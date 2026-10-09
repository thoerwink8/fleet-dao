import { describe, expect, test } from 'vitest';
import {
  actualRanks,
  modelSlotState,
  routeSlotState,
  type SlotState,
  slotWord,
  summarizeOrder,
} from './routing-order';

const route = (enabled: boolean, channelId = 'ch-a') => ({ enabled, channelId });
const open = () => true;
const unknown = () => undefined;
const closed = (id: string) => id !== 'ch-closed';

describe('路由顺位：只数引擎会真派的', () => {
  test('路由：开关关着 = 关着；渠道读到了且关着 = 渠道已关；读不到渠道不猜成关', () => {
    expect(routeSlotState(route(true), open)).toBe('on');
    expect(routeSlotState(route(false), open)).toBe('off');
    expect(routeSlotState(route(true, 'ch-closed'), closed)).toBe('closed');
    expect(routeSlotState(route(false, 'ch-closed'), closed)).toBe('off');
    expect(routeSlotState(route(true), unknown)).toBe('on');
  });

  test('模型：没有路由 = 没有可用路由；没有开着的 = 关着；开着的全在关了的渠道下 = 渠道都关着；有一条能派就是开着', () => {
    expect(modelSlotState({ routes: [] }, open)).toBe('empty');
    expect(modelSlotState({ routes: [route(false), route(false)] }, open)).toBe('off');
    expect(modelSlotState({ routes: [route(true, 'ch-closed'), route(false)] }, closed)).toBe('closed');
    expect(modelSlotState({ routes: [route(true, 'ch-closed'), route(true)] }, closed)).toBe('on');
    expect(modelSlotState({ routes: [route(false), route(true)] }, open)).toBe('on');
  });

  test('实际顺位只数开着的：1 开、2 关、3 开 → 实际 1、跳过、2', () => {
    const states: SlotState[] = ['on', 'off', 'on', 'empty', 'closed', 'on'];
    expect(actualRanks(states)).toEqual([1, null, 2, null, null, 3]);
  });

  test('每一行的话：开着写实际第几位，被跳过的写为什么', () => {
    expect(slotWord('on', 2, '模型')).toBe('实际第 2 位');
    expect(slotWord('off', null, '模型')).toBe('关着，已跳过');
    expect(slotWord('empty', null, '模型')).toBe('没有可用路由，已跳过');
    expect(slotWord('closed', null, '模型')).toContain('没有可用路由，已跳过');
    expect(slotWord('closed', null, '路由')).toBe('渠道已关，已跳过');
  });

  test('一层合起来：几个开着、几个被跳过、排头的是第几个', () => {
    expect(summarizeOrder(['off', 'on', 'empty', 'on'], '模型')).toEqual({
      ok: true,
      active: 2,
      skipped: 2,
      firstPosition: 2,
    });
  });

  test('故意造出失败：全部关着时不能算出顺位，返回明确的「无可用」，不是 0 或空', () => {
    const none = summarizeOrder(['off', 'empty', 'closed'], '模型');
    expect(none.ok).toBe(false);
    if (none.ok) throw new Error('全部被跳过时不该算出顺位');
    expect(none.why).toContain('无可用');
    expect(actualRanks(['off', 'empty', 'closed'])).toEqual([null, null, null]);
    const noRoute = summarizeOrder(['off', 'closed'], '路由');
    expect(noRoute.ok).toBe(false);
    if (!noRoute.ok) expect(noRoute.why).toContain('没有可用路由，已跳过这个模型');
    expect(summarizeOrder([], '路由')).toEqual({ ok: false, why: '无可用：一个路由都没有' });
    // 开着的一行没有顺位是调用方的错，不拿默认值冒充
    expect(() => slotWord('on', null, '模型')).toThrow('实际顺位');
  });
});
