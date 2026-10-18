// Grok 账单结构不认识时，沿真实 quota-read 接线保留 unknown：失败轮次不写旧额度、不推进最近读成，
// 恢复后才写新读数并撤同一条 quota-read:grok 提醒。
import { type QuotaConfig, type QuotaDeps, readAllQuotas } from '@fleet-dao/adapters/quota';
import { alertByKey, registerScheduledJobs, seed } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QUOTA_READ_JOB, runQuotaReadJob } from '../../src/jobs/quota-read.ts';
import { quotaReadJob } from '../../src/real/quota-read.ts';

const AUTH_PATH = '/home/tester/.grok/auth.json';
const ACCESS_TOKEN = 'access-token-for-test';
const START = new Date('2026-10-19T20:00:00.000Z');

const config: QuotaConfig = {
  pools: [
    {
      poolId: 'grok',
      channelId: 'grok-subscription',
      name: 'Grok',
      reader: 'grok-billing',
      authFile: AUTH_PATH,
    },
  ],
};

const billing = (percent: number): Record<string, unknown> => ({
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-10-19T18:24:24.441496+00:00',
      end: '2026-10-26T18:24:24.441496+00:00',
    },
    creditUsagePercent: percent,
  },
});

const invalidObservedBillingShape = (): Record<string, unknown> => ({
  // 脱敏的结构夹具：config 仍存在，但总用量字段类型不支持数字读取。
  // 它只验证未知结构的处理，不宣称这是已核实的上游新协议。
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' },
    creditUsagePercent: { value: 47 },
  },
});

function quotaDeps(now: () => Date, body: () => unknown): QuotaDeps {
  const io: QuotaDeps = {
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.includes('/billing') ? body() : { subscriptionTier: 'SuperGrok' };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch,
    runCommand: async () => {
      throw new Error('测试不应起命令');
    },
    readFile: async (path) => {
      if (path !== AUTH_PATH) throw new Error(`测试不应读 ${path}`);
      return JSON.stringify({
        default: { key: ACCESS_TOKEN, expires_at: '2099-01-01T00:00:00.000Z' },
      });
    },
    listDir: async () => [],
    openWebSocket: () => {
      throw new Error('测试不应开 WebSocket');
    },
    workDir: async () => '/nowhere',
    homeDir: '/home/tester',
    env: {},
    now,
  };
  return io;
}

const poolRow = async (t: TestDb) => {
  const result = await t.client.query<{ last_read_ok_at: string | null }>(
    'select last_read_ok_at from pools where id = $1',
    ['grok'],
  );
  const value = result.rows[0]?.last_read_ok_at;
  return value === null || value === undefined ? null : new Date(value);
};

describe('真实 quota-read 接线：Grok 账单结构 unknown 不冒充额度', () => {
  let t: TestDb;
  let now = new Date(START);
  let body: unknown = billing(47);

  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetTestDb(t);
    await seed(t.db);
    await t.client.exec(
      "insert into pools (id, channel_id, max_concurrency) values ('grok', 'grok-subscription', 6)",
    );
    await registerScheduledJobs(t.db, [QUOTA_READ_JOB]);
    now = new Date(START);
    body = billing(47);
  });

  const run = () =>
    runQuotaReadJob(
      quotaReadJob({
        db: t.db,
        now: () => now,
        loadConfig: async () => config,
        quotaDeps: quotaDeps(
          () => now,
          () => body,
        ),
      })(),
    );

  it('失败轮次保留旧窗口、lastReadOkAt 和 quota-read:grok；随后成功轮次才更新并 resolve', async () => {
    await expect(run()).resolves.toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });
    const beforeFailure = await poolRow(t);
    const oldWindows = await t.client.query('select * from quota_windows where pool_id = $1 order by label', [
      'grok',
    ]);
    expect(beforeFailure).toEqual(START);
    expect(oldWindows.rows).toHaveLength(1);
    expect(oldWindows.rows[0]?.used).toBe(47);

    now = new Date(START.getTime() + 15 * 60_000);
    body = invalidObservedBillingShape();
    const failed = await run();
    expect(failed).toMatchObject({ outcome: 'partial', scanned: 1, found: 1 });
    expect(failed.why).toContain('类型 object');
    expect(failed.why).toContain('config.creditUsagePercent');
    expect(failed.why).not.toContain('47');

    const afterFailure = await poolRow(t);
    expect(afterFailure).toEqual(beforeFailure);
    const windowsAfterFailure = await t.client.query(
      'select * from quota_windows where pool_id = $1 order by label',
      ['grok'],
    );
    expect(windowsAfterFailure.rows).toEqual(oldWindows.rows);
    const open = await alertByKey(t.db, 'quota-read:grok');
    expect(open?.resolvedAt).toBeNull();
    expect(open?.body).toContain('bad_response');
    expect(open?.body).toContain('config.creditUsagePercent');
    expect(JSON.stringify(open)).not.toContain(ACCESS_TOKEN);

    const runsAfterFailure = await t.client.query<{ outcome: string }>(
      'select outcome from schedule_runs where job = $1 order by id',
      ['quota-read'],
    );
    expect(runsAfterFailure.rows.map((r) => r.outcome)).toEqual(['ok', 'partial']);

    now = new Date(START.getTime() + 30 * 60_000);
    body = billing(63);
    await expect(run()).resolves.toMatchObject({ outcome: 'ok', scanned: 1, found: 0 });

    const afterRecovery = await poolRow(t);
    expect(afterRecovery).toEqual(now);
    const newWindows = await t.client.query<{ used: number }>(
      'select used from quota_windows where pool_id = $1 order by label',
      ['grok'],
    );
    expect(newWindows.rows).toHaveLength(1);
    expect(newWindows.rows[0]?.used).toBe(63);

    const resolved = await alertByKey(t.db, 'quota-read:grok');
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(resolved?.resolvedBy).toBe('engine');
    const allRuns = await t.client.query<{ outcome: string }>(
      'select outcome from schedule_runs where job = $1 order by id',
      ['quota-read'],
    );
    expect(allRuns.rows.map((r) => r.outcome)).toEqual(['ok', 'partial', 'ok']);
  });

  it('unknown 账单结构仍返回 bad_response，不生成任何窗口', async () => {
    body = { config: { usagePercent: 47 } };
    const report = await readAllQuotas(
      config,
      quotaDeps(
        () => now,
        () => body,
      ),
    );
    const result = report.results[0];
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'bad_response' },
    });
    expect(result && !result.ok && result.error.message).toContain('config.creditUsagePercent');
    expect(result && !result.ok && 'windows' in result).toBe(false);
  });
});
