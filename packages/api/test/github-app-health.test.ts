// /healthz 的 github_app 项：引擎每小时对账自检 GitHub 两个机器人的权限，缺的、没查成的开着提醒就红；撤了自己回绿。
// 对外只有一句中性的话（不提仓名、缺哪样权限），提醒的标题只进日志。
import { GITHUB_APP_ALERT_PREFIX, resolveAlertByKey, upsertAlert } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { noteOnlyOptions } from '@fleet-dao/shared';
import { silentLogger } from '@fleet-dao/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { githubAppHealthCheck } from '../src/github-app-health.ts';
import { PublicHealthError, PublicHealthWarning, runHealthChecks } from '../src/health.ts';

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
    const key = `${GITHUB_APP_ALERT_PREFIX}acme/widgets`;
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
      detail: 'github-app:acme/widgets：「引擎」机器人在 acme/widgets 上的权限不对：缺 statuses:write',
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

  it('机器人没装到某个仓（只有这一种问题，decision 级）：降成警告，整体仍 200、对外一句中性的话、仓名只进日志；装好了回绿', async () => {
    const key = `${GITHUB_APP_ALERT_PREFIX}acme/gadgets`;
    await upsertAlert(t.db, {
      dedupeKey: key,
      level: 'decision',
      taskId: null,
      title: 'acme/gadgets：先去 GitHub 把两个机器人装到这个仓',
      body: '占位',
      options: noteOnlyOptions(),
      reason: 'human-only',
    });
    const err = await githubAppHealthCheck(t.db)().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublicHealthWarning);
    expect(err).toMatchObject({
      code: 'github_app_not_installed',
      detail: expect.stringContaining('acme/gadgets'),
    });
    const report = await runHealthChecks(
      [
        { name: 'database', check: async () => {} },
        { name: 'github_app', check: githubAppHealthCheck(t.db) },
      ],
      silentLogger,
    );
    expect(report.ok).toBe(true);
    expect(report.checks.github_app).toEqual({
      ok: true,
      status: 'warning',
      code: 'github_app_not_installed',
      message: '有仓还没装好 GitHub 机器人（待处理）',
    });
    expect(JSON.stringify(report)).not.toContain('acme');
    await resolveAlertByKey(t.db, { dedupeKey: key, by: 'engine:hourly-reconcile' });
    await expect(githubAppHealthCheck(t.db)()).resolves.toBeUndefined();
  });

  it('【不降级】没装的警告和真权限故障同时开着：红的优先，整体 503', async () => {
    const warnKey = `${GITHUB_APP_ALERT_PREFIX}acme/gadgets`;
    const failKey = `${GITHUB_APP_ALERT_PREFIX}acme/widgets`;
    await upsertAlert(t.db, {
      dedupeKey: warnKey,
      level: 'decision',
      taskId: null,
      title: '没装',
      body: '占位',
      options: noteOnlyOptions(),
      reason: 'human-only',
    });
    await upsertAlert(t.db, {
      dedupeKey: failKey,
      level: 'alert',
      taskId: null,
      title: '缺权限',
      body: '占位',
    });
    const report = await runHealthChecks(
      [{ name: 'github_app', check: githubAppHealthCheck(t.db) }],
      silentLogger,
    );
    expect(report.ok).toBe(false);
    expect(report.checks.github_app).toMatchObject({ ok: false, code: 'github_app' });
    await resolveAlertByKey(t.db, { dedupeKey: warnKey, by: 'x' });
    await resolveAlertByKey(t.db, { dedupeKey: failKey, by: 'x' });
  });
});
