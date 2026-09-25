// 接近真实的几组场景：两个 Claude 池、Mirasim 模型组窗口、Cursor 两个桶、额度读不到、并发全满、额度全满、全被禁。
// 池名都是占位；数字取自 docs/reference/quota.md 的现场读数（比例），不带任何账号信息。
import { describe, expect, it } from 'vitest';
import { chooseRoute, type RouteFacts } from '../../src/routing/index.ts';
import { at, input, route, win } from './helpers.ts';

const solo = (extra: Partial<RouteFacts> = {}) =>
  route('solo-opus', { poolId: 'claude-solo', poolName: '独享号', ...extra });
const carpool = (extra: Partial<RouteFacts> = {}) =>
  route('carpool-opus', { poolId: 'claude-carpool', poolName: '拼车号', poolRole: 'backup', ...extra });

describe('两个 Claude 池：一个快清零，一个刚清零', () => {
  // 独享号周窗刚清零（用了 2%，还有近 7 天）；拼车号周窗 20 小时后清零、还剩 60%。
  const soloFresh = solo({
    windows: [
      win({ label: '5h', window: '5h', used: 0.05, resetsAt: at(4) }),
      win({ used: 0.02, resetsAt: at(167) }),
    ],
  });
  const carpoolSoon = carpool({
    windows: [
      win({ label: '5h', window: '5h', used: 0.1, resetsAt: at(2) }),
      win({ used: 0.4, resetsAt: at(20) }),
    ],
  });

  it('轻活（分诊）：先用快清零的拼车号，理由写清几点清零、还剩多少', () => {
    const r = chooseRoute(input([soloFresh, carpoolSoon], { stage: 'triage' }));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'carpool-opus' });
    if (r.kind === 'dispatch') expect(r.why).toContain('拼车号周额度 20 小时后清零、还剩 60%，提到最前');
  });

  it('重活（写码）：拼车号只接轻活，派独享号', () => {
    const r = chooseRoute(input([soloFresh, carpoolSoon], { stage: 'execute' }));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'solo-opus' });
  });

  it('任务标了轻重就按任务的：写码阶段的小活可以用拼车号', () => {
    const r = chooseRoute(input([soloFresh, carpoolSoon], { stage: 'execute', weight: 'light' }));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'carpool-opus' });
  });

  it('拼车号已经在跑 2 个：轻活也回到独享号', () => {
    const busy = { ...carpoolSoon, inFlight: 2 };
    expect(chooseRoute(input([soloFresh, busy], { stage: 'triage' }))).toMatchObject({
      routeId: 'solo-opus',
    });
  });

  it('只剩拼车号、它 5 小时窗只剩 5%：不派，等它清零', () => {
    const thin = carpool({
      windows: [
        win({ label: '5h', window: '5h', used: 0.95, resetsAt: at(1.5) }),
        win({ used: 0.4, resetsAt: at(20) }),
      ],
    });
    const r = chooseRoute(input([solo({ blockers: ['no-slot'], inFlight: 5 }), thin], { stage: 'triage' }));
    // 独享号等空位、拼车号等额度：先等空位（多半更快）。
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'slot' });
    const alone = chooseRoute(input([thin], { stage: 'triage' }));
    expect(alone).toMatchObject({ kind: 'wait', waitFor: 'quota', until: at(1.5) });
  });
});

describe('Mirasim 池只扣某一族的窗口', () => {
  // 账号级 5h / 7d 还有余；7d_claude 用满（只扣 Claude 族）。候选查询已按 windowAppliesTo 判好：
  // Opus 路由带上 7d_claude 并被挡，Kimi 路由根本不带这个窗口。
  const account = [
    win({ label: '5h', window: '5h', used: 0.008, resetsAt: at(3) }),
    win({ label: '7d', used: 0.557, resetsAt: at(100) }),
  ];
  const opus = route('mira-opus', {
    channelId: 'mirasim-cloud',
    poolId: 'mirasim',
    poolName: 'Mirasim 中转',
    hostId: 'mirasim',
    quota: 'exhausted',
    blockers: ['quota-exhausted'],
    windows: [
      ...account,
      win({
        label: '7d_claude',
        window: '7d_model',
        scope: 'claude',
        state: 'exhausted',
        used: 1,
        resetsAt: at(100),
      }),
    ],
  });
  const kimi = route('mira-kimi', {
    channelId: 'mirasim-cloud',
    poolId: 'mirasim',
    poolName: 'Mirasim 中转',
    hostId: 'mirasim',
    modelId: 'kimi-k3',
    modelName: 'Kimi k3',
    family: 'kimi',
    windows: account,
  });

  it('Claude 组用满只挡 Opus，Kimi 照常派', () => {
    const r = chooseRoute(input([opus, kimi]));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'mira-kimi' });
    if (r.kind === 'dispatch') expect(r.why).toContain('claude 周额度用满');
  });

  it('只剩 Opus 这条：等 Claude 组清零', () => {
    expect(chooseRoute(input([opus]))).toMatchObject({ kind: 'wait', waitFor: 'quota', until: at(100) });
  });
});

describe('Cursor 两个桶', () => {
  const cursor = (
    id: string,
    modelName: string,
    bucket: 'auto' | 'api',
    used: number,
    extra: Partial<RouteFacts> = {},
  ) =>
    route(id, {
      channelId: 'cursor',
      poolId: 'cursor',
      poolName: 'Cursor',
      hostId: 'cursor-agent',
      modelId: id,
      modelName,
      family: bucket === 'auto' ? 'cursor' : 'kimi',
      windows: [
        win({ label: `${bucket}_percent`, window: 'month_usd', scope: bucket, used, resetsAt: at(400) }),
      ],
      ...extra,
    });

  it('Auto 桶用满只挡 Cursor Auto；API 桶的 Kimi 照常', () => {
    const auto = cursor('cursor-auto', 'Cursor Auto', 'auto', 1, {
      quota: 'exhausted',
      blockers: ['quota-exhausted'],
    });
    auto.windows = auto.windows.map((w) => ({ ...w, state: 'exhausted' as const }));
    const r = chooseRoute(input([auto, cursor('cursor-kimi', 'Kimi k3', 'api', 0.4)]));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'cursor-kimi' });
    if (r.kind === 'dispatch') expect(r.why).toContain('月额度（auto）用满');
  });

  it('账期 30 小时后结束、Auto 桶还剩 80%：提到 Claude 前面，先把要作废的用掉', () => {
    const soon = cursor('cursor-auto', 'Cursor Auto', 'auto', 0.2);
    soon.windows = [
      win({ label: 'auto_percent', window: 'month_usd', scope: 'auto', used: 0.2, resetsAt: at(30) }),
    ];
    const r = chooseRoute(input([solo(), soon]));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'cursor-auto' });
    if (r.kind === 'dispatch') expect(r.why).toContain('月额度（auto） 30 小时后清零、还剩 80%');
  });
});

describe('额度读不到', () => {
  it('主池额度未知：不挡，但排在读到了的后面，理由写「额度未知」', () => {
    const unknownSolo = solo({ quota: 'unknown', windows: [] });
    const known = route('mira-opus', { poolName: 'Mirasim 中转', hostId: 'mirasim' });
    expect(chooseRoute(input([unknownSolo, known]))).toMatchObject({ routeId: 'mira-opus' });
    const r = chooseRoute(input([unknownSolo]));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'solo-opus' });
    if (r.kind === 'dispatch') expect(r.why).toContain('额度未知');
  });

  it('全部额度未知：照常按人排的顺序派', () => {
    const r = chooseRoute(
      input([solo({ quota: 'unknown', windows: [] }), route('b', { quota: 'unknown', windows: [] })]),
    );
    expect(r).toMatchObject({ routeId: 'solo-opus' });
  });

  it('备池额度未知：不派（判不了够不够跑一个活）', () => {
    const r = chooseRoute(input([carpool({ quota: 'unknown', windows: [] })], { stage: 'triage' }));
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'quota', until: null });
    if (r.kind === 'wait') expect(r.reason).toContain('额度未知');
  });
});

describe('全部并发满 / 全部额度满 / 全部被禁', () => {
  it('全部并发满：等空位', () => {
    const rs = [
      solo({ blockers: ['no-slot'], inFlight: 3, maxConcurrency: 3 }),
      route('b', { blockers: ['no-slot'] }),
    ];
    expect(chooseRoute(input(rs))).toMatchObject({ kind: 'wait', waitFor: 'slot', until: null });
  });

  it('全部额度满：等最早清零的那个', () => {
    const full = (id: string, hours: number | null) =>
      route(id, {
        quota: 'exhausted',
        blockers: ['quota-exhausted'],
        windows: [win({ state: 'exhausted', used: 1, resetsAt: hours === null ? null : at(hours) })],
      });
    const r = chooseRoute(input([full('a', 50), full('b', 8), full('c', null)]));
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'quota', until: at(8) });
    if (r.kind === 'wait') expect(r.reason).toContain('另有 1 条时刻不知道');
  });

  it('全部被禁（UI 阶段只挂了 GPT 和 Fable）：派不出，附每条原因', () => {
    const gpt = route('gpt-ui', {
      modelId: 'gpt-5.6-luna',
      modelName: 'GPT 5.6 luna',
      family: 'gpt',
      hostId: 'codex',
    });
    const fable = route('fable-ui', { modelId: 'fable-5.1', modelName: 'Fable 5.1' });
    const r = chooseRoute(input([gpt, fable], { stage: 'ui' }));
    expect(r.kind).toBe('none');
    if (r.kind === 'none') {
      expect(r.reason).toContain('GPT 不做 UI 类活');
      expect(r.reason).toContain('不用 Fable');
      expect(r.verdicts.map((v) => v.blocks.map((b) => b.code))).toEqual([['banned'], ['banned']]);
    }
  });
});
