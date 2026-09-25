// classifyFailure：一次失败 → 下一步动作。纯函数：证据进、结论出，不取时钟、不碰网络。
// 认的顺序见 rules.ts。认不出的不停下等人：先按能撤回的动作走兜底梯（原路重试 → 换路由 → 换模型 → 挂起并报警），
// 同时出一道 Jev 题；调用方问完带着回答再判一次（ask.ts 的 triageFailure）。Jev 只能选能撤回的三种动作，
// 而且只在规则认不出时才问——规则认出来的（尤其是账号池的事）它碰不到。

import { type JevQuestion, readJevReply } from './jev.ts';
import { type FailureRule, matchRule, type Rung } from './rules.ts';
import { duration, excerpt, parseTime, type Scan, scanEvidence, waitFromText } from './scan.ts';
import {
  type AttemptCounters,
  type Avoid,
  type FailureAction,
  type FailureEvidence,
  type FailurePolicy,
  type FailureVerdict,
  resolveFailurePolicy,
  type TriageChoice,
} from './types.ts';

export const FALLBACK_LADDER: readonly Rung[] = ['retry', 'swapRoute', 'swapModel', 'park'];

const JEV_LADDERS: Readonly<Record<Exclude<TriageChoice, 'unclear'>, readonly Rung[]>> = {
  retry: FALLBACK_LADDER,
  swapRoute: ['swapRoute', 'swapModel', 'park'],
  swapModel: ['swapModel', 'park'],
};

export const TRIAGE_OPTIONS: readonly TriageChoice[] = ['retry', 'swapRoute', 'swapModel', 'unclear'];

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
  ladder: readonly Rung[];
  rule: string;
  title: string;
  via: FailureVerdict['via'];
  hit: string;
  budget: 'infra' | 'rework';
  maxRetries: number;
  retryBaseSeconds?: number | undefined;
  defaultWaitSeconds?: number | undefined;
  avoid?: FailureRule['avoid'] | undefined;
  alert: boolean;
  routeOutcome: 'fail' | 'neutral';
  /** 认不出的路子（兜底或 Jev）：端口说「重试没用」时跳过原路重试。 */
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
  action: FailureAction;
  delaySeconds: number;
  counter: keyof AttemptCounters | null;
  wait: boolean;
  avoid?: Avoid;
}

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
  let jevQuestion: JevQuestion<TriageChoice> | undefined;
  let missingReason = false;
  const hit = matchRule(scan);
  if (hit) {
    plan = {
      ladder: (evidence.poolRole === 'backup' ? hit.rule.backupLadder : undefined) ?? hit.rule.ladder,
      rule: hit.rule.id,
      title: hit.rule.title,
      via: hit.via,
      hit: excerpt(hit.hit),
      budget: hit.rule.budget ?? 'infra',
      maxRetries: hit.rule.maxRetries ?? Number.POSITIVE_INFINITY,
      retryBaseSeconds: hit.rule.retryBaseSeconds,
      defaultWaitSeconds: hit.rule.defaultWaitSeconds,
      avoid: hit.rule.avoid,
      alert: hit.rule.alert === true,
      routeOutcome: hit.rule.routeOutcome,
      unknown: false,
      hint: hit.rule.hint,
      humanFix: hit.rule.humanFix,
      resumeAfterPark: hit.rule.resumeAfterPark,
      notes: [],
    };
  } else {
    missingReason = isBlank(scan);
    const unknownPlan = {
      budget: 'infra' as const,
      maxRetries: Number.POSITIVE_INFINITY,
      alert: false,
      // 缺原因的不算进路由的失败（errors.md 第 8 节第 11 条）：连为什么都不知道，不能拿它判一条路由坏了。
      routeOutcome: ctx.routeBound && !missingReason ? ('fail' as const) : ('neutral' as const),
      unknown: true,
      hit: missingReason ? '没有任何原文' : describe(evidence, scan),
    };
    const read = readJevReply(evidence.jev, {
      options: TRIAGE_OPTIONS,
      confidenceFloor: policy.jevConfidenceFloor,
    });
    if ('use' in read && read.use !== 'unclear') {
      plan = {
        ...unknownPlan,
        ladder: JEV_LADDERS[read.use],
        rule: 'JV',
        title: 'Jev 判的',
        via: 'jev',
        notes: [],
      };
    } else {
      plan = {
        ...unknownPlan,
        ladder: FALLBACK_LADDER,
        rule: 'FB',
        title: missingReason ? '缺原因，走兜底梯' : '认不出，走兜底梯',
        via: 'fallback',
        notes: [],
      };
      if (evidence.jev !== undefined) {
        plan.notes.push('skip' in read ? read.skip : 'Jev 也看不出来');
      } else if (!missingReason) {
        jevQuestion = triageQuestion(evidence, scan, policy.jevConfidenceFloor);
      }
    }
  }

  // 分流自己不能因为证据读坏了就失败（那样失败就没人处置了），但读坏的要写明，不当成没给。
  plan.notes.push(...unreadableFields(evidence));
  const step = walk(plan, ctx);
  const alert = plan.alert || step.action === 'park';
  const how = plan.hint && step.action === 'retry' && !step.wait ? `，${plan.hint}` : '';
  const humanFix = plan.humanFix ? fillFix(plan.humanFix, evidence) : undefined;
  const reason = `${plan.title}（${plan.hit}）：${actionText(step, plan, ctx)}${how}${
    alert && step.action !== 'park' ? '，并报警' : ''
  }${humanFix ? `；要人：${humanFix}` : ''}${plan.notes.length > 0 ? `（${plan.notes.join('；')}）` : ''}`;
  const shared = sharedAvoid(plan, ctx);
  return {
    action: step.action,
    delaySeconds: step.delaySeconds,
    reason,
    rule: plan.rule,
    title: plan.title,
    via: plan.via,
    classifiedAs: plan.unknown && plan.rule === 'FB' ? 'unknown' : firstChoice(plan, ctx),
    alert,
    counter: step.counter,
    ...(step.wait && step.action === 'retry'
      ? { wait: plan.avoid?.scope === 'pool' ? ('quota' as const) : ('upstream' as const) }
      : {}),
    ...(step.avoid ? { avoid: step.avoid } : {}),
    ...(shared ? { shared } : {}),
    ...(humanFix ? { humanFix } : {}),
    // 原路再试（含等上游）续同一个会话；挂起的只有规则写明「修的是机器或账号池」才续。
    resumeSame: step.action === 'retry' || (step.action === 'park' && plan.resumeAfterPark === true),
    routeOutcome: plan.routeOutcome,
    ...(missingReason ? { missingReason: true as const } : {}),
    ...(jevQuestion ? { jevQuestion } : {}),
  };
}

/** 规则写明所有任务一起避开的，不管这一步做什么都给出（挂起时也要让别的任务别再派过去）。 */
function sharedAvoid(plan: Plan, ctx: Ctx): Avoid | undefined {
  const spec = plan.avoid;
  if (!spec?.shared) return undefined;
  const out: Avoid = { scope: spec.scope, shared: true };
  if (spec.until !== 'none' && ctx.nowMs !== undefined) {
    const cooldown = spec.scope === 'pool' ? ctx.policy.poolCooldownSeconds : ctx.policy.routeCooldownSeconds;
    const seconds = spec.until === 'upstream' && ctx.upstreamWait !== undefined ? ctx.upstreamWait : cooldown;
    out.until = new Date(ctx.nowMs + seconds * 1000).toISOString();
  }
  return out;
}

function fillFix(template: string, e: FailureEvidence): string {
  const missing = '（没报）';
  return template
    .replaceAll('{machine}', e.machine?.trim() ? `「${e.machine.trim()}」` : `机器${missing}`)
    .replaceAll('{user}', e.runAsUser?.trim() ? `会话用户 ${e.runAsUser.trim()} ` : `会话用户${missing}`)
    .replaceAll('{pool}', e.poolId?.trim() ? `账号池 ${e.poolId.trim()}` : `账号池${missing}`);
}

/** 顺着梯子往下走，第一级还有次数的就是它；走完就挂起。走过哪些级、为什么跳过，记进 plan.notes。 */
function walk(plan: Plan, ctx: Ctx): Step {
  const { policy, used } = ctx;
  const retryCap = Math.min(plan.maxRetries, policy.retryAttempts);
  for (const rung of plan.ladder) {
    if (rung === 'retry') {
      const counter = plan.budget === 'rework' ? 'reworks' : 'retries';
      const cap = plan.budget === 'rework' ? policy.reworkRounds : retryCap;
      const skip = retrySkip(plan, ctx, used[counter]);
      if (skip) {
        plan.notes.push(skip);
        continue;
      }
      if (used[counter] >= cap) {
        plan.notes.push(counter === 'reworks' ? `已返工 ${used.reworks} 轮` : `已重试 ${used.retries} 次`);
        continue;
      }
      const base = plan.retryBaseSeconds ?? policy.retryBaseSeconds;
      return {
        action: 'retry',
        delaySeconds: Math.min(base * 2 ** used[counter], policy.retryMaxSeconds),
        counter,
        wait: false,
      };
    }
    if (rung === 'waitShort' || rung === 'wait') {
      const wait = ctx.upstreamWait;
      if (rung === 'waitShort' && (wait === undefined || wait > policy.inPlaceWaitMaxSeconds)) {
        if (wait !== undefined) plan.notes.push(`上游要等 ${duration(wait)}，不原地等`);
        continue;
      }
      if (used.retries >= retryCap) {
        plan.notes.push(`已等过 ${used.retries} 次`);
        continue;
      }
      if (wait !== undefined && wait > policy.waitMaxSeconds) {
        plan.notes.push(`上游要 ${duration(wait)}后才恢复，太久了`);
        continue;
      }
      const delaySeconds =
        wait ??
        Math.min(
          (plan.defaultWaitSeconds ?? policy.retryBaseSeconds) * 2 ** used.retries,
          policy.waitMaxSeconds,
        );
      return { action: 'retry', delaySeconds, counter: 'retries', wait: true };
    }
    if (rung === 'swapRoute' || rung === 'swapModel') {
      if (!ctx.routeBound) continue;
      const counter = rung === 'swapRoute' ? 'routeSwaps' : 'modelSwaps';
      const cap = rung === 'swapRoute' ? policy.routeSwaps : policy.modelSwaps;
      if (used[counter] >= cap) {
        plan.notes.push(
          rung === 'swapRoute' ? `已换过 ${used.routeSwaps} 次路由` : `已换过 ${used.modelSwaps} 次模型`,
        );
        continue;
      }
      return { action: rung, delaySeconds: 0, counter, wait: false, avoid: avoidFor(plan, rung, ctx) };
    }
    return { action: 'park', delaySeconds: 0, counter: null, wait: false };
  }
  return { action: 'park', delaySeconds: 0, counter: null, wait: false };
}

/** 原路重试什么时候不值得：路由病了、原文和上一次一字不差、端口说没用（只对认不出的）。 */
function retrySkip(plan: Plan, ctx: Ctx, usedSoFar: number): string | undefined {
  const { evidence, policy } = ctx;
  const health = evidence.routeHealth;
  if (
    plan.budget === 'infra' &&
    ctx.routeBound &&
    health &&
    health.failureRate !== null &&
    health.samples >= policy.sickRouteMinSamples &&
    health.failureRate >= policy.sickRouteFailureRate
  ) {
    return `这条路由最近 ${health.samples} 次里失败 ${Math.round(health.failureRate * 100)}%，不在它身上重试`;
  }
  const message = evidence.message?.trim();
  if (usedSoFar >= 1 && message && evidence.previousMessage?.trim() === message) {
    return '和上一次的原文一字不差，原路再试不会变';
  }
  if (plan.unknown && evidence.retryable === false) return '端口说重试没用';
  return undefined;
}

function avoidFor(plan: Plan, rung: 'swapRoute' | 'swapModel', ctx: Ctx): Avoid {
  const spec = plan.avoid;
  const fits = spec !== undefined && (rung === 'swapModel') === (spec.scope === 'model');
  if (!spec || !fits) return { scope: rung === 'swapModel' ? 'model' : 'route', shared: false };
  const out: Avoid = { scope: spec.scope, shared: spec.shared };
  if (spec.until !== 'none' && ctx.nowMs !== undefined) {
    const cooldown = spec.scope === 'pool' ? ctx.policy.poolCooldownSeconds : ctx.policy.routeCooldownSeconds;
    const seconds = spec.until === 'upstream' && ctx.upstreamWait !== undefined ? ctx.upstreamWait : cooldown;
    out.until = new Date(ctx.nowMs + seconds * 1000).toISOString();
  }
  return out;
}

/** 规则的第一选择（不看次数）：等待类落成 retry；上游没给时间的 waitShort 不算。 */
function firstChoice(plan: Plan, ctx: Ctx): FailureAction {
  for (const rung of plan.ladder) {
    if (rung === 'waitShort') {
      if (ctx.upstreamWait !== undefined && ctx.upstreamWait <= ctx.policy.inPlaceWaitMaxSeconds)
        return 'retry';
      continue;
    }
    return rung === 'wait' ? 'retry' : rung;
  }
  return 'park';
}

function actionText(step: Step, plan: Plan, ctx: Ctx): string {
  const first = plan.unknown && step.action !== 'park' ? '先按能撤回的动作走，' : '';
  switch (step.action) {
    case 'retry':
      if (step.counter === 'reworks') return `${first}退回会话返工（第 ${ctx.used.reworks + 1} 轮）`;
      if (step.wait) return `${first}等 ${duration(step.delaySeconds)}再试`;
      return `${first}第 ${ctx.used.retries + 1} 次重试，${
        step.delaySeconds === 0 ? '马上' : `${duration(step.delaySeconds)}后`
      }`;
    case 'swapRoute': {
      const avoid = step.avoid;
      if (avoid?.scope === 'pool') return `${first}换一个账号池，这个池${untilText(avoid)}不派`;
      if (avoid?.shared) return `${first}换一条路由，所有任务${untilText(avoid)}避开它`;
      return `${first}换一条路由`;
    }
    case 'swapModel':
      return step.avoid?.shared
        ? `${first}换一个模型，这个模型${untilText(step.avoid)}不派`
        : `${first}换一个模型`;
    case 'park':
      return '挂起并报警';
  }
}

function untilText(avoid: Avoid): string {
  return avoid.until ? `到 ${avoid.until.slice(0, 16).replace('T', ' ')} UTC 前` : '在处理好之前';
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

/** 给 Jev 的题：喂全文，不裁剪；只让它在三种能撤回的动作里选。 */
export function triageQuestion(
  e: FailureEvidence,
  scan: Scan,
  confidenceFloor: number,
): JevQuestion<TriageChoice> {
  const stage = e.stage ?? (e.source?.startsWith('session:') ? e.source.slice('session:'.length) : undefined);
  const facts: [string, string | number | undefined][] = [
    ['出在', e.source],
    ['阶段', stage],
    ['执行方式', e.hostId],
    ['渠道', e.channelId],
    ['模型', e.modelId],
    ['错误码', e.code],
    ['HTTP 状态', scan.status],
    ['退出码', scan.exitCode],
    ['信号', scan.signal],
  ];
  const lines = facts.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}：${v}`);
  lines.push('上游错误原文：', scan.text.trim() ? scan.text : '（没有）');
  lines.push('最后几段过程记录：', scan.tail.trim() ? scan.tail : '（没有）');
  return {
    questionId: 'failure-triage',
    prompt: '一次失败，规则认不出。只看下面的材料，判断下一步怎么做最可能奏效；看不出就选 unclear，不要猜。',
    options: TRIAGE_OPTIONS,
    hints: {
      retry: '临时故障（网络抖动、上游一时出错、会话半路断了），原路再试大概率能好',
      swapRoute: '这条路暂时不行（繁忙、限流、这个账号池或执行方式出了问题），换一条能跑同一模型的路',
      swapModel: '这个模型本身不行（不存在、不支持、反复做不对），换一个模型',
      unclear: '看不出来',
    },
    sample: lines.join('\n'),
    confidenceFloor,
  };
}

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
