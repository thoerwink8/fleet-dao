// 选路（设计 §九「选路」五条 + §十二「一条路由报繁忙，所有任务一起避开」由熔断判定带进来）。
// 纯函数、确定性：同样输入同样输出；不取时钟、不随机——现在几点、试探用的随机数都由调用方给，引擎记进历史。
// 模型之间严格按用途顺序：往后挑只因额度用完（含留量线）、人关了或钉住别的、报错（探测不通、熔断）；
// 不因为作者族、不因为本单之前用过哪一家而改顺序（冷验收验不了由冷验收自己兜，见 verifier-invoke.ts 的两家都验）。
// 唯一的例外是动手按模型战绩排（rank.ts 的 modelOrder，PLAN 3f，决定 0093、0095、0098）：按档排时用收缩后的质量下界，
// 分钟只打平手，不再把一轮做成率差的挪到最后。byTier 关掉时仍是旧规则：一轮做成率明显差的模型不进动手，
// 但别的模型都派不了、又不只是在等空位时照样派它——打分绝不能把唯一能用的排没。

import { allocateWeights, weightedPick, weightText } from './allocate.ts';
import { blocksFor, type FilterContext, familyKey } from './filter.ts';
import { applyFloor, floorOf } from './floor.ts';
import { type BlockGroup, groupOf } from './group.ts';
import { routeLabel, STAGE_NAMES, stamp } from './names.ts';
import { resolveRoutingPolicy } from './policy.ts';
import {
  type ModelScore,
  type Ranked,
  rank,
  type StrengthOptions,
  scoreOf,
  seedDraw,
  tierScores,
} from './rank.ts';
import { shareRedirect } from './share.ts';
import type {
  AllOpenCheck,
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
    },
    liveOrg: input.liveOrg,
    liveOrgProblem: input.liveOrgProblem,
    orgPlan: input.orgPlan,
    quotaReserve: input.quotaReserve,
    carpoolRegistry: input.carpoolRegistry,
    uiWork: input.uiWork ?? false,
  };
}

/** 排序 → 每条算被挡原因 → 分组。chooseRoute 和 stageAllOpen 共用这一段，熔断算不算挡着才不会两套。 */
function judgeStage(
  input: ChooseRouteInput,
  ctx: FilterContext,
): { judged: Judged[]; floorNote: string | null; scores: Map<string, ModelScore> | undefined } {
  const factsOf = new Map(input.routes.map((r) => [r.routeId, r]));
  const rows = [...input.order]
    .sort((a, b) => a.position - b.position)
    .map((entry) => ({ route: factsOf.get(entry.routeId) as RouteFacts, entry }));
  // 挡因先算（只看路由自己和这一单，不看排序）：强档让不让位只看没被硬挡的渠道（#2724：人关掉的路由持平不能拦住让位）
  const blocksOf = new Map(rows.map(({ route, entry }) => [route.routeId, blocksFor(route, entry, ctx)]));
  const floorNote = floorStage(input, ctx, rows, blocksOf);
  const hardBlocked = new Set(
    [...blocksOf].flatMap(([id, blocks]) => (groupOf(blocks).kind === 'hard' ? [id] : [])),
  );
  const scores = scoresOf(input, ctx);
  const ranked = rank(
    rows,
    input.stagePinned,
    ctx.policy,
    ctx.now,
    scores,
    STAGE_NAMES[input.stage],
    strengthOf(input, ctx, scores, hardBlocked),
  );
  const judged = ranked.map((item) => {
    const blocks = blocksOf.get(item.route.routeId) ?? [];
    return { item, blocks, group: groupOf(blocks) };
  });
  return { judged, floorNote, scores };
}

/**
 * 能力下限（#2725，floor.ts）：排序之前把够不上的路由加一条硬挡，写明为什么没派它；降了档回那一句（写进派工理由）。
 * 人的指令不驳：整段钉住、钉住的行、人给这张单指定了模型（floorWaived）都不挡。
 * 判「够格的是不是全被挡」时不算「这一问只派别家」的换族挡因：冷验收按族一家家问，别家够格的问到它那一族时照样能派，
 * 不能因为这一问避开了别家就提前降档。
 */
function floorStage(
  input: ChooseRouteInput,
  ctx: FilterContext,
  rows: readonly { route: RouteFacts; entry: StageRouteEntry }[],
  blocksOf: Map<string, Block[]>,
): string | null {
  const floor = floorOf(input.stage, input.tier);
  if (!floor || !input.tier || input.stagePinned || input.floorWaived) return null;
  const otherFamilies = ctx.avoid.families.size > 0;
  const loose: FilterContext = otherFamilies
    ? { ...ctx, avoid: { ...ctx.avoid, families: new Set<string>() } }
    : ctx;
  const candidates = rows.filter(({ entry }) => !entry.pinned);
  const decision = applyFloor(
    candidates.map(({ route, entry }) => ({
      route,
      blocks: blocksOf.get(route.routeId) ?? [],
      ...(otherFamilies ? { judgeBlocks: blocksFor(route, entry, loose) } : {}),
    })),
    input.stage,
    input.tier,
    floor,
    ctx.now,
  );
  for (const [id, block] of decision.below) blocksOf.get(id)?.push(block);
  return decision.lowered;
}

/**
 * 这个用途按动手战绩排、又拿到了战绩：每个模型的分。否则为空（模型之间照人排的）。
 * 按档排只看这一档的行；这一档是空的也不退回整单战绩。byTier 关掉时忽略分档战绩，仍用整单。
 */
function scoresOf(input: ChooseRouteInput, ctx: FilterContext): Map<string, ModelScore> | undefined {
  const ts = ctx.policy.trackScore;
  if (!ts.stages.includes(input.stage)) return undefined;
  if (ts.byTier && input.tier && input.modelTierTracks) {
    return tierScores(
      input.modelTierTracks.filter((t) => t.tier === input.tier),
      ctx.policy,
    );
  }
  if (!input.modelTracks) return undefined;
  return new Map(input.modelTracks.map((t) => [t.modelId, scoreOf(t, ctx.policy)]));
}

/**
 * 先给强档、探索（决定 0099）：只在动手（trackScore.stages）、给了派工档时。探索还要有单号做种子、读成了战绩
 * （不知道谁样本少就不探）。同档分流不经这里（rank 按 policy.strength.pool 做，任何用途都做）。
 */
function strengthOf(
  input: ChooseRouteInput,
  ctx: FilterContext,
  scores: ReadonlyMap<string, ModelScore> | undefined,
  hardBlocked: ReadonlySet<string>,
): StrengthOptions | undefined {
  const { trackScore: ts, strength: st } = ctx.policy;
  const tier = input.tier;
  if (!tier || !ts.stages.includes(input.stage)) return undefined;
  const seed = input.exploreSeed;
  const explore =
    seed && scores && st.explore[tier] > 0
      ? {
          draw: seedDraw(seed),
          ratio: st.explore[tier],
          samples: new Map([...scores].map(([m, s]) => [m, s.track.tasks])),
        }
      : null;
  return { tier, strongFirst: st.strongFirstTiers.includes(tier), explore, hardBlocked };
}

const isPoor = (j: Judged) => j.item.nudges.some((n) => n.kind === 'poor-one-round');

/**
 * 一轮做成率差的不进动手：别的模型有能派的、或只差空位（随时会好）时，把它从能派的里拿掉；
 * 别的都硬挡、或在等额度清零、切号这类等不来的，就还派它——唯一能用的不能被打分排没。
 */
function gatePoor(judged: Judged[], ready: Judged[]): Judged[] {
  if (!ready.some(isPoor)) return ready;
  const others = judged.filter((j) => !isPoor(j));
  const othersAlive = others.some(
    (j) => j.group.kind === 'ready' || (j.group.kind === 'wait' && j.group.waitFor === 'slot'),
  );
  return othersAlive ? ready.filter((j) => !isPoor(j)) : ready;
}

export function chooseRoute(input: ChooseRouteInput): ChooseRouteResult {
  const policy = resolveRoutingPolicy(input.policy);
  const now = validateInput(input, policy.trialEnabled);
  const ctx = contextOf(input, policy, now);
  return chooseIn(input, ctx);
}

/** 过滤、排序之后怎么选：任务指定的只看它；没配顺序、一条没配派不出；能派的派，全熔断放试探，其余等或派不出。 */
function chooseIn(input: ChooseRouteInput, ctx: FilterContext): ChooseRouteResult {
  const { policy } = ctx;
  const stageName = STAGE_NAMES[input.stage];
  const factsOf = new Map(input.routes.map((r) => [r.routeId, r]));
  const fact = (id: string) => factsOf.get(id) as RouteFacts;

  if (input.taskRouteId !== undefined) return chooseTaskRoute(input, fact(input.taskRouteId), ctx);

  if (!input.configured) {
    return {
      kind: 'none',
      reason: `${stageName}阶段没配模型：这个用途没有模型，派不了，不退到别的用途`,
      verdicts: [],
    };
  }
  if (input.order.length === 0) {
    return { kind: 'none', reason: `${stageName}阶段一条路由都没配`, verdicts: [] };
  }

  const { judged, floorNote, scores } = judgeStage(input, ctx);
  const verdicts = judged.map((j, i) => verdictOf(j, i));

  const ready = gatePoor(
    judged,
    judged.filter((j) => j.group.kind === 'ready'),
  );
  const first = ready[0];
  // 按池压力加权抽签（决定 0104）：能派的里按权重抽；人钉住的照人排（钉住就是人要它）。权重全是 0 才落回下面照人排的先后
  if (first && policy.allocate.mode === 'weighted' && !ready.some((j) => j.item.pinned)) {
    const picked = weightedChoice(input, ctx, ready, judged, scores, stageName);
    if (picked) {
      const shared = shareOf(input, picked.item, ready, judged, stageName);
      const item = shared?.item ?? picked.item;
      const route = item.route;
      const breakerTrial = route.breaker.admit === 'trial';
      return dispatch(
        route,
        withNotes(
          shared?.why ?? picked.why,
          quotaNote(route),
          breakerTrial ? BREAKER_TRIAL : null,
          floorNote,
        ),
        breakerTrial ? 'breaker' : null,
        null,
        verdicts,
      );
    }
  }
  if (first) {
    const explore = policy.allocate.mode === 'legacy' ? pickTrial(input, ready, policy) : null;
    const chosen = explore ?? first;
    // 试探要的就是非首选，不再按同一档改派。
    const shared = explore ? null : shareOf(input, chosen.item, ready, judged, stageName);
    if (shared) {
      const route = shared.item.route;
      const breakerTrial = route.breaker.admit === 'trial';
      return dispatch(
        route,
        withNotes(shared.why, quotaNote(route), breakerTrial ? BREAKER_TRIAL : null, floorNote),
        breakerTrial ? 'breaker' : null,
        null,
        verdicts,
      );
    }
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
    return dispatch(route, withNotes(why, floorNote), trial, null, verdicts);
  }

  const allOpen = allOpenTrial(judged);
  if (allOpen) {
    const why = withNotes(
      `${stageName}阶段的候选路由全都熔断，多半是共用的一层坏了（本机网络、中转服务）：放最早到点的 ${routeLabel(allOpen.item.route)} 去试探`,
      quotaNote(allOpen.item.route),
    );
    return dispatch(allOpen.item.route, why, 'all-open', why, verdicts);
  }

  return waitOrNone(stageName, judged, verdicts);
}

/**
 * 按池压力加权抽一条（决定 0104，allocate.ts）。抽签的数：给了 allocateSeed（单号:段:第几次选）用 seedDraw 算，同一单同一段
 * 重算不变；没给用工作流给的 draw；都没有就取权重最大的。权重全是 0 回 null（调用方照人排的先后，理由写明）。
 */
function weightedChoice(
  input: ChooseRouteInput,
  ctx: FilterContext,
  ready: Judged[],
  judged: Judged[],
  scores: ReadonlyMap<string, ModelScore> | undefined,
  stageName: string,
): { item: Ranked; why: string } | null {
  const al = ctx.policy.allocate;
  const weights = allocateWeights(
    ready.map((j) => j.item.route),
    scores,
    input.tier,
    al,
    ctx.now,
  );
  const seed = input.allocateSeed;
  const u = seed !== undefined ? seedDraw(seed) : input.draw;
  let idx: number | null;
  if (u === undefined) {
    const max = Math.max(...weights.map((w) => w.weight));
    idx = max > 0 ? weights.findIndex((w) => w.weight === max) : null;
  } else {
    idx = weightedPick(weights, u);
  }
  if (idx === null) return null;
  const chosen = ready[idx] as Judged;
  const positive = weights.filter((w) => w.weight > 0);
  const top = positive[0]?.weight ?? 0;
  const tied = positive.every((w) => Math.abs(w.weight - top) <= 1e-12 * Math.max(1, top));
  const how =
    positive.length === 1
      ? '只有它权重不是 0'
      : tied
        ? '权重平手，照人排的先后'
        : u === undefined
          ? '没有抽签的数，取权重最大的'
          : `抽到 ${u.toFixed(3)}${seed !== undefined ? `（种子 ${seed}）` : ''}`;
  const list = weights
    .map((w, i) => weightText(routeLabel((ready[i] as Judged).item.route), w, al))
    .join('；');
  // 人排在它前面、这次没派的：各自为什么（被挡写挡因，能派的写抽签没抽到和它的权重，被闸掉的写闸的话）
  const notes = judged
    .filter((j) => j !== chosen && j.item.humanIndex < chosen.item.humanIndex)
    .map((j) => {
      const at = ready.indexOf(j);
      const cause =
        j.blocks.length > 0
          ? j.blocks.map((b) => b.text).join('、')
          : at >= 0 && !tied
            ? `抽签没抽到（权重 ${(weights[at]?.weight ?? 0).toFixed(2)}${weights[at]?.excluded ? `，${weights[at]?.excluded}` : ''}）`
            : j.item.nudges
                .filter((n) => n.kind !== 'fast-reset' && n.kind !== 'pace-behind')
                .map((n) => n.text)
                .join('、') || (at >= 0 ? '权重平手，照先后排在后面' : '排到了后面');
      return `第 ${j.item.humanIndex + 1} 条 ${routeLabel(j.item.route)}：${cause}`;
    });
  const passed =
    notes.length === 0
      ? null
      : notes.length > 2
        ? `${notes.slice(0, 2).join('；')}；另有 ${notes.length - 2} 条也没派`
        : notes.join('；');
  return {
    item: chosen.item,
    why: withNotes(
      `${stageName}阶段第 ${chosen.item.humanIndex + 1} 条：${routeLabel(chosen.item.route)}；按池压力加权抽签（${how}）`,
      `候选权重 = q × min(ρ, ${al.rhoCap})²：${list}`,
      passed,
    ),
  };
}

/** 同一档用的抽签数和加权抽签同一套：有种子用种子，否则用调用方给的 draw，都没有就取权重最大的。 */
function shareOf(
  input: ChooseRouteInput,
  chosen: Ranked,
  ready: Judged[],
  judged: Judged[],
  stageName: string,
): { item: Ranked; why: string } | null {
  const seed = input.allocateSeed;
  if (seed !== undefined) {
    const u = seedDraw(seed);
    return shareRedirect(chosen, ready, judged, u, stageName, `抽到 ${u.toFixed(3)}（种子 ${seed}）`);
  }
  if (input.draw !== undefined) {
    return shareRedirect(chosen, ready, judged, input.draw, stageName, `抽到 ${input.draw.toFixed(3)}`);
  }
  return shareRedirect(chosen, ready, judged, undefined, stageName, '没有抽签的数，取权重最大的');
}

/** 每条派出去的路径都经这里。理由不必再补「探针结论过期」那句（#1798 片 4）：派前 15 分钟探一次保证了结论新。 */
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
    const fast = item.nudges.find((n) => n.kind === 'fast-reset' || n.kind === 'pace-behind');
    if (fast && item.humanIndex > at)
      parts.push(fast.text.replace(/往前提$/, at === 0 ? '提到最前' : `提到第 ${at + 1}`));
  }
  const note = quotaNote(item.route);
  if (note) parts.push(note);
  // 因强弱档、探索、同档分流挪了位（决定 0099）：各写一句
  for (const n of item.nudges) {
    if (n.kind === 'explore' || n.kind === 'strength-first' || n.kind === 'strength-pool') parts.push(n.text);
  }
  const track = item.nudges.find((n) => n.kind === 'track-score' || n.kind === 'poor-one-round');
  if (track)
    parts.push(track.kind === 'poor-one-round' ? `${track.text}；别的都派不了，这次兜底派它` : track.text);
  // 人排在它前面、这次没派的：各自为什么（被挡，或被微调挪到了后面）。
  const passed = judged.filter((j) => j !== chosen && j.item.humanIndex < item.humanIndex);
  const notes = passed.map((j) => {
    const cause =
      j.blocks.length > 0
        ? j.blocks.map((b) => b.text).join('、')
        : j.item.nudges
            .filter((n) => n.kind !== 'fast-reset' && n.kind !== 'pace-behind')
            .map((n) => n.text)
            .join('、') || '排到了后面';
    return `第 ${j.item.humanIndex + 1} 条 ${routeLabel(j.item.route)}：${cause}`;
  });
  if (notes.length > 0) {
    const shown = notes.slice(0, 2).join('；');
    parts.push(notes.length > 2 ? `${shown}；另有 ${notes.length - 2} 条也没派` : shown);
  }
  // 强档让位的模型人排在它后面时上面那段数不到：单写一句，每个模型一句
  const yields = new Set(
    judged
      .filter((j) => j !== chosen && !passed.includes(j))
      .flatMap((j) =>
        j.item.nudges
          .filter((n) => n.kind === 'strength-yield')
          .map((n) => `${j.item.route.modelId}：${n.text}`),
      ),
  );
  parts.push(...yields);
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
    return { allOpen: false, detail: `${stageName}阶段没配模型：这个用途没有模型，派不了，不退到别的用途` };
  }
  if (input.order.length === 0) {
    return { allOpen: false, detail: `${stageName}阶段一条路由都没配` };
  }
  const { judged } = judgeStage(input, contextOf(input, policy, now));
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
  const cause = (j: Judged) =>
    j.blocks.map((b) => b.text).join('、') ||
    j.item.nudges.find((n) => n.kind === 'poor-one-round')?.text ||
    '没有被挡';
  const summary = judged
    .map((j) => `第 ${j.item.humanIndex + 1} 条 ${routeLabel(j.item.route)}：${cause(j)}`)
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
    switch (w.waitFor) {
      case 'breaker':
        return '在等熔断的试探结果';
      case 'org':
        return '在等引擎切号（下一轮路由探针切），按轮询间隔再看';
      case 'probe':
        return '在等路由探针在现在挂着的组织下探一次，按轮询间隔再看';
      default:
        return '在等额度清零，清零时刻不知道，按轮询间隔再看';
    }
  }
  switch (w.waitFor) {
    case 'breaker':
      return `最早 ${stamp(w.until)} 熔断到点、放试探`;
    case 'org':
      return `最早 ${stamp(w.until)} 以后引擎切号`;
    case 'probe':
      return `最早 ${stamp(w.until)} 路由探针在现在挂着的组织下探一次`;
    default:
      return `最早 ${stamp(w.until)} 额度清零、够跑一个活`;
  }
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
  return dispatch(route, why, trial, null, [verdict]);
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
