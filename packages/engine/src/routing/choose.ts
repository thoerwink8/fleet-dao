// 选路（设计 §九「选路」五条 + §十二「一条路由报繁忙，所有任务一起避开」由熔断判定带进来）。
// 纯函数、确定性：同样输入同样输出；不取时钟、不随机——现在几点、试探用的随机数都由调用方给，引擎记进历史。

import { routeProbeStaleMinutes } from '@fleet-dao/shared';
import { blocksFor, type FilterContext, familyKey } from './filter.ts';
import { type BlockGroup, groupOf } from './group.ts';
import { duration, routeLabel, STAGE_NAMES, stamp } from './names.ts';
import { resolveRoutingPolicy } from './policy.ts';
import { type Ranked, rank } from './rank.ts';
import type {
  AllOpenCheck,
  Block,
  ChooseRouteInput,
  ChooseRouteResult,
  KeepVerifier,
  RouteFacts,
  RouteVerdict,
  StageRouteEntry,
  TrialKind,
} from './types.ts';
import { time, validateInput } from './validate.ts';
import { verifierGuard } from './verifier.ts';

interface Judged {
  item: Ranked;
  blocks: Block[];
  group: BlockGroup;
}

function contextOf(
  input: ChooseRouteInput,
  policy: ReturnType<typeof resolveRoutingPolicy>,
  now: number,
): FilterContext {
  return {
    stage: input.stage,
    policy,
    now,
    avoid: {
      routeIds: new Set(input.avoid?.routeIds ?? []),
      poolIds: new Set(input.avoid?.poolIds ?? []),
      modelIds: new Set(input.avoid?.modelIds ?? []),
      families: new Set((input.avoid?.families ?? []).map(familyKey)),
      // 给验证留一家：先避开的族照旧避开（放不放行在 keepingVerifier 里定），渠道自己挑模型的认不出是哪一家、不派
      spare: new Set((input.keepVerifier?.spare ?? []).map(familyKey)),
      routers: input.keepVerifier !== undefined,
    },
    liveOrg: input.liveOrg,
    liveOrgProblem: input.liveOrgProblem,
    uiWork: input.uiWork ?? false,
  };
}

/** 排序 → 每条算被挡原因 → 分组。chooseRoute 和 stageAllOpen 共用这一段，熔断算不算挡着才不会两套。 */
function judgeStage(input: ChooseRouteInput, ctx: FilterContext): Judged[] {
  const factsOf = new Map(input.routes.map((r) => [r.routeId, r]));
  const rows = [...input.order]
    .sort((a, b) => a.position - b.position)
    .map((entry) => ({ route: factsOf.get(entry.routeId) as RouteFacts, entry }));
  const ranked = rank(rows, input.stagePinned, ctx.policy, ctx.now);
  return ranked.map((item) => {
    const blocks = blocksFor(item.route, item.entry, ctx);
    return { item, blocks, group: groupOf(blocks) };
  });
}

export function chooseRoute(input: ChooseRouteInput): ChooseRouteResult {
  const policy = resolveRoutingPolicy(input.policy);
  const now = validateInput(input, policy.trialEnabled);
  const ctx = contextOf(input, policy, now);
  return input.keepVerifier ? keepingVerifier(input, ctx, input.keepVerifier) : chooseIn(input, ctx);
}

/**
 * 给开 PR 前验证留一家（ChooseRouteInput.keepVerifier；verifier.ts 按候选的族现选一次验证那一步）：
 * 1. 写这张单的族已经让验证没人可派：选谁都救不回来，照常选（先避开的族照旧避开），带 noVerifier 让调用方当场报警。
 * 2. 任务指定的路由（续会话、人点名）不挡：换了就续不上会话、人的指令就是要它；它会让验证没人可派也照派，带 noVerifier。
 * 3. 照常选，会让验证没人可派的族挡掉（no-verifier），先避开的族照旧避开：有能派、能等的就是它。
 * 4. 别家的候选能派（或等得来）、却都会让验证没人可派：放行先避开的族再选一次——它们本来就在写这张单，不多加一族。
 *    别家只是没额度、连不上的不放行（副手派不出由 Lead 自己干，0003 第 7 条）。
 * 5. 还是没有：otherwise none 交派不出（副手：Lead 自己干，写手族不变）；any 照常选、带 noVerifier（Lead：非派不可）。
 */
function keepingVerifier(input: ChooseRouteInput, ctx: FilterContext, keep: KeepVerifier): ChooseRouteResult {
  const guard = verifierGuard(keep, chooseRoute);
  const factsOf = new Map(input.routes.map((r) => [r.routeId, r]));
  // 任务指定的路由不按「先避开」挡：续的会话可能正是上一次放行的同族，人点名的就是要它
  const unspared: FilterContext = { ...ctx, avoid: { ...ctx.avoid, spare: new Set<string>() } };
  const task = input.taskRouteId === undefined ? null : (factsOf.get(input.taskRouteId) as RouteFacts);
  const already = guard.left(null);
  if (already !== null) return { ...chooseIn(input, task ? unspared : ctx), noVerifier: already };

  if (task) {
    const r = chooseIn(input, unspared);
    const spoil = r.kind === 'none' ? null : guard.left(task.family);
    return spoil === null ? r : { ...r, noVerifier: spoil };
  }

  const spoils = new Map<string, string>();
  for (const e of input.order) {
    const family = (factsOf.get(e.routeId) as RouteFacts).family;
    const key = familyKey(family);
    if (!spoils.has(key) && guard.left(family) !== null) spoils.set(key, guard.block(family));
  }
  const first = chooseIn(input, { ...ctx, spoils });
  if (first.kind !== 'none') return first;
  if ((ctx.avoid.spare?.size ?? 0) > 0 && first.verdicts.some(spoiledOnly)) {
    const second = chooseIn(input, { ...unspared, spoils });
    if (second.kind === 'dispatch') return { ...second, why: `${second.why}；${SPARED}` };
    if (second.kind === 'wait') return { ...second, reason: `${second.reason}；${SPARED}` };
  }
  if (keep.otherwise === 'none') return first;
  const any = chooseIn(input, ctx);
  if (any.kind === 'none') return any;
  // 派出去的那条（等的话，最先等得来的那条）会让验证没人可派：第 3 步挡掉之后就没有别的能派、能等的了
  const open = any.verdicts.find((v) => groupOf(v.blocks).kind !== 'hard');
  const family = any.kind === 'dispatch' ? any.family : (factsOf.get(open?.routeId ?? '')?.family ?? null);
  const spoil = family === null ? null : guard.left(family);
  return spoil === null ? any : { ...any, noVerifier: spoil };
}

const SPARED = '别家的都会让开 PR 前验证没有别家可派，改派写这张单的同族（不多加一族）';

/** 只因为「选它验证就没人可派」挡着：去掉这一条就能派、等得来。 */
function spoiledOnly(v: RouteVerdict): boolean {
  if (!v.blocks.some((b) => b.code === 'no-verifier')) return false;
  return groupOf(v.blocks.filter((b) => b.code !== 'no-verifier')).kind !== 'hard';
}

/** 过滤、排序之后怎么选：任务指定的只看它；没配顺序、一条没配派不出；能派的派，全熔断放试探，其余等或派不出。 */
function chooseIn(input: ChooseRouteInput, ctx: FilterContext): ChooseRouteResult {
  const { policy, now } = ctx;
  const stageName = STAGE_NAMES[input.stage];
  const factsOf = new Map(input.routes.map((r) => [r.routeId, r]));
  const fact = (id: string) => factsOf.get(id) as RouteFacts;

  if (input.taskRouteId !== undefined) return chooseTaskRoute(input, fact(input.taskRouteId), ctx);

  if (!input.configured) {
    return {
      kind: 'none',
      reason: `${stageName}阶段还没在调度台上排路由顺序：不按编号乱挑，请先排好`,
      verdicts: [],
    };
  }
  if (input.order.length === 0) {
    return { kind: 'none', reason: `${stageName}阶段一条路由都没配`, verdicts: [] };
  }

  const judged = judgeStage(input, ctx);
  const verdicts = judged.map((j, i) => verdictOf(j, i));

  const ready = judged.filter((j) => j.group.kind === 'ready');
  const first = ready[0];
  if (first) {
    const explore = pickTrial(input, ready, policy);
    const chosen = explore ?? first;
    const route = chosen.item.route;
    const breakerTrial = route.breaker.admit === 'trial';
    const trial: TrialKind | null = explore ? 'explore' : breakerTrial ? 'breaker' : null;
    const why = explore
      ? withNotes(
          `试探：${stageName}阶段第 ${explore.item.humanIndex + 1} 条 ${routeLabel(route)}（首选是 ${routeLabel(first.item.route)}；约 ${Math.round(policy.trialRatio * 100)}% 的任务派给非首选，攒战绩）`,
          quotaNote(route),
          breakerTrial ? BREAKER_TRIAL : null,
        )
      : withNotes(whyFirst(stageName, chosen, judged), breakerTrial ? BREAKER_TRIAL : null);
    return dispatch(route, why, trial, null, verdicts, now);
  }

  const allOpen = allOpenTrial(judged);
  if (allOpen) {
    const why = withNotes(
      `${stageName}阶段的候选路由全都熔断，多半是共用的一层坏了（本机网络、中转服务）：放最早到点的 ${routeLabel(allOpen.item.route)} 去试探`,
      quotaNote(allOpen.item.route),
    );
    return dispatch(allOpen.item.route, why, 'all-open', why, verdicts, now);
  }

  return waitOrNone(stageName, judged, verdicts);
}

/** 每条派出去的路径都经这里：理由末尾补上探针结论过期的那句（probeNote）。 */
function dispatch(
  route: RouteFacts,
  why: string,
  trial: TrialKind | null,
  alarm: string | null,
  verdicts: RouteVerdict[],
  now: number,
): ChooseRouteResult {
  return {
    kind: 'dispatch',
    routeId: route.routeId,
    poolId: route.poolId,
    modelId: route.modelId,
    family: route.family,
    hostId: route.hostId,
    why: withNotes(why, probeNote(route, now)),
    trial,
    alarm,
    verdicts,
  };
}

/**
 * 派出去的这条路由的「在线」是探针多久前的结论（design 第九节「路由探针」）。超过 routeProbeStaleMinutes 没更新
 * （每轮都探的连着三轮没给新结论；放慢的执行方式按它的间隔再加两轮——探针可能停了）照上一次的结论派：探针是看门的，
 * 它自己坏了不该把活全挡住（额度没读成不挡是同一个道理，真坏了的路由由会话的失败分流兜住）；但理由里写明，不拿上一次的
 * 结论冒充现在。和驾驶舱标「探测过期」同一条线。
 */
function probeNote(route: RouteFacts, now: number): string | null {
  // 在线的一定有时刻（validate.ts 已拦）；派得出去的都在线。
  if (route.probedAt === null) return null;
  const age = now - Date.parse(route.probedAt);
  if (age <= routeProbeStaleMinutes(route.hostId) * 60_000) return null;
  return `在线是探针 ${duration(age)}前的结论，之后它没再给新结论（探针可能停了），照上一次的结论派`;
}

function verdictOf(j: Judged, index: number): RouteVerdict {
  return {
    routeId: j.item.route.routeId,
    label: routeLabel(j.item.route),
    humanRank: j.item.humanIndex + 1,
    rank: index + 1,
    pinned: j.item.pinned,
    blocks: j.blocks,
    nudges: j.item.nudges,
  };
}

/** 「写码阶段第 2 条：拼车号 · Opus 5.5 · Claude Code；拼车号周额度 20 小时后清零、还剩 70%，提到最前」。 */
function whyFirst(stageName: string, chosen: Judged, judged: Judged[]): string {
  const { item } = chosen;
  const parts = [
    `${stageName}阶段第 ${item.humanIndex + 1} 条：${routeLabel(item.route)}${item.pinned ? '（钉住）' : ''}`,
  ];
  const at = judged.indexOf(chosen);
  if (item.fast) {
    const fast = item.nudges.find((n) => n.kind === 'fast-reset');
    if (fast && item.humanIndex > at)
      parts.push(fast.text.replace(/往前提$/, at === 0 ? '提到最前' : `提到第 ${at + 1}`));
  }
  const note = quotaNote(item.route);
  if (note) parts.push(note);
  // 人排在它前面、这次没派的：各自为什么（被挡，或被微调挪到了后面）。
  const passed = judged.filter((j) => j !== chosen && j.item.humanIndex < item.humanIndex);
  const notes = passed.map((j) => {
    const cause =
      j.blocks.length > 0
        ? j.blocks.map((b) => b.text).join('、')
        : j.item.nudges
            .filter((n) => n.kind !== 'fast-reset')
            .map((n) => n.text)
            .join('、') || '排到了后面';
    return `第 ${j.item.humanIndex + 1} 条 ${routeLabel(j.item.route)}：${cause}`;
  });
  if (notes.length > 0) {
    const shown = notes.slice(0, 2).join('；');
    parts.push(notes.length > 2 ? `${shown}；另有 ${notes.length - 2} 条也没派` : shown);
  }
  return parts.join('；');
}

/** 约 trialRatio 的任务派给非首选的可用路由；首选钉住时不试探（创始人钉住就是要用它）。样本不够的优先。 */
function pickTrial(
  input: ChooseRouteInput,
  ready: Judged[],
  policy: ReturnType<typeof resolveRoutingPolicy>,
): Judged | null {
  const [first, ...rest] = ready;
  if (!policy.trialEnabled || !first || first.item.pinned || rest.length === 0) return null;
  const draw = input.draw as number;
  if (draw >= policy.trialRatio) return null;
  const thin = rest.filter((j) => (j.item.route.record?.samples ?? 0) < policy.minSamples);
  const pool = thin.length > 0 ? thin : rest;
  // draw < ratio 时 draw / ratio 在 [0, 1) 里均匀：同一个数既决定试不试、又决定试哪条。
  return pool[Math.min(pool.length - 1, Math.floor((draw / policy.trialRatio) * pool.length))] ?? null;
}

/**
 * 这个阶段现在是不是全熔断。和 chooseRoute 走出 trial 'all-open' 同一段（judgeStage + allOpenTrial），
 * 不看任务指定的路由、不用试探的随机数：给对账撤提醒用，判一次不能顺手再报一次。
 * 阶段没配顺序、一条都没配：不是全熔断（那是别的提醒管的）。
 */
export function stageAllOpen(input: ChooseRouteInput): AllOpenCheck {
  const policy = resolveRoutingPolicy(input.policy);
  const now = validateInput(input, policy.trialEnabled);
  const stageName = STAGE_NAMES[input.stage];
  if (!input.configured) {
    return { allOpen: false, detail: `${stageName}阶段还没在调度台上排路由顺序` };
  }
  if (input.order.length === 0) {
    return { allOpen: false, detail: `${stageName}阶段一条路由都没配` };
  }
  const judged = judgeStage(input, contextOf(input, policy, now));
  const ready = judged.filter((j) => j.group.kind === 'ready');
  // 有能派的就先派它，走不到全熔断那一支：这里和 chooseRoute 一样，ready 优先。
  if (ready.length === 0 && allOpenTrial(judged)) return { allOpen: true };
  const first = ready[0];
  if (first) {
    return {
      allOpen: false,
      detail: `第 ${first.item.humanIndex + 1} 条 ${routeLabel(first.item.route)} 不在熔断`,
    };
  }
  const summary = judged
    .map(
      (j) =>
        `第 ${j.item.humanIndex + 1} 条 ${routeLabel(j.item.route)}：${j.blocks.map((b) => b.text).join('、') || '没有被挡'}`,
    )
    .join('；');
  return { allOpen: false, detail: `不再是只被熔断挡着（${summary}）` };
}

/**
 * 候选全都熔断（至少两条、除熔断外没别的挡）：多半是共用的一层坏了，不剔空候选（那是零吞吐），
 * 放最早到点的一条去试探并报警（和 failure/breaker.ts 的 whenAllOpen 同一个判法）。有路由只差空位或额度时不走这条。
 */
function allOpenTrial(judged: Judged[]): Judged | null {
  const live = judged.filter((j) => j.group.kind !== 'hard');
  if (live.length < 2) return null;
  const onlyBreaker = live.every(
    (j) => j.item.route.breaker.state === 'open' && j.blocks.every((b) => b.code === 'breaker-open'),
  );
  if (!onlyBreaker) return null;
  const probe = (j: Judged) =>
    j.item.route.breaker.probeAt === undefined
      ? Number.POSITIVE_INFINITY
      : time(j.item.route.breaker.probeAt, '');
  return live.reduce((a, b) => (probe(b) < probe(a) ? b : a));
}

function waitOrNone(stageName: string, judged: Judged[], verdicts: RouteVerdict[]): ChooseRouteResult {
  const waiting = judged.filter((j) => j.group.kind === 'wait');
  const summary = judged
    .map(
      (j) =>
        `第 ${j.item.humanIndex + 1} 条 ${routeLabel(j.item.route)}：${j.blocks.map((b) => b.text).join('、')}`,
    )
    .join('；');
  if (waiting.length === 0) {
    return { kind: 'none', reason: `${stageName}阶段没有能派的路由（${summary}）`, verdicts };
  }
  const soonest = earliestWait(waiting.map((j) => j.group).filter(isWait));
  return {
    kind: 'wait',
    waitFor: soonest.waitFor,
    until: soonest.until === null ? null : new Date(soonest.until).toISOString(),
    reason: `${stageName}阶段暂时派不了，${waitText(soonest)}（${summary}）`,
    verdicts,
  };
}

type Wait = Extract<BlockGroup, { kind: 'wait' }>;

function isWait(g: BlockGroup): g is Wait {
  return g.kind === 'wait';
}

/**
 * 几条路由各等各的：最早能派 = 最早好的那条。有一条时刻不知道（只差空位、等试探结果、清零时刻不知道），
 * 它随时可能好，就不给时刻、按轮询间隔再选一次——不能拿别的路由几天后的清零时刻去睡，把它错过。
 * 时刻不知道时，有只差空位的就说在等空位（多半最快），否则说第一条时刻不知道的在等什么。
 */
function earliestWait(waits: Wait[]): Wait {
  const unknown = waits.filter((w) => w.until === null);
  if (unknown.length > 0) return unknown.find((w) => w.waitFor === 'slot') ?? (unknown[0] as Wait);
  return waits.reduce((a, b) => ((b.until as number) < (a.until as number) ? b : a));
}

function waitText(w: Wait): string {
  if (w.waitFor === 'slot') return '在等并发空位';
  if (w.until === null) {
    return w.waitFor === 'breaker' ? '在等熔断的试探结果' : '在等额度清零，清零时刻不知道，按轮询间隔再看';
  }
  return w.waitFor === 'breaker'
    ? `最早 ${stamp(w.until)} 熔断到点、放试探`
    : `最早 ${stamp(w.until)} 额度清零、够跑一个活`;
}

/** 任务指定了路由：只看它；硬挡报「指定的路由用不了」，等得来就等，绝不偷偷换。 */
function chooseTaskRoute(input: ChooseRouteInput, route: RouteFacts, ctx: FilterContext): ChooseRouteResult {
  const entry: StageRouteEntry | undefined = input.order.find((e) => e.routeId === route.routeId);
  const blocks = blocksFor(route, entry, ctx);
  const group = groupOf(blocks);
  const label = routeLabel(route);
  const verdict: RouteVerdict = {
    routeId: route.routeId,
    label,
    humanRank: null,
    rank: 1,
    pinned: true,
    blocks,
    nudges: [],
  };
  const texts = blocks.map((b) => b.text).join('、');
  if (group.kind === 'hard') {
    return { kind: 'none', reason: `指定的路由用不了：${label}：${texts}`, verdicts: [verdict] };
  }
  if (group.kind === 'wait') {
    const until = group.until === null ? null : new Date(group.until).toISOString();
    return {
      kind: 'wait',
      waitFor: group.waitFor,
      until,
      reason: `指定的路由 ${label} 暂时派不了，等它（不换路由）：${texts}${until === null ? '' : `，最早 ${stamp(group.until as number)}`}`,
      verdicts: [verdict],
    };
  }
  const breakerTrial = route.breaker.admit === 'trial';
  const trial: TrialKind | null = breakerTrial ? 'breaker' : null;
  const why = withNotes(`任务指定的路由：${label}`, quotaNote(route), breakerTrial ? BREAKER_TRIAL : null);
  return dispatch(route, why, trial, null, [verdict], ctx.now);
}

const BREAKER_TRIAL = '熔断半开，这一单当试探';

/**
 * 派出去的这条额度未知时，理由里写明（design §九 选路第 3 条）。每条派出去的路径都经这里，试探、全熔断的也不例外。
 */
function quotaNote(route: RouteFacts): string | null {
  return route.quota === 'unknown' ? '额度未知（没读成或读数过期）' : null;
}

function withNotes(head: string, ...notes: (string | null)[]): string {
  return [head, ...notes.filter((n): n is string => n !== null)].join('；');
}
