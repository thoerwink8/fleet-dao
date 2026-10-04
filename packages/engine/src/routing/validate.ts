// 输入先整体认一遍：时刻、随机数、重复的路由、缺的事实、认不出的被挡原因。认不出就抛 RoutingInputError，
// 不把读坏的输入当成「没有被挡」「额度没问题」往下走。
import { STAGE_NEEDS } from './policy.ts';
import { CANDIDATE_BLOCKERS, type ChooseRouteInput, RoutingInputError } from './types.ts';

const WINDOW_STATES = ['ok', 'exhausted', 'stale', 'reset'];
const QUOTA_STATES = ['ok', 'exhausted', 'unknown'];
const ADMITS = ['all', 'trial', 'none'];
const ORGS = ['solo', 'carpool'];
const PROBE_STATES = ['ok', 'failed', 'not_wired', 'skipped'];

export function time(iso: unknown, what: string): number {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) throw new RoutingInputError(`选路判不了：${what}认不出（${String(iso)}）`);
  return ms;
}

function count(v: unknown, what: string): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new RoutingInputError(`选路判不了：${what}认不出（${String(v)}）`);
  }
}

export function validateInput(input: ChooseRouteInput, trialEnabled: boolean): number {
  const now = time(input.now, '现在的时刻');
  if (!Object.hasOwn(STAGE_NEEDS, input.stage)) {
    throw new RoutingInputError(`选路判不了：阶段类型认不出（${String(input.stage)}）`);
  }
  if (input.liveOrg !== undefined && !ORGS.includes(input.liveOrg)) {
    throw new RoutingInputError(`选路判不了：会话用户挂的组织认不出（${String(input.liveOrg)}）`);
  }
  if (input.liveOrgProblem !== undefined) {
    if (typeof input.liveOrgProblem !== 'string' || !input.liveOrgProblem.trim()) {
      throw new RoutingInputError('选路判不了：会话用户挂的组织为什么认不出，原因是空的');
    }
    if (input.liveOrg !== undefined) {
      throw new RoutingInputError('选路判不了：会话用户挂的组织既给了，又说认不出');
    }
  }
  // 切号的打算认不出就不往下判：拿坏的打算会把该硬挡的当成等得来（任务一直等），或反过来挂起等人
  const plan = input.orgPlan;
  if (plan !== undefined) {
    if (input.liveOrg === undefined) {
      throw new RoutingInputError('选路判不了：给了引擎切号的打算，却不知道会话用户现在挂的是哪个组织');
    }
    if (plan.to !== null && !ORGS.includes(plan.to)) {
      throw new RoutingInputError(`选路判不了：引擎打算切到的组织认不出（${String(plan.to)}）`);
    }
    if (plan.at !== null) {
      time(plan.at, '引擎打算切号的时刻');
      if (plan.to === null) throw new RoutingInputError('选路判不了：引擎切号的打算给了时刻，却没说切到哪个');
    }
    if (typeof plan.why !== 'string' || !plan.why.trim()) {
      throw new RoutingInputError('选路判不了：引擎切号的打算没写为什么');
    }
  }
  // 留量线设置的外壳认不出就不往下判：拿坏的输入会把该挡的当成不限
  const qr: unknown = input.quotaReserve;
  if (qr !== undefined && (typeof qr !== 'object' || qr === null || !('setting' in qr))) {
    throw new RoutingInputError('选路判不了：额度留量线的输入认不出（要 { setting: 设置原值 }）');
  }
  if (trialEnabled) {
    const d = input.draw;
    if (typeof d !== 'number' || !Number.isFinite(d) || d < 0 || d >= 1) {
      throw new RoutingInputError(`选路判不了：试探开着，随机数要在 [0, 1) 里，给的是 ${String(d)}`);
    }
  }
  const seenOrder = new Set<string>();
  const seenPos = new Set<number>();
  for (const e of input.order) {
    if (seenOrder.has(e.routeId))
      throw new RoutingInputError(`选路判不了：路由 ${e.routeId} 在顺序里出现了两次`);
    seenOrder.add(e.routeId);
    count(e.position, `路由 ${e.routeId} 的位置`);
    if (seenPos.has(e.position)) throw new RoutingInputError(`选路判不了：位置 ${e.position} 上有两条路由`);
    seenPos.add(e.position);
  }
  const facts = new Set<string>();
  for (const r of input.routes) {
    const who = `路由 ${r.routeId}`;
    if (facts.has(r.routeId)) throw new RoutingInputError(`选路判不了：${who} 的事实给了两份`);
    facts.add(r.routeId);
    if (!QUOTA_STATES.includes(r.quota))
      throw new RoutingInputError(`选路判不了：${who} 的额度状态认不出（${r.quota}）`);
    if (r.orgKind !== undefined && r.orgKind !== null && !ORGS.includes(r.orgKind))
      throw new RoutingInputError(`选路判不了：${who} 的组织类型认不出（${String(r.orgKind)}）`);
    if (r.probeState !== undefined && r.probeState !== null && !PROBE_STATES.includes(r.probeState)) {
      throw new RoutingInputError(`选路判不了：${who} 的探针结论认不出（${String(r.probeState)}）`);
    }
    if (r.probeOrg !== undefined && r.probeOrg !== null && !ORGS.includes(r.probeOrg)) {
      throw new RoutingInputError(`选路判不了：${who} 探针那时挂的组织认不出（${String(r.probeOrg)}）`);
    }
    count(r.inFlight, `${who} 的在途数`);
    // 读不到不能当 0：一批任务同时来时，每个都会看到「没人占着」，并发上限就挡不住。
    count(r.reserved, `${who} 的已选定还没开工数`);
    count(r.maxConcurrency, `${who} 的并发上限`);
    // 硬禁令也按上游串和别名认：没带上就只认得模型 id 和显示名，上游串是 Fable 的会漏过去。
    if (r.upstreamModel !== null && typeof r.upstreamModel !== 'string') {
      throw new RoutingInputError(`选路判不了：${who} 的上游模型串认不出（${String(r.upstreamModel)}）`);
    }
    if (!Array.isArray(r.upstreamAliases) || r.upstreamAliases.some((a) => typeof a !== 'string')) {
      throw new RoutingInputError(`选路判不了：${who} 的上游别名认不出（${String(r.upstreamAliases)}）`);
    }
    for (const b of r.blockers) {
      if (!CANDIDATE_BLOCKERS.includes(b))
        throw new RoutingInputError(`选路判不了：${who} 的被挡原因认不出（${b}）`);
    }
    // 在线的一定带着探针下结论的时刻（库里约束 alive 要有探针的 ok 结论）：没有就是输入拼错了，不当成刚探过。
    if (r.probedAt !== null) time(r.probedAt, `${who} 的探针时刻`);
    else if (!r.blockers.includes('offline')) {
      throw new RoutingInputError(`选路判不了：${who} 在线，却没有探针下结论的时刻`);
    }
    // 候选查询里两者是一回事（额度用满才挂 quota-exhausted）。对不上说明输入拼错了：用满的池会被照派，
    // 不能按其中一边往下走。
    if ((r.quota === 'exhausted') !== r.blockers.includes('quota-exhausted')) {
      throw new RoutingInputError(
        `选路判不了：${who} 的额度状态（${r.quota}）和被挡原因（${r.blockers.join('、') || '无'}）对不上`,
      );
    }
    if (!ADMITS.includes(r.breaker.admit)) {
      throw new RoutingInputError(`选路判不了：${who} 的熔断判定认不出（${r.breaker.admit}）`);
    }
    if (r.breaker.probeAt !== undefined) time(r.breaker.probeAt, `${who} 的熔断试探时刻`);
    if (r.record !== null) {
      count(r.record.samples, `${who} 的战绩样本数`);
      count(r.record.successes, `${who} 的战绩成功数`);
      if (r.record.successes > r.record.samples) {
        throw new RoutingInputError(`选路判不了：${who} 的战绩成功数比样本数还多`);
      }
    }
    for (const w of r.windows) {
      const where = `${who} 的额度窗 ${w.label}`;
      if (!WINDOW_STATES.includes(w.state))
        throw new RoutingInputError(`选路判不了：${where} 的状态认不出（${w.state}）`);
      if (w.used !== null && (typeof w.used !== 'number' || !Number.isFinite(w.used) || w.used < 0)) {
        throw new RoutingInputError(`选路判不了：${where} 的已用比例认不出（${String(w.used)}）`);
      }
      if (w.resetsAt !== null) time(w.resetsAt, `${where} 的清零时刻`);
      time(w.readAt, `${where} 的读数时刻`);
      if (w.staleSince !== null) time(w.staleSince, `${where} 的过期时刻`);
    }
  }
  for (const id of [...seenOrder, ...(input.taskRouteId === undefined ? [] : [input.taskRouteId])]) {
    if (!facts.has(id))
      throw new RoutingInputError(`选路判不了：路由 ${id} 的事实没给（候选、熔断、战绩没读到）`);
  }
  if (input.keepVerifier !== undefined) keepVerifierProblem(input);
  return now;
}

const familyList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((f) => typeof f === 'string' && f.trim() !== '');

/** 给验证留一家的输入：写手族空着就判不了验证是不是别家（不当成谁都能验）；验证那一步的输入自己由选路现选时再认一遍。 */
function keepVerifierProblem(input: ChooseRouteInput): void {
  const keep = input.keepVerifier;
  if (!keep) return;
  if (input.stage === 'verify') {
    throw new RoutingInputError('选路判不了：开 PR 前验证这一步自己不该带「给验证留一家」');
  }
  if (!familyList(keep.writers) || keep.writers.length === 0) {
    throw new RoutingInputError('选路判不了：给验证留一家却没给写这张单的族，判不了验证是不是别家');
  }
  if (keep.spare !== undefined && !familyList(keep.spare)) {
    throw new RoutingInputError(`选路判不了：先避开的族认不出（${String(keep.spare)}）`);
  }
  if (keep.otherwise !== 'none' && keep.otherwise !== 'any') {
    throw new RoutingInputError(`选路判不了：留不下验证时怎么办认不出（${String(keep.otherwise)}）`);
  }
  const verify: unknown = keep.verify;
  if (typeof verify !== 'object' || verify === null || 'keepVerifier' in verify || 'taskRouteId' in verify) {
    throw new RoutingInputError(
      '选路判不了：验证那一步的选路输入认不出（不该再带给验证留一家、任务指定的路由）',
    );
  }
}
