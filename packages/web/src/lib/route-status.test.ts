// 路由在不在线的说法（#129）：照探针写进库的结论说；还没探过的不说成离线，没探通的不拿默认值说成在线。
import { ROUTE_PROBE_STALE_MINUTES } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';
import type { Route } from '../api/types';
import { probeSummary, routeStatus } from './catalog';
import { TIME } from './format';

const NOW = Date.parse('2026-09-26T10:00:00Z');
const ago = (min: number) => new Date(NOW - min * TIME.MIN).toISOString();
type R = Pick<Route, 'alive' | 'probe'>;

describe('routeStatus', () => {
  test('探通了：在线，原因写的是回答和用时', () => {
    const s = routeStatus(
      { alive: true, probe: { state: 'ok', at: ago(3), detail: '答上了：OK · 用时 9 秒' } },
      NOW,
    );
    expect(s).toEqual({
      kind: 'online',
      label: '在线',
      tone: 'done',
      detail: '答上了：OK · 用时 9 秒',
      at: ago(3),
      stale: false,
    });
  });

  test('探针还没看过：「还没探过」，不说成离线，也不当在线', () => {
    const s = routeStatus({ alive: false }, NOW);
    expect(s.kind).toBe('unprobed');
    expect(s.label).toBe('还没探过');
    expect(s.label).not.toContain('离线');
    expect(s.detail).toContain('还没看过');
    expect(s.at).toBeUndefined();
  });

  test('探了没通：离线、标红，原因照探针写的原话', () => {
    const s = routeStatus(
      { alive: false, probe: { state: 'failed', at: ago(2), detail: '登录失效：Not logged in' } },
      NOW,
    );
    expect(s).toMatchObject({
      kind: 'offline',
      label: '离线',
      tone: 'fail',
      detail: '登录失效：Not logged in',
    });
  });

  test('插头没接、这一轮没探：也是离线（派不到），标灰，原因照写', () => {
    for (const state of ['not_wired', 'skipped'] as const) {
      const s = routeStatus({ alive: false, probe: { state, at: ago(2), detail: `原因：${state}` } }, NOW);
      expect(s).toMatchObject({ kind: 'offline', label: '离线', tone: 'stop', detail: `原因：${state}` });
    }
  });

  test('结论是 ok、alive 却是假的：照 alive 说离线（派工只看 alive），不拿上一次的 ok 冒充在线', () => {
    const s = routeStatus({ alive: false, probe: { state: 'ok', at: ago(2), detail: '答上了：OK' } }, NOW);
    expect(s.kind).toBe('offline');
    expect(s.detail).toContain('标着不在线');
  });

  test('离线却没写原因（契约里 detail 可选）：明说「没写原因」，不留空', () => {
    const s = routeStatus({ alive: false, probe: { state: 'failed', at: ago(2) } }, NOW);
    expect(s.detail).toBe('探针没写原因');
  });

  test(`结论超过 ${ROUTE_PROBE_STALE_MINUTES} 分钟没更新：标过期（探针可能停了）`, () => {
    const fresh = routeStatus(
      { alive: true, probe: { state: 'ok', at: ago(ROUTE_PROBE_STALE_MINUTES), detail: 'OK' } },
      NOW,
    );
    const stale = routeStatus(
      { alive: true, probe: { state: 'ok', at: ago(ROUTE_PROBE_STALE_MINUTES + 1), detail: 'OK' } },
      NOW,
    );
    expect(fresh.stale).toBe(false);
    expect(stale.stale).toBe(true);
    // 过期了照样说在线（派工照 alive 派），另外标过期
    expect(stale.kind).toBe('online');
  });
});

describe('probeSummary', () => {
  test('在线几条、还没探过几条、最近一次结论的时刻', () => {
    const routes: R[] = [
      { alive: true, probe: { state: 'ok', at: ago(20), detail: 'OK' } },
      { alive: false, probe: { state: 'failed', at: ago(3), detail: '没通' } },
      { alive: false },
    ];
    expect(probeSummary(routes)).toEqual({ online: 1, total: 3, unprobed: 1, lastAt: ago(3) });
  });

  test('一条结论都没有：lastAt 是 undefined（不拿 0 或现在冒充探过）', () => {
    expect(probeSummary([{ alive: false }, { alive: false }])).toEqual({
      online: 0,
      total: 2,
      unprobed: 2,
      lastAt: undefined,
    });
    expect(probeSummary([])).toEqual({ online: 0, total: 0, unprobed: 0, lastAt: undefined });
  });
});
