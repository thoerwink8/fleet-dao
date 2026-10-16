// 任务工作流的脚本化活动（测试和重放夹具录制器共用）：默认全走通；哪一步要出岔子，给那一步的脚本。
// 活动被调的先后记在 calls.order 里（验收一定在挂自动合并之前）。

import type { EngineTasks } from '../src/activities.ts';
import { fakeHead } from '../src/fakes.ts';
import { buildTaskBrief, type TaskBrief, type TaskBriefResult } from '../src/runner/task-brief.ts';
import type {
  ArmAutoMergeInput,
  ArmAutoMergeResult,
  ColdVerifyInput,
  ColdVerifyResult,
  DecideFlowModeInput,
  DecideFlowModeResult,
  DeliveryRead,
  GuardedPaths,
  MergeNowInput,
  MergeNowResult,
  MergeWait,
  NoteBare401Input,
  PlanSegmentResumeInput,
  PlanSegmentResumeResult,
  ReadCiPolicyResult,
  ReadDeliveryInput,
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
  guarded: (n: number) => GuardedPaths;
  arm: (n: number, input: ArmAutoMergeInput) => ArmAutoMergeResult;
  merged: (n: number) => MergeWait;
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
}

export interface Calls {
  /** 任务活动被调的先后（验收一定在挂自动合并之前）。 */
  order: string[];
  brief: number;
  segment: RunSegmentInput[];
  delivery: number;
  verify: ColdVerifyInput[];
  guarded: number;
  arm: number;
  /** 挂自动合并被调时收到的入参。 */
  armInputs: ArmAutoMergeInput[];
  merged: number;
  /** 读 CI 模式的次数。不进 order。 */
  ciPolicy: number;
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
  /** 每次定模式时已经起过几段会话（第一段动手之前定＝0）。 */
  flowAfterSegments: number[];
}

export const OK_SEGMENT: RunSegmentResult = { ok: true, runId: 'run-1', answer: '已提交' };

/** 默认全走通；哪一步要出岔子，给那一步的脚本。 */
export function scripted(over: Partial<Script> = {}): { tasks: EngineTasks; calls: Calls } {
  const calls: Calls = {
    order: [],
    brief: 0,
    segment: [],
    delivery: 0,
    verify: [],
    guarded: 0,
    arm: 0,
    armInputs: [],
    merged: 0,
    ciPolicy: 0,
    merge: 0,
    resume: [],
    selfCheck: [],
    spend: 0,
    spendInputs: [],
    settled: [],
    flow: [],
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
    ciPolicy: () => ({ mode: 'force' }),
    mergeNow: () => ({ merged: true, mergeCommit: 'abc1234567890' }),
    resume: () => ({ kind: 'new', reason: '测试默认不续' }),
    selfCheck: () => ({ state: 'skipped', reason: '测试默认不跑', steps: [] }),
    spend: () => ({ tokens: 0, runs: 0, unmetered: 0, estimated: 0 }),
    settled: () => ({ settled: true }),
    flow: () => ({ mode: 'three', source: 'ineligible', reason: '测试默认三段' }),
    ...over,
  };
  const bare401 = new Map<string, Bare401Stamp>();
  const tasks: EngineTasks = {
    async readTaskBrief() {
      calls.order.push('brief');
      calls.brief += 1;
      return script.brief(calls.brief);
    },
    async runSegment(input, ctx) {
      calls.order.push('segment');
      calls.segment.push(input);
      // 心跳：放弃时 Temporal 要靠心跳把取消送进来
      const beat = setInterval(() => ctx.heartbeat(), 20);
      try {
        return await script.segment(input, calls.segment.length, ctx.signal, () => ctx.heartbeat());
      } finally {
        clearInterval(beat);
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
      // 心跳：取消要靠心跳送进来
      const beat = setInterval(() => ctx.heartbeat(), 20);
      try {
        return await script.verify(input, calls.verify.length, ctx.signal);
      } finally {
        clearInterval(beat);
      }
    },
    async checkGuarded() {
      calls.order.push('guarded');
      calls.guarded += 1;
      return script.guarded(calls.guarded);
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
    async readCiPolicy() {
      calls.ciPolicy += 1;
      return script.ciPolicy();
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
    async decideFlowMode(input) {
      calls.flowAfterSegments.push(calls.segment.length);
      calls.flow.push(input);
      return script.flow(input, calls.flow.length);
    },
  };
  return { tasks, calls };
}

/** 测试里同一份 scripted() 的任务共用这一张表，两个任务各打一次 401 才算第二次。 */
function noteSharedBare401(stamps: Map<string, Bare401Stamp>, input: NoteBare401Input) {
  const { stamp, repeated } = nextBare401Stamp(stamps.get(input.poolId), {
    now: input.now,
    claim: input.claim,
  });
  stamps.set(input.poolId, stamp);
  return { repeated };
}
