import { describe, expect, it } from 'vitest';
import {
  byAtThenId,
  compareIds,
  cursorOf,
  nextCursorOf,
  pageOfSorted,
  startAfterCursor,
} from '../src/paging.ts';

const row = (at: string, id: string) => ({ at, id });
// 倒序：新的在前
const LIST = [
  row('2026-01-01T00:00:05.000Z', '9'),
  row('2026-01-01T00:00:05.000Z', '10'),
  row('2026-01-01T00:00:03.000Z', '2'),
  row('2026-01-01T00:00:01.000Z', '1'),
].sort((a, b) => byAtThenId(b, a));

describe('翻页共用逻辑', () => {
  it('compareIds：纯数字按数值（9 < 10），其余按字面', () => {
    expect(compareIds('9', '10')).toBeLessThan(0);
    expect(compareIds('10', '9')).toBeGreaterThan(0);
    expect(compareIds('audit:000000000000009', 'audit:000000000000010')).toBeLessThan(0);
    expect(compareIds('a', 'a')).toBe(0);
    expect(compareIds('9', 'a')).toBeLessThan(0);
  });

  it('byAtThenId：先比时刻、再比编号', () => {
    expect(
      byAtThenId(row('2026-01-01T00:00:01.000Z', '9'), row('2026-01-01T00:00:02.000Z', '1')),
    ).toBeLessThan(0);
    expect(
      byAtThenId(row('2026-01-01T00:00:01.000Z', '9'), row('2026-01-01T00:00:01.000Z', '10')),
    ).toBeLessThan(0);
  });

  it('游标是 at|id；没有最后一条或后面没有了就不给', () => {
    expect(cursorOf(row('2026-01-01T00:00:01.000Z', 'x'))).toBe('2026-01-01T00:00:01.000Z|x');
    expect(nextCursorOf(undefined, true)).toBeUndefined();
    expect(nextCursorOf(row('t', 'x'), false)).toBeUndefined();
    expect(nextCursorOf(row('t', 'x'), true)).toBe('t|x');
  });

  it('startAfterCursor：没游标从头；游标是严格之后；游标比所有都小回列表长度', () => {
    expect(startAfterCursor(LIST, null)).toBe(0);
    expect(startAfterCursor(LIST, row('2026-01-01T00:00:05.000Z', '10'))).toBe(1);
    expect(startAfterCursor(LIST, row('2026-01-01T00:00:03.000Z', '2'))).toBe(3);
    expect(startAfterCursor(LIST, row('2026-01-01T00:00:00.000Z', '0'))).toBe(LIST.length);
    expect(startAfterCursor([], row('t', 'x'))).toBe(0);
  });

  it('pageOfSorted：翻页一页一页走完，不漏不重；最后一页没有游标；刚好整除也不多给一页', () => {
    const seen: string[] = [];
    let cursor: { at: string; id: string } | null = null;
    for (let i = 0; i < 10; i++) {
      const page = pageOfSorted(LIST, cursor, 2);
      seen.push(...page.items.map((x) => x.id));
      if (!page.nextCursor) break;
      cursor = parseTestCursor(page.nextCursor);
    }
    expect(seen).toEqual(LIST.map((x) => x.id));
    expect(pageOfSorted(LIST, null, 4).nextCursor).toBeUndefined();
    expect(pageOfSorted(LIST, null, 3).nextCursor).toBeDefined();
    expect(pageOfSorted([], null, 3)).toEqual({ items: [], nextCursor: undefined });
  });
});

function parseTestCursor(raw: string) {
  const sep = raw.lastIndexOf('|');
  return { at: raw.slice(0, sep), id: raw.slice(sep + 1) };
}
