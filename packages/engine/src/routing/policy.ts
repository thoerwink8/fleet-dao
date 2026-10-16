// 选路的参数与能力表。全是起步值：驾驶舱「战绩」「额度」攒够真实数据后再调，每个数的理由写在旁边。
// 给了但不对的直接报错，不悄悄换成默认值。
import { type HostId, type QuotaWindowKind, type StageKind, TRACK_PRIOR_TASKS } from '@fleet-dao/shared';
import { type RouteTier, RoutingInputError } from './types.ts';

/** 执行方式能做的事。answer = 只答题；read = 读仓库；edit = 改文件；shell = 跑命令和测试。 */
export type Ability = 'answer' | 'read' | 'edit' | 'shell';

/**
 * 执行方式 × 能力。命令行写码助手（含经 Mirasim 程序接口起的）四样都会。
 * 接口外壳（api-shell）的写码外壳还没做出来，眼下只接判断题；做好了把这一行改成四样。
 */
export const HOST_ABILITIES: Readonly<Record<HostId, readonly Ability[]>> = {
  'claude-code': ['answer', 'read', 'edit', 'shell'],
  codex: ['answer', 'read', 'edit', 'shell'],
  'cursor-agent': ['answer', 'read', 'edit', 'shell'],
  grok: ['answer', 'read', 'edit', 'shell'],
  mirasim: ['answer', 'read', 'edit', 'shell'],
  'api-shell': ['answer'],
};

/**
 * 阶段 × 要的能力。写码、UI 要改文件并跑测试；写需求文档、方案要读仓库并写进 specs/；
 * 审查、开 PR 前验证要读代码、能跑测试（只写结论文件）；调研要读；分诊和判断题只答题（接口外壳或命令行都行）。
 */
export const STAGE_NEEDS: Readonly<Record<StageKind, readonly Ability[]>> = {
  triage: ['answer'],
  judge: ['answer'],
  spec: ['read', 'edit'],
  plan: ['read', 'edit'],
  execute: ['read', 'edit', 'shell'],
  ui: ['read', 'edit', 'shell'],
  review: ['read', 'shell'],
  verify: ['read', 'shell'],
  research: ['read'],
  // 临时指挥官整理待办：读仓库（只读检出）、读单子，产出结构化清单；不改文件
  groom: ['read', 'shell'],
  // 驾驶舱「提需求」的指挥官会话（#2061）：读主线的只读检出、跑只读命令，交回回话和草稿补丁；不改文件
  'intake-chat': ['read', 'shell'],
};

export const ABILITY_NAMES: Readonly<Record<Ability, string>> = {
  answer: '答题',
  read: '读仓库',
  edit: '改文件',
  shell: '跑命令和测试',
};

export interface FastReset {
  /** 离清零不超过这么多小时算「快清零」。 */
  withinHours: number;
  /** 还剩不少于这个比例算「还剩很多」。 */
  minRemaining: number;
}

/**
 * 按消耗进度排同一模型的几个渠道（#2363，参考广告预算「按进度花」）：每个窗口算落后量 = 已过比例 − 已用比例（shared 的 quotaPace）。
 */
export interface PacePolicy {
  /** 总开关。关掉就回到「快清零往前提」（fastReset）的老排法。 */
  enabled: boolean;
  /**
   * 落后不少于这个数往前提（剩的反正要作废，越早清零越前），超前不少于这个数往后放（照这个速度清零前就会用完）。
   * 0.1：创始人给的线；差得不多照人排的，免得读数一抖顺序就翻。
   */
  margin: number;
}

export interface RoutingPolicy {
  /** 按消耗进度排（开着时代替 fastReset）。5 小时窗不参与排序（它几小时就轮一次），只挡：见 othersMinRemaining。 */
  pace: PacePolicy;
  /**
   * 快清零提前（pace 关着时才用）：只看这些窗口。周窗、按月 / 按账期的窗口清零时没用完的就作废，所以要赶在清零前用掉。
   * 不看 5 小时窗：它几小时就轮一次，真正卡人的是周窗；拿 5 小时窗提前会让顺序每小时抖一次，还会替周窗多烧额度。
   * 周窗 24 小时 / 剩 30%：24 小时是创始人举的例子；剩 30% 以上才值得插队，少于这个数的快清零池本来就会被自然用完。
   * 月窗 / 账期 48 小时 / 剩 20%：账期长，剩两成就是不小的一笔钱。
   */
  fastReset: Partial<Record<QuotaWindowKind, FastReset>>;
  /**
   * 快清零提前（按进度落后往前提同样）还要求：这条路由的其余适用窗口都还剩不少于这个比例、而且都读成了。
   * 这是「不会把快用满的池顶到最前」的保证：周窗快清零、但 5 小时窗已经用了九成的池不提前（派过去也跑不完）。
   */
  othersMinRemaining: number;
  /** 战绩样本少于这个数不动（旧系统保底线同样是 10）。 */
  minSamples: number;
  /** 样本够、成功率低于这个数算「明显差」，往后放（旧系统保底线 0.5，只后置不淘汰）。 */
  poorSuccessRate: number;
  /** 试探开关；构建期关着（全用 Opus 5.5）。 */
  trialEnabled: boolean;
  /** 开着时约这么多比例的任务派给非首选的可用路由。 */
  trialRatio: number;
  /**
   * 额度够收尾（design §九 选路第 1 条，所有路由都判）：适用的窗口剩余少于这个比例就不派，等它清零。没列的种类按 other 算。
   * 起步值按拼车号的轻活估：一个活大约占 5 小时窗的一成、周窗的百分之三（估的，没有量过）。独享号的窗口大得多
   * （design §十：拼车一窗约 3400 万输入当量，独享至少 2.8 亿），这张表对它偏保守，宁可早一点停下等清零，
   * 也不派一个跑不完的活；它的 5 小时窗在 12 个会话下撑了 3 小时 20 分还没满，6 个并发下多半撑不到只剩一成就清零了。
   * 攒够会话用量后换成「该阶段在该池上的 p80 用量」。
   */
  needPerTask: Partial<Record<QuotaWindowKind, number>>;
  /** 动手按模型战绩排（PLAN 3f，决定 0093），见 TrackScorePolicy。 */
  trackScore: TrackScorePolicy;
  /** 按模型强弱档排（决定 0099），见 StrengthPolicy。 */
  strength: StrengthPolicy;
  /** 怎么在能派的候选里挑一条（决定 0104），见 AllocatePolicy。 */
  allocate: AllocatePolicy;
}

/**
 * 怎么在能派的候选里挑一条（决定 0104，#2757）：
 * - weighted：能力下限（floor.ts，硬过滤）之后，按池压力加权抽签，质量作乘数。权重 = q × min(ρ, rhoCap)²：
 *   ρ 是这条路由的池压力（剩余比例 ÷ 剩余时间比例，取 5 小时窗以外最紧的那个窗口，读不到按 neutralRho），
 *   q 是动手按这一档的质量下界（不低于 minQuality；没打分的按候选里打了分的平均，都没打分为 1）。
 *   用 seedDraw(单号:段:第几次选) 抽，同一单同一段重算结果不变；权重都一样（平手）时照人排的先后。
 *   中档单不进 ρ < 1 的强档池（强档自己都快用完了，留给主力档）。
 * - legacy：照决定 0095、0098、0099 那一套排好以后取第一条能派的（快清零、按进度、战绩、先给强档、让位、探索、同档分流）。
 */
export interface AllocatePolicy {
  mode: 'weighted' | 'legacy';
  /** ρ 封顶：4。ρ 再大（快清零还剩一大截）也只算 4，免得一个快作废的池把别的全挤没。 */
  rhoCap: number;
  /** 读不到读数（额度未知、只有 5 小时窗、读数过期）的池按这个 ρ 算：1 = 中性，不排到最后，也不顶到最前。 */
  neutralRho: number;
  /** 质量下界的下限：收缩下界可以是 0 甚至负数，乘数不能把一条能派的路由乘没。 */
  minQuality: number;
}

/**
 * 按模型的强弱档（目录的 strength：strong / standard / light）排，决定 0099。三条：
 * 1. 重活先给强档：这一单的派工档在 strongFirstTiers 里、用途在 trackScore.stages 里时，强档的模型整体提到别的档前面，
 *    档内仍按战绩和人排的先后。强档某个模型没被硬挡的池都超前时间进度不少于 yieldAhead，这个模型让位：只让给不超前的强档，
 *    强档都超前时照派强档、不让给别的档（#2724）。
 * 2. 探索：同样只在动手、给了派工档时，按单的编号算出的数小于 explore[档] 就把样本少于 trackScore.minTasks 的强档模型提到第一。
 * 3. 同档分流：任何用途里，强弱档相同、排在相邻位置的几个模型合成一组，组内所有渠道按池子消耗进度排（和同一模型的
 *    几个渠道之间同一套微调），不同档之间、没标档的照旧按模型先后。
 * 被挡的照旧被挡：强档全被挡（没额度、熔断、钉住别的）时 choose.ts 往下派，这里只排先后。
 */
export interface StrengthPolicy {
  /**
   * 哪几个派工档先给强档。只放 heavyweight：近 14 天主力档 144 单里 127 单给了 grok-4.7，一段过 19%、平均 3.3 轮、
   * 每单约 1650 万 token；中档 grok 一段过 54%、快档 71%，够用，不为它们多烧强档的额度。
   */
  strongFirstTiers: RouteTier[];
  /**
   * 强档的模型，它每条读成了额度的渠道都有一个窗口超前时间进度不少于这个数（shared 的 quotaPace，同 pace 那一套，5 小时窗不算），
   * 这个模型就让位。0.3：比 pace.margin（0.1）宽得多，只在照这个速度清零前一定用完时才让，免得强档稍快一点就换。硬挡着的渠道不算（choose.ts 先算挡因交给 rank）。
   */
  yieldAhead: number;
  /**
   * 探索的比例（按派工档）：按单的编号算出的 [0, 1) 里的数小于它，就把样本少的强档模型提到第一。
   * 主力档 0.2：强档在主力档上只有三四单样本，按 #2403 的收缩分永远挪不上来，要每五单探一单才攒得起来；
   * 中档 0.1、快档 0.05：这两档 grok 够用，只少量攒强档在这两档上的数。置 0 = 这一档不探。
   */
  explore: Record<RouteTier, number>;
  /** 同档分流的开关。关掉 = 模型之间仍按先后，只在同一个模型的几个渠道之间按进度排。 */
  pool: boolean;
}

/**
 * 动手按模型的真实战绩排（PLAN 3f，决定 0093、0095、0098）。战绩由引擎从库里现算，取数近 14 天。
 * byTier 开着且这一单带了档时用 db 的 modelTierTracks（只算第一段、按档）；否则用 modelExecuteTracks
 * （整单记在第一段的模型名下，决定 0095 第 2–4 条）。读不到就整段不做，退回人排的先后（选路理由里写明）。
 */
export interface TrackScorePolicy {
  /**
   * 哪些用途按它排。只放动手的两个用途：战绩是从动手段（runs.segment = manual）算的，拿去排冷验收、分诊等别的用途不对口；
   * 一轮做成率差的模型照样能做那些（订阅不闲置）。
   */
  stages: StageKind[];
  /** 样本（到了终态的单）少于这个数的模型不打分、不挡，留在人排的位置上。5：PLAN 3f 推演里定的线。 */
  minTasks: number;
  /**
   * 一轮做成率低于这个数的模型不进这些用途（别的模型都派不了、也不是只差空位时才兜底）。0.15 的理由：法国库 10-14 查的近 7 天，
   * 全部动手单一轮成约 24%（近 4 天 42 单成 10 单）、grok-4.7 约 51%、cursor-auto 约 17%、deepseek-flash 约 6%（16 单成 1 单）；
   * 线划在全体平均的六成左右，只拦一轮几乎做不成的，不误伤偏弱但还在干活的。
   */
  poorOneRoundRate: number;
  /**
   * 每多一轮动手，除了会话本身还要再走一遍冷验收、CI、排队的分钟数，算进每单期望成本。15：main 上 CI 中位 9.3 分钟，
   * 冷验收一段几分钟（_tmp/rethink/COMMON.md 已知事实）；不算它，段短轮多的模型（cursor-auto 一段 7 分钟、平均近 3 段）会被
   * 当成比一轮就成的更省。
   */
  roundOverheadMinutes: number;
  /**
   * 打了分的模型要比人排在它前面的模型的期望成本至少低这么多比例，才挪到它前面。0.3：样本只有几单时成本抖得厉害，
   * 差得不多就照人排的，免得一两单的运气把顺序翻来翻去（也免得把创始人排在后面的订阅大量拉进动手）。
   * 只在 byTier 关掉时用（决定 0095 第 2 条）。
   */
  promoteMargin: number;
  /**
   * 按这一单的派工档排（决定 0098）。开着、又给了档和分档战绩时，用收缩后的质量下界在人排的位置之间重排，
   * 分钟只在质量分打平手时才比。关掉就回到决定 0095 第 2–4 条（期望成本、样本线、一轮做成率闸），取数窗口仍是 14 天。
   */
  byTier: boolean;
  /** 收缩用的先验强度：往本档平均拉这么多单。4：小样本不会被自己的一两个结果拉飞，样本上来以后自己的数占大头。 */
  priorTasks: number;
  /**
   * 质量下界要比前一个高这么多才往前挪。0.08：差一截才换人排的先后，读数一抖不翻顺序。
   * 分相同（打平手）才比每段分钟，低的往前。
   */
  qualityMargin: number;
}

export const DEFAULT_ROUTING_POLICY: Readonly<RoutingPolicy> = Object.freeze<RoutingPolicy>({
  pace: { enabled: true, margin: 0.1 },
  fastReset: {
    '7d': { withinHours: 24, minRemaining: 0.3 },
    '7d_model': { withinHours: 24, minRemaining: 0.3 },
    month_usd: { withinHours: 48, minRemaining: 0.2 },
    period_usd: { withinHours: 48, minRemaining: 0.2 },
  },
  othersMinRemaining: 0.2,
  minSamples: 10,
  poorSuccessRate: 0.5,
  trialEnabled: false,
  trialRatio: 0.1,
  needPerTask: {
    '5h': 0.1,
    '7d': 0.03,
    '7d_model': 0.03,
    month_usd: 0.02,
    period_usd: 0.02,
    points: 0.05,
    other: 0.05,
  },
  trackScore: {
    stages: ['execute', 'ui'],
    minTasks: 5,
    poorOneRoundRate: 0.15,
    roundOverheadMinutes: 15,
    promoteMargin: 0.3,
    byTier: true,
    priorTasks: TRACK_PRIOR_TASKS,
    qualityMargin: 0.08,
  },
  strength: {
    strongFirstTiers: ['heavyweight'],
    yieldAhead: 0.3,
    explore: { heavyweight: 0.2, medium: 0.1, fast: 0.05 },
    pool: true,
  },
  allocate: { mode: 'weighted', rhoCap: 4, neutralRho: 1, minQuality: 0.05 },
});

const ROUTE_TIERS: readonly RouteTier[] = ['fast', 'medium', 'heavyweight'];

/** 缺的取默认值，给了但不对的报错。trackScore、pace、strength 可以只给要改的那几项。 */
export function resolveRoutingPolicy(partial?: RoutingPolicyInput): RoutingPolicy {
  // fastReset 整张换（换了就能去掉某种窗口）；needPerTask、pace、trackScore 按项合并，只改给了的那几项。
  const p: RoutingPolicy = {
    ...DEFAULT_ROUTING_POLICY,
    ...(partial ?? {}),
    pace: { ...DEFAULT_ROUTING_POLICY.pace, ...partial?.pace },
    needPerTask: { ...DEFAULT_ROUTING_POLICY.needPerTask, ...partial?.needPerTask },
    trackScore: { ...DEFAULT_ROUTING_POLICY.trackScore, ...partial?.trackScore },
    strength: {
      ...DEFAULT_ROUTING_POLICY.strength,
      ...partial?.strength,
      explore: { ...DEFAULT_ROUTING_POLICY.strength.explore, ...partial?.strength?.explore },
    },
    allocate: { ...DEFAULT_ROUTING_POLICY.allocate, ...partial?.allocate },
  };
  const bad = (key: string, want: string, got: unknown) =>
    new RoutingInputError(`选路策略的 ${key} 不对：要${want}，给的是 ${JSON.stringify(got)}`);
  const ratio = (key: string, v: unknown, { zeroOk = true } = {}) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v > 1 || (zeroOk ? v < 0 : v <= 0)) {
      throw bad(key, zeroOk ? ' 0 到 1 之间的数' : '大于 0、不超过 1 的数', v);
    }
  };
  if (typeof p.pace.enabled !== 'boolean') throw bad('pace.enabled', ' true 或 false', p.pace.enabled);
  ratio('pace.margin', p.pace.margin, { zeroOk: false });
  for (const [kind, f] of Object.entries(p.fastReset)) {
    if (f === undefined) continue;
    if (typeof f.withinHours !== 'number' || !Number.isFinite(f.withinHours) || f.withinHours <= 0) {
      throw bad(`fastReset.${kind}.withinHours`, '大于 0 的小时数', f.withinHours);
    }
    ratio(`fastReset.${kind}.minRemaining`, f.minRemaining, { zeroOk: false });
  }
  ratio('othersMinRemaining', p.othersMinRemaining);
  if (!Number.isInteger(p.minSamples) || p.minSamples < 1)
    throw bad('minSamples', '不小于 1 的整数', p.minSamples);
  ratio('poorSuccessRate', p.poorSuccessRate);
  if (typeof p.trialEnabled !== 'boolean') throw bad('trialEnabled', ' true 或 false', p.trialEnabled);
  ratio('trialRatio', p.trialRatio, { zeroOk: false });
  for (const [kind, need] of Object.entries(p.needPerTask)) {
    if (need !== undefined) ratio(`needPerTask.${kind}`, need);
  }
  const ts = p.trackScore;
  if (typeof ts !== 'object' || ts === null) throw bad('trackScore', '一组设置', ts);
  if (!Array.isArray(ts.stages) || ts.stages.some((s) => !Object.hasOwn(STAGE_NEEDS, s))) {
    throw bad('trackScore.stages', '用途名的数组', ts.stages);
  }
  if (!Number.isInteger(ts.minTasks) || ts.minTasks < 1)
    throw bad('trackScore.minTasks', '不小于 1 的整数', ts.minTasks);
  ratio('trackScore.poorOneRoundRate', ts.poorOneRoundRate);
  if (
    typeof ts.roundOverheadMinutes !== 'number' ||
    !Number.isFinite(ts.roundOverheadMinutes) ||
    ts.roundOverheadMinutes < 0
  )
    throw bad('trackScore.roundOverheadMinutes', '不小于 0 的分钟数', ts.roundOverheadMinutes);
  ratio('trackScore.promoteMargin', ts.promoteMargin);
  if (typeof ts.byTier !== 'boolean') throw bad('trackScore.byTier', ' true 或 false', ts.byTier);
  if (!Number.isInteger(ts.priorTasks) || ts.priorTasks < 1)
    throw bad('trackScore.priorTasks', '不小于 1 的整数', ts.priorTasks);
  ratio('trackScore.qualityMargin', ts.qualityMargin);
  const st = p.strength;
  if (
    !Array.isArray(st.strongFirstTiers) ||
    st.strongFirstTiers.some((t) => !(ROUTE_TIERS as readonly string[]).includes(t))
  ) {
    throw bad(
      'strength.strongFirstTiers',
      '派工档（fast / medium / heavyweight）的数组',
      st.strongFirstTiers,
    );
  }
  ratio('strength.yieldAhead', st.yieldAhead, { zeroOk: false });
  for (const tier of ROUTE_TIERS) ratio(`strength.explore.${tier}`, st.explore[tier]);
  for (const key of Object.keys(st.explore)) {
    if (!(ROUTE_TIERS as readonly string[]).includes(key))
      throw bad(`strength.explore.${key}`, '派工档名', key);
  }
  if (typeof st.pool !== 'boolean') throw bad('strength.pool', ' true 或 false', st.pool);
  const al = p.allocate;
  if (al.mode !== 'weighted' && al.mode !== 'legacy')
    throw bad('allocate.mode', ' weighted 或 legacy', al.mode);
  const positive = (key: string, v: unknown) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw bad(key, '大于 0 的数', v);
  };
  positive('allocate.rhoCap', al.rhoCap);
  positive('allocate.neutralRho', al.neutralRho);
  ratio('allocate.minQuality', al.minQuality, { zeroOk: false });
  return p;
}

/** 调用方可以只改 trackScore、pace、strength 里的几项，没写的留默认。 */
export type RoutingPolicyInput = Omit<
  Partial<RoutingPolicy>,
  'trackScore' | 'pace' | 'strength' | 'allocate'
> & {
  allocate?: Partial<AllocatePolicy>;
  pace?: Partial<PacePolicy>;
  trackScore?: Partial<TrackScorePolicy>;
  strength?: Partial<Omit<StrengthPolicy, 'explore'>> & { explore?: Partial<Record<RouteTier, number>> };
};
