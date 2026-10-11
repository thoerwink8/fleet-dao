// 派前探测 + 换下一条（#1798 片 4）：选路选出要派的那一条之后、起会话之前先探一次（活动 probeAssignedRoute，15 分钟新鲜线，
// 见 jobs/dispatch-probe.ts），探不通就避开它再选，一轮最多 3 条。动手那一段工作流里早就有同一套（workflows/task-session.ts
// 的 consider/stopForProbe）；这一份给「会起会话、但不在工作流里」的选路用：验收（real/task-verify.ts 经 cold-verify-pick.ts
// 的按族选路）和临时指挥官整理待办（real/groom.ts）。
//
// 改这里之前必须知道：
// - 选法（按族、按用途）留在调用方：这里只把「再避开这几条」交给它的 pick，不改它的语义（避开别的族、认族名、记已经挑过的）。
// - 只探真探得动的：探针自己按规矩不探的（按量计费、插头没接、下架、挂着别的组织）回 counted 为假，不占 3 条名额，
//   和动手那一段同一个口径（workflows/task-support.ts 的 DISPATCH_PROBE_LIMIT）。
// - 探不通的那一条：它选路时预占的池名额要当场放掉（没进起会话，不能占着池等到过期），调用方给 onUnprobed。
// - 选路本身说派不出（等空位、等额度、一条能用的都没有）：不探，原样交回给调用方（等还是停由它判）。
// - 三条都不通：不是「选路派不出」，是「候选都在派前探测里被打掉」——回 exhausted，带上每一条的结果（谁、为什么）。

import type { PickRouteResult, RouteChoice } from '../ports.ts';
import type { ProbeAssignedResult } from '../task-contract.ts';
import {
  DISPATCH_PROBE_LIMIT,
  type DispatchProbeFail,
  dispatchProbeLine,
} from '../workflows/task-support.ts';

/** 一轮最多当场探几条（和动手那一段同一个数）。 */
export const PICK_THEN_PROBE_LIMIT = DISPATCH_PROBE_LIMIT;

/** 派前探这一条：活动 probeAssignedRoute 的样子（生产在 real/index.ts 装配）。 */
export type AssignedProber = (input: { routeId: string; label: string }) => Promise<ProbeAssignedResult>;

/** 探不通的每一条：谁、为什么（停下来时带上，写进原因/提醒）。 */
export interface PickThenProbeFailure extends DispatchProbeFail {
  routeId: string;
}

/**
 * 「一轮」的共享状态：真探了几条、已经打掉哪几条。验收按族问好几轮（每族一次）时跨调用共用一份：
 * - 上限是「这一轮真探了几条」，不是「失败了几条」——探通的那条也占名额，不然换了族又能再探三条
 *   （一轮真探 3 条是硬上限，和各族问几轮无关）。
 * - 打掉的名单也共用：三条都不通时要把每一族打掉的每一条都带上，不能只留最后一个族那一条。
 */
export interface ProbeBudget {
  probed: number;
  failures: PickThenProbeFailure[];
}

/** 跨调用共用一份名额和打掉名单（验收按族问好几轮时给；不给就这一次算一轮）。 */
export function createProbeBudget(): ProbeBudget {
  return { probed: 0, failures: [] };
}

export interface PickThenProbeDeps {
  /**
   * 用「再避开这几条」重选一次。调用方自己的选法（按族、按用途）原样保留，只多一个避让。
   * 回的是选路端口那一份结果（派、等、派不出）。
   */
  pick: (avoidRouteIds: readonly string[]) => Promise<PickRouteResult>;
  /** 派前探选中的那一条（活动 probeAssignedRoute）。 */
  probe: AssignedProber;
  /** 探不通的那一条：放掉它预占的名额。抛了只记日志，不改这一轮的结果。 */
  onUnprobed?: (route: RouteChoice) => Promise<void>;
  /** 跨调用共用的名额和打掉名单（验收按族问好几轮时给；不给就这一次算一轮）。 */
  budget?: ProbeBudget;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export type PickThenProbeOutcome =
  /** 选到一条、探通了：可以起会话。failures 是先探不通、被换掉的那几条（含共用预算里别的族打掉的）。 */
  | { kind: 'picked'; route: RouteChoice; why: string; failures: PickThenProbeFailure[] }
  /** 选路自己说派不出（等空位 / 等额度 / 一条能用的都没有）：没探，原样交回。 */
  | { kind: 'unavailable'; result: Extract<PickRouteResult, { ok: false }>; failures: PickThenProbeFailure[] }
  /** 探满 3 条都不通：派不出，带上每一条的结果。 */
  | { kind: 'exhausted'; failures: PickThenProbeFailure[] };

/** 停下来时的那一句（和动手那一段同一份写法：每条「谁 不通（为什么）」用「；」连起来）。 */
export function pickThenProbeStopText(failures: readonly PickThenProbeFailure[]): string {
  return dispatchProbeLine(failures, null);
}

/**
 * 选一条就派前探一次，不通就避开它再选，一轮最多 PICK_THEN_PROBE_LIMIT 条真探（共用预算时跨调用一起数）。
 * 探通的直接交回（带这一轮打掉的几条）；探满 3 条回 exhausted；选路说派不出回 unavailable。
 * avoidRouteIds 是调用方本来就要避开的（老避让、已经挑过的），在这里往下接着攒。
 */
export async function pickThenProbe(
  deps: PickThenProbeDeps,
  input: { avoidRouteIds?: readonly string[] } = {},
): Promise<PickThenProbeOutcome> {
  const avoid = [...(input.avoidRouteIds ?? [])];
  // 共用的预算里记着前面几次调用打掉的每一条；这一次也往里攒，停下来时一起交回（验收三条都不通要带全）。
  const budget = deps.budget ?? createProbeBudget();
  const failures = budget.failures;
  for (;;) {
    if (budget.probed >= PICK_THEN_PROBE_LIMIT) return { kind: 'exhausted', failures: [...failures] };
    const got = await deps.pick(avoid);
    if (!got.ok) return { kind: 'unavailable', result: got, failures: [...failures] };
    const probe = await deps.probe({ routeId: got.route.routeId, label: got.route.modelId });
    // 真探过的都占名额——探通的那条也算：不这样，跨族共用预算时第一族探两条失败、第三条探通后，
    // 第二族还能再探三条，一轮就超过 3 条了。没真探的（复用了 15 分钟内的旧结论、按规矩没探）不占。
    if (probe.kind === 'pass' ? probe.probed : probe.counted) budget.probed += 1;
    if (probe.kind === 'pass')
      return { kind: 'picked', route: got.route, why: got.why, failures: [...failures] };
    failures.push({ routeId: got.route.routeId, label: probe.label, detail: probe.detail });
    // 这条不会进起会话：它预占的名额当场放掉，别占着池等它过期。放不掉只记日志，不改这一轮的结果。
    if (deps.onUnprobed) {
      try {
        await deps.onUnprobed(got.route);
      } catch (err) {
        deps.log?.('派前探测：探不通那条的预占没放掉（最多占到预占过期）', {
          routeId: got.route.routeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!avoid.includes(got.route.routeId)) avoid.push(got.route.routeId);
  }
}
