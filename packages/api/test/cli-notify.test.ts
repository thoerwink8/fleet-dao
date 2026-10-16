// fleet-api notify raise（#2729）：法国上的发版脚本写卡住报警的统一入口。经 upsertAlert 落库（同键原地更新、处理过的重新打开）；
// 参数不对不连库；要你拍不走这里（只收 alert、daily）。真 Postgres（PGlite）。
import { notifications } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CliDeps, main } from '../src/cli.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

function setup(body = '发版没成：第 4 步健康检查没过') {
  const out: string[] = [];
  const err: string[] = [];
  let dbOpened = 0;
  const deps: CliDeps = {
    env: { DATABASE_URL: 'postgres:///fleet' },
    out: (x) => out.push(x),
    err: (x) => err.push(x),
    now: () => new Date('2026-10-16T09:00:00Z'),
    readStdin: async () => body,
    openStore: async () => {
      throw new Error('notify 不该用 Store');
    },
    openDb: async () => {
      dbOpened += 1;
      return { db: t.db, close: async () => {} };
    },
  };
  return { out, err, deps, dbOpened: () => dbOpened };
}

const row = async (key: string) =>
  (await t.db.select().from(notifications).where(eq(notifications.dedupeKey, key)))[0];

describe('fleet-api notify raise', () => {
  it('记一条卡住报警：正文从标准输入读、带驾驶舱链接；同键再报原地更新，处理过的重新打开', async () => {
    const key = 'release:failed:aaaaaaaaaaaa:untouched';
    const s = setup('第一次的正文\n');
    expect(
      await main(
        ['notify', 'raise', '--key', key, '--title', '【发版失败】第 0 步', '--link', '/france'],
        s.deps,
      ),
    ).toBe(0);
    expect(s.out.join('\n')).toContain(`记了提醒 ${key}`);
    expect(await row(key)).toMatchObject({
      level: 'alert',
      title: '【发版失败】第 0 步',
      body: '第一次的正文',
      link: '/france',
      decisionOptions: null,
      decisionReason: null,
      resolvedAt: null,
    });

    await t.db
      .update(notifications)
      .set({ resolvedAt: new Date(), resolvedBy: 'release-request' })
      .where(eq(notifications.dedupeKey, key));
    const again = setup('第二次的正文');
    expect(await main(['notify', 'raise', '--key', key, '--title', '【发版失败】又一次'], again.deps)).toBe(
      0,
    );
    expect(again.out.join('\n')).toContain(`更新了提醒 ${key}`);
    expect(await row(key)).toMatchObject({
      title: '【发版失败】又一次',
      body: '第二次的正文',
      resolvedAt: null,
    });
    expect(await t.db.select().from(notifications)).toHaveLength(1);
  });

  it('老版本记成要你拍的同键行：再报改成卡住报警，选项、原因清掉', async () => {
    const key = 'release:blocked:bbbbbbbbbbbb:1';
    await t.client.query(
      `insert into notifications (level, dedupe_key, title, body, decision_options, decision_reason)
       values ('decision', $1, '旧', '', $2::jsonb, 'human-only')`,
      [
        key,
        JSON.stringify([
          { id: 'a', label: '甲', detail: '甲', recommended: '甲' },
          { id: 'b', label: '乙', detail: '乙' },
        ]),
      ],
    );
    expect(await main(['notify', 'raise', '--key', key, '--title', '卡住'], setup().deps)).toBe(0);
    expect(await row(key)).toMatchObject({ level: 'alert', decisionOptions: null, decisionReason: null });
  });

  it('【故意造出的失败】要你拍不走这里、缺参数、认不出的参数、键带空白：退出 2，不连库、不写', async () => {
    for (const argv of [
      ['notify', 'raise', '--key', 'k:1', '--title', 't', '--level', 'decision'],
      ['notify', 'raise', '--key', 'k:1'],
      ['notify', 'raise', '--key', 'k:1', '--title', 't', '--options', 'x'],
      ['notify', 'raise', '--key', 'k 1', '--title', 't'],
      ['notify', 'raise', '--key', 'k:1', '--title', 't', '--link', 'http://x'],
      ['notify', 'resolve', '--key', 'k:1'],
    ]) {
      const s = setup();
      expect(await main(argv, s.deps), argv.join(' ')).toBe(2);
      expect(s.dbOpened()).toBe(0);
      expect(s.err.join('\n')).not.toBe('');
    }
    const s = setup();
    await main(['notify', 'raise', '--key', 'k:1', '--title', 't', '--level', 'decision'], s.deps);
    expect(s.err.join('\n')).toContain('要你拍不走这里');
    expect(await t.db.select().from(notifications)).toEqual([]);
  });

  it('标题太长截断不拒（报警丢了比标题长更糟）', async () => {
    expect(
      await main(['notify', 'raise', '--key', 'k:long', '--title', '长'.repeat(300)], setup().deps),
    ).toBe(0);
    const title = (await row('k:long'))?.title ?? '';
    expect([...title]).toHaveLength(200);
    expect(title.endsWith('…')).toBe(true);
  });

  it('【故意造出的失败】库写不进：退出 1，照实说没记上', async () => {
    const s = setup();
    s.deps.openDb = async () => {
      throw new Error('连不上库');
    };
    expect(await main(['notify', 'raise', '--key', 'k:1', '--title', 't'], s.deps)).toBe(1);
    expect(s.err.join('\n')).toContain('提醒没记上：连不上库');
  });
});
