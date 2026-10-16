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
  'task-merge-conflict',
  'task-merging',
  'task-paused',
  'task-reworked',
  'task-repinned',
  'task-full-merged',
  'task-full-reworked',
];

const HOW =
  '这份历史是过去的代码真走过的路：现在的代码走不出同样的步骤 = 在途的任务会变僵尸。' +
  "用 patched('<新标记>') 把改动包起来，老任务照老步序重放；不许重录夹具让它变绿。";

interface Fixture {
  /** 工作流编号不在历史里，但工作流代码会用（报警去重键），重放按原编号。 */
  workflowId: string;
  history: {
    events: {
      eventId?: string;
      activityTaskScheduledEventAttributes?: { activityType: { name: string } };
      activityTaskCompletedEventAttributes?: {
        scheduledEventId?: string;
        result?: unknown;
      };
      markerRecordedEventAttributes?: {
        markerName?: string;
        details?: Record<string, { payloads?: { data?: string }[] }>;
      };
      [key: string]: unknown;
    }[];
  };
}

const load = (file: string): Fixture => JSON.parse(readFileSync(`${DIR}${file}`, 'utf8')) as Fixture;

type Event = Fixture['history']['events'][number];

/** 历史里按顺序调度过的活动名（查步序用）。 */
const scheduledActivities = (history: Fixture['history']): string[] =>
  history.events
    .map((e) => e.activityTaskScheduledEventAttributes?.activityType.name)
    .filter((n): n is string => n !== undefined);

/** 第一次调度某个活动的那个事件（找不到就是 undefined，测试自己断言）。 */
const firstScheduled = (history: Fixture['history'], activity: string): Event | undefined =>
  history.events.find((e) => e.activityTaskScheduledEventAttributes?.activityType.name === activity);

/** 某次调度的结果事件（对上 scheduledEventId）。 */
const completionOf = (history: Fixture['history'], scheduled: Event | undefined): Event | undefined =>
  history.events.find((e) => e.activityTaskCompletedEventAttributes?.scheduledEventId === scheduled?.eventId);

/** 载荷（Temporal 把活动结果封成 base64 的 json/plain）。 */
const payloadOf = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

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

  it('task-repinned 夹具真走过「现在就换」那一支（#1216）：历史里有 taskRepin 信号和 task-repin 的 patched 标记；老夹具里没有这两样', () => {
    const text = readFileSync(`${DIR}task-repinned.json`, 'utf8');
    expect(text).toContain('taskRepin');
    const marker = Buffer.from(JSON.stringify({ id: 'task-repin', deprecated: false })).toString('base64');
    expect(text).toContain(marker);
    // 对照：老夹具里没有（新分支被 patched('task-repin') 守着，老任务照老步序重放）
    for (const old of ['task-merged', 'task-paused', 'task-reworked']) {
      const plain = readFileSync(`${DIR}${old}.json`, 'utf8');
      expect(plain).not.toContain('taskRepin');
      expect(plain).not.toContain(marker);
    }
  });

  it('全程两份夹具（#2826）真走过定模式：带 flow-mode 标记和 decideFlowMode；全程返工只有一轮却起了三段会话；老夹具里都没有', () => {
    const marker = Buffer.from(JSON.stringify({ id: 'flow-mode', deprecated: false })).toString('base64');
    for (const name of ['task-full-merged', 'task-full-reworked']) {
      const text = readFileSync(`${DIR}${name}.json`, 'utf8');
      expect(text).toContain(marker);
      expect(scheduledActivities(load(`${name}.json`).history)).toContain('decideFlowMode');
    }
    const reworked = scheduledActivities(load('task-full-reworked.json').history);
    expect(reworked.filter((n) => n === 'runSegment').length).toBe(3);
    for (const old of ['task-merged', 'task-reworked', 'task-merge-conflict']) {
      const text = readFileSync(`${DIR}${old}.json`, 'utf8');
      expect(text).not.toContain(marker);
      expect(scheduledActivities(load(`${old}.json`).history)).not.toContain('decideFlowMode');
    }
  });

  // 新分支真走没走、老历史重放会不会走进去——都要用「真重放一遍」证明，光查夹具里有没有标记不算（#1838 返工意见）。
  // 两条用例各管一边：
  //  - task-merging（老历史的等合并）：第一次 waitMerged 的结果改成 conflict，老历史里没有 merge-wait-conflict 标记，
  //    patched() 为假就当没这一支、照老步序接着等，重放得过（历史里还是 waitMerged，没多出 syncMainline）。
  //  - task-merge-conflict（新代码真走过的等合并遇冲突）：历史里带标记，走到那一支，重放得过；
  //    把标记改名（patched() 认不出）后重放当场红——两边对照，证明这一支真的靠标记守着、真会改变走的步序。
  const MERGE_WAIT_MARKER = Buffer.from(
    JSON.stringify({ id: 'merge-wait-conflict', deprecated: false }),
  ).toString('base64');

  it('task-merging 老历史（等合并）里 waitMerged 回了 conflict、历史里没有标记：patched() 为假，照老步序重放得过（#1838）', async () => {
    const { workflowId, history } = load('task-merging.json');
    // 老历史第一回等合并回的是 waiting；把它的结果改成 conflict，模拟「GitHub 当时回了冲突」的历史
    const done = completionOf(history, firstScheduled(history, 'waitMerged'));
    expect(done).toBeDefined();
    const attrs = done?.activityTaskCompletedEventAttributes;
    expect(attrs).toBeDefined();
    if (attrs)
      attrs.result = {
        payloads: [
          {
            metadata: { encoding: 'anNvbi9wbGFpbg==' },
            data: payloadOf({ state: 'conflict', detail: 'PR #100 和主线冲突' }),
          },
        ],
      };
    expect(JSON.stringify(history)).not.toContain(MERGE_WAIT_MARKER); // 老历史里没有这个标记
    // 重放得过就是这一支真没走的证明：patched() 为假，照老步序接着等下一回 waitMerged。
    // 反过来验过：把代码里的 patched('merge-wait-conflict') 去掉，这一步重放当场报
    // TMPRL1100（'waitMerged' 对不上 'syncMainline'）——证明新分支真被标记守着、这条断言真能红。
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
  });

  it('task-merging 老历史里 waitMerged 回了 checks_red、历史里没有标记：patched() 为假，照老步序重放得过（#1983）', async () => {
    const marker = Buffer.from(JSON.stringify({ id: 'merge-wait-red-checks', deprecated: false })).toString(
      'base64',
    );
    const { workflowId, history } = load('task-merging.json');
    const done = completionOf(history, firstScheduled(history, 'waitMerged'));
    expect(done).toBeDefined();
    const attrs = done?.activityTaskCompletedEventAttributes;
    expect(attrs).toBeDefined();
    if (attrs) {
      attrs.result = {
        payloads: [
          {
            metadata: { encoding: 'anNvbi9wbGFpbg==' },
            data: payloadOf({
              state: 'checks_red',
              failedChecks: ['merge-gate'],
              detail: 'merge-gate：cold-verify 没过',
            }),
          },
        ],
      };
    }
    expect(JSON.stringify(history)).not.toContain(marker);
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
  });

  it('task-merge-conflict 夹具（新代码真走过的等合并遇冲突）：带 merge-wait-conflict 标记，重放得过（#1838）', async () => {
    const text = readFileSync(`${DIR}task-merge-conflict.json`, 'utf8');
    expect(text).toContain(MERGE_WAIT_MARKER); // 这份夹具真走过这一支，标记在历史里
    const { history } = load('task-merge-conflict.json');
    // 真并了一遍主线、对新的头重走了一遍 CI 和验收：老历史里不会有这些步序（跑得通也证明历史和新代码对得上）
    const acts = scheduledActivities(history);
    expect(acts).toContain('syncMainline');
    expect(acts.filter((n) => n === 'waitCi').length).toBe(2);
    expect(acts.filter((n) => n === 'coldVerify').length).toBe(2);
  });

  it('对照：把 task-merge-conflict 里的标记改名，patched() 认不出，重放当场红（这一支真靠标记守着）（#1838）', async () => {
    const { workflowId, history } = load('task-merge-conflict.json');
    const marker = history.events.find((e) => {
      const details = (e.markerRecordedEventAttributes?.details ?? {}) as Record<
        string,
        { payloads?: { data?: string }[] }
      >;
      return details['patch-data']?.payloads?.[0]?.data === MERGE_WAIT_MARKER;
    });
    if (marker === undefined) throw new Error('夹具里没有 merge-wait-conflict 的 core_patch 标记');
    const details = marker.markerRecordedEventAttributes?.details as
      | Record<string, { payloads: { data: string }[] }>
      | undefined;
    const patchData = details?.['patch-data']?.payloads?.[0];
    if (patchData === undefined) throw new Error('core_patch 标记的载荷读不出来');
    // 标记改成 patched() 认不出的名字：等于「这份历史没见过这一支」——老任务重放会照老步序走，和新历史对不上
    patchData.data = payloadOf({ id: 'merge-wait-conflict-renamed', deprecated: false });
    const error = await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DeterminismViolationError);
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
