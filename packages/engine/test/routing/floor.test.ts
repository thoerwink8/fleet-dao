// 能力下限（#2725）：按用途和派工档定最低强弱档，选路排序之前硬过滤。法国 10-15 deepseek-flash（轻档）接了 35 段主力档动手、
// 做成 6 段；10-16 #2688（主力档）的冷验收派给了 deepseek-flash。额度再宽也不放宽下限；够格的全被硬挡才降一档，永远不降到轻档。
import { describe, expect, it } from 'vitest';
import {
  type ChooseRouteInput,
  chooseRoute,
  floorOf,
  type RouteFacts,
  STRENGTH_FLOOR,
} from '../../src/routing/index.ts';
import { at, input, route, win } from './helpers.ts';

// 7 天窗还有 72 小时清零：按时间该用约 57%，只用了 5%——落后很多、照进度该往前提，下限照样挡它
const roomy = [
  win({ label: '5h', window: '5h', used: 0.05, resetsAt: at(3) }),
  win({ used: 0.05, resetsAt: at(72) }),
];

/** 法国动手用途里人排的先后（节选）：deepseek-flash 排第一，grok 第二，opus 在后面。 */
const routesOf = (over: Record<string, Partial<RouteFacts>> = {}): RouteFacts[] => [
  route('flash', {
    modelId: 'deepseek-flash',
    modelName: 'deepseek-flash',
    family: 'deepseek',
    strength: 'light',
    poolName: 'DeepSeek',
    windows: roomy,
    ...over.flash,
  }),
  route('grok', {
    modelId: 'grok-4.7',
    modelName: 'grok-4.7',
    family: 'grok',
    hostId: 'grok',
    strength: 'standard',
    poolName: 'grok',
    ...over.grok,
  }),
  route('opus', {
    modelId: 'opus-5.5',
    modelName: 'opus-5.5',
    family: 'claude',
    strength: 'strong',
    poolName: 'Mirasim',
    ...over.opus,
  }),
];

const pick = (over: Partial<ChooseRouteInput> = {}, routes = routesOf()) =>
  chooseRoute(input(routes, { tier: 'heavyweight', ...over }));

const dispatched = (r: ReturnType<typeof chooseRoute>) => {
  if (r.kind !== 'dispatch') throw new Error(`没派出去：${r.kind}：${'reason' in r ? r.reason : ''}`);
  return r;
};
const blockOf = (r: ReturnType<typeof chooseRoute>, routeId: string) =>
  r.verdicts.find((v) => v.routeId === routeId)?.blocks.find((b) => b.code === 'below-floor');
const off = (routes: RouteFacts[], ...ids: string[]) =>
  routes.map((r) =>
    ids.includes(r.routeId) ? { ...r, blockers: [...r.blockers, 'switched-off' as const] } : r,
  );

describe('下限表', () => {
  it('动手、界面：主力档要强档、中档要标准档、快档不设；验收：主力档和中档要强档', () => {
    expect(STRENGTH_FLOOR.execute).toEqual({ heavyweight: 'strong', medium: 'standard', fast: 'light' });
    expect(STRENGTH_FLOOR.ui).toEqual({ heavyweight: 'strong', medium: 'standard', fast: 'light' });
    expect(STRENGTH_FLOOR.verify).toEqual({ heavyweight: 'strong', medium: 'strong', fast: 'light' });
    expect(floorOf('execute', 'fast')).toBeNull();
    expect(floorOf('execute', undefined)).toBeNull();
    expect(floorOf('judge', 'heavyweight')).toBeNull();
    expect(floorOf('verify', 'medium')).toBe('strong');
  });
});

describe('动手、界面按下限硬挡', () => {
  it('主力档动手：deepseek-flash 额度很宽、人排第一也不派，派强档；理由写清为什么没派它', () => {
    const r = dispatched(pick());
    expect(r.modelId).toBe('opus-5.5');
    expect(blockOf(r, 'flash')?.text).toContain('主力档的动手要强档');
    expect(blockOf(r, 'flash')?.text).toContain('额度剩多少都不放宽');
    expect(blockOf(r, 'grok')?.text).toContain('grok-4.7 是标准档');
    expect(r.why).toContain('够不上能力下限');
  });

  it('主力档界面同样要强档', () => {
    const r = dispatched(pick({ stage: 'ui' }));
    expect(r.modelId).toBe('opus-5.5');
    expect(blockOf(r, 'flash')?.text).toContain('主力档的界面要强档');
  });

  it('中档动手要标准档以上：挡 deepseek-flash，派 grok；快档轻档也行', () => {
    const medium = dispatched(pick({ tier: 'medium' }));
    expect(medium.modelId).toBe('grok-4.7');
    expect(blockOf(medium, 'flash')?.text).toContain('中档的动手要标准档以上');
    expect(dispatched(pick({ tier: 'fast' })).modelId).toBe('deepseek-flash');
  });

  it('没给派工档、不分档的用途：不设下限，照人排的', () => {
    expect(dispatched(chooseRoute(input(routesOf()))).modelId).toBe('deepseek-flash');
    expect(dispatched(pick({ stage: 'judge' })).modelId).toBe('deepseek-flash');
  });
});

describe('降档', () => {
  it('强档全被硬挡（人关了）：降一档派 grok，理由写明；轻档仍不派', () => {
    const r = dispatched(pick({}, off(routesOf(), 'opus')));
    expect(r.modelId).toBe('grok-4.7');
    expect(r.why).toContain('下限是强档');
    expect(r.why).toContain('降一档到标准档');
    expect(r.why).toContain('轻档仍不派');
    expect(blockOf(r, 'flash')?.text).toContain('不降到轻档');
  });

  it('强档、标准档都被硬挡：派不出，也不派轻档', () => {
    const r = pick({}, off(routesOf(), 'opus', 'grok'));
    expect(r.kind).toBe('none');
    expect(r.kind === 'none' && r.reason).toContain('够不上能力下限');
  });

  it('中档动手的标准档以上全被挡：不降到轻档', () => {
    const r = pick({ tier: 'medium' }, off(routesOf(), 'opus', 'grok'));
    expect(r.kind).toBe('none');
  });

  it('强档只是在等空位：等它，不降档', () => {
    const r = pick({}, routesOf({ opus: { inFlight: 5, maxConcurrency: 5 } }));
    expect(r.kind).toBe('wait');
    expect(r.kind === 'wait' && r.waitFor).toBe('slot');
  });

  it('强档额度用满、1 小时后清零：等它；3 小时后清零：降一档', () => {
    const exhausted = (hours: number) =>
      routesOf({
        opus: {
          quota: 'exhausted',
          blockers: ['quota-exhausted'],
          windows: [win({ state: 'exhausted', used: 1, resetsAt: at(hours) })],
        },
      });
    expect(pick({}, exhausted(1)).kind).toBe('wait');
    const later = dispatched(pick({}, exhausted(3)));
    expect(later.modelId).toBe('grok-4.7');
    expect(later.why).toContain('降一档到标准档');
  });
});

describe('验收', () => {
  it('主力档、中档的验收要强档：deepseek-flash、grok 都不派；快档轻档也行', () => {
    for (const tier of ['heavyweight', 'medium'] as const) {
      const r = dispatched(pick({ stage: 'verify', tier }));
      expect(r.modelId).toBe('opus-5.5');
      expect(blockOf(r, 'flash')?.text).toContain('的验收要强档');
    }
    expect(dispatched(pick({ stage: 'verify', tier: 'fast' })).modelId).toBe('deepseek-flash');
  });

  it('冷验收按族一家家问：问 deepseek 那一族，主力档单不派 deepseek-flash；别家避开不算够格的被挡，不提前降档', () => {
    const only = (family: string) => ({
      stage: 'verify' as const,
      avoid: { families: ['deepseek', 'grok', 'claude'].filter((f) => f !== family) },
    });
    // 10-16 #2688 的那一问：别的族都避开，只问 deepseek
    const deepseek = pick(only('deepseek'));
    expect(deepseek.kind).toBe('none');
    expect(blockOf(deepseek, 'flash')?.text).toContain('主力档的验收要强档');
    // 问 grok 那一族：claude 族的 opus 够格、问到它时能派，所以这一问不降档、不派 grok
    expect(pick(only('grok')).kind).toBe('none');
    expect(dispatched(pick(only('claude'))).modelId).toBe('opus-5.5');
  });

  it('冷验收：强档真的全被挡时，问 grok 那一族降一档派 grok；deepseek 那一族仍不派', () => {
    const routes = off(routesOf(), 'opus');
    const ask = (family: string) =>
      pick(
        { stage: 'verify', avoid: { families: ['deepseek', 'grok', 'claude'].filter((f) => f !== family) } },
        routes,
      );
    const grok = dispatched(ask('grok'));
    expect(grok.modelId).toBe('grok-4.7');
    expect(grok.why).toContain('降一档到标准档');
    expect(ask('deepseek').kind).toBe('none');
  });
});

describe('人的指令不驳', () => {
  // 用中档：主力档还有「重活先给强档」把强档排到前面，和下限无关
  it('人给这张单指定了模型（floorWaived）：不按下限挡', () => {
    const r = dispatched(pick({ tier: 'medium', floorWaived: '人在驾驶舱给这张单指定了 deepseek-flash' }));
    expect(r.modelId).toBe('deepseek-flash');
  });

  it('没标强弱档的模型照决定 0099「没标档照以前」：不按下限挡', () => {
    const r = dispatched(pick({ tier: 'medium' }, routesOf({ flash: { strength: null } })));
    expect(r.modelId).toBe('deepseek-flash');
  });
});
