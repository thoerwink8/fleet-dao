// 失败分流的说法：动作只有四种，类别数 = 动作数（设计第十二节；依据见 docs/reference/errors.md 第 4 节）。
// 本目录全是纯函数：不取时钟、不碰网络和文件，时间由调用方传进来。

import type { JevQuestion, JevReply } from './jev.ts';
import { type Bound, count, fraction, nonNegative, resolvePolicy } from './policy.ts';

/** 下一步动作。四个名字和引擎兜底梯的四级一样，可以直接接。 */
export type FailureAction = 'retry' | 'swapRoute' | 'swapModel' | 'park';

/** 这个任务在这一步上已经用掉的处置次数。缺的 = 从没用过。 */
export interface AttemptCounters {
  /** 原路重试（含等上游给的时间）。 */
  retries: number;
  /** 返工：测试红、合并冲突、没交付——和基础设施的重试分开记（windsurf-dao#1755：CI 修复轮吃光审查轮次）。 */
  reworks: number;
  routeSwaps: number;
  modelSwaps: number;
}

export type TriageChoice = 'retry' | 'swapRoute' | 'swapModel' | 'unclear';

/** 一次失败的证据。能给的都给；分类用全文，展示时才截。 */
export interface FailureEvidence {
  /** 出在哪一步：`session:<阶段>`（AI 会话）、`pushBranch`、`createWorktree`…… */
  source?: string;
  /** 阶段类型（@fleet-dao/shared 的 StageKind）；不给就从 source 的 `session:<阶段>` 取。 */
  stage?: string;
  channelId?: string;
  poolId?: string;
  routeId?: string;
  modelId?: string;
  /** 执行方式（@fleet-dao/shared 的 HostId）。 */
  hostId?: string;
  /**
   * 主池 / 备池（选路的 PoolRole：拼车号是备池）。额度用满时两者走法不同（design 第一节、第九节）：
   * 主池挂起到清零、续同一个会话；备池窗口小，先换到别的池接着干（fork 续），换不了再等清零。不给按主池。
   */
  poolRole?: 'primary' | 'backup';
  /** 出事的机器（给人看的名字，例如「法国」）和会话用户：只有人能修的（重新登录）要写清去哪台机器、以谁的身份修。 */
  machine?: string;
  runAsUser?: string;
  /** 这一步跟路由绑不绑定（AI 会话绑定；建树、推分支、开 PR 不绑定）。不给：有 routeId 或 source 是 `session:` 就算绑定。 */
  routeBound?: boolean;
  /** 结构化错误码：插头判定的原因（quota_exhausted、model_mismatch……）、端口的 PortError.code、Temporal 的 TIMEOUT_*、mirasim 的结束码。 */
  code?: string;
  /** 端口说能不能重试；null / 不给 = 没说。 */
  retryable?: boolean | null;
  exitCode?: number | null;
  signal?: string | null;
  httpStatus?: number;
  /** 上游错误原文，全文（调用方先脱敏）。 */
  message?: string;
  /** 最后几段过程记录（老的在前）。只有写明「读过程记录」的规则才看它：助手自己写的正文里常有 429、503 这类字样。 */
  transcriptTail?: readonly string[];
  /** 上游给的等待：Retry-After 的秒数。 */
  retryAfterSeconds?: number;
  /** 上游给的恢复时刻（额度窗清零），ISO。 */
  resetsAt?: string;
  /** 现在，ISO。算「等到几点」「避开到几点」要它；不给就只用默认时长、不写到期时刻。 */
  now?: string;
  attempts?: Partial<AttemptCounters>;
  /** 同一路由最近的真实流量（不含探针）：直接传 routeBreaker 结果里的 window。失败率 null = 窗口里没有真实流量，不算病。 */
  routeHealth?: { samples: number; failureRate: number | null };
  /** 这一步上一次失败的原文。一字不差再犯 = 重试不会变，不在原路再试（windsurf-dao#1237）。 */
  previousMessage?: string;
  /** 问过 Jev 才有（见 triageFailure）；没问是 undefined。 */
  jev?: JevReply<TriageChoice>;
}

/** 换路由、换模型时要避开的范围。 */
export interface Avoid {
  /** route = 这一条路由；pool = 整个账号池（额度、封号、登录失效）；model = 这个模型。 */
  scope: 'route' | 'pool' | 'model';
  /** 所有任务一起避开（写进共享的路由 / 账号池状态），不只是这个任务。 */
  shared: boolean;
  /** 避到几点；没有 = 等人或帅位处理完再放开。 */
  until?: string;
}

export interface FailureVerdict {
  action: FailureAction;
  /** 重试前等多久；别的动作是 0。 */
  delaySeconds: number;
  /** 一句白话。 */
  reason: string;
  /** 命中的规则编号；FB = 认不出走兜底梯，JV = 认不出、按 Jev 的判断走。 */
  rule: string;
  /** 规则的白话名。 */
  title: string;
  /** 怎么认出来的：结构化的码、已知原文、只剩状态码或退出码、Jev、兜底。 */
  via: 'signal' | 'text' | 'generic' | 'jev' | 'fallback';
  /** 规则的第一选择；和 action 不同说明那一级的次数用完、往下走了。 */
  classifiedAs: FailureAction | 'unknown';
  /** 要不要报警（挂起一定报警）。 */
  alert: boolean;
  /** 调用方该给哪个计数加一；挂起时是 null（引擎挂起后清零重来）。 */
  counter: keyof AttemptCounters | null;
  /**
   * action 是 retry、延迟是在等上游恢复时给：quota = 等账号池额度清零（等人、排队一样不算墙钟预算），
   * upstream = 等上游给的别的时间（限流、繁忙、GitHub 暂时不让访问）。
   */
  wait?: 'quota' | 'upstream';
  /**
   * 所有任务一起避开的（写进共享的路由 / 账号池状态），和这个任务下一步做什么无关：挂起的也要给——
   * 设备被撤销时这个任务挂起，同一个池的别的任务也不该再派过去。
   */
  shared?: Avoid;
  /** 只有人能修、修法确定时给：写给人看的一句（填好了机器、会话用户）。 */
  humanFix?: string;
  /** 这一步之后（等完、或挂起后人点「继续」）续同一个会话、同一条路由；false = 下一次照常选路。 */
  resumeSame: boolean;
  avoid?: Avoid;
  /** 喂熔断：fail = 算这条路由的失败；neutral = 不算（我们自己停的、断流、账号池的事、任务自己的问题）。 */
  routeOutcome: 'fail' | 'neutral';
  /** 既没有原文，也没有认得出的码：「缺原因」单独计数，别和「认不出」混在一起（旧系统 82 条这样的没人数）。 */
  missingReason?: true;
  /** 认不出、又还没问过 Jev 时给：调用方可以拿去问 Jev，再带着回答重判一次。 */
  jevQuestion?: JevQuestion<TriageChoice>;
}

/** 上限与时长。前三个与引擎 Limits 同名，可以直接把引擎的上限传进来。 */
export interface FailurePolicy {
  /** 原路重试几次（引擎 limits.retryAttempts）。 */
  retryAttempts: number;
  routeSwaps: number;
  modelSwaps: number;
  /** 返工几轮（设计第五节：审查意见最多 2 轮；返工另记一本账）。 */
  reworkRounds: number;
  /** 退避：从这里起翻倍，封顶 retryMaxSeconds（与引擎兜底梯同一条算法）。 */
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  /** 上游给的等待不超过这个就原地等，超了先换路由。 */
  inPlaceWaitMaxSeconds: number;
  /** 最多等多久：额度要等更久才恢复，就挂起报警，不闷头睡几天。 */
  waitMaxSeconds: number;
  /** 路由繁忙时所有任务一起避开多久（盲设计题 Grok 臂的起步值 10 分钟）。 */
  routeCooldownSeconds: number;
  /** 额度用满又读不出清零时刻时，账号池先避开多久（旧系统账号池暂停的第一档 15 分钟）。 */
  poolCooldownSeconds: number;
  /** 路由病了的判据：真实流量至少几条、失败率多少（windsurf-dao#1342：好路由 0–30%，坏路由 52–75%）。 */
  sickRouteMinSamples: number;
  sickRouteFailureRate: number;
  /** Jev 把握度低于它 = 没判出来（旧系统 Jev 的放行线）。 */
  jevConfidenceFloor: number;
}

export const DEFAULT_FAILURE_POLICY: Readonly<FailurePolicy> = Object.freeze({
  retryAttempts: 2,
  routeSwaps: 2,
  modelSwaps: 1,
  reworkRounds: 2,
  retryBaseSeconds: 15,
  retryMaxSeconds: 600,
  inPlaceWaitMaxSeconds: 300,
  waitMaxSeconds: 6 * 3600,
  routeCooldownSeconds: 600,
  poolCooldownSeconds: 900,
  sickRouteMinSamples: 8,
  sickRouteFailureRate: 0.6,
  jevConfidenceFloor: 0.7,
});

/** 缺的取默认值，给了但不对的报错。梯子上的次数可以是 0（跳过那一级）。 */
export function resolveFailurePolicy(partial?: Partial<FailurePolicy>): FailurePolicy {
  return resolvePolicy('失败分流策略', DEFAULT_FAILURE_POLICY, FAILURE_POLICY_BOUNDS, partial);
}

const FAILURE_POLICY_BOUNDS: { readonly [K in keyof FailurePolicy]: Bound } = {
  retryAttempts: count(0),
  routeSwaps: count(0),
  modelSwaps: count(0),
  reworkRounds: count(0),
  retryBaseSeconds: nonNegative,
  retryMaxSeconds: nonNegative,
  inPlaceWaitMaxSeconds: nonNegative,
  waitMaxSeconds: nonNegative,
  routeCooldownSeconds: nonNegative,
  poolCooldownSeconds: nonNegative,
  sickRouteMinSamples: count(1),
  sickRouteFailureRate: { min: 0, minExclusive: true, max: 1 },
  jevConfidenceFloor: fraction,
};
