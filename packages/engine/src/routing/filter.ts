// 过滤：一条路由这次派不派得出去，挡在哪（每个原因一条，白话 + 等不等得来）。被挡的不删，带原因留给驾驶舱。
import { hardBanFor, type StageKind } from '@fleet-dao/shared';
import { duration, hostName, percent, remaining, STAGE_NAMES, stamp, windowName } from './names.ts';
import { ABILITY_NAMES, HOST_ABILITIES, type RoutingPolicy, STAGE_NEEDS } from './policy.ts';
import type {
  Block,
  CandidateBlocker,
  RouteFacts,
  RouteWindow,
  StageRouteEntry,
  TaskWeight,
} from './types.ts';

export interface FilterContext {
  stage: StageKind;
  weight: TaskWeight;
  policy: RoutingPolicy;
  now: number;
  avoid: { routeIds: ReadonlySet<string>; poolIds: ReadonlySet<string>; modelIds: ReadonlySet<string> };
}

/** 这条路由此刻的全部被挡原因；空数组 = 能派。entry 是调度台上的那一行（任务指定、不在顺序里的没有）。 */
export function blocksFor(
  route: RouteFacts,
  entry: StageRouteEntry | undefined,
  ctx: FilterContext,
): Block[] {
  const out: Block[] = [];
  // 候选查询按同一个开关也会给 switched-off：两边任一说关着就挡，只记一条。
  if ((entry && !entry.enabled) || route.blockers.includes('switched-off')) {
    out.push(hard('switched-off', '调度台上这一条关着'));
  }
  out.push(...candidateBlocks(route, ctx));
  const unfit = hostUnfit(route.hostId, ctx.stage);
  if (unfit) out.push(hard('host-unfit', unfit));
  if (route.breaker.admit === 'none') {
    out.push({
      code: 'breaker-open',
      text: `熔断：${route.breaker.reason}`,
      wait: 'breaker',
      until: route.breaker.probeAt ?? null,
    });
  }
  const avoided = avoidReason(route, ctx);
  if (avoided) out.push(hard('avoided', avoided));
  if (route.poolRole === 'backup') out.push(...backupBlocks(route, ctx));
  return out;
}

function hard(code: Block['code'], text: string): Block {
  return { code, text, wait: null, until: null };
}

type SpecialBlocker = 'switched-off' | 'banned' | 'quota-exhausted' | 'no-slot';

const CANDIDATE_TEXT: Record<Exclude<CandidateBlocker, SpecialBlocker>, string> = {
  offline: '不在线（探活或熔断判的）',
  'channel-disabled': '渠道关了',
  'pool-expired': '订阅过期了',
  'model-retired': '模型已下架',
};

function candidateBlocks(route: RouteFacts, ctx: FilterContext): Block[] {
  const out: Block[] = [];
  for (const b of route.blockers) {
    if (b === 'switched-off' || b === 'banned' || b === 'quota-exhausted' || b === 'no-slot') continue;
    out.push(hard(b, CANDIDATE_TEXT[b]));
  }
  // 硬禁令在这里再过一遍（shared 的同一份，连上游串和别名一起认）：候选查询漏了、或任务指定的路由没经过候选查询，也照样挡。
  const hardBan = hardBanFor(
    {
      id: route.modelId,
      family: route.family,
      displayName: route.modelName,
      upstreamModel: route.upstreamModel,
      upstreamAliases: route.upstreamAliases,
    },
    ctx.stage,
  );
  const reasons = [...route.banReasons];
  if (hardBan && !reasons.includes(hardBan.reason)) reasons.unshift(hardBan.reason);
  if (route.blockers.includes('banned') || reasons.length > 0) {
    out.push(hard('banned', `犯禁令：${reasons.length > 0 ? reasons.join('、') : '原因没写'}`));
  }
  if (route.blockers.includes('quota-exhausted')) out.push(exhaustedBlock(route, ctx.now));
  if (route.blockers.includes('no-slot')) {
    out.push({
      code: 'no-slot',
      text: `${route.poolName}并发满了（${route.inFlight}/${route.maxConcurrency}）`,
      wait: 'slot',
      until: null,
    });
  }
  return out;
}

/** 用满的窗口全都清零了才放得出来：所以最早能派 = 这些窗口里最晚的清零时刻；有一个不知道就不知道。 */
function exhaustedBlock(route: RouteFacts, now: number): Block {
  const full = route.windows.filter((w) => w.state === 'exhausted' && w.applies === 'yes');
  const resets = full.map((w) => (w.resetsAt === null ? null : Date.parse(w.resetsAt)));
  const known = resets.every((t): t is number => t !== null) && resets.length > 0;
  const until = known ? Math.max(...resets) : null;
  const names = full.map(windowName).join('、') || '额度';
  const when = until === null ? '清零时刻不知道' : `${duration(until - now)}后（${stamp(until)}）清零`;
  return {
    code: 'quota-exhausted',
    text: `${route.poolName}${names}用满，${when}`,
    wait: 'quota',
    until: until === null ? null : new Date(until).toISOString(),
  };
}

/** 执行方式够不够这个阶段：能力表是数据（policy.ts），这里只查表。 */
export function hostUnfit(hostId: string, stage: StageKind): string | null {
  const abilities = (HOST_ABILITIES as Record<string, readonly string[] | undefined>)[hostId];
  if (!abilities) return `执行方式认不出（${hostId}），不知道它能干什么`;
  const missing = STAGE_NEEDS[stage].filter((a) => !abilities.includes(a));
  if (missing.length === 0) return null;
  return `${hostName(hostId)}不会${missing.map((a) => ABILITY_NAMES[a]).join('、')}，${STAGE_NAMES[stage]}阶段要`;
}

function avoidReason(route: RouteFacts, ctx: FilterContext): string | null {
  if (ctx.avoid.routeIds.has(route.routeId)) return '这个任务要避开这条路由（刚在它上面出过错）';
  if (ctx.avoid.poolIds.has(route.poolId)) return `这个任务要避开${route.poolName}整个池`;
  if (ctx.avoid.modelIds.has(route.modelId)) return `这个任务要换模型，避开 ${route.modelName}`;
  return null;
}

/**
 * 备池（拼车号）三条：只接短而轻的活；同时最多 backupMaxConcurrency 个（和池自己的上限取小的）；
 * 适用的每个窗口剩余都要够跑一个活。
 * 额度未知时判不了够不够：只放一个轻活去试探，并发临时压到 1。拼车号的真实上限只有真实请求被拒最准
 * （/usage 看不见成员上限，design §十），读取器一坏就整个停派，等于渠道静默闲置。那个会话被拒时，被拒原文记成
 * 一条用满读数（清零时刻取原文），候选查询随之给出 quota-exhausted，所有任务避开到清零；被拒的任务由失败分流 QT1 换池。
 * 主池额度未知照常派、排在读到了的后面（rank.ts）。
 */
function backupBlocks(route: RouteFacts, ctx: FilterContext): Block[] {
  const out: Block[] = [];
  const { policy } = ctx;
  if (ctx.weight !== 'light') {
    out.push(hard('backup-heavy', `${route.poolName}是备池，只接短而轻的活，这一单是重活`));
  }
  const probe = backupProbeReason(route);
  const cap = probe === null ? Math.min(route.maxConcurrency, policy.backupMaxConcurrency) : 1;
  if (route.inFlight >= cap && !route.blockers.includes('no-slot')) {
    out.push({
      code: probe === null ? 'backup-no-slot' : 'backup-quota-unknown',
      text:
        probe === null
          ? `${route.poolName}是备池，同时最多 ${cap} 个，已经在跑 ${route.inFlight} 个`
          : `${route.poolName}额度未知（${probe}），只放一个试探，已经有 ${route.inFlight} 个在跑：等它的结果`,
      wait: 'slot',
      until: null,
    });
  }
  if (route.blockers.includes('quota-exhausted')) return out;
  // 额度未知时也照样看读到了的窗口（池级读数过期，但会话里顺手读到的窗口还新）：知道不够就等它清零，不拿试探去撞。
  for (const w of route.windows) {
    if (w.applies !== 'yes' || w.state !== 'ok') continue;
    const left = remaining(w);
    // 算不出还剩多少的，按额度未知放试探（backupProbeReason）。
    if (left === null) continue;
    const need = needPerTask(w, policy);
    if (left < need) out.push(shortBlock(route, w, left, need, ctx.now));
  }
  return out;
}

/**
 * 备池额度未知（没读成、读数过期，或适用的窗口算不出还剩多少）的白话原因：这时只放一个试探。
 * 主池、已经用满的、读到了的为空。
 */
export function backupProbeReason(route: RouteFacts): string | null {
  if (route.poolRole !== 'backup' || route.quota === 'exhausted') return null;
  if (route.quota === 'unknown') return '没读成或读数过期';
  const blind = route.windows.find((w) => w.applies === 'yes' && w.state === 'ok' && remaining(w) === null);
  return blind ? `${windowName(blind)}算不出还剩多少` : null;
}

function needPerTask(w: RouteWindow, policy: RoutingPolicy): number {
  return policy.backupNeedPerTask[w.window] ?? policy.backupNeedPerTask.other ?? 0;
}

function shortBlock(route: RouteFacts, w: RouteWindow, left: number, need: number, now: number): Block {
  const reset = w.resetsAt === null ? null : Date.parse(w.resetsAt);
  const when = reset === null ? '清零时刻不知道' : `${duration(reset - now)}后清零`;
  return {
    code: 'backup-quota-short',
    text: `${route.poolName}是备池，${windowName(w)}只剩 ${percent(left)}，不够跑一个活（要 ${percent(need)}），${when}`,
    wait: 'quota',
    until: reset === null ? null : new Date(reset).toISOString(),
  };
}
