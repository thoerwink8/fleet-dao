// 老历史进新代码（windsurf-dao#1633）：拿录好的历史（过去某一版代码真走过的路，test/replay/fixtures/）对「现在的」工作流代码重放。
// 重放出来的步骤和历史对不上 = 此刻在途的任务（包括停在等人、等合并里的）换上新代码会变僵尸
// （TMPRL1100：读不了状态、收不了信号，只能终止）。修法是用 patched() 把改动包起来，不许重录夹具让它变绿。
// 只有任务工作流的夹具（task-*.json）：更早的 subtask-/fusion-/requirement-/merge-queue- 夹具连同它们的工作流一起在 #556-2 删了，
// 拉单的夹具（intake-idle）随拉单工作流在 #1072 删了（拉单改成引擎进程里的定时器，不再是工作流）。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineBundle } from './support.ts';

const DIR = fileURLToPath(new URL('./replay/fixtures/', import.meta.url));
const files = readdirSync(DIR).filter((f) => f.startsWith('task-') && f.endsWith('.json'));

/** 必须有的场景：没有它们，「扫完 0 条」和「一条样本都没扫到」就分不开了。 */
const REQUIRED = [
  'task-merged',
  'task-parked-brief',
  'task-parked-guarded',
  'task-merging',
  'task-paused',
  'task-reworked',
];

const HOW =
  '这份历史是过去的代码真走过的路：现在的代码走不出同样的步骤 = 在途的任务会变僵尸。' +
  "用 patched('<新标记>') 把改动包起来，老任务照老步序重放；不许重录夹具让它变绿。";

interface Fixture {
  /** 工作流编号不在历史里，但工作流代码会用（报警去重键），重放按原编号。 */
  workflowId: string;
  history: {
    events: {
      activityTaskScheduledEventAttributes?: { activityType: { name: string } };
      [key: string]: unknown;
    }[];
  };
}

const load = (file: string): Fixture => JSON.parse(readFileSync(`${DIR}${file}`, 'utf8')) as Fixture;

let bundle: Awaited<ReturnType<typeof engineBundle>>;
beforeAll(async () => {
  bundle = await engineBundle();
}, 120_000);

describe('老历史按现在的代码重放', { timeout: 60_000 }, () => {
  it('夹具都在：做完、等人补交代、等创始人、等合并', () => {
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

  it('task-paused 夹具真走过暂停那一支：历史里有 taskPause 信号和 patched 的标记（不是一份和别的夹具一样的历史）', () => {
    const text = readFileSync(`${DIR}task-paused.json`, 'utf8');
    expect(text).toContain('taskPause');
    // patched() 的标记在历史里是 core_patch，编号藏在 base64 里
    const marker = Buffer.from(JSON.stringify({ id: 'task-pause', deprecated: false })).toString('base64');
    expect(text).toContain(marker);
    // 对照：没有暂停的夹具里没有这两样
    const plain = readFileSync(`${DIR}task-merged.json`, 'utf8');
    expect(plain).not.toContain('taskPause');
    expect(plain).not.toContain(marker);
  });

  it('对照：历史里调度的活动和代码调的对不上，重放当场报 DeterminismViolationError（这道检查真能红）', async () => {
    const { workflowId, history } = load('task-merged.json');
    const scheduled = history.events.find((e) => e.activityTaskScheduledEventAttributes);
    expect(scheduled?.activityTaskScheduledEventAttributes?.activityType.name).toBe('readTaskBrief');
    if (scheduled?.activityTaskScheduledEventAttributes) {
      scheduled.activityTaskScheduledEventAttributes.activityType.name = 'coldVerify';
    }
    const error = await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DeterminismViolationError);
  });
});
