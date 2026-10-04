// 拼车盯读的真接线（real/carpool-watch.ts，#194）：迁移 0034 上线后引擎第一轮盯读起不来、或账本认不出，要推 session-org:ledger
// 「要人看」提醒（和切号那边同一条），不只记一条没跑成的记录；账本读得出了自己撤。
import { notifications, saveOrgState } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CarpoolWatchFailedError, runCarpoolWatchJob } from '../../src/jobs/carpool-watch.ts';
import { emptyLedger, serializeLedger } from '../../src/jobs/org-ledger.ts';
import { carpoolWatchJob } from '../../src/real/carpool-watch.ts';
import { registerEngineJobs } from '../../src/real/jobs.ts';
import { ORG_LEDGER_ALERT } from '../../src/real/org-switch.ts';
import { NOW, world } from './fixtures.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await world(t.db);
  await registerEngineJobs(t.db);
});

const USER = 'fleet-agent-carpool';
const alertOf = async () =>
  (await t.db.select().from(notifications)).find((n) => n.dedupeKey === ORG_LEDGER_ALERT);

function deps() {
  return carpoolWatchJob({
    db: t.db,
    user: USER,
    sessionOrg: async () => ({ ok: true, org: 'carpool' }),
    orgSwitch: { now: async () => null } as never,
    readApi: async () => ({ ok: false, requestedAt: NOW, code: 'network', why: '测试里不连网' }),
    now: () => NOW,
    log: () => {},
  })();
}

describe('盯读读账本', () => {
  it('【故意造出失败】账本认不出：这一轮记没跑成、抛 CarpoolWatchFailedError，同时推 session-org:ledger；修好了下一轮自己撤', async () => {
    await saveOrgState(t.db, USER, { v: 99, garbage: true }, NOW);
    await expect(runCarpoolWatchJob(deps())).rejects.toBeInstanceOf(CarpoolWatchFailedError);
    expect(await alertOf()).toMatchObject({ level: 'alert', resolvedAt: null });
    expect((await alertOf())?.body).toContain('拼车盯读这一轮读不了账本');

    await saveOrgState(t.db, USER, serializeLedger(emptyLedger()), NOW);
    await runCarpoolWatchJob(deps());
    expect((await alertOf())?.resolvedAt).not.toBeNull();
  });

  it('【故意造出失败】库读不了（比如迁移 0034 没跑、session_org_state 不在）：照常抛，不推「账本认不出」冒充另一回事', async () => {
    await t.client.exec('alter table session_org_state rename to session_org_state_unreadable');
    try {
      await expect(runCarpoolWatchJob(deps())).rejects.toThrow();
      expect(await alertOf()).toBeUndefined();
    } finally {
      await t.client.exec('alter table session_org_state_unreadable rename to session_org_state');
    }
  });
});
