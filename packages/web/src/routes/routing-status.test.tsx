// @vitest-environment happy-dom
// 渠道状态页（#1087；驾驶舱改版 2026-10-07「渠道状态无法探测」；近 60 次真历史 #1139）：左栏按顺位排的渠道卡，
// 每张卡一条格子（一次探针一格），点开看那一次的耗时和原文；右边每条路由的最近一次结论。单条、整个渠道、全部都能
// 「立即探测」，点了马上看到排队 / 探测中，探完自己刷新。
// 故意造出的失败：引擎关着（按钮置灰、写明，历史照样在）、点了被拒（写明是哪样）、立即探测的记录读不到（写没读成）、
// 探针历史读不到（写没查成、不画格子）、运行中失败的渠道顺到谁没有。
import { type ProbeHistoryCell, probeHistoryStrips } from '@fleet-dao/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { Channel, ChannelState, Route, RouteProbeHistory, RouteProbeStatus } from '../api/types';
import { failoverOf } from '../lib/provider-status';
import RoutingStatus from '../routes/routing-status';
import { renderApp } from '../test/harness';

afterEach(cleanup);

const channel = (id: string, name: string, enabled = true): Channel => ({
  id,
  name,
  billing: 'subscription',
  enabled,
});

const route = (id: string, channelId: string, opts: Partial<Route> = {}): Route => ({
  id,
  channelId,
  poolId: 'p1',
  modelId: 'm1',
  hostId: 'claude-code',
  alive: true,
  ...opts,
});

const card = (channelId: string) => {
  const el = document.querySelector(`[data-channel="${channelId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`页面上没有渠道卡 ${channelId}`);
  return el;
};
const routeRow = (routeId: string) => {
  const el = document.querySelector(`[data-route="${routeId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`页面上没有路由 ${routeId}`);
  return el;
};

const historyOf = (rows: ProbeHistoryCell[]): RouteProbeHistory => ({
  state: 'ok',
  ...probeHistoryStrips(rows),
});

const probeCell = (
  over: Partial<ProbeHistoryCell> &
    Pick<ProbeHistoryCell, 'id' | 'routeId' | 'channelId' | 'probedAt' | 'result'>,
): ProbeHistoryCell => ({
  durationMs: null,
  failureReason: over.result === 'passed' ? null : '原因',
  requestText: null,
  responseText: null,
  ...over,
});

describe('运行中失败的渠道（#1118，failoverOf）', () => {
  const failedState = (over: Partial<ChannelState> = {}): ChannelState => ({
    channelId: 'c1',
    status: 'disabled',
    reason: '上游断连（已重试 2 次）',
    failedRouteId: 'r1',
    fallbackChannelId: 'c2',
    fallbackModelId: 'm1',
    flaggedAt: '2026-10-05T01:10:00Z',
    updatedAt: '2026-10-05T01:10:00Z',
    ...over,
  });
  const routing = {
    channels: [channel('c1', 'Claude 订阅'), channel('c2', '中转站')],
    models: [{ id: 'm1', family: 'claude', displayName: 'Opus 5.5' }],
  };

  test('写明为什么、顺延到谁（渠道和模型）、下次探测：引发失败的那条上次通了，按它的间隔算', () => {
    const routes = [route('r1', 'c1', { probe: { state: 'ok', at: '2026-10-05T01:00:00Z' } })];
    expect(failoverOf(failedState(), routes, routing)).toMatchObject({
      reason: '上游断连（已重试 2 次）',
      failedRouteId: 'r1',
      fallback: { channelName: '中转站', modelName: 'Opus 5.5' },
      nextProbeAt: '2026-10-05T01:15:00.000Z',
      probeEveryMinutes: 15,
    });
    const slow = [
      route('r1', 'c1', { hostId: 'mirasim', probe: { state: 'ok', at: '2026-10-05T01:00:00Z' } }),
    ];
    expect(failoverOf(failedState(), slow, routing)).toMatchObject({
      nextProbeAt: '2026-10-05T03:00:00.000Z',
      probeEveryMinutes: 120,
    });
  });

  test('【故意造出的失败】顺到谁还没有、引发的路由没探过：照实写没有，不编', () => {
    const got = failoverOf(
      failedState({ fallbackChannelId: undefined, fallbackModelId: undefined }),
      [route('r1', 'c1')],
      routing,
    );
    expect(got).toMatchObject({ fallback: undefined, nextProbeAt: undefined });
    expect(failoverOf(failedState({ status: 'ok' }), [], routing)).toBeUndefined();
  });
});

describe('渠道状态页：渠道卡', () => {
  test('目录里每个渠道一张卡，按顺位排；探针报错的标暂不可用、顺延到谁；按量计费的写明不自动探；不露模型串', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status' });
    const list = await screen.findByRole('list', { name: '渠道状态' });
    const items = Array.from(list.children) as HTMLElement[];
    expect(items.map((c) => c.getAttribute('data-channel')).sort()).toEqual([
      'ch-claude',
      'ch-cursor',
      'ch-ds',
      'ch-grok',
      'ch-relay',
    ]);
    const cursor = card('ch-cursor');
    expect(cursor.getAttribute('data-state')).toBe('down');
    expect(cursor.textContent).toContain('暂不可用');
    expect(cursor.textContent).toContain('连探两次都没通');
    expect(cursor.textContent).toMatch(/选路顺延到「.+」|后面没有能用的渠道了/);
    const claude = card('ch-claude');
    expect(claude.getAttribute('data-state')).toBe('ok');
    expect(claude.textContent).toMatch(/4 分钟前探的/);
    expect(card('ch-ds').textContent).toContain('按量计费，不自动探');
    expect(items[0]?.textContent).toContain('顺位第 1');
    expect(list.textContent).not.toMatch(/grok-4\.7|deepseek-v4\.1-flash/);
    expect(screen.getByText(/绿灯只表示本节点最近一轮抽测通过/)).toBeTruthy();
  });

  test('运行中失败（#1118）：中转站卡上写「运行中失败，已顺延」、为什么、顺到谁、下次探测；和路由页同一份判法', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status' });
    await screen.findByRole('list', { name: '渠道状态' });
    const relay = card('ch-relay');
    expect(relay.getAttribute('data-state')).toBe('down');
    expect(within(relay).getByText('运行中失败，已顺延')).toBeTruthy();
    expect(relay.querySelector('[data-field="reason"]')?.textContent).toContain('上游断连');
    expect(relay.querySelector('[data-field="fallback"]')?.textContent).toBe('Claude 订阅 · Opus 5.5');
    expect(card('ch-claude').querySelector('[data-failover]')).toBeNull();
  });

  test('上次探测超过间隔 + 3 分钟：这个渠道改成「检测中断」，别的渠道不受影响', async () => {
    const api = createMockApi({ live: false });
    const layers = await api.routingLayers();
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    for (const p of layers.purposes) {
      for (const m of p.models) for (const r of m.routes) if (r.channelId === 'ch-claude') r.probedAt = old;
    }
    Object.assign(api, { routingLayers: async () => layers });
    renderApp(<RoutingStatus />, { route: '/routing/status', api });
    await screen.findByRole('list', { name: '渠道状态' });
    expect(card('ch-claude').getAttribute('data-state')).toBe('interrupted');
    expect(card('ch-claude').textContent).toContain('检测中断');
    expect(card('ch-grok').getAttribute('data-state')).toBe('ok');
  });
});

describe('渠道状态页：每条路由', () => {
  test('点开 Cursor：最近一次的时刻、耗时、失败原因原文都在，不藏', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-cursor' });
    const row = await waitFor(() => routeRow('r-cursor'));
    expect(row.getAttribute('data-probe')).toBe('failed');
    expect(row.textContent).toContain('失败原因（原文）');
    expect(row.textContent).toContain('等了 150 秒还没起来');
    expect(row.textContent).toContain('最近一次');
    expect(row.textContent).toContain('耗时');
  });

  test('通的路由：耗时取探针原文里的「用时 N 秒」', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-claude' });
    const row = await waitFor(() => routeRow('r-ca-opus'));
    expect(row.textContent).toContain('9 秒');
    expect(row.textContent).toContain('通过');
  });

  test('点单条「立即探测」：马上看到排队，引擎接手后探测中，探完结论自己刷新、顶上写探完了', async () => {
    let t = Date.now();
    const api = createMockApi({ live: false, now: () => t });
    const { qc } = renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-grok', api });
    const row = await waitFor(() => routeRow('r-grok'));
    const before = row.textContent;
    fireEvent.click(within(row).getByRole('button', { name: /立即探测/ }));
    await waitFor(() => expect(routeRow('r-grok').getAttribute('data-probe')).toBe('queued'));
    expect(routeRow('r-grok').textContent).toContain('排队中');
    expect(await screen.findByText(/正在探1 条路由/)).toBeTruthy();
    // 引擎 1.5 秒接手
    t += 2_000;
    await act(() => qc.invalidateQueries({ queryKey: ['route-probe'] }));
    await waitFor(() => expect(routeRow('r-grok').getAttribute('data-probe')).toBe('running'));
    // 接手 4 秒探完：顶上写探完了，这条的结论换成新的
    t += 5_000;
    await act(() => qc.invalidateQueries({ queryKey: ['route-probe'] }));
    expect(await screen.findByText(/的立即探测探完了：通过 1 · 不通 0/)).toBeTruthy();
    await waitFor(() => expect(routeRow('r-grok').getAttribute('data-probe')).toBe('ok'));
    await waitFor(() => expect(routeRow('r-grok').textContent).not.toBe(before));
    // 操作记录里有点击、接手、探完三条
    const audit = await api.audit({ target: 'routing:probe' });
    expect(audit.items.map((a) => a.action).sort()).toEqual([
      'routing.probe.done',
      'routing.probe.request',
      'routing.probe.start',
    ]);
  });

  test('「全部立即探测」：每条路由都转排队；按量计费的探完写明照规矩没探，不写成通', async () => {
    let t = Date.now();
    const api = createMockApi({ live: false, now: () => t });
    const { qc } = renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-ds', api });
    await screen.findByRole('list', { name: '渠道状态' });
    fireEvent.click(screen.getByRole('button', { name: '全部立即探测' }));
    await waitFor(() => expect(routeRow('r-ds').getAttribute('data-probe')).toBe('queued'));
    expect(screen.getByRole('button', { name: '全部立即探测' })).toHaveProperty('disabled', true);
    t += 2_000;
    await act(() => qc.invalidateQueries({ queryKey: ['route-probe'] }));
    t += 5_000;
    await act(() => qc.invalidateQueries({ queryKey: ['route-probe'] }));
    await waitFor(() => expect(routeRow('r-ds').getAttribute('data-probe')).toBe('skipped'));
    expect(routeRow('r-ds').textContent).toContain('按量计费的渠道不自动探');
    expect(routeRow('r-ds').textContent).toContain('没真探');
  });
});

describe('渠道状态页：探不了要说清是哪样', () => {
  const statusWith = (engine: RouteProbeStatus['engine']) => {
    const api = createMockApi({ live: false });
    Object.assign(api, {
      routeProbeStatus: async (): Promise<RouteProbeStatus> => ({
        asOf: new Date().toISOString(),
        engine,
        requests: [],
      }),
    });
    return api;
  };

  test('【故意造出的失败】引擎按配置没开：顶上写明，「全部立即探测」和每条的按钮都置灰', async () => {
    renderApp(<RoutingStatus />, {
      route: '/routing/status?p=ch-claude',
      api: statusWith({ state: 'off', detail: '这台机器按配置没开引擎' }),
    });
    expect(await screen.findByText(/引擎按配置没开（这台机器按配置没开引擎）：探不了/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '全部立即探测' })).toHaveProperty('disabled', true);
    const row = await waitFor(() => routeRow('r-ca-opus'));
    expect(within(row).getByRole('button', { name: /立即探测/ })).toHaveProperty('disabled', true);
    await waitFor(() => expect(card('ch-claude').querySelector('[data-history="strip"]')).toBeTruthy());
  });

  test('【故意造出的失败】引擎没连上：写「没连上」，不显示成通', async () => {
    renderApp(<RoutingStatus />, {
      route: '/routing/status',
      api: statusWith({ state: 'down', detail: '任务队列上没有在拉活的引擎工人' }),
    });
    expect(await screen.findByText(/引擎没连上（任务队列上没有在拉活的引擎工人）：探不了/)).toBeTruthy();
  });

  test('【故意造出的失败】点了被后端拒：原话写在顶上，路由不转「探测中」', async () => {
    const api = createMockApi({ live: false });
    Object.assign(api, {
      routeProbeNow: () =>
        Promise.reject(new ApiError(503, 'engine_down', '探不了：引擎没连上，点了也没人接')),
    });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-grok', api });
    const row = await waitFor(() => routeRow('r-grok'));
    fireEvent.click(within(row).getByRole('button', { name: /立即探测/ }));
    expect(await screen.findByText('没探成：探不了：引擎没连上，点了也没人接')).toBeTruthy();
    expect(routeRow('r-grok').getAttribute('data-probe')).toBe('ok');
  });

  test('【故意造出的失败】立即探测的记录读不到：写没读成和原因，按钮置灰，渠道卡照常显示', async () => {
    const api = createMockApi({ live: false });
    Object.assign(api, {
      routeProbeStatus: () =>
        Promise.reject(new ApiError(503, 'route_probe_unreadable', '立即探测的记录没读成：连不上库')),
    });
    renderApp(<RoutingStatus />, { route: '/routing/status', api });
    expect(await screen.findByText(/立即探测的记录没读成：.*连不上库/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '全部立即探测' })).toHaveProperty('disabled', true);
    expect(card('ch-claude')).toBeTruthy();
  });

  test('点了没人接手（作废）：那条路由写明这次没成和为什么', async () => {
    const api = createMockApi({ live: false });
    const requestedAt = new Date(Date.now() + 60_000).toISOString();
    Object.assign(api, {
      routeProbeStatus: async (): Promise<RouteProbeStatus> => ({
        asOf: new Date().toISOString(),
        engine: { state: 'on' },
        requests: [
          {
            requestId: 'x',
            requestedAt,
            by: 'founder',
            routeIds: ['r-grok'],
            state: 'expired',
            why: '点了 10 分钟引擎都没接手，作废了：引擎没在跑，或还没发到带「立即探测」的版本',
            results: [],
          },
        ],
      }),
    });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-grok', api });
    const row = await waitFor(() => routeRow('r-grok'));
    await waitFor(() => expect(row.textContent).toContain('点的立即探测没成：点了 10 分钟引擎都没接手'));
  });
});

describe('渠道状态页：近 60 次真历史（#1139）', () => {
  const t = Date.parse('2026-10-07T00:00:00.000Z');
  const cursorHistory = (): RouteProbeHistory =>
    historyOf([
      probeCell({
        id: 1,
        routeId: 'r-cursor',
        channelId: 'ch-cursor',
        probedAt: new Date(t - 30 * 60_000).toISOString(),
        result: 'passed',
        durationMs: 2000,
        failureReason: null,
        requestText: '只回 OK',
        responseText: 'OK',
      }),
      probeCell({
        id: 3,
        routeId: 'r-cursor',
        channelId: 'ch-cursor',
        probedAt: new Date(t - 15 * 60_000).toISOString(),
        result: 'not_probed',
        failureReason: '按规矩没探',
      }),
      probeCell({
        id: 2,
        routeId: 'r-other',
        channelId: 'ch-cursor',
        probedAt: new Date(t - 5 * 60_000).toISOString(),
        result: 'failed',
        durationMs: 4000,
        failureReason: '上游断了',
        requestText: 'PING',
        responseText: 'boom',
      }),
    ]);

  test('格子三种颜色分开；点一格看原文；点路由行看这条自己的最近一次', async () => {
    const api = createMockApi({ live: false });
    Object.assign(api, { routeProbeHistory: async () => cursorHistory() });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-cursor', api });
    const strip = await waitFor(() => {
      const el = card('ch-cursor').querySelector('[data-history="strip"]');
      if (!(el instanceof HTMLElement)) throw new Error('格子条还没出来');
      return el;
    });
    expect(strip.querySelector('[data-result="passed"]')?.className).toContain('bg-st-done');
    expect(strip.querySelector('[data-result="failed"]')?.className).toContain('bg-st-fail');
    expect(strip.querySelector('[data-result="not_probed"]')?.className).toContain('bg-st-stall');
    expect(strip.querySelectorAll('[data-cell]')).toHaveLength(3);
    expect(strip.querySelectorAll('[data-result="empty"]')).toHaveLength(57);

    const detail = () => screen.getByRole('region', { name: '这一次' });
    await waitFor(() => expect(within(detail()).getByText(/上游断了/)).toBeTruthy());
    expect(within(detail()).getByText('PING')).toBeTruthy();
    expect(within(detail()).getByText('boom')).toBeTruthy();
    expect(within(detail()).getByText('4.0 秒')).toBeTruthy();

    const passed = strip.querySelector('[data-result="passed"]');
    if (!(passed instanceof HTMLElement)) throw new Error('没有通过的格子');
    fireEvent.click(passed);
    await waitFor(() => expect(within(detail()).getByText('只回 OK')).toBeTruthy());
    expect(within(detail()).getByText('OK')).toBeTruthy();
    expect(within(detail()).getByText('2.0 秒')).toBeTruthy();
    expect(within(detail()).queryByText(/上游断了/)).toBeNull();

    fireEvent.click(within(routeRow('r-cursor')).getByRole('button', { name: '看最近一次' }));
    await waitFor(() => expect(within(detail()).getByText(/按规矩没探/)).toBeTruthy());
    expect(within(detail()).getByText('没真探')).toBeTruthy();
    expect(within(detail()).getByText('（没发出去）')).toBeTruthy();
    expect(within(detail()).getByText('（没拿到）')).toBeTruthy();
  });

  test('卡片头部的均耗时、可用率按这 60 次算：没探不进可用率，没量到的耗时不当 0', async () => {
    const api = createMockApi({ live: false });
    Object.assign(api, { routeProbeHistory: async () => cursorHistory() });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-cursor', api });
    const stats = await waitFor(() => {
      const el = card('ch-cursor').querySelector('[data-history-stats]');
      if (!(el instanceof HTMLElement)) throw new Error('还没有均耗时');
      return el;
    });
    expect(stats.textContent).toContain('均耗时 3.0 秒');
    expect(stats.textContent).toContain('可用率 50%（1/2）');
  });

  test('超过 60 次只画最近 60 格，更老的不在条上', async () => {
    const api = createMockApi({ live: false });
    const cells = Array.from({ length: 61 }, (_, i) =>
      probeCell({
        id: i + 1,
        routeId: 'r-cursor',
        channelId: 'ch-cursor',
        probedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        result: 'passed',
        durationMs: 1000,
        failureReason: null,
        responseText: 'OK',
      }),
    );
    Object.assign(api, {
      routeProbeHistory: async (): Promise<RouteProbeHistory> => ({
        state: 'ok',
        channels: [{ channelId: 'ch-cursor', cells, avgDurationMs: 1000, passed: 61, attempted: 61 }],
        latestByRoute: [cells[60] as ProbeHistoryCell],
      }),
    });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-cursor', api });
    const strip = await waitFor(() => {
      const el = card('ch-cursor').querySelector('[data-history="strip"]');
      if (!(el instanceof HTMLElement)) throw new Error('格子条还没出来');
      return el;
    });
    expect(strip.querySelectorAll('[data-cell]')).toHaveLength(60);
    expect(strip.querySelector('[data-cell="1"]')).toBeNull();
    expect(strip.querySelector('[data-cell="61"]')).toBeTruthy();
    expect(strip.querySelector('[data-result="empty"]')).toBeNull();
    expect(within(screen.getByRole('list', { name: '最近状态（60）' })).getAllByRole('button')).toHaveLength(
      60,
    );
  });

  test('【故意造出的失败】库读不到：写没查成，不画格子冒充没有历史', async () => {
    const api = createMockApi({ live: false });
    Object.assign(api, {
      routeProbeHistory: async () => ({ state: 'unreadable' as const, why: '没查成：连不上库' }),
    });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-cursor', api });
    await waitFor(() => expect(card('ch-cursor').querySelector('[data-history="unreadable"]')).toBeTruthy());
    expect(card('ch-cursor').textContent).toContain('没查成：连不上库');
    expect(document.querySelector('[data-result]')).toBeNull();
    expect(document.querySelector('[data-history="strip"]')).toBeNull();
    const alerts = document.querySelectorAll('[data-history="unreadable"]');
    expect(alerts.length).toBeGreaterThan(1);
    expect([...alerts].every((el) => el.textContent?.includes('没查成：连不上库'))).toBe(true);
  });

  test('读成了但还没有历史：补空格子，写还没有，不写没查成', async () => {
    const api = createMockApi({ live: false });
    Object.assign(api, {
      routeProbeHistory: async () => ({ state: 'ok' as const, channels: [], latestByRoute: [] }),
    });
    renderApp(<RoutingStatus />, { route: '/routing/status', api });
    await screen.findByRole('list', { name: '渠道状态' });
    await waitFor(() => expect(card('ch-claude').querySelector('[data-history="strip"]')).toBeTruthy());
    expect(card('ch-claude').textContent).toContain('还没有探针历史');
    expect(card('ch-claude').textContent).toContain('还没有真探');
    expect(card('ch-claude').textContent).toContain('没量到');
    expect(card('ch-claude').textContent).not.toContain('没查成');
    expect(card('ch-claude').querySelectorAll('[data-result="empty"]')).toHaveLength(60);
    expect(card('ch-claude').querySelector('[data-cell]')).toBeNull();
  });
});
