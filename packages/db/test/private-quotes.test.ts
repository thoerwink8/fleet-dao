import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPrivateQuote, listPrivateQuotes, putPrivateQuotes } from '../src/queries/private-quotes.ts';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
const q = {
  id: 'f42a5acf-2eba-4d63-9c5f-aa14fba76df0',
  spokenAt: '2026-10-18T10:00:00Z',
  text: '合成私有原文',
  machine: 'fixture-machine',
  lineage: 'fixture-session',
  remote: 'https://fixture.invalid/team/project.git',
  directiveId: '20261018180000',
};
describe('私有原话真迁移与幂等', () => {
  it('精确字段读回、重试不改入库时间，since按说话时间筛', async () => {
    expect(await putPrivateQuotes(t.db, [q])).toEqual([q.id]);
    const first = await getPrivateQuote(t.db, q.id);
    expect(first).toMatchObject({ ...q, spokenAt: new Date(q.spokenAt) });
    await putPrivateQuotes(t.db, [q]);
    expect((await getPrivateQuote(t.db, q.id))?.receivedAt).toEqual(first?.receivedAt);
    expect(await listPrivateQuotes(t.db, new Date(q.spokenAt))).toHaveLength(1);
    expect(await listPrivateQuotes(t.db, new Date('2026-10-18T10:00:01Z'))).toEqual([]);
  });
  it('首尾空白原样保存，同id仅空白不同也拒绝', async () => {
    const padded = { ...q, id: 'f42a5acf-2eba-4d63-9c5f-aa14fba76df2', text: ' \n' + q.text + ' \n' };
    await putPrivateQuotes(t.db, [padded]);
    expect((await getPrivateQuote(t.db, padded.id))?.text).toBe(padded.text);
    await expect(putPrivateQuotes(t.db, [{ ...padded, text: q.text }])).rejects.toThrow('编号冲突');
  });
  it('同编号异文拒绝且整批回滚，错误不含原文', async () => {
    const next = { ...q, id: 'f42a5acf-2eba-4d63-9c5f-aa14fba76df1' };
    await expect(putPrivateQuotes(t.db, [next, { ...q, text: '另一个合成秘密' }])).rejects.toThrow(
      '编号冲突',
    );
    expect(await getPrivateQuote(t.db, next.id)).toBeNull();
    expect((await getPrivateQuote(t.db, q.id))?.text).toBe(q.text);
  });
});
