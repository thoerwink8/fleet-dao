// 过滤：每条规则一正一反。被挡的留原因，no-slot 不算坏（等空位），额度没读成的池不挡。
import { describe, expect, it } from 'vitest';
import { blocksFor, type FilterContext, hostUnfit } from '../../src/routing/filter.ts';
import { groupOf } from '../../src/routing/group.ts';
import {
  chooseRoute,
  DEFAULT_ROUTING_POLICY,
  HOST_ABILITIES,
  type RouteFacts,
  type RouteWindow,
  STAGE_NEEDS,
} from '../../src/routing/index.ts';
import { at, entry, halfOpenBreaker, input, NOW, route, win } from './helpers.ts';

function ctx(overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    stage: 'execute',
    policy: { ...DEFAULT_ROUTING_POLICY },
    now: Date.parse(NOW),
    avoid: { routeIds: new Set(), poolIds: new Set(), modelIds: new Set(), families: new Set() },
    liveOrg: 'carpool',
    uiWork: false,
    ...overrides,
  };
}
const codes = (r: RouteFacts, c = ctx(), e = entry(r.routeId, 0)) => blocksFor(r, e, c).map((b) => b.code);

describe('会话用户挂着哪个组织（design 第九节：一个会话用户，同一时刻只挂一个组织）', () => {
  it('挂着的那个组织的池能派；没标组织类型的池（不是 Claude 订阅池）不受影响', () => {
    expect(codes(route('car', { orgKind: 'carpool' }))).toEqual([]);
    expect(codes(route('relay', { orgKind: null }))).toEqual([]);
    expect(codes(route('relay2'))).toEqual([]);
  });

  it('没挂的组织的池：硬挡，写明现在挂的是哪个', () => {
    const blocks = blocksFor(route('solo', { orgKind: 'solo', poolName: '独享号' }), entry('solo', 0), ctx());
    expect(blocks.map((b) => b.code)).toEqual(['org-not-live']);
    expect(blocks[0]?.text).toBe('会话用户现在挂的是拼车组织，独享号要等切过去才能派');
    expect(groupOf(blocks)).toEqual({ kind: 'hard' });
    expect(codes(route('car', { orgKind: 'carpool' }), ctx({ liveOrg: 'solo' }))).toEqual(['org-not-live']);
  });

  it('不知道会话用户挂的是哪个组织：带组织类型的池一律不派，不当成挂着', () => {
    const blocks = blocksFor(route('car', { orgKind: 'carpool', poolName: '拼车号' }), entry('car', 0), {
      ...ctx(),
      liveOrg: undefined,
    });
    expect(blocks.map((b) => b.code)).toEqual(['org-not-live']);
    expect(blocks[0]?.text).toContain('不知道会话用户现在挂的是哪个组织');
    expect(codes(route('relay'), { ...ctx(), liveOrg: undefined })).toEqual([]);
  });

  it('读了没读成（读不到、认不出）：带组织类型的池一律不派，原话写进原因；别的池照派', () => {
    const unknown = ctx({ liveOrg: undefined, liveOrgProblem: 'reclaude 报登录失效' });
    for (const kind of ['carpool', 'solo'] as const) {
      const blocks = blocksFor(route(kind, { orgKind: kind, poolName: '某号' }), entry(kind, 0), unknown);
      expect(blocks.map((b) => b.code)).toEqual(['org-not-live']);
      expect(blocks[0]?.text).toBe('会话用户挂的组织认不出（reclaude 报登录失效），某号不派');
      expect(groupOf(blocks)).toEqual({ kind: 'hard' });
    }
    expect(codes(route('relay'), unknown)).toEqual([]);
  });
});

describe('不是挂着的那个组织的池：引擎打算切过去的等切号，不打算切的硬挡（#335，和切号同一个判法）', () => {
  const solo = route('solo', { orgKind: 'solo', poolName: '独享号' });

  it('引擎下一轮就切过去（to 是它的组织、没给时刻）：等得来（等切号），时刻不知道、按轮询再看', () => {
    const blocks = blocksFor(
      solo,
      entry('solo', 0),
      ctx({ orgPlan: { to: 'solo', at: null, why: '拼车额度用满了，切到独享接着干' } }),
    );
    expect(blocks).toEqual([
      {
        code: 'org-not-live',
        text: '会话用户现在挂的是拼车组织，独享号要等切过去才能派；引擎下一轮路由探针切过去（拼车额度用满了，切到独享接着干），等切号',
        wait: 'org',
        until: null,
      },
    ]);
    expect(groupOf(blocks)).toEqual({ kind: 'wait', waitFor: 'org', until: null });
  });

  it('引擎到点才切回（拼车几点恢复）：等到那个时刻', () => {
    const car = route('car', { orgKind: 'carpool', poolName: '拼车号' });
    const blocks = blocksFor(
      car,
      entry('car', 0),
      ctx({ liveOrg: 'solo', orgPlan: { to: 'carpool', at: at(2), why: '拼车 2 小时后恢复' } }),
    );
    expect(blocks[0]).toMatchObject({ code: 'org-not-live', wait: 'org', until: at(2) });
    expect(blocks[0]?.text).toContain('以后的那一轮路由探针切过去（拼车 2 小时后恢复）');
    // 那个时刻已经过了（读数慢了一步）：不给过去的时刻，按下一轮算
    const late = blocksFor(
      car,
      entry('car', 0),
      ctx({ liveOrg: 'solo', orgPlan: { to: 'carpool', at: at(-1), why: '恢复了' } }),
    );
    expect(late[0]).toMatchObject({ wait: 'org', until: null });
  });

  it('引擎不打算切过去（to 是另一个或空）：硬挡，写明为什么不切', () => {
    for (const to of ['carpool', null] as const) {
      const blocks = blocksFor(
        solo,
        entry('solo', 0),
        ctx({ orgPlan: { to, at: null, why: '挂着拼车，拼车额度没用满' } }),
      );
      expect(blocks.map((b) => b.code)).toEqual(['org-not-live']);
      expect(blocks[0]?.text).toBe(
        '会话用户现在挂的是拼车组织，独享号要等切过去才能派；引擎现在不打算切过去（挂着拼车，拼车额度没用满）',
      );
      expect(groupOf(blocks)).toEqual({ kind: 'hard' });
    }
  });

  it('整池暂停着的（pool-hold）：就算引擎打算切过去也照样硬挡（避开整池是硬挡）', () => {
    const blocks = blocksFor(
      solo,
      entry('solo', 0),
      ctx({
        avoid: {
          routeIds: new Set(),
          poolIds: new Set(['pool-solo']),
          modelIds: new Set(),
          families: new Set(),
        },
        orgPlan: { to: 'solo', at: null, why: '切' },
      }),
    );
    expect(blocks.map((b) => b.code)).toEqual(['avoided', 'org-not-live']);
    expect(groupOf(blocks)).toEqual({ kind: 'hard' });
  });
});

describe('探针在另一个组织挂着时没探的（skipped、probeOrg 是另一个组织，#335）', () => {
  const skipped = (over: Partial<RouteFacts> = {}) =>
    route('car', {
      orgKind: 'carpool',
      poolName: '拼车号',
      blockers: ['offline'],
      probeState: 'skipped',
      probeOrg: 'solo',
      probedAt: at(-0.1),
      ...over,
    });

  it('现在挂的正是它的组织：不当成坏了，等下一轮探针在这个组织下探过（最早上次结论之后一轮）', () => {
    const blocks = blocksFor(skipped(), entry('car', 0), ctx());
    expect(blocks).toEqual([
      {
        code: 'offline',
        text: `探针上一次看它（2026-09-24 23:54 UTC）时会话用户挂的是独享组织，没探它；现在挂的是拼车组织，等下一轮路由探针在拼车组织下探过再派`,
        wait: 'probe',
        until: new Date(Date.parse(at(-0.1)) + 15 * 60_000).toISOString(),
      },
    ]);
    expect(groupOf(blocks)).toMatchObject({ kind: 'wait', waitFor: 'probe' });
    // 下一轮该探的时刻过了还没新结论：时刻不给，按轮询再看
    expect(blocksFor(skipped({ probedAt: at(-0.5) }), entry('car', 0), ctx())[0]).toMatchObject({
      wait: 'probe',
      until: null,
    });
  });

  it('【故意造出的失败】过了探针的过期线还没探到：按不在线硬挡，写明探针可能停了', () => {
    const blocks = blocksFor(skipped({ probedAt: at(-1) }), entry('car', 0), ctx());
    expect(blocks.map((b) => b.code)).toEqual(['offline']);
    expect(blocks[0]?.text).toContain('之后 1 小时探针都没再探它（探针可能停了），按不在线算');
    expect(groupOf(blocks)).toEqual({ kind: 'hard' });
  });

  it('【故意造出的失败】别的不在线照老样子硬挡：探了没通、探针那时组织认不出、探的时候就是它的组织、没给结论', () => {
    for (const over of [
      { probeState: 'failed' as const },
      { probeOrg: null },
      { probeOrg: 'carpool' as const },
      { probeState: null },
      { probedAt: null },
    ]) {
      const blocks = blocksFor(skipped(over), entry('car', 0), ctx());
      expect(blocks).toEqual([
        { code: 'offline', text: '不在线（探活或熔断判的）', wait: null, until: null },
      ]);
    }
  });

  it('现在挂的还是另一个组织：照样不在线，另加「要等切过去」', () => {
    const blocks = blocksFor(skipped(), entry('car', 0), ctx({ liveOrg: 'solo' }));
    expect(blocks.map((b) => [b.code, b.wait])).toEqual([
      ['offline', null],
      ['org-not-live', null],
    ]);
  });
});

describe('候选查询给的被挡原因', () => {
  it('没被挡的能派', () => {
    expect(codes(route('a'))).toEqual([]);
  });

  it.each([
    ['offline', '不在线'],
    ['channel-disabled', '渠道关了'],
    ['pool-expired', '订阅过期'],
    ['model-retired', '模型已下架'],
  ] as const)('%s 是硬挡，带白话', (code, text) => {
    const blocks = blocksFor(route('a', { blockers: [code] }), entry('a', 0), ctx());
    expect(blocks.map((b) => b.code)).toEqual([code]);
    expect(blocks[0]?.text).toContain(text);
    expect(groupOf(blocks)).toEqual({ kind: 'hard' });
  });

  it('no-slot 不算坏：等空位', () => {
    const blocks = blocksFor(route('a', { blockers: ['no-slot'], inFlight: 5 }), entry('a', 0), ctx());
    expect(blocks.map((b) => b.code)).toEqual(['no-slot']);
    expect(blocks[0]?.text).toContain('5/5');
    expect(groupOf(blocks)).toEqual({ kind: 'wait', waitFor: 'slot', until: null });
  });

  it('quota-exhausted 等额度：最早能派 = 用满的窗口里最晚清零的那个', () => {
    const r = route('a', {
      quota: 'exhausted',
      blockers: ['quota-exhausted'],
      windows: [
        win({ label: '5h', window: '5h', state: 'exhausted', used: 1, resetsAt: at(2) }),
        win({ label: '7d', state: 'exhausted', used: 1, resetsAt: at(30) }),
      ],
    });
    const blocks = blocksFor(r, entry('a', 0), ctx());
    expect(groupOf(blocks)).toEqual({ kind: 'wait', waitFor: 'quota', until: Date.parse(at(30)) });
  });

  it('用满的窗口不知道清零时刻：最早能派也不知道（不编一个）', () => {
    const r = route('a', {
      quota: 'exhausted',
      blockers: ['quota-exhausted'],
      windows: [win({ state: 'exhausted', used: 1, resetsAt: null })],
    });
    expect(groupOf(blocksFor(r, entry('a', 0), ctx()))).toEqual({
      kind: 'wait',
      waitFor: 'quota',
      until: null,
    });
  });

  it('额度没读成的池不挡', () => {
    expect(codes(route('a', { quota: 'unknown', windows: [] }))).toEqual([]);
  });
});

describe('禁令用 shared 的硬禁令，候选查询漏了也挡', () => {
  it('Fable 不再是硬禁令（决定 0033）：开着、在用途里就不挡；创始人没打开（开关关着）才挡，挡在开关上', () => {
    const r = route('f', { modelId: 'x-5.1', modelName: 'Fable 5.1' });
    expect(blocksFor(r, entry('f', 0), ctx())).toEqual([]);
    const closed = blocksFor(r, entry('f', 0, { enabled: false }), ctx());
    expect(closed.map((b) => b.code)).toEqual(['switched-off']);
  });

  it('GPT 在 UI 阶段挡，在写码阶段不挡', () => {
    const gpt = route('g', {
      modelId: 'gpt-5.6-luna',
      modelName: 'GPT 5.6 luna',
      family: 'gpt',
      hostId: 'codex',
    });
    expect(codes(gpt, ctx({ stage: 'ui' }))).toEqual(['banned']);
    expect(codes(gpt, ctx({ stage: 'execute' }))).toEqual([]);
  });

  it('界面类的活（验证一个改了页面的改动）：不管哪个阶段，GPT 都挡（GPT 不审界面）；别的族不挡', () => {
    const gpt = route('g', { modelId: 'gpt-5.6-luna', modelName: 'GPT 5.6 luna', family: 'gpt' });
    expect(codes(gpt, ctx({ stage: 'verify', uiWork: true }))).toEqual(['banned']);
    expect(codes(gpt, ctx({ stage: 'verify', uiWork: false }))).toEqual([]);
    expect(codes(route('k', { family: 'kimi' }), ctx({ stage: 'verify', uiWork: true }))).toEqual([]);
  });

  it('库里的禁令原因照写，不重复', () => {
    const r = route('k', { blockers: ['banned'], banReasons: ['创始人另加：Kimi 不做审查'] });
    const blocks = blocksFor(r, entry('k', 0), ctx({ stage: 'review' }));
    expect(blocks.map((b) => b.text)).toEqual(['犯禁令：创始人另加：Kimi 不做审查']);
  });

  it('目录里写成 opus、上游串或别名却是 GPT：UI 阶段照样挡；上游串正常不挡', () => {
    const ui = ctx({ stage: 'ui' });
    const viaUpstream = route('o', { upstreamModel: 'gpt-5.6' });
    expect(codes(viaUpstream, ui)).toEqual(['banned']);
    const viaAlias = route('o', { upstreamModel: 'claude-opus-5-5', upstreamAliases: ['gpt-5.6'] });
    expect(codes(viaAlias, ui)).toEqual(['banned']);
    expect(codes(route('o', { upstreamModel: 'claude-opus-5-5', upstreamAliases: ['opus'] }), ui)).toEqual(
      [],
    );
    // 上游串是 Fable 不挡（决定 0033）
    expect(codes(route('o', { upstreamModel: 'claude-fable-5-1' }))).toEqual([]);
  });
});

describe('单条开关', () => {
  it('关着的不派；开着的派', () => {
    expect(codes(route('a'), ctx(), entry('a', 0, { enabled: false }))).toEqual(['switched-off']);
    expect(codes(route('a'), ctx(), entry('a', 0, { enabled: true }))).toEqual([]);
  });

  it('候选查询说关着也挡（它按同一个开关算）；两边都说只记一条', () => {
    const off = route('a', { blockers: ['switched-off'] });
    const blocks = blocksFor(off, entry('a', 0), ctx());
    expect(blocks).toEqual([
      { code: 'switched-off', text: '这条路由在它的模型下关着（路由两层的开关）', wait: null, until: null },
    ]);
    expect(codes(off, ctx(), entry('a', 0, { enabled: false }))).toEqual(['switched-off']);
  });
});

describe('执行方式 × 阶段是数据', () => {
  it('每个阶段都写了要什么，每个执行方式都写了会什么', () => {
    expect(Object.keys(STAGE_NEEDS).sort()).toEqual(
      ['execute', 'groom', 'judge', 'plan', 'research', 'review', 'spec', 'triage', 'ui', 'verify'].sort(),
    );
    // 整理待办（groom，#1338）读仓库、读单子、跑只读命令，不改文件：接口外壳（只会答题）挡，命令行类都行
    expect(STAGE_NEEDS.groom).toEqual(['read', 'shell']);
    expect(Object.keys(HOST_ABILITIES).sort()).toEqual(
      ['api-shell', 'claude-code', 'codex', 'cursor-agent', 'grok', 'mirasim'].sort(),
    );
  });

  it('写码、UI 要能改文件：接口外壳挡；判断题、分诊接口外壳和命令行都行', () => {
    expect(hostUnfit('api-shell', 'execute')).toContain('改文件');
    expect(hostUnfit('api-shell', 'ui')).toContain('改文件');
    expect(hostUnfit('api-shell', 'judge')).toBeNull();
    expect(hostUnfit('api-shell', 'groom')).not.toBeNull();
    expect(hostUnfit('claude-code', 'groom')).toBeNull();
    expect(hostUnfit('api-shell', 'triage')).toBeNull();
    expect(hostUnfit('claude-code', 'judge')).toBeNull();
    expect(hostUnfit('cursor-agent', 'execute')).toBeNull();
  });

  it('认不出的执行方式挡（不当它什么都会）', () => {
    expect(codes(route('x', { hostId: 'teleport' as never }))).toEqual(['host-unfit']);
  });
});

describe('熔断', () => {
  it('none 挡，等到试探时刻', () => {
    const r = route('a', {
      breaker: { state: 'open', admit: 'none', reason: '连续失败 3 次', probeAt: at(0.2) },
    });
    const blocks = blocksFor(r, entry('a', 0), ctx());
    expect(groupOf(blocks)).toEqual({ kind: 'wait', waitFor: 'breaker', until: Date.parse(at(0.2)) });
  });

  it('trial 放（已经有试探在途时熔断自己判 none）；all 放', () => {
    expect(
      codes(route('a', { breaker: { state: 'half_open', admit: 'trial', reason: '冷却到点' } })),
    ).toEqual([]);
    expect(codes(route('a'))).toEqual([]);
  });

  it('半开、已经有试探在跑（真熔断函数算的）：试探时刻早过了，不给过去的时刻，等试探结果', () => {
    const breaker = halfOpenBreaker(1, 'a');
    expect(breaker).toMatchObject({ state: 'half_open', admit: 'none' });
    expect(Date.parse(breaker.probeAt as string)).toBeLessThan(Date.parse(NOW));
    const blocks = blocksFor(route('a', { breaker }), entry('a', 0), ctx());
    expect(blocks.map((b) => [b.code, b.until])).toEqual([['breaker-open', null]]);
    expect(blocks[0]?.text).toMatch(/^熔断：等试探结果（/);
    expect(groupOf(blocks)).toEqual({ kind: 'wait', waitFor: 'breaker', until: null });
    // 没有在跑的：放这一单当试探。
    expect(codes(route('a', { breaker: halfOpenBreaker(0, 'a') }))).toEqual([]);
  });
});

describe('最早几点能好：一定晚于现在', () => {
  it('用满的窗口清零时刻已经过了（读数慢了一步）：不给过去的时刻，等下一次读数', () => {
    const r = route('a', {
      quota: 'exhausted',
      blockers: ['quota-exhausted'],
      windows: [win({ state: 'exhausted', used: 1, resetsAt: at(-0.1) })],
    });
    const blocks = blocksFor(r, entry('a', 0), ctx());
    expect(blocks.map((b) => [b.code, b.until])).toEqual([['quota-exhausted', null]]);
    expect(blocks[0]?.text).toContain('清零时刻已过，等下一次读数');
  });

  it('剩余不够的窗口清零时刻已经过了：同样不给过去的时刻', () => {
    const r = route('a', { windows: [win({ label: '5h', window: '5h', used: 0.99, resetsAt: at(-0.1) })] });
    const blocks = blocksFor(r, entry('a', 0), ctx());
    expect(blocks.map((b) => [b.code, b.until])).toEqual([['quota-short', null]]);
    expect(blocks[0]?.text).toContain('清零时刻已过，等下一次读数');
  });
});

describe('一条路由挡在几处', () => {
  it('有一条硬挡就是硬挡，哪怕另有等得来的（等来了也还是派不了）', () => {
    const blocks = blocksFor(
      route('a', { blockers: ['offline', 'no-slot'], inFlight: 5 }),
      entry('a', 0),
      ctx(),
    );
    expect(blocks.map((b) => b.code)).toEqual(['offline', 'no-slot']);
    expect(groupOf(blocks)).toEqual({ kind: 'hard' });
  });

  it('等额度 1 小时、又熔断 2 小时：两样都解除才派得出去，最早 2 小时后', () => {
    const r = route('a', {
      quota: 'exhausted',
      blockers: ['quota-exhausted'],
      windows: [win({ state: 'exhausted', used: 1, resetsAt: at(1) })],
      breaker: { state: 'open', admit: 'none', reason: '连续失败 3 次', probeAt: at(2) },
    });
    expect(groupOf(blocksFor(r, entry('a', 0), ctx()))).toEqual({
      kind: 'wait',
      waitFor: 'quota',
      until: Date.parse(at(2)),
    });
  });

  it('等额度 1 小时、又差空位：1 小时之前一定派不了，到时候再看空位', () => {
    const r = route('a', {
      quota: 'exhausted',
      blockers: ['quota-exhausted', 'no-slot'],
      inFlight: 5,
      windows: [win({ state: 'exhausted', used: 1, resetsAt: at(1) })],
    });
    expect(groupOf(blocksFor(r, entry('a', 0), ctx()))).toEqual({
      kind: 'wait',
      waitFor: 'quota',
      until: Date.parse(at(1)),
    });
  });

  it('额度 3 天后才清零、又在等试探结果：3 天之内一定派不了，最早 3 天后（不因为试探时刻不知道就每 30 秒轮询 3 天）', () => {
    const r = route('a', {
      quota: 'exhausted',
      blockers: ['quota-exhausted'],
      windows: [win({ state: 'exhausted', used: 1, resetsAt: at(72) })],
      breaker: halfOpenBreaker(1, 'a'),
    });
    expect(groupOf(blocksFor(r, entry('a', 0), ctx()))).toEqual({
      kind: 'wait',
      waitFor: 'quota',
      until: Date.parse(at(72)),
    });
  });

  it('只有时刻不知道的原因：不知道', () => {
    const r = route('a', { breaker: halfOpenBreaker(1, 'a'), blockers: ['no-slot'], inFlight: 5 });
    expect(groupOf(blocksFor(r, entry('a', 0), ctx()))).toEqual({
      kind: 'wait',
      waitFor: 'breaker',
      until: null,
    });
  });
});

describe('额度够收尾：所有路由都判（design §九 选路第 1 条）', () => {
  const solo = (o: Partial<RouteFacts> = {}) => route('solo', { poolName: '独享号', ...o });
  const fiveHour = (used: number, extra: Partial<RouteWindow> = {}) =>
    win({ label: '5h', window: '5h', used, resetsAt: at(2), ...extra });

  it('独享号 5 小时窗只剩 1%：写码重活不派，等它清零（审查实测照派了）', () => {
    const blocks = blocksFor(solo({ windows: [fiveHour(0.99), win()] }), entry('solo', 0), ctx());
    expect(blocks.map((b) => b.code)).toEqual(['quota-short']);
    expect(blocks[0]?.text).toBe('独享号5 小时额度只剩 1%，不够跑一个活（要 10%），2 小时后清零');
    expect(groupOf(blocks)).toEqual({ kind: 'wait', waitFor: 'quota', until: Date.parse(at(2)) });
  });

  it('够就派；正好剩一成也算够（1 − 0.9 算出来是 0.0999…）', () => {
    expect(codes(solo({ windows: [fiveHour(0.5), win()] }))).toEqual([]);
    expect(codes(solo({ windows: [fiveHour(0.9), win()] }))).toEqual([]);
  });

  it('判不了扣不扣的窗口不在这里挡（那是额度未知，排后面）', () => {
    const r = solo({ quota: 'unknown', windows: [fiveHour(0.99, { applies: 'unknown' }), win()] });
    expect(codes(r)).toEqual([]);
  });

  it('读数过期、算不出剩多少的窗口也不在这里挡', () => {
    expect(codes(solo({ quota: 'unknown', windows: [fiveHour(0.99, { state: 'stale' })] }))).toEqual([]);
    expect(codes(solo({ windows: [fiveHour(0.99, { used: null })] }))).toEqual([]);
  });

  it('已经用满的只记一条用满，不再记不够', () => {
    const r = solo({
      quota: 'exhausted',
      blockers: ['quota-exhausted'],
      windows: [fiveHour(1, { state: 'exhausted' }), win({ used: 0.99 })],
    });
    expect(codes(r)).toEqual(['quota-exhausted']);
  });
});

describe('已选定、还没开工的也占位子（一批任务同时选路）', () => {
  it('在跑 3 个 + 已选定 2 个 = 上限 5，候选查询没标 no-slot 也等空位；已选定 1 个放', () => {
    const blocks = blocksFor(route('a', { inFlight: 3, reserved: 2 }), entry('a', 0), ctx());
    expect(blocks.map((b) => b.code)).toEqual(['no-slot']);
    expect(blocks[0]?.text).toBe('池a并发满了（已经有 5 个（在跑 3 个、已选定还没开工 2 个），上限 5 个）');
    expect(codes(route('a', { inFlight: 3, reserved: 1 }))).toEqual([]);
  });
});

describe('避开', () => {
  it('按路由、池、模型避开；不相干的不挡', () => {
    const avoid = (a: Partial<FilterContext['avoid']>) =>
      ctx({
        avoid: { routeIds: new Set(), poolIds: new Set(), modelIds: new Set(), families: new Set(), ...a },
      });
    expect(codes(route('a'), avoid({ routeIds: new Set(['a']) }))).toEqual(['avoided']);
    expect(codes(route('a'), avoid({ poolIds: new Set(['pool-a']) }))).toEqual(['avoided']);
    expect(codes(route('a'), avoid({ modelIds: new Set(['opus-5.5']) }))).toEqual(['avoided']);
    expect(codes(route('a'), avoid({ routeIds: new Set(['b']) }))).toEqual([]);
  });

  it('开 PR 前验证只派别家：写这张单的族整族避开（族名不分大小写），别的族照派', () => {
    const avoid = ctx({
      stage: 'verify',
      avoid: { routeIds: new Set(), poolIds: new Set(), modelIds: new Set(), families: new Set(['claude']) },
    });
    const blocks = blocksFor(route('a', { family: ' Claude ' }), entry('a', 0), avoid);
    expect(blocks.map((b) => b.code)).toEqual(['avoided']);
    expect(blocks[0]?.text).toContain('只派别家');
    expect(codes(route('k', { family: 'kimi', modelName: 'Kimi k3' }), avoid)).toEqual([]);
  });

  it('【故意造出的失败】只派别家时，渠道自己挑模型的（上游串或别名是 auto）认不出是哪一家：不派；不验证时照派', () => {
    const verifying = ctx({
      stage: 'verify',
      avoid: { routeIds: new Set(), poolIds: new Set(), modelIds: new Set(), families: new Set(['claude']) },
    });
    const auto = route('c', { family: 'cursor', modelName: 'Cursor Auto', upstreamModel: 'auto' });
    const blocks = blocksFor(auto, entry('c', 0), verifying);
    expect(blocks.map((b) => b.code)).toEqual(['avoided']);
    expect(blocks[0]?.text).toBe(
      '这一步只派别家：Cursor Auto 由渠道自己挑模型（上游串 auto），认不出这次是哪一家在答',
    );
    expect(codes(route('o', { family: 'gpt', upstreamModel: 'openrouter/auto' }), verifying)).toEqual([
      'avoided',
    ]);
    expect(
      codes(route('d', { family: 'cursor', upstreamModel: 'x', upstreamAliases: ['Auto'] }), verifying),
    ).toEqual(['avoided']);
    // 钉住型号的照派；不验证（没有要避开的族）时 auto 照派
    expect(codes(route('p', { family: 'cursor', upstreamModel: 'gpt-5.6-autopilot' }), verifying)).toEqual(
      [],
    );
    expect(codes(auto, ctx({ stage: 'verify' }))).toEqual([]);
  });
});

describe('拼车号不再是备池（#59：两个会话用户同时跑时的主池、备池规则删掉）', () => {
  const carpool = (o: Partial<RouteFacts> = {}) =>
    route('c', { poolName: '拼车号', orgKind: 'carpool', ...o });

  it('写码这种重活照派；在跑几个按池自己的并发上限，不再压到 2', () => {
    expect(codes(carpool())).toEqual([]);
    expect(codes(carpool({ inFlight: 4 }))).toEqual([]);
    expect(codes(carpool({ inFlight: 5 }))).toEqual(['no-slot']);
  });

  it('额度未知照派，已经有一个在跑也不等它（额度未知的排后面，rank.ts）', () => {
    expect(codes(carpool({ quota: 'unknown', windows: [], inFlight: 1 }))).toEqual([]);
  });

  it('【#194 方案 4.3】拼车池不按「够收尾」挡：周窗只剩 2%、5 小时窗只剩 5% 也照派，用到被拒为止（死区消失）', () => {
    expect(codes(carpool({ windows: [win({ used: 0.98 })] }))).toEqual([]);
    expect(
      codes(carpool({ windows: [win({ label: '5h', window: '5h', used: 0.95, resetsAt: at(1) })] })),
    ).toEqual([]);
  });

  it('【故意造出的失败】拼车池真用满了（exhausted）仍然挡：不拿活去撞用满的号', () => {
    expect(codes(carpool({ blockers: ['quota-exhausted'], windows: [win({ used: 1 })] }))).toEqual([
      'quota-exhausted',
    ]);
  });

  it('独享池照旧按「够收尾」判：周窗只剩 2% 不派（一个活要 3%）', () => {
    const solo = (o: Partial<RouteFacts> = {}) => route('s', { poolName: '独享号', orgKind: 'solo', ...o });
    expect(codes(solo({ windows: [win({ used: 0.98 })] }), ctx({ liveOrg: 'solo' }))).toEqual([
      'quota-short',
    ]);
  });

  it('独享：池级读数过期、但会话里顺手读到的窗口还新：读到了不够就等它清零，不拿活去撞', () => {
    // 候选查询：池的最近读成超过 30 分钟 → quota unknown；窗口本身是 10 分钟前从会话流里读到的。
    const passive = (used: number) =>
      route('s', {
        poolName: '独享号',
        orgKind: 'solo',
        quota: 'unknown',
        windows: [win({ label: '5h', window: '5h', used, resetsAt: at(1) }), win({ used: 0.4 })],
      });
    const short = blocksFor(passive(0.95), entry('s', 0), ctx({ liveOrg: 'solo' }));
    expect(short.map((b) => b.code)).toEqual(['quota-short']);
    expect(groupOf(short)).toEqual({ kind: 'wait', waitFor: 'quota', until: Date.parse(at(1)) });
    expect(codes(passive(0.5), ctx({ liveOrg: 'solo' }))).toEqual([]);
  });
});

describe('渠道不可用、切回宽限（#194）', () => {
  const claude = (kind: 'carpool' | 'solo') => route('c', { poolName: '拼车号', orgKind: kind });
  const withPlan = (plan: NonNullable<FilterContext['orgPlan']>, liveOrg: 'carpool' | 'solo') => ({
    ...ctx(),
    liveOrg,
    orgPlan: plan,
  });

  it('【故意造出的失败】渠道不可用：不管挂着哪个，带组织类型的池一律不派，写明原因；不带组织类型的路由不受影响', () => {
    const plan = { to: null, at: null, why: '不切', channelDown: '没有一个可用账号' };
    for (const live of ['carpool', 'solo'] as const) {
      const blocks = blocksFor(claude(live), entry('c', 0), withPlan(plan, live));
      expect(blocks.map((b) => b.code)).toEqual(['org-not-live']);
      expect(blocks[0]?.text).toContain('渠道不可用');
      expect(blocks[0]?.wait).toBeNull();
    }
    expect(codes(route('g'))).toEqual([]);
  });

  it('切回宽限中：挂着的这一类池新活先不派（等切号，任务不挂起）；另一类和没在宽限时的照常', () => {
    const plan = { to: 'carpool' as const, at: null, why: '切回拼车', drain: 'solo' as const };
    const drained = blocksFor(claude('solo'), entry('c', 0), withPlan(plan, 'solo'));
    expect(drained.map((b) => b.code)).toEqual(['org-not-live']);
    expect(drained[0]?.wait).toBe('org');
    expect(drained[0]?.text).toContain('宽限');
    // 没给 drain：照常
    expect(
      blocksFor(claude('solo'), entry('c', 0), withPlan({ to: 'carpool', at: null, why: 'x' }, 'solo')),
    ).toEqual([]);
  });
});

describe('额度留量线（#194 方案 4.8）：线只来自库里的设置，代码里没有默认值', () => {
  const solo = (windows: RouteWindow[], over: Partial<RouteFacts> = {}) =>
    route('solo', { orgKind: 'solo', poolId: 'claude-solo', poolName: '独享号', windows, ...over });
  const five = (used: number, over: Partial<RouteWindow> = {}) =>
    win({ label: '5h', window: '5h', used, resetsAt: at(3), ...over });
  const week = (used: number, over: Partial<RouteWindow> = {}) => win({ used, resetsAt: at(72), ...over });
  const lines = { 'claude-solo': { '5h': 0.8, '7d': 0.7 } };
  const withLines = (setting: unknown) => ctx({ liveOrg: 'solo', quotaReserve: { setting } });

  it('周窗已用 75%、线 70%：不再派新活，等清零（等得来，写明哪条线、几点清零）', () => {
    const blocks = blocksFor(solo([five(0.2), week(0.75)]), entry('solo', 0), withLines(lines));
    expect(blocks.map((b) => [b.code, b.wait])).toEqual([['quota-reserve', 'quota']]);
    expect(blocks[0]?.text).toContain('独享号周额度用了 75%，到了留量线 70%');
    expect(blocks[0]?.until).toBe(at(72));
    expect(groupOf(blocks)).toEqual({ kind: 'wait', waitFor: 'quota', until: Date.parse(at(72)) });
  });

  it('5 小时窗到线同样挡；两条都到线一条块里都写；没到线照派', () => {
    expect(codes(solo([five(0.8), week(0.1)]), withLines(lines))).toEqual(['quota-reserve']);
    const both = blocksFor(solo([five(0.9), week(0.9)]), entry('solo', 0), withLines(lines));
    expect(both).toHaveLength(1);
    expect(both[0]?.text).toContain('5 小时额度');
    expect(both[0]?.text).toContain('周额度');
    expect(codes(solo([five(0.79), week(0.69)]), withLines(lines))).toEqual([]);
  });

  it('这个池库里没写线 = 不限：用 99% 也不被留量线挡（别家、拼车不设线）', () => {
    // 99% 会被另一条规矩（额度够收尾）挡，这里只看留量线这一条
    const reserveOnly = (r: RouteFacts, c: FilterContext) => codes(r, c).filter((x) => x === 'quota-reserve');
    expect(reserveOnly(solo([five(0.99), week(0.99)]), withLines({}))).toEqual([]);
    expect(reserveOnly(solo([five(0.99), week(0.99)]), withLines({ other: { '5h': 0.1 } }))).toEqual([]);
    // 明确写 null 也是不限
    expect(
      reserveOnly(solo([five(0.99), week(0.99)]), withLines({ 'claude-solo': { '5h': null, '7d': null } })),
    ).toEqual([]);
  });

  it('改线马上生效：把周窗线调到 90%，75% 就能派', () => {
    expect(codes(solo([week(0.75)]), withLines({ 'claude-solo': { '7d': 0.9 } }))).toEqual([]);
  });

  it('旧读数（stale）已超线照挡；清零时刻不知道：等待时刻为空、按轮询再看', () => {
    expect(codes(solo([week(0.8, { state: 'stale' })]), withLines(lines))).toEqual(['quota-reserve']);
    const b = blocksFor(solo([week(0.8, { resetsAt: null })]), entry('solo', 0), withLines(lines));
    expect(b[0]).toMatchObject({ code: 'quota-reserve', wait: 'quota', until: null });
    expect(b[0]?.text).toContain('清零时刻不知道');
  });

  it('【故意造出的失败】库里没有这一行（种子没装上，setting 是 undefined）：每个池都硬挡，不当成不限', () => {
    for (const r of [solo([week(0.1)]), route('cursor', { poolId: 'cursor-pool' })]) {
      const blocks = blocksFor(r, entry(r.routeId, 0), withLines(undefined));
      expect(blocks.map((b) => [b.code, b.wait])).toEqual([['quota-reserve', null]]);
      expect(blocks[0]?.text).toContain('没装进库');
    }
  });

  it('【故意造出的失败】线是负数、大于 1、字符串、整份不是对象：硬挡，写明原因，不当成不限也不当成 0', () => {
    const bads = [
      { 'claude-solo': { '7d': -0.2 } },
      { 'claude-solo': { '7d': 1.5 } },
      { 'claude-solo': { '7d': 'x' } },
      'on',
      [1],
    ];
    for (const bad of bads) {
      const blocks = blocksFor(solo([week(0.1)]), entry('solo', 0), withLines(bad));
      expect(
        blocks.map((b) => [b.code, b.wait]),
        JSON.stringify(bad),
      ).toEqual([['quota-reserve', null]]);
      expect(blocks[0]?.text).toContain('读不到或认不出');
    }
    // 只有这个池那一项坏了：别的池不受影响
    expect(
      codes(route('cursor', { poolId: 'cursor-pool' }), withLines({ 'claude-solo': { '7d': -1 } })),
    ).toEqual([]);
  });

  it('读数缺配了线的窗口 / 没给已用多少：额度未知，照现有规矩不挡（不是到线）', () => {
    expect(codes(solo([five(0.1)]), withLines(lines))).toEqual([]);
    expect(codes(solo([week(0.1, { used: null })]), withLines(lines))).toEqual([]);
  });

  it('不给 quotaReserve（老输入、纯函数）：留量线不管；池已经用满另有原因、不重复', () => {
    expect(codes(solo([week(0.75)]), ctx({ liveOrg: 'solo' }))).toEqual([]);
    expect(codes(solo([week(0.99)], { blockers: ['quota-exhausted'] }), withLines(lines))).toEqual([
      'quota-exhausted',
    ]);
  });

  it('输入外壳认不出（不是 { setting }）：选路判不了，抛', () => {
    expect(() => chooseRoute(input([route('a')], { quotaReserve: 'oops' as never }))).toThrow(
      /额度留量线的输入认不出/,
    );
  });
});

describe('拼车并发登记核对不上：不往拼车池派（#896，方案第六节第 19 条）', () => {
  const car = (over: Partial<RouteFacts> = {}) =>
    route('car', { orgKind: 'carpool', poolId: 'claude-carpool', poolName: '拼车号', ...over });
  const solo = (over: Partial<RouteFacts> = {}) =>
    route('solo', { orgKind: 'solo', poolId: 'claude-solo', poolName: '独享号', ...over });
  const bad = (why: string) => ctx({ carpoolRegistry: { ok: false, why } });

  it('核对不上：拼车池硬挡、写明核对出的原因；对上了照派', () => {
    const blocks = blocksFor(car(), entry('car', 0), bad('登记的拼车并发上限是 2，库里拼车池加起来是 4'));
    expect(blocks.map((b) => [b.code, b.wait])).toEqual([['carpool-registry', null]]);
    expect(blocks[0]?.text).toContain('拼车号暂不派');
    expect(blocks[0]?.text).toContain('登记的拼车并发上限是 2，库里拼车池加起来是 4');
    expect(groupOf(blocks)).toEqual({ kind: 'hard' });
    expect(codes(car(), ctx({ carpoolRegistry: { ok: true } }))).toEqual([]);
  });

  it('只管拼车池：独享池、别家的池照派', () => {
    const c = { ...bad('没登记'), liveOrg: 'solo' as const };
    expect(codes(solo(), c)).toEqual([]);
    expect(codes(route('relay'), c)).toEqual([]);
  });

  it('不给（老输入、纯函数）：不判', () => {
    expect(codes(car())).toEqual([]);
  });

  it('选路：拼车排第一、核对不上 → 派给后面的路由，派工理由写明拼车为什么没派；核对对上了又回到拼车', () => {
    const routes = [car(), route('relay')];
    const withBad = chooseRoute(
      input(routes, { liveOrg: 'carpool', carpoolRegistry: { ok: false, why: '没登记' } }),
    );
    expect(withBad).toMatchObject({ kind: 'dispatch', routeId: 'relay' });
    expect(withBad.kind === 'dispatch' && withBad.why).toContain('拼车并发登记核对不上（没登记）');
    const good = chooseRoute(input(routes, { liveOrg: 'carpool', carpoolRegistry: { ok: true } }));
    expect(good).toMatchObject({ kind: 'dispatch', routeId: 'car' });
  });

  it('选路：只剩拼车池又核对不上 → 派不出（none），原因里有登记核对；点名拼车池的路由同样用不了、不偷偷换', () => {
    const only = chooseRoute(
      input([car()], { liveOrg: 'carpool', carpoolRegistry: { ok: false, why: '库里没有拼车池' } }),
    );
    expect(only.kind).toBe('none');
    expect(only.kind === 'none' && only.reason).toContain('库里没有拼车池');
    const named = chooseRoute(
      input([car(), route('relay')], {
        liveOrg: 'carpool',
        taskRouteId: 'car',
        carpoolRegistry: { ok: false, why: '写坏了' },
      }),
    );
    expect(named.kind).toBe('none');
    expect(named.kind === 'none' && named.reason).toContain('指定的路由用不了');
  });

  it('【故意造出的失败】核对的结论认不出（缺 why、不是对象、ok 不是布尔）：选路判不了、抛，不当成对上了', () => {
    for (const broken of [{ ok: false }, { ok: false, why: '  ' }, 'ok', null, { ok: 'yes' }, {}]) {
      expect(
        () => chooseRoute(input([car()], { liveOrg: 'carpool', carpoolRegistry: broken as never })),
        JSON.stringify(broken),
      ).toThrow(/拼车并发登记核对的结论认不出/);
    }
  });
});

describe('写码不派冷验收认不出作者族的路由（#1626）', () => {
  const cursor = route('cur', { family: 'cursor', modelName: 'Cursor Auto' });
  it('execute 阶段 cursor 族被挡，文字写明验不了', () => {
    const blocks = blocksFor(cursor, entry('cur', 0), ctx({ stage: 'execute' }));
    expect(blocks.map((b) => b.code)).toEqual(['banned']);
    expect(blocks[0]?.text).toContain('验不了');
  });
  it('ui 阶段上游串是 auto 的被挡', () => {
    const auto = route('auto', { family: 'other', upstreamModel: 'cursor:auto' });
    const blocks = blocksFor(auto, entry('auto', 0), ctx({ stage: 'ui' }));
    expect(blocks.map((b) => b.text).join()).toContain('验不了');
  });
  it('triage 阶段同一条 cursor 路由不被这条挡', () => {
    const blocks = blocksFor(cursor, entry('cur', 0), ctx({ stage: 'triage' }));
    expect(blocks.map((b) => b.text).join()).not.toContain('验不了');
  });
  it('execute 阶段 grok 族不受影响', () => {
    expect(codes(route('g', { family: 'grok' }), ctx({ stage: 'execute' }))).toEqual([]);
  });
});
