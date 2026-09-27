// chooseRoute 的三种结果、任务指定路由、试探、熔断，以及「为什么派给它」。
import { ROUTE_PROBE_STALE_MINUTES, routeProbeStaleMinutes } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  type ChooseRouteResult,
  chooseRoute,
  type RouteFacts,
  stageAllOpen,
} from '../../src/routing/index.ts';
import { at, entry, halfOpenBreaker, input, NOW, route, soloAndCarpool, win } from './helpers.ts';

function picked(result: ChooseRouteResult): string {
  if (result.kind !== 'dispatch') throw new Error(`没派出去：${result.kind} ${result.reason}`);
  return result.routeId;
}

describe('派给某条路由', () => {
  it('按人排的顺序取第一条能用的，带路由的全部身份', () => {
    const r = chooseRoute(input([route('a', { channelId: 'mirasim-cloud', hostId: 'mirasim' }), route('b')]));
    expect(r).toMatchObject({
      kind: 'dispatch',
      routeId: 'a',
      poolId: 'pool-a',
      modelId: 'opus-5.5',
      family: 'claude',
      hostId: 'mirasim',
      trial: null,
      alarm: null,
    });
  });

  it('前面的被挡就取下一条，理由里写前面那条为什么没派', () => {
    const r = chooseRoute(input([route('a', { blockers: ['offline'] }), route('b')]));
    expect(picked(r)).toBe('b');
    if (r.kind === 'dispatch')
      expect(r.why).toBe(
        '写码阶段第 2 条：池b · Opus 5.5 · Claude Code；第 1 条 池a · Opus 5.5 · Claude Code：不在线（探活或熔断判的）',
      );
  });

  it('每条路由的判定都留在结果里（被挡的不删）', () => {
    const r = chooseRoute(input([route('a', { blockers: ['model-retired'] }), route('b')]));
    expect(r.verdicts.map((v) => [v.routeId, v.blocks.map((b) => b.code)])).toEqual([
      ['a', ['model-retired']],
      ['b', []],
    ]);
  });

  it('额度未知的被选上时写明「额度未知」', () => {
    const r = chooseRoute(input([route('a', { quota: 'unknown', windows: [] })]));
    expect(picked(r)).toBe('a');
    if (r.kind === 'dispatch') expect(r.why).toContain('额度未知');
  });

  it('同样的输入同样的结果（确定性）', () => {
    const make = () =>
      input(soloAndCarpool({}, { windows: [win({ used: 0.3, resetsAt: at(20) })] }), { weight: 'light' });
    expect(chooseRoute(make())).toEqual(chooseRoute(make()));
  });
});

describe('等', () => {
  it('所有能用的都只差空位：等空位，不报「派不出」', () => {
    const full = (id: string) => route(id, { blockers: ['no-slot'], inFlight: 5 });
    const r = chooseRoute(
      input([full('a'), full('b'), route('c', { blockers: ['banned'], banReasons: ['x'] })]),
    );
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'slot', until: null });
    if (r.kind === 'wait') expect(r.reason).toContain('等并发空位');
  });

  it('全部额度用满：等额度，给最早清零时刻', () => {
    const out = (id: string, hours: number) =>
      route(id, {
        quota: 'exhausted',
        blockers: ['quota-exhausted'],
        windows: [win({ state: 'exhausted', used: 1, resetsAt: at(hours) })],
      });
    const r = chooseRoute(input([out('a', 30), out('b', 6)]));
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'quota', until: at(6) });
  });

  it('有的差空位、有的差额度：先等空位', () => {
    const r = chooseRoute(
      input([
        route('a', {
          quota: 'exhausted',
          blockers: ['quota-exhausted'],
          windows: [win({ state: 'exhausted', used: 1 })],
        }),
        route('b', { blockers: ['no-slot'] }),
      ]),
    );
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'slot' });
  });

  it('熔断开着：等到试探时刻', () => {
    const r = chooseRoute(
      input([
        route('a', { breaker: { state: 'open', admit: 'none', reason: '连续失败 3 次', probeAt: at(0.25) } }),
      ]),
    );
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'breaker', until: at(0.25) });
  });

  it('一条等额度 1 小时、一条等熔断 2 小时：等 1 小时（取最早好的那条，不按种类挑）', () => {
    const r = chooseRoute(
      input([
        route('a', {
          quota: 'exhausted',
          blockers: ['quota-exhausted'],
          windows: [win({ state: 'exhausted', used: 1, resetsAt: at(1) })],
        }),
        route('b', { breaker: { state: 'open', admit: 'none', reason: '连续失败 3 次', probeAt: at(2) } }),
      ]),
    );
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'quota', until: at(1) });
    if (r.kind === 'wait') expect(r.reason).toMatch(/^写码阶段暂时派不了，最早 .* 额度清零/);
  });

  it('熔断半开、已经有试探在跑：等试探结果，不给过去的时刻（给了，等待秒数是负数，选路会空转）', () => {
    const r = chooseRoute(input([route('a', { breaker: halfOpenBreaker(1, 'a') })]));
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'breaker', until: null });
    if (r.kind === 'wait') expect(r.reason).toContain('在等熔断的试探结果');
  });

  it('有一条时刻不知道：不拿别的路由几天后的清零时刻去睡，按轮询间隔再看', () => {
    const r = chooseRoute(
      input([
        route('a', {
          quota: 'exhausted',
          blockers: ['quota-exhausted'],
          windows: [win({ state: 'exhausted', used: 1, resetsAt: at(50) })],
        }),
        route('b', { breaker: halfOpenBreaker(1, 'b') }),
      ]),
    );
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'breaker', until: null });
  });
});

describe('派不出（要报警，附每条被挡的原因）', () => {
  it('全被禁令、下架、关闭挡住', () => {
    const r = chooseRoute(
      input(
        [
          route('f', { modelId: 'fable-5.1', modelName: 'Fable 5.1' }),
          route('r', { blockers: ['model-retired'] }),
          route('c', { blockers: ['channel-disabled'] }),
        ],
        { order: [entry('f', 0), entry('r', 1), entry('c', 2)] },
      ),
    );
    expect(r.kind).toBe('none');
    if (r.kind === 'none') {
      expect(r.reason).toContain('不用 Fable');
      expect(r.reason).toContain('模型已下架');
      expect(r.reason).toContain('渠道关了');
    }
  });

  it('一条路由都没配', () => {
    expect(chooseRoute(input([], { order: [] }))).toMatchObject({ kind: 'none' });
  });

  it('阶段没配过顺序：不按编号乱挑（旧系统按 id 字典序选中了 Cursor）', () => {
    const r = chooseRoute(input([route('a')], { configured: false }));
    expect(r.kind).toBe('none');
    if (r.kind === 'none') expect(r.reason).toContain('还没在调度台上排路由顺序');
  });

  it('单条开关全关', () => {
    const r = chooseRoute(input([route('a')], { order: [entry('a', 0, { enabled: false })] }));
    expect(r.kind).toBe('none');
  });

  it('一条路由既不在线、又差空位：派不出（等来空位也还是派不了），不说等空位', () => {
    const r = chooseRoute(input([route('a', { blockers: ['offline', 'no-slot'], inFlight: 5 })]));
    expect(r.kind).toBe('none');
  });

  it('开 PR 前验证：能用的只有和作者同族的，派不出，不拿同族顶；有别家就派别家（哪怕人排在后面）', () => {
    const claude = [route('a'), route('b')];
    const onlySame = chooseRoute(input(claude, { stage: 'verify', avoid: { families: ['Claude'] } }));
    expect(onlySame.kind).toBe('none');
    if (onlySame.kind === 'none') expect(onlySame.reason).toContain('只派别家');
    const kimi = route('k', { family: 'kimi', modelId: 'kimi-k3', modelName: 'Kimi k3' });
    const withOther = chooseRoute(
      input([...claude, kimi], { stage: 'verify', avoid: { families: ['claude'] } }),
    );
    expect(picked(withOther)).toBe('k');
  });

  it('别家在等空位：等它，不回派不出', () => {
    const kimi = route('k', { family: 'kimi', blockers: ['no-slot'], inFlight: 5 });
    const r = chooseRoute(input([route('a'), kimi], { stage: 'verify', avoid: { families: ['claude'] } }));
    expect(r.kind).toBe('wait');
  });
});

describe('任务指定了路由', () => {
  const routes = () => [route('a'), route('b')];

  it('没被挡就用它，哪怕它排在后面', () => {
    const r = chooseRoute(input(routes(), { taskRouteId: 'b' }));
    expect(picked(r)).toBe('b');
    if (r.kind === 'dispatch') expect(r.why).toBe('任务指定的路由：池b · Opus 5.5 · Claude Code');
  });

  it('被硬禁令挡：报「指定的路由用不了」，不偷偷换成别的', () => {
    const fable = route('b', { modelId: 'fable-5.1', modelName: 'Fable 5.1' });
    const r = chooseRoute(input([route('a'), fable], { taskRouteId: 'b' }));
    expect(r.kind).toBe('none');
    if (r.kind === 'none') expect(r.reason).toMatch(/^指定的路由用不了：.*不用 Fable/);
  });

  it('被下架、被关闭挡：同样报用不了', () => {
    expect(
      chooseRoute(input([route('a'), route('b', { blockers: ['model-retired'] })], { taskRouteId: 'b' }))
        .kind,
    ).toBe('none');
    const off = input(routes(), {
      taskRouteId: 'b',
      order: [entry('a', 0), entry('b', 1, { enabled: false })],
    });
    expect(chooseRoute(off).kind).toBe('none');
  });

  it('只差空位：等它，不换', () => {
    const r = chooseRoute(input([route('a'), route('b', { blockers: ['no-slot'] })], { taskRouteId: 'b' }));
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'slot' });
  });

  it('不在这个阶段的顺序里也能指定', () => {
    const r = chooseRoute(input([route('a'), route('x')], { order: [entry('a', 0)], taskRouteId: 'x' }));
    expect(picked(r)).toBe('x');
  });

  it('指定的主池额度未知：照派，理由写「额度未知」', () => {
    const r = chooseRoute(
      input([route('a'), route('b', { quota: 'unknown', windows: [] })], { taskRouteId: 'b' }),
    );
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'b', trial: null });
    if (r.kind === 'dispatch')
      expect(r.why).toBe('任务指定的路由：池b · Opus 5.5 · Claude Code；额度未知（没读成或读数过期）');
  });

  it('指定的备池额度未知：放这一个当试探；已经有一个在跑就等它，不换路由', () => {
    const [solo, carpool] = soloAndCarpool({}, { quota: 'unknown', windows: [] });
    const r = chooseRoute(input([solo, carpool], { stage: 'judge', taskRouteId: 'carpool' }));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'carpool', trial: 'quota-probe' });
    if (r.kind === 'dispatch')
      expect(r.why).toBe('任务指定的路由：拼车号 · Opus 5.5 · Claude Code；拼车号额度未知，只放一个试探');
    const busy = { ...carpool, inFlight: 1 };
    expect(chooseRoute(input([solo, busy], { stage: 'judge', taskRouteId: 'carpool' }))).toMatchObject({
      kind: 'wait',
      waitFor: 'slot',
    });
  });
});

describe('试探', () => {
  const three = () => [route('a'), route('b'), route('c')];
  const on = { trialEnabled: true };

  it('构建期默认关：随机数多小都派首选', () => {
    expect(picked(chooseRoute(input(three(), { draw: 0 })))).toBe('a');
  });

  it('开着、随机数落在 10% 里：派给非首选，理由写「试探」', () => {
    const r = chooseRoute(input(three(), { draw: 0.07, policy: on }));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'c', trial: 'explore' });
    if (r.kind === 'dispatch') expect(r.why).toMatch(/^试探：/);
    expect(picked(chooseRoute(input(three(), { draw: 0.01, policy: on })))).toBe('b');
  });

  it('开着、随机数落在 10% 外：派首选', () => {
    expect(chooseRoute(input(three(), { draw: 0.1, policy: on }))).toMatchObject({
      routeId: 'a',
      trial: null,
    });
  });

  it('只从能派的里挑，样本不够的优先', () => {
    const rs = [
      route('a'),
      route('b', { blockers: ['offline'] }),
      route('c', { record: { samples: 50, successes: 45 } }),
      route('d', { record: { samples: 2, successes: 2 } }),
    ];
    expect(picked(chooseRoute(input(rs, { draw: 0.09, policy: on })))).toBe('d');
  });

  it('首选钉住时不试探', () => {
    const rs = three();
    const r = chooseRoute(
      input(rs, {
        draw: 0.01,
        policy: on,
        order: [entry('a', 0, { pinned: true }), entry('b', 1), entry('c', 2)],
      }),
    );
    expect(r).toMatchObject({ routeId: 'a', trial: null });
  });

  it('任务指定了路由时不试探', () => {
    expect(chooseRoute(input(three(), { draw: 0.01, policy: on, taskRouteId: 'a' }))).toMatchObject({
      routeId: 'a',
    });
  });

  it('试探落到额度未知的备池：记成 explore，理由两样都写', () => {
    const rs = soloAndCarpool({}, { quota: 'unknown', windows: [] });
    const r = chooseRoute(input(rs, { stage: 'judge', draw: 0.05, policy: on }));
    expect(r).toMatchObject({ routeId: 'carpool', trial: 'explore' });
    if (r.kind === 'dispatch') {
      expect(r.why).toMatch(/^试探：/);
      expect(r.why).toContain('拼车号额度未知，只放一个试探');
    }
  });

  it('试探落到额度未知的主池：理由写「额度未知」（design §九 选路第 3 条）', () => {
    const rs = [route('a'), route('b', { quota: 'unknown', windows: [] })];
    const r = chooseRoute(input(rs, { draw: 0.05, policy: on }));
    expect(r).toMatchObject({ routeId: 'b', trial: 'explore' });
    if (r.kind === 'dispatch') expect(r.why).toMatch(/^试探：.*；额度未知（没读成或读数过期）$/);
  });
});

describe('熔断：trial 只放一个', () => {
  it('半开、没有在途：放这一单当试探', () => {
    const r = chooseRoute(
      input([route('a', { breaker: { state: 'half_open', admit: 'trial', reason: '冷却到点' } })]),
    );
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'a', trial: 'breaker' });
    if (r.kind === 'dispatch') expect(r.why).toContain('熔断半开，这一单当试探');
  });

  it('半开、已经有试探在途（熔断判 none）：换下一条', () => {
    const busy = route('a', {
      breaker: { state: 'half_open', admit: 'none', reason: '已经有 1 个在途当试探' },
    });
    expect(picked(chooseRoute(input([busy, route('b')])))).toBe('b');
  });

  it('候选全都熔断：放最早到点的一条去试探，并报警', () => {
    const open = (id: string, probe: number) =>
      route(id, { breaker: { state: 'open', admit: 'none', reason: '连续失败 3 次', probeAt: at(probe) } });
    const r = chooseRoute(input([open('a', 0.5), open('b', 0.2)]));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'b', trial: 'all-open' });
    if (r.kind === 'dispatch') expect(r.alarm).toContain('全都熔断');
  });

  it('全都熔断、放出去试探的那条额度未知：理由里也写「额度未知」', () => {
    const open = (id: string, probe: number, extra: Partial<RouteFacts> = {}) =>
      route(id, {
        breaker: { state: 'open', admit: 'none', reason: '连续失败 3 次', probeAt: at(probe) },
        ...extra,
      });
    const r = chooseRoute(input([open('a', 0.5), open('b', 0.2, { quota: 'unknown', windows: [] })]));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'b', trial: 'all-open' });
    if (r.kind === 'dispatch') expect(r.why).toMatch(/去试探；额度未知（没读成或读数过期）$/);
  });

  it('只有一条熔断、别的只差空位：不强放试探，等空位', () => {
    const r = chooseRoute(
      input([
        route('a', { breaker: { state: 'open', admit: 'none', reason: 'x', probeAt: at(1) } }),
        route('b', { blockers: ['no-slot'] }),
      ]),
    );
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'slot' });
  });

  it('半开的又是额度未知的备池：标熔断试探，理由两样都写', () => {
    const c = route('c', {
      poolName: '拼车号',
      poolRole: 'backup',
      quota: 'unknown',
      windows: [],
      breaker: { state: 'half_open', admit: 'trial', reason: '冷却到点' },
    });
    const r = chooseRoute(input([c], { stage: 'triage' }));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'c', trial: 'breaker' });
    if (r.kind === 'dispatch') {
      expect(r.why).toContain('拼车号额度未知，只放一个试探');
      expect(r.why).toContain('熔断半开，这一单当试探');
    }
  });
});

describe('全熔断只读判定（stageAllOpen）：和选路同一段，不派、不抽签', () => {
  const open = (id: string, probe: number, extra: Partial<RouteFacts> = {}) =>
    route(id, {
      breaker: { state: 'open', admit: 'none', reason: '连续失败 3 次', probeAt: at(probe) },
      ...extra,
    });

  it('chooseRoute 给出 trial all-open 的输入，stageAllOpen 也判全熔断；指定路由、随机数不影响', () => {
    const rows = [open('a', 0.5), open('b', 0.2)];
    expect(chooseRoute(input(rows))).toMatchObject({ kind: 'dispatch', routeId: 'b', trial: 'all-open' });
    expect(stageAllOpen(input(rows))).toEqual({ allOpen: true });
    // 任务指定了路由时 chooseRoute 不走全熔断那一支；这个判断不看它，也不看试探用的随机数。
    const pinned = input(rows, { taskRouteId: 'a', draw: 0.01, policy: { trialEnabled: true } });
    expect(chooseRoute(pinned)).not.toMatchObject({ trial: 'all-open' });
    expect(stageAllOpen(pinned)).toEqual({ allOpen: true });
    expect(stageAllOpen(input(rows, { draw: 0.99 }))).toEqual({ allOpen: true });
  });

  it('有一条熔断解了（ready）：不是全熔断，detail 写出是哪条', () => {
    const check = stageAllOpen(input([open('a', 0.5), route('b')]));
    expect(check).toEqual({
      allOpen: false,
      detail: '第 2 条 池b · Opus 5.5 · Claude Code 不在熔断',
    });
  });

  it('某条不只被熔断挡着：不是全熔断，detail 写明被挡原因', () => {
    const check = stageAllOpen(input([open('a', 0.5), open('b', 0.2, { blockers: ['offline'] })]));
    expect(check.allOpen).toBe(false);
    if (!check.allOpen) {
      expect(check.detail).toContain('不再是只被熔断挡着');
      expect(check.detail).toContain('不在线');
    }
  });

  it('阶段没配顺序、一条都没配：不是全熔断', () => {
    expect(stageAllOpen(input([open('a', 0.5), open('b', 0.2)], { configured: false })).allOpen).toBe(false);
    expect(stageAllOpen(input([], { order: [] })).allOpen).toBe(false);
  });
});

describe('为什么派给它：人看得懂', () => {
  it('快清零提到最前', () => {
    const [solo, carpool] = soloAndCarpool(
      {},
      {
        windows: [win({ label: '5h', window: '5h', used: 0.1 }), win({ used: 0.3, resetsAt: at(20) })],
      },
    );
    const r = chooseRoute(input([solo, carpool], { weight: 'light' }));
    expect(r.kind === 'dispatch' && r.why).toBe(
      '写码阶段第 2 条：拼车号 · Opus 5.5 · Claude Code；拼车号周额度 20 小时后清零、还剩 70%，提到最前；第 1 条 独享号 · Opus 5.5 · Claude Code：排到了后面',
    );
  });

  it('首选被战绩挤下去：写明那条战绩差', () => {
    const r = chooseRoute(
      input([route('a', { record: { samples: 12, successes: 3 } }), route('b')], { stage: 'review' }),
    );
    expect(r.kind === 'dispatch' && r.why).toBe(
      '审查阶段第 2 条：池b · Opus 5.5 · Claude Code；第 1 条 池a · Opus 5.5 · Claude Code：战绩差（近期 12 次成 3 次），往后放',
    );
  });

  it('钉住的写「钉住」', () => {
    const r = chooseRoute(input([route('a')], { order: [entry('a', 0, { pinned: true })] }));
    expect(r.kind === 'dispatch' && r.why).toBe('写码阶段第 1 条：池a · Opus 5.5 · Claude Code（钉住）');
  });

  it('跳过很多条时只列前两条，其余写个数', () => {
    const off = (id: string) => route(id, { blockers: ['offline'] });
    const r = chooseRoute(input([off('a'), off('b'), off('c'), off('d'), route('e')] as RouteFacts[]));
    expect(r.kind === 'dispatch' && r.why).toContain('另有 2 条也没派');
  });
});

// design 第九节「路由探针」：探针连着三轮没给新结论（探针可能停了），照上一次的结论派——探针是看门的，它自己坏了
// 不该把活全挡住；但理由里写明「在线」是多久前的结论，不拿上一次的结论冒充现在。
describe('探针结论过期：照上一次的结论派，理由里写明', () => {
  const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
  const NOTE = /；在线是探针 .+前的结论，之后它没再给新结论（探针可能停了），照上一次的结论派$/;

  it('上一轮刚探过（没过期）：理由里不提探针', () => {
    const r = chooseRoute(input([route('a')]));
    expect(r.kind === 'dispatch' && r.why).toBe('写码阶段第 1 条：池a · Opus 5.5 · Claude Code');
  });

  it('两小时没有新结论：照派（不停工），理由末尾写明在线是两小时前的结论', () => {
    const r = chooseRoute(input([route('a', { probedAt: at(-2) })]));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'a', trial: null, alarm: null });
    expect(r.kind === 'dispatch' && r.why).toBe(
      '写码阶段第 1 条：池a · Opus 5.5 · Claude Code；在线是探针 2 小时前的结论，之后它没再给新结论（探针可能停了），照上一次的结论派',
    );
  });

  it('过期线和驾驶舱同一条：整 45 分钟不算过期，多 1 分钟就算', () => {
    const edge = chooseRoute(input([route('a', { probedAt: minutesAgo(ROUTE_PROBE_STALE_MINUTES) })]));
    expect(edge.kind === 'dispatch' && edge.why).not.toContain('探针');
    const over = chooseRoute(input([route('a', { probedAt: minutesAgo(ROUTE_PROBE_STALE_MINUTES + 1) })]));
    expect(over.kind === 'dispatch' && over.why).toContain('在线是探针 46 分钟前的结论');
  });

  it('放慢的执行方式（cursor-agent 探通了隔 2 小时再探）按它自己的线：2 小时 30 分以内不算过期', () => {
    const slow = { hostId: 'cursor-agent' as const };
    const stale = routeProbeStaleMinutes('cursor-agent');
    expect(stale).toBe(150);
    const fresh = chooseRoute(input([route('a', { ...slow, probedAt: minutesAgo(100) })]));
    expect(fresh.kind === 'dispatch' && fresh.why).not.toContain('探针');
    const edge = chooseRoute(input([route('a', { ...slow, probedAt: minutesAgo(stale) })]));
    expect(edge.kind === 'dispatch' && edge.why).not.toContain('探针');
    const over = chooseRoute(input([route('a', { ...slow, probedAt: minutesAgo(stale + 1) })]));
    expect(over.kind === 'dispatch' && over.why).toContain('在线是探针 3 小时前的结论');
  });

  it('派出去的每条路径都写：任务指定的路由、试探、全熔断时放的试探', () => {
    const stale = { probedAt: at(-3) };
    const pinned = chooseRoute(input([route('a'), route('b', stale)], { taskRouteId: 'b' }));
    expect(pinned).toMatchObject({ kind: 'dispatch', routeId: 'b' });
    expect(pinned.kind === 'dispatch' && pinned.why).toMatch(NOTE);

    const explore = chooseRoute(
      input([route('a'), route('b', stale), route('c', stale)], {
        draw: 0.01,
        policy: { trialEnabled: true },
      }),
    );
    expect(explore).toMatchObject({ kind: 'dispatch', routeId: 'b', trial: 'explore' });
    expect(explore.kind === 'dispatch' && explore.why).toMatch(NOTE);

    const open = (id: string, probe: number) =>
      route(id, {
        ...stale,
        breaker: { state: 'open', admit: 'none', reason: '连续失败 3 次', probeAt: at(probe) },
      });
    const allOpen = chooseRoute(input([open('a', 0.5), open('b', 0.2)]));
    expect(allOpen).toMatchObject({ kind: 'dispatch', routeId: 'b', trial: 'all-open' });
    expect(allOpen.kind === 'dispatch' && allOpen.why).toMatch(NOTE);
  });

  it('只说派出去的这条：没派的那条过期了不提', () => {
    const r = chooseRoute(input([route('a', { probedAt: at(-5), blockers: ['offline'] }), route('b')]));
    expect(r.kind === 'dispatch' && r.why).not.toContain('探针');
  });
});
