// 路由状态语义（#1363）：「死」拆开。已关、没用、下架、池暂停、没探过都不是故障，不进告警；只有该在线却探不通才是。
import { describe, expect, test } from 'vitest';
import type { LivenessFact } from '../api/types';
import {
  classifyProbe,
  classifyRoute,
  countKinds,
  countsText,
  isAlert,
  matchesFilter,
  type RouteStateKind,
  rollupKind,
  routeStateLabel,
  routeStateTone,
} from './route-state';

const live: LivenessFact = { verdict: 'live', reason: '好' };
const dead: LivenessFact = { verdict: 'dead', reason: '探针判不在线：没通' };
const unknown: LivenessFact = { verdict: 'unknown', reason: '没看过' };

const base = { enabled: true, verdict: 'live' as const, connect: live, quota: live, ban: live };

describe('classifyRoute', () => {
  test('开着、三件都过 = 在线', () => {
    expect(classifyRoute({ ...base, probedAt: '2026-10-08T00:00:00Z' })).toBe('live');
  });

  test('该在线却探不通 = 故障，唯一进告警的一种', () => {
    const k = classifyRoute({ ...base, verdict: 'dead', connect: dead, probedAt: '2026-10-08T00:00:00Z' });
    expect(k).toBe('fault');
    expect(isAlert(k)).toBe(true);
    expect(routeStateTone[k]).toBe('fail');
  });

  test('人关的路由：后端写死，这里是已关，不是故障', () => {
    const k = classifyRoute({
      ...base,
      enabled: false,
      verdict: 'dead',
      connect: dead,
      ban: { verdict: 'dead', reason: '开关关着' },
    });
    expect(k).toBe('off');
    expect(isAlert(k)).toBe(false);
    expect(routeStateTone[k]).not.toBe('fail');
  });

  test('渠道关了：已关；模型下架：已下架；整池暂停：池暂停；没用途在用：未被用途使用', () => {
    const dd = { ...base, verdict: 'dead' as const, connect: dead };
    expect(classifyRoute(dd, { channelEnabled: false })).toBe('off');
    expect(classifyRoute(dd, { modelRetired: true })).toBe('retired');
    expect(classifyRoute(dd, { poolHeld: true })).toBe('held');
    expect(classifyRoute(dd, { usedByPurpose: false })).toBe('unused');
    for (const k of ['off', 'retired', 'held', 'unused'] as const) expect(isAlert(k)).toBe(false);
  });

  test('下架压过已关：先说最根本的', () => {
    expect(classifyRoute({ ...base, enabled: false }, { modelRetired: true })).toBe('retired');
  });

  test('探针没看过 = 未探；探过但这一轮没探 = 不知道；都不是故障', () => {
    const u = { ...base, verdict: 'unknown' as const, connect: unknown };
    expect(classifyRoute(u)).toBe('unprobed');
    expect(classifyRoute({ ...u, probedAt: '2026-10-08T00:00:00Z' })).toBe('unknown');
  });

  test('额度用满、命中禁令 = 暂时挡着，不是故障', () => {
    expect(classifyRoute({ ...base, verdict: 'dead', quota: { verdict: 'dead', reason: '额度用满' } })).toBe(
      'blocked',
    );
    expect(classifyRoute({ ...base, verdict: 'dead', ban: { verdict: 'dead', reason: '命中禁令' } })).toBe(
      'blocked',
    );
  });
});

describe('按需探测（#1635）', () => {
  const onDemand = '不主动探，要派给它时先探一次。上一次真探：通，10-10 09:00';
  test('原文写了按需：不是故障、不进告警、不画红，也不是「不知道」', () => {
    const k = classifyRoute({
      ...base,
      verdict: 'unknown',
      connect: { verdict: 'unknown', reason: `按需探测：${onDemand}` },
      probedAt: '2026-10-08T00:00:00Z',
      probeDetail: onDemand,
    });
    expect(k).toBe('on_demand');
    expect(isAlert(k)).toBe(false);
    expect(routeStateTone[k]).not.toBe('fail');
    expect(routeStateLabel[k]).toBe('按需探测');
  });
  test('渠道状态页里没排进用途的路由：探针结论 on_demand 也是按需', () => {
    expect(classifyProbe({ state: 'on_demand' })).toBe('on_demand');
    expect(classifyProbe({ state: 'on_demand' }, { usedByPurpose: false })).toBe('unused');
  });
  test('一组里有在线的还是在线；全是按需的是按需；摘要写「按需」', () => {
    expect(rollupKind(['on_demand', 'live'])).toBe('live');
    expect(rollupKind(['on_demand', 'off'])).toBe('on_demand');
    expect(countsText(countKinds(['live', 'on_demand', 'on_demand']))).toBe('1 在线 · 2 按需');
  });
});

describe('classifyProbe', () => {
  test('没用途在用的路由，探针再红也是未被用途使用', () => {
    expect(classifyProbe({ state: 'failed' }, { usedByPurpose: false })).toBe('unused');
  });
  test('用着的：failed 才是故障，skipped 不是', () => {
    expect(classifyProbe({ state: 'failed' })).toBe('fault');
    expect(classifyProbe({ state: 'skipped' })).toBe('unknown');
    expect(classifyProbe({ state: 'ok' })).toBe('live');
    expect(classifyProbe(undefined)).toBe('unprobed');
  });
});

describe('rollup 和摘要', () => {
  test('有在线的就在线；全是已关的是已关，不是故障', () => {
    expect(rollupKind(['off', 'live', 'fault'])).toBe('live');
    expect(rollupKind(['off', 'off'])).toBe('off');
    expect(rollupKind(['off', 'unused'])).toBe('off');
    expect(rollupKind(['fault', 'off'])).toBe('fault');
    expect(rollupKind([])).toBe('unused');
  });

  test('摘要只数在线、故障、待查、已关、未使用；零的不写', () => {
    const kinds: RouteStateKind[] = ['live', 'live', 'fault', 'off', 'retired', 'held', 'unused', 'unprobed'];
    expect(countsText(countKinds(kinds))).toBe('2 在线 · 1 故障 · 1 待查 · 3 已关 · 1 未使用');
    expect(countsText(countKinds([]))).toBe('没有路由');
  });

  test('筛选：已关把人关的、下架、池暂停合在一起，故障只含故障', () => {
    expect(matchesFilter('retired', 'off')).toBe(true);
    expect(matchesFilter('held', 'off')).toBe(true);
    expect(matchesFilter('fault', 'off')).toBe(false);
    expect(matchesFilter('fault', 'fault')).toBe(true);
    expect(matchesFilter('unused', 'unused')).toBe(true);
    expect(matchesFilter('live', 'all')).toBe(true);
  });
});
