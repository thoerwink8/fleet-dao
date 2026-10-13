// 库的大小（#1985，db-sizes.ts）：bigint 字符串转成数；没 CONNECT 权限的库（null）单写没读到；认不出的整块抛，不拿 0 顶。
import { describe, expect, test } from 'vitest';
import { DATABASE_SIZES_SQL, parseDatabaseSizes, pgDatabaseSizes } from '../src/db-sizes.ts';

describe('库的大小', () => {
  test('bigint 字符串转成数；null 是没权限（undefined，不是 0）', () => {
    expect(
      parseDatabaseSizes([
        { name: 'fleet', bytes: '1932735283' },
        { name: 'temporal', bytes: 12 },
        { name: 'other', bytes: null },
      ]),
    ).toEqual([
      { name: 'fleet', bytes: 1932735283 },
      { name: 'temporal', bytes: 12 },
      { name: 'other', bytes: undefined },
    ]);
  });

  test('【故意造红】大小认不出、库名不是字：抛', () => {
    expect(() => parseDatabaseSizes([{ name: 'fleet', bytes: 'abc' }])).toThrow('库 fleet 的大小认不出');
    expect(() => parseDatabaseSizes([{ name: 3, bytes: '1' }])).toThrow('库名认不出');
  });

  test('只查非模板库、带 CONNECT 权限判断，交给连接的就是这一句', async () => {
    expect(DATABASE_SIZES_SQL).toContain('not datistemplate');
    expect(DATABASE_SIZES_SQL).toContain("has_database_privilege(datname, 'CONNECT')");
    const asked: string[] = [];
    const sizes = pgDatabaseSizes(async (text) => {
      asked.push(text);
      return [{ name: 'fleet', bytes: '10' }];
    });
    expect(await sizes()).toEqual([{ name: 'fleet', bytes: 10 }]);
    expect(asked).toEqual([DATABASE_SIZES_SQL]);
  });
});
