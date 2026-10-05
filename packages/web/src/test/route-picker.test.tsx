// @vitest-environment happy-dom
// 换模型对话框（#574）：候选按路由两层列（GET /routing/layers，和选路、路由页同一份）——这个用途下模型的先后、再是模型下路由的
// 先后；选不了的原因照后端现算的三件事说，不在前端再判一遍。读不到、没接上、认不出、这个用途没配，都照实说现在没法换，
// 不画空列表冒充「没有路由」：每一种都故意造一次。
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi, type MockApi } from '../api/mock/server';
import type {
  LivenessFact,
  RoutingLayerModel,
  RoutingLayerPurpose,
  RoutingLayerRoute,
  RoutingLayers,
  StageKind,
} from '../api/types';
import { purposeFor, routeOptions, targetOf, useTaskActions } from '../components/task-actions';
import { renderApp } from './harness';

afterEach(cleanup);

const live = (reason = '好着'): LivenessFact => ({ verdict: 'live', reason });
const dead = (reason: string): LivenessFact => ({ verdict: 'dead', reason });
const unknown = (reason: string): LivenessFact => ({ verdict: 'unknown', reason });

function route(routeId: string, over: Partial<RoutingLayerRoute> = {}): RoutingLayerRoute {
  const r: RoutingLayerRoute = {
    routeId,
    channelId: 'relay',
    channelName: '中转站',
    poolId: 'relay',
    hostId: 'claude-code',
    enabled: true,
    verdict: 'live',
    connect: live('探针探通了'),
    quota: live('额度读数新、窗口有余'),
    ban: live('没有禁令、开关开着'),
    exhausted: [],
    inFlight: 0,
    reserved: 0,
    maxConcurrency: 2,
    ...over,
  };
  const facts = [r.connect.verdict, r.quota.verdict, r.ban.verdict];
  return {
    ...r,
    verdict: facts.includes('dead') ? 'dead' : facts.includes('unknown') ? 'unknown' : 'live',
  };
}

function model(modelId: string, displayName: string, routes: RoutingLayerRoute[]): RoutingLayerModel {
  return { modelId, displayName, family: 'claude', verdict: 'live', routes };
}

const PLAN: RoutingLayerPurpose = {
  purpose: 'plan',
  verdict: 'live',
  problems: [],
  models: [
    model('opus-5.5', 'Opus 5.5', [
      route('r-off', { ban: dead('开关关着（这条路由在它的模型下关着）') }),
      route('r-unprobed', { connect: unknown('探针还没看过这条路由') }),
      route('r-busy', { inFlight: 2, maxConcurrency: 2 }),
    ]),
    model('kimi-k3', 'Kimi k3', [
      route('r-quota-unknown', { quota: unknown('额度没读成、读数过期，或判不了扣不扣这条路由') }),
      route('r-dead-twice', {
        connect: dead('探针判不在线：连不上'),
        quota: dead('适用的额度窗用满了'),
      }),
    ]),
  ],
};

const layersWith = (purposes: RoutingLayerPurpose[], extra: Partial<RoutingLayers> = {}): RoutingLayers => ({
  asOf: '2026-09-25T10:00:00Z',
  purposes,
  ...extra,
});

function apiWith(layers: RoutingLayers): MockApi {
  const api = createMockApi({ live: false });
  Object.assign(api, { routingLayers: async () => layers });
  return api;
}

/** 在测试里直接打开换模型对话框：对着一个正在跑某个阶段的需求。 */
function OpenPicker({ stage, routeId }: { stage: StageKind; routeId: string }) {
  const { trigger } = useTaskActions();
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    trigger('reroute', {
      ...targetOf({
        id: 't-15',
        issueNumber: 15,
        title: '站内通知 7 天没读就再提醒一次',
        state: 'planning',
        priority: 3,
        requestedBy: 'u-lan',
        createdAt: '2026-09-25T00:00:00Z',
        progress: { done: 0, total: 0 },
        subtasks: [],
      }),
      activity: {
        runId: 'run-x',
        stage,
        routeId,
        modelName: 'Opus 5.5',
        queued: false,
        since: '2026-09-25T00:00:00Z',
        text: 'Opus 5.5 正在写方案',
      },
    });
  }, [trigger, stage, routeId]);
  return null;
}

async function closeDialog() {
  await act(async () => {
    fireEvent.keyDown(document.body, { key: 'Escape' });
  });
}

describe('换模型的候选按路由两层列', () => {
  test('先模型的先后、再模型下路由的先后；只列这个用途两层里的路由', () => {
    expect(routeOptions(PLAN, undefined, undefined).map((o) => o.id)).toEqual([
      'r-off',
      'r-unprobed',
      'r-busy',
      'r-quota-unknown',
      'r-dead-twice',
    ]);
  });

  test('选不了的原因照后端写的：死的写死在哪几件，接不接得上不知道的也选不了；额度没读成、池满了不挡', () => {
    const byId = new Map(routeOptions(PLAN, undefined, 'r-quota-unknown').map((o) => [o.id, o]));
    expect(byId.get('r-off')?.blocked).toBe('开关关着（这条路由在它的模型下关着）');
    expect(byId.get('r-unprobed')?.blocked).toBe('接不接得上还不知道：探针还没看过这条路由');
    expect(byId.get('r-dead-twice')?.blocked).toBe('探针判不在线：连不上；适用的额度窗用满了');
    expect(byId.get('r-quota-unknown')?.blocked).toBeUndefined();
    expect(byId.get('r-busy')?.blocked).toBeUndefined();
    expect(byId.get('r-busy')?.note).toBe('账号池满 2/2');
    expect(byId.get('r-quota-unknown')?.note).toBe('正在用');
  });

  test('账号池满按「在跑 + 已选定还没开跑」判（#800，和引擎选路同一个判法）：上限 3、1 在跑 2 预占 = 满，写明各几个；预占没了就不满', () => {
    const purpose = (over: Partial<RoutingLayerRoute>): RoutingLayerPurpose => ({
      ...PLAN,
      models: [model('opus-5.5', 'Opus 5.5', [route('r-pool', { maxConcurrency: 3, ...over })])],
    });
    const note = (over: Partial<RoutingLayerRoute>) =>
      routeOptions(purpose(over), undefined, undefined)[0]?.note;
    expect(note({ inFlight: 1, reserved: 2 })).toBe('账号池满 3/3（在跑 1、已选定还没开跑 2）');
    expect(note({ inFlight: 1, reserved: 1 })).toBeUndefined();
    expect(note({ inFlight: 1, reserved: 0 })).toBeUndefined();
    // 满了不挡选：引擎照常排队等空位，和只数在跑时一样
    expect(
      routeOptions(purpose({ inFlight: 1, reserved: 2 }), undefined, undefined)[0]?.blocked,
    ).toBeUndefined();
  });

  test('对话框里：死的那条点不了、原因写着；排在前面的是两层的顺序', async () => {
    renderApp(<OpenPicker stage="plan" routeId="r-quota-unknown" />, { api: apiWith(layersWith([PLAN])) });
    expect(
      await screen.findByText('「方案」用途的路由（路由两层的顺序：先模型，再模型下的路由）'),
    ).toBeTruthy();
    // cmdk 的条目登记完下一轮才画出来：等它出现
    const off = (await screen.findByText('开关关着（这条路由在它的模型下关着）')).closest('[cmdk-item]');
    expect(off?.getAttribute('aria-disabled')).toBe('true');
    const items = [...document.querySelectorAll('[cmdk-item]')].map((el) => el.textContent ?? '');
    expect(items).toHaveLength(5);
    expect(items[0]).toContain('Opus 5.5');
    expect(items[3]).toContain('Kimi k3');
    await closeDialog();
  });

  test('原因太长：一行里截短，悬停看全文', async () => {
    const long = `探针判不在线：连探两次都没通：${'很长的报错'.repeat(30)}`;
    const purpose: RoutingLayerPurpose = {
      ...PLAN,
      models: [model('opus-5.5', 'Opus 5.5', [route('r-long', { connect: dead(long) })])],
    };
    renderApp(<OpenPicker stage="plan" routeId="r-x" />, { api: apiWith(layersWith([purpose])) });
    const shown = await screen.findByTitle(long);
    expect(shown.textContent?.endsWith('…')).toBe(true);
    expect(shown.textContent?.length).toBeLessThanOrEqual(80);
    expect(shown.textContent?.startsWith('探针判不在线：连探两次都没通')).toBe(true);
    await closeDialog();
  });
});

describe('换模型：读不到、没接上、认不出、没配，都照实说现在没法换', () => {
  test('没接上（开发环境内存版没有那两张表）：写后端给的原因，不画空列表', async () => {
    const why = '路由两层没接上：这里是开发环境的内存版';
    renderApp(<OpenPicker stage="plan" routeId="r-x" />, {
      api: apiWith(layersWith([], { unavailable: why })),
    });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', `现在没法换：${why}`);
    expect(screen.queryByText('没有匹配的路由')).toBeNull();
    await closeDialog();
  });

  test('后端回的用途里没有这一个：写认不出，不当成这个用途没有路由', async () => {
    renderApp(<OpenPicker stage="review" routeId="r-x" />, { api: apiWith(layersWith([PLAN])) });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('后端回的路由两层里没有「第二意见」这个用途，认不出');
    expect(screen.queryByText('没有匹配的路由')).toBeNull();
    await closeDialog();
  });

  test('这个用途没配模型顺序：写明配置缺口，列表那里说一条路由都没有，不说「没有匹配的路由」', async () => {
    const none: RoutingLayerPurpose = {
      purpose: 'plan',
      verdict: 'dead',
      problems: ['用途 plan 没配模型顺序'],
      models: [],
    };
    renderApp(<OpenPicker stage="plan" routeId="r-x" />, { api: apiWith(layersWith([none])) });
    expect(await screen.findByText('路由两层的配置缺口：用途 plan 没配模型顺序')).toBeTruthy();
    expect(screen.getByText('「方案」用途在路由两层里一条路由都没有')).toBeTruthy();
    expect(screen.queryByText('没有匹配的路由')).toBeNull();
    await closeDialog();
  });

  test('purposeFor：没接上、认不出各回各的原因，认得的回那一份', () => {
    expect(purposeFor(layersWith([], { unavailable: '没接上' }), 'plan')).toEqual({
      problem: '现在没法换：没接上',
    });
    expect(purposeFor(layersWith([PLAN]), 'ui')).toEqual({
      problem: '现在没法换：后端回的路由两层里没有「UI」这个用途，认不出',
    });
    expect(purposeFor(layersWith([PLAN]), 'plan')).toEqual({ purpose: PLAN });
  });
});
