// 更新日志：同一个版本号不能既有发布标记、又被当成「这一版」。
// 故意造出的失败：v3 开着、又已经有 ## [v3] 标记 → 判成已发布，「这一版」取下一个号。
import { describe, expect, test } from 'vitest';
import { separateReleasedFromCurrent } from './changelog-version';

const V3 = { version: 'v3', milestone: { number: 3, title: 'v3 三段一条龙' } };
const V4 = { version: 'v4', milestone: { number: 4, title: 'v4 看得更清楚' } };

describe('已发布和这一版不能是同一个号', () => {
  test('同一版本既有发布标记又被当成这一版：判成已发布，这一版取下一个号', () => {
    // 开着的里 N 最小的是 v3（数组顺序故意把 v4 放前面），可 v3 已经有发布标记。
    const released = [{ version: 'v3', date: '2026-10-05' }];
    const r = separateReleasedFromCurrent([V4, V3], released);
    expect(released.map((item) => item.version)).toContain('v3');
    expect(r.version).toBe('v4');
    expect(r.milestone).toEqual(V4.milestone);
    expect(r.others).toEqual([]);
  });

  test('候选没有发布标记：这一版就是候选，不取下一个号', () => {
    const r = separateReleasedFromCurrent([V4, V3], []);
    expect(r.version).toBe('v3');
    expect(r.milestone).toEqual(V3.milestone);
    expect(r.others).toEqual([V4.milestone]);
  });

  test('更早的号发过、候选自己没有标记：不按已发布的最大号 +1 猜', () => {
    const r = separateReleasedFromCurrent([V3], [{ version: 'v1' }]);
    expect(r.version).toBe('v3');
  });

  test('下一个号也有发布标记：继续往后，直到这一版不再是已发布', () => {
    const released = [
      { version: 'v3', date: '2026-10-05' },
      { version: 'v4', date: '2026-10-06' },
    ];
    const r = separateReleasedFromCurrent([V3], released);
    expect(r.version).toBe('v5');
    expect(released.map((item) => item.version)).not.toContain(r.version);
  });
});
