// @vitest-environment happy-dom
// 路由页（#574）：每个用途 → 模型 → 路由，每一层活 / 死 / 不知道和原因都在页面上，不藏；读不到写没读成，没接上写没接上，
// 都不画空表冒充「都没配」。
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { RoutingLayers } from '../api/types';
import RoutingPage from '../routes/routing';
import { renderApp } from './harness';

afterEach(cleanup);

function withLayers(layers: RoutingLayers | (() => Promise<RoutingLayers>)): MockApi {
  const api = createMockApi({ live: false });
  Object.assign(api, { routingLayers: typeof layers === 'function' ? layers : async () => layers });
  return api;
}

const purposeLinks = async () =>
  within(await screen.findByRole('navigation', { name: '用途' })).getAllByRole('link');

const routeItem = (routeId: string) => {
  const el = document.querySelector(`[data-route="${routeId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`页面上没有路由 ${routeId}`);
  return el;
};

describe('路由页：每一层现在活着吗', () => {
  test('只列在用的五个用途；没点名先看靠后备撑着的验收（整理待办不抢）；对题不选路；Jev、整理待办单列', async () => {
    renderApp(<RoutingPage />, { route: '/routing' });
    const links = await purposeLinks();
    expect(links).toHaveLength(5);
    expect(links[0]?.textContent).toContain('动手');
    expect(links[0]?.textContent).not.toContain('动手 · 界面');
    expect(links[1]?.textContent).toContain('动手 · 界面');
    expect(links[2]?.textContent).toContain('验收');
    expect(links[3]?.textContent).toContain('Jev 判断');
    expect(links[4]?.textContent).toContain('整理待办');
    expect(screen.getByText('在对话里做，不选路', { exact: false })).toBeTruthy();
    expect(screen.getByText('不是流程里的一段')).toBeTruthy();
    const current = links.filter((a) => a.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('验收');
    for (const gone of ['分诊', '需求文档', '方案', '调研', '第二意见', '开 PR 前验证']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(screen.getByText('5 个派得出去')).toBeTruthy();
    expect(screen.getByText('0 个不知道')).toBeTruthy();
    expect(screen.getByText('0 个派不出去')).toBeTruthy();
  });

  test('点名验收：首选模型不行时写明顺位第一条活的在第几个模型，不知道的原因照写，顺位第一条活的那条标出来', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=verify' });
    await purposeLinks();
    // 清单那一行和详情的副标题各一遍
    expect(
      screen.getAllByText('首选模型不行，顺位第一条活的在第 2 个模型：GPT 5.6 luna（中转站 · relay）'),
    ).toHaveLength(2);
    // Grok 的额度读数是 42 分钟前的：额度不知道，整条不知道（不画成活）
    const grok = routeItem('r-grok');
    expect(within(grok).getByText('不知道', { selector: 'span' })).toBeTruthy();
    expect(grok.textContent).toContain('额度没读成、读数过期，或判不了扣不扣这条路由');
    expect(routeItem('r-rl-gpt').textContent).toContain('顺位第一条活的');
    expect(grok.textContent).not.toContain('顺位第一条活的');
  });

  test('写码：探了没通、模型下架、开关关着的都列出来，死因写全', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute' });
    await purposeLinks();
    expect(routeItem('r-cursor').textContent).toContain(
      '探针判不在线：连探两次都没通：等了 150 秒还没起来（第一次：进程退出（退出码 1），没有终帧）',
    );
    expect(routeItem('r-ca-opus5').textContent).toContain('模型已下架');
    const off = routeItem('r-rl-opus');
    expect(off.textContent).toContain('关着');
    expect(off.textContent).toContain('开关关着（这条路由在它的模型下关着）');
  });

  test('额度用满写哪个窗、几点清零；探针结论过期标出来；池满了说是等空位；模型下没路由照说', async () => {
    const now = Date.now();
    const iso = (min: number) => new Date(now + min * 60_000).toISOString();
    const fact = (verdict: 'live' | 'dead' | 'unknown', reason: string) => ({ verdict, reason });
    const api = withLayers({
      asOf: iso(0),
      purposes: [
        {
          purpose: 'execute',
          verdict: 'dead',
          problems: ['模型 kimi-k3 没有路由（routing_catalog 里一条都没有）'],
          models: [
            {
              modelId: 'opus-5.5',
              displayName: 'Opus 5.5',
              family: 'claude',
              verdict: 'dead',
              routes: [
                {
                  routeId: 'rt-a',
                  channelId: 'ch-claude',
                  channelName: 'Claude 订阅',
                  poolId: 'claude-a',
                  hostId: 'claude-code',
                  enabled: true,
                  verdict: 'dead',
                  connect: fact('live', '探针探通了'),
                  quota: fact('dead', '适用的额度窗用满了'),
                  ban: fact('live', '没有禁令、开关开着'),
                  probedAt: iso(-120),
                  exhausted: [{ label: '5h', resetsAt: iso(90) }, { label: '7d' }],
                  inFlight: 2,
                  reserved: 0,
                  maxConcurrency: 2,
                },
              ],
            },
            { modelId: 'kimi-k3', displayName: 'Kimi k3', verdict: 'dead', routes: [] },
          ],
        },
      ],
    });
    renderApp(<RoutingPage />, { route: '/routing', api });
    await purposeLinks();
    const a = routeItem('rt-a');
    expect(a.textContent).toMatch(/5h：1 小时 \d+ 分后清零|5h：1 小时后清零|5h：(89|90) 分钟后清零/);
    expect(a.textContent).toContain('7d：清零时刻没读到');
    expect(a.textContent).toContain('探测过期：2 小时前的结论，探针可能停了');
    expect(a.textContent).toContain('满了，等空位，不算死');
    expect(screen.getByText('这个模型下一条路由都没有：排了它也派不到它')).toBeTruthy();
    expect(screen.getByText('一条路由都没有')).toBeTruthy();
    expect(screen.getByText('模型 kimi-k3 没有路由（routing_catalog 里一条都没有）')).toBeTruthy();
  });

  test('池满按「在跑 + 已选定还没开跑」判（#800）：上限 3、1 在跑 2 预占 = 满，页面写占 3/3 和各几个；只有 1 个在跑的不满', async () => {
    const now = Date.now();
    const fact = (verdict: 'live' | 'dead' | 'unknown', reason: string) => ({ verdict, reason });
    const slot = (routeId: string, poolId: string, reserved: number) => ({
      routeId,
      channelId: 'ch-claude',
      channelName: 'Claude 订阅',
      poolId,
      hostId: 'claude-code' as const,
      enabled: true,
      verdict: 'live' as const,
      connect: fact('live', '探针探通了'),
      quota: fact('live', '额度读数新、窗口有余'),
      ban: fact('live', '没有禁令、开关开着'),
      probedAt: new Date(now - 60_000).toISOString(),
      exhausted: [],
      inFlight: 1,
      reserved,
      maxConcurrency: 3,
    });
    const api = withLayers({
      asOf: new Date(now).toISOString(),
      purposes: [
        {
          purpose: 'execute',
          verdict: 'live',
          problems: [],
          models: [
            {
              modelId: 'opus-5.5',
              displayName: 'Opus 5.5',
              family: 'claude',
              verdict: 'live',
              routes: [slot('rt-reserved', 'carpool', 2), slot('rt-free', 'solo', 0)],
            },
          ],
        },
      ],
    });
    renderApp(<RoutingPage />, { route: '/routing?purpose=execute', api });
    await purposeLinks();
    const reserved = routeItem('rt-reserved');
    expect(reserved.textContent).toContain('占 3/3（在跑 1、已选定还没开跑 2）');
    expect(reserved.textContent).toContain('满了，等空位，不算死');
    const free = routeItem('rt-free');
    expect(free.textContent).toContain('在跑 1/3');
    expect(free.textContent).not.toContain('满了，等空位');
  });

  test('网址里点了已不存在的用途（plan）：照没点名算（先看靠后备撑着的验收），不留一块空详情', async () => {
    renderApp(<RoutingPage />, { route: '/routing?purpose=plan' });
    const links = await purposeLinks();
    expect(links.find((a) => a.getAttribute('aria-current') === 'true')?.textContent).toContain('验收');
    expect(screen.queryByText('方案')).toBeNull();
  });

  test('【故意造出的失败】读不到：写「路由两层没读成」和原因，不画清单、不报几个派得出去', async () => {
    const api = withLayers(() => Promise.reject(new ApiError(503, 'routing_layers_unreadable', '库连不上')));
    renderApp(<RoutingPage />, { route: '/routing', api });
    expect(await screen.findByText('路由两层没读成：库连不上')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '用途' })).toBeNull();
    expect(screen.queryByText(/个派得出去/)).toBeNull();
  });

  test('【故意造出的失败】后端一个用途都没给（不合约定）：照说，不报「0 个派不出去」冒充没事', async () => {
    const api = withLayers({ asOf: new Date().toISOString(), purposes: [] });
    renderApp(<RoutingPage />, { route: '/routing', api });
    expect(await screen.findByText('后端一个用途都没给')).toBeTruthy();
    expect(screen.queryByText(/个派不出去/)).toBeNull();
    expect(screen.queryByRole('navigation', { name: '用途' })).toBeNull();
  });

  test('【故意造出的失败】没接上（开发环境内存版）：整块写没接上和为什么，不说「没读成」、不画空清单', async () => {
    const api = withLayers({
      asOf: new Date().toISOString(),
      purposes: [],
      unavailable: '路由两层没接上：这里是开发环境的内存版',
    });
    renderApp(<RoutingPage />, { route: '/routing', api });
    expect(await screen.findByRole('note')).toHaveProperty(
      'textContent',
      '路由两层没接上：这里是开发环境的内存版',
    );
    expect(screen.queryByText(/没读成/)).toBeNull();
    expect(screen.queryByRole('navigation', { name: '用途' })).toBeNull();
  });
});

describe('路由页顶上的渠道一览（驾驶舱改版 2026-10-07：细看和立即探测在渠道状态页）', () => {
  test('每个渠道一个小圆点加名字，点过去是渠道状态页；不通的写状态，通的不多写', async () => {
    renderApp(<RoutingPage />, { route: '/routing' });
    const strip = await screen.findByRole('navigation', { name: '渠道一览' });
    const items = within(strip).getAllByRole('listitem');
    expect(items.map((c) => c.getAttribute('data-channel')).sort()).toEqual([
      'ch-claude',
      'ch-cursor',
      'ch-ds',
      'ch-grok',
      'ch-relay',
    ]);
    const cursor = items.find((c) => c.getAttribute('data-channel') === 'ch-cursor');
    expect(cursor?.textContent).toContain('暂不可用');
    expect(
      within(cursor as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe('/routing/status?p=ch-cursor');
    expect(
      within(strip)
        .getByRole('link', { name: /看原文、立即探测/ })
        .getAttribute('href'),
    ).toBe('/routing/status');
    // 整块渠道卡不再在路由页上画第二份
    expect(screen.queryByRole('list', { name: '渠道状态' })).toBeNull();
  });

  test('【故意造出的失败】渠道目录读不到：写没读成和原因，不画空的一行', async () => {
    const api = createMockApi({ live: false });
    Object.assign(api, {
      routing: () => Promise.reject(new ApiError(503, 'routing_unreadable', '库连不上')),
    });
    renderApp(<RoutingPage />, { route: '/routing', api });
    expect(await screen.findByText('渠道状态没读成：库连不上')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '渠道一览' })).toBeNull();
  });
});
