import { describe, expect, it } from 'vitest';
import {
  carpoolSubscription,
  type PoolQuotaResult,
  readAllQuotas,
  readingsFromCarpoolQuota,
} from '../../src/quota/index.ts';
import { blockNetwork, FIXED_NOW, fakeDeps, fakeFetch, fakeFiles, fixtureJson } from './helpers.ts';

blockNetwork();

const ctx = { poolId: 'claude-carpool', readAt: '2026-09-24T19:00:00.000Z' };
const quota = () => fixtureJson('reclaude-carpool-quota-2026-09-25.json') as Record<string, unknown>;
const orgs = () => fixtureJson('reclaude-orgs-2026-09-25.json') as { items: Record<string, unknown>[] };

describe('reclaude 拼车额度（真机回包，编号与邮箱已换成假的）', () => {
  it('拼车成员的 5 小时美元上限收成一个 5h 窗口', () => {
    const out = readingsFromCarpoolQuota(quota(), ctx);
    expect(out.windows).toEqual([
      {
        poolId: 'claude-carpool',
        window: '5h',
        label: 'carpool_5h_usd',
        unit: 'usd',
        used: 9.3835775,
        limit: 80,
        utilization: 9.3835775 / 80,
        resetsAt: '2026-09-25T23:30:00.338Z',
        statusRaw: 'active',
        reading: 'measured',
        readAt: '2026-09-24T19:00:00.000Z',
        source: 'reclaude-carpool',
      },
    ]);
    expect(out.notes.join()).toContain('暂定');
  });

  it('上游明说没设上限：零个窗口，并写明', () => {
    const out = readingsFromCarpoolQuota({ ...quota(), enabled: false }, ctx);
    expect(out.windows).toEqual([]);
    expect(out.notes.join()).toContain('没设');
  });

  it('开没开认不出、金额缺或不是数：bad_response，不填 0', () => {
    const { enabled: _e, ...noEnabled } = quota();
    expect(() => readingsFromCarpoolQuota(noEnabled, ctx)).toThrowError(/enabled/);
    const { used_usd: _u, ...noUsed } = quota();
    expect(() => readingsFromCarpoolQuota(noUsed, ctx)).toThrowError(/金额认不出/);
    expect(() => readingsFromCarpoolQuota({ ...quota(), quota_usd: 'n/a' }, ctx)).toThrowError(/金额认不出/);
    expect(() => readingsFromCarpoolQuota('oops', ctx)).toThrowError(/不是对象/);
  });

  it('到期日取唯一的拼车组织；几个拼车组织就不猜', () => {
    expect(carpoolSubscription(orgs(), FIXED_NOW)).toEqual({
      subscription: { expiresAt: '2026-11-19T02:32:45.859Z' },
      notes: [],
    });
    const two = orgs();
    two.items.push({ ...(two.items[1] as Record<string, unknown>) });
    expect(carpoolSubscription(two, FIXED_NOW).subscription).toBeUndefined();
    expect(carpoolSubscription({}, FIXED_NOW).notes.join()).toContain('认不出');
  });

  it('组织列表说拼车池用不了：没有拼车组织、没分到账号、已到期，都抛 upstream，不当读成了', () => {
    const none = orgs();
    none.items = none.items.filter((o) => o.type !== 'team');
    expect(() => carpoolSubscription(none, FIXED_NOW)).toThrowError(/没有拼车组织/);
    const unassigned = orgs();
    (unassigned.items[1] as Record<string, unknown>).has_assigned_account = false;
    expect(() => carpoolSubscription(unassigned, FIXED_NOW)).toThrowError(/没分到 Claude 账号/);
    expect(() => carpoolSubscription(orgs(), new Date('2026-12-01T00:00:00Z'))).toThrowError(/到期/);
  });
});

describe('reclaude 拼车读取器', () => {
  const keyPath = '/home/tester/.fleet-dao/reclaude-api.key';
  const key = `rck_${'a1B2'.repeat(10)}`;
  const pool = {
    poolId: 'claude-carpool',
    channelId: 'claude-sub',
    reader: 'reclaude-carpool' as const,
    keyFile: '~/.fleet-dao/reclaude-api.key',
  };
  const happy: Parameters<typeof fakeFetch>[0] = (url) =>
    url.endsWith('/api/v1/orgs') ? { body: orgs() } : { body: quota() };

  const run = async (answer: Parameters<typeof fakeFetch>[0], keyText: string | null = `${key}\n`) => {
    const f = fakeFetch(answer);
    const report = await readAllQuotas(
      { pools: [pool] },
      fakeDeps({ fetch: f.fetch, readFile: fakeFiles(keyText === null ? {} : { [keyPath]: keyText }) }),
    );
    return { result: report.results[0] as PoolQuotaResult, calls: f.calls, report };
  };

  it('只读 GET 两个接口，带 Bearer；Key、编号、邮箱一个字都不往外带', async () => {
    const { result, calls, report } = await run(happy);
    expect(result.ok && result.windows.map((w) => w.label)).toEqual(['carpool_5h_usd']);
    expect(result.ok && result.subscription).toEqual({ expiresAt: '2026-11-19T02:32:45.859Z' });
    expect(calls.map((c) => c.url).sort()).toEqual([
      'https://www.reclaude.ai/api/v1/carpool/quota',
      'https://www.reclaude.ai/api/v1/orgs',
    ]);
    for (const c of calls) {
      expect(c.init?.method ?? 'GET').toBe('GET');
      expect(((c.init?.headers ?? {}) as Record<string, string>).Authorization).toBe(`Bearer ${key}`);
    }
    const text = JSON.stringify(report);
    for (const secret of [key, '<邮箱>', '1111', '2222', '3333', '<拼车组织>']) {
      expect(text).not.toContain(secret);
    }
  });

  it('组织接口 5xx 只记说明；任一接口 401 都算 Key 失效；组织列表说池用不了就整池失败', async () => {
    const orgsOnly = (answer: ReturnType<Parameters<typeof fakeFetch>[0]>) =>
      run((url, init) => (url.endsWith('/api/v1/orgs') ? answer : happy(url, init)));
    const partial = await orgsOnly({ status: 500, body: 'x' });
    expect(partial.result.ok).toBe(true);
    expect(partial.result.notes.join()).toContain('到期日没读到');
    for (const r of [
      (await run(() => ({ status: 401, body: { code: 'client.unauthorized' } }))).result,
      (await orgsOnly({ status: 401, body: {} })).result,
    ]) {
      expect(!r.ok && r.error.code).toBe('auth');
      expect(!r.ok && r.error.message).toContain('重新生成');
    }
    const unassigned = orgs();
    (unassigned.items[1] as Record<string, unknown>).has_assigned_account = false;
    const blocked = (await orgsOnly({ body: unassigned })).result;
    expect(!blocked.ok && blocked.error.code).toBe('upstream');
  });

  it('读不到的每条路都给明确失败：没 Key 文件、文件里不是 Key、上游 5xx、连不上、回包认不出', async () => {
    const code = (r: PoolQuotaResult) => (r.ok ? 'ok' : r.error.code);
    const none = await run(happy, null);
    expect(code(none.result)).toBe('no_credentials');
    expect(none.calls).toHaveLength(0);
    // 网页上「下载 .txt」存下来的是带说明的整页，不是 Key 本身。
    expect(code((await run(happy, `Reclaude API key\n${key}\n`)).result)).toBe('no_credentials');
    expect(code((await run(happy, '')).result)).toBe('no_credentials');
    expect(code((await run(() => ({ status: 503, body: 'down' }))).result)).toBe('upstream');
    expect(code((await run(() => new TypeError('fetch failed'))).result)).toBe('unreachable');
    expect(code((await run(() => ({ body: { items: [] } }))).result)).toBe('bad_response');
  });
});
