// 读不到、格式认不出：明确失败（抛 RoutingInputError），不当成「没被挡」「额度没问题」往下派。每条路径一条故意造坏的用例。
import { describe, expect, it } from 'vitest';
import {
  type ChooseRouteInput,
  chooseRoute,
  type RouteFacts,
  RoutingInputError,
  resolveRoutingPolicy,
} from '../../src/routing/index.ts';
import { entry, input, route, win } from './helpers.ts';

function fails(make: () => ChooseRouteInput, message: RegExp) {
  expect(() => chooseRoute(make())).toThrow(RoutingInputError);
  expect(() => chooseRoute(make())).toThrow(message);
}
const one = (extra: Partial<RouteFacts>) => input([route('a', extra)]);

describe('输入认不出就明确失败', () => {
  it('现在的时刻认不出', () => fails(() => input([route('a')], { now: 'yesterday' }), /现在的时刻认不出/));

  it('阶段类型、活的轻重认不出（轻重认不出不能让备池当成轻活放行）', () => {
    fails(() => input([route('a')], { stage: 'test' as never }), /阶段类型认不出/);
    fails(() => input([route('a')], { weight: 'medium' as never }), /轻重认不出/);
  });

  it('试探开着却没给随机数、或随机数越界', () => {
    const on = { trialEnabled: true };
    fails(() => input([route('a')], { policy: on }), /随机数/);
    fails(() => input([route('a')], { policy: on, draw: 1 }), /随机数/);
    fails(() => input([route('a')], { policy: on, draw: -0.1 }), /随机数/);
    fails(() => input([route('a')], { policy: on, draw: Number.NaN }), /随机数/);
  });

  it('试探关着时不要随机数', () => {
    expect(chooseRoute(input([route('a')])).kind).toBe('dispatch');
  });

  it('顺序里的路由没给事实（候选、熔断、战绩没读到）：不当它不存在', () =>
    fails(() => input([route('a')], { order: [entry('a', 0), entry('ghost', 1)] }), /ghost 的事实没给/));

  it('指定的路由没给事实', () =>
    fails(() => input([route('a')], { taskRouteId: 'ghost' }), /ghost 的事实没给/));

  it('同一条路由在顺序里两次、同一个位置两条、事实两份', () => {
    fails(() => input([route('a')], { order: [entry('a', 0), entry('a', 1)] }), /出现了两次/);
    fails(
      () => input([route('a'), route('b')], { order: [entry('a', 0), entry('b', 0)] }),
      /位置 0 上有两条/,
    );
    fails(() => input([route('a'), route('a')], { order: [entry('a', 0)] }), /事实给了两份/);
  });

  it('认不出的被挡原因：不当成没被挡', () =>
    fails(() => one({ blockers: ['paused' as never] }), /被挡原因认不出/));

  it('额度状态和被挡原因对不上：不按其中一边往下派（未知的备池会被放去试探，用满的主池会被照派）', () => {
    fails(() => one({ quota: 'exhausted', blockers: [] }), /额度状态（exhausted）和被挡原因（无）对不上/);
    fails(
      () => one({ poolRole: 'backup', quota: 'unknown', blockers: ['quota-exhausted'] }),
      /额度状态（unknown）和被挡原因（quota-exhausted）对不上/,
    );
    fails(() => one({ quota: 'ok', blockers: ['no-slot', 'quota-exhausted'] }), /对不上/);
  });

  it('认不出的额度状态、池主备、熔断判定', () => {
    fails(() => one({ quota: 'fine' as never }), /额度状态认不出/);
    fails(() => one({ poolRole: 'spare' as never }), /池主备认不出/);
    fails(() => one({ breaker: { state: 'closed', admit: 'maybe' as never, reason: '' } }), /熔断判定认不出/);
    fails(
      () => one({ breaker: { state: 'open', admit: 'none', reason: '', probeAt: 'soon' } }),
      /熔断试探时刻认不出/,
    );
  });

  it('上游模型串、别名认不出（没带上，硬禁令就认不出上游串是 Fable 的）', () => {
    fails(() => one({ upstreamModel: undefined as never }), /上游模型串认不出/);
    fails(() => one({ upstreamModel: 42 as never }), /上游模型串认不出/);
    fails(() => one({ upstreamAliases: undefined as never }), /上游别名认不出/);
    fails(() => one({ upstreamAliases: [7] as never }), /上游别名认不出/);
  });

  it('在途数、并发上限认不出', () => {
    fails(() => one({ inFlight: -1 }), /在途数认不出/);
    fails(() => one({ maxConcurrency: 1.5 }), /并发上限认不出/);
  });

  it('战绩认不出', () => {
    fails(() => one({ record: { samples: Number.NaN, successes: 0 } }), /战绩样本数认不出/);
    fails(() => one({ record: { samples: 3, successes: 4 } }), /成功数比样本数还多/);
  });

  it('额度窗认不出：状态、已用比例、清零时刻、读数时刻、过期时刻', () => {
    fails(() => one({ windows: [win({ state: 'full' as never })] }), /状态认不出/);
    fails(() => one({ windows: [win({ used: -0.2 })] }), /已用比例认不出/);
    fails(() => one({ windows: [win({ used: Number.NaN })] }), /已用比例认不出/);
    fails(() => one({ windows: [win({ resetsAt: 'next week' })] }), /清零时刻认不出/);
    fails(() => one({ windows: [win({ readAt: '' })] }), /读数时刻认不出/);
    fails(() => one({ windows: [win({ staleSince: 'x' })] }), /过期时刻认不出/);
  });
});

describe('策略给了但不对就报错，不悄悄换成默认', () => {
  it.each([
    [{ minSamples: 0 }, /minSamples/],
    [{ poorSuccessRate: 1.5 }, /poorSuccessRate/],
    [{ trialRatio: 0 }, /trialRatio/],
    [{ backupMaxConcurrency: 0 }, /backupMaxConcurrency/],
    [{ othersMinRemaining: -1 }, /othersMinRemaining/],
    [{ fastReset: { '7d': { withinHours: 0, minRemaining: 0.3 } } }, /withinHours/],
    [{ fastReset: { '7d': { withinHours: 24, minRemaining: 0 } } }, /minRemaining/],
    [{ backupNeedPerTask: { '5h': 2 } }, /backupNeedPerTask/],
    [{ stageWeight: { triage: 'tiny' as never } } as never, /stageWeight/],
    [{ trialEnabled: 'yes' as never }, /trialEnabled/],
  ])('%j', (policy, message) => {
    expect(() => resolveRoutingPolicy(policy)).toThrow(message);
  });

  it('只改给了的项，其余照默认', () => {
    const p = resolveRoutingPolicy({
      stageWeight: { plan: 'light' } as never,
      backupNeedPerTask: { '5h': 0.2 },
    });
    expect(p.stageWeight.plan).toBe('light');
    expect(p.stageWeight.execute).toBe('heavy');
    expect(p.backupNeedPerTask['5h']).toBe(0.2);
    expect(p.backupNeedPerTask['7d']).toBe(0.03);
    expect(p.trialEnabled).toBe(false);
  });
});
