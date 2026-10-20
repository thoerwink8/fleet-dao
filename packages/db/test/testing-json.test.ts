import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, realTestPgUrl, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';

describe('TestClient raw SQL JSON 参数合同', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
    if (realTestPgUrl()) {
      const { rows } = await t.client.query<{ db: string }>('select current_database() as db');
      expect(rows[0]?.db).toMatch(/^fleet_test_[a-f0-9]{32}$/);
    }
  }, TEST_DB_TIMEOUT_MS);
  afterAll(async () => t?.close());

  for (const type of ['json', 'jsonb']) {
    for (const [name, value] of [
      ['object', { nested: { enabled: false }, text: '中文' }],
      ['array', [{ enabled: true }, 2, null]],
      ['string', 'literal text'],
      ['null', null],
      ['boolean', true],
      ['boolean', false],
      ['number', 1.25],
    ] as const) {
      it(`${type} 已序列化 ${name} 只解码一次`, async () => {
        const { rows } = await t.client.query<{ value: unknown; kind: string }>(
          `select $1::${type} as value, ${type}_typeof($1::${type}) as kind`,
          [JSON.stringify(value)],
        );
        expect(rows[0]).toEqual({ value, kind: name });
      });
    }
    for (const value of [{ nested: [1, true] }, [{ id: 1 }, 'two']]) {
      it(`${type} 原生${Array.isArray(value) ? '数组' : '对象'}仍可直接传入`, async () => {
        const { rows } = await t.client.query<{ value: unknown }>(`select $1::${type} as value`, [value]);
        expect(rows[0]?.value).toEqual(value);
      });
    }
    it(`${type} 非法JSON文本必须拒绝，不能包装成合法字符串`, async () => {
      for (const bad of ['not-json', '{"missing":', ''])
        await expect(t.client.query(`select $1::${type}`, [bad])).rejects.toThrow();
    });
  }

  it('普通text、数字、UUID与日期读回保持原语义', async () => {
    const id = 'c8cc2233-a9f5-4a2b-9ca2-60713ec40b45';
    const at = '2026-10-19T18:00:00.000Z';
    const { rows } = await t.client.query<{
      text: string;
      n: number;
      id: string;
      at: Date;
      absent: unknown;
    }>('select $1::text as text, $2::int as n, $3::uuid as id, $4::timestamptz as at, $5::jsonb as absent', [
      '{not JSON and must remain text}',
      42,
      id,
      at,
      null,
    ]);
    expect(rows[0]).toEqual({
      text: '{not JSON and must remain text}',
      n: 42,
      id,
      at: new Date(at),
      absent: null,
    });
  });

  it('Date 参数保留各原后端合同，不被JSON配置改写', async () => {
    const at = new Date('2026-10-19T18:00:00.000Z');
    if (!realTestPgUrl()) {
      expect(() => t.client.query('select $1::timestamptz', [at])).toThrow('SQL 参数里有 Date');
      return;
    }
    const { rows } = await t.client.query<{ at: Date }>('select $1::timestamptz as at', [at]);
    expect(rows[0]?.at).toEqual(at);
  });
});
