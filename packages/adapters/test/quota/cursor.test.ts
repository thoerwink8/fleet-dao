import { describe, expect, it } from 'vitest';
import {
  type PoolQuotaResult,
  readAllQuotas,
  readingsFromPeriodUsage,
  windowsForModel,
} from '../../src/quota/index.ts';
import { blockNetwork, fakeDeps, fakeFetch, fakeFiles, fixtureJson } from './helpers.ts';

blockNetwork();

const ctx = { poolId: 'cursor', readAt: '2026-09-24T19:00:00.000Z' };
const period = () => fixtureJson('cursor-period-usage-2026-09-24.json');

describe('Cursor Dashboard：账期用量（VPS 真机回包）', () => {
  it('账期美元 + Auto 桶 + API 桶，各一行；清零时刻 = 账期结束', () => {
    const out = readingsFromPeriodUsage(period(), ctx);
    expect(out.windows).toEqual([
      expect.objectContaining({
        label: 'plan_usd',
        window: 'month_usd',
        unit: 'usd',
        used: 222.81,
        limit: 400,
        resetsAt: '2026-10-16T19:08:36.000Z',
        reading: 'measured',
        source: 'cursor-dashboard',
      }),
      expect.objectContaining({
        label: 'auto_percent',
        window: 'other',
        scope: 'auto',
        used: 7.4270000000000005,
      }),
      expect.objectContaining({ label: 'api_percent', window: 'other', scope: 'api', used: 0, limit: 100 }),
    ]);
    expect(out.periodEnd).toBe('2026-10-16T19:08:36.000Z');
  });

  it('totalPercentUsed 是合成数，不单独当窗口', () => {
    expect(readingsFromPeriodUsage(period(), ctx).windows.some((w) => w.label.startsWith('total'))).toBe(
      false,
    );
  });

  it('Auto 桶的成员表来自接口：composer 只看 Auto 桶，点名的其它模型只看 API 桶', () => {
    const out = readingsFromPeriodUsage(period(), ctx);
    const labels = (model: string) =>
      windowsForModel(out.windows, { id: model }, out.scopeModels).map((w) => w.label);
    expect(labels('composer-2.5')).toEqual(['plan_usd', 'auto_percent']);
    expect(labels('kimi-k3')).toEqual(['plan_usd', 'api_percent']);
  });

  it('以后多出来的桶照收（xxxPercentUsed）', () => {
    const body = period() as { planUsage: Record<string, unknown> };
    body.planUsage.bonusPercentUsed = 12;
    const out = readingsFromPeriodUsage(body, ctx);
    expect(out.windows.find((w) => w.label === 'bonus_percent')).toMatchObject({ scope: 'bonus', used: 12 });
  });

  it('按需付费一栏出现没核实过的字段：只点名，不猜成窗口', () => {
    const body = period() as Record<string, unknown>;
    body.spendLimitUsage = { limitType: 'user', individualLimit: 5000 };
    const out = readingsFromPeriodUsage(body, ctx);
    expect(out.windows).toHaveLength(3);
    expect(out.notes.join()).toContain('individualLimit');
  });

  it('上游改了字段名、一个窗口都认不出：bad_response，不许报「0 个窗口」让调度当成不限额', () => {
    const renamed = {
      billingCycleEnd: '1792177716000',
      planUsage: { spendCents: 39000, capCents: 40000, autoUsagePct: 97, apiUsagePct: 99 },
    };
    expect(() => readingsFromPeriodUsage(renamed, ctx)).toThrowError(/一个额度窗口都认不出/);
    expect(() => readingsFromPeriodUsage({ billingCycleEnd: '1' }, ctx)).toThrowError(/没有 planUsage/);
  });

  it('只剩账期美元、桶的百分比找不到：照收，但写明按桶卡不住', () => {
    const body = period() as { planUsage: Record<string, unknown> };
    delete body.planUsage.autoPercentUsed;
    delete body.planUsage.apiPercentUsed;
    const out = readingsFromPeriodUsage(body, ctx);
    expect(out.windows.map((w) => w.label)).toEqual(['plan_usd']);
    expect(out.notes.join()).toContain('按桶卡不住');
  });
});

describe('Cursor 读取器', () => {
  const pool = { poolId: 'cursor', channelId: 'cursor', reader: 'cursor-dashboard' as const };
  const authPath = '/home/tester/.config/cursor/auth.json';
  const auth = JSON.stringify({ accessToken: 'cursor-access-token', refreshToken: 'cursor-refresh-token' });

  const run = async (
    answer: Parameters<typeof fakeFetch>[0],
    files: Record<string, string> = { [authPath]: auth },
  ) => {
    const f = fakeFetch(answer);
    const report = await readAllQuotas(
      { pools: [pool] },
      fakeDeps({ fetch: f.fetch, readFile: fakeFiles(files) }),
    );
    return { result: report.results[0] as PoolQuotaResult, calls: f.calls, report };
  };
  const happy: Parameters<typeof fakeFetch>[0] = (url) =>
    url.endsWith('GetCurrentPeriodUsage')
      ? { body: period() }
      : url.endsWith('GetPlanInfo')
        ? { body: fixtureJson('cursor-plan-info.json') }
        : { body: { noUsageBasedAllowed: true } };

  it('只 POST 白名单里的只读方法，带登录令牌；套餐名与「不允许按量」进补充信息', async () => {
    const { result, calls, report } = await run(happy);
    expect(result.ok).toBe(true);
    expect(
      calls.map((c) => c.url.replace('https://api2.cursor.sh/aiserver.v1.DashboardService/', '')).sort(),
    ).toEqual(['GetCurrentPeriodUsage', 'GetHardLimit', 'GetPlanInfo']);
    for (const c of calls) {
      expect(c.init?.method).toBe('POST');
      expect(c.init?.body).toBe('{}');
      expect(((c.init?.headers ?? {}) as Record<string, string>).Authorization).toBe(
        'Bearer cursor-access-token',
      );
    }
    expect(result.ok && result.subscription).toEqual({
      plan: 'Ultra（$200/mo）',
      expiresAt: '2026-10-16T19:08:36.000Z',
    });
    expect(result.notes).toContain('账号不允许按量计费：超出套餐不会自动扣钱');
    expect(JSON.stringify(report)).not.toContain('cursor-access-token');
    expect(JSON.stringify(report)).not.toContain('<账号主人>');
  });

  it('套餐名读不到只记一笔说明，不算失败', async () => {
    const { result } = await run((url, init) =>
      url.endsWith('GetPlanInfo') ? { status: 500, body: 'x' } : happy(url, init),
    );
    expect(result.ok).toBe(true);
    expect(result.notes.join()).toContain('套餐名没读到');
  });

  it('401：要重新登录（auth）；连不上：unreachable；没有登录文件：no_credentials', async () => {
    const code = (r: PoolQuotaResult) => (r.ok ? 'ok' : r.error.code);
    expect(code((await run(() => ({ status: 401, body: {} }))).result)).toBe('auth');
    expect(code((await run(() => new TypeError('fetch failed'))).result)).toBe('unreachable');
    expect(code((await run(happy, {})).result)).toBe('no_credentials');
    expect(code((await run(happy, { [authPath]: '{"refreshToken":"x"}' })).result)).toBe('no_credentials');
    expect(code((await run(happy, { [authPath]: 'not json' })).result)).toBe('no_credentials');
    expect(code((await run(() => ({ status: 502, body: 'bad gateway' }))).result)).toBe('upstream');
    expect(code((await run(() => ({ body: '<html>login</html>' }))).result)).toBe('bad_response');
  });
});

describe('Cursor 读取器：API 密钥优先，被拒或读不到退回登录令牌', () => {
  const keyPath = '/home/tester/.cursor/fleet-api-key';
  const authPath = '/home/tester/.config/cursor/auth.json';
  const pool = {
    poolId: 'cursor',
    channelId: 'cursor',
    reader: 'cursor-dashboard' as const,
    keyFile: keyPath,
  };
  const KEY = 'k-placeholder-key';
  const TOKEN = 'cursor-access-token';
  const files = {
    [keyPath]: `${KEY}\n`,
    [authPath]: JSON.stringify({ accessToken: TOKEN }),
  };
  const happyBody = (url: string) =>
    url.endsWith('GetCurrentPeriodUsage')
      ? { body: period() }
      : url.endsWith('GetPlanInfo')
        ? { body: fixtureJson('cursor-plan-info.json') }
        : { body: { noUsageBasedAllowed: true } };
  const bearer = (c: { init?: RequestInit | undefined }) =>
    ((c.init?.headers ?? {}) as Record<string, string>).Authorization;

  const run = async (answer: Parameters<typeof fakeFetch>[0], fileSet: Record<string, string> = files) => {
    const f = fakeFetch(answer);
    const report = await readAllQuotas(
      { pools: [pool] },
      fakeDeps({ fetch: f.fetch, readFile: fakeFiles(fileSet) }),
    );
    return { result: report.results[0] as PoolQuotaResult, calls: f.calls, report };
  };

  it('密钥可用时三个调用都用密钥，不碰登录令牌', async () => {
    const { result, calls } = await run((url) => happyBody(url));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(bearer(c)).toBe(`Bearer ${KEY}`);
  });

  it('密钥 401：退回登录令牌，后面的调用也用登录令牌', async () => {
    const { result, calls } = await run((url, init) =>
      bearer({ init }) === `Bearer ${KEY}` ? { status: 401, body: {} } : happyBody(url),
    );
    expect(result.ok).toBe(true);
    expect(calls.map(bearer)).toEqual([
      `Bearer ${KEY}`,
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
    ]);
  });

  it('两个都 401：报 auth，原因写明两个来源各是什么结果，不含密钥内容', async () => {
    const { result, report } = await run(() => ({ status: 401, body: {} }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('auth');
    expect(result.error.message).toContain(`API 密钥（${keyPath}）被拒：HTTP 401`);
    expect(result.error.message).toContain(`登录令牌（${authPath}）被拒：HTTP 401`);
    const dump = JSON.stringify(report);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain(TOKEN);
  });

  it('密钥文件读不到：退回登录令牌；密钥文件是空的也一样', async () => {
    const missing = await run((url) => happyBody(url), { [authPath]: files[authPath] });
    expect(missing.result.ok).toBe(true);
    expect(missing.calls.map(bearer)).toEqual(Array(3).fill(`Bearer ${TOKEN}`));
    const blank = await run((url) => happyBody(url), { ...files, [keyPath]: '  \n' });
    expect(blank.result.ok).toBe(true);
    expect(blank.calls.map(bearer)).toEqual(Array(3).fill(`Bearer ${TOKEN}`));
  });

  it('密钥被拒、登录文件读不到：仍是 auth（不是 no_credentials），原因里两边都写', async () => {
    const { result } = await run(() => ({ status: 403, body: {} }), { [keyPath]: files[keyPath] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('auth');
    expect(result.error.message).toContain('被拒：HTTP 403');
    expect(result.error.message).toContain('读不到：ENOENT');
  });

  it('密钥不是凭据问题的失败（502）不退回登录令牌，原样报 upstream', async () => {
    const { result, calls } = await run(() => ({ status: 502, body: 'bad gateway' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('upstream');
    expect(calls.every((c) => bearer(c) === `Bearer ${KEY}`)).toBe(true);
  });

  it('故意造出失败：两个文件都读不到 → no_credentials，原因里两个来源都写，没发过一次请求', async () => {
    const { result, calls } = await run((url) => happyBody(url), {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('no_credentials');
    expect(result.error.message).toContain(`API 密钥（${keyPath}）读不到：ENOENT`);
    expect(result.error.message).toContain(`登录令牌（${authPath}）读不到：ENOENT`);
    expect(calls).toHaveLength(0);
  });
});
