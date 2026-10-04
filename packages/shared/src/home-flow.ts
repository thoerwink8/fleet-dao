// 主页三段流水线图的数：每张在跑的单现在在哪一段、谁在做、最近一次事件，以及每段在途几张、平均多久。
// 全部从三段流水（runs 表，经 readSegmentRun 读好的）推出；推不出的不猜（segment 给 null，图上落进「还没分段」）。
// 改这里之前必须知道：
// - 「还没验」（verify_pending）只表示动手收了、验收还没起，是等，不是失败；真失败只有三段流水自己的结局（超时 / 失败 / 没起来）。
// - 平均耗时只用 outcome=done 且起止读得出来的笔（readSegmentRun 已把「起止同一刻」这类占位挡成没读到）；样本为 0 就不给平均，不拿 0 顶。

import type { z } from 'zod';
import type { SegmentKind, Task } from './domain.ts';
import { SEGMENT_LABELS, SEGMENT_OUTCOME_LABELS, type SegmentRunView } from './segment-runs.ts';
import type { HomeFlowStageSchema, HomeRunningSchema } from './web-api.ts';

type HomeRunning = z.input<typeof HomeRunningSchema>;
type HomeSegment = HomeRunning['segment'];
type LastEvent = NonNullable<HomeRunning['lastEvent']>;
type FlowStage = z.input<typeof HomeFlowStageSchema>;

/** 三段先后。 */
export const FLOW_SEGMENTS: readonly SegmentKind[] = ['scope', 'manual', 'verify'];

/** 主页的 segment 枚举属于哪一段（图上的泳道）。null（推不出）不属于任何一段。 */
export function laneOf(segment: HomeSegment): SegmentKind | null {
  switch (segment) {
    case 'scoping':
      return 'scope';
    case 'doing':
      return 'manual';
    case 'verifying':
    case 'verify_pending':
    case 'merge':
      return 'verify';
    case null:
      return null;
  }
}

export interface TaskFlow {
  segment: HomeSegment;
  stageSince?: string;
  worker?: string;
  lastEvent?: LastEvent;
}

const RUNNING_OF: Record<SegmentKind, HomeSegment> = {
  scope: 'scoping',
  manual: 'doing',
  verify: 'verifying',
};

/** 跑完（done）之后单子落在哪：对题收了等动手起、动手收了等验收起（还没验）、验收收了等合并。 */
const NEXT_OF: Record<SegmentKind, HomeSegment> = {
  scope: 'doing',
  manual: 'verify_pending',
  verify: 'merge',
};

function lastEventOf(run: SegmentRunView): LastEvent | undefined {
  if (run.segment === null || run.startedAt === undefined) return undefined;
  const label = SEGMENT_LABELS[run.segment];
  if (run.running) return { text: `${label}开跑 · ${run.modelName}`, at: run.startedAt, tone: 'ok' };
  const at = run.endedAt ?? run.startedAt;
  const outcome = run.outcome;
  if (outcome === undefined) return { text: `${label}收场时没记结局`, at, tone: 'wait' };
  const reason = run.failureReason ? `：${run.failureReason}` : '';
  const text = `${label}${SEGMENT_OUTCOME_LABELS[outcome]}${outcome === 'done' ? '' : reason}`;
  if (outcome === 'done') return { text, at, tone: 'ok' };
  // 切号停下、内存满没放行、被停掉：引擎自己的动作，不是这张单做坏了
  if (outcome === 'org_switch' || outcome === 'admission_blocked' || outcome === 'killed') {
    return { text, at, tone: 'wait' };
  }
  return { text, at, tone: 'trouble' };
}

/**
 * 一张单现在在哪一段：看最近一笔三段流水（按起跑先后的最后一笔，认不出段名或起跑时刻的不算）。
 * 在跑 → 就在那一段、有人在做；收了 done → 往后一段、等着起；没收好（超时、失败、被停…）→ 还在那一段、没人在做。
 * 一笔都没有：排队 / 分诊中算还没开始对题；合并中算合并；其余推不出，null。单子自己的状态是合并中，永远归「合并」。
 */
export function taskFlow(task: Pick<Task, 'state'>, runs: readonly SegmentRunView[]): TaskFlow {
  let latest: SegmentRunView | undefined;
  for (const r of runs) {
    if (r.segment !== null && r.startedAt !== undefined) {
      if (!latest || (latest.startedAt ?? '') <= r.startedAt) latest = r;
    }
  }
  const merging = task.state === 'merging';
  if (!latest || latest.segment === null) {
    if (merging) return { segment: 'merge' };
    if (task.state === 'queued' || task.state === 'triaging') return { segment: 'scoping' };
    return { segment: null };
  }
  const lastEvent = lastEventOf(latest);
  const base = { ...(lastEvent ? { lastEvent } : {}) };
  if (latest.running) {
    return {
      segment: merging ? 'merge' : RUNNING_OF[latest.segment],
      ...(latest.startedAt ? { stageSince: latest.startedAt } : {}),
      worker: latest.modelName,
      ...base,
    };
  }
  const since = latest.endedAt ?? latest.startedAt;
  const segment = latest.outcome === 'done' ? NEXT_OF[latest.segment] : RUNNING_OF[latest.segment];
  return { segment: merging ? 'merge' : segment, ...(since ? { stageSince: since } : {}), ...base };
}

/** 图头上的三格：在途几张（按泳道数）、近期跑完的平均耗时。 */
export function flowStages(
  allRuns: readonly SegmentRunView[],
  running: readonly Pick<HomeRunning, 'segment'>[],
): FlowStage[] {
  return FLOW_SEGMENTS.map((segment) => {
    const durations = allRuns
      .filter((r) => r.segment === segment && r.outcome === 'done' && r.durationMs !== undefined)
      .map((r) => r.durationMs as number);
    const sum = durations.reduce((a, b) => a + b, 0);
    return {
      segment,
      inFlight: running.filter((r) => laneOf(r.segment) === segment).length,
      ...(durations.length > 0 ? { avgMs: Math.round(sum / durations.length) } : {}),
      samples: durations.length,
    };
  });
}
