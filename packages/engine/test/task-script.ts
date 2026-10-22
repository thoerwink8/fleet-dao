// 任务工作流的脚本化活动（测试和重放夹具录制器共用）：默认全走通；哪一步要出岔子，给那一步的脚本。
// 活动被调的先后记在 calls.order 里（验收一定在挂自动合并之前）。

import type { EngineTasks } from '../src/activities.ts';
import { fakeHead } from '../src/fakes.ts';
import { buildTaskBrief, type TaskBrief, type TaskBriefResult } from '../src/runner/task-brief.ts';
import type {
  ArmAutoMergeInput,
  ArmAutoMergeResult,
  CheckGuardedInput,
  ColdVerifyInput,
  ColdVerifyResult,
  DecideFlowModeInput,
  DecideFlowModeResult,
  DeliveryRead,
  GuardedPaths,
  HandBackLocalInput,
  HandBackLocalResult,
  MergeNowInput,
  MergeNowResult,
  MergeReadyInput,
  MergeReadyResult,
  MergeWait,
  NoteBare401Input,
  PlanSegmentResumeInput,
  PlanSegmentResumeResult,
  ReadCiPolicyResult,
  ReadCiReviewsInput,
  ReadDeliveryInput,
  ReadTaskBriefInput,
  ResolveConflictInput,
  ResolveConflictResult,
  RunSegmentInput,
  RunSegmentResult,
  SegmentSettledInput,
  SegmentSettledResult,
  SelfCheckInput,
  SelfCheckResult,
  TaskSpendInput,
  TaskSpendResult,
} from '../src/task-contract.ts';
import { type Bare401Stamp, nextBare401Stamp } from '../src/workflows/task-support.ts';

export const BODY = [
  '## 场景',
  '',
  '创始人要在驾驶舱看到每张单走到哪一步。',
  '',
  '## 原话',
  '',
  '「我回来打开驾驶舱，这张单就该在做完的那一栏」',
  '',
  '## 已知的模块',
  '',
  '- `packages/web/src/pages/`：驾驶舱页面',
  '',
  '## 怎么算做完',
  '',
  '1. 页面上能看到「验收中」这个状态',
  '',
].join('\n');

export function goodBrief(): TaskBrief {
  const r = buildTaskBrief({ issue: { number: 12, title: '给驾驶舱加状态', body: BODY, state: 'open' } });
  if (!r.ok) throw new Error('测试用的交代应该齐');
  return r.brief;
}

export interface Script {
  brief: (n: number) => TaskBriefResult;
  /** 安全边界的当前正文；旧脚本没有外部编辑时沿用最近一次显式读取的正文。 */
  contractBrief?: (input: ReadTaskBriefInput, n: number) => TaskBriefResult;
  segment: (
    input: RunSegmentInput,
    n: number,
    signal: AbortSignal,
    beat: () => void,
  ) => Promise<RunSegmentResult>;
  delivery: (n: number, input: ReadDeliveryInput) => DeliveryRead;
  /** signal：活动被取消（和 CI 同时起、CI 先红了，决定 0093）时会触发；要等它的脚本自己 await。 */
  verify: (
    input: ColdVerifyInput,
    n: number,
    signal: AbortSignal,
  ) => ColdVerifyResult | Promise<ColdVerifyResult>;
  guarded: (n: number, input: CheckGuardedInput) => GuardedPaths;
  arm: (n: number, input: ArmAutoMergeInput) => ArmAutoMergeResult;
  merged: (n: number) => MergeWait;
  /** 停在合并这一步后的复核（#3281）。默认不满足：老用例照旧等人点「继续」。不进 calls.order。 */
  mergeReady: (n: number, input: MergeReadyInput) => MergeReadyResult;
  /** 默认强制。不进 calls.order。 */
  ciPolicy: () => ReadCiPolicyResult;
  mergeNow: (n: number, input: MergeNowInput) => MergeNowResult;
  /** 判续会话（决定 0088）。默认续不上：老用例照旧开新会话。抛了＝活动没查成。 */
  resume: (input: PlanSegmentResumeInput, n: number) => PlanSegmentResumeResult;
  /** 动手会话收场后的自测（决定 0093）。默认没跑（skipped）：老用例照旧推。抛了＝活动没跑成。 */
  selfCheck: (input: SelfCheckInput, n: number) => SelfCheckResult;
  /** 这张单花掉多少 token（单任务预算）。默认 0。input 是活动入参（带不带起算时间由工作流定）。 */
  spend: (n: number, input: TaskSpendInput) => TaskSpendResult;
  /** 上一段收场了没有（决定 0093）；默认收场了。 */
  settled: (input: SegmentSettledInput, n: number) => SegmentSettledResult;
  /** 定这张单走三段还是全程（#2826）。默认三段：老用例照旧。 */
  flow: (input: DecideFlowModeInput, n: number) => DecideFlowModeResult;
  /** 并主线冲突里机械可解的引擎自己解（#3428）。默认没解（declined、无原因）：老用例照旧交给会话。抛了＝活动没做成。 */
  resolveConflict: (input: ResolveConflictInput, n: number) => ResolveConflictResult;
  /** 总轮数到顶交还本机（#3603）。默认留言、贴标签都成了。抛了＝没做成。 */
  handBack: (input: HandBackLocalInput, n: number) => HandBackLocalResult;
}

export interface Calls {
  contractReads: ReadTaskBriefInput[];
  /** 任务活动被调的先后（验收一定在挂自动合并之前）。 */
  order: string[];
  brief: number;
  segment: RunSegmentInput[];
  delivery: number;
  verify: ColdVerifyInput[];
  guarded: number;
  /** 查路径收到的入参（批准只认当时的头）。不进 order。 */
  guardedInputs: CheckGuardedInput[];
  arm: number;
  /** 挂自动合并被调时收到的入参。 */
  armInputs: ArmAutoMergeInput[];
  merged: number;
  /** 停在合并这一步后复核收到的入参。不进 order。 */
  mergeReady: MergeReadyInput[];
  /** 读 CI 模式的次数。不进 order。 */
  ciPolicy: number;
  /** CI 红返工读评审的入参。不进 order（老用例比 order 一字不差）。默认成功且没有评审。 */
  ciReviews: ReadCiReviewsInput[];
  /** 直接合并的次数。不进 order。 */
  merge: number;
  /** 判续会话收到的入参。不进 order。 */
  resume: PlanSegmentResumeInput[];
  /** 自测收到的入参。不进 order。 */
  selfCheck: SelfCheckInput[];
  /** 查花费的次数。不进 order。 */
  spend: number;
  /** 查花费收到的入参（起算时间在不在里面）。不进 order。 */
  spendInputs: TaskSpendInput[];
  settled: SegmentSettledInput[];
  /** 定模式收到的入参。不进 order（老用例比 order 一字不差）。 */
  flow: DecideFlowModeInput[];
  /** 机械解冲突收到的入参。不进 order（老用例比 order 一字不差）。 */
  resolveConflict: ResolveConflictInput[];
  /** 交还本机收到的入参（#3603）。不进 order（老用例比 order 一字不差）。 */
  handBack: HandBackLocalInput[];
  /** 每次定模式时已经起过几段会话（第一段动手之前定＝0）。 */
  flowAfterSegments: number[];
}

export const OK_SEGMENT: RunSegmentResult = { ok: true, runId: 'run-1', answer: '已提交' };

/**
 * 活动还在跑时给心跳，放弃的取消靠它送进来。
 * 间隔 200ms，且上一次心跳的调用没回来就不再开下一次：20ms 不重叠地打 RPC 时，慢的测试服务端会把活动完成挤到用例时限之后，时间也不跳。
 */
function heartbeats(beat: () => unknown): () => void {
  let pending = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = true;
    Promise.resolve(beat()).finally(() => {
      pending = false;
    });
  }, 200);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** 默认全走通；哪一步要出岔子，给那一步的脚本。 */
export function scripted(over: Partial<Script> = {}): { tasks: EngineTasks; calls: Calls } {
  const calls: Calls = {
    contractReads: [],
    order: [],
    brief: 0,
    segment: [],
    delivery: 0,
    verify: [],
    guarded: 0,
    guardedInputs: [],
    arm: 0,
    armInputs: [],
    merged: 0,
    mergeReady: [],
    ciPolicy: 0,
    ciReviews: [],
    merge: 0,
    resume: [],
    selfCheck: [],
    spend: 0,
    spendInputs: [],
    settled: [],
    flow: [],
    resolveConflict: [],
    handBack: [],
    flowAfterSegments: [],
  };
  const script: Script = {
    brief: () => ({ ok: true, brief: goodBrief() }),
    segment: async () => OK_SEGMENT,
    delivery: (n) => ({
      head: fakeHead(100 + n),
      commits: 1,
      changedFiles: ['packages/web/src/pages/a.tsx'],
    }),
    verify: (_i, n) => ({ pass: true, problems: [], round: n === 1 ? 1 : 2 }),
    guarded: () => ({ standards: [] }),
    arm: () => ({ armed: true, merged: false }),
    merged: () => ({ state: 'merged', mergeCommit: 'abc1234567890' }),
    mergeReady: () => ({ ready: false, why: '测试默认不满足' }),
    ciPolicy: () => ({ mode: 'force' }),
    mergeNow: () => ({ merged: true, mergeCommit: 'abc1234567890' }),
    resume: () => ({ kind: 'new', reason: '测试默认不续' }),
    selfCheck: () => ({ state: 'skipped', reason: '测试默认不跑', steps: [] }),
    spend: () => ({ tokens: 0, runs: 0, unmetered: 0, estimated: 0 }),
    settled: () => ({ settled: true }),
    flow: () => ({ mode: 'three', source: 'ineligible', reason: '测试默认三段' }),
    resolveConflict: () => ({ state: 'declined', reason: '' }),
    handBack: () => ({ commented: true }),
    ...over,
  };
  const bare401 = new Map<string, Bare401Stamp>();
  let currentBrief: TaskBriefResult | null = null;
  const tasks: EngineTasks = {
    async readTaskBrief(input) {
      if (input.checkContract) {
        calls.contractReads.push(input);
        return (
          script.contractBrief?.(input, calls.contractReads.length) ??
          currentBrief ??
          script.brief(calls.brief)
        );
      }
      calls.order.push('brief');
      calls.brief += 1;
      currentBrief = script.brief(calls.brief);
      return currentBrief;
    },
    async runSegment(input, ctx) {
      calls.order.push('segment');
      calls.segment.push(input);
      // 心跳：放弃时 Temporal 要靠心跳把取消送进来。上一次还没回来就不再叠下一次。
      const stop = heartbeats(() => ctx.heartbeat());
      try {
        return await script.segment(input, calls.segment.length, ctx.signal, () => ctx.heartbeat());
      } finally {
        stop();
      }
    },
    async readDelivery(input) {
      calls.order.push('delivery');
      calls.delivery += 1;
      return script.delivery(calls.delivery, input);
    },
    async coldVerify(input, ctx) {
      calls.order.push('verify');
      calls.verify.push(input);
      // 心跳：取消要靠心跳送进来。上一次还没回来就不再叠下一次。
      const stop = heartbeats(() => ctx.heartbeat());
      try {
        return await script.verify(input, calls.verify.length, ctx.signal);
      } finally {
        stop();
      }
    },
    async checkGuarded(input) {
      calls.order.push('guarded');
      calls.guarded += 1;
      calls.guardedInputs.push(input);
      return script.guarded(calls.guarded, input);
    },
    async armAutoMerge(input) {
      calls.order.push('arm');
      calls.arm += 1;
      calls.armInputs.push(input);
      return script.arm(calls.arm, input);
    },
    async waitMerged() {
      calls.order.push('merged');
      calls.merged += 1;
      return script.merged(calls.merged);
    },
    async mergeReady(input) {
      calls.mergeReady.push(input);
      return script.mergeReady(calls.mergeReady.length, input);
    },
    async readCiPolicy() {
      calls.ciPolicy += 1;
      return script.ciPolicy();
    },
    async readCiReviews(input) {
      calls.ciReviews.push(input);
      return { delivered: true as const, head: input.expectedHead, reviews: [] };
    },
    async mergeNow(input) {
      calls.merge += 1;
      return script.mergeNow(calls.merge, input);
    },
    async planSegmentResume(input) {
      calls.resume.push(input);
      return script.resume(input, calls.resume.length);
    },
    async selfCheck(input) {
      calls.selfCheck.push(input);
      return script.selfCheck(input, calls.selfCheck.length);
    },
    async segmentSettled(input) {
      calls.settled.push(input);
      return script.settled(input, calls.settled.length);
    },
    async taskSpend(input) {
      calls.spend += 1;
      calls.spendInputs.push(input);
      return script.spend(calls.spend, input);
    },
    async noteBare401(input) {
      return noteSharedBare401(bare401, input);
    },
    async resolveConflictMechanically(input) {
      calls.resolveConflict.push(input);
      return script.resolveConflict(input, calls.resolveConflict.length);
    },
    async handBackLocal(input) {
      calls.handBack.push(input);
      return script.handBack(input, calls.handBack.length);
    },
    async decideFlowMode(input) {
      calls.flowAfterSegments.push(calls.segment.length);
      calls.flow.push(input);
      return script.flow(input, calls.flow.length);
    },
  };
  return { tasks, calls };
}

/**
 * 测试里同一份 scripted() 的任务共用这一张表，两个任务各打一次 401 才算第二次。
 * 窗口按真实时间算，不用工作流传进来的 now。那是可跳时间的测试服务端时钟：
 * await result() 会放开跳时间，活动的超时定时器能把时钟拨过 10 分钟（#1764）。
 * 两张单在真实时间里是紧挨着的，却会被算成窗口过了、第二次变成第一次。
 * 同一个 claim 再来（活动重试）仍算同一次，由 nextBare401Stamp 认。
 */
function noteSharedBare401(stamps: Map<string, Bare401Stamp>, input: NoteBare401Input) {
  const { stamp, repeated } = nextBare401Stamp(stamps.get(input.poolId), {
    now: new Date().toISOString(),
    claim: input.claim,
  });
  stamps.set(input.poolId, stamp);
  return { repeated };
}
