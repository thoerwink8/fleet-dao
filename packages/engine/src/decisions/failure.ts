// 失败分流：按「下一步该做什么」分类，类别数 = 动作数（设计十二）。
// 分类表可插拔（createDecide({ classify })）；这里只带一张认结构化错误码的底表，认不出的走兜底梯，不默认停下等人。

import type { Limits } from '../limits.ts';

export type ActionClass = 'retry' | 'swapRoute' | 'swapModel' | 'park';

/** 兜底梯：有界重试 → 换路由 → 换模型 → 挂起并报警。 */
export const LADDER: readonly ActionClass[] = ['retry', 'swapRoute', 'swapModel', 'park'];

export interface FailureInfo {
  /** 出在哪一步，例如 `session:execute`、`createWorktree`。 */
  source: string;
  /** 结构化错误码：端口抛的 PortError.code、Temporal 超时 `TIMEOUT_HEARTBEAT`…… */
  code: string;
  message: string;
  /** 端口说能不能重试；null = 没说。 */
  retryable: boolean | null;
}

/**
 * 换路时避开多大范围：route 只避这条路由；pool 避开整个账号池（封号、额度用满——同一个池的别的路由照样撞）；
 * model 避开这个模型。
 */
export type AvoidScope = 'route' | 'pool' | 'model';

/** 分类器的回答：下一步该做什么（可带上换路时避开的范围）；答不上来回 unknown。 */
export type Classification = ActionClass | 'unknown' | { action: ActionClass; avoid?: AvoidScope };

/** 分类器：只回答「下一步该做什么」。 */
export type Classifier = (failure: FailureInfo) => Classification;

/** 错误码不分大小写（插头的判定原因是小写蛇形，例如 quota_exhausted）。 */
const STRUCTURAL: Readonly<Record<string, Classification>> = {
  ROUTE_BUSY: 'swapRoute',
  RATE_LIMITED: 'swapRoute',
  CAPACITY: 'swapRoute',
  QUOTA_EXHAUSTED: { action: 'swapRoute', avoid: 'pool' },
  ACCOUNT_BANNED: { action: 'swapRoute', avoid: 'pool' },
  ROUTE_OFFLINE: 'swapRoute',
  CLI_TOO_OLD: 'swapRoute',
  MODEL_UNAVAILABLE: 'swapModel',
  MODEL_RETIRED: 'swapModel',
  MODEL_MISMATCH: 'swapModel',
  UNSUPPORTED_CAPABILITY: 'swapModel',
  NEEDS_HUMAN: 'park',
  CONFIG_MISSING: 'park',
  AUTH_REQUIRED: 'park',
  PERMISSION_DENIED: 'park',
  WORKFLOWS_PERMISSION: 'park',
  TRANSIENT: 'retry',
  SESSION_STALLED: 'retry',
  SESSION_LOST: 'retry',
  SESSION_MISMATCH: 'retry',
  // 这一次会话被外面停了（对账、人手停的）：换个新编号重起就是。
  SESSION_STOPPED: 'retry',
  STARTUP_TIMEOUT: 'retry',
  WALL_CLOCK_TIMEOUT: 'retry',
  SPAWN_FAILED: 'retry',
  NO_RESULT: 'retry',
  NOT_DELIVERED: 'retry',
  DELIVERY_UNKNOWN: 'retry',
  TIMEOUT_HEARTBEAT: 'retry',
  TIMEOUT_START_TO_CLOSE: 'retry',
};

/** 底表：只认结构化错误码。完整分类表（已知文本、Jev）由错误分流那块接进来。 */
export const classifyStructural: Classifier = (failure) =>
  STRUCTURAL[failure.code.toUpperCase()] ?? 'unknown';

export interface LadderCounters {
  retries: number;
  routeSwaps: number;
  modelSwaps: number;
}

export interface FailureInput {
  failure: FailureInfo;
  /** 缺的计数 = 从没用过。 */
  counters?: Partial<LadderCounters> | undefined;
  limits: Pick<Limits, 'retryAttempts' | 'routeSwaps' | 'modelSwaps'>;
  /** 这一步跟路由绑定吗（AI 会话是，建工作树、开 PR 不是）。不绑定的跳过换路由、换模型两级。 */
  routeBound: boolean;
}

export interface NextAction {
  action: ActionClass;
  /** 分类器的原判；和 action 不同说明那一级额度用完、往下走了。 */
  classifiedAs: ActionClass | 'unknown';
  delaySeconds: number;
  reason: string;
  /** 换路由、换模型时避开多大范围（换路由默认只避这条路由，分类器说是账号池的事就避开整个池）。 */
  avoid?: AvoidScope;
}

const LABEL: Record<ActionClass, string> = {
  retry: '重试',
  swapRoute: '换路由',
  swapModel: '换模型',
  park: '挂起并报警',
};

/** 重试退避：15 秒起翻倍，封顶 10 分钟。确定性，不带随机数。 */
export function retryDelaySeconds(retriesSoFar: number): number {
  return Math.min(15 * 2 ** Math.max(0, retriesSoFar), 600);
}

export function nextAction(input: FailureInput, classify: Classifier = classifyStructural): NextAction {
  const used = {
    retries: input.counters?.retries ?? 0,
    routeSwaps: input.counters?.routeSwaps ?? 0,
    modelSwaps: input.counters?.modelSwaps ?? 0,
  };
  let answer: Classification;
  try {
    answer = classify(input.failure);
  } catch {
    answer = 'unknown';
  }
  let classifiedAs: ActionClass | 'unknown' = typeof answer === 'object' && answer ? answer.action : answer;
  if (classifiedAs !== 'unknown' && !LADDER.includes(classifiedAs)) classifiedAs = 'unknown';
  const scope = typeof answer === 'object' && answer ? answer.avoid : undefined;
  // 分类器说「整个账号池的事」只在它原判的那一级换路由时算数；从别的级爬上来的换路由只避这条路由。
  const routeAvoid: AvoidScope = classifiedAs === 'swapRoute' && scope === 'pool' ? 'pool' : 'route';
  // 认不出的从最低一级爬；端口明说「重试没用」的跳过重试。
  let rung =
    classifiedAs === 'unknown' ? (input.failure.retryable === false ? 1 : 0) : LADDER.indexOf(classifiedAs);
  const what = `「${input.failure.code}」（${input.failure.source}）`;
  for (; rung < LADDER.length; rung += 1) {
    const action = LADDER[rung] as ActionClass;
    const via =
      classifiedAs === action
        ? ''
        : `（原判${classifiedAs === 'unknown' ? '认不出' : LABEL[classifiedAs]}，额度用完往下走）`;
    if (action === 'retry' && used.retries < input.limits.retryAttempts) {
      const delaySeconds = retryDelaySeconds(used.retries);
      return {
        action,
        classifiedAs,
        delaySeconds,
        reason: `${what}：第 ${used.retries + 1} 次重试，${delaySeconds} 秒后${via}`,
      };
    }
    if (action === 'swapRoute' && input.routeBound && used.routeSwaps < input.limits.routeSwaps) {
      const target = routeAvoid === 'pool' ? '换一个账号池（这个池的路由都不再用）' : '换一条路由';
      return { action, classifiedAs, delaySeconds: 0, reason: `${what}：${target}${via}`, avoid: routeAvoid };
    }
    if (action === 'swapModel' && input.routeBound && used.modelSwaps < input.limits.modelSwaps) {
      return { action, classifiedAs, delaySeconds: 0, reason: `${what}：换一个模型${via}`, avoid: 'model' };
    }
    if (action === 'park') {
      return { action, classifiedAs, delaySeconds: 0, reason: `${what}：挂起并报警${via}` };
    }
  }
  return { action: 'park', classifiedAs, delaySeconds: 0, reason: `${what}：挂起并报警` };
}
