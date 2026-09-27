// /healthz 的 session_org 项（#157）：引擎切会话用户挂的组织出了要人看的（切号没成、切完读回不在线、拼车恢复时刻读不到），
// 开着就红；撤了自己回绿。对外只有一句中性的话，提醒的标题只进日志。
import { resolveAlertByKey, SESSION_ORG_ALERT_PREFIX, upsertAlert } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublicHealthError, runHealthChecks } from '../src/health.ts';
import { silentLogger } from '../src/log.ts';
import { sessionOrgHealthCheck } from '../src/session-org-health.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

describe('session_org', () => {
  it('没有切号的提醒（别的提醒开着也不算）：好的', async () => {
    await upsertAlert(t.db, {
      dedupeKey: 'pool-hold:claude-solo',
      level: 'decision',
      taskId: null,
      title: '账号池整池暂停',
      body: '占位',
    });
    await expect(sessionOrgHealthCheck(t.db)()).resolves.toBeUndefined();
  });

  it('【故意造出的失败】切号的提醒开着：报红，对外一句中性的话，哪一条只进日志；撤了回绿', async () => {
    const key = `${SESSION_ORG_ALERT_PREFIX}switch`;
    await upsertAlert(t.db, {
      dedupeKey: key,
      level: 'alert',
      taskId: null,
      title: '会话用户切号没成：拼车 → 独享',
      body: '占位',
    });
    const err = await sessionOrgHealthCheck(t.db)().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublicHealthError);
    expect(err).toMatchObject({
      code: 'session_org',
      message: '会话账号切换有要人看的问题',
      detail: 'session-org:switch：会话用户切号没成：拼车 → 独享',
    });
    const report = await runHealthChecks(
      [{ name: 'session_org', check: sessionOrgHealthCheck(t.db) }],
      silentLogger,
    );
    expect(report).toEqual({
      ok: false,
      checks: { session_org: { ok: false, code: 'session_org', message: '会话账号切换有要人看的问题' } },
    });
    await resolveAlertByKey(t.db, { dedupeKey: key, by: 'engine:org-switch' });
    await expect(sessionOrgHealthCheck(t.db)()).resolves.toBeUndefined();
  });
});
