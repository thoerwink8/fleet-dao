// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import RoutingPage from '../routes/routing';
import { renderApp } from '../test/harness';
import {
  actualRanks,
  modelSlotState,
  routeSlotState,
  type SlotState,
  slotWord,
  summarizeOrder,
} from './routing-order';

afterEach(() => {
  cleanup();
});

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

  test('已下架的不占实际顺位：后面开着的名次往前靠，行上写「已下架」不写名次', () => {
    // 开着的路由本来会占一位；下架之后让出来，再下一个开着的从 2 变成接着数
    expect(modelSlotState({ routes: [route(true)] }, open, true)).toBe('retired');
    expect(modelSlotState({ routes: [route(false)] }, open, true)).toBe('retired');
    const states: SlotState[] = [
      modelSlotState({ routes: [route(true)] }, open, false),
      modelSlotState({ routes: [route(true)] }, open, true),
      modelSlotState({ routes: [route(false)] }, open, false),
      modelSlotState({ routes: [route(true)] }, open, false),
    ];
    expect(states).toEqual(['on', 'retired', 'off', 'on']);
    expect(actualRanks(states)).toEqual([1, null, null, 2]);
    expect(slotWord('retired', null, '模型')).toBe('已下架');
    expect(slotWord('on', 2, '模型')).toBe('实际第 2 位');
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

describe('已下架的模型行不写名次', () => {
  test('动手里的 Opus 5 行写「已下架」，不写实际第几位', async () => {
    renderApp(createElement(RoutingPage), { route: '/routing?purpose=execute' });
    await screen.findByRole('list', { name: '模型' });
    // 下架记在目录里，目录比用途层晚到时这一行先按开着画，到了再改成已下架
    await waitFor(() => {
      const slot = document.querySelector('li[data-model="opus-5"] [data-slot-state]');
      expect(slot?.textContent).toBe('已下架');
      expect(slot?.getAttribute('data-slot-state')).toBe('retired');
    });
    const row = document.querySelector('li[data-model="opus-5"]') as HTMLElement;
    expect(row.textContent).not.toMatch(/实际第 \d+ 位/);
  });
});

describe('模型行：长说明不跟名字挤在一起', () => {
  test('说明和名字分属两个元素，悬停上是全文，名字不被截断样式挤掉', async () => {
    renderApp(createElement(RoutingPage), { route: '/routing?purpose=review' });
    const list = await screen.findByRole('list', { name: '模型' });
    const row = list.querySelector('li[data-model="gpt-5.6-luna"]') as HTMLElement;
    const name = row.querySelector('[data-row-name]') as HTMLElement;
    const note = row.querySelector('[data-row-note]') as HTMLElement;
    expect(name.textContent).toBe('GPT 5.6 luna');
    expect(name.className).not.toContain('truncate');
    expect(note.textContent).toBe('引擎还没接上，起不了会话');
    expect(note.getAttribute('title')).toBe('引擎还没接上，起不了会话');
    expect(name.contains(note)).toBe(false);
    expect(note.className).not.toContain('truncate');
    // 自己占一行：窄宽度下不再跟名字抢同一行的宽度
    expect(note.className).toContain('basis-full');
  });
});
