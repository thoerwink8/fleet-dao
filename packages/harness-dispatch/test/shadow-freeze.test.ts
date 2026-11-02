// 冻结影子批次的命令入口（#3776）：读齐再写、不合格整批不冻、冻结后不改。
import { BatchFrozenError, listBatchItems } from '@fleet-dao/harness-store';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freezeShadowRefs, parseShadowRef, type ShadowFreezeReader } from '../src/index.ts';

const SHA = 'a'.repeat(40);
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec('truncate fleet2.shadow_batch_items restart identity');
});

const reader = (facts: Record<number, { open: boolean; isPr: boolean }>): ShadowFreezeReader => ({
  issueFacts: async (_r, n) => {
    const f = facts[n];
    if (!f) throw new Error(`读 ${n}：HTTP 404`);
    return f;
  },
  headSha: async () => SHA,
});
const open = { open: true, isPr: false };

describe('freezeShadowRefs', () => {
  it('开着的单冻结进清单，基线是主线现在的提交', async () => {
    const items = await freezeShadowRefs(t.db, reader({ 1: open, 2: open }), 'b1', [
      { repo: 'o/r', issue: 1 },
      { repo: 'o/r', issue: 2 },
    ]);
    expect(items.map((i) => i.issue)).toEqual([1, 2]);
    const rows = await listBatchItems(t.db, 'b1');
    expect(rows.map((r) => [r.repo, r.issue, r.baseSha])).toEqual([
      ['o/r', 1, SHA],
      ['o/r', 2, SHA],
    ]);
  });

  it('有一张是 PR、已关、读不到或写了两遍，整批都不冻结', async () => {
    const r = reader({ 1: open, 2: { open: true, isPr: true }, 3: { open: false, isPr: false } });
    const f = (n: number[]) =>
      freezeShadowRefs(
        t.db,
        r,
        'b2',
        n.map((issue) => ({ repo: 'o/r', issue })),
      );
    await expect(f([1, 2])).rejects.toThrow('是 PR');
    await expect(f([1, 3])).rejects.toThrow('已经关了');
    await expect(f([1, 9])).rejects.toThrow('404');
    await expect(f([1, 1])).rejects.toThrow('写了两遍');
    expect(await listBatchItems(t.db, 'b2')).toEqual([]);
  });

  it('allowClosed 放行已关的单（对照批）', async () => {
    await freezeShadowRefs(
      t.db,
      reader({ 3: { open: false, isPr: false } }),
      'b3',
      [{ repo: 'o/r', issue: 3 }],
      { allowClosed: true },
    );
    expect(await listBatchItems(t.db, 'b3')).toHaveLength(1);
  });

  it('同一批次号冻结后不改；空批次和坏批次号拒', async () => {
    const r = reader({ 1: open, 2: open });
    await freezeShadowRefs(t.db, r, 'b4', [{ repo: 'o/r', issue: 1 }]);
    await expect(freezeShadowRefs(t.db, r, 'b4', [{ repo: 'o/r', issue: 2 }])).rejects.toThrow(
      BatchFrozenError,
    );
    await expect(freezeShadowRefs(t.db, r, 'b5', [])).rejects.toThrow('空批次');
    await expect(freezeShadowRefs(t.db, r, 'bad id!', [{ repo: 'o/r', issue: 1 }])).rejects.toThrow('批次号');
  });
});

describe('parseShadowRef', () => {
  it('认 owner/仓#号，别的写法抛', () => {
    expect(parseShadowRef('thoerwink8/fleet-dao#3776')).toEqual({
      repo: 'thoerwink8/fleet-dao',
      issue: 3776,
    });
    expect(() => parseShadowRef('3776')).toThrow('写法不对');
  });
});
