// /healthz 认出外部看门狗（#292 第 3 片）：请求头 x-fleet-watch 和配置里的 FLEET_EDGE_WATCH_ID
// 一致，才给登记表 external-watchdog 记一轮成功。没配、对不上、头缺失：不记，公网响应里不出现编号。
import { registerScheduledJobs, scheduleHealth, scheduleRuns } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { EXTERNAL_WATCH_NOT_WIRED, recordExternalWatchRound } from '../src/external-watch.ts';
import { type Harness, pgHarness, T0 } from './harness.ts';

/** 随机形状的假编号。卫生检查按名字拦密钥，这个常量不能叫 SECRET、TOKEN、PASSWORD、KEY。 */
const WATCH_ID = 'ew-7k3m-q9p2-x4n8-b6c1';
const HEADER = 'x-fleet-watch';
const JOB_ID = 'external-watchdog';

const PROD = {
  FLEET_ENV: 'production',
  FLEET_PUBLIC_URL: 'https://cockpit.example.test',
  FLEET_COCKPIT_LISTEN: 'wg-france:8787',
  FLEET_SESSION_SECRET: 's'.repeat(40),
  FLEET_AGENT_TOKEN_SECRET: 'a'.repeat(40),
  FLEET_GITHUB_WEBHOOK_SECRET: 'w'.repeat(20),
  FEISHU_APP_ID: 'cli_x',
  FEISHU_APP_SECRET: 'y',
  DATABASE_URL: 'postgres://fleet@localhost/fleet',
};

interface HealthPageRow {
  key: string;
  reason: string;
  notWired?: boolean;
}
interface HealthPage {
  judge(fetched: { status: number; body: string }): { rows: HealthPageRow[] };
}
const HEALTH_PAGE = '../../../deploy/web/health/health.js';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let current: Awaited<ReturnType<typeof pgHarness>> | undefined;
afterEach(async () => {
  await current?.stop();
  current = undefined;
});

async function start(options: Parameters<typeof pgHarness>[1] = {}) {
  current = await pgHarness(t, options);
  return current;
}

async function rounds() {
  return t.db.select().from(scheduleRuns).where(eq(scheduleRuns.job, JOB_ID));
}

/** 第 2 片登记的那一行。没这一行，运行记录写不进去（外键）。 */
async function registerJob() {
  await registerScheduledJobs(t.db, [
    { id: JOB_ID, name: '外部看门狗', schedule: '每 5 分钟', expectEveryMinutes: 15 },
  ]);
}

function wired(h: Harness) {
  h.deps.recordExternalWatchRound = () => recordExternalWatchRound(t.db, new Date(T0));
}

describe('外部看门狗来查 /healthz（#292 第 3 片）', () => {
  it('配置从 FLEET_EDGE_WATCH_ID 读：没有、空的、只有空白都是不启用', () => {
    expect(loadConfig(PROD).edgeWatchId).toBeNull();
    expect(loadConfig({ ...PROD, FLEET_EDGE_WATCH_ID: '' }).edgeWatchId).toBeNull();
    expect(loadConfig({ ...PROD, FLEET_EDGE_WATCH_ID: ' \t' }).edgeWatchId).toBeNull();
    expect(loadConfig({ ...PROD, FLEET_EDGE_WATCH_ID: WATCH_ID }).edgeWatchId).toBe(WATCH_ID);
    expect(EXTERNAL_WATCH_NOT_WIRED).toBe('没配外部看门狗（#292）');
  });

  it('头和配置一致：登记表记一轮成功', async () => {
    const h = await start({ config: { edgeWatchId: WATCH_ID } });
    wired(h);
    await registerJob();

    const res = await h.cockpit.request('/healthz', { headers: { [HEADER]: WATCH_ID } });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain(WATCH_ID);
    expect(JSON.parse(text).checks.external_watchdog).toEqual({ ok: true });
    const got = await rounds();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ job: JOB_ID, outcome: 'ok', scanned: 1, found: 0, why: null });
    const listed = (await scheduleHealth(t.db, T0)).find((row) => row.job.id === JOB_ID);
    expect(listed?.status).toBe('ok');
    expect(listed?.lastSuccess?.outcome).toBe('ok');
    expect(JSON.stringify(h.logs)).not.toContain(WATCH_ID);
  });

  it('登记行还没有：对得上头也不把 /healthz 打成 500，响应和日志里都没有编号', async () => {
    const h = await start({ config: { edgeWatchId: WATCH_ID } });
    wired(h);

    const res = await h.cockpit.request('/healthz', { headers: { [HEADER]: WATCH_ID } });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain(WATCH_ID);
    expect(JSON.parse(text).ok).toBe(true);
    expect(await rounds()).toHaveLength(0);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', message: '外部看门狗这一轮没记上' }),
    );
    expect(JSON.stringify(h.logs)).not.toContain(WATCH_ID);
  });

  it('头不一致、或没带头：不记，响应和没带头一样', async () => {
    const h = await start({ config: { edgeWatchId: WATCH_ID } });
    wired(h);
    await registerJob();

    const wrong = await h.cockpit.request('/healthz', { headers: { [HEADER]: `${WATCH_ID}-no` } });
    const wrongText = await wrong.text();
    expect(await rounds()).toHaveLength(0);

    const missing = await h.cockpit.request('/healthz');
    const missingText = await missing.text();
    expect(await rounds()).toHaveLength(0);
    expect(wrong.status).toBe(missing.status);
    expect(wrongText).toBe(missingText);
    expect(wrongText).not.toContain(WATCH_ID);
    expect(missing.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['没这个键', null],
    ['空字符串', ''],
    ['只有空白', ' \t'],
  ] as const)('%s：不记、不报错，健康页写未接，其余项不变，响应里没有编号', async (_label, edgeWatchId) => {
    const h = await start({
      config: { edgeWatchId },
      health: [{ name: 'database', check: async () => '库好' }],
    });
    wired(h);
    await registerJob();

    const res = await h.cockpit.request('/healthz', { headers: { [HEADER]: WATCH_ID } });
    const text = await res.text();
    const body = JSON.parse(text) as {
      ok: boolean;
      checks: Record<string, { ok?: boolean; status?: string; message?: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.database).toEqual({ ok: true, message: '库好' });
    expect(Object.keys(body.checks).filter((name) => name !== 'external_watchdog')).toEqual(['database']);
    const item = body.checks.external_watchdog;
    expect(item).toEqual({ ok: true, status: 'not_wired', message: '没配外部看门狗（#292）' });
    expect(item).not.toEqual({ ok: true });
    expect(await rounds()).toHaveLength(0);
    expect(text).not.toContain(WATCH_ID);
    for (const [name, value] of res.headers) expect(`${name}: ${value}`).not.toContain(WATCH_ID);

    const { judge } = (await import(/* @vite-ignore */ HEALTH_PAGE)) as HealthPage;
    const row = judge({ status: res.status, body: text }).rows.find((r) => r.key === 'external_watchdog');
    expect(row).toMatchObject({ notWired: true, reason: '未接：没配外部看门狗（#292）' });
    expect(row?.reason.startsWith('在线')).toBe(false);
  });
});
