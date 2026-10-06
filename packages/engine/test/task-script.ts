// 任务工作流的脚本化活动（测试和重放夹具录制器共用）：默认全走通；哪一步要出岔子，给那一步的脚本。
// 活动被调的先后记在 calls.order 里（验收一定在挂自动合并之前）。

import type { EngineTasks } from '../src/activities.ts';
import { fakeHead } from '../src/fakes.ts';
import { buildTaskBrief, type TaskBrief, type TaskBriefResult } from '../src/runner/task-brief.ts';
import type {
  ArmAutoMergeResult,
  ColdVerifyInput,
  ColdVerifyResult,
  DeliveryRead,
  GuardedPaths,
  MergeWait,
  RunSegmentInput,
  RunSegmentResult,
} from '../src/task-contract.ts';

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
  delivery: (n: number) => DeliveryRead;
  verify: (input: ColdVerifyInput, n: number) => ColdVerifyResult;
  guarded: (n: number) => GuardedPaths;
  arm: (n: number) => ArmAutoMergeResult;
  merged: (n: number) => MergeWait;
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
  merged: number;
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
    merged: 0,
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
    ...over,
  };
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
    async readDelivery() {
      calls.order.push('delivery');
      calls.delivery += 1;
      return script.delivery(calls.delivery);
    },
    async coldVerify(input) {
      calls.order.push('verify');
      calls.verify.push(input);
      return script.verify(input, calls.verify.length);
    },
    async checkGuarded() {
      calls.order.push('guarded');
      calls.guarded += 1;
      return script.guarded(calls.guarded);
    },
    async armAutoMerge() {
      calls.order.push('arm');
      calls.arm += 1;
      return script.arm(calls.arm);
    },
    async waitMerged() {
      calls.order.push('merged');
      calls.merged += 1;
      return script.merged(calls.merged);
    },
  };
  return { tasks, calls };
}
