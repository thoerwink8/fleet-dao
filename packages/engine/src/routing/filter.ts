// 过滤：一条路由这次派不派得出去，挡在哪（每个原因一条，白话 + 等不等得来）。被挡的不删，带原因留给驾驶舱。
// 等得来的原因带「最早几点能好」，一定晚于现在：那个时刻已经过了（读数、熔断状态慢了一步）就按不知道算，
// 调用方按轮询间隔再选一次——给一个过去的时刻，等待秒数成了负数，选路循环会空转。
import {
  hardBanFor,
  type OrgKind,
  ROUTE_PROBE_EVERY_MINUTES,
  routeProbeStaleMinutes,
  type StageKind,
} from '@fleet-dao/shared';
import {
  duration,
  hostName,
  ORG_NAMES,
  percent,
  remaining,
  STAGE_NAMES,
  stamp,
  windowName,
} from './names.ts';
import { ABILITY_NAMES, HOST_ABILITIES, type RoutingPolicy, STAGE_NEEDS } from './policy.ts';
import type {
  Block,
  CandidateBlocker,
  OrgPlanView,
  RouteFacts,
  RouteWindow,
  StageRouteEntry,
} from './types.ts';

export interface FilterContext {
  stage: StageKind;
  policy: RoutingPolicy;
  now: number;
  avoid: {
    routeIds: ReadonlySet<string>;
    poolIds: ReadonlySet<string>;
    modelIds: ReadonlySet<string>;
    /** 要避开的模型族（小写）。 */
    families: ReadonlySet<string>;
    /** 先避开的族（小写，KeepVerifier.spare）：别家的都会让开 PR 前验证没人可派时，选路去掉它再选一次。 */
    spare?: ReadonlySet<string>;
    /**
     * 渠道自己挑模型的路由（上游串 auto）也不派：给开 PR 前验证留一家要认得出是哪一家（KeepVerifier）。
     * 避开了族（families、spare）的一律不派，不用另给。
     */
    routers?: boolean;
  };
  /**
   * 给开 PR 前验证留一家（ChooseRouteInput.keepVerifier）：选了会让验证没人可派的族（小写）→ 挡掉的白话（no-verifier）。
   * 由 choose.ts 按候选的族现算，不给 = 不管。
   */
  spoils?: ReadonlyMap<string, string>;
  /** 会话用户此刻挂的组织；不知道为 undefined（ChooseRouteInput.liveOrg）。 */
  liveOrg: OrgKind | undefined;
  /** 不知道是因为读了没读成：原话（ChooseRouteInput.liveOrgProblem）。 */
  liveOrgProblem?: string | undefined;
  /** 引擎切号的打算（ChooseRouteInput.orgPlan）：不是挂着的那个组织的池等不等得来按它判。 */
  orgPlan?: OrgPlanView | undefined;
  /** 界面类的活：禁令按 UI 判（ChooseRouteInput.uiWork）。 */
  uiWork: boolean;
}

/** 族名比较用的写法：去掉首尾空白、小写（和 core 的 decideVerdict 判同族一个认法）。 */
export const familyKey = (family: string): string => family.trim().toLowerCase();

/** 这条路由此刻的全部被挡原因；空数组 = 能派。entry 是它在路由两层顺序里的那一行（任务指定、不在顺序里的没有）。 */
export function blocksFor(
  route: RouteFacts,
  entry: StageRouteEntry | undefined,
  ctx: FilterContext,
): Block[] {
  const out: Block[] = [];
  // 候选查询按同一个开关也会给 switched-off：两边任一说关着就挡，只记一条。
  if ((entry && !entry.enabled) || route.blockers.includes('switched-off')) {
    out.push(hard('switched-off', '这条路由在它的模型下关着（路由两层的开关）'));
  }
  out.push(...candidateBlocks(route, ctx));
  const unfit = hostUnfit(route.hostId, ctx.stage);
  if (unfit) out.push(hard('host-unfit', unfit));
  if (route.breaker.admit === 'none') out.push(breakerBlock(route, ctx.now));
  const avoided = avoidReason(route, ctx);
  if (avoided) out.push(hard('avoided', avoided));
  const spoiled = ctx.spoils?.get(familyKey(route.family));
  if (spoiled) out.push(hard('no-verifier', spoiled));
  const notLive = orgBlock(route, ctx);
  if (notLive) out.push(notLive);
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
    out.push(b === 'offline' ? offlineBlock(route, ctx) : hard(b, CANDIDATE_TEXT[b]));
  }
  // 硬禁令在这里再过一遍（shared 的同一份，连上游串和别名一起认）：候选查询漏了、或任务指定的路由没经过候选查询，也照样挡。
  // 界面类的活（例如验证一个改了页面的改动）按 UI 判：候选查询是按阶段算的，查不出这一条。
  const hardBan = hardBanFor(
    {
      id: route.modelId,
      family: route.family,
      displayName: route.modelName,
      upstreamModel: route.upstreamModel,
      upstreamAliases: route.upstreamAliases,
    },
    ctx.uiWork ? 'ui' : ctx.stage,
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

/**
 * 会话用户同一时刻只挂一个 reclaude 组织（design 第九节）：不是它挂着的那个组织的 Claude 池，派过去会话照样扣挂着的
 * 那个组织，额度账就记错了池。不知道挂的是哪个（读了没读成的带上原话），带组织类型的池一律不派，不拿哪个组织顶。
 * 不是挂着的那个组织的池：引擎打算切过去的（orgPlan，和切号同一个判法）等得来——等切号，任务不挂起（#335：09-27 21:54
 * 人手动切走又切回，这里硬挡了拼车，任务挂起等人）；不打算切的（或没判）硬挡，写明引擎为什么不切。
 */
function orgBlock(route: RouteFacts, ctx: FilterContext): Block | null {
  const kind = route.orgKind;
  if (kind === undefined || kind === null) return null;
  const { liveOrg, liveOrgProblem: problem, orgPlan: plan } = ctx;
  // 渠道不可用（可用账号 0 个）：不管挂着哪个组织，Claude 订阅的池都不派，写明原因（自己恢复后这一条就没了）
  if (plan?.channelDown) {
    return hard('org-not-live', `渠道不可用，${route.poolName}不派：${plan.channelDown}`);
  }
  if (liveOrg === undefined) {
    return hard(
      'org-not-live',
      problem
        ? `会话用户挂的组织认不出（${problem}），${route.poolName}不派`
        : `不知道会话用户现在挂的是哪个组织，${route.poolName}不派`,
    );
  }
  if (kind === liveOrg) {
    // 切回拼车的宽限中：现在挂着的这一类新活先不派，等切回（在跑的不动，宽限到点才停）
    if (plan?.drain === kind) {
      const at = plan.at === null ? null : ahead(Date.parse(plan.at), ctx.now);
      return {
        code: 'org-not-live',
        text: `${route.poolName}在切回${plan.to ? ORG_NAMES[plan.to] : '另一个'}组织的宽限中，新活先不派（${plan.why}），等切号`,
        wait: 'org',
        until: at === null ? null : new Date(at).toISOString(),
      };
    }
    return null;
  }
  const head = `会话用户现在挂的是${ORG_NAMES[liveOrg]}组织，${route.poolName}要等切过去才能派`;
  if (!plan) return hard('org-not-live', head);
  if (plan.to !== kind) return hard('org-not-live', `${head}；引擎现在不打算切过去（${plan.why}）`);
  const at = plan.at === null ? null : ahead(Date.parse(plan.at), ctx.now);
  return {
    code: 'org-not-live',
    text: `${head}；引擎${at === null ? '下一轮路由探针' : `${stamp(at)} 以后的那一轮路由探针`}切过去（${plan.why}），等切号`,
    wait: 'org',
    until: at === null ? null : new Date(at).toISOString(),
  };
}

/**
 * 候选查询说它不在线。Claude 订阅池的路由上一次的结论是探针在另一个组织挂着时写的「不探」（skipped、probeOrg 是另一个
 * 组织）：那不是它坏了，是那一轮探不了它。现在会话用户挂的正是它的组织：等下一轮路由探针在这个组织下探过再派（最早是
 * 上一次结论之后一轮），任务不挂起；过了探针的过期线（routeProbeStaleMinutes）还没探到，按不在线硬挡，写明探针可能停了。
 * 别的（探了没通、认不出组织没探、老的输入没给结论）照老样子硬挡。
 */
function offlineBlock(route: RouteFacts, ctx: FilterContext): Block {
  const kind = route.orgKind;
  const seen = route.probeOrg;
  if (
    !kind ||
    ctx.liveOrg !== kind ||
    route.probeState !== 'skipped' ||
    !seen ||
    seen === kind ||
    route.probedAt === null
  ) {
    return hard('offline', CANDIDATE_TEXT.offline);
  }
  const probedAt = Date.parse(route.probedAt);
  const age = ctx.now - probedAt;
  const was = `探针上一次看它（${stamp(probedAt)}）时会话用户挂的是${ORG_NAMES[seen]}组织，没探它`;
  if (age > routeProbeStaleMinutes(route.hostId) * 60_000) {
    return hard('offline', `${was}，之后 ${duration(age)}探针都没再探它（探针可能停了），按不在线算`);
  }
  const next = ahead(probedAt + ROUTE_PROBE_EVERY_MINUTES * 60_000, ctx.now);
  return {
    code: 'offline',
    text: `${was}；现在挂的是${ORG_NAMES[kind]}组织，等下一轮路由探针在${ORG_NAMES[kind]}组织下探过再派`,
    wait: 'probe',
    until: next === null ? null : new Date(next).toISOString(),
  };
}

/** 上游串是 auto 的（Cursor Auto 这类由渠道自己挑模型的）：这一次到底是哪一家在答，事先认不出。 */
const ROUTER_MODEL = /(?:^|[/:])auto$/i;

/** 这条路由的模型是不是由渠道自己挑的（上游串或别名是 auto）。 */
export function routerPicksModel(route: Pick<RouteFacts, 'upstreamModel' | 'upstreamAliases'>): boolean {
  return [route.upstreamModel ?? '', ...(route.upstreamAliases ?? [])].some((n) =>
    ROUTER_MODEL.test(n.trim()),
  );
}

function avoidReason(route: RouteFacts, ctx: FilterContext): string | null {
  const family = familyKey(route.family);
  const spare = ctx.avoid.spare ?? new Set<string>();
  const byFamily = ctx.avoid.families.size > 0 || spare.size > 0;
  if (ctx.avoid.families.has(family)) {
    return `这一步只派别家：${route.modelName} 是 ${route.family} 族，写这张单的就有这一族`;
  }
  if (spare.has(family)) {
    return `先派别家：${route.modelName} 是 ${route.family} 族，写这张单的就有这一族（别家都会让开 PR 前验证没人可派时才派它）`;
  }
  // 只派别家、给验证留一家都要认得出是哪一家：渠道自己挑模型的，挑中的可能正是写这张单的那家
  if ((byFamily || ctx.avoid.routers) && routerPicksModel(route)) {
    const why = byFamily ? '这一步只派别家' : '给开 PR 前验证留一家要认得出是哪一家';
    return `${why}：${route.modelName} 由渠道自己挑模型（上游串 ${route.upstreamModel}），认不出这次是哪一家在答`;
  }
  if (ctx.avoid.routeIds.has(route.routeId)) return '这个任务要避开这条路由（刚在它上面出过错）';
  if (ctx.avoid.poolIds.has(route.poolId)) return `这个任务要避开${route.poolName}整个池`;
  if (ctx.avoid.modelIds.has(route.modelId)) return `这个任务要换模型，避开 ${route.modelName}`;
  return null;
}

/** 比较剩余和所需时的容差：1 − 0.9 算出来是 0.0999…，正好剩一成要算够。 */
const EPSILON = 1e-9;

/**
 * 额度够收尾（design §九 选路第 1 条，所有路由都判）：这条路由适用的每个窗口，读到了还剩多少的，剩余要够跑一个活，
 * 不够就等那个窗口清零。读数过期、算不出剩多少、判不了扣不扣的窗口不在这里挡——那是「额度未知」：照派、排在读到了的
 * 后面（rank.ts）。额度未知的池照样看读到了的窗口（池级读数过期，但会话里顺手读到的窗口还新）：知道不够就等，不拿活去撞。
 */
function shortBlocks(route: RouteFacts, ctx: FilterContext): Block[] {
  if (route.blockers.includes('quota-exhausted')) return [];
  // 拼车池不按「够收尾」挡（#194 方案 4.3，创始人 2026-10-04 约 08:50「拼车要尽可能用完」）：拼车额度不用就作废、还会被同车的人
  // 用掉，所以用到被拒为止，被拒当场切独享；剩最后一成就不派的话，那点额度用不掉、活还空等（G1 死区）。用满了（exhausted）的照挡，
  // 上面已经 return。独享、别家照判。
  if (route.orgKind === 'carpool') return [];
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
