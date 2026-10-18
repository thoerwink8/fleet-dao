import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import { parseQuoteArgs, runQuote } from '../src/quote-cli.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
const q = {
  id: 'f42a5acf-2eba-4d63-9c5f-aa14fba76df0',
  spokenAt: '2026-10-18T10:00:00Z',
  text: 'CLI合成私有原话',
  machine: 'fixture',
  lineage: 'fixture',
  remote: null,
  directiveId: null,
};
describe('quote CLI', () => {
  it('put从stdin读数组，幂等、get和since list可用', async () => {
    const stdin = async () => JSON.stringify([q]);
    expect(await runQuote(['put'], t.db, stdin)).toEqual({ ids: [q.id] });
    expect(await runQuote(['put'], t.db, stdin)).toEqual({ ids: [q.id] });
    expect(
      await runQuote(['get', q.id], t.db, async () => {
        throw new Error('不得读stdin');
      }),
    ).toMatchObject({ ...q, spokenAt: new Date(q.spokenAt) });
    expect(await runQuote(['list', '--since', q.spokenAt], t.db, stdin)).toHaveLength(1);
  });
  it('拒绝命令行正文、坏JSON/字段/编号冲突/不存在均不泄漏内容', async () => {
    expect(() => parseQuoteArgs(['put', q.text])).toThrow('用法');
    for (const raw of [
      q.text,
      JSON.stringify([{ ...q, extra: q.text }]),
      JSON.stringify([{ ...q, text: '另一段合成秘密' }]),
    ]) {
      await expect(runQuote(['put'], t.db, async () => raw)).rejects.toThrow('内容不回显');
    }
    await expect(
      runQuote(['get', 'f42a5acf-2eba-4d63-9c5f-aa14fba76df1'], t.db, async () => ''),
    ).rejects.toThrow('内容不回显');
  });
});

it('真实fleet-api入口用私有stdin和数据库，失败不回显payload', async () => {
  const out: string[] = [],
    err: string[] = [];
  const deps = {
    env: { DATABASE_URL: 'postgres://fixture.invalid/fixture' },
    out: (s: string) => {
      out.push(s);
    },
    err: (s: string) => {
      err.push(s);
    },
    now: () => new Date(),
    openStore: async () => {
      throw new Error('不得读Store');
    },
    openDb: async () => ({ db: t.db, close: async () => {} }),
    readStdin: async () => JSON.stringify([q]),
  };
  expect(await runCli(['quote', 'put'], deps)).toBe(0);
  expect(JSON.parse(out[0]!)).toEqual({ ids: [q.id] });
  expect(out.join('')).not.toContain(q.text);
  expect(await runCli(['quote', 'put'], { ...deps, readStdin: async () => q.text })).toBe(1);
  expect(err.join('')).not.toContain(q.text);
  expect(err.join('')).toContain('内容不回显');
});
