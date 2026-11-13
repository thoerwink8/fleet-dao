import { describe, expect, it } from 'vitest';
import { matchingFamilies, nestSessions } from './session-tree';

const row = (id: string, parentId: string | null) => ({ id, parentId, title: id });

describe('子会话挂在父会话下', () => {
  it('父会话在列表里时，子会话不另占一行', () => {
    const nested = nestSessions([row('p', null), row('c', 'p'), row('g', 'c'), row('solo', null)]);
    expect(nested.map((r) => r.id)).toEqual(['p', 'solo']);
    expect(nested[0]?.children.map((r) => r.id)).toEqual(['c']);
    expect(nested[0]?.children[0]?.children.map((r) => r.id)).toEqual(['g']);
  });

  it('父会话不在这一页时，子会话自己当一行', () => {
    const nested = nestSessions([row('c', 'missing')]);
    expect(nested.map((r) => r.id)).toEqual(['c']);
    expect(nested[0]?.children).toEqual([]);
  });

  it('搜到子会话时父会话还在', () => {
    const rows = [row('p', null), row('c', 'p'), row('other', null)];
    const kept = matchingFamilies(rows, (r) => r.title === 'c');
    expect(kept.map((r) => r.id).sort()).toEqual(['c', 'p']);
  });
});
