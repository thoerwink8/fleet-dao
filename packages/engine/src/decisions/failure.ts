// 失败分流的引擎入口：工作流看到的失败 + 这一步的上下文 → 失败分流（failure/classify.ts：规则表认原因，认不出走兜底梯）
// → 下一步动作。经 decide 本地活动调，结果进历史；改规则表不会让在途任务重放对不上。
// 分流自己出错或答非所问（规则表写坏了）也不判死：退回只看次数的兜底梯（重试 → 换路由 → 换模型 → 挂起并报警）。

import type { StageKind } from '@fleet-dao/shared';
import { classifyFailure } from '../failure/classify.ts';
import type { JevReply } from '../failure/jev.ts';
import type { FailureEvidence, FailurePolicy, FailureVerdict, TriageChoice } from '../failure/types.ts';
import type { Limits } from '../limits.ts';

export type ActionClass = 'retry' | 'swapRoute' | 'swapModel' | 'park';

/** 兜底梯：有界重试 → 换路由 → 换模型 → 挂起并报警。 */
export const LADDER: readonly ActionClass[] = ['retry', 'swapRoute', 'swapModel', 'park'];

export interface FailureInfo {
  /** 出在哪一步，例如 `session:execute`、`createWorktree`。 */
  source: string;
  /** 结构化错误码：端口抛的 PortError.code、插头判定的原因（quota_exhausted、agent_error……）、Temporal 超时 `TIMEOUT_HEARTBEAT`…… */
  code: string;
  message: string;
  /** 端口说能不能重试；null = 没说。 */
  retryable: boolean | null;
}

/**
 * 换路时避开多大范围：route 只避这条路由；pool 避开整个账号池（封号、额度用满、设备被撤销——同一个池的别的路由照样撞）；
 * model 避开这个模型。
 */
export type AvoidScope = 'route' | 'pool' | 'model';

/** 这一步上已经用掉的处置次数。reworks = 返工（没交付、测试红、冲突），和基础设施的重试分开记。 */
export interface LadderCounters {
  retries: number;
  reworks: number;
  routeSwaps: number;
  modelSwaps: number;
}

/** 这一步的上下文：给分流认原因、算等多久。都可以不给（接上失败分流之前的历史里的判断没有这些）。 */
export interface FailureContext {
  stage?: StageKind | undefined;
  route?:
    | {
        routeId: string;
        poolId: string;
        modelId: string;
        hostId: string;
        channelId?: string | undefined;
        poolRole?: 'primary' | 'backup' | undefined;
      }
    | undefined;
  /** 上游给的清零时刻（ISO）/ 等待秒数。 */
  resetsAt?: string | undefined;
  retryAfterSeconds?: number | undefined;
  httpStatus?: number | undefined;
  exitCode?: number | null | undefined;
  signal?: string | null | undefined;
  transcriptTail?: string[] | undefined;
  /** 这一步上一次失败的原文：一字不差再犯，原路再试不会变。 */
  previousMessage?: string | undefined;
  /** 出事的机器、会话用户：只有人能修的（重新登录）要写清去哪修。 */
  machine?: string | undefined;
  runAsUser?: string | undefined;
  /** 工作流里的「现在」（ISO）：算等到几点、避到几点。 */
  now?: string | undefined;
  /**
   * 看守活动问回来的 Jev 答案（规则认不出的会话失败才有，ports.ts 的 SessionEnd.failure.jev）。分流只在规则认不出时看它；
   * 只记不拦、把握不够、没判出来的照兜底梯走。
   */
  jev?: JevReply<TriageChoice> | undefined;
}

export interface FailureInput {
  failure: FailureInfo;
  /** 缺的计数 = 从没用过。 */
  counters?: Partial<LadderCounters> | undefined;
  limits: Pick<Limits, 'retryAttempts' | 'routeSwaps' | 'modelSwaps'>;
  /** 这一步跟路由绑定吗（AI 会话是，建工作树、开 PR 不是）。不绑定的跳过换路由、换模型两级。 */
  routeBound: boolean;
  context?: FailureContext | undefined;
}

export interface NextAction {
  action: ActionClass;
  /** 分流的第一选择；和 action 不同说明那一级的次数用完、往下走了。 */
  classifiedAs: ActionClass | 'unknown';
  delaySeconds: number;
  reason: string;
  /** 换路由、换模型时这个任务避开多大范围。 */
  avoid?: AvoidScope;
  // 下面几项是接上失败分流之后才有的；在途任务历史里的老判断没有，读的地方按缺省处理。
  /** 给哪个计数加一；挂起时是 null（挂起后清零重来）。缺 = 按动作猜（retry→retries……）。 */
  counter?: keyof LadderCounters | null;
  /** retry 的延迟是在等上游恢复：quota = 等账号池额度清零（不算墙钟预算），upstream = 等上游给的别的时间。 */
  wait?: 'quota' | 'upstream';
  /** 这一步之后（等完、或挂起后人点「继续」）续同一个会话、同一条路由。缺 = 只有 retry 续。 */
  resumeSame?: boolean;
  /** 不挂起也要报警（例如封号换池）。 */
  alert?: boolean;
  /** 命中的规则编号（FB = 认不出走兜底梯，EF = 分流自己出错）。 */
  rule?: string;
  /** 所有任务一起避开的（写进共享的账号池 / 路由状态），挂起时也可能有。 */
  shared?: { scope: AvoidScope; until?: string };
  /** 只有人能修、修法确定时：写给人看的一句。 */
  humanFix?: string;
}

/** 分流本身：可以换（演练「分流出错」用）；不给就是 failure/classify.ts 的 classifyFailure。 */
export type FailureTriage = (evidence: FailureEvidence, policy: Partial<FailurePolicy>) => FailureVerdict;

/** 重试退避：15 秒起翻倍，封顶 10 分钟。确定性，不带随机数（和分流的退避同一条算法）。 */
export function retryDelaySeconds(retriesSoFar: number): number {
  return Math.min(15 * 2 ** Math.max(0, retriesSoFar), 600);
}

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function evidenceOf(input: FailureInput): FailureEvidence {
  const c = input.context ?? {};
  const r = c.route;
  const counters = input.counters ?? {};
  const set = <K extends keyof FailureEvidence>(key: K, value: FailureEvidence[K] | null | undefined) =>
    value === undefined || value === null ? {} : { [key]: value };
  return {
    source: input.failure.source,
    routeBound: input.routeBound,
    code: input.failure.code,
    retryable: input.failure.retryable,
    message: input.failure.message,
    ...set('stage', c.stage),
    ...(r
      ? {
          routeId: r.routeId,
          poolId: r.poolId,
          modelId: r.modelId,
          hostId: r.hostId,
          ...set('channelId', r.channelId),
          ...set('poolRole', r.poolRole),
        }
      : {}),
    ...set('resetsAt', c.resetsAt),
    ...set('retryAfterSeconds', c.retryAfterSeconds),
    ...set('httpStatus', c.httpStatus),
    ...(c.exitCode === undefined ? {} : { exitCode: c.exitCode }),
    ...(c.signal === undefined ? {} : { signal: c.signal }),
    ...set('transcriptTail', c.transcriptTail),
    ...set('previousMessage', c.previousMessage),
    ...set('machine', c.machine),
    ...set('runAsUser', c.runAsUser),
    ...set('now', c.now),
    ...set('jev', c.jev),
    attempts: {
      retries: count(counters.retries),
      reworks: count(counters.reworks),
      routeSwaps: count(counters.routeSwaps),
      modelSwaps: count(counters.modelSwaps),
    },
  };
}

const LABEL: Record<ActionClass, string> = {
  retry: '重试',
  swapRoute: '换路由',
  swapModel: '换模型',
  park: '挂起并报警',
};

/** 分流给的结论形状对不对：动作认得、延迟是非负数、有原因。不对就当分流出错。 */
function usable(v: unknown): v is FailureVerdict {
  if (!v || typeof v !== 'object') return false;
  const verdict = v as Partial<FailureVerdict>;
  return (
    LADDER.includes(verdict.action as ActionClass) &&
    typeof verdict.delaySeconds === 'number' &&
    Number.isFinite(verdict.delaySeconds) &&
    verdict.delaySeconds >= 0 &&
    typeof verdict.reason === 'string' &&
    verdict.reason.length > 0
  );
}

export function nextAction(input: FailureInput, triage: FailureTriage = classifyFailure): NextAction {
  const policy: Partial<FailurePolicy> = {
    retryAttempts: input.limits.retryAttempts,
    routeSwaps: input.limits.routeSwaps,
    modelSwaps: input.limits.modelSwaps,
  };
  let verdict: unknown;
  let broken: string | null = null;
  try {
    verdict = triage(evidenceOf(input), policy);
    if (!usable(verdict)) broken = '分流答非所问';
  } catch (error) {
    broken = `分流出错：${error instanceof Error ? error.message : String(error)}`;
  }
  if (broken !== null || !usable(verdict)) return fallback(input, broken ?? '分流答非所问');
  const v = verdict;
  const shared = v.shared
    ? { scope: v.shared.scope, ...(v.shared.until ? { until: v.shared.until } : {}) }
    : null;
  return {
    action: v.action,
    classifiedAs: v.classifiedAs,
    delaySeconds: v.delaySeconds,
    reason: v.reason,
    ...(v.avoid ? { avoid: v.avoid.scope } : {}),
    counter: v.counter,
    ...(v.wait ? { wait: v.wait } : {}),
    resumeSame: v.resumeSame,
    alert: v.alert,
    rule: v.rule,
    ...(shared ? { shared } : {}),
    ...(v.humanFix ? { humanFix: v.humanFix } : {}),
  };
}

/** 分流出错时的兜底：只看次数的梯子。端口明说重试没用的跳过重试；不绑路由的只有重试和挂起。 */
function fallback(input: FailureInput, why: string): NextAction {
  const used = {
    retries: count(input.counters?.retries),
    routeSwaps: count(input.counters?.routeSwaps),
    modelSwaps: count(input.counters?.modelSwaps),
  };
  const what = `「${input.failure.code}」（${input.failure.source}）`;
  const base = { classifiedAs: 'unknown' as const, rule: 'EF', alert: true };
  const text = (action: ActionClass, extra = '') => `${what}：${why}，走兜底梯：${LABEL[action]}${extra}`;
  if (input.failure.retryable !== false && used.retries < input.limits.retryAttempts) {
    const delaySeconds = retryDelaySeconds(used.retries);
    return {
      ...base,
      action: 'retry',
      delaySeconds,
      reason: text('retry', `（第 ${used.retries + 1} 次，${delaySeconds} 秒后）`),
      counter: 'retries',
      resumeSame: true,
    };
  }
  if (input.routeBound && used.routeSwaps < input.limits.routeSwaps) {
    return {
      ...base,
      action: 'swapRoute',
      delaySeconds: 0,
      reason: text('swapRoute'),
      avoid: 'route',
      counter: 'routeSwaps',
      resumeSame: false,
    };
  }
  if (input.routeBound && used.modelSwaps < input.limits.modelSwaps) {
    return {
      ...base,
      action: 'swapModel',
      delaySeconds: 0,
      reason: text('swapModel'),
      avoid: 'model',
      counter: 'modelSwaps',
      resumeSame: false,
    };
  }
  return { ...base, action: 'park', delaySeconds: 0, reason: text('park'), counter: null, resumeSame: false };
}
