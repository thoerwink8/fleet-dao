// 体量关口重评（#3249）：停在体量预算停点的单，可信重评只放行「这一次停点的这一份交付」，不授权后续。
// 真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动（重评走 readDelivery 的 budgetRemeasure 入参）。
// 不碰真实 #3207，不改生产数据。

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, fakeHead } from '../src/fakes.ts';
import { DEFAULT_PR_LINE_BUDGET } from '../src/limits.ts';
import type { PortName } from '../src/ports.ts';
import type { TaskBrief } from '../src/runner/task-brief.ts';
import {
  type DeliveryRead,
  type LineBudgetParkIdentity,
  type ReadDeliveryInput,
  type RemeasureLineBudgetCommand,
  type RemeasureLineBudgetResult,
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskContinueSignal,
  taskRemeasureLineBudgetUpdate,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { REMEASURE_CATCH_UP_SECONDS } from '../src/workflows/task-budget-remeasure.ts';
import { engineBundle, freshRepo, pollQuery, useEnv, waitUntil, withWorker } from './helpers.ts';
import { goodBrief, scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

const BASE = fakeHead(1);
const RAW = 9550;

function input(): TaskWorkflowInput {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 12,
    title: '给驾驶舱加状态',
  };
}

const brief = (): { ok: true; brief: TaskBrief } => ({
  ok: true,
  brief: { ...goodBrief(), tier: { tier: 'medium', effort: 'high', reason: '测试定的档' } },
});

type Remeasure = (
  read: NonNullable<ReadDeliveryInput['budgetRemeasure']>,
) => DeliveryRead | Promise<DeliveryRead>;

/** 可信折扣测量的回答：8037 行生成快照可折扣，实际计量 1513 行。 */
function measured(
  ask: { head: string; base: string },
  over: { measurement?: object; answer?: object } = {},
): DeliveryRead {
  return {
    head: ask.head,
    commits: 0,
    changedFiles: [],
    budgetRemeasure: {
      version: 1,
      status: 'measured',
      head: ask.head,
      base: ask.base,
      headAfter: ask.head,
      cleanAfter: true,
      measurement: {
        version: 1,
        base: ask.base,
        head: ask.head,
        rawAddedLines: RAW,
        rawDiffBytes: 330000,
        verifiedGeneratedLines: 8037,
        chargeableAddedLines: 1513,
        verified: true,
        reason: '已核单份快照',
        ...over.measurement,
      },
      ...over.answer,
    },
  } as DeliveryRead;
}

/**
 * 常规交付报 addedLinesBase＝BASE（原始新增行实际按的 base），停点身份钉它。measuredBase：再带一份没核实的测量（base 是它）；
 * old：像重评能力之前的活动那样不报 addedLinesBase（停点身份的 base 为 null）。
 */
function setup(
  remeasure: Remeasure,
  verifyFirstFails = false,
  opts: { measuredBase?: string; old?: boolean; holdPorts?: PortName[] } = {},
) {
  const parkedBase = opts.measuredBase;
  const world = createFakeWorld(opts.holdPorts ? { holdPorts: opts.holdPorts } : {});
  let regular = 0;
  const asks: ReadDeliveryInput['budgetRemeasure'][] = [];
  const { tasks, calls } = scripted({
    brief,
    verify: (_i, n) =>
      verifyFirstFails && n === 1
        ? { pass: false, problems: ['少了状态'], round: 1 }
        : { pass: true, problems: [], round: 2 },
    // 每份常规交付都是原始 9550 行、没有折扣：第 1 份打回，第 2 份停下
    delivery: (_n, read) => {
      if (read.budgetRemeasure) {
        asks.push(read.budgetRemeasure);
        return remeasure(read.budgetRemeasure) as DeliveryRead;
      }
      regular += 1;
      const head = fakeHead(100 + regular);
      return {
        head,
        commits: 1,
        changedFiles: ['packages/db/migrations/meta/0095_snapshot.json', 'packages/api/src/a.ts'],
        addedLines: RAW,
        ...(opts.old ? {} : { addedLinesBase: BASE }),
        ...(parkedBase === undefined
          ? {}
          : {
              lineBudgetMeasurement: {
                version: 1,
                base: parkedBase,
                head,
                rawAddedLines: RAW,
                verifiedGeneratedLines: 0,
                chargeableAddedLines: RAW,
                verified: false,
                reason: '停下时没核实',
              },
            }),
      };
    },
  });
  return { world, tasks, calls, asks };
}

async function start(q: string, i: TaskWorkflowInput): Promise<WorkflowHandle> {
  return env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(i.repo, i.issueNumber, 1),
    args: [i],
  });
}

const status = (h: WorkflowHandle) => h.query(taskStatusQuery) as Promise<TaskStatus>;

async function parkedIdentity(h: WorkflowHandle, notParks?: number): Promise<LineBudgetParkIdentity> {
  const s = await pollQuery(
    () => status(h),
    (x) => !!x.lineBudgetPark?.identity && x.lineBudgetPark.identity.parks !== notParks,
    '停在体量关口',
    // 走到停点要两段会话、一次打回：整包并行跑、机器忙时 20 秒默认不够
    60_000,
  );
  return s.lineBudgetPark?.identity as LineBudgetParkIdentity;
}

function command(
  i: TaskWorkflowInput,
  h: WorkflowHandle,
  identity: LineBudgetParkIdentity,
  over: Partial<RemeasureLineBudgetCommand> = {},
): RemeasureLineBudgetCommand {
  return {
    version: 1,
    mode: 'resume',
    identity,
    repo: { owner: i.repo.owner, name: i.repo.name },
    taskId: i.taskId,
    workflowId: h.workflowId,
    head: identity.head,
    base: BASE,
    by: 'ops',
    ...over,
  };
}

const send = (h: WorkflowHandle, cmd: RemeasureLineBudgetCommand): Promise<RemeasureLineBudgetResult> =>
  h.executeUpdate(taskRemeasureLineBudgetUpdate, { args: [cmd] });

const waitingHuman = async (h: WorkflowHandle) => expect((await status(h)).waiting?.kind).toBe('human');

/** 历史事件里认命令序要的那几项：现录的是字节，夹具（JSON）里是 base64。 */
type CommandEvent = {
  activityTaskScheduledEventAttributes?: { activityType?: { name?: string | null } | null } | null;
  markerRecordedEventAttributes?: {
    markerName?: string | null;
    details?: Record<string, { payloads?: { data?: Uint8Array | string | null }[] | null }> | null;
  } | null;
};

/** 命令序：活动和 patched 标记按先后排（搜索属性略）。 */
function commandsOf(events: readonly CommandEvent[]): string[] {
  return events.flatMap((e) => {
    const activity = e.activityTaskScheduledEventAttributes?.activityType?.name;
    if (activity) return [activity];
    const marker = e.markerRecordedEventAttributes;
    if (!marker) return [];
    if (marker.markerName !== 'core_patch') return [`marker:${marker.markerName}`];
    const payloads = Object.values(marker.details ?? {}).flatMap((p) => p.payloads ?? []);
    const id = payloads
      .map((p) => {
        const raw = typeof p.data === 'string' ? Buffer.from(p.data, 'base64') : Buffer.from(p.data ?? []);
        return (JSON.parse(raw.toString('utf8')) as { id?: unknown }).id;
      })
      .find((x) => typeof x === 'string');
    return [`patch:${String(id)}`];
  });
}

/**
 * 重评能力之前的代码（#3249 改动前的 828c9d47，假端口、无关数据）真跑到体量停点时录下的历史，一行一个事件，第一行是工作流编号。
 * 那一版报警正文里还没有重评入口的提示，可据此认出不是新代码录的。不许重录。
 */
const OLD_PARK = (() => {
  const file = fileURLToPath(new URL('./replay/fixtures/task-budget-parked-old.jsonl', import.meta.url));
  const [first = '', ...lines] = readFileSync(file, 'utf8').trim().split('\n');
  const events = lines.map((line) => JSON.parse(line) as CommandEvent);
  return { workflowId: (JSON.parse(first) as { workflowId: string }).workflowId, events };
})();
const OLD_PARK_COMMANDS = commandsOf(OLD_PARK.events);

/** 停点报警还挂着、waiting 尚未设上时，第一次体量停点应有的身份（交付头是第二份常规交付）。 */
function formingPark(runId: string, over: Partial<LineBudgetParkIdentity> = {}): LineBudgetParkIdentity {
  return {
    version: 1,
    runId,
    parks: 1,
    generation: 1,
    continued: 0,
    prNumber: null,
    head: fakeHead(102),
    rawAddedLines: RAW,
    chargeableAddedLines: RAW,
    budget: DEFAULT_PR_LINE_BUDGET,
    base: BASE,
    ...over,
  };
}

type HistEvent = {
  eventId?: unknown;
  timerStartedEventAttributes?: { startToFireTimeout?: unknown } | null;
  timerFiredEventAttributes?: { startedEventId?: unknown } | null;
  timerCanceledEventAttributes?: { startedEventId?: unknown } | null;
  workflowExecutionSignaledEventAttributes?: { signalName?: string | null } | null;
};

function timeoutSeconds(raw: unknown): number {
  if (typeof raw === 'string') {
    const secs = /^(\d+(?:\.\d+)?)s$/.exec(raw);
    if (secs?.[1]) return Number(secs[1]);
    const hours = /^(\d+(?:\.\d+)?)h$/.exec(raw);
    if (hours?.[1]) return Number(hours[1]) * 3600;
  }
  if (typeof raw === 'object' && raw !== null && 'seconds' in raw) {
    const seconds = (raw as { seconds: unknown }).seconds;
    if (typeof seconds === 'number' || typeof seconds === 'bigint') return Number(seconds);
    if (typeof seconds === 'string' && seconds !== '') return Number(seconds);
    if (typeof seconds === 'object' && seconds !== null && 'toNumber' in seconds) {
      return (seconds as { toNumber: () => number }).toNumber();
    }
  }
  throw new Error(`定时器时长认不出：${JSON.stringify(raw)}`);
}

function startedTimerSeconds(events: readonly HistEvent[]): number[] {
  const started: number[] = [];
  for (const e of events) {
    if (!e.timerStartedEventAttributes) continue;
    started.push(timeoutSeconds(e.timerStartedEventAttributes.startToFireTimeout));
  }
  return started;
}

/** 已响或已取消的开始事件。认不出对应的开始时长就抛，不把缺事件当成没响。 */
function settledTimerSeconds(events: readonly HistEvent[], fired: boolean): number[] {
  const duration = new Map<string, number>();
  for (const e of events) {
    if (!e.timerStartedEventAttributes || e.eventId == null) continue;
    duration.set(String(e.eventId), timeoutSeconds(e.timerStartedEventAttributes.startToFireTimeout));
  }
  const out: number[] = [];
  for (const e of events) {
    const id = fired
      ? e.timerFiredEventAttributes?.startedEventId
      : e.timerCanceledEventAttributes?.startedEventId;
    if (id == null) continue;
    const secs = duration.get(String(id));
    if (secs === undefined)
      throw new Error(`定时器${fired ? '响了' : '取消了'}但找不到开始事件 ${String(id)}`);
    out.push(secs);
  }
  return out;
}

const historyOf = async (h: WorkflowHandle): Promise<HistEvent[]> =>
  ((await h.fetchHistory()).events ?? []) as HistEvent[];

const catchupTimers = (events: readonly HistEvent[], fired: boolean) =>
  settledTimerSeconds(events, fired).filter((s) => s === REMEASURE_CATCH_UP_SECONDS);

/** 继续、30 秒 catchup、放弃在历史里的先后。证明旧请求是继续之后才挂上等待，放弃才取消。 */
function catchupWakeTrace(events: readonly HistEvent[]): string[] {
  const duration = new Map<string, number>();
  const out: string[] = [];
  for (const e of events) {
    const signal = e.workflowExecutionSignaledEventAttributes?.signalName;
    if (signal === 'taskContinue' || signal === 'taskAbandon') out.push(signal);
    if (e.timerStartedEventAttributes && e.eventId != null) {
      const secs = timeoutSeconds(e.timerStartedEventAttributes.startToFireTimeout);
      duration.set(String(e.eventId), secs);
      if (secs === REMEASURE_CATCH_UP_SECONDS) out.push('timerStarted');
    }
    const canceledId = e.timerCanceledEventAttributes?.startedEventId;
    if (canceledId != null && duration.get(String(canceledId)) === REMEASURE_CATCH_UP_SECONDS)
      out.push('timerCanceled');
    const firedId = e.timerFiredEventAttributes?.startedEventId;
    if (firedId != null && duration.get(String(firedId)) === REMEASURE_CATCH_UP_SECONDS)
      out.push('timerFired');
  }
  return out;
}

/**
 * 等这次 Update。不可恢复的身份若仍起了 catchup 定时器，用 unblock 解开挂着的活动，
 * 让定时器按历史走完（测试服务端跳过剩余时间也会留下 TimerFired），再把历史交回去断言。
 */
async function finishUpdate(
  h: WorkflowHandle,
  pending: Promise<RemeasureLineBudgetResult>,
  unblock: () => void,
): Promise<{ result: RemeasureLineBudgetResult; events: HistEvent[] }> {
  let stop = false;
  const sawTimer = (async () => {
    const deadline = Date.now() + 8_000;
    while (!stop && Date.now() < deadline) {
      if (startedTimerSeconds(await historyOf(h)).includes(REMEASURE_CATCH_UP_SECONDS)) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return false;
  })();
  const winner = await Promise.race([
    pending.then((result) => ({ kind: 'result' as const, result })),
    sawTimer.then((timer) => ({ kind: 'timer' as const, timer })),
  ]);
  stop = true;
  if (winner.kind === 'timer' && winner.timer) unblock();
  const result = winner.kind === 'result' ? winner.result : await pending;
  return { result, events: await historyOf(h) };
}

const expectNoCatchupTimer = (events: readonly HistEvent[]) => {
  expect(startedTimerSeconds(events).filter((s) => s === REMEASURE_CATCH_UP_SECONDS)).toEqual([]);
  expect(catchupTimers(events, true)).toEqual([]);
};

describe('体量关口重评（#3249）', { timeout: 180_000 }, () => {
  it('8037 行生成折扣、实际计量 1513：预检只测不放行，执行只放行这一份交付，不设永久豁免；旧停点历史可达、整段可重放', async () => {
    const { world, tasks, asks } = setup((ask) => measured(ask), true);
    const i = input();
    const { run, parked, full, workflowId } = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const id = await parkedIdentity(h);
        // 此刻的历史就是「停在体量关口的旧在途任务」：没有重评标记、没有重评 Update（下面核命令序）
        const parked = await h.fetchHistory();
        expect(id).toMatchObject({
          rawAddedLines: RAW,
          chargeableAddedLines: RAW,
          budget: DEFAULT_PR_LINE_BUDGET,
          base: BASE, // 停下时原始新增行实际按的 base（readDelivery 报的 addedLinesBase）
        });

        const checked = await send(h, command(i, h, id, { mode: 'check' }));
        expect(checked).toMatchObject({
          outcome: 'eligible',
          receipt: {
            chargeableAddedLines: 1513,
            verifiedGeneratedLines: 8037,
            rawAddedLines: RAW,
            head: id.head,
            base: BASE,
          },
        });
        await waitingHuman(h);
        expect(world.count('pushBranch')).toBe(0);

        const resumed = await send(h, command(i, h, id));
        expect(resumed.outcome).toBe('resumed');
        // 放行绑定对外可读（同一请求重发凭它拿幂等回执），停点身份不再可用
        expect((await status(h)).lineBudgetPark?.resumed).toEqual({
          identity: id,
          head: id.head,
          base: BASE,
        });
        // 这一份交付被推走；验收第一次不过，第 3 份交付没有折扣：必须重新计量并再次停下，没有永久豁免
        const next = await parkedIdentity(h, id.parks);
        expect(next.head).not.toBe(id.head);
        expect(next.parks).toBeGreaterThan(id.parks);
        expect(next.continued).toBe(id.continued); // 没有增加继续次数
        expect(world.count('pushBranch')).toBe(1);

        // 重放同一个已完成请求：只回原身份的回执，不放行新头
        const again = await send(h, command(i, h, id));
        expect(again).toMatchObject({ outcome: 'already_resumed', receipt: { head: id.head } });
        await waitingHuman(h);
        expect(world.count('pushBranch')).toBe(1);
        // 旧停点身份对新头不生效
        expect(await send(h, command(i, h, id, { head: next.head }))).toMatchObject({
          outcome: 'refused',
          reason: 'stale',
        });
        await h.signal(taskContinueSignal, { by: 'frank' });
        const run = (await h.result()) as TaskRun;
        return { run, parked, full: await h.fetchHistory(), workflowId: h.workflowId };
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(asks).toHaveLength(2); // check + resume 各测一次；重放不再测
    expect(asks[0]).toMatchObject({ base: BASE, rawAddedLines: RAW });

    // 旧在途历史：停到体量关口的命令序与重评之前的代码一致；这段前缀原样在整段历史里，后面接重评 Update
    // （标记第一次在 Update 里问）和放行后的推、验收、再停、继续、合并。两段都按现在的代码重放不报对不上。
    expect(commandsOf(parked.events ?? [])).toEqual(OLD_PARK_COMMANDS);
    expect(JSON.stringify(parked)).not.toContain('taskRemeasureLineBudget');
    expect(commandsOf(full.events ?? []).slice(0, OLD_PARK_COMMANDS.length)).toEqual(OLD_PARK_COMMANDS);
    expect(JSON.stringify(full)).toContain('taskRemeasureLineBudget');
    const bundle = { workflowBundle: await engineBundle() };
    await Worker.runReplayHistory(bundle, parked, workflowId);
    await Worker.runReplayHistory(bundle, full, workflowId);
  });

  it('人点「继续」仍保留既有授权语义：之后的交付不再判体量', async () => {
    const { world, tasks } = setup((ask) => measured(ask), true);
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        await parkedIdentity(h);
        await h.signal(taskContinueSignal, { by: 'frank' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    // 验收第一次不过后的第 3 份交付仍是 9550 行，没有再停下（budgetApproved）：全程没有第二次停点
    expect(run.outcome).toBe('merged');
    expect(world.alerts.filter((a) => a.title.includes('体量预算'))).toHaveLength(1);
  });

  it('硬界与未知都保留原停点并写明原因：不可信测量、仍超预算、读失败、旧 worker', async () => {
    const answers: Remeasure[] = [
      (ask) =>
        measured(ask, {
          measurement: {
            verified: false,
            verifiedGeneratedLines: 0,
            chargeableAddedLines: RAW,
            reason: 'raw 新增超过 20000 行，不适用自动折扣',
          },
        }),
      (ask) => measured(ask, { measurement: { verifiedGeneratedLines: 4000, chargeableAddedLines: 5550 } }),
      () => {
        throw new Error('git 读取失败');
      },
      (ask) => ({ head: ask.head, commits: 0, changedFiles: [] }),
      (ask) => measured(ask, { measurement: { verifiedGeneratedLines: 1, chargeableAddedLines: 1 } }),
    ];
    // 读失败的活动会被重试：答案按「第几个请求」换，不按调用次数
    let current = answers[0] as Remeasure;
    const { world, tasks } = setup((ask) => current(ask));
    const i = input();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const id = await parkedIdentity(h);
        const reasons: string[] = [];
        for (let k = 0; k < answers.length; k++) {
          current = answers[k] as Remeasure;
          const r = await send(h, command(i, h, id));
          expect(r.outcome).toBe('refused');
          if (r.outcome === 'refused') reasons.push(r.reason);
          await waitingHuman(h);
          expect((await status(h)).lineBudgetPark?.identity).toMatchObject({ parks: id.parks });
        }
        expect(reasons).toEqual(['unverified', 'over_budget', 'unknown', 'unsupported', 'unverified']);
        expect(world.count('pushBranch')).toBe(0);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测试收场' });
        await h.result();
      },
      { tasks },
    );
  });

  it('精确身份、脏树、未跟踪、头基线变化都拒绝并保留停点', async () => {
    const dirty: Remeasure = (ask) => ({
      head: ask.head,
      commits: 0,
      changedFiles: [],
      budgetRemeasure: {
        version: 1,
        status: 'refused',
        reason: 'dirty',
        detail: '工作树有没提交的改动：?? new.ts',
      },
    });
    const answers: Remeasure[] = [
      dirty,
      (ask) => measured(ask, { answer: { headAfter: fakeHead(999) } }),
      (ask) => measured(ask, { answer: { cleanAfter: false } }),
      (ask) => measured(ask, { answer: { base: fakeHead(2) } }),
      (ask) => measured(ask, { measurement: { rawAddedLines: RAW + 1, chargeableAddedLines: 1514 } }),
    ];
    let n = 0;
    // 停下时那次测量的 base 是 BASE：停点身份钉住它
    const { world, tasks } = setup((ask) => (answers[n++] as Remeasure)(ask), false, { measuredBase: BASE });
    const i = input();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const id = await parkedIdentity(h);
        expect(id.base).toBe(BASE);
        // 换另一个（更早的）base 改测量范围：不进活动就拒
        expect(await send(h, command(i, h, id, { base: fakeHead(3) }))).toMatchObject({
          outcome: 'refused',
          reason: 'changed',
        });
        expect(n).toBe(0);
        for (let k = 0; k < answers.length; k++) {
          const r = await send(h, command(i, h, id));
          expect(r).toMatchObject({ outcome: 'refused', reason: 'changed' });
        }
        expect(n).toBe(answers.length);
        // 以下不进活动：形状、仓、任务、工作流、run、head 不对
        const bad: Partial<RemeasureLineBudgetCommand>[] = [
          { head: 'abc' },
          { base: 'abc' },
          { repo: { owner: 'x', name: 'y' } },
          { taskId: 'other' },
          { workflowId: 'task:other#1' },
          { identity: { ...id, runId: 'other-run' } },
        ];
        for (const over of bad) {
          expect(await send(h, command(i, h, id, over))).toMatchObject({
            outcome: 'refused',
            reason: 'identity',
          });
        }
        expect(await send(h, command(i, h, id, { head: fakeHead(555) }))).toMatchObject({ reason: 'stale' });
        expect(await send(h, command(i, h, { ...id, continued: 7 }))).toMatchObject({ reason: 'stale' });
        // 身份里的 base 也是身份的一部分：改了就不是这次停点
        expect(
          await send(h, command(i, h, { ...id, base: fakeHead(3) }, { base: fakeHead(3) })),
        ).toMatchObject({ reason: 'stale' });
        expect(n).toBe(answers.length);
        expect(world.count('pushBranch')).toBe(0);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测试收场' });
        await h.result();
      },
      { tasks },
    );
  });

  it('并发请求只一个测，另一个 busy；测量期间人点「继续」则旧测量作废，走原授权语义', async () => {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { world, tasks } = setup(async (ask) => {
      entered();
      await gate;
      return measured(ask);
    });
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const id = await parkedIdentity(h);
        const first = send(h, command(i, h, id));
        await inFlight;
        expect((await status(h)).lineBudgetPark?.identity).toBeNull(); // 重评中不暴露可用身份
        expect(await send(h, command(i, h, id))).toMatchObject({ outcome: 'refused', reason: 'busy' });
        await h.signal(taskContinueSignal, { by: 'frank' });
        release();
        expect(await first).toMatchObject({ outcome: 'refused', reason: 'stale' });
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.count('pushBranch')).toBe(1);
  });

  it('测量期间放弃：取消测量、不放行任何东西', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered: () => void = () => {};
    const inFlight = new Promise<void>((r) => {
      entered = r;
    });
    const { world, tasks } = setup(async (ask) => {
      entered();
      await gate;
      return measured(ask);
    });
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const id = await parkedIdentity(h);
        const pending = send(h, command(i, h, id));
        await inFlight;
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '不要了' });
        expect(await pending).toMatchObject({ outcome: 'refused', reason: 'unknown' });
        const result = h.result() as Promise<TaskRun>;
        release(); // 活动自己跑完的结果已被丢弃；放开它好让测试 worker 干净收场
        return result;
      },
      { tasks },
    );
    expect(run.outcome).toBe('abandoned');
    expect(world.count('pushBranch')).toBe(0);
  });

  it('旧代码停下的真实历史：现在的代码重放不报对不上；那时没记测量 base，现停点这样的一律明确拒绝、不进活动', async () => {
    // 夹具是旧代码录的：没有重评标记、没有重评 Update，停在体量预算的报警上
    const text = JSON.stringify(OLD_PARK.events);
    expect(text).not.toContain('taskRemeasureLineBudget');
    expect(OLD_PARK_COMMANDS).not.toContain('patch:line-budget-remeasure-v1');
    expect(OLD_PARK_COMMANDS).toContain('patch:pr-line-budget');
    expect(OLD_PARK_COMMANDS.at(-1)).toBe('raiseAlert');
    expect(text).not.toContain('addedLinesBase');
    await Worker.runReplayHistory(
      { workflowBundle: await engineBundle() },
      { events: OLD_PARK.events } as never,
      OLD_PARK.workflowId,
    );

    // 同样形状（交付不报 addedLinesBase）的停点在现在的代码上：身份 base 为 null，重评明确拒绝，不拿请求者给的 base 顶替
    const { world, tasks, asks } = setup((ask) => measured(ask), false, { old: true });
    const i = input();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const id = await parkedIdentity(h);
        expect(id.base).toBeNull();
        expect(await send(h, command(i, h, id))).toMatchObject({ outcome: 'refused', reason: 'unsupported' });
        await waitingHuman(h);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测试收场' });
        await h.result();
      },
      { tasks },
    );
    expect(asks).toHaveLength(0);
    expect(world.count('pushBranch')).toBe(0);
  });

  it('跨工人接停点：停在体量关口时工人下线，新起的工人从历史整段重放接手，处理重评后照原路走完', async () => {
    const { world, tasks, asks } = setup((ask) => measured(ask));
    const i = input();
    const taskQueue = `q-${randomUUID()}`;
    // 第一个工人不缓存：下线后不留粘性队列（可跳时间的测试服务端不会把下线工人粘性队列里的任务挪回普通队列）
    const { h, id } = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        return { h, id: await parkedIdentity(h) };
      },
      { tasks, taskQueue, maxCachedWorkflows: 0 },
    );
    // 下线时的停点历史，命令序与旧代码录的真实历史逐条一致
    const parked = await h.fetchHistory();
    expect(commandsOf(parked.events ?? [])).toEqual(OLD_PARK_COMMANDS);
    // 新起的工人（像部署后的新进程，缓存是空的）：第一个工作流任务就是从上面那份历史整段重放，再处理重评
    const run = await withWorker(
      env,
      world,
      async () => {
        expect(await send(h, command(i, h, id))).toMatchObject({
          outcome: 'resumed',
          receipt: { chargeableAddedLines: 1513, verifiedGeneratedLines: 8037, base: BASE },
        });
        // 接手后的重发：只回原身份的幂等回执
        expect(await send(h, command(i, h, id))).toMatchObject({
          outcome: 'already_resumed',
          receipt: { head: id.head },
        });
        return h.result() as Promise<TaskRun>;
      },
      { tasks, taskQueue },
    );
    expect(run.outcome).toBe('merged');
    expect(asks).toHaveLength(1);
    expect(world.count('pushBranch')).toBe(1);
  });

  it('catchup：同一身份在停点可见前等到，重评成功且 30 秒定时器取消', async () => {
    const { world, tasks, asks } = setup((ask) => measured(ask), false, { holdPorts: ['raiseAlert'] });
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        await world.until(
          () => world.calls.some((c) => c.port === 'raiseAlert' && c.end === null),
          '体量停点的报警还挂着',
        );
        const id = formingPark((await h.describe()).runId);
        const pending = send(h, command(i, h, id));
        await waitUntil(async () => {
          const open = startedTimerSeconds(await historyOf(h)).filter(
            (s) => s === REMEASURE_CATCH_UP_SECONDS,
          );
          const done =
            catchupTimers(await historyOf(h), true).length + catchupTimers(await historyOf(h), false).length;
          return open.length > done;
        }, '同一身份的 catchup 定时器已起');
        world.releasePort('raiseAlert');
        expect(await pending).toMatchObject({
          outcome: 'resumed',
          receipt: { head: id.head, base: BASE, chargeableAddedLines: 1513 },
        });
        const events = await historyOf(h);
        expect(catchupTimers(events, true)).toEqual([]);
        expect(catchupTimers(events, false)).toEqual([REMEASURE_CATCH_UP_SECONDS]);
        expect(asks).toHaveLength(1);
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(world.count('pushBranch')).toBe(1);
  });

  it('catchup：等待中放弃，定时器取消而不是响，旧请求 stale，工作流结束', async () => {
    const { world, tasks, asks } = setup((ask) => measured(ask), false, { holdPorts: ['raiseAlert'] });
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        await world.until(
          () => world.calls.some((c) => c.port === 'raiseAlert' && c.end === null),
          '体量停点的报警还挂着',
        );
        const id = formingPark((await h.describe()).runId);
        const pending = send(h, command(i, h, id));
        await waitUntil(
          async () => startedTimerSeconds(await historyOf(h)).includes(REMEASURE_CATCH_UP_SECONDS),
          'catchup 定时器已起',
        );
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '不要了' });
        // 报警是不可取消的：一直挂着，测试服务端不能把 30 秒跳掉。放弃若唤不醒，这里会真等满才返回。
        expect(await pending).toMatchObject({ outcome: 'refused', reason: 'stale' });
        const events = await historyOf(h);
        expect(catchupTimers(events, true)).toEqual([]);
        expect(catchupTimers(events, false)).toEqual([REMEASURE_CATCH_UP_SECONDS]);
        expect(asks).toHaveLength(0);
        world.releasePort('raiseAlert');
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('abandoned');
    expect(world.count('pushBranch')).toBe(0);
  });

  it('catchup：先查停点，继续后旧请求进入等待，等待中放弃叫醒；不测不推，定时器取消而不是响', async () => {
    let releaseMirror: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseMirror = r;
    });
    let mirrorHeld: () => void = () => {};
    const held = new Promise<void>((r) => {
      mirrorHeld = r;
    });
    let sawBudgetAlert = false;
    const { world, tasks, asks } = setup((ask) => measured(ask));
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const id = await parkedIdentity(h);
        await h.signal(taskContinueSignal, { by: 'frank' });
        await held;
        const pending = send(h, command(i, h, id));
        // 定时器已起且还没结算：谓词当时为假，卡在 condition 里。继续若已让早退，这里等不到。
        // 落库活动还挂着，测试服务端不能把 30 秒跳掉；放弃若唤不醒，下面会真等到定时器响。
        await waitUntil(async () => {
          const open = startedTimerSeconds(await historyOf(h)).filter(
            (s) => s === REMEASURE_CATCH_UP_SECONDS,
          );
          const done =
            catchupTimers(await historyOf(h), true).length + catchupTimers(await historyOf(h), false).length;
          return open.length > done;
        }, '继续之后旧请求的 catchup 定时器已起且还在等');
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '不要了' });
        expect(await pending).toMatchObject({ outcome: 'refused', reason: 'stale' });
        const events = await historyOf(h);
        const trace = catchupWakeTrace(events);
        const continuedAt = trace.indexOf('taskContinue');
        const startedAt = trace.indexOf('timerStarted', continuedAt + 1);
        const abandonedAt = trace.indexOf('taskAbandon', startedAt + 1);
        const canceledAt = trace.indexOf('timerCanceled', abandonedAt + 1);
        expect(continuedAt).toBeGreaterThanOrEqual(0);
        expect(startedAt).toBeGreaterThan(continuedAt);
        expect(abandonedAt).toBeGreaterThan(startedAt);
        expect(canceledAt).toBeGreaterThan(abandonedAt);
        expect(trace).not.toContain('timerFired');
        expect(catchupTimers(events, true)).toEqual([]);
        expect(catchupTimers(events, false)).toEqual([REMEASURE_CATCH_UP_SECONDS]);
        expect(asks).toHaveLength(0);
        expect(world.count('pushBranch')).toBe(0);
        releaseMirror();
        return h.result() as Promise<TaskRun>;
      },
      {
        tasks,
        wrapActivities: (acts) => ({
          ...acts,
          raiseAlert: async (input) => {
            const out = await acts.raiseAlert(input);
            if (input.title.includes('体量预算')) sawBudgetAlert = true;
            return out;
          },
          saveTaskState: async (input) => {
            if (sawBudgetAlert && input.state === 'running') {
              mirrorHeld();
              await gate;
            }
            return acts.saveTaskState(input);
          },
        }),
      },
    );
    expect(run.outcome).toBe('abandoned');
    expect(world.count('pushBranch')).toBe(0);
    expect(asks).toHaveLength(0);
  });

  it('catchup：请求到达时已经放弃，直接拒绝，不起 30 秒定时器', async () => {
    const { world, tasks, asks } = setup((ask) => measured(ask), false, { holdPorts: ['removeWorktree'] });
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const id = await parkedIdentity(h);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '不要了' });
        await world.until(
          () => world.calls.some((c) => c.port === 'removeWorktree' && c.end === null),
          '放弃后正在收树',
        );
        const pending = send(h, command(i, h, id));
        const { result, events } = await finishUpdate(h, pending, () => world.releasePort('removeWorktree'));
        expect(result).toMatchObject({ outcome: 'refused', reason: 'stale' });
        expectNoCatchupTimer(events);
        expect(asks).toHaveLength(0);
        world.releasePort('removeWorktree');
        return h.result() as Promise<TaskRun>;
      },
      { tasks },
    );
    expect(run.outcome).toBe('abandoned');
    expect(world.count('pushBranch')).toBe(0);
  });

  it('catchup：请求到达时已经换代，直接拒绝，不测也不唤醒新停点', async () => {
    let releaseAlert: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseAlert = r;
    });
    let secondEntered: () => void = () => {};
    const entered = new Promise<void>((r) => {
      secondEntered = r;
    });
    let alerts = 0;
    const { world, tasks, asks } = setup((ask) => measured(ask), true);
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        const id = await parkedIdentity(h);
        expect(await send(h, command(i, h, id))).toMatchObject({ outcome: 'resumed' });
        await entered;
        // 同一请求的幂等回执在新停点还没可见时也不再测、不唤醒它
        expect(await send(h, command(i, h, id))).toMatchObject({
          outcome: 'already_resumed',
          receipt: { head: id.head, base: BASE },
        });
        expect(asks).toHaveLength(1);
        const pending = send(h, command(i, h, id, { mode: 'check' }));
        const { result, events } = await finishUpdate(h, pending, releaseAlert);
        expect(result).toMatchObject({ outcome: 'refused', reason: 'stale' });
        expectNoCatchupTimer(events);
        expect(asks).toHaveLength(1);
        const pushes = world.count('pushBranch');
        releaseAlert();
        const next = await parkedIdentity(h, id.parks);
        expect(next.parks).toBeGreaterThan(id.parks);
        expect(next.head).not.toBe(id.head);
        await waitingHuman(h);
        expect(world.count('pushBranch')).toBe(pushes);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测试收场' });
        return h.result() as Promise<TaskRun>;
      },
      {
        tasks,
        wrapActivities: (acts) => ({
          ...acts,
          raiseAlert: async (input) => {
            alerts += 1;
            if (alerts === 2) {
              secondEntered();
              await gate;
            }
            return acts.raiseAlert(input);
          },
        }),
      },
    );
    expect(run.outcome).toBe('abandoned');
    expect(asks).toHaveLength(1);
  });

  it('catchup：计数还小于请求时有界等满 30 秒再拒绝，不测不放行', async () => {
    let releaseRead: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseRead = r;
    });
    let secondEntered: () => void = () => {};
    const entered = new Promise<void>((r) => {
      secondEntered = r;
    });
    let reads = 0;
    const { world, tasks, asks } = setup((ask) => measured(ask));
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, i);
        await entered;
        const id = formingPark((await h.describe()).runId, { parks: 99, generation: 99, continued: 99 });
        const pending = send(h, command(i, h, id));
        expect(await pending).toMatchObject({ outcome: 'refused', reason: 'stale' });
        const events = await historyOf(h);
        expect(catchupTimers(events, true)).toEqual([REMEASURE_CATCH_UP_SECONDS]);
        expect(asks).toHaveLength(0);
        expect(world.count('pushBranch')).toBe(0);
        releaseRead();
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测试收场' });
        return h.result() as Promise<TaskRun>;
      },
      {
        tasks,
        wrapActivities: (acts) => ({
          ...acts,
          readDelivery: async (input) => {
            if (!input.budgetRemeasure) {
              reads += 1;
              if (reads === 2) {
                secondEntered();
                await gate;
              }
            }
            return acts.readDelivery(input);
          },
        }),
      },
    );
    expect(run.outcome).toBe('abandoned');
    expect(asks).toHaveLength(0);
  });
});
