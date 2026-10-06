// @vitest-environment happy-dom
// 渠道状态页（#1087）：左边一排供应商卡（近 60 次柱条、平均耗时、可用率），点开看每一条的 request/response。
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { Channel, ChannelState, Route, Routing as RoutingShape } from '../api/types';
import { buildProviderCards, summaryLine } from '../lib/provider-status';
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

const shape = (
  channels: Channel[],
  routes: Route[],
  channelStates: ChannelState[] = [],
  models: RoutingShape['models'] = [],
): RoutingShape => ({
  channels,
  channelStates,
  pools: [],
  models,
  routes,
  hardBans: [],
  bans: [],
});

describe('provider-status：buildProviderCards', () => {
  test('每个渠道一张卡：近 60 次柱条格子数固定是 60，没探过的格写在最前', () => {
    const cards = buildProviderCards(
      shape(
        [channel('c1', 'Claude 订阅')],
        [
          route('r1', 'c1', {
            probe: { state: 'ok', at: '2026-10-05T01:00:00Z', detail: '答上了 OK · 用时 9 秒' },
          }),
        ],
      ),
      undefined,
    );
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c.ticks).toHaveLength(60);
    // 1 条路由：前面 59 格 off，最后 1 格是真结论
    expect(c.ticks.filter((t) => t.kind === 'off')).toHaveLength(59);
    expect(c.ticks[59]!.kind).toBe('ok');
    expect(c.okCount).toBe(1);
    expect(c.availability).toBe(1);
    expect(c.avgLatencySec).toBe(9);
    expect(c.current.kind).toBe('ok');
  });

  test('有的探通有的探针报错：状态成 partial、可用率按 ok/已探算', () => {
    const cards = buildProviderCards(
      shape(
        [channel('c1', '中转站')],
        [
          route('r1', 'c1', {
            probe: { state: 'ok', at: '2026-10-05T01:00:00Z', detail: '答上了 OK · 用时 8 秒' },
          }),
          route('r2', 'c1', {
            alive: false,
            probe: { state: 'failed', at: '2026-10-05T01:05:00Z', detail: '等了 150 秒还没起来' },
          }),
        ],
      ),
      undefined,
    );
    const c = cards[0]!;
    expect(c.current.kind).toBe('partial');
    expect(c.okCount).toBe(1);
    expect(c.downCount).toBe(1);
    expect(c.availability).toBe(0.5);
    expect(c.avgLatencySec).toBe(8);
  });

  test('渠道下架：状态 off，不画柱条', () => {
    const cards = buildProviderCards(shape([channel('c1', 'Cursor', false)], []), undefined);
    expect(cards[0]!.current.kind).toBe('off');
    expect(cards[0]!.current.label).toContain('已下架');
  });

  test('没探过的渠道：状态 unknown，「还没探到」写明原因', () => {
    const cards = buildProviderCards(shape([channel('c1', 'DeepSeek 接口')], [route('r1', 'c1')]), undefined);
    const c = cards[0]!;
    expect(c.current.kind).toBe('unknown');
    expect(c.current.label).toContain('还没探到');
    expect(c.availability).toBeUndefined();
    expect(c.avgLatencySec).toBeUndefined();
  });

  test('顶部汇总「N / M 正常」：下架的不算，down 的算坏', () => {
    const cards = buildProviderCards(
      shape(
        [channel('c1', 'a'), channel('c2', 'b'), channel('c3', 'off渠道', false)],
        [
          route('r1', 'c1', { probe: { state: 'ok', at: '2026-10-05T01:00:00Z' } }),
          route('r2', 'c2', {
            alive: false,
            probe: { state: 'failed', at: '2026-10-05T01:00:00Z', detail: '连不上' },
          }),
        ],
      ),
      undefined,
    );
    const s = summaryLine(cards);
    expect(s.total).toBe(2);
    expect(s.ok).toBe(1);
    expect(s.downNames).toEqual(['b']);
  });
});

describe('provider-status：运行中失败的渠道（#1118）', () => {
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
  const models = [{ id: 'm1', family: 'claude', displayName: 'Opus 5.5' }];
  const routes = [
    route('r1', 'c1', { probe: { state: 'ok', at: '2026-10-05T01:00:00Z', detail: '答上了 OK' } }),
    route('r2', 'c2', { probe: { state: 'ok', at: '2026-10-05T01:00:00Z' } }),
  ];
  const channels = [channel('c1', 'Claude 订阅'), channel('c2', '中转站')];

  test('disabled 的渠道：状态是「运行中失败，已顺延」，写明为什么、顺延到谁（渠道和模型）、下次探测时间', () => {
    const [c1, c2] = buildProviderCards(shape(channels, routes, [failedState()], models), undefined);
    expect(c1?.current).toMatchObject({
      kind: 'down',
      label: '运行中失败，已顺延',
      reason: '上游断连（已重试 2 次）',
    });
    expect(c1?.failover).toMatchObject({
      reason: '上游断连（已重试 2 次）',
      failedRouteId: 'r1',
      fallback: { channelName: '中转站', modelName: 'Opus 5.5' },
      // 引发失败的 r1 上次通了、claude-code 每 15 分钟一轮：01:00 + 15 分钟
      nextProbeAt: '2026-10-05T01:15:00.000Z',
      probeEveryMinutes: 15,
    });
    // 别的渠道不受影响
    expect(c2?.failover).toBeUndefined();
    expect(c2?.current.kind).toBe('ok');
    expect(summaryLine([c1, c2].filter((c) => c !== undefined)).downNames).toEqual(['Claude 订阅']);
  });

  test('按量放慢的执行方式（mirasim，通了隔 2 小时才再探）：下次探测按那个间隔算；上次没通的每轮都探', () => {
    const slow = [
      route('r1', 'c1', {
        hostId: 'mirasim',
        probe: { state: 'ok', at: '2026-10-05T01:00:00Z' },
      }),
    ];
    const [ok] = buildProviderCards(shape(channels, slow, [failedState()], models), undefined);
    expect(ok?.failover).toMatchObject({
      nextProbeAt: '2026-10-05T03:00:00.000Z',
      probeEveryMinutes: 120,
    });
    const failing = [
      route('r1', 'c1', {
        hostId: 'mirasim',
        alive: false,
        probe: { state: 'failed', at: '2026-10-05T01:00:00Z', detail: '连不上' },
      }),
    ];
    const [bad] = buildProviderCards(shape(channels, failing, [failedState()], models), undefined);
    expect(bad?.failover).toMatchObject({ nextProbeAt: '2026-10-05T01:15:00.000Z', probeEveryMinutes: 15 });
  });

  test('【故意造出的失败】顺到谁还没有、引发的路由探针没看过 / 已被删：照实写没有，不编一个顺延目标或探测时间', () => {
    const [c1] = buildProviderCards(
      shape(
        channels,
        [route('r1', 'c1')],
        [failedState({ fallbackChannelId: undefined, fallbackModelId: undefined })],
        models,
      ),
      undefined,
    );
    expect(c1?.failover).toMatchObject({ fallback: undefined, nextProbeAt: undefined });
    const [gone] = buildProviderCards(
      shape(channels, [route('r9', 'c1')], [failedState({ failedRouteId: undefined })], models),
      undefined,
    );
    expect(gone?.failover).toMatchObject({ failedRouteId: undefined, nextProbeAt: undefined });
  });

  test('已经改回 ok 的渠道（status ok）、已下架的渠道：不显示运行中失败', () => {
    const [back] = buildProviderCards(
      shape(channels, routes, [failedState({ status: 'ok', reason: '路由探针探通了 r1，渠道恢复' })], models),
      undefined,
    );
    expect(back?.failover).toBeUndefined();
    expect(back?.current.kind).toBe('ok');
    const [off] = buildProviderCards(
      shape([channel('c1', 'Claude 订阅', false), channels[1] as Channel], routes, [failedState()], models),
      undefined,
    );
    expect(off?.failover).toBeUndefined();
    expect(off?.current.kind).toBe('off');
  });
});

describe('routing-status 页面', () => {
  test('mock 渲染：左边每张供应商一张卡，点开右边看路由的 request/response 原文', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status' });
    // mock 里有 5 个渠道，每张卡都要在
    for (const name of ['Claude 订阅', '中转站', 'Cursor', 'Grok', 'DeepSeek 接口']) {
      expect(await screen.findByRole('button', { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    // 顶部汇总「N / M 正常」
    expect(await screen.findByText(/\/\s*\d+\s*正常/)).toBeTruthy();

    // 点开 Cursor 那张卡，看它的 detail 里那条探针报错的原文
    fireEvent.click(screen.getByRole('button', { name: /Cursor/ }));
    const details = await screen.findAllByText(/等了 150 秒还没起来/);
    expect(details.length).toBeGreaterThanOrEqual(1);

    // 跳到 DeepSeek（按量不探）那张卡：写明按量计费不自动探
    fireEvent.click(screen.getByRole('button', { name: /DeepSeek 接口/ }));
    expect((await screen.findAllByText(/按量计费|不自动探|还没探到/)).length).toBeGreaterThanOrEqual(1);
  });

  test('mock 里中转站运行中失败被顺延：卡上和详情里都写明为什么不可用、顺延到谁、下次探测', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status' });
    const relay = await screen.findByRole('button', { name: /中转站/ });
    expect(relay.getAttribute('data-state')).toBe('down');
    expect(within(relay).getByText('运行中失败，已顺延')).toBeTruthy();
    expect(relay.querySelector('[data-field="reason"]')?.textContent).toContain('上游断连');
    expect(relay.querySelector('[data-field="fallback"]')?.textContent).toBe('Claude 订阅 · Opus 5.5');
    expect(relay.querySelector('[data-field="next-probe"]')?.textContent).toContain('探通 r-rl-opus 才恢复');
    // 没出过事的渠道没有这一块
    const claude = await screen.findByRole('button', { name: /^Claude 订阅/ });
    expect(claude.querySelector('[data-failover]')).toBeNull();
    // 点开中转站：右边详情也有完整的一份
    fireEvent.click(relay);
    const notes = document.querySelectorAll('[data-failover]');
    expect(notes.length).toBe(2);
  });

  test('六十格柱条：每张卡都要画出 60 根小柱', async () => {
    renderApp(<RoutingStatus />, { route: '/routing/status' });
    const claude = await screen.findByRole('button', { name: /^Claude 订阅/ });
    const bars = claude.querySelectorAll('[role="img"] span');
    expect(bars).toHaveLength(60);
  });
});
