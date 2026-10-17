// @vitest-environment happy-dom
// 渠道状态页（#1087；驾驶舱改版 2026-10-07「渠道状态无法探测」；近 60 次真历史 #1139）：左栏按顺位排的渠道卡，
// 每张卡一条格子（一次探针一格），点开看那一次的耗时和原文；右边每条路由的最近一次结论。单条、整个渠道、全部都能
// 「立即探测」，点了马上看到排队 / 探测中，探完自己刷新。
// 故意造出的失败：引擎关着（按钮置灰、写明，历史照样在）、点了被拒（写明是哪样）、立即探测的记录读不到（写没读成）、
// 探针历史读不到（写没查成、不画格子）、运行中失败的渠道顺到谁没有。
import { type ProbeHistoryCell, probeHistoryStrips } from '@fleet-dao/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { Channel, ChannelState, Route, RouteProbeHistory, RouteProbeStatus } from '../api/types';
import { failoverOf } from '../lib/provider-status';
import RoutingStatus from '../routes/routing-status';
import { renderApp } from '../test/harness';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 只把 Date 钉在本地今天的某个钟点（setTimeout 等不假，React / testing-library 的等待照常走）。 */
const pinClock = (hour: number, minute: number) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 13, hour, minute, 0, 0));
};

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

/** 已关、未使用的路由默认折成一行：点开（等折叠行出来再点）。 */
const openQuiet = async () => {
  const toggle = await waitFor(() => {
    const el = document.querySelector('[data-route-fold="quiet"] button[aria-expanded]');
    if (!(el instanceof HTMLElement)) throw new Error('折叠行还没出来');
    return el;
  });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
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

  test('写明为什么、顺延到谁（渠道和模型）、下次探测：直接读引发失败的那条路由的 probeNextAt', () => {
    const routes = [
      route('r1', 'c1', {
        probe: { state: 'ok', at: '2026-10-05T01:00:00Z' },
        probeTier: 'active',
        probeNextAt: '2026-10-05T02:00:00Z',
      }),
    ];
    expect(failoverOf(failedState(), routes, routing)).toMatchObject({
      reason: '上游断连（已重试 2 次）',
      failedRouteId: 'r1',
      fallback: { channelName: '中转站', modelName: 'Opus 5.5' },
      nextProbeAt: '2026-10-05T02:00:00Z',
    });
  });

  test('退避中的下次探测也是 probeNextAt，不看原文里写了什么', () => {
    const routes = [
      route('r1', 'c1', {
        alive: false,
        probe: {
          state: 'failed',
          at: '2026-10-05T01:00:00Z',
          detail: '503 容量满。退避中，下次约 03:00 再探',
        },
        probeTier: 'active',
        probeFailStreak: 3,
        probeNextAt: '2026-10-05T02:00:00Z',
      }),
    ];
    expect(failoverOf(failedState(), routes, routing)?.nextProbeAt).toBe('2026-10-05T02:00:00Z');
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
    // 四段脚注收进 ⓘ：点开才看（#1903）
    expect(screen.queryByText(/绿灯只表示本节点最近一轮抽测通过/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '怎么看这些状态' }));
    expect(screen.getByText(/绿灯只表示本节点最近一轮抽测通过/)).toBeTruthy();
  });

  /** 退避中的 cursor 路由：连不通 6 次，下次探测在「钉住的现在」之后 afterMin 分钟；返回「下次探测」那一行。 */
  const backoffNotice = async (afterMin: number) => {
    const api = createMockApi({ live: false });
    const cursor = api.state().routes.find((r) => r.id === 'r-cursor');
    if (!cursor?.probe) throw new Error('假数据没有 cursor 路由');
    cursor.probeFailStreak = 6;
    cursor.probeNextAt = new Date(Date.now() + afterMin * 60_000).toISOString();
    // 原文里写的退避不再有人读：故意写一个对不上的
    cursor.probe = { ...cursor.probe, detail: '连探两次都没通。退避中，下次约 03:00 再探（连着不通 2 次）' };
    renderApp(<RoutingStatus />, { api, route: '/routing/status' });
    await screen.findByRole('list', { name: '渠道状态' });
    fireEvent.click(within(card('ch-cursor')).getByRole('button'));
    return waitFor(() => {
      const el = routeRow('r-cursor').querySelector('[data-probe-next]');
      if (!(el instanceof HTMLElement)) throw new Error('还没有下次探测那一行');
      return el;
    });
  };

  test('退避中：路由行写连着不通几次和下次几点，读的是 probeFailStreak、probeNextAt，不带截断，也不标检测中断', async () => {
    pinClock(10, 0); // 白天 10:00，100 分钟后还是当天，不随 CI 几点跑变
    const notice = await backoffNotice(100);
    expect(notice.textContent).toMatch(/^退避中，连着不通 6 次，下次约 \d{2}:\d{2}$/);
    expect(notice.className).not.toContain('truncate');
    expect(routeRow('r-cursor').getAttribute('data-kind')).toBe('fault');
  });

  test('退避中的下次探测跨过零点：钉在 23:50，下次 00:04，页面写「下次约 明天 00:04」', async () => {
    pinClock(23, 50);
    const notice = await backoffNotice(14);
    expect(notice.textContent).toBe('退避中，连着不通 6 次，下次约 明天 00:04');
    expect(routeRow('r-cursor').getAttribute('data-kind')).toBe('fault');
  });

  test('一个渠道 200 多条路由：默认只铺要人看的，已关、未使用折成一行，点开先 20 条，「再看 50 条」分批', async () => {
    const api = createMockApi({ live: false, manyRoutes: 213 });
    const routes = api.state().routes.filter((r) => r.channelId === 'ch-cursor');
    expect(routes.length).toBeGreaterThan(200);
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-cursor', api });
    await waitFor(() => routeRow('r-cursor'));
    const rows = () => document.querySelectorAll('[data-route]').length;
    // 要人看的：不通 1 条、疑似换模型 1 条；其余 213 条没用途在用，全折起来
    expect(rows()).toBe(2);
    const fold = document.querySelector('[data-route-fold="quiet"] button[aria-expanded]') as HTMLElement;
    expect(fold.textContent).toContain('未使用 213 条');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    // 点开：先 20 条，每次「再看」50 条
    fireEvent.click(fold);
    expect(rows()).toBe(2 + 20);
    const more = () => document.querySelector('[data-route-fold="more"]') as HTMLElement;
    expect(more().textContent).toContain('再看 50 条');
    fireEvent.click(more());
    expect(rows()).toBe(2 + 70);
    // 再点一下折回去
    fireEvent.click(fold);
    expect(rows()).toBe(2);
  });

  test('点开折叠行：先铺前 20 条（第 20 条在、第 21 条还没有）', async () => {
    const api = createMockApi({ live: false, manyRoutes: 213 });
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-cursor', api });
    await waitFor(() => routeRow('r-cursor'));
    await openQuiet();
    const last = routeRow('r-cursor-bulk-020');
    expect(last).toBeTruthy();
    expect(document.querySelector('[data-route="r-cursor-bulk-021"]')).toBeNull();
  });

  test('路由行按新列显示：上次（时刻、种类、触发者）、下次（时刻、档），活跃 / 不活跃 / 不在用各一句', async () => {
    pinClock(10, 0); // 活跃的下次是 55 分钟后：不钉的话 23:05 以后跑就变「明天」
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-relay' });
    await openQuiet();
    await waitFor(() => routeRow('r-rl-opus'));
    const last = (id: string) => routeRow(id).querySelector('[data-probe-last]')?.textContent;
    const next = (id: string) => routeRow(id).querySelector('[data-probe-next]')?.textContent;
    // 活跃的中转模型：身份题，触发者来自探测记录
    expect(last('r-rl-opus')).toBe('上次 5 分钟前 · 身份题 · 定时');
    expect(next('r-rl-opus')).toMatch(/^下次约 \d{2}:\d{2}（活跃，每小时）$/);
    // 不活跃：每天一次，下次在明天
    expect(last('r-rl-gpt')).toBe('上次 5 分钟前 · 连通 · 定时');
    expect(next('r-rl-gpt')).toMatch(/^下次约 明天 \d{2}:\d{2}（不活跃，每天）$/);
    // 不在用：不主动探
    await openQuiet();
    expect(next('r-rl-fable')).toBe('不主动探（没用途在用）');
  });

  test('晚于下次探测时刻 20 分钟：路由行标「检测中断」并画红，写本该几点探', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-relay' });
    await waitFor(() => routeRow('r-rl-kimi'));
    const row = routeRow('r-rl-kimi');
    expect(row.getAttribute('data-kind')).toBe('interrupted');
    expect(within(row).getByText('检测中断')).toBeTruthy();
    expect(row.className).toContain('border-st-fail');
    const next = row.querySelector('[data-probe-next]');
    expect(next?.getAttribute('data-probe-next')).toBe('fail');
    expect(next?.textContent).toMatch(/^检测中断：本该 \d{2}:\d{2} 探，已过 [67]\d 分钟没探$/);
    expect(next?.className).toContain('text-ink-fail');
    // 同一个渠道里没晚的路由不受影响
    expect(routeRow('r-rl-gpt').getAttribute('data-kind')).toBe('live');
  });

  test('疑似换模型的路由：橙色一档，不是故障；说明里写的是「疑似换模型」', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-cursor' });
    await waitFor(() => expect(routeRow('r-cursor-hi').getAttribute('data-kind')).toBe('degraded'));
    expect(routeRow('r-cursor-hi').textContent).toContain('疑似换模型·已按不在线处理');
    // 触发者直接读路由目录的 probeTrigger（mock 里 cursor-hi 是派前、cursor 是断链）
    expect(routeRow('r-cursor-hi').querySelector('[data-probe-last]')?.textContent).toContain('派前');
    expect(routeRow('r-cursor').querySelector('[data-probe-last]')?.textContent).toContain('断链');
    expect(document.body.textContent).not.toContain('疑似降智');
  });

  test('顶上的说明换成三档节奏的那一句，不再写「Mirasim、Cursor、Grok 探通后 2 小时一轮」', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status' });
    await screen.findByRole('list', { name: '渠道状态' });
    // 页头一行写概要，探测节奏这一句收在标题旁的 ⓘ 里（#1897），点开才看
    fireEvent.click(document.querySelector('[data-description-hint]') as HTMLElement);
    expect(
      await screen.findByText((text) =>
        text.includes(
          '活跃路由每小时探一次，不活跃的每天一次，派活前 15 分钟内没探过会先探；中转渠道的活跃模型额外问一道身份题。',
        ),
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('2 小时一轮');
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

  test('晚于下次探测时刻 20 分钟：这个渠道改成「检测中断」，别的渠道不受影响', async () => {
    const api = createMockApi({ live: false });
    const layers = await api.routingLayers();
    const late = new Date(Date.now() - 30 * 60_000).toISOString();
    for (const p of layers.purposes) {
      for (const m of p.models)
        for (const r of m.routes) if (r.channelId === 'ch-claude') r.probeNextAt = late;
    }
    Object.assign(api, { routingLayers: async () => layers });
    renderApp(<RoutingStatus />, { route: '/routing/status', api });
    await screen.findByRole('list', { name: '渠道状态' });
    expect(card('ch-claude').getAttribute('data-state')).toBe('interrupted');
    expect(card('ch-claude').textContent).toContain('检测中断');
    expect(card('ch-cursor').getAttribute('data-state')).toBe('down');
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
    await openQuiet();
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
    // 探测记录默认只铺最近 10 条（#1837），点「再看」铺到 60 条为止
    const logButtons = () =>
      within(screen.getByRole('list', { name: '探测记录列表' })).getAllByRole('button');
    expect(logButtons()).toHaveLength(10);
    for (const more of [/^再看 20 条/, /^再看 20 条/, /^再看 10 条/]) {
      fireEvent.click(screen.getByRole('button', { name: more }));
    }
    expect(logButtons()).toHaveLength(60);
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
        kind: 'ping',
        trigger: 'scheduled',
      }),
      probeCell({
        id: 2,
        routeId: 'r-cursor',
        channelId: 'ch-cursor',
        probedAt: mins(10),
        result: 'failed',
        durationMs: 8000,
        failureReason: '疑似换成旧模型：题 现任日本首相是谁？，新答案应为 高市早苗，实答 石破茂',
        requestText: '请求原文 A\n请求原文 B',
        responseText: '响应原文 X\n响应原文 Y',
        checkQuestion: '现任日本首相是谁？',
        checkExpected: '高市早苗/Takaichi',
        checkOldAnswer: '石破茂/Ishiba',
        checkAnswer: '石破茂',
        checkPassed: false,
        selfIdentity: '某个小模型',
        kind: 'identity',
        trigger: 'dispatch',
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
        kind: 'ping',
        trigger: 'break',
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

  test('从新到旧列出；每行带种类和触发者；格子单独一种颜色，橙色叫「疑似换模型」', async () => {
    renderLog(logHistory());
    await waitFor(() => expect(rowOrder()).toEqual(['2', '3', '1']));
    const source = (id: number) =>
      document.querySelector(`[data-probe-row="${id}"] [data-field="source"]`)?.textContent;
    expect(source(1)).toBe('连通 · 定时');
    expect(source(2)).toBe('身份题 · 派前');
    expect(source(3)).toBe('连通 · 断链');
    const row = document.querySelector('[data-probe-row="2"]') as HTMLElement;
    expect(row.getAttribute('data-result')).toBe('doubt');
    expect(within(row).getByText('疑似换模型')).toBeTruthy();
    expect(document.body.textContent).not.toContain('疑似降智');
    const cell = historyStrip().querySelector('[data-cell="2"]');
    expect(cell?.getAttribute('data-result')).toBe('doubt');
    expect(cell?.className).toContain('bg-st-doubt');
    // 颜色图例只留一份（#1922）：格子条下面那行「绿通过 · 红不通 · 橙疑似换模型」并进探测记录的图例，
    // 图例里橙色色块就叫「疑似换模型」（原断言：格子条文字含「橙疑似换模型」）
    const legend = document.querySelector('[data-probe-log="legend"]') as HTMLElement;
    expect(legend.textContent).toContain('疑似换模型：身份题说出了旧答案');
    expect(legend.querySelector('.bg-st-doubt')).toBeTruthy();
  });

  test('身份题那一行展开：题、新答案、旧答案、实答、自报身份；折叠时不铺；连通那行没有题', async () => {
    renderLog(logHistory());
    await waitFor(() => expect(rowOrder()).toHaveLength(3));
    expect(document.querySelector('[data-probe-row="2"] [data-field="check"]')).toBeNull();
    open(2);
    const row = document.querySelector('[data-probe-row="2"]') as HTMLElement;
    expect(row.querySelector('[data-field="question"]')?.textContent).toBe('现任日本首相是谁？');
    expect(row.querySelector('[data-field="expected"]')?.textContent).toBe('高市早苗/Takaichi');
    expect(row.querySelector('[data-field="old"]')?.textContent).toBe('石破茂/Ishiba');
    expect(row.querySelector('[data-field="answer"]')?.textContent).toBe('石破茂');
    expect(row.querySelector('[data-field="identity"]')?.textContent).toBe('某个小模型');
    open(1);
    expect(document.querySelector('[data-probe-row="1"] [data-field="check"]')).toBeNull();
  });

  test('算术题时代的老记录（没有种类、带着题）：照原样显示，标「旧版降智题」，没有旧答案那一栏', async () => {
    renderLog(
      historyOf([
        probeCell({
          id: 1,
          routeId: 'r-cursor',
          channelId: 'ch-cursor',
          probedAt: mins(10),
          result: 'failed',
          failureReason: '疑似降智：题 17 乘 23，应为 391，实答 381',
          checkQuestion: '17 乘 23 等于多少？',
          checkExpected: '391',
          checkAnswer: '381',
          checkPassed: false,
        }),
      ]),
    );
    await waitFor(() => expect(rowOrder()).toEqual(['1']));
    const row = document.querySelector('[data-probe-row="1"]') as HTMLElement;
    expect(row.querySelector('[data-field="legacy"]')?.textContent).toBe('旧版降智题');
    open(1);
    expect(row.querySelector('[data-field="question"]')?.textContent).toBe('17 乘 23 等于多少？');
    expect(row.querySelector('[data-field="old"]')).toBeNull();
    // 没有种类和触发者可写，这一行的来源栏里只有这个标
    expect(row.querySelector('[data-field="source"]')?.textContent).toBe('旧版降智题');
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
    // 疑似换模型的行展开：原文保留换行
    open(2);
    expect(document.querySelector('[data-probe-row="2"] [data-field="request"]')?.textContent).toBe(
      '请求原文 A\n请求原文 B',
    );
    expect(document.querySelector('[data-probe-row="2"] [data-field="failure"]')?.textContent).toContain(
      '疑似换模型',
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

  test('默认只铺最近 10 条，点「再看 20 条」多出 20 条，余下不足 20 时按实数写（#1837）', async () => {
    // 一次铺满 60 条（渠道状态页整页 13000px）这一条会红。
    renderLog(
      historyOf(
        Array.from({ length: 35 }, (_, i) =>
          probeCell({
            id: i + 1,
            routeId: 'r-cursor',
            channelId: 'ch-cursor',
            probedAt: mins(100 - i),
            result: 'passed',
            durationMs: 1000,
            failureReason: null,
            requestText: 'PING',
            responseText: 'OK',
          }),
        ),
      ),
    );
    await waitFor(() => expect(rowOrder()).toHaveLength(10));
    // 新的在上：最后一格（id 35）最新
    expect(rowOrder()[0]).toBe('35');
    fireEvent.click(screen.getByRole('button', { name: /^再看 20 条/ }));
    expect(rowOrder()).toHaveLength(30);
    fireEvent.click(screen.getByRole('button', { name: /^再看 5 条/ }));
    expect(rowOrder()).toHaveLength(35);
    expect(document.querySelector('[data-probe-log="more"]')).toBeNull();
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

  test('没真探的记录统一标「没探」，折在下面；图例里没有「按需」', async () => {
    renderLog(
      historyOf([
        probeCell({
          id: 1,
          routeId: 'r-cursor',
          channelId: 'ch-cursor',
          probedAt: mins(10),
          result: 'not_probed',
          failureReason: '这一轮没探：账号池整池暂停',
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
    const plain = document.querySelector('[data-probe-row="2"]') as HTMLElement;
    expect(plain.getAttribute('data-result')).toBe('not_probed');
    expect(within(plain).getByText('没探')).toBeTruthy();
    expect(historyStrip().querySelector('[data-cell]')).toBeNull();
    expect(document.querySelector('[data-probe-log="legend"]')?.textContent).not.toContain('按需');
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
    await waitFor(() => expect(rowOrder()).toHaveLength(10));
    for (const more of [/^再看 20 条/, /^再看 20 条/, /^再看 11 条/]) {
      fireEvent.click(screen.getByRole('button', { name: more }));
    }
    expect(rowOrder()).toHaveLength(61);
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
    await openQuiet();
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
      Array.from(document.querySelectorAll('ul[aria-label="渠道状态"] > [data-channel]')).map((el) =>
        el.getAttribute('data-channel'),
      );
    fireEvent.click(
      within(screen.getByRole('group', { name: '按状态筛选' })).getByRole('button', { name: /^已关/ }),
    );
    expect(shown()).toEqual(['ch-off']);
    fireEvent.click(
      within(screen.getByRole('group', { name: '按状态筛选' })).getByRole('button', { name: /^未使用/ }),
    );
    expect(shown()).toEqual(['ch-dry']);
    fireEvent.click(
      within(screen.getByRole('group', { name: '按状态筛选' })).getByRole('button', { name: /^全部/ }),
    );
    expect(shown().length).toBeGreaterThan(5);
  });

  test('故障的渠道置顶；搜索按渠道名、路由号、模型名找；搜不到写明', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status', api: semanticsApi() });
    await waitFor(() => card('ch-off'));
    const shown = () =>
      Array.from(document.querySelectorAll('ul[aria-label="渠道状态"] > [data-channel]')).map((el) =>
        el.getAttribute('data-channel'),
      );
    const first = document.querySelector('ul[aria-label="渠道状态"] > [data-channel]');
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

  test('搜索没有匹配时，详情不再渲染渠道，改写空态', async () => {
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
    expect(screen.queryByRole('list', { name: /的路由$/ })).toBeNull();
  });
});

describe('渠道状态页：连通但额度耗尽（#2939）', () => {
  // 假数据里 ch-claude 有三条路：r-cb-opus 连通但额度耗尽（上游给了重置时刻），r-ca-opus、r-ca-sonnet 正常
  const baseHistory = async (api: ReturnType<typeof createMockApi>) => {
    const h = await api.routeProbeHistory();
    if (h.state !== 'ok') throw new Error('假数据历史没读成');
    return h;
  };
  const withLatest = async (
    api: ReturnType<typeof createMockApi>,
    patch: (c: ProbeHistoryCell) => ProbeHistoryCell,
  ): Promise<RouteProbeHistory> => {
    const h = await baseHistory(api);
    const swap = (c: ProbeHistoryCell) => (c.channelId === 'ch-claude' ? patch(c) : c);
    return {
      ...h,
      latestByRoute: h.latestByRoute.map(swap),
      channels: h.channels.map((s) => ({ ...s, cells: s.cells.map(swap) })),
    };
  };
  const show = (api: ReturnType<typeof createMockApi>) =>
    renderApp(<RoutingStatus />, { route: '/routing/status?p=ch-claude', api });

  test('部分路耗尽：渠道摘要、详情头部、路由行都写连通但额度耗尽和受影响路数，不说成整个渠道耗尽', async () => {
    show(createMockApi({ live: false }));
    await waitFor(() => expect(card('ch-claude').textContent).toContain('部分路额度耗尽'));
    expect(card('ch-claude').textContent).toContain('额度耗尽 1/3 路');
    expect(card('ch-claude').getAttribute('data-state')).toBe('ok');
    expect(card('ch-claude').textContent).not.toContain('连通但额度耗尽');
    const hero = document.querySelector('[data-channel-hero]');
    expect(hero?.textContent).toContain('3 条路里 1 条额度耗尽，其余可用');
    expect(hero?.textContent).toContain('额度耗尽 1/3 路');
    expect(hero?.textContent).toMatch(/预计 .+ 重置/);
    const hit = routeRow('r-cb-opus');
    expect(hit.querySelector('[data-route-quota]')?.textContent).toBe('连通但额度耗尽');
    expect(
      hit.getAttribute('aria-label') ?? hit.querySelector('button')?.getAttribute('aria-label'),
    ).toContain('连通但额度耗尽');
    // 正常对照：同渠道的另外两条路没有这个标
    expect(routeRow('r-ca-opus').querySelector('[data-route-quota]')).toBeNull();
    expect(routeRow('r-ca-opus').textContent).toContain('在线');
  });

  test('路由行展开：真实原因、额度重置时刻、响应原文；正常的路没有这些', async () => {
    show(createMockApi({ live: false }));
    await waitFor(() => routeRow('r-cb-opus'));
    const row = openRoute('r-cb-opus');
    expect(row.querySelector('[data-field="quota-detail"]')?.textContent).toContain('5 小时窗口额度耗尽');
    expect(row.querySelector('[data-field="quota-resets"]')?.textContent).toMatch(/^预计 .+ 重置$/);
    expect(row.querySelector('[data-field="quota-response"]')?.textContent).toContain(
      '5-hour usage limit reached',
    );
    expect(row.textContent).toContain('连通但额度耗尽');
    const ok = openRoute('r-ca-opus');
    expect(ok.querySelector('[data-field="quota-detail"]')).toBeNull();
    expect(ok.textContent).toContain('通过');
  });

  test('探针历史：额度记录的格子单独一色，tooltip / 读屏带重置说明；展开能看 detail、重置时间和响应原文；普通成功对照没有', async () => {
    show(createMockApi({ live: false }));
    const strip = await waitFor(historyStrip);
    const quotaCell = strip.querySelector('[data-result="quota"]');
    if (!(quotaCell instanceof HTMLElement)) throw new Error('没有额度耗尽的格子');
    expect(quotaCell.className).toContain('bg-st-wait');
    expect(quotaCell.title).toMatch(/连通但额度耗尽（预计 .+ 重置）/);
    expect(quotaCell.querySelector('.sr-only')?.textContent).toContain('连通但额度耗尽');
    expect(strip.querySelector('[data-result="passed"]')?.className).toContain('bg-st-done');
    const log = () => screen.getByRole('region', { name: '探测记录' });
    expect(log().textContent).toContain('连通但额度耗尽：探通了，但上游说额度用完了');
    fireEvent.click(quotaCell);
    await waitFor(() => expect(log().querySelector('[data-field="quota"]')).toBeTruthy());
    const q = log().querySelector('[data-field="quota"]') as HTMLElement;
    expect(q.textContent).toContain('5 小时窗口额度耗尽');
    expect(q.querySelector('[data-field="resets"]')?.textContent).toMatch(/^预计 .+ 重置$/);
    expect(log().querySelector('[data-field="response"]')?.textContent).toContain(
      '5-hour usage limit reached',
    );
    const row = log().querySelector('[data-probe-row][data-result="quota"]');
    expect(row?.textContent).toContain('连通但额度耗尽');
    // 对照：普通成功那行不带额度块
    const normal = log().querySelector('[data-probe-row][data-result="passed"]');
    expect(normal?.querySelector('[data-field="quota"]')).toBeNull();
    // 凭据不外露
    expect(document.body.textContent).not.toMatch(/sk-[A-Za-z0-9]{8,}|Bearer\s+\S+/);
  });

  test('手机：色条读屏汇总单报连通但额度耗尽几次；没有额度记录的渠道不多这一项', async () => {
    const real = window.matchMedia.bind(window);
    const spy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) =>
      query === '(max-width: 767px)'
        ? ({
            matches: true,
            media: query,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => false,
          } as MediaQueryList)
        : real(query),
    );
    try {
      show(createMockApi({ live: false }));
      const display = await waitFor(() => {
        const el = document.querySelector('[data-history="strip"] [data-strip-display]');
        if (!(el instanceof HTMLElement)) throw new Error('还没有色条');
        return el;
      });
      expect(display.getAttribute('aria-label')).toMatch(
        /^近 \d+ 次真探：通过 \d+、连通但额度耗尽 1、不通 \d+、疑似换模型 \d+$/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test('所有路都耗尽、上游没给重置时间：渠道说连通但额度耗尽，写重置时间上游没给，不编时刻', async () => {
    const api = createMockApi({ live: false });
    const h = await withLatest(api, (c) =>
      c.result === 'passed'
        ? { ...c, quotaExhausted: true, detail: '额度用完', resetsAt: undefined, responseText: '额度用完' }
        : c,
    );
    Object.assign(api, { routeProbeHistory: async () => h });
    show(api);
    await waitFor(() => expect(card('ch-claude').textContent).toContain('额度耗尽 3/3 路'));
    expect(
      card('ch-claude').getAttribute('aria-label') ??
        card('ch-claude').querySelector('button')?.getAttribute('aria-label'),
    ).toContain('连通但额度耗尽');
    const hero = document.querySelector('[data-channel-hero]');
    expect(hero?.textContent).toContain('3 条路额度都耗尽了');
    expect(hero?.textContent).toContain('重置时间上游没给');
    expect(hero?.textContent).not.toMatch(/预计 \d/);
    expect(openRoute('r-cb-opus').querySelector('[data-field="quota-resets"]')?.textContent).toBe(
      '重置时间上游没给',
    );
  });

  test('旧额度记录已被更新的成功覆盖 / 老行缺字段：照旧显示在线，不认定额度耗尽', async () => {
    const api = createMockApi({ live: false });
    // 额度记录比路由当前探针早 30 分钟：探针已经有更新的结果
    const stale = await withLatest(api, (c) =>
      c.routeId === 'r-cb-opus'
        ? { ...c, probedAt: new Date(Date.parse(c.probedAt) - 30 * 60_000).toISOString() }
        : c,
    );
    Object.assign(api, { routeProbeHistory: async () => stale });
    show(api);
    await waitFor(() => routeRow('r-cb-opus'));
    expect(card('ch-claude').textContent).not.toContain('额度耗尽');
    expect(routeRow('r-cb-opus').querySelector('[data-route-quota]')).toBeNull();
    cleanup();
    // 老行：没有新增字段
    const old = createMockApi({ live: false });
    const legacy = await withLatest(old, ({ quotaExhausted: _q, detail: _d, resetsAt: _r, ...rest }) => rest);
    Object.assign(old, { routeProbeHistory: async () => legacy });
    show(old);
    await waitFor(() => routeRow('r-cb-opus'));
    expect(card('ch-claude').textContent).not.toContain('额度耗尽');
    expect(document.querySelector('[data-result="quota"]')).toBeNull();
  });

  test('失败（认证 / 网络 / 临时 429）不画成额度耗尽；历史读不到明确报没读成', async () => {
    const api = createMockApi({ live: false });
    const failed = await withLatest(api, (c) =>
      c.routeId === 'r-cb-opus'
        ? { ...c, result: 'failed', failureReason: '429 临时限流，稍后重试', quotaExhausted: undefined }
        : c,
    );
    Object.assign(api, { routeProbeHistory: async () => failed });
    show(api);
    await waitFor(() => routeRow('r-cb-opus'));
    expect(card('ch-claude').textContent).not.toContain('额度耗尽');
    expect(document.querySelector('[data-result="quota"]')).toBeNull();
    cleanup();
    const broken = createMockApi({ live: false });
    Object.assign(broken, {
      routeProbeHistory: async () => ({ state: 'unreadable' as const, why: '没查成：连不上库' }),
    });
    show(broken);
    await waitFor(() => expect(document.querySelector('[data-history="unreadable"]')).toBeTruthy());
    expect(document.querySelector('[data-hero-notes]')?.textContent).toContain('额度状态没读成');
  });
});
