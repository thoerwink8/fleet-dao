// @vitest-environment happy-dom
// 渠道状态页（#1087；驾驶舱改版 2026-10-07「渠道状态无法探测」；近 60 次真历史 #1139）：左栏按顺位排的渠道卡，
// 每张卡一条格子（一次探针一格），点开看那一次的耗时和原文；右边每条路由的最近一次结论。单条、整个渠道、全部都能
// 「立即探测」，点了马上看到排队 / 探测中，探完自己刷新。
// 故意造出的失败：引擎关着（按钮置灰、写明，历史照样在）、点了被拒（写明是哪样）、立即探测的记录读不到（写没读成）、
// 探针历史读不到（写没查成、不画格子）、运行中失败的渠道顺到谁没有。
import { type ProbeHistoryCell, probeHistoryStrips, ROUTE_PROBE_ON_DEMAND_MARK } from '@fleet-dao/shared';
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

/** 路由行默认折叠：点一下展开（手风琴，一次只开一条）。返回展开后的那一行。 */
const openRoute = (routeId: string) => {
  const row = routeRow(routeId);
  const toggle = row.querySelector('button[aria-expanded]');
  if (!(toggle instanceof HTMLElement)) throw new Error(`路由 ${routeId} 没有展开按钮`);
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  return routeRow(routeId);
};

/** 详情里的探针格子条（选中渠道的）。 */
const historyStrip = () => {
  const el = document.querySelector('[data-history="strip"]');
  if (!(el instanceof HTMLElement)) throw new Error('格子条还没出来');
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
  checkQuestion: null,
  checkExpected: null,
  checkAnswer: null,
  checkPassed: null,
  selfIdentity: null,
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

  test('不通且写了连着几次：下次探测按退避那一档，不按 15 分钟', () => {
    const detail = '503 容量满。退避中，下次约 03:00 再探（连着不通 3 次）';
    const routes = [
      route('r1', 'c1', {
        alive: false,
        probe: { state: 'failed', at: '2026-10-05T01:00:00Z', detail },
      }),
    ];
    expect(failoverOf(failedState(), routes, routing)).toMatchObject({
      nextProbeAt: '2026-10-05T02:00:00.000Z',
      probeEveryMinutes: 60,
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
    expect(cursor.getAttribute('data-kind')).toBe('fault');
    expect(cursor.textContent).toContain('故障');
    // 默认折叠成一行摘要：原因、顺延到谁在点开后的详情里，不在行上铺开
    expect(cursor.textContent).not.toContain('连探两次都没通');
    fireEvent.click(within(cursor).getByRole('button'));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Cursor 的路由' })).toBeTruthy());
    expect(document.body.textContent).toContain('连探两次都没通');
    expect(document.body.textContent).toMatch(/选路顺延到「.+」|后面没有能用的渠道了/);
    const claude = card('ch-claude');
    expect(claude.getAttribute('data-state')).toBe('ok');
    expect(claude.textContent).toMatch(/4 分钟前探的/);
    expect(card('ch-ds').textContent).toContain('按量计费，不自动探');
    expect(items.some((c) => c.textContent?.includes('顺位第 1'))).toBe(true);
    expect(list.textContent).not.toMatch(/grok-4\.7|deepseek-v4\.1-flash/);
    expect(screen.getByText(/绿灯只表示本节点最近一轮抽测通过/)).toBeTruthy();
  });

  test('退避中单独一行写下次大约几点，不带截断，也不标结论过期', async () => {
    const api = createMockApi({ live: false });
    const cursor = api.state().routes.find((r) => r.id === 'r-cursor');
    if (!cursor?.probe) throw new Error('假数据没有 cursor 路由');
    cursor.probe = {
      state: 'failed',
      at: new Date(Date.now() - 20 * 60_000).toISOString(),
      detail: '连探两次都没通：503 容量满。退避中，下次约 16:07 再探（连着不通 6 次）',
    };
    renderApp(<RoutingStatus />, { api, route: '/routing/status' });
    await screen.findByRole('list', { name: '渠道状态' });
    fireEvent.click(within(card('ch-cursor')).getByRole('button'));
    const notice = await waitFor(() => {
      const el = routeRow('r-cursor').querySelector('[data-probe-backoff]');
      if (!(el instanceof HTMLElement)) throw new Error('还没有退避那一行');
      return el;
    });
    expect(notice.textContent).toBe('退避中，下次约 16:07 再探');
    expect(notice.className).not.toContain('truncate');
    expect(routeRow('r-cursor').textContent).not.toContain('结论过期');
  });

  test('运行中失败（#1118）：中转站卡上写「运行中失败，已顺延」、为什么、顺到谁、下次探测；和路由页同一份判法', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status' });
    await screen.findByRole('list', { name: '渠道状态' });
    const relay = card('ch-relay');
    expect(relay.getAttribute('data-state')).toBe('down');
    expect(within(relay).getByText('运行中失败，已顺延')).toBeTruthy();
    fireEvent.click(within(relay).getByRole('button'));
    await waitFor(() => expect(document.querySelector('[data-failover]')).toBeTruthy());
    expect(document.querySelector('[data-field="reason"]')?.textContent).toContain('上游断连');
    expect(document.querySelector('[data-field="fallback"]')?.textContent).toBe('Claude 订阅 · Opus 5.5');
    fireEvent.click(within(card('ch-claude')).getByRole('button'));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Claude 订阅 的路由' })).toBeTruthy());
    expect(document.querySelector('[data-failover]')).toBeNull();
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
    await waitFor(() => routeRow('r-cursor'));
    // 默认折叠：故障的一行在行上写一句原因，原文、耗时在点开后
    expect(routeRow('r-cursor').textContent).not.toContain('失败原因（原文）');
    const row = openRoute('r-cursor');
    expect(row.getAttribute('data-probe')).toBe('failed');
    expect(row.getAttribute('data-kind')).toBe('fault');
    expect(row.textContent).toContain('失败原因（原文）');
    expect(row.textContent).toContain('等了 150 秒还没起来');
    expect(row.textContent).toContain('最近一次');
    expect(row.textContent).toContain('耗时');
  });

  test('通的路由：耗时取探针原文里的「用时 N 秒」', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-claude' });
    await waitFor(() => routeRow('r-ca-opus'));
    const row = openRoute('r-ca-opus');
    expect(row.textContent).toContain('9 秒');
    expect(row.textContent).toContain('通过');
  });

  test('点单条「立即探测」：马上看到排队，引擎接手后探测中，探完结论自己刷新、顶上写探完了', async () => {
    let t = Date.now();
    const api = createMockApi({ live: false, now: () => t });
    const { qc } = renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-grok', api });
    await waitFor(() => routeRow('r-grok'));
    const row = openRoute('r-grok');
    const before = row.textContent;
    fireEvent.click(within(row).getByRole('button', { name: '立即探测' }));
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
    // 假数据里自带的那次自动探（probe-auto-1）不算这次点的
    const mine = audit.items.filter(
      (a) => (a.after as { requestId?: string } | null)?.requestId !== 'probe-auto-1',
    );
    expect(mine.map((a) => a.action).sort()).toEqual([
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
    const row = openRoute('r-ds');
    expect(row.textContent).toContain('按量计费的渠道不自动探');
    expect(row.textContent).toContain('没真探');
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
    await waitFor(() => routeRow('r-ca-opus'));
    const row = openRoute('r-ca-opus');
    expect(within(row).getByRole('button', { name: '立即探测' })).toHaveProperty('disabled', true);
    await waitFor(() => expect(document.querySelector('[data-history="strip"]')).toBeTruthy());
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
    await waitFor(() => routeRow('r-grok'));
    const row = openRoute('r-grok');
    fireEvent.click(within(row).getByRole('button', { name: '立即探测' }));
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
    await waitFor(() => routeRow('r-grok'));
    const row = openRoute('r-grok');
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
    const strip = await waitFor(historyStrip);
    expect(strip.querySelector('[data-result="passed"]')?.className).toContain('bg-st-done');
    expect(strip.querySelector('[data-result="failed"]')?.className).toContain('bg-st-fail');
    // #1748：没探的不画进色条、不进可用率，折在探测记录下面
    expect(strip.querySelector('[data-result="not_probed"]')).toBeNull();
    expect(strip.querySelectorAll('[data-cell]')).toHaveLength(2);
    expect(strip.querySelectorAll('[data-result="empty"]')).toHaveLength(58);
    expect(strip.textContent).toContain('另有 1 条没真探');
    expect(document.querySelector('[data-probe-log="skipped"]')).toBeTruthy();

    // 什么都没点：探测记录都折叠着
    const log = () => screen.getByRole('region', { name: '探测记录' });
    expect(log().querySelector('[data-field="request"]')).toBeNull();

    const failed = strip.querySelector('[data-result="failed"]');
    if (!(failed instanceof HTMLElement)) throw new Error('没有不通的格子');
    fireEvent.click(failed);
    await waitFor(() => expect(within(log()).getByText(/上游断了/)).toBeTruthy());
    expect(within(log()).getByText('PING')).toBeTruthy();
    expect(within(log()).getByText('boom')).toBeTruthy();
    expect(within(log()).getByText('4.0 秒')).toBeTruthy();

    const passed = strip.querySelector('[data-result="passed"]');
    if (!(passed instanceof HTMLElement)) throw new Error('没有通过的格子');
    fireEvent.click(passed);
    await waitFor(() => expect(within(log()).getByText('只回 OK')).toBeTruthy());
    expect(within(log()).getByText('OK')).toBeTruthy();
    expect(within(log()).getByText('2.0 秒')).toBeTruthy();
    expect(within(log()).queryByText(/上游断了/)).toBeNull();

    fireEvent.click(within(openRoute('r-cursor')).getByRole('button', { name: '看最近一次' }));
    await waitFor(() => expect(within(log()).getByText(/按规矩没探/)).toBeTruthy());
    expect(within(log()).getByText('没真探')).toBeTruthy();
    expect(within(log()).getByText('（没发出去）')).toBeTruthy();
    expect(within(log()).getByText('（没拿到）')).toBeTruthy();
  });

  test('卡片头部的均耗时、可用率按这 60 次算：没探不进可用率，没量到的耗时不当 0', async () => {
    const api = createMockApi({ live: false });
    Object.assign(api, { routeProbeHistory: async () => cursorHistory() });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-cursor', api });
    const stats = await waitFor(() => {
      const el = document.querySelector('[data-history-stats]');
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
        channels: [
          { channelId: 'ch-cursor', cells, skipped: [], avgDurationMs: 1000, passed: 61, attempted: 61 },
        ],
        latestByRoute: [cells[60] as ProbeHistoryCell],
      }),
    });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-cursor', api });
    const strip = await waitFor(historyStrip);
    expect(strip.querySelectorAll('[data-cell]')).toHaveLength(60);
    expect(strip.querySelector('[data-cell="1"]')).toBeNull();
    expect(strip.querySelector('[data-cell="61"]')).toBeTruthy();
    expect(strip.querySelector('[data-result="empty"]')).toBeNull();
    expect(within(screen.getByRole('list', { name: '探测记录列表' })).getAllByRole('button')).toHaveLength(
      60,
    );
  });

  test('【故意造出的失败】库读不到：写没查成，不画格子冒充没有历史', async () => {
    const api = createMockApi({ live: false });
    Object.assign(api, {
      routeProbeHistory: async () => ({ state: 'unreadable' as const, why: '没查成：连不上库' }),
    });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-cursor', api });
    await waitFor(() => expect(document.querySelector('[data-history="unreadable"]')).toBeTruthy());
    expect(document.body.textContent).toContain('没查成：连不上库');
    expect(document.querySelector('[data-result]')).toBeNull();
    expect(document.querySelector('[data-history="strip"]')).toBeNull();
    const alerts = document.querySelectorAll('[data-history="unreadable"]');
    expect(alerts.length).toBeGreaterThan(0);
    expect([...alerts].every((el) => el.textContent?.includes('没查成：连不上库'))).toBe(true);
  });

  test('读成了但还没有历史：补空格子，写还没有，不写没查成', async () => {
    const api = createMockApi({ live: false });
    Object.assign(api, {
      routeProbeHistory: async () => ({ state: 'ok' as const, channels: [], latestByRoute: [] }),
    });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-claude', api });
    await screen.findByRole('list', { name: '渠道状态' });
    const strip = await waitFor(historyStrip);
    expect(strip.textContent).toContain('还没有真探');
    expect(strip.textContent).toContain('没量到');
    expect(strip.textContent).not.toContain('没查成');
    expect(strip.querySelectorAll('[data-result="empty"]')).toHaveLength(60);
    expect(strip.querySelector('[data-cell]')).toBeNull();
  });
});

describe('渠道状态页：探测记录（#1638）', () => {
  const t = Date.parse('2026-10-07T00:00:00.000Z');
  const mins = (n: number) => new Date(t - n * 60_000).toISOString();
  const logHistory = (): RouteProbeHistory =>
    historyOf([
      probeCell({
        id: 1,
        routeId: 'r-cursor',
        channelId: 'ch-cursor',
        probedAt: mins(30),
        result: 'passed',
        durationMs: 2000,
        failureReason: null,
        requestText: '只回 OK\n第二行',
        responseText: 'OK',
      }),
      probeCell({
        id: 2,
        routeId: 'r-cursor',
        channelId: 'ch-cursor',
        probedAt: mins(10),
        result: 'failed',
        durationMs: 8000,
        failureReason: '降智题答错：实答 381',
        requestText: '请求原文 A\n请求原文 B',
        responseText: '响应原文 X\n响应原文 Y',
        checkQuestion: '17 乘 23 等于多少？',
        checkExpected: '391',
        checkAnswer: '381',
        checkPassed: false,
        selfIdentity: '某个小模型',
      }),
      probeCell({
        id: 3,
        routeId: 'r-cursor',
        channelId: 'ch-cursor',
        probedAt: mins(20),
        result: 'failed',
        failureReason: '上游 503',
        requestText: 'PING',
        responseText: 'boom',
      }),
    ]);
  const rowOrder = () =>
    [...document.querySelectorAll('[data-probe-row]')].map((el) => el.getAttribute('data-probe-row'));
  const open = (id: number) => {
    const row = document.querySelector(`[data-probe-row="${id}"]`);
    const button = row?.querySelector('button[aria-expanded]');
    if (!(button instanceof HTMLElement)) throw new Error(`探测记录里没有第 ${id} 行`);
    fireEvent.click(button);
  };
  const renderLog = (history: unknown) => {
    const api = createMockApi({ live: false });
    Object.assign(api, { routeProbeHistory: async () => history });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-cursor', api });
  };

  test('从新到旧列出；疑似降智那一行写题、标准答案、实答和自报身份，格子单独一种颜色', async () => {
    renderLog(logHistory());
    await waitFor(() => expect(rowOrder()).toEqual(['2', '3', '1']));
    const row = document.querySelector('[data-probe-row="2"]') as HTMLElement;
    expect(row.getAttribute('data-result')).toBe('doubt');
    expect(within(row).getByText('疑似降智')).toBeTruthy();
    expect(within(row).getByText('17 乘 23 等于多少？')).toBeTruthy();
    expect(row.querySelector('[data-field="expected"]')?.textContent).toBe('391');
    expect(row.querySelector('[data-field="answer"]')?.textContent).toBe('381');
    expect(row.querySelector('[data-field="identity"]')?.textContent).toBe('某个小模型');
    // 不通的那行没有题，不画题
    expect(document.querySelector('[data-probe-row="3"] [data-field="check"]')).toBeNull();
    const cell = historyStrip().querySelector('[data-cell="2"]');
    expect(cell?.getAttribute('data-result')).toBe('doubt');
    expect(cell?.className).toContain('bg-st-doubt');
    expect(historyStrip().textContent).toContain('橙疑似降智');
  });

  test('点一行展开请求和响应原文；不通的另起一块写失败原因；点格子打开的是同一行', async () => {
    renderLog(logHistory());
    await waitFor(() => expect(rowOrder()).toHaveLength(3));
    expect(document.querySelector('[data-field="request"]')).toBeNull();
    open(3);
    const row = document.querySelector('[data-probe-row="3"]') as HTMLElement;
    expect(row.querySelector('[data-field="failure"]')?.textContent).toBe('失败原因：上游 503');
    expect(row.querySelector('[data-field="request"]')?.textContent).toBe('PING');
    expect(row.querySelector('[data-field="response"]')?.textContent).toBe('boom');
    // 点格子 1：展开的换成第 1 行（同一个详情）
    fireEvent.click(historyStrip().querySelector('[data-cell="1"]') as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector('[data-probe-row="1"] [data-field="request"]')?.textContent).toBe(
        '只回 OK\n第二行',
      ),
    );
    expect(document.querySelector('[data-probe-row="3"] [data-field="request"]')).toBeNull();
    // 再点一下这一行折起来
    open(1);
    expect(document.querySelector('[data-probe-row="1"] [data-field="request"]')).toBeNull();
    // 疑似降智的行展开：原文保留换行
    open(2);
    expect(document.querySelector('[data-probe-row="2"] [data-field="request"]')?.textContent).toBe(
      '请求原文 A\n请求原文 B',
    );
    expect(document.querySelector('[data-probe-row="2"] [data-field="failure"]')?.textContent).toContain(
      '疑似降智',
    );
  });

  test('【故意造出的失败】读不到：写没读成和原因，不画空列表', async () => {
    renderLog({ state: 'unreadable', why: '没查成：连不上库' });
    const alert = await waitFor(() => {
      const el = document.querySelector('[data-probe-log="unreadable"]');
      if (!(el instanceof HTMLElement)) throw new Error('还没有没读成');
      return el;
    });
    expect(alert.textContent).toContain('没读成');
    expect(alert.textContent).toContain('连不上库');
    expect(document.querySelector('[data-probe-log="list"]')).toBeNull();
    expect(document.querySelector('[data-probe-log="empty"]')).toBeNull();
  });

  test('读成了但真没有记录：写还没有探测记录', async () => {
    renderLog({ state: 'ok', channels: [], latestByRoute: [] });
    const empty = await waitFor(() => {
      const el = document.querySelector('[data-probe-log="empty"]');
      if (!(el instanceof HTMLElement)) throw new Error('还没有空态');
      return el;
    });
    expect(empty.textContent).toBe('还没有探测记录');
  });

  test('没探里原文带「按需」那一句的标「按需」，别的没探还是「没探」；图例一起写', async () => {
    renderLog(
      historyOf([
        probeCell({
          id: 1,
          routeId: 'r-cursor',
          channelId: 'ch-cursor',
          probedAt: mins(10),
          result: 'not_probed',
          failureReason: `${ROUTE_PROBE_ON_DEMAND_MARK}。还没真探过`,
        }),
        probeCell({
          id: 2,
          routeId: 'r-cursor',
          channelId: 'ch-cursor',
          probedAt: mins(20),
          result: 'not_probed',
          failureReason: '没有用途在用，不花额度去探',
        }),
      ]),
    );
    // 全是没真探：列表区写明，记录折在下面，点开才看
    await waitFor(() => expect(document.querySelector('[data-probe-log="skipped"]')).toBeTruthy());
    expect(rowOrder()).toEqual([]);
    fireEvent.click(
      within(document.querySelector('[data-probe-log="skipped"]') as HTMLElement).getByRole('button'),
    );
    await waitFor(() => expect(rowOrder()).toEqual(['1', '2']));
    const onDemand = document.querySelector('[data-probe-row="1"]') as HTMLElement;
    expect(onDemand.getAttribute('data-result')).toBe('on_demand');
    expect(within(onDemand).getByText('按需')).toBeTruthy();
    const plain = document.querySelector('[data-probe-row="2"]') as HTMLElement;
    expect(plain.getAttribute('data-result')).toBe('not_probed');
    expect(within(plain).getByText('没探')).toBeTruthy();
    expect(historyStrip().querySelector('[data-cell]')).toBeNull();
    expect(document.querySelector('[data-probe-log="legend"]')?.textContent).toContain('按需：');
  });

  test('挤出 60 格的路由，它自己的最近一次也列出来', async () => {
    const cells = Array.from({ length: 60 }, (_, i) =>
      probeCell({
        id: i + 10,
        routeId: 'r-cursor',
        channelId: 'ch-cursor',
        probedAt: mins(i),
        result: 'passed',
        failureReason: null,
      }),
    );
    const old = probeCell({
      id: 1,
      routeId: 'r-other',
      channelId: 'ch-cursor',
      probedAt: mins(500),
      result: 'passed',
      failureReason: null,
    });
    renderLog({
      state: 'ok',
      channels: [
        { channelId: 'ch-cursor', cells, skipped: [], avgDurationMs: null, passed: 60, attempted: 60 },
      ],
      latestByRoute: [old],
    });
    await waitFor(() => expect(rowOrder()).toHaveLength(61));
    expect(rowOrder().at(-1)).toBe('1');
  });
});

describe('渠道状态页重做（#1366）：折叠、手风琴、状态语义、筛选、搜索', () => {
  test('默认全部折叠：一行摘要，路由原文、立即探测按钮一个都不铺', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-claude' });
    await waitFor(() => routeRow('r-ca-opus'));
    // 渠道行：名字、状态、几条在线、最近一次探测时间，一行写完
    expect(card('ch-claude').textContent).toMatch(/在线/);
    expect(card('ch-claude').textContent).toMatch(/分钟前探的/);
    // 路由行折叠：按钮 aria-expanded=false，没有原文、没有每行的「立即探测」
    const toggles = Array.from(document.querySelectorAll('[data-route] button[aria-expanded]'));
    expect(toggles.length).toBeGreaterThan(1);
    expect(toggles.every((el) => el.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(screen.queryByRole('button', { name: '立即探测' })).toBeNull();
    expect(document.querySelector('[data-route] pre')).toBeNull();
  });

  test('手风琴：展开一条，上一条自动收起，一次只开一个', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-claude' });
    await waitFor(() => routeRow('r-ca-opus'));
    openRoute('r-ca-opus');
    expect(document.querySelectorAll('[data-route] button[aria-expanded="true"]')).toHaveLength(1);
    openRoute('r-ca-sonnet');
    const opened = document.querySelectorAll('[data-route] button[aria-expanded="true"]');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.closest('[data-route]')?.getAttribute('data-route')).toBe('r-ca-sonnet');
    // 再点一下自己：收起
    fireEvent.click(opened[0] as Element);
    expect(document.querySelectorAll('[data-route] button[aria-expanded="true"]')).toHaveLength(0);
  });

  /** 一个渠道被人关了、一个没有任何用途在用、一个真坏了：三样分开。 */
  const semanticsApi = () => {
    const api = createMockApi({ live: false });
    const routing = api.routing.bind(api);
    Object.assign(api, {
      routing: async () => {
        const data = await routing();
        return {
          ...data,
          channels: [
            ...data.channels,
            { id: 'ch-off', name: '人关的渠道', billing: 'subscription' as const, enabled: false },
            { id: 'ch-dry', name: '没人用的渠道', billing: 'subscription' as const, enabled: true },
          ],
          routes: [
            ...data.routes,
            route('r-off', 'ch-off', { modelId: data.models[0]?.id ?? 'm1' }),
            route('r-dry', 'ch-dry', { modelId: data.models[0]?.id ?? 'm1' }),
          ],
        };
      },
    });
    return api;
  };

  test('没用途在用的路由点完立即探测：灰的「未被用途使用」不变，旁边写这一次通不通（#1630）', async () => {
    const api = semanticsApi();
    const routing = api.routing.bind(api);
    Object.assign(api, {
      routing: async () => {
        const data = await routing();
        return {
          ...data,
          routes: data.routes.map((r) =>
            r.id === 'r-dry'
              ? { ...r, probe: { state: 'ok' as const, at: new Date().toISOString(), detail: '答上了：OK' } }
              : r,
          ),
        };
      },
    });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-dry', api });
    await waitFor(() => routeRow('r-dry'));
    const row = routeRow('r-dry');
    expect(row.getAttribute('data-kind')).toBe('unused');
    expect(row.textContent).toContain('未被用途使用');
    expect(row.textContent).toContain('探过：通');
    expect(row.textContent).not.toContain('故障');
  });

  test('已关、未被用途使用不显示成故障（不画红、不进故障数）；只有探不通的才是故障', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status', api: semanticsApi() });
    await screen.findByRole('list', { name: '渠道状态' });
    await waitFor(() => card('ch-off'));
    expect(card('ch-off').getAttribute('data-kind')).toBe('off');
    expect(card('ch-off').textContent).toContain('已关');
    expect(card('ch-off').textContent).not.toContain('故障');
    expect(card('ch-off').className).not.toContain('st-fail');
    expect(card('ch-dry').getAttribute('data-kind')).toBe('unused');
    expect(card('ch-dry').textContent).toContain('未被用途使用');
    expect(card('ch-dry').textContent).not.toContain('故障');
    expect(card('ch-cursor').getAttribute('data-kind')).toBe('fault');
    // 故障筛选里只有真坏的，没有已关、没用的
    fireEvent.click(screen.getByRole('button', { name: /^故障/ }));
    const ids = Array.from(document.querySelectorAll('[data-channel]')).map((el) =>
      el.getAttribute('data-channel'),
    );
    expect(ids).toContain('ch-cursor');
    expect(ids).not.toContain('ch-off');
    expect(ids).not.toContain('ch-dry');
  });

  test('筛选：已关只留人关的；未使用只留没用途在用的；全部回来', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status', api: semanticsApi() });
    await waitFor(() => card('ch-off'));
    const shown = () =>
      Array.from(document.querySelectorAll('ol[aria-label="渠道状态"] > [data-channel]')).map((el) =>
        el.getAttribute('data-channel'),
      );
    fireEvent.click(screen.getByRole('button', { name: /^已关/ }));
    expect(shown()).toEqual(['ch-off']);
    fireEvent.click(screen.getByRole('button', { name: /^未使用/ }));
    expect(shown()).toEqual(['ch-dry']);
    fireEvent.click(document.querySelector('[data-filter="all"]') as Element);
    expect(shown().length).toBeGreaterThan(5);
  });

  test('故障的渠道置顶；搜索按渠道名、路由号、模型名找；搜不到写明', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status', api: semanticsApi() });
    await waitFor(() => card('ch-off'));
    const shown = () =>
      Array.from(document.querySelectorAll('ol[aria-label="渠道状态"] > [data-channel]')).map((el) =>
        el.getAttribute('data-channel'),
      );
    const first = document.querySelector('ol[aria-label="渠道状态"] > [data-channel]');
    expect(first?.getAttribute('data-kind')).toBe('fault');
    const box = screen.getByRole('searchbox', { name: '搜索渠道' });
    fireEvent.change(box, { target: { value: 'r-grok' } });
    expect(shown()).toEqual(['ch-grok']);
    fireEvent.change(box, { target: { value: '人关的' } });
    expect(shown()).toEqual(['ch-off']);
    fireEvent.change(box, { target: { value: '根本没有这个东西' } });
    expect(shown()).toEqual([]);
    expect(screen.getByText(/没有符合的渠道/)).toBeTruthy();
  });

  test('搜索有匹配时，详情显示结果里的渠道：原来的还在结果里就留着，不在就改看第一个', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-claude' });
    await screen.findByRole('list', { name: '渠道状态' });
    await waitFor(() => expect(screen.getByRole('heading', { name: /Claude 订阅/ })).toBeTruthy());
    const box = screen.getByRole('searchbox', { name: '搜索渠道' });
    fireEvent.change(box, { target: { value: 'Claude' } });
    expect(screen.getByRole('heading', { name: /Claude 订阅/ })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Claude 订阅 的路由' })).toBeTruthy();
    fireEvent.change(box, { target: { value: 'Grok' } });
    expect(screen.getByRole('heading', { name: /Grok/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Claude 订阅/ })).toBeNull();
    expect(screen.getByRole('list', { name: 'Grok 的路由' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /返回渠道列表/ })).toBeTruthy();
  });

  test('任务断链后引擎自动排的立即探测（#1636）：顶上和路由行都写「任务 #N 断链后自动探」，不写成人点的', async () => {
    const api = createMockApi({ live: false });
    const base = await api.routeProbeStatus();
    // 假数据里带的那条自动探已经过了 30 分钟，页面顶上不挂；换成刚探完的一条和一条在探的
    const at = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
    Object.assign(api, {
      routeProbeStatus: async () => ({
        ...base,
        requests: [
          {
            requestId: 'auto-running',
            requestedAt: at(5_000),
            by: 'engine:route-probe-now',
            routeIds: ['r-grok'],
            source: { kind: 'task-route-broken' as const, issueNumber: 1621 },
            state: 'running' as const,
            startedAt: at(2_000),
            results: [],
          },
          {
            requestId: 'auto-done',
            requestedAt: at(120_000),
            by: 'engine:route-probe-now',
            routeIds: ['r-cursor'],
            source: { kind: 'task-route-broken' as const, issueNumber: 1622 },
            state: 'done' as const,
            startedAt: at(110_000),
            finishedAt: at(100_000),
            results: [],
          },
        ],
      }),
    });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-grok', api });
    await waitFor(() => routeRow('r-grok'));
    const banner = await screen.findByRole('list', { name: '立即探测' });
    expect(banner.textContent).toContain('任务 #1621 断链后自动探：引擎已接手，在探');
    expect(banner.textContent).toContain('任务 #1622 断链后自动探，探完了');
    expect(openRoute('r-grok').textContent).toContain('任务 #1621 断链后自动探');
  });

  test('搜索没有匹配时，详情不再渲染渠道，改写空态；窄屏返回按钮不出现', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-claude' });
    await screen.findByRole('list', { name: '渠道状态' });
    await waitFor(() => expect(screen.getByRole('heading', { name: /Claude 订阅/ })).toBeTruthy());
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索渠道' }), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('没有可看的渠道，换个搜索词或筛选')).toBeTruthy();
    expect(screen.getByText(/没有符合的渠道：「zzz」/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Claude 订阅/ })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.queryByRole('button', { name: '探这个渠道' })).toBeNull();
    expect(screen.queryByRole('button', { name: /返回渠道列表/ })).toBeNull();
    expect(screen.queryByRole('list', { name: /的路由$/ })).toBeNull();
  });

  test('窄屏：点一行进详情页，返回回到列表（宽屏两栏并排，不看它）', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status' });
    await screen.findByRole('list', { name: '渠道状态' });
    const back = () => screen.queryByRole('button', { name: /返回渠道列表/ });
    fireEvent.click(within(card('ch-grok')).getByRole('button'));
    await waitFor(() => expect(back()).toBeTruthy());
    const listCol = screen.getByRole('list', { name: '渠道状态' }).closest('div.hidden, div.min-w-0');
    expect(document.querySelector('.hidden.xl\\:block')).toBeTruthy();
    expect(listCol).toBeTruthy();
    fireEvent.click(back() as HTMLElement);
    expect(screen.getByRole('list', { name: '渠道状态' }).closest('.hidden')).toBeNull();
  });
});
