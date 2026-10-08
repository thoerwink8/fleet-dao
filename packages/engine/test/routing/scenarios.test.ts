// 接近真实的几组场景：两个 Claude 池、Mirasim 模型组窗口、Cursor 两个桶、额度读不到、并发全满、额度全满、全被禁。
// 池名都是占位；数字取自 docs/reference/quota.md 的现场读数（比例），不带任何账号信息。
import { describe, expect, it } from 'vitest';
import { classifyFailure } from '../../src/failure/index.ts';
import { type ChooseRouteInput, chooseRoute, type RouteFacts } from '../../src/routing/index.ts';
import { at, entry, halfOpenBreaker, input, NOW, reserve, route, win } from './helpers.ts';

const solo = (extra: Partial<RouteFacts> = {}) =>
  route('solo-opus', { poolId: 'claude-solo', poolName: '独享号', ...extra });
const carpool = (extra: Partial<RouteFacts> = {}) =>
  route('carpool-opus', { poolId: 'claude-carpool', poolName: '拼车号', ...extra });

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

  it('先用快清零的拼车号，理由写清几点清零、还剩多少', () => {
    const r = chooseRoute(input([soloFresh, carpoolSoon], { stage: 'triage' }));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'carpool-opus' });
    if (r.kind === 'dispatch') expect(r.why).toContain('拼车号周额度 20 小时后清零、还剩 60%，提到最前');
  });

  it('不分轻活重活：写码、审查也先用快清零的拼车号（#59 删掉了「拼车号是备池、只接轻活」）', () => {
    for (const stage of ['execute', 'review'] as const) {
      expect(chooseRoute(input([soloFresh, carpoolSoon], { stage }))).toMatchObject({
        kind: 'dispatch',
        routeId: 'carpool-opus',
      });
    }
  });

  it('拼车号按它自己池的并发上限算，满了回到独享号（不再另压到 2 个）', () => {
    expect(chooseRoute(input([soloFresh, { ...carpoolSoon, inFlight: 2 }]))).toMatchObject({
      routeId: 'carpool-opus',
    });
    const full = { ...carpoolSoon, inFlight: 5 };
    expect(chooseRoute(input([soloFresh, full]))).toMatchObject({ routeId: 'solo-opus' });
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
    upstreamModel: 'claude-opus-5-5',
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

  it('账期 30 小时后结束、Auto 桶还剩 80%：它是后面的模型，不插到 Claude 前面（#1089）', () => {
    const soon = cursor('cursor-auto', 'Cursor Auto', 'auto', 0.2);
    soon.windows = [
      win({ label: 'auto_percent', window: 'month_usd', scope: 'auto', used: 0.2, resetsAt: at(30) }),
    ];
    const r = chooseRoute(input([solo(), soon]));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'solo-opus' });
    if (r.kind === 'dispatch') expect(r.why).not.toContain('清零');
  });
});

describe('额度读不到', () => {
  it('额度未知：不挡，但排在读到了的后面，理由写「额度未知」', () => {
    const unknownSolo = solo({ quota: 'unknown', windows: [] });
    const known = route('mira-opus', {
      poolName: 'Mirasim 中转',
      hostId: 'mirasim',
      upstreamModel: 'claude-opus-5-5',
    });
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
});

describe('拼车号额度读不到：照派、排在读到了的后面；被拒就一起避开到清零，切了号换池接着干', () => {
  // 独享号并发满了，拼车号的额度读取器坏了。
  const soloFull = () => solo({ blockers: ['no-slot'], inFlight: 5 });
  const blind = (inFlight = 0) => carpool({ quota: 'unknown', windows: [], inFlight });

  it('照派，理由写「额度未知」；已经有一个在跑也不等（不再是「备池只放一个试探」，#59 删掉）', () => {
    const r = chooseRoute(input([soloFull(), blind()], { stage: 'triage' }));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'carpool-opus', trial: null });
    if (r.kind === 'dispatch') {
      expect(r.why).toBe(
        '分诊阶段第 2 条：拼车号 · Opus 5.5 · Claude Code；额度未知（没读成或读数过期）；第 1 条 独享号 · Opus 5.5 · Claude Code：独享号并发满了（5/5）',
      );
    }
    expect(chooseRoute(input([soloFull(), blind(1)], { stage: 'execute' }))).toMatchObject({
      kind: 'dispatch',
      routeId: 'carpool-opus',
    });
  });

  it('独享号有空位：先去独享号（额度未知的排在读到了的后面）', () => {
    const r = chooseRoute(input([solo(), blind()], { stage: 'triage' }));
    expect(r).toMatchObject({ kind: 'dispatch', routeId: 'solo-opus', trial: null });
  });

  it('被拒：被拒的任务回去选路、等这个池（切了号就换池接着干），别的任务按读数里原文的时间一起避开，过了清零时刻照派', () => {
    // 2026-09-23 拼车号当场用满的真实原文（失败样本 X03）。Claude 订阅池不原地睡到清零：马上回去选路（QT1 的订阅池那一路）。
    const verdict = classifyFailure({
      source: 'session:triage',
      hostId: 'claude-code',
      poolId: 'claude-carpool',
      orgKind: 'carpool',
      routeId: 'carpool-opus',
      message:
        'API Error: Server is temporarily limiting requests (not your usage limit) · 拼车 5 小时额度已用完，约 20 分钟后重置，请稍后再来（请求 ID: <请求ID>）',
      now: NOW,
    });
    const until = at(20 / 60);
    expect(verdict).toMatchObject({
      rule: 'QT1',
      action: 'retry',
      delaySeconds: 0,
      resumeSame: true,
    });

    // 被拒原文记成一条读数（5 小时窗用满、清零取原文，adapters 的 claude-stream 读数就这么记），候选查询随之给出
    // quota-exhausted：续同一个会话的那个任务等这条路由到原文给的时刻，别的任务有独享号就去独享号。
    const rejected = (extra: Partial<RouteFacts> = {}) =>
      carpool({
        quota: 'exhausted',
        blockers: ['quota-exhausted'],
        windows: [win({ label: '5h', window: '5h', state: 'exhausted', used: null, resetsAt: until })],
        ...extra,
      });
    expect(
      chooseRoute(input([solo(), rejected()], { stage: 'triage', taskRouteId: 'carpool-opus' })),
    ).toMatchObject({ kind: 'wait', waitFor: 'quota', until });
    expect(chooseRoute(input([solo(), rejected()], { stage: 'triage' }))).toMatchObject({
      routeId: 'solo-opus',
    });

    // 会话用户切到独享组织（#157）：续的那条路由挡着（等也等不来），端口照常再选，派到独享号（会话端口换池 fork 续上）
    const orgSolo = solo({ orgKind: 'solo' });
    const orgCarpool = rejected({ orgKind: 'carpool' });
    const stuck = chooseRoute(
      input([orgSolo, orgCarpool], { stage: 'triage', taskRouteId: 'carpool-opus', liveOrg: 'solo' }),
    );
    expect(stuck).toMatchObject({ kind: 'none' });
    expect(chooseRoute(input([orgSolo, orgCarpool], { stage: 'triage', liveOrg: 'solo' }))).toMatchObject({
      kind: 'dispatch',
      routeId: 'solo-opus',
    });

    // 带上引擎切号的打算（#335）：挂着独享、拼车到点切回——续的那条拼车路由成了「等切号 + 等清零」，等得来；
    // 选路端口（real/store-ports.ts）见续会话的路由只差切号，不等它，照常再选（上面那样派到独享，换池 fork 续上）
    const planned = chooseRoute(
      input([orgSolo, orgCarpool], {
        stage: 'triage',
        taskRouteId: 'carpool-opus',
        liveOrg: 'solo',
        orgPlan: { to: 'carpool', at: until, why: '挂着独享；拼车到点才恢复，到点再切回' },
      }),
    );
    expect(planned).toMatchObject({ kind: 'wait', waitFor: 'quota', until });
    expect(planned.verdicts[0]?.blocks.map((b) => b.wait)).toEqual(['quota', 'org']);

    // 过了清零时刻：旧读数作废（候选查询判 reset → 额度未知），照派。
    const reset = carpool({
      quota: 'unknown',
      windows: [win({ label: '5h', window: '5h', state: 'reset', used: null, resetsAt: until })],
    });
    expect(chooseRoute(input([reset], { stage: 'triage', now: at(0.5) }))).toMatchObject({
      kind: 'dispatch',
      trial: null,
    });
  });
});

describe('只剩独享号一条时（审查实测的两处）', () => {
  const execute = (soloExtra: Partial<RouteFacts>) =>
    chooseRoute(input([solo(soloExtra)], { stage: 'execute' }));

  it('独享号 5 小时窗只剩 1%：不派过去，等它清零（额度够收尾，所有路由都判）', () => {
    const r = execute({
      windows: [win({ label: '5h', window: '5h', used: 0.99, resetsAt: at(2) }), win({ used: 0.3 })],
    });
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'quota', until: at(2) });
    if (r.kind === 'wait') expect(r.reason).toContain('独享号5 小时额度只剩 1%，不够跑一个活');
  });

  it('独享号熔断半开、已经有一个试探在跑：等试探结果；最早几点不给过去的时刻', () => {
    const r = execute({ breaker: halfOpenBreaker(1, 'solo-opus') });
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'breaker', until: null });
    if (r.kind === 'wait') expect(r.reason).toContain('在等熔断的试探结果');
  });
});

describe('一批任务同时来选路：已选定、还没开工的也占位子', () => {
  /** 端口的做法：每选定一条，就在同一个事务里记下（这个池的已选定数加一），下一个任务读到的是加过的。 */
  function batch(routes: RouteFacts[], n: number, stage: ChooseRouteInput['stage']): string[] {
    const out: string[] = [];
    let rs = routes;
    for (let i = 0; i < n; i += 1) {
      const r = chooseRoute(input(rs, { stage }));
      out.push(
        r.kind === 'dispatch'
          ? `${r.routeId}${r.trial ? `(${r.trial})` : ''}`
          : `${r.kind}:${r.kind === 'wait' ? r.waitFor : ''}`,
      );
      if (r.kind === 'dispatch') rs = reserve(rs, r.poolId);
    }
    return out;
  }
  const soloFull = () => solo({ blockers: ['no-slot'], inFlight: 5 });

  it('拼车号额度未知：按池自己的并发上限放（不再只放一个试探），满了等', () => {
    expect(
      batch([soloFull(), carpool({ quota: 'unknown', windows: [], maxConcurrency: 2 })], 3, 'triage'),
    ).toEqual(['carpool-opus', 'carpool-opus', 'wait:slot']);
  });

  it('独享号上限 2：三个重活同时来，第三个等空位', () => {
    expect(batch([solo({ maxConcurrency: 2 })], 3, 'execute')).toEqual([
      'solo-opus',
      'solo-opus',
      'wait:slot',
    ]);
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

  it('全部额度满：等最早清零的那个；有一条清零时刻不知道就按轮询间隔再看', () => {
    const full = (id: string, hours: number | null) =>
      route(id, {
        quota: 'exhausted',
        blockers: ['quota-exhausted'],
        windows: [win({ state: 'exhausted', used: 1, resetsAt: hours === null ? null : at(hours) })],
      });
    expect(chooseRoute(input([full('a', 50), full('b', 8)]))).toMatchObject({
      kind: 'wait',
      waitFor: 'quota',
      until: at(8),
    });
    // 时刻不知道的那条随时可能好（读数 30 分钟内会更新）：不拿 8 小时后的清零时刻去睡。
    const r = chooseRoute(input([full('a', 50), full('b', 8), full('c', null)]));
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'quota', until: null });
    if (r.kind === 'wait') expect(r.reason).toContain('清零时刻不知道，按轮询间隔再看');
  });

  it('全部被禁（UI 阶段挂了 GPT 和关着的 Fable）：派不出，附每条原因', () => {
    const gpt = route('gpt-ui', {
      modelId: 'gpt-5.6-luna',
      modelName: 'GPT 5.6 luna',
      family: 'gpt',
      hostId: 'codex',
    });
    const fable = route('fable-ui', { modelId: 'fable-5.1', modelName: 'Fable 5.1' });
    const r = chooseRoute(
      input([gpt, fable], {
        stage: 'ui',
        order: [entry('gpt-ui', 0), entry('fable-ui', 1, { enabled: false })],
      }),
    );
    expect(r.kind).toBe('none');
    if (r.kind === 'none') {
      expect(r.reason).toContain('GPT 不做 UI 类活');
      expect(r.reason).toContain('在它的模型下关着');
      expect(r.verdicts.map((v) => v.blocks.map((b) => b.code))).toEqual([['banned'], ['switched-off']]);
    }
  });
});

describe('09-27 21:54 那一次（#335）：人手动切到独享又切回，巡检单在最终审查挂起等人', () => {
  // 21:52 那一轮探针挂着拼车：拼车路由探通在线，独享路由写「现在挂拼车，不探」（skipped、探的时候挂的是拼车）
  const carpoolOk = carpool({ orgKind: 'carpool' });
  const soloSkipped = solo({
    orgKind: 'solo',
    blockers: ['offline'],
    probeState: 'skipped',
    probeOrg: 'carpool',
    probedAt: at(-0.03),
  });

  it('当时的判法（没有切号的打算、不知道独享那条是没探还是坏了）：两条都是硬挡——派不出，任务挂起等人', () => {
    const then = solo({ orgKind: 'solo', blockers: ['offline'], probedAt: at(-0.03) });
    const r = chooseRoute(input([carpoolOk, then], { liveOrg: 'solo' }));
    expect(r.kind).toBe('none');
  });

  it('现在：独享挂着、引擎打算切回拼车（和切号同一个判法），拼车等切号、独享等探针探一次——等得来，不挂起', () => {
    const r = chooseRoute(
      input([carpoolOk, soloSkipped], {
        liveOrg: 'solo',
        orgPlan: { to: 'carpool', at: null, why: '挂着独享；拼车没有用满的读数，切回拼车（平时挂拼车）' },
      }),
    );
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'org', until: null });
    expect(r.kind === 'wait' && r.reason).toContain('在等引擎切号');
    expect(r.verdicts.map((v) => v.blocks.map((b) => [b.code, b.wait]))).toEqual([
      [['org-not-live', 'org']],
      [['offline', 'probe']],
    ]);
  });

  it('切回拼车以后（读数回到拼车）：拼车照派', () => {
    expect(chooseRoute(input([carpoolOk, soloSkipped], { liveOrg: 'carpool' }))).toMatchObject({
      kind: 'dispatch',
      routeId: 'carpool-opus',
    });
  });

  it('引擎不打算切回（比如拼车池整池暂停着）：拼车硬挡、写明为什么不切；独享挂着，等探针在独享下探一次', () => {
    const noBack = { to: null, at: null, why: '挂着独享；拼车池整池暂停着（等人处理），先不切回' };
    const r = chooseRoute(input([carpoolOk, soloSkipped], { liveOrg: 'solo', orgPlan: noBack }));
    expect(r).toMatchObject({ kind: 'wait', waitFor: 'probe' });
    expect(r.kind === 'wait' && r.reason).toContain(
      '引擎现在不打算切过去（挂着独享；拼车池整池暂停着（等人处理），先不切回）',
    );
    // 探针在独享下探过、没探通：两条都等不来——派不出，明确写着为什么（不是悄悄挂着）
    const soloDown = solo({
      orgKind: 'solo',
      blockers: ['offline'],
      probeState: 'failed',
      probeOrg: 'solo',
      probedAt: at(-0.03),
    });
    const none = chooseRoute(input([carpoolOk, soloDown], { liveOrg: 'solo', orgPlan: noBack }));
    expect(none.kind).toBe('none');
    expect(none.kind === 'none' && none.reason).toContain('引擎现在不打算切过去');
    expect(none.kind === 'none' && none.reason).toContain('不在线（探活或熔断判的）');
  });
});
