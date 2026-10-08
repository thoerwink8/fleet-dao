// 路由页路由、模型这两层的状态判法（#1366 第二部分）：后端的「死」拆开，只有故障画红，没有路由的模型不画态。
import { describe, expect, test } from 'vitest';
import type { RoutingLayerRoute } from '../api/types';
import { modelKind, NO_ENV, routeKind } from './route-kinds';
import { routeStateTone } from './route-state';

const f = (verdict: 'live' | 'dead' | 'unknown') => ({ verdict, reason: '原因' });
const route = (over: Partial<RoutingLayerRoute> = {}): RoutingLayerRoute => ({
  routeId: 'r',
  channelId: 'c',
  channelName: 'C',
  poolId: 'p',
  hostId: 'claude-code',
  enabled: true,
  verdict: 'live',
  connect: f('live'),
  quota: f('live'),
  ban: f('live'),
  probedAt: '2026-10-08T00:00:00.000Z',
  exhausted: [],
  inFlight: 0,
  reserved: 0,
  maxConcurrency: 2,
  ...over,
});

describe('routeKind', () => {
  test('探通、额度够、没被挡 = 在线', () => {
    expect(routeKind(route(), 'm', NO_ENV)).toBe('live');
  });

  test('探不通才是故障；额度用满、禁令挡着是暂时挡着，不是故障', () => {
    expect(routeKind(route({ verdict: 'dead', connect: f('dead') }), 'm', NO_ENV)).toBe('fault');
    expect(routeKind(route({ verdict: 'dead', quota: f('dead') }), 'm', NO_ENV)).toBe('blocked');
    expect(routeKind(route({ verdict: 'dead', ban: f('dead') }), 'm', NO_ENV)).toBe('blocked');
  });

  test('开关关着、渠道关了、模型下架、整池暂停先说，不画成故障', () => {
    const dead = route({ verdict: 'dead', connect: f('dead') });
    expect(routeKind({ ...dead, enabled: false }, 'm', NO_ENV)).toBe('off');
    expect(routeKind(dead, 'm', { ...NO_ENV, channelEnabled: () => false })).toBe('off');
    expect(routeKind(dead, 'm', { ...NO_ENV, modelRetired: () => true })).toBe('retired');
    expect(routeKind(dead, 'm', { ...NO_ENV, poolHeld: () => true })).toBe('held');
  });

  test('探针没看过 = 未探；看过但这一轮没探、额度没读成 = 不知道', () => {
    const unk = route({ verdict: 'unknown', connect: f('unknown') });
    const { probedAt: _, ...never } = unk;
    expect(routeKind(never, 'm', NO_ENV)).toBe('unprobed');
    expect(routeKind(unk, 'm', NO_ENV)).toBe('unknown');
  });

  test('只有故障是红色', () => {
    expect(routeStateTone[routeKind(route({ verdict: 'dead', connect: f('dead') }), 'm', NO_ENV)]).toBe(
      'fail',
    );
    for (const r of [route(), route({ enabled: false }), route({ quota: f('dead') })]) {
      expect(routeStateTone[routeKind(r, 'm', NO_ENV)]).not.toBe('fail');
    }
  });
});

describe('modelKind', () => {
  test('一条路由都没有：返回 null，不画态', () => {
    expect(modelKind({ modelId: 'm', routes: [] }, NO_ENV)).toBeNull();
  });

  test('有在线的就在线；没有在线、有故障就故障；全关着是已关，不会变成故障', () => {
    const ok = route({ routeId: 'a' });
    const bad = route({ routeId: 'b', verdict: 'dead', connect: f('dead') });
    expect(modelKind({ modelId: 'm', routes: [bad, ok] }, NO_ENV)).toBe('live');
    expect(modelKind({ modelId: 'm', routes: [bad] }, NO_ENV)).toBe('fault');
    expect(modelKind({ modelId: 'm', routes: [{ ...bad, enabled: false }] }, NO_ENV)).toBe('off');
  });
});
