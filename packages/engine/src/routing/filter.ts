// 过滤：一条路由这次派不派得出去，挡在哪（每个原因一条，白话 + 等不等得来）。被挡的不删，带原因留给驾驶舱。
// 等得来的原因带「最早几点能好」，一定晚于现在：那个时刻已经过了（读数、熔断状态慢了一步）就按不知道算，
// 调用方按轮询间隔再选一次——给一个过去的时刻，等待秒数成了负数，选路循环会空转。
import { hardBanFor, type OrgKind, type StageKind } from '@fleet-dao/shared';
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
  /** 会话用户此刻挂的组织；不知道为 undefined（ChooseRouteInput.liveOrg）。 */
  liveOrg: OrgKind | undefined;
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
  if (route.breaker.admit === 'none') out.push(breakerBlock(route, ctx.now));
  const avoided = avoidReason(route, ctx);
  if (avoided) out.push(hard('avoided', avoided));
  const notLive = orgNotLive(route, ctx.liveOrg);
  if (notLive) out.push(hard('org-not-live', notLive));
  if (route.poolRole === 'backup') out.push(...backupBlocks(route, ctx));
  out.push(...shortBlocks(route, ctx));
  return out;
}

function hard(code: Block['code'], text: string): Block {
  return { code, text, wait: null, until: null };
}

/** 只收晚于现在的时刻；已经过了的按不知道算。 */
function ahead(at: number | null, now: number): number | null {
  return at !== null && at > now ? at : null;
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
  // 候选查询只数已开工的；已选定、还没开工的也占位子，这里再按两者之和判一次。
  if (route.blockers.includes('no-slot') || occupied(route) >= route.maxConcurrency) {
    const text =
      route.reserved > 0
        ? `${holders(route)}，上限 ${route.maxConcurrency} 个`
        : `${route.inFlight}/${route.maxConcurrency}`;
    out.push({ code: 'no-slot', text: `${route.poolName}并发满了（${text}）`, wait: 'slot', until: null });
  }
  return out;
}

/** 这个池占着的位子：在跑的 + 已选定还没开工的。 */
function occupied(route: RouteFacts): number {
  return route.inFlight + route.reserved;
}

function holders(route: RouteFacts): string {
  return route.reserved > 0
    ? `已经有 ${occupied(route)} 个（在跑 ${route.inFlight} 个、已选定还没开工 ${route.reserved} 个）`
    : `已经在跑 ${route.inFlight} 个`;
}

/** 用满的窗口全都清零了才放得出来：所以最早能派 = 这些窗口里最晚的清零时刻；有一个不知道就不知道。 */
function exhaustedBlock(route: RouteFacts, now: number): Block {
  const full = route.windows.filter((w) => w.state === 'exhausted' && w.applies === 'yes');
  const resets = full.map((w) => (w.resetsAt === null ? null : Date.parse(w.resetsAt)));
  const known = resets.every((t): t is number => t !== null) && resets.length > 0;
  const latest = known ? Math.max(...resets) : null;
  const until = ahead(latest, now);
  const names = full.map(windowName).join('、') || '额度';
  const when =
    until !== null
      ? `${duration(until - now)}后（${stamp(until)}）清零`
      : latest !== null
        ? '清零时刻已过，等下一次读数'
        : '清零时刻不知道';
  return {
    code: 'quota-exhausted',
    text: `${route.poolName}${names}用满，${when}`,
    wait: 'quota',
    until: until === null ? null : new Date(until).toISOString(),
  };
}

/**
 * 熔断挡着：开着的等到试探时刻；半开、已经有一个试探在跑的，试探时刻已经过了，等的是那个试探的结果
 * （什么时候出结果不知道，按轮询间隔再看）。
 */
function breakerBlock(route: RouteFacts, now: number): Block {
  const probeAt = route.breaker.probeAt === undefined ? null : Date.parse(route.breaker.probeAt);
  const until = ahead(probeAt, now);
  return {
    code: 'breaker-open',
    text: until === null ? `熔断：等试探结果（${route.breaker.reason}）` : `熔断：${route.breaker.reason}`,
    wait: 'breaker',
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

const ORG_NAMES: Record<OrgKind, string> = { solo: '独享', carpool: '拼车' };

/**
 * 会话用户同一时刻只挂一个 reclaude 组织（design 第九节）：不是它挂着的那个组织的 Claude 池，派过去会话照样扣挂着的
 * 那个组织，额度账就记错了池。不知道挂的是哪个，带组织类型的池一律不派。
 */
function orgNotLive(route: RouteFacts, liveOrg: OrgKind | undefined): string | null {
  const kind = route.orgKind;
  if (kind === undefined || kind === null) return null;
  if (liveOrg === undefined) return `不知道会话用户现在挂的是哪个组织，${route.poolName}不派`;
  if (kind === liveOrg) return null;
  return `会话用户现在挂的是${ORG_NAMES[liveOrg]}组织，${route.poolName}要等切过去才能派`;
}

function avoidReason(route: RouteFacts, ctx: FilterContext): string | null {
  if (ctx.avoid.routeIds.has(route.routeId)) return '这个任务要避开这条路由（刚在它上面出过错）';
  if (ctx.avoid.poolIds.has(route.poolId)) return `这个任务要避开${route.poolName}整个池`;
  if (ctx.avoid.modelIds.has(route.modelId)) return `这个任务要换模型，避开 ${route.modelName}`;
  return null;
}

/**
 * 备池（拼车号）另有两条：只接短而轻的活；同时最多 backupMaxConcurrency 个（和池自己的上限取小的）。
 * 额度未知时判不了够不够：只放一个轻活去试探，并发临时压到 1。拼车号的真实上限只有真实请求被拒最准
 * （/usage 看不见成员上限，design §十），读取器一坏就整个停派，等于渠道静默闲置。那个会话被拒时，被拒原文记成
 * 一条用满读数（清零时刻取原文），候选查询随之给出 quota-exhausted，所有任务避开到清零；被拒的任务由失败分流 QT1 换池。
 * 主池额度未知照常派、排在读到了的后面（rank.ts）。「额度够收尾」所有路由都判（shortBlocks）。
 */
function backupBlocks(route: RouteFacts, ctx: FilterContext): Block[] {
  const out: Block[] = [];
  if (ctx.weight !== 'light') {
    out.push(hard('backup-heavy', `${route.poolName}是备池，只接短而轻的活，这一单是重活`));
  }
  const probe = backupProbeReason(route);
  const cap = probe === null ? Math.min(route.maxConcurrency, ctx.policy.backupMaxConcurrency) : 1;
  const poolFull = route.blockers.includes('no-slot') || occupied(route) >= route.maxConcurrency;
  if (occupied(route) >= cap && !poolFull) {
    out.push({
      code: probe === null ? 'backup-no-slot' : 'backup-quota-unknown',
      text:
        probe === null
          ? `${route.poolName}是备池，同时最多 ${cap} 个，${holders(route)}`
          : `${route.poolName}额度未知（${probe}），只放一个试探，${holders(route)}：等它的结果`,
      wait: 'slot',
      until: null,
    });
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

/** 比较剩余和所需时的容差：1 − 0.9 算出来是 0.0999…，正好剩一成要算够。 */
const EPSILON = 1e-9;

/**
 * 额度够收尾（design §九 选路第 1 条，所有路由都判）：这条路由适用的每个窗口，读到了还剩多少的，剩余要够跑一个活，
 * 不够就等那个窗口清零。读数过期、算不出剩多少、判不了扣不扣的窗口不在这里挡——那是「额度未知」：主池排后面，
 * 备池只放一个试探。额度未知的池照样看读到了的窗口（池级读数过期，但会话里顺手读到的窗口还新）：知道不够就等，不拿活去撞。
 */
function shortBlocks(route: RouteFacts, ctx: FilterContext): Block[] {
  if (route.blockers.includes('quota-exhausted')) return [];
  const out: Block[] = [];
  for (const w of route.windows) {
    if (w.applies !== 'yes' || w.state !== 'ok') continue;
    const left = remaining(w);
    if (left === null) continue;
    const need = needPerTask(w, ctx.policy);
    if (left + EPSILON < need) out.push(shortBlock(route, w, left, need, ctx.now));
  }
  return out;
}

function needPerTask(w: RouteWindow, policy: RoutingPolicy): number {
  return policy.needPerTask[w.window] ?? policy.needPerTask.other ?? 0;
}

function shortBlock(route: RouteFacts, w: RouteWindow, left: number, need: number, now: number): Block {
  const reset = w.resetsAt === null ? null : Date.parse(w.resetsAt);
  const until = ahead(reset, now);
  const when =
    until !== null
      ? `${duration(until - now)}后清零`
      : reset !== null
        ? '清零时刻已过，等下一次读数'
        : '清零时刻不知道';
  return {
    code: 'quota-short',
    text: `${route.poolName}${windowName(w)}只剩 ${percent(left)}，不够跑一个活（要 ${percent(need)}），${when}`,
    wait: 'quota',
    until: until === null ? null : new Date(until).toISOString(),
  };
}
