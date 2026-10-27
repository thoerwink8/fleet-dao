// 区块收起的开合记在网址参数 ?open=（#3707 批次 3）：解析、写回、点一下翻过来。
// 常态网址要干净：和默认一样的就不写进网址；两边都空就把参数整个删掉。
import { describe, expect, test } from 'vitest';
import { isOpenIn, OPEN_PARAM, openIn, parseOpen, serializeOpen, toggleIn } from './section-open';

describe('解析 ?open=', () => {
  test('没参数就是空', () => {
    const s = parseOpen(null);
    expect([...s.opened]).toEqual([]);
    expect([...s.closed]).toEqual([]);
    expect(parseOpen(undefined)).toEqual(parseOpen(''));
  });

  test('逗号分开；前面带 - 的是显式收起；空格、空段跳过', () => {
    const s = parseOpen(' alarm , -projects ,, overview ');
    expect([...s.opened].sort()).toEqual(['alarm', 'overview']);
    expect([...s.closed]).toEqual(['projects']);
  });
});

describe('写回 ?open=', () => {
  test('排序后逗号连起来；空的返回 null（参数整个删掉）', () => {
    expect(serializeOpen(parseOpen('projects,alarm'))).toBe('alarm,projects');
    expect(serializeOpen({ opened: new Set(['a']), closed: new Set(['b']) })).toBe('a,-b');
    expect(serializeOpen(parseOpen(''))).toBeNull();
  });

  test('解析再写回是同一串（除排序）', () => {
    expect(serializeOpen(parseOpen('alarm,-projects'))).toBe('alarm,-projects');
    expect(serializeOpen(parseOpen('-projects,alarm'))).toBe('alarm,-projects');
  });
});

describe('这一块现在是开是合', () => {
  test('显式收起优先，其次显式展开，都没有才用默认', () => {
    const s = parseOpen('alarm,-ask');
    expect(isOpenIn(s, 'alarm', false)).toBe(true);
    expect(isOpenIn(s, 'ask', true)).toBe(false);
    expect(isOpenIn(s, 'run', true)).toBe(true);
    expect(isOpenIn(s, 'projects', false)).toBe(false);
  });
});

describe('点一下', () => {
  test('默认收起的：从合到开记成展开；再点回到默认就不写进网址', () => {
    const first = toggleIn(parseOpen(null), 'projects', false);
    expect(serializeOpen(first)).toBe('projects');
    expect(isOpenIn(first, 'projects', false)).toBe(true);
    const back = toggleIn(first, 'projects', false);
    expect(serializeOpen(back)).toBeNull();
  });

  test('默认展开的：从开到合记成 -key；再点回到默认就不写进网址', () => {
    const first = toggleIn(parseOpen(null), 'ask', true);
    expect(serializeOpen(first)).toBe('-ask');
    expect(isOpenIn(first, 'ask', true)).toBe(false);
    const back = toggleIn(first, 'ask', true);
    expect(serializeOpen(back)).toBeNull();
  });

  test('别块的开合不受影响', () => {
    const s = parseOpen('alarm,-ask');
    expect(serializeOpen(toggleIn(s, 'projects', false))).toBe('alarm,projects,-ask');
    expect(serializeOpen(toggleIn(s, 'ask', true))).toBe('alarm');
  });
});

describe('点页内目录跳到收着的一节', () => {
  test('不管默认怎样都记成展开，原来收着的记法去掉', () => {
    expect(serializeOpen(openIn(parseOpen('-projects'), 'projects'))).toBe('projects');
    expect(serializeOpen(openIn(parseOpen('-ask'), 'ask'))).toBe('ask');
    expect(OPEN_PARAM).toBe('open');
  });
});
