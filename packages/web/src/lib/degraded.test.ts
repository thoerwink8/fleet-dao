// 路由降智下线（#1748）：疑似降智在路由状态、顺位、摘要里单独一种，不被「按需探测」盖住，不算进开着的路由。
import { describe, expect, test } from 'vitest';
import type { LivenessFact } from '../api/types';
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
const unknown: LivenessFact = { verdict: 'unknown', reason: '按需探测' };
const base = { enabled: true, verdict: 'live' as const, connect: live, quota: live, ban: live };

const degraded = '疑似降智：题 17 乘 23，应为 391，实答 381';
const onDemandAfterDegraded =
  '不主动探，要派给它时先探一次。上一次真探：不通，10-10 09:05（疑似降智：题 17 乘 23，应为 391，实答 381）';
const onDemandAfterOk = '不主动探，要派给它时先探一次。上一次真探：通，10-10 09:05（答上了：OK）';

describe('路由状态：疑似降智', () => {
  test('直接是降智结论、或按需探测里带着上一次降智结论：都是疑似降智，不是故障也不是按需', () => {
    const t = '2026-10-10T00:00:00Z';
    const a = classifyRoute({ ...base, verdict: 'dead', connect: dead, probeDetail: degraded, probedAt: t });
    const b = classifyRoute({
      ...base,
      verdict: 'unknown',
      connect: unknown,
      probeDetail: onDemandAfterDegraded,
      probedAt: t,
    });
    for (const k of [a, b]) {
      expect(k).toBe('degraded');
      expect(isAlert(k)).toBe(false);
      expect(routeStateLabel[k]).toBe('疑似降智·已按不在线处理');
    }
    expect(classifyProbe({ state: 'failed', detail: degraded })).toBe('degraded');
    expect(classifyProbe({ state: 'on_demand', detail: onDemandAfterDegraded })).toBe('degraded');
  });

  test('普通不通仍是故障；上一次真探是通的仍是按需；人关的仍先说已关', () => {
    const t = '2026-10-10T00:00:00Z';
    expect(classifyRoute({ ...base, verdict: 'dead', connect: dead, probeDetail: '连探两次都没通' })).toBe(
      'fault',
    );
    expect(
      classifyRoute({
        ...base,
        verdict: 'unknown',
        connect: unknown,
        probeDetail: onDemandAfterOk,
        probedAt: t,
      }),
    ).toBe('on_demand');
    expect(
      classifyRoute(
        { ...base, verdict: 'dead', connect: dead, probeDetail: degraded },
        { channelEnabled: false },
      ),
    ).toBe('off');
  });

  test('摘要单列「疑似降智」，不混进在线和故障', () => {
    expect(countsText(countKinds(['live', 'degraded']))).toBe('1 在线 · 1 疑似降智');
  });
});

describe('顺位：疑似降智的路由不占位、不算进开着的路由数', () => {
  const open = () => true;
  test('跳过它，开着的数少一个，词写疑似降智', () => {
    const states = [
      routeSlotState({ enabled: true, channelId: 'c', probeDetail: onDemandAfterDegraded }, open),
      routeSlotState({ enabled: true, channelId: 'c' }, open),
    ];
    expect(states).toEqual(['degraded', 'on']);
    expect(actualRanks(states)).toEqual([null, 1]);
    expect(summarizeOrder(states, '路由')).toMatchObject({
      ok: true,
      active: 1,
      skipped: 1,
      firstPosition: 2,
    });
    expect(slotWord('degraded', null, '路由')).toBe('疑似降智，已跳过');
  });

  test('一个模型下的路由全是降智：整个模型被跳过', () => {
    expect(modelSlotState({ routes: [{ enabled: true, channelId: 'c', probeDetail: degraded }] }, open)).toBe(
      'off',
    );
  });
});
