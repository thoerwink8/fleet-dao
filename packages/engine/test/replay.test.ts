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
  'task-verify-reattach',
  'task-contract-first-accept',
  'task-acceptance-duty-merged',
  'task-rounds-continued-old',
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
  it('旧夹具没有 CI 红带评审这一步：没有 ci-red-review-context，也没调度 readCiReviews', () => {
    const marker = Buffer.from(JSON.stringify({ id: 'ci-red-review-context', deprecated: false })).toString(
      'base64',
    );
    for (const file of files) {
      const text = readFileSync(`${DIR}${file}`, 'utf8');
      expect(text, file).not.toContain(marker);
      expect(scheduledActivities(load(file).history), file).not.toContain('readCiReviews');
    }
  });

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

  it('task-verify-reattach 夹具（#2848）真走过冷验收接回：带 cold-verify-attach 标记，coldVerify 调了两次（第二次带 attach）；老夹具里没有这个标记', () => {
    const marker = Buffer.from(JSON.stringify({ id: 'cold-verify-attach', deprecated: false })).toString(
      'base64',
    );
    const text = readFileSync(`${DIR}task-verify-reattach.json`, 'utf8');
    expect(text).toContain(marker);
    const { history } = load('task-verify-reattach.json');
    expect(scheduledActivities(history).filter((n) => n === 'coldVerify').length).toBe(2);
    // 只动手一次：脱开不是没过，没回去返工
    expect(scheduledActivities(history).filter((n) => n === 'runSegment').length).toBe(1);
    for (const old of files.filter((f) => f !== 'task-verify-reattach.json')) {
      expect(readFileSync(`${DIR}${old}`, 'utf8')).not.toContain(marker);
    }
  });

  it('task-contract-first-accept 夹具（#3402）真走过「旧交代没有合同、第一次安全边界按首次接纳」：读合同之后紧接写进度行；其余夹具都没有读合同这一步', () => {
    const marker = Buffer.from(
      JSON.stringify({ id: 'task-contract-revisions-v1', deprecated: false }),
    ).toString('base64');
    const { history } = load('task-contract-first-accept.json');
    expect(JSON.stringify(history)).toContain(marker);
    const scheduled = history.events
      .map((e) => e.activityTaskScheduledEventAttributes)
      .filter((a): a is NonNullable<typeof a> => a !== undefined) as {
      activityType: { name: string };
      input?: { payloads?: { data?: string }[] };
    }[];
    const checks = (a: (typeof scheduled)[number]) =>
      a.activityType.name === 'readTaskBrief' &&
      Buffer.from(a.input?.payloads?.[0]?.data ?? '', 'base64')
        .toString('utf8')
        .includes('checkContract');
    const at = scheduled.findIndex(checks);
    expect(at).toBeGreaterThanOrEqual(0);
    // 首次接纳（之前没有合同）才会写进度行；被默认参数吞成「没变」就直接往下选路，重放当场对不上
    expect(scheduled[at + 1]?.activityType.name).toBe('saveTaskState');
    // #3402 之后录的夹具（新代码每次都过合同修订边界，自然带这个标记）不在「老夹具」之列
    const AFTER_3402 = [
      'task-contract-first-accept.json',
      'task-acceptance-duty-merged.json',
      'task-rounds-continued-old.json',
    ];
    for (const old of files.filter((f) => !AFTER_3402.includes(f))) {
      expect(readFileSync(`${DIR}${old}`, 'utf8')).not.toContain(marker);
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
    expect(JSON.stringify(history)).not.toContain(
      Buffer.from(JSON.stringify({ id: 'acceptance-duty-before-merge', deprecated: false })).toString(
        'base64',
      ),
    );
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

  it('task-merged 老历史里冷验收回了 outOfScope、历史里没有 acceptance-duty 标记：收尾照老步序直接关单，重放得过（#3037）', async () => {
    const marker = Buffer.from(JSON.stringify({ id: 'acceptance-duty', deprecated: false })).toString(
      'base64',
    );
    const { workflowId, history } = load('task-merged.json');
    const done = completionOf(history, firstScheduled(history, 'coldVerify'));
    const attrs = done?.activityTaskCompletedEventAttributes;
    expect(attrs).toBeDefined();
    // 老活动结果加上「不归我验」（老历史里本来没有这个字段的也一样）：工作流只记进状态，不多调活动
    if (attrs) {
      attrs.result = {
        payloads: [
          {
            metadata: { encoding: 'anNvbi9wbGFpbg==' },
            data: payloadOf({ pass: true, problems: [], round: 1, outOfScope: ['现场 add/check 五条'] }),
          },
        ],
      };
    }
    expect(JSON.stringify(history)).not.toContain(marker);
    const acts = scheduledActivities(history);
    expect(acts).toContain('closeIssue');
    expect(acts).not.toContain('acceptanceDuties');
    // 反过来验过：把 finish 里的 patched('acceptance-duty') 去掉，这一步重放当场报 TMPRL1100（'closeIssue' 对不上 'acceptanceDuties'）
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
  });

  it('task-acceptance-duty-merged 老历史（#3591 停写之前录的）：合并前、收尾两次 acceptanceDuties 都带着要写的转人验收条，没关单；现在的代码只读不写，重放照老步序得过', async () => {
    const { workflowId, history } = load('task-acceptance-duty-merged.json');
    const scheduled = history.events
      .map((e) => e.activityTaskScheduledEventAttributes)
      .filter((a): a is NonNullable<typeof a> => a !== undefined) as {
      activityType: { name: string };
      input?: { payloads?: { data?: string }[] };
    }[];
    const duties = scheduled.filter((a) => a.activityType.name === 'acceptanceDuties');
    expect(duties).toHaveLength(2);
    for (const a of duties) {
      const arg = JSON.parse(Buffer.from(a.input?.payloads?.[0]?.data ?? '', 'base64').toString('utf8')) as {
        record: { items: string[] }[];
      };
      // 老代码真交过去记库（停写前的步序），不是一份只读的历史
      expect(arg.record.flatMap((r) => r.items)).toContain('现场 add/check 五条');
    }
    const acts = scheduledActivities(history);
    expect(acts).not.toContain('closeIssue');
    expect(acts.indexOf('acceptanceDuties')).toBeLessThan(acts.indexOf('armAutoMerge'));
    // 现在的代码：同样调两次 acceptanceDuties（record 改空、结果并上工作流记着的条），步序一样，不关单
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
  });

  it('同一份老历史把 acceptanceDuties 的读回改成空（库里没有行）：留不留单只凭工作流自己记着的转人验收条，照样不关单，重放得过（#3591）', async () => {
    const { workflowId, history } = load('task-acceptance-duty-merged.json');
    const ids = history.events
      .filter((e) => e.activityTaskScheduledEventAttributes?.activityType.name === 'acceptanceDuties')
      .map((e) => e.eventId);
    expect(ids).toHaveLength(2);
    for (const e of history.events) {
      const done = e.activityTaskCompletedEventAttributes;
      if (done && ids.includes(done.scheduledEventId)) {
        done.result = {
          payloads: [{ metadata: { encoding: 'anNvbi9wbGFpbg==' }, data: payloadOf({ open: [] }) }],
        };
      }
    }
    // 反过来验过：openDuties 只回 read.open（不并工作流记着的）时，合并前读到空就不改 PR 说明（Refs），重放当场报
    // TMPRL1100（'updatePrBody' 对不上 'readTaskBrief'）——留单、写 Refs 真是靠工作流自己记着的条
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
  });

  // #3603：CI 红返工点名上一段的路由、不受连续续会话上限。两份老历史都真走过 CI 红返工（三段的 task-reworked 没有续会话那一套，
  // 全程的 task-full-reworked 带 rework-resume、真问过 planSegmentResume），历史里都没有这两个新标记：patched() 为假，
  // 第 2 轮选路照老入参（不带 preferRouteId），重放得过。
  const CI_REWORK_MARKERS = ['ci-rework-prefer-route', 'ci-rework-keep-resume'].map((id) =>
    Buffer.from(JSON.stringify({ id, deprecated: false })).toString('base64'),
  );
  const pickInputs = (history: Fixture['history']): Record<string, unknown>[] =>
    history.events
      .map(
        (e) =>
          e.activityTaskScheduledEventAttributes as
            | { activityType: { name: string }; input?: { payloads?: { data?: string }[] } }
            | undefined,
      )
      .filter((a) => a?.activityType.name === 'pickRoute')
      .map((a) => JSON.parse(Buffer.from(a?.input?.payloads?.[0]?.data ?? '', 'base64').toString('utf8')));
  for (const name of ['task-reworked', 'task-full-reworked']) {
    it(`${name} 老历史真走过 CI 红返工、没有 #3603 的标记：返工那一轮选路不点名，现在的代码重放得过`, async () => {
      const { workflowId, history } = load(`${name}.json`);
      const text = JSON.stringify(history);
      for (const marker of CI_REWORK_MARKERS) expect(text).not.toContain(marker);
      const acts = scheduledActivities(history);
      // CI 红了（第一次 waitCi 不是最后一次）、回去又起了一段会话
      expect(acts.filter((n) => n === 'waitCi').length).toBeGreaterThanOrEqual(2);
      expect(acts.indexOf('runSegment', acts.indexOf('waitCi'))).toBeGreaterThan(acts.indexOf('waitCi'));
      const picks = pickInputs(history);
      expect(picks.length).toBeGreaterThanOrEqual(2);
      for (const pick of picks) expect(pick).not.toHaveProperty('preferRouteId');
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
    });
  }

  it('task-rounds-continued-old 老历史（#3603 之前录的）：累计 6 轮停下、不带原因点了「继续」、又做 3 轮停下；没有 task-total-rounds 标记，现在的代码照老步序重放得过', async () => {
    // 录法：在 origin/main 5eaf379fd（#3603 之前）的代码上，用 record.ts 同一套假端口和 scripted()，每轮都没提交（不走 CI 红，
    // 「旧夹具没有 CI 红带评审这一步」那条只许老夹具有），停在 6 轮后发一次 { by: 'recorder' } 的继续，停在 9 轮后取历史。
    // record.ts 跑的是现在的代码，录不出这份老历史，所以没把它写成那里的场景。
    const { workflowId, history } = load('task-rounds-continued-old.json');
    const marker = Buffer.from(JSON.stringify({ id: 'task-total-rounds', deprecated: false })).toString(
      'base64',
    );
    expect(JSON.stringify(history)).not.toContain(marker);
    const acts = scheduledActivities(history);
    // 真跑满了 9 轮（过了 6 轮的上限），中间没有交还本机这一步
    expect(acts.filter((n) => n === 'runSegment')).toHaveLength(9);
    expect(acts).not.toContain('handBackLocal');
    // 那一下「继续」是人点的、没带原因：老代码照样清零放行
    const signals = history.events
      .map(
        (e) =>
          e.workflowExecutionSignaledEventAttributes as
            | { signalName: string; input?: { payloads?: { data?: string }[] } }
            | undefined,
      )
      .filter((s) => s !== undefined);
    expect(signals.map((s) => s.signalName)).toEqual(['taskContinue']);
    const command = JSON.parse(
      Buffer.from(signals[0]?.input?.payloads?.[0]?.data ?? '', 'base64').toString('utf8'),
    ) as { note?: string };
    expect(command.note).toBeUndefined();
    // 反过来验过：把 holdAtTotalRounds 里的 patched('task-total-rounds') 换成恒真，这份历史重放当场报 TMPRL1100
    // （第 6 轮停下那一步走进了交还本机那一支，和历史里的停下对不上）——在途的老任务确实靠这个标记照老步序走
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
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
