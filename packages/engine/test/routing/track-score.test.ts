// 动手按模型战绩排（PLAN 3f，决定 0093）：每单期望成本重排模型、一轮做成率差的不进动手但能兜底、样本少不动、读不到照旧、
// 别的用途不动。战绩数取自法国库 10-14 查的近 7 天（_tmp/rethink/routescore/q2.sql）。
import { describe, expect, it } from 'vitest';
import {
  chooseRoute,
  type ModelTierTrackFacts,
  type ModelTrackFacts,
  type RouteFacts,
  resolveRoutingPolicy,
} from '../../src/routing/index.ts';
import { modelOrder, scoreOf, tierQuality } from '../../src/routing/rank.ts';
import { entry, input, route } from './helpers.ts';

const track = (
  modelId: string,
  tasks: number,
  done: number,
  oneRound: number,
  segments: number,
  segmentMinutes: number,
): ModelTrackFacts => ({ modelId, tasks, done, oneRound, segments, segmentMinutes });

/** 法国库 10-14 查的近 7 天快照（按第一段动手的模型记）。byTier 关掉时仍用这组数排，顺序不随窗口从 7 天改成 14 天变。 */
const FRANCE: ModelTrackFacts[] = [
  track('grok-4.7', 157, 138, 80, 300, 4320),
  track('cursor-auto', 35, 29, 6, 100, 710),
  track('deepseek-flash', 16, 13, 1, 38, 669),
  track('glm-5.3-flash', 8, 6, 2, 23, 416),
  track('sonnet-5.5', 6, 5, 1, 12, 64),
  track('opus-5.5', 4, 2, 2, 5, 92),
  track('gpt-5.6-luna', 2, 2, 2, 2, 9),
];

/** 动手用途在法国的人排先后，一个模型一条路由。 */
const MODELS = [
  'grok-4.7',
  'cursor-auto',
  'deepseek-flash',
  'glm-5.3-flash',
  'sonnet-5.5',
  'opus-5.5',
  'gpt-5.6-luna',
];
const routesOf = (over: Record<string, Partial<RouteFacts>> = {}) =>
  MODELS.map((m) => route(m, { modelId: m, modelName: m, ...over[m] }));

const row = (
  modelId: string,
  tier: ModelTierTrackFacts['tier'],
  firstSegs: number,
  onePass: number,
  sentBack: number,
  noDeliver: number,
  notDone: number,
  minutes: number,
): ModelTierTrackFacts => ({ modelId, tier, firstSegs, onePass, sentBack, noDeliver, notDone, minutes });

/** 同一模型快档 25/35、主力档 24/109；对照模型快档弱、主力档强。 */
const SPLIT: ModelTierTrackFacts[] = [
  row('cursor-auto', 'fast', 35, 25, 10, 0, 0, 350),
  row('cursor-auto', 'heavyweight', 109, 24, 50, 10, 25, 2180),
  row('grok-4.7', 'fast', 30, 5, 10, 5, 10, 300),
  row('grok-4.7', 'heavyweight', 50, 40, 8, 1, 1, 1500),
];

const policy = resolveRoutingPolicy();

describe('打分', () => {
  it('期望成本 = 段数 / 做成单数 ×（每段分钟 + 每轮额外分钟）；一轮做成率低于线、样本够才算差', () => {
    const grok = scoreOf(FRANCE[0] as ModelTrackFacts, policy);
    expect(grok.expectedMinutes).toBeCloseTo((300 / 138) * (4320 / 300 + 15), 5);
    expect(grok.poor).toBe(false);
    const ds = scoreOf(FRANCE[2] as ModelTrackFacts, policy);
    expect(ds.poor).toBe(true);
    // 样本不够（4 单 < 5）：不打分、不挡
    const opus = scoreOf(FRANCE[5] as ModelTrackFacts, policy);
    expect(opus.scored).toBe(false);
    expect(scoreOf(track('x', 5, 0, 0, 5, 10), policy).expectedMinutes).toBe(Number.POSITIVE_INFINITY);
    expect(scoreOf(track('x', 4, 0, 0, 4, 10), policy).poor).toBe(false);
  });

  it('按法国战绩重排：grok 仍第一；sonnet 比 cursor、glm 明显省，挪到它们前面；deepseek 一轮几乎做不成，挪到最后；样本少的留原位', () => {
    const scores = new Map(FRANCE.map((t) => [t.modelId, scoreOf(t, policy)]));
    expect(modelOrder(MODELS, scores, policy)).toEqual([
      'grok-4.7',
      'sonnet-5.5',
      'cursor-auto',
      'glm-5.3-flash',
      'opus-5.5',
      'gpt-5.6-luna',
      'deepseek-flash',
    ]);
  });

  it('差得不多（不到 promoteMargin）不挪：照人排的', () => {
    const scores = new Map(
      [track('a', 10, 10, 5, 10, 100), track('b', 10, 10, 5, 10, 80)].map((t) => [
        t.modelId,
        scoreOf(t, policy),
      ]),
    );
    // a 每单 25 分钟、b 23 分钟：只省 8%
    expect(modelOrder(['a', 'b'], scores, policy)).toEqual(['a', 'b']);
  });
});

describe('选路：动手按战绩', () => {
  it('没给战绩：和以前一样按人排的（第一个模型）', () => {
    const r = chooseRoute(input(routesOf()));
    expect(r.kind === 'dispatch' && r.routeId).toBe('grok-4.7');
  });

  it('给了战绩：派 grok，理由带它的战绩分；verdicts 里 deepseek 排最后、写明不进动手', () => {
    const r = chooseRoute(input(routesOf(), { modelTracks: FRANCE }));
    if (r.kind !== 'dispatch') throw new Error(`没派出去：${JSON.stringify(r)}`);
    expect(r.routeId).toBe('grok-4.7');
    expect(r.why).toContain('动手战绩：近 14 天 157 单成 138、一轮成 80（51%）');
    expect(r.verdicts.map((v) => v.routeId)).toEqual([
      'grok-4.7',
      'sonnet-5.5',
      'cursor-auto',
      'glm-5.3-flash',
      'opus-5.5',
      'gpt-5.6-luna',
      'deepseek-flash',
    ]);
    const ds = r.verdicts.at(-1);
    expect(ds?.nudges.map((n) => n.kind)).toEqual(['poor-one-round']);
    expect(ds?.nudges[0]?.text).toContain('不进写码');
    expect(r.verdicts[1]?.nudges[0]?.text).toContain('按战绩排第 2 个模型（人排第 5 个）');
  });

  it('前面的都只差空位、只剩 deepseek 能派：等空位，不派一轮做不成的', () => {
    const full = { blockers: ['no-slot' as const] };
    const routes = routesOf(
      Object.fromEntries(MODELS.filter((m) => m !== 'deepseek-flash').map((m) => [m, full])),
    );
    const r = chooseRoute(input(routes, { modelTracks: FRANCE }));
    expect(r.kind).toBe('wait');
    if (r.kind === 'wait') {
      expect(r.waitFor).toBe('slot');
      expect(r.reason).toContain('一轮做成率低于 15%');
    }
  });

  it('别的都硬挡（渠道关了）：唯一能用的 deepseek 照样派，理由写明兜底', () => {
    const off = { blockers: ['channel-disabled' as const] };
    const routes = routesOf(
      Object.fromEntries(MODELS.filter((m) => m !== 'deepseek-flash').map((m) => [m, off])),
    );
    const r = chooseRoute(input(routes, { modelTracks: FRANCE }));
    if (r.kind !== 'dispatch') throw new Error(`唯一能用的被打分排没了：${JSON.stringify(r)}`);
    expect(r.routeId).toBe('deepseek-flash');
    expect(r.why).toContain('别的都派不了，这次兜底派它');
  });

  it('只配了 deepseek 一个模型：照派', () => {
    const r = chooseRoute(
      input([route('ds', { modelId: 'deepseek-flash', modelName: 'deepseek' })], { modelTracks: FRANCE }),
    );
    expect(r.kind === 'dispatch' && r.routeId).toBe('ds');
  });

  it('冷验收等别的用途：给了战绩也不动，deepseek 照常按人排的位置派', () => {
    const routes = [
      route('ds', { modelId: 'deepseek-flash', modelName: 'deepseek' }),
      route('grok', { modelId: 'grok-4.7', modelName: 'grok' }),
    ];
    const r = chooseRoute(input(routes, { stage: 'verify', modelTracks: FRANCE }));
    expect(r.kind === 'dispatch' && r.routeId).toBe('ds');
    if (r.kind === 'dispatch') expect(r.verdicts.flatMap((v) => v.nudges)).toEqual([]);
  });

  it('界面活（ui 用途）也按动手战绩挡', () => {
    const routes = [
      route('ds', { modelId: 'deepseek-flash', modelName: 'deepseek' }),
      route('grok', { modelId: 'grok-4.7', modelName: 'grok' }),
    ];
    const r = chooseRoute(input(routes, { stage: 'ui', modelTracks: FRANCE }));
    expect(r.kind === 'dispatch' && r.routeId).toBe('grok');
  });

  it('有钉住的行：模型之间整段不动', () => {
    const routes = routesOf();
    const r = chooseRoute(
      input(routes, {
        modelTracks: FRANCE,
        order: routes.map((x, i) => entry(x.routeId, i, { pinned: x.routeId === 'cursor-auto' })),
      }),
    );
    if (r.kind !== 'dispatch') throw new Error('没派出去');
    expect(r.verdicts.map((v) => v.routeId)).toEqual(MODELS);
  });

  it('战绩认不出：选路报错，不拿坏数排', () => {
    expect(() =>
      chooseRoute(input(routesOf(), { modelTracks: [track('grok-4.7', 3, 5, 0, 3, 10)] })),
    ).toThrow(/动手战绩对不上/);
    expect(() =>
      chooseRoute(
        input(routesOf(), {
          modelTracks: [track('grok-4.7', 3, 1, 0, 3, 10), track('grok-4.7', 3, 1, 0, 3, 10)],
        }),
      ),
    ).toThrow(/重复/);
  });

  it('byTier 关掉：分档战绩就算会翻顺序，模型先后仍和改前一字不差', () => {
    const off = resolveRoutingPolicy({ trackScore: { byTier: false } });
    const scores = new Map(FRANCE.map((t) => [t.modelId, scoreOf(t, off)]));
    expect(modelOrder(MODELS, scores, off)).toEqual([
      'grok-4.7',
      'sonnet-5.5',
      'cursor-auto',
      'glm-5.3-flash',
      'opus-5.5',
      'gpt-5.6-luna',
      'deepseek-flash',
    ]);
    const r = chooseRoute(
      input(routesOf(), {
        policy: { trackScore: { byTier: false } },
        tier: 'heavyweight',
        modelTracks: FRANCE,
        modelTierTracks: [
          row('cursor-auto', 'heavyweight', 109, 24, 50, 10, 25, 2000),
          row('grok-4.7', 'heavyweight', 50, 40, 8, 1, 1, 1500),
        ],
      }),
    );
    if (r.kind !== 'dispatch') throw new Error('没派出去');
    expect(r.verdicts.map((v) => v.routeId)).toEqual([
      'grok-4.7',
      'sonnet-5.5',
      'cursor-auto',
      'glm-5.3-flash',
      'opus-5.5',
      'gpt-5.6-luna',
      'deepseek-flash',
    ]);
    expect(r.why).toContain('近 14 天');
  });
});

describe('选路：动手按派工档', () => {
  const pair = [
    route('cursor-auto', { modelId: 'cursor-auto', modelName: 'cursor' }),
    route('grok-4.7', { modelId: 'grok-4.7', modelName: 'grok' }),
  ];

  it('本档只有它自己时，收缩后的 m 等于自己的一段过率', () => {
    const m = 24 / 109;
    const q = m - Math.sqrt((m * (1 - m)) / 113);
    expect(tierQuality(24, 109, m, 4)).toBeCloseTo(q, 12);
    expect(q).toBeCloseTo(0.181203, 5);
  });

  it('同一模型快档 25/35 仍排前面；主力档 24/109 排在这一档更好的模型后面', () => {
    const heavy = chooseRoute(input(pair, { tier: 'heavyweight', modelTierTracks: SPLIT }));
    if (heavy.kind !== 'dispatch') throw new Error('没派出去');
    expect(heavy.verdicts.map((v) => v.routeId)).toEqual(['grok-4.7', 'cursor-auto']);
    expect(heavy.verdicts[0]?.nudges[0]?.text).toContain('主力档');
    expect(heavy.verdicts[0]?.nudges[0]?.text).toContain('按这一档排第 1 个模型（人排第 2 个）');
    expect(heavy.why).toContain('cursor-auto');

    const fast = chooseRoute(input(pair, { tier: 'fast', modelTierTracks: SPLIT }));
    if (fast.kind !== 'dispatch') throw new Error('没派出去');
    expect(fast.verdicts.map((v) => v.routeId)).toEqual(['cursor-auto', 'grok-4.7']);
    expect(fast.verdicts[0]?.nudges[0]?.text).toContain('快档 35 单一段过 25');
  });

  it('8 单一段过 1 单不再被挪到最后', () => {
    const routes = [
      route('sonnet-5.5', { modelId: 'sonnet-5.5', modelName: 'sonnet' }),
      route('grok-4.7', { modelId: 'grok-4.7', modelName: 'grok' }),
      route('opus-5.5', { modelId: 'opus-5.5', modelName: 'opus' }),
    ];
    const r = chooseRoute(
      input(routes, {
        tier: 'heavyweight',
        modelTierTracks: [
          row('sonnet-5.5', 'heavyweight', 8, 1, 4, 1, 2, 200),
          row('grok-4.7', 'heavyweight', 20, 10, 6, 2, 2, 400),
        ],
      }),
    );
    if (r.kind !== 'dispatch') throw new Error('没派出去');
    expect(r.verdicts.map((v) => v.routeId)).toEqual(['grok-4.7', 'sonnet-5.5', 'opus-5.5']);
    const sonnet = r.verdicts.find((v) => v.routeId === 'sonnet-5.5');
    expect(sonnet?.nudges.some((n) => n.kind === 'poor-one-round')).toBe(false);
  });

  it('质量分相同才比每段分钟；差不到 0.08 不因分钟往前挪', () => {
    const tie = chooseRoute(
      input(pair, {
        tier: 'medium',
        modelTierTracks: [
          row('cursor-auto', 'medium', 20, 10, 6, 2, 2, 400),
          row('grok-4.7', 'medium', 20, 10, 6, 2, 2, 100),
        ],
      }),
    );
    if (tie.kind !== 'dispatch') throw new Error('没派出去');
    expect(tie.verdicts.map((v) => v.routeId)).toEqual(['grok-4.7', 'cursor-auto']);

    const close = chooseRoute(
      input(pair, {
        tier: 'medium',
        modelTierTracks: [
          row('cursor-auto', 'medium', 40, 20, 12, 4, 4, 800),
          row('grok-4.7', 'medium', 40, 18, 12, 4, 6, 80),
        ],
      }),
    );
    if (close.kind !== 'dispatch') throw new Error('没派出去');
    expect(close.verdicts.map((v) => v.routeId)).toEqual(['cursor-auto', 'grok-4.7']);
  });

  it('这一档没有行：留在人排的位置，不退回整单战绩', () => {
    const r = chooseRoute(input(pair, { tier: 'medium', modelTracks: FRANCE, modelTierTracks: SPLIT }));
    if (r.kind !== 'dispatch') throw new Error('没派出去');
    expect(r.verdicts.map((v) => v.routeId)).toEqual(['cursor-auto', 'grok-4.7']);
    expect(r.verdicts.flatMap((v) => v.nudges)).toEqual([]);
  });

  it('分档战绩认不出：选路报错', () => {
    expect(() => chooseRoute(input(pair, { tier: 'nope' as 'fast', modelTierTracks: SPLIT }))).toThrow(
      /派工档认不出/,
    );
    expect(() =>
      chooseRoute(
        input(pair, {
          tier: 'fast',
          modelTierTracks: [row('cursor-auto', 'fast', 3, 1, 1, 1, 1, 10)],
        }),
      ),
    ).toThrow(/分档战绩对不上/);
  });
});
