// 疑似换模型（#1748、#1798）：身份题说出旧答案的路由，在路由状态、摘要里单独一种，不算故障。
// 是不是它，看探测记录里这条路由最近一次的 checkPassed，不从探针原文里抠。
import { describe, expect, test } from 'vitest';
import type { LivenessFact, ProbeHistoryCell } from '../api/types';
import { identityMismatchRoutes, probeKind } from './probe-history-view';
import {
  classifyProbe,
  classifyRoute,
  countKinds,
  countsText,
  isAlert,
  routeStateLabel,
} from './route-state';
import { actualRanks, modelSlotState, routeSlotState, slotWord, summarizeOrder } from './routing-order';

const live: LivenessFact = { verdict: 'live', reason: '好' };
const dead: LivenessFact = { verdict: 'dead', reason: '探针判不在线' };
const base = { enabled: true, verdict: 'live' as const, connect: live, quota: live, ban: live };

const cell = (over: Partial<ProbeHistoryCell>): ProbeHistoryCell => ({
  id: 1,
  routeId: 'r-1',
  channelId: 'ch-1',
  probedAt: '2026-10-10T00:00:00Z',
  result: 'passed',
  durationMs: 1000,
  failureReason: null,
  requestText: null,
  responseText: null,
  checkQuestion: null,
  checkExpected: null,
  checkAnswer: null,
  checkPassed: null,
  selfIdentity: null,
  kind: null,
  ...over,
});

describe('路由状态：疑似换模型', () => {
  test('最近一次身份题说出旧答案：疑似换模型，不是故障，不进告警', () => {
    const a = classifyRoute(
      { ...base, verdict: 'dead', connect: dead, probedAt: '2026-10-10T00:00:00Z' },
      { identityMismatch: true },
    );
    expect(a).toBe('degraded');
    expect(isAlert(a)).toBe(false);
    expect(routeStateLabel[a]).toBe('疑似换模型·已按不在线处理');
    expect(classifyProbe({ state: 'failed' }, { identityMismatch: true })).toBe('degraded');
  });

  test('普通不通仍是故障；人关的仍先说已关', () => {
    expect(classifyRoute({ ...base, verdict: 'dead', connect: dead })).toBe('fault');
    expect(
      classifyRoute(
        { ...base, verdict: 'dead', connect: dead },
        { channelEnabled: false, identityMismatch: true },
      ),
    ).toBe('off');
  });

  test('摘要单列「疑似换模型」，不混进在线和故障', () => {
    expect(countsText(countKinds(['live', 'degraded']))).toBe('1 在线 · 1 疑似换模型');
  });

  test('从探测记录认：说中旧答案（失败且 checkPassed 为 false）的路由；对上新答案、认不出的不算', () => {
    const rows = [
      cell({ routeId: 'a', result: 'failed', checkPassed: false, kind: 'identity' }),
      cell({ routeId: 'b', result: 'passed', checkPassed: true, kind: 'identity' }),
      cell({ routeId: 'c', result: 'passed', checkPassed: null, kind: 'identity' }),
      cell({ routeId: 'd', result: 'failed', checkPassed: null, kind: 'ping' }),
    ];
    expect([...identityMismatchRoutes(rows)]).toEqual(['a']);
    expect(probeKind(rows[0] as ProbeHistoryCell)).toBe('doubt');
  });
});

describe('顺位：路由的疑似换模型不单列', () => {
  const open = () => true;
  test('顺位只看开关和渠道：开着的算 on，被跳过的只有关着、渠道已关', () => {
    const states = [
      routeSlotState({ enabled: false, channelId: 'c' }, open),
      routeSlotState({ enabled: true, channelId: 'c' }, open),
    ];
    expect(states).toEqual(['off', 'on']);
    expect(actualRanks(states)).toEqual([null, 1]);
    expect(summarizeOrder(states, '路由')).toMatchObject({
      ok: true,
      active: 1,
      skipped: 1,
      firstPosition: 2,
    });
    expect(slotWord('off', null, '路由')).toBe('关着，已跳过');
  });

  test('一个模型下的路由全关着：整个模型被跳过', () => {
    expect(modelSlotState({ routes: [{ enabled: false, channelId: 'c' }] }, open)).toBe('off');
  });
});
