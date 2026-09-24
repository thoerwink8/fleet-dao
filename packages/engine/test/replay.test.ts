// 老历史进新代码（windsurf-dao#1633）：拿录好的历史（过去某一版代码真走过的路，test/replay/fixtures/）对「现在的」工作流代码重放。
// 重放出来的步骤和历史对不上 = 此刻在途的任务（包括停在暂停、挂起、等回答、等合并队列里的）换上新代码会变僵尸
// （TMPRL1100：读不了状态、收不了信号，只能终止）。修法是用 patched() 把改动包起来，不许重录夹具让它变绿。
// 流程判断走本地活动、结果在历史里，重放时不重算——所以改判断条件不会让这里变红；改调度顺序才会。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineBundle } from './support.ts';

const DIR = fileURLToPath(new URL('./replay/fixtures/', import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

/** 必须有的场景：没有它们，「扫完 0 条」和「一条样本都没扫到」就分不开了。 */
const REQUIRED = [
  'subtask-merged',
  'subtask-paused',
  'subtask-parked',
  'subtask-in-merge-queue',
  'merge-queue-idle',
  'merge-queue-busy',
  'requirement-done',
  'requirement-done-api',
  'requirement-done-page',
  'requirement-asking',
  'requirement-running',
  'requirement-running-main',
];

const HOW =
  '这份历史是过去的代码真走过的路：现在的代码走不出同样的步骤 = 在途的任务会变僵尸。' +
  "用 patched('<新标记>') 把改动包起来，老任务照老步序重放；不许重录夹具让它变绿。";

interface Fixture {
  /** 工作流编号不在历史里，但工作流代码会用（子任务编号、合并条目编号），重放要按原编号。 */
  workflowId: string;
  history: { events: Record<string, unknown>[] };
}

const load = (file: string): Fixture => JSON.parse(readFileSync(`${DIR}${file}`, 'utf8')) as Fixture;

let bundle: Awaited<ReturnType<typeof engineBundle>>;
beforeAll(async () => {
  bundle = await engineBundle();
}, 120_000);

describe('老历史按现在的代码重放', { timeout: 60_000 }, () => {
  it('夹具都在：做完、暂停、挂起、等回答、在合并队列里、需求在调度……', () => {
    expect(REQUIRED.filter((name) => !files.includes(`${name}.json`))).toEqual([]);
  });

  for (const file of files) {
    it(`${file}：重放不报历史对不上`, async () => {
      const { workflowId, history } = load(file);
      expect(history.events.length).toBeGreaterThan(5);
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId).catch(
        (error: unknown) => {
          throw new Error(`${HOW}\n原始报错：${String((error as Error)?.message ?? error).slice(0, 800)}`);
        },
      );
    });
  }

  it('对照：历史里调度的活动和代码调的对不上，重放当场报 DeterminismViolationError（这道检查真能红）', async () => {
    const { workflowId, history } = load('subtask-paused.json');
    const scheduled = history.events.find((e) => 'activityTaskScheduledEventAttributes' in e) as
      | { activityTaskScheduledEventAttributes: { activityType: { name: string } } }
      | undefined;
    expect(scheduled?.activityTaskScheduledEventAttributes.activityType.name).toBe('createWorktree');
    if (scheduled) scheduled.activityTaskScheduledEventAttributes.activityType.name = 'openPr';
    const error = await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DeterminismViolationError);
  });

  it('对照：拿错编号重放也会红（编号进了子任务编号、合并条目编号，所以夹具要带原编号）', async () => {
    const { history } = load('requirement-done.json');
    const error = await Worker.runReplayHistory(
      { workflowBundle: bundle },
      history,
      'req:other/repo#1',
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeterminismViolationError);
  });
});
