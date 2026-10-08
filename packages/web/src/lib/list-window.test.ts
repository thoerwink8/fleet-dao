// 路由页长列表的纯函数（#1366 第二部分）：窗口范围、拖到边缘的自动滚动速度、置顶置底挪一格、搜索和只看已开启。
import { describe, expect, test } from 'vitest';
import {
  autoScrollDelta,
  dropOrder,
  filterActive,
  filterRows,
  moveToEdge,
  NO_FILTER,
  stepOrder,
  WINDOW_MIN_ROWS,
  windowRange,
} from './list-window';

describe('windowRange：只画看得见的行', () => {
  test('行数不超过 50 全画，不开窗口', () => {
    expect(windowRange({ count: WINDOW_MIN_ROWS, rowHeight: 44, height: 440, scrollTop: 0 })).toEqual({
      start: 0,
      end: WINDOW_MIN_ROWS,
    });
    expect(windowRange({ count: 0, rowHeight: 44, height: 440, scrollTop: 0 })).toEqual({ start: 0, end: 0 });
  });

  test('300 行：顶上只画可视的十行加下面的余量，滚下去窗口跟着走，到底不越界', () => {
    const top = windowRange({ count: 300, rowHeight: 44, height: 440, scrollTop: 0 });
    expect(top.start).toBe(0);
    expect(top.end).toBe(16);
    const mid = windowRange({ count: 300, rowHeight: 44, height: 440, scrollTop: 44 * 100 });
    expect(mid).toEqual({ start: 94, end: 116 });
    const bottom = windowRange({ count: 300, rowHeight: 44, height: 440, scrollTop: 44 * 290 });
    expect(bottom.end).toBe(300);
    expect(bottom.start).toBeGreaterThan(270);
  });
});

describe('autoScrollDelta：拖到容器边缘自动滚', () => {
  // 容器 100 ~ 500
  test('中间不滚；靠上沿往上（负）、靠下沿往下（正）', () => {
    expect(autoScrollDelta(300, 100, 500)).toBe(0);
    expect(autoScrollDelta(120, 100, 500)).toBeLessThan(0);
    expect(autoScrollDelta(480, 100, 500)).toBeGreaterThan(0);
  });

  test('离沿越近越快；拖出容器按最快滚；最慢也至少 1 像素', () => {
    const far = Math.abs(autoScrollDelta(140, 100, 500));
    const near = Math.abs(autoScrollDelta(110, 100, 500));
    expect(near).toBeGreaterThan(far);
    expect(autoScrollDelta(20, 100, 500)).toBe(-24);
    expect(autoScrollDelta(900, 100, 500)).toBe(24);
    expect(autoScrollDelta(147, 100, 500)).toBe(-1);
  });

  test('容器比两个边区还矮：边区缩成各一半，没有高度的容器不滚', () => {
    expect(autoScrollDelta(110, 100, 140)).toBeLessThan(0);
    expect(autoScrollDelta(130, 100, 140)).toBeGreaterThan(0);
    expect(autoScrollDelta(100, 100, 100)).toBe(0);
  });
});

describe('置顶、置底、挪一格', () => {
  const ids = ['a', 'b', 'c', 'd'];

  test('置顶 / 置底：挪到头 / 尾，其余保持原来的先后', () => {
    expect(moveToEdge(ids, 'c', 'top')).toEqual(['c', 'a', 'b', 'd']);
    expect(moveToEdge(ids, 'b', 'bottom')).toEqual(['a', 'c', 'd', 'b']);
  });

  test('已经在头 / 尾、或不在里面：返回 null，不算一次改动', () => {
    expect(moveToEdge(ids, 'a', 'top')).toBeNull();
    expect(moveToEdge(ids, 'd', 'bottom')).toBeNull();
    expect(moveToEdge(ids, 'x', 'top')).toBeNull();
  });

  test('挪一格：头不能再往前、尾不能再往后', () => {
    expect(stepOrder(ids, 'b', -1)).toEqual(['b', 'a', 'c', 'd']);
    expect(stepOrder(ids, 'b', 1)).toEqual(['a', 'c', 'b', 'd']);
    expect(stepOrder(ids, 'a', -1)).toBeNull();
    expect(stepOrder(ids, 'd', 1)).toBeNull();
  });

  test('放下：放在目标前 / 后；放在自己身上顺序不变', () => {
    expect(dropOrder(ids, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
    expect(dropOrder(ids, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c']);
    expect(dropOrder(ids, 'b', 'b', 'after')).toEqual(ids);
  });
});

describe('filterRows：搜索和只看已开启', () => {
  const rows = [
    { name: 'Opus 5.5', family: 'claude', on: true },
    { name: 'Kimi k3', family: 'moonshot', on: false },
    { name: 'Opus 5', family: 'claude', on: false },
  ];
  const hay = (r: (typeof rows)[number]) => [r.name, r.family];
  const on = (r: (typeof rows)[number]) => r.on;

  test('不筛：原样；搜索不分大小写、多个词都要中', () => {
    expect(filterRows(rows, NO_FILTER, hay, on)).toHaveLength(3);
    expect(filterRows(rows, { query: 'OPUS', onlyEnabled: false }, hay, on)).toHaveLength(2);
    expect(filterRows(rows, { query: 'opus claude', onlyEnabled: false }, hay, on)).toHaveLength(2);
    expect(filterRows(rows, { query: 'opus moonshot', onlyEnabled: false }, hay, on)).toHaveLength(0);
  });

  test('只看已开启：关着的不要；和搜索一起用', () => {
    expect(filterRows(rows, { query: '', onlyEnabled: true }, hay, on).map((r) => r.name)).toEqual([
      'Opus 5.5',
    ]);
    expect(filterRows(rows, { query: 'kimi', onlyEnabled: true }, hay, on)).toHaveLength(0);
  });

  test('filterActive：空白搜索词不算在筛', () => {
    expect(filterActive(NO_FILTER)).toBe(false);
    expect(filterActive({ query: '   ', onlyEnabled: false })).toBe(false);
    expect(filterActive({ query: 'x', onlyEnabled: false })).toBe(true);
    expect(filterActive({ query: '', onlyEnabled: true })).toBe(true);
  });
});
