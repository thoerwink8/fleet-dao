// classifyFailure：一次失败 → 下一步动作。纯函数：证据进、结论出，不取时钟、不碰网络。
// 先认是哪一种打断原因（rules.ts：强码 → 已知原文 → 状态码/症状码），再按这一种的处置办（下面的 POLICY）。
// 认不出的不无限重试：按「临时的」办一两次，原文一字不差再犯、端口说没用、次数用完就停下报警。
//
// 处置表（#1072 瘦身：原来每条规则各写一套梯子——重试、换路由、换模型、挂起，还有避开多久、记哪本账——删了；509 §九「重试不判、
// 按表办」、docs/decisions/0010 第 7 条：每种带「总次数 + 最长等待」两个上限，超任一个就停下报人，同一个原文连续再犯也停）：
//
// | 打断原因（kind）           | 怎么办                                             | 总次数上限            | 最长等待          |
// |---------------------------|---------------------------------------------------|----------------------|------------------|
// | resume 我们自己停的         | 马上接着干，不记账（切号、发布排空）                   | 不设（停几次续几次）    | 0                |
// | wait 额度/限流/繁忙         | 等到上游给的时刻再来；订阅池回去选路等（切号会换池）     | 策略的重试次数         | waitMaxSeconds   |
// | retry 临时的               | 原路重试，退避翻倍                                   | 策略的重试次数         | retryMaxSeconds  |
// | rework 返工                | 退回会话去改                                        | reworkRounds          | —                |
// | stop 只有人能修             | 停下报警，写清原因（和修法）                          | —                    | —                |
// 重试、返工：原文和上一次一字不差再犯 = 重试不会变，直接停下；次数用完停下（原因里写「已重试 N 次」）。等待类上游自己给了时间，
// 不按原文重复判。

import { type FailureRule, matchRule } from './rules.ts';
import { duration, excerpt, parseTime, type Scan, scanEvidence, waitFromText } from './scan.ts';
import {
  type AttemptCounters,
  type Avoid,
  type FailureEvidence,
  type FailurePolicy,
  type FailureVerdict,
  resolveFailurePolicy,
} from './types.ts';

/** 这些码只说明「失败了」，不说明为什么。 */
const BLANK_CODES = new Set([
  'failed',
  'error',
  'unknown',
  'session_failed',
  'agent_error',
  'no_result',
  'exit_nonzero',
]);

interface Plan {
  kind: FailureRule['kind'];
  rule: string;
  title: string;
  via: FailureVerdict['via'];
  hit: string;
  maxRetries: number;
  retryBaseSeconds?: number | undefined;
  defaultWaitSeconds?: number | undefined;
  quota: boolean;
  hold: boolean;
  routeOutcome: 'fail' | 'neutral';
  /** 认不出的路子：端口说「重试没用」时跳过原路重试。 */
  unknown: boolean;
  /** 原路再试时怎么试。 */
  hint?: string | undefined;
  humanFix?: string | undefined;
  resumeAfterPark?: true | undefined;
  notes: string[];
}

interface Ctx {
  evidence: FailureEvidence;
  policy: FailurePolicy;
  nowMs: number | undefined;
  routeBound: boolean;
  used: AttemptCounters;
  /** 上游给的等待（秒）：Retry-After、清零时刻、原文里写的「约 N 分钟后重置」。 */
  upstreamWait: number | undefined;
}

type Cooldown = NonNullable<FailureVerdict['cooldown']>;

interface Step {
  action: 'retry' | 'park' | 'swapRoute';
  delaySeconds: number;
  counter: keyof AttemptCounters | null;
  wait: boolean;
  /** 额度池回去选路等：不原地睡（原因里这么写）。 */
  reroute?: true;
  /**
   * 出在账号池上：不挂起这张单。pool = 整池暂停，回去选路避开这个池；
   * route = 只凭一次 401，按临时失败换路由，不暂停整池。
   */
  authReroute?: 'pool' | 'route';
  /** 只凭 401 的第二次：原因里写明是第二次才停池。 */
  second401?: true;
  /** 原路再试前歇多久按哪一档定（决定 0093）。 */
  cooldown?: Cooldown;
}

/** 登录失效、封号、设备被撤销：停的是池，不是这张单。别的 stop（没权限、密钥没放好、余额不够）仍挂起。 */
const POOL_AUTH_REROUTE = new Set(['AU1', 'AU2', 'DV1']);

/**
 * 只凭 HTTP 401，没有「要重新登录」的整句、也没有结构化的登录码。
 * 结构化 httpStatus、原文里的 Unauthorized / 状态码 401 都算；not logged in、token expired、authentication failed 不算。
 */
function isBare401(plan: Plan, evidence: FailureEvidence): boolean {
  if (plan.rule !== 'AU2' || plan.via === 'signal') return false;
  const text = evidence.message ?? '';
  if (
    /not logged in|please run \/login|no valid login detected|重新登录|完成登录|token (?:has )?expired|invalid (?:x-)?api[ _-]?key|authentication (?:failed|required)/i.test(
      text,
    )
  ) {
    return false;
  }
  if (evidence.httpStatus === 401) return true;
  if (plan.via === 'generic' && plan.hit.startsWith('HTTP 401')) return true;
  return /^(?:unauthori[sz]ed|unauthenticated)$/i.test(plan.hit);
}

/** 绑路由的会话撞上账号池的停：回去选路。不绑路由的（推送令牌过期）仍挂起。只凭 401 要第二次才停池。 */
function poolAuthLeave(plan: Plan, ctx: Ctx): 'pool' | 'route' | undefined {
  if (!ctx.routeBound || !POOL_AUTH_REROUTE.has(plan.rule)) return undefined;
  if (isBare401(plan, ctx.evidence)) {
    return ctx.evidence.priorBare401 === true ? 'pool' : 'route';
  }
  return plan.hold ? 'pool' : undefined;
}

const PARK: Step = { action: 'park', delaySeconds: 0, counter: null, wait: false };

export function classifyFailure(
  evidence: FailureEvidence,
  policyInput?: Partial<FailurePolicy>,
): FailureVerdict {
  const policy = resolveFailurePolicy(policyInput);
  const scan = scanEvidence(evidence);
  const nowMs = parseTime(evidence.now);
  const ctx: Ctx = {
    evidence,
    policy,
    nowMs,
    routeBound: scan.session,
    used: {
      retries: count(evidence.attempts?.retries),
      reworks: count(evidence.attempts?.reworks),
      routeSwaps: count(evidence.attempts?.routeSwaps),
      modelSwaps: count(evidence.attempts?.modelSwaps),
    },
    upstreamWait: upstreamWait(evidence, scan, nowMs),
  };

  let plan: Plan;
  let missingReason = false;
  const hit = matchRule(scan);
  if (hit) {
    plan = {
      kind: hit.rule.kind,
      rule: hit.rule.id,
      title: hit.rule.title,
      via: hit.via,
      hit: excerpt(hit.hit),
      maxRetries: hit.rule.maxRetries ?? Number.POSITIVE_INFINITY,
      retryBaseSeconds: hit.rule.retryBaseSeconds,
      defaultWaitSeconds: hit.rule.defaultWaitSeconds,
      quota: hit.rule.quota === true,
      hold: hit.rule.hold === true,
      routeOutcome: hit.rule.routeOutcome,
      unknown: false,
      hint: hit.rule.hint,
      humanFix: hit.rule.humanFix,
      resumeAfterPark: hit.rule.resumeAfterPark,
      notes: [],
    };
  } else {
    missingReason = isBlank(scan);
    plan = {
      kind: 'retry',
      rule: 'FB',
      title: missingReason ? '缺原因，按临时的办' : '认不出，按临时的办',
      via: 'fallback',
      hit: missingReason ? '没有任何原文' : describe(evidence, scan),
      maxRetries: Number.POSITIVE_INFINITY,
      quota: false,
      hold: false,
      // 缺原因的不算进路由的失败（errors.md 第 8 节第 11 条）：连为什么都不知道，不能拿它判一条路由坏了。
      routeOutcome: ctx.routeBound && !missingReason ? 'fail' : 'neutral',
      unknown: true,
      notes: [],
    };
  }

  // 分流自己不能因为证据读坏了就失败（那样失败就没人处置了），但读坏的要写明，不当成没给。
  plan.notes.push(...unreadableFields(evidence));
  const step = decide(plan, ctx);
  // 只凭一次 401 不报警、也不整池暂停（decide 里把 hold 拿掉了）。停池的那一档仍报警。
  const alert = step.authReroute === 'route' ? false : plan.kind === 'stop' || step.action === 'park';
  const how = plan.hint && step.action === 'retry' && !step.wait ? `，${plan.hint}` : '';
  const humanFix = plan.humanFix ? fillFix(plan.humanFix, evidence) : undefined;
  const reason = `${plan.title}（${plan.hit}）：${actionText(step, plan, ctx)}${how}${evidenceDetail(
    evidence,
  )}${
    alert && step.action !== 'park' ? '，并报警' : ''
  }${humanFix ? `；要人：${humanFix}` : ''}${plan.notes.length > 0 ? `（${plan.notes.join('；')}）` : ''}`;
  const shared: Avoid | undefined = plan.hold ? { scope: 'pool', shared: true } : undefined;
  return {
    action: step.action,
    delaySeconds: step.delaySeconds,
    reason,
    rule: plan.rule,
    title: plan.title,
    via: plan.via,
    classifiedAs: plan.unknown
      ? 'unknown'
      : step.authReroute
        ? 'swapRoute'
        : plan.kind === 'stop'
          ? 'park'
          : 'retry',
    alert,
    counter: step.counter,
    ...(step.wait && step.action === 'retry'
      ? { wait: plan.quota ? ('quota' as const) : ('upstream' as const) }
      : {}),
    ...(shared ? { shared } : {}),
    ...(step.authReroute ? { authReroute: step.authReroute } : {}),
    ...(humanFix ? { humanFix } : {}),
    // 原路再试（含等上游）续同一个会话；停下的只有规则写明「修的是机器或账号池」才续。
    resumeSame: step.action === 'retry' || (step.action === 'park' && plan.resumeAfterPark === true),
    routeOutcome: plan.routeOutcome,
    ...(missingReason ? { missingReason: true as const } : {}),
    ...(step.cooldown && step.action === 'retry' ? { cooldown: step.cooldown } : {}),
  };
}

/** 按这一种打断原因的处置办（上面的表）：还有次数、没超最长等待就接着来，否则停下。次数用完、为什么跳过，记进 plan.notes。 */
function decide(plan: Plan, ctx: Ctx): Step {
  const { policy, used } = ctx;
  switch (plan.kind) {
    case 'stop': {
      const leave = poolAuthLeave(plan, ctx);
      if (leave === 'route') {
        // 一次 401 不暂停整池：shared 不设，路由探针也不会因此停池。
        plan.hold = false;
        return { action: 'swapRoute', delaySeconds: 0, counter: null, wait: false, authReroute: 'route' };
      }
      if (leave === 'pool') {
        return {
          action: 'swapRoute',
          delaySeconds: 0,
          counter: null,
          wait: false,
          authReroute: 'pool',
          ...(isBare401(plan, ctx.evidence) ? { second401: true as const } : {}),
        };
      }
      return PARK;
    }
    case 'resume':
      // 不记账、不设上限、不看上一次原文（切号这种：停几次续几次）
      return { action: 'retry', delaySeconds: plan.retryBaseSeconds ?? 0, counter: null, wait: false };
    case 'rework': {
      const skip = repeatSkip(plan, ctx, used.reworks);
      if (skip) return stopWith(plan, skip);
      if (used.reworks >= policy.reworkRounds) return stopWith(plan, `已返工 ${used.reworks} 轮`);
      return {
        action: 'retry',
        delaySeconds: Math.min(
          (plan.retryBaseSeconds ?? policy.retryBaseSeconds) * 2 ** used.reworks,
          policy.retryMaxSeconds,
        ),
        counter: 'reworks',
        wait: false,
      };
    }
    case 'retry': {
      const skip = repeatSkip(plan, ctx, used.retries);
      if (skip) return stopWith(plan, skip);
      if (used.retries >= retryCap(plan, policy)) return stopWith(plan, `已重试 ${used.retries} 次`);
      // 绑路由的别的临时失败（决定 0093，magpie 分档冷却的「其他」）：1 分钟起翻倍、封顶；规则自己写了起步的照规则
      const base =
        plan.retryBaseSeconds ?? (ctx.routeBound ? policy.routeRetryBaseSeconds : policy.retryBaseSeconds);
      return {
        action: 'retry',
        delaySeconds: Math.min(base * 2 ** used.retries, policy.retryMaxSeconds),
        counter: 'retries',
        wait: false,
        cooldown: { tier: 'other', by: 'backoff' },
      };
    }
    case 'wait': {
      const wait = ctx.upstreamWait;
      if (used.retries >= retryCap(plan, policy)) return stopWith(plan, `已等过 ${used.retries} 次`);
      if (wait !== undefined && wait > policy.waitMaxSeconds) {
        return stopWith(
          plan,
          `上游要 ${duration(wait)}后才恢复，超过最长等待 ${duration(policy.waitMaxSeconds)}`,
        );
      }
      // 分档（决定 0093，magpie 分档冷却）：额度用完歇到清零（读到时刻用读数，没读到按估计并写明）；限流、繁忙按上游给的
      // 时间，没给按默认起翻倍
      const cooldown: Cooldown = plan.quota
        ? { tier: 'quota', by: wait === undefined ? 'estimate' : 'resets' }
        : { tier: 'rate', by: wait === undefined ? 'backoff' : 'retry-after' };
      // 订阅池（带组织类型）不原地睡：马上回去选路，续同一个会话等这条路由（选路隔一会儿再看），切了号就照常选到切过去的池
      if (plan.quota && ctx.evidence.orgKind) {
        return { action: 'retry', delaySeconds: 0, counter: 'retries', wait: true, reroute: true, cooldown };
      }
      const delaySeconds =
        wait ??
        Math.min(
          (plan.defaultWaitSeconds ?? policy.retryBaseSeconds) * 2 ** used.retries,
          policy.waitMaxSeconds,
        );
      return { action: 'retry', delaySeconds, counter: 'retries', wait: true, cooldown };
    }
  }
}

function retryCap(plan: Plan, policy: FailurePolicy): number {
  return Math.min(plan.maxRetries, policy.retryAttempts);
}

function stopWith(plan: Plan, why: string): Step {
  plan.notes.push(why);
  return PARK;
}

/** 原路再试什么时候不值得：原文和上一次一字不差、端口说没用（只对认不出的）。 */
function repeatSkip(plan: Plan, ctx: Ctx, usedSoFar: number): string | undefined {
  const { evidence } = ctx;
  const message = evidence.message?.trim();
  // 超时发生在旧引擎、当前已是新引擎时，原文相同不代表原路再试不会变：
  // 这次重试是在修复基础设施中断，不是在盲撞同一个上游错误。
  if (plan.rule === 'EN1' && evidence.engineRestarted === true) return undefined;
  if (usedSoFar >= 1 && message && evidence.previousMessage?.trim() === message) {
    return '和上一次的原文一字不差，原路再试不会变';
  }
  if (plan.unknown && evidence.retryable === false) return '端口说重试没用';
  return undefined;
}

function evidenceDetail(evidence: FailureEvidence): string {
  const timeout = evidence.startToCloseSeconds;
  const isTimeout = evidence.code?.toLowerCase().startsWith('timeout_') === true;
  if (!isTimeout && evidence.engineRestarted !== true) return '';
  const details: string[] = [];
  if (evidence.activity) details.push(`活动 ${evidence.activity}`);
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0) {
    details.push(`startToClose ${timeoutText(timeout)}`);
  }
  if (evidence.engineRestarted === true) {
    details.push(
      `这一段期间引擎进程换过（旧启动 ${evidence.engineStartedAt ?? '没报'}，现启动 ${
        evidence.currentEngineStartedAt ?? '没报'
      }）`,
    );
  }
  return details.length > 0 ? `；${details.join('，')}` : '';
}

function timeoutText(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded % 60 === 0) return `${rounded / 60} 分钟`;
  return duration(rounded);
}

function actionText(step: Step, plan: Plan, ctx: Ctx): string {
  const first = plan.unknown && step.action !== 'park' ? '先按能撤回的动作走，' : '';
  if (step.authReroute === 'route') {
    return `${first}第一次 401，按临时失败换一条路由重试，不暂停整池`;
  }
  if (step.authReroute === 'pool') {
    return step.second401
      ? `${first}同一个池短时间里第二次 401，整池暂停，回去选路避开这个池`
      : `${first}整池暂停，回去选路避开这个池`;
  }
  if (step.action === 'park') return '挂起并报警';
  if (step.counter === null) {
    return `${first}${step.delaySeconds === 0 ? '马上' : `${duration(step.delaySeconds)}后`}接着干（不算重试）`;
  }
  if (step.counter === 'reworks') return `${first}退回会话返工（第 ${ctx.used.reworks + 1} 轮）`;
  if (step.reroute) {
    return `${first}不原地睡到清零，回去选路等：续同一个会话等这个池${
      ctx.upstreamWait === undefined ? '' : `（约 ${duration(ctx.upstreamWait)}后清零）`
    }，会话用户切了号就换到切过去的那个池接着干`;
  }
  if (step.wait) return `${first}${waitText(step)}`;
  return `${first}第 ${ctx.used.retries + 1} 次重试，${
    step.delaySeconds === 0 ? '马上' : `${duration(step.delaySeconds)}后`
  }`;
}

/** 等上游的那一句：按哪一档、依据什么歇（决定 0093）。读不到的写明是估计，不当成读数。 */
function waitText(step: Step): string {
  const d = duration(step.delaySeconds);
  switch (step.cooldown?.by) {
    case 'resets':
      return `歇到额度清零再试（按读到的清零时刻，等 ${d}）`;
    case 'estimate':
      return `清零时刻没读到，按估计歇 ${d}再试`;
    case 'retry-after':
      return `按上游给的时间歇 ${d}再试`;
    case 'backoff':
      return `上游没给时间，按默认起翻倍歇 ${d}再试`;
    default:
      return `等 ${d}再试`;
  }
}

function fillFix(template: string, e: FailureEvidence): string {
  const missing = '（没报）';
  return template
    .replaceAll('{machine}', e.machine?.trim() ? `「${e.machine.trim()}」` : `机器${missing}`)
    .replaceAll('{user}', e.runAsUser?.trim() ? `会话用户 ${e.runAsUser.trim()} ` : `会话用户${missing}`)
    .replaceAll('{pool}', e.poolId?.trim() ? `账号池 ${e.poolId.trim()}` : `账号池${missing}`);
}

function upstreamWait(e: FailureEvidence, scan: Scan, nowMs: number | undefined): number | undefined {
  if (
    typeof e.retryAfterSeconds === 'number' &&
    Number.isFinite(e.retryAfterSeconds) &&
    e.retryAfterSeconds >= 0
  ) {
    return Math.round(e.retryAfterSeconds);
  }
  const resetsAt = parseTime(e.resetsAt);
  // 已经过了的清零时刻是旧读数，不当成「马上就好」（等 0 秒原路再撞）：当没读到，往下找，再没有按估计（决定 0093）
  if (resetsAt !== undefined && nowMs !== undefined && resetsAt > nowMs)
    return Math.round((resetsAt - nowMs) / 1000);
  return waitFromText(scan.text, nowMs);
}

function unreadableFields(e: FailureEvidence): string[] {
  const out: string[] = [];
  if (e.now !== undefined && parseTime(e.now) === undefined) {
    out.push(`now 认不出（${e.now}），不写到期时刻`);
  }
  const resetsAt = parseTime(e.resetsAt);
  if (e.resetsAt !== undefined && resetsAt === undefined) {
    out.push(`resetsAt 认不出（${e.resetsAt}），按默认时长`);
  }
  const nowMs = parseTime(e.now);
  if (resetsAt !== undefined && nowMs !== undefined && resetsAt <= nowMs) {
    out.push(`resetsAt 已经过了（${e.resetsAt}），是旧读数，不算`);
  }
  const after = e.retryAfterSeconds;
  if (after !== undefined && !(typeof after === 'number' && Number.isFinite(after) && after >= 0)) {
    out.push(`retryAfterSeconds 认不出（${String(after)}），按默认时长`);
  }
  return out;
}

/** 既没有原文，也没有说得出原因的码、状态码、信号：「缺原因」。 */
function isBlank(scan: Scan): boolean {
  if (scan.text.trim() || scan.tail.trim()) return false;
  if (scan.status !== undefined || scan.signal) return false;
  if (scan.exitCode !== undefined && scan.exitCode !== 0 && scan.exitCode !== 1) return false;
  return [...scan.codes].every((c) => BLANK_CODES.has(c));
}

function describe(e: FailureEvidence, scan: Scan): string {
  const parts = [
    e.code?.trim(),
    scan.status === undefined ? undefined : `HTTP ${scan.status}`,
    scan.exitCode === undefined ? undefined : `退出码 ${scan.exitCode}`,
    scan.signal ? `信号 ${scan.signal}` : undefined,
    scan.text.trim() ? excerpt(scan.text, 40) : undefined,
  ].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' · ') : '只有过程记录';
}

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
