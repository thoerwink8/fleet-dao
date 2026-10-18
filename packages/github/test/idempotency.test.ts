import { describe, expect, it } from 'vitest';
import { memoryIdempotencyStore } from '../src/idempotency.ts';

describe('内存幂等账的真实来源', () => {
  it('peek 返回原始 action/target，冲突占用、完成和接管不能升级补账来源', async () => {
    const store = memoryIdempotencyStore();
    const key = 'gh:merge_pr:acme/widgets#1:head';
    const first = new Date('2026-09-25T10:00:00Z');
    const later = new Date('2026-09-25T11:00:00Z');
    await store.claim({ key, action: 'github.merge_pr_backfill', target: 'acme/widgets#1' }, first);
    expect(await store.peek(key)).toEqual({
      action: 'github.merge_pr_backfill',
      target: 'acme/widgets#1',
      claimedAt: first,
      completedAt: null,
      result: undefined,
    });
    expect(await store.claim({ key, action: 'github.merge_pr', target: 'other/repo#2' }, later)).toEqual({
      status: 'in-flight',
      claimedAt: first,
    });
    expect(await store.takeOver(key, first, later)).toBe(true);
    const receipt = { number: 1, head: 'a'.repeat(40), mergeCommit: 'b'.repeat(40), mergedBy: 'engine[bot]' };
    await store.complete(key, receipt, later);
    expect(await store.peek(key)).toEqual({
      action: 'github.merge_pr_backfill',
      target: 'acme/widgets#1',
      claimedAt: later,
      completedAt: later,
      result: receipt,
    });
    expect(
      await store.claim({ key, action: 'github.merge_pr', target: 'other/repo#2' }, later),
    ).toMatchObject({ status: 'done' });
    expect(await store.peek(key)).toMatchObject({
      action: 'github.merge_pr_backfill',
      target: 'acme/widgets#1',
      result: receipt,
    });
  });

  it('未指定 target 留为 null；找不到键返回 null', async () => {
    const store = memoryIdempotencyStore();
    expect(await store.peek('missing')).toBeNull();
    await store.claim({ key: 'key', action: 'github.test' }, new Date());
    expect(await store.peek('key')).toMatchObject({ action: 'github.test', target: null, completedAt: null });
  });
});
