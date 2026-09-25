// 选路（设计 §九「选路」五条 + §十二「一条路由报繁忙，所有任务一起避开」由熔断判定带进来）。
// 纯函数、确定性：同样输入同样输出；不取时钟、不随机——现在几点、试探用的随机数都由调用方给，引擎记进历史。

import { blocksFor, type FilterContext } from './filter.ts';
import { type BlockGroup, groupOf } from './group.ts';
import { routeLabel, STAGE_NAMES, stamp } from './names.ts';
import { resolveRoutingPolicy } from './policy.ts';
import { type Ranked, rank } from './rank.ts';
import type {
  Block,
  ChooseRouteInput,
  ChooseRouteResult,
  RouteFacts,
  RouteVerdict,
  StageRouteEntry,
  TrialKind,
} from './types.ts';
import { time, validateInput } from './validate.ts';

interface Judged {
  item: Ranked;
  blocks: Block[];
  group: BlockGroup;
}

export function chooseRoute(input: ChooseRouteInput): ChooseRouteResult {
  const policy = resolveRoutingPolicy(input.policy);
  const now = validateInput(input, policy.trialEnabled);
  const stageName = STAGE_NAMES[input.stage];
  const ctx: FilterContext = {
    stage: input.stage,
    weight: input.weight ?? policy.stageWeight[input.stage],
    policy,
    now,
    avoid: {
      routeIds: new Set(input.avoid?.routeIds ?? []),
      poolIds: new Set(input.avoid?.poolIds ?? []),
      modelIds: new Set(input.avoid?.modelIds ?? []),
    },
  };
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

  const rows = [...input.order]
    .sort((a, b) => a.position - b.position)
    .map((entry) => ({ route: fact(entry.routeId), entry }));
  const ranked = rank(rows, input.stagePinned, policy, now);
  const judged: Judged[] = ranked.map((item) => {
    const blocks = blocksFor(item.route, item.entry, ctx);
    return { item, blocks, group: groupOf(blocks) };
  });
  const verdicts = judged.map((j, i) => verdictOf(j, i));

  const ready = judged.filter((j) => j.group.kind === 'ready');
  const first = ready[0];
  if (first) {
    const explore = pickTrial(input, ready, policy);
    const chosen = explore ?? first;
    const breakerTrial = chosen.item.route.breaker.admit === 'trial';
    const trial: TrialKind | null = explore ? 'explore' : breakerTrial ? 'breaker' : null;
    let why = explore
      ? `试探：${stageName}阶段第 ${explore.item.humanIndex + 1} 条 ${routeLabel(explore.item.route)}（首选是 ${routeLabel(first.item.route)}；约 ${Math.round(policy.trialRatio * 100)}% 的任务派给非首选，攒战绩）`
      : whyFirst(stageName, chosen, judged);
    if (breakerTrial) why += '；熔断半开，这一单当试探';
    return dispatch(chosen.item.route, why, trial, null, verdicts);
  }

  const allOpen = allOpenTrial(judged);
  if (allOpen) {
    const why = `${stageName}阶段的候选路由全都熔断，多半是共用的一层坏了（本机网络、中转服务）：放最早到点的 ${routeLabel(allOpen.item.route)} 去试探`;
    return dispatch(allOpen.item.route, why, 'all-open', why, verdicts);
  }

  return waitOrNone(stageName, judged, verdicts);
}

function dispatch(
  route: RouteFacts,
  why: string,
  trial: TrialKind | null,
  alarm: string | null,
  verdicts: RouteVerdict[],
): ChooseRouteResult {
  return {
    kind: 'dispatch',
    routeId: route.routeId,
    poolId: route.poolId,
    modelId: route.modelId,
    family: route.family,
    hostId: route.hostId,
    why,
    trial,
    alarm,
    verdicts,
  };
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
  const unknown = item.nudges.find((n) => n.kind === 'quota-unknown');
  if (unknown || (item.pinned && item.route.quota === 'unknown')) parts.push('额度未知（没读成或读数过期）');
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
  const order = ['slot', 'breaker', 'quota'] as const;
  const waitFor =
    order.find((k) => waiting.some((j) => j.group.kind === 'wait' && j.group.waitFor === k)) ?? 'quota';
  const those = waiting.filter((j) => j.group.kind === 'wait' && j.group.waitFor === waitFor);
  const untils = those
    .map((j) => (j.group.kind === 'wait' ? j.group.until : null))
    .filter((t): t is number => t !== null);
  const until = untils.length > 0 ? Math.min(...untils) : null;
  const head = {
    slot: `${stageName}阶段能用的路由都在等并发空位`,
    breaker: `${stageName}阶段能用的路由都在熔断冷却`,
    quota: `${stageName}阶段能用的路由都在等额度清零`,
  }[waitFor];
  const when =
    until === null
      ? waitFor === 'slot'
        ? ''
        : '，最早几点能派不知道'
      : `，最早 ${stamp(until)}${those.length > untils.length ? `（另有 ${those.length - untils.length} 条时刻不知道）` : ''}`;
  return {
    kind: 'wait',
    waitFor,
    until: until === null ? null : new Date(until).toISOString(),
    reason: `${head}${when}（${summary}）`,
    verdicts,
  };
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
  const why = `任务指定的路由：${label}${breakerTrial ? '；熔断半开，这一单当试探' : ''}`;
  return dispatch(route, why, breakerTrial ? 'breaker' : null, null, [verdict]);
}
