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

interface Step {
  action: 'retry' | 'park';
  delaySeconds: number;
  counter: keyof AttemptCounters | null;
  wait: boolean;
  /** 额度池回去选路等：不原地睡（原因里这么写）。 */
  reroute?: true;
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
  const alert = plan.kind === 'stop' || step.action === 'park';
  const how = plan.hint && step.action === 'retry' && !step.wait ? `，${plan.hint}` : '';
  const humanFix = plan.humanFix ? fillFix(plan.humanFix, evidence) : undefined;
  const reason = `${plan.title}（${plan.hit}）：${actionText(step, plan, ctx)}${how}${
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
    classifiedAs: plan.unknown ? 'unknown' : plan.kind === 'stop' ? 'park' : 'retry',
    alert,
    counter: step.counter,
    ...(step.wait && step.action === 'retry'
      ? { wait: plan.quota ? ('quota' as const) : ('upstream' as const) }
      : {}),
    ...(shared ? { shared } : {}),
    ...(humanFix ? { humanFix } : {}),
    // 原路再试（含等上游）续同一个会话；停下的只有规则写明「修的是机器或账号池」才续。
    resumeSame: step.action === 'retry' || (step.action === 'park' && plan.resumeAfterPark === true),
    routeOutcome: plan.routeOutcome,
    ...(missingReason ? { missingReason: true as const } : {}),
  };
}

/** 按这一种打断原因的处置办（上面的表）：还有次数、没超最长等待就接着来，否则停下。次数用完、为什么跳过，记进 plan.notes。 */
function decide(plan: Plan, ctx: Ctx): Step {
  const { policy, used } = ctx;
  switch (plan.kind) {
    case 'stop':
      return PARK;
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
      return {
        action: 'retry',
        delaySeconds: Math.min(
          (plan.retryBaseSeconds ?? policy.retryBaseSeconds) * 2 ** used.retries,
          policy.retryMaxSeconds,
        ),
        counter: 'retries',
        wait: false,
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
      // 订阅池（带组织类型）不原地睡：马上回去选路，续同一个会话等这条路由（选路隔一会儿再看），切了号就照常选到切过去的池
      if (plan.quota && ctx.evidence.orgKind) {
        return { action: 'retry', delaySeconds: 0, counter: 'retries', wait: true, reroute: true };
      }
      const delaySeconds =
        wait ??
        Math.min(
          (plan.defaultWaitSeconds ?? policy.retryBaseSeconds) * 2 ** used.retries,
          policy.waitMaxSeconds,
        );
      return { action: 'retry', delaySeconds, counter: 'retries', wait: true };
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
  if (usedSoFar >= 1 && message && evidence.previousMessage?.trim() === message) {
    return '和上一次的原文一字不差，原路再试不会变';
  }
  if (plan.unknown && evidence.retryable === false) return '端口说重试没用';
  return undefined;
}

function actionText(step: Step, plan: Plan, ctx: Ctx): string {
  const first = plan.unknown && step.action !== 'park' ? '先按能撤回的动作走，' : '';
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
  if (step.wait) return `${first}等 ${duration(step.delaySeconds)}再试`;
  return `${first}第 ${ctx.used.retries + 1} 次重试，${
    step.delaySeconds === 0 ? '马上' : `${duration(step.delaySeconds)}后`
  }`;
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
  if (resetsAt !== undefined && nowMs !== undefined)
    return Math.max(0, Math.round((resetsAt - nowMs) / 1000));
  return waitFromText(scan.text, nowMs);
}

function unreadableFields(e: FailureEvidence): string[] {
  const out: string[] = [];
  if (e.now !== undefined && parseTime(e.now) === undefined) {
    out.push(`now 认不出（${e.now}），不写到期时刻`);
  }
  if (e.resetsAt !== undefined && parseTime(e.resetsAt) === undefined) {
    out.push(`resetsAt 认不出（${e.resetsAt}），按默认时长`);
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
