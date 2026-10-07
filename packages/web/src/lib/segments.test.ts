// 不计的段（#761）：名单只有对题；每一句都说明白，不拿「没记」「没读到」冒充。
import { describe, expect, test } from 'vitest';
import { SEGMENT_UNMETERED } from './segments';

describe('不计的段（#761）', () => {
  test('只有对题不计；动手、验收没有行是真的没跑或没记，不许写成不计', () => {
    expect(Object.keys(SEGMENT_UNMETERED)).toEqual(['scope']);
    expect(SEGMENT_UNMETERED.manual).toBeUndefined();
    expect(SEGMENT_UNMETERED.verify).toBeUndefined();
  });

  test('每一句都说明白：不计的原因、引擎有对题会话时的补充；短句和补充不写「没记」「没读到」', () => {
    const u = SEGMENT_UNMETERED.scope;
    if (!u) throw new Error('对题应当不计');
    expect(u.short).toContain('不计');
    expect(u.why).toContain('对话');
    expect(u.partial).toContain('不计');
    for (const s of [u.short, u.partial]) expect(s).not.toMatch(/没记|没读到/);
  });
});
