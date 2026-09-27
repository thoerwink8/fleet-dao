// /healthz 的 github_app 项：引擎每小时对账自检 GitHub 两个机器人的权限，缺的、没查成的开着提醒就红；撤了自己回绿。
// 对外只有一句中性的话（不提仓名、缺哪样权限），提醒的标题只进日志。
import { GITHUB_APP_ALERT_PREFIX, resolveAlertByKey, upsertAlert } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { githubAppHealthCheck } from '../src/github-app-health.ts';
import { PublicHealthError, runHealthChecks } from '../src/health.ts';
import { silentLogger } from '../src/log.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

describe('github_app', () => {
  it('没有机器人权限的提醒（别的提醒开着也不算）：好的', async () => {
    await upsertAlert(t.db, {
      dedupeKey: 'session-org:switch',
      level: 'alert',
      taskId: null,
      title: '会话用户切号没成',
      body: '占位',
    });
    await expect(githubAppHealthCheck(t.db)()).resolves.toBeUndefined();
  });

  it('【故意造出的失败】「引擎」缺 statuses:write 的提醒开着：报红，对外一句中性的话，哪一条只进日志；撤了回绿', async () => {
    const key = `${GITHUB_APP_ALERT_PREFIX}engine:acme/widgets`;
    await upsertAlert(t.db, {
      dedupeKey: key,
      level: 'alert',
      taskId: null,
      title: '「引擎」机器人在 acme/widgets 上的权限不对：缺 statuses:write',
      body: '占位',
    });
    const err = await githubAppHealthCheck(t.db)().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublicHealthError);
    expect(err).toMatchObject({
      code: 'github_app',
      message: 'GitHub 机器人的权限有要人看的问题',
      detail: 'github-app:engine:acme/widgets：「引擎」机器人在 acme/widgets 上的权限不对：缺 statuses:write',
    });
    const report = await runHealthChecks(
      [{ name: 'github_app', check: githubAppHealthCheck(t.db) }],
      silentLogger,
    );
    expect(report).toEqual({
      ok: false,
      checks: { github_app: { ok: false, code: 'github_app', message: 'GitHub 机器人的权限有要人看的问题' } },
    });
    await resolveAlertByKey(t.db, { dedupeKey: key, by: 'engine:hourly-reconcile' });
    await expect(githubAppHealthCheck(t.db)()).resolves.toBeUndefined();
  });
});
