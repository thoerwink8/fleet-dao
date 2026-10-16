// 会话用户家里的子代理定义和仓里对不上的提醒（real/segment-settings.ts 的 reportSubagentDefs，#2834）：
// 每个会话用户一条，对不上就原地更新，对上了自动撤。用 PGlite 内存库。
import { notifications } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reportSubagentDefs, SUBAGENT_DEFS_ALERT_PREFIX } from '../../src/real/segment-settings.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

const USER = 'fleet-agent-carpool';
const KEY = `${SUBAGENT_DEFS_ALERT_PREFIX}${USER}`;
const rows = async () => (await t.db.select().from(notifications)).filter((n) => n.dedupeKey === KEY);

describe('reportSubagentDefs：会话用户家里的子代理定义和仓里对不上的提醒（#2834）', () => {
  it('键是 segment-subagent-defs:<会话用户>', () => {
    expect(KEY).toBe('segment-subagent-defs:fleet-agent-carpool');
  });

  it('对不上：报一条报警级提醒；同一个键再报原地更新，不重复推、没撤', async () => {
    await reportSubagentDefs(t.db, USER, ['Plan：家里没有 .claude/agents/Plan.md']);
    await reportSubagentDefs(t.db, USER, ['Plan：家里没有 .claude/agents/Plan.md', 'Explore：和仓里不一样']);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ level: 'alert', resolvedAt: null });
    expect(r[0]?.body).toContain('Explore：和仓里不一样');
  });

  it('再报对上了（空）：这一行撤掉，resolved_at 有值，正文写明已撤', async () => {
    await reportSubagentDefs(t.db, USER, ['Plan：家里没有 .claude/agents/Plan.md']);
    await reportSubagentDefs(t.db, USER, []);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]?.resolvedAt).not.toBeNull();
    expect(r[0]?.body).toContain('已撤：');
  });

  it('一上来就对上：不报错，表里没有这一行', async () => {
    await expect(reportSubagentDefs(t.db, USER, [])).resolves.toBeUndefined();
    expect(await rows()).toEqual([]);
  });
});
