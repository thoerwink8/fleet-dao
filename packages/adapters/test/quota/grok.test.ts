import { describe, expect, it } from 'vitest';
import { type PoolQuotaResult, readAllQuotas, readingsFromGrokBilling } from '../../src/quota/index.ts';
import { blockNetwork, FIXED_NOW, fakeDeps, fakeFetch, fakeFiles, fixtureJson } from './helpers.ts';

blockNetwork();

const ctx = { poolId: 'grok', readAt: '2026-09-24T19:00:00.000Z' };
const billing = () => fixtureJson('grok-billing-2026-09-24.json');

describe('Grok Build 账单（VPS 真机回包）', () => {
  it('这一期的总用量收成一个周窗口，清零时刻 = 本期结束', () => {
    const out = readingsFromGrokBilling(billing(), ctx);
    expect(out.windows).toEqual([
      {
        poolId: 'grok',
        window: '7d',
        label: 'credits:weekly',
        unit: 'percent',
        used: 47,
        limit: 100,
        utilization: 0.47,
        resetsAt: '2026-09-27T18:24:24.441Z',
        reading: 'measured',
        readAt: '2026-09-24T19:00:00.000Z',
        source: 'grok-billing',
      },
    ]);
    expect(out.notes).toContain('分产品：GrokBuild 47%');
    expect(out.notes).toContain('按需付费上限为 0：超出套餐不会自动扣钱');
  });

  it('没见过的账期类型：窗口归 other 原样收，并写明', () => {
    const body = billing() as { config: { currentPeriod: { type: string } } };
    body.config.currentPeriod.type = 'USAGE_PERIOD_TYPE_MONTHLY';
    const out = readingsFromGrokBilling(body, ctx);
    expect(out.windows[0]).toMatchObject({ window: 'other', label: 'credits:monthly' });
    expect(out.notes.join()).toContain('没见过');
  });

  it('缺总用量：bad_response，不填 0', () => {
    const body = billing() as { config: Record<string, unknown> };
    delete body.config.creditUsagePercent;
    expect(() => readingsFromGrokBilling(body, ctx)).toThrowError(/creditUsagePercent/);
  });
});

describe('Grok 读取器', () => {
  const pool = { poolId: 'grok', channelId: 'xai', reader: 'grok-billing' as const };
  const authPath = '/home/tester/.grok/auth.json';
  const authFile = (expiresAt: string) =>
    JSON.stringify({
      'https://auth.x.ai::client': {
        key: 'grok-access-token',
        refresh_token: 'grok-refresh-token',
        expires_at: expiresAt,
        auth_mode: 'oidc',
      },
    });
  const valid = authFile(new Date(FIXED_NOW.getTime() + 3_600_000).toISOString());
  const happy: Parameters<typeof fakeFetch>[0] = (url) =>
    url.includes('/billing') ? { body: billing() } : { body: fixtureJson('grok-user.json') };

  const run = async (answer: Parameters<typeof fakeFetch>[0], auth = valid) => {
    const f = fakeFetch(answer);
    const report = await readAllQuotas(
      { pools: [pool] },
      fakeDeps({ fetch: f.fetch, readFile: fakeFiles({ [authPath]: auth }) }),
    );
    return { result: report.results[0] as PoolQuotaResult, calls: f.calls, report };
  };

  it('只读 GET 账单与订阅档位；订阅回包里的身份信息一个字都不往外带', async () => {
    const { result, calls, report } = await run(happy);
    expect(result.ok && result.windows.map((w) => w.label)).toEqual(['credits:weekly']);
    expect(result.ok && result.subscription).toEqual({ plan: 'SuperGrokPro' });
    expect(calls.map((c) => c.url)).toEqual([
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      'https://cli-chat-proxy.grok.com/v1/user?include=subscription',
    ]);
    for (const c of calls) {
      expect(c.init?.method ?? 'GET').toBe('GET');
      expect(((c.init?.headers ?? {}) as Record<string, string>).Authorization).toBe(
        'Bearer grok-access-token',
      );
    }
    const text = JSON.stringify(report);
    for (const secret of ['grok-access-token', 'grok-refresh-token', '<邮箱>', '<用户编号>']) {
      expect(text).not.toContain(secret);
    }
  });

  it('令牌过期：报 auth，不自己续期，一次请求都不发', async () => {
    const { result, calls } = await run(happy, authFile(new Date(FIXED_NOW.getTime() - 1000).toISOString()));
    expect(!result.ok && result.error.code).toBe('auth');
    expect(!result.ok && result.error.message).toContain('不自己续期');
    expect(calls).toHaveLength(0);
  });

  it('订阅档位读不到只记说明；账单 401 才算要重新登录', async () => {
    const partial = await run((url, init) =>
      url.includes('/user') ? { status: 500, body: 'x' } : happy(url, init),
    );
    expect(partial.result.ok).toBe(true);
    expect(partial.result.notes.join()).toContain('订阅档位没读到');
    const denied = await run(() => ({ status: 401, body: {} }));
    expect(!denied.result.ok && denied.result.error.code).toBe('auth');
  });
});
