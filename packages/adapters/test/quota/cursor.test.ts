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

describe('Cursor 读取器：令牌被拒时刷新一次再读', () => {
  const authPath = '/home/tester/.config/cursor/auth.json';
  const pool = { poolId: 'cursor', channelId: 'cursor', reader: 'cursor-dashboard' as const };
  const STALE = 'stale-access-token';
  const FRESH = 'fresh-access-token';
  const authWith = (token: string) => JSON.stringify({ accessToken: token });
  const happyBody = (url: string) =>
    url.endsWith('GetCurrentPeriodUsage')
      ? { body: period() }
      : url.endsWith('GetPlanInfo')
        ? { body: fixtureJson('cursor-plan-info.json') }
        : { body: { noUsageBasedAllowed: true } };
  const bearer = (c: { init?: RequestInit | undefined }) =>
    ((c.init?.headers ?? {}) as Record<string, string>).Authorization;

  /**
   * 登录文件在内存里；refresh 是假的刷新端口，记次数，成功时把文件换成新令牌（像 cursor-agent status 那样重写 auth.json）。
   * 上游只认 FRESH。
   */
  const setup = (
    refresh: 'ok' | 'ok-but-unchanged' | Error | undefined,
    pools: (typeof pool)[] = [pool],
    initial = STALE,
  ) => {
    const files: Record<string, string> = { [authPath]: authWith(initial) };
    let refreshes = 0;
    const f = fakeFetch((url, init) =>
      bearer({ init }) === `Bearer ${FRESH}` ? happyBody(url) : { status: 401, body: {} },
    );
    const refreshCursorLogin =
      refresh === undefined
        ? undefined
        : async () => {
            refreshes++;
            if (refresh instanceof Error) throw refresh;
            if (refresh === 'ok') files[authPath] = authWith(FRESH);
          };
    const run = async () => {
      const report = await readAllQuotas(
        { pools },
        fakeDeps({
          fetch: f.fetch,
          readFile: fakeFiles(files),
          asUser: {
            readers: ['cursor-dashboard'],
            readFile: async (p) => fakeFiles(files)(p),
            homeDir: '/home/tester',
            ...(refreshCursorLogin ? { refreshCursorLogin } : {}),
          },
        }),
      );
      return report;
    };
    return { run, calls: f.calls, refreshes: () => refreshes, files };
  };
  const first = (r: { results: PoolQuotaResult[] }) => r.results[0] as PoolQuotaResult;

  it('令牌有效：直接读成，不刷新', async () => {
    const t = setup('ok', [pool], FRESH);
    const result = first(await t.run());
    expect(result.ok).toBe(true);
    expect(t.refreshes()).toBe(0);
    expect(t.calls.map(bearer)).toEqual(Array(3).fill(`Bearer ${FRESH}`));
  });

  it('令牌被拒：刷新一次、重读登录文件、再调一次就读成；后面的调用都用新令牌', async () => {
    const t = setup('ok');
    const report = await t.run();
    expect(first(report).ok).toBe(true);
    expect(t.refreshes()).toBe(1);
    expect(t.calls.map(bearer)).toEqual([
      `Bearer ${STALE}`,
      `Bearer ${FRESH}`,
      `Bearer ${FRESH}`,
      `Bearer ${FRESH}`,
    ]);
    expect(JSON.stringify(report)).not.toContain(STALE);
    expect(JSON.stringify(report)).not.toContain(FRESH);
  });

  it('刷新后仍被拒：报 auth，原因写明刷新过一次仍被拒、要人在这台机器上 cursor-agent login；只刷新了一次', async () => {
    const t = setup('ok-but-unchanged');
    const result = first(await t.run());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('auth');
    expect(result.error.message).toContain(`登录令牌（${authPath}）被拒：HTTP 401`);
    expect(result.error.message).toContain('刷新过一次仍被拒');
    expect(result.error.message).toContain('要人在这台机器上 cursor-agent login');
    expect(t.refreshes()).toBe(1);
    expect(t.calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(STALE);
  });

  it('刷新命令失败：报 auth 并写出刷新失败的原因，不当成没事、不再调上游', async () => {
    const t = setup(new Error('cursor-agent status 退出 1：Not logged in'));
    const result = first(await t.run());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('auth');
    expect(result.error.message).toContain('刷新令牌的命令（cursor-agent status）也没跑成');
    expect(result.error.message).toContain('Not logged in');
    expect(t.refreshes()).toBe(1);
    expect(t.calls).toHaveLength(1);
  });

  it('刷新后登录文件读不到：报 no_credentials，写明是刷新后重读', async () => {
    const files: Record<string, string> = { [authPath]: authWith(STALE) };
    const f = fakeFetch(() => ({ status: 401, body: {} }));
    const report = await readAllQuotas(
      { pools: [pool] },
      fakeDeps({
        fetch: f.fetch,
        readFile: fakeFiles(files),
        asUser: {
          readers: ['cursor-dashboard'],
          readFile: fakeFiles(files),
          homeDir: '/home/tester',
          refreshCursorLogin: async () => {
            delete files[authPath];
          },
        },
      }),
    );
    const result = first(report);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('no_credentials');
    expect(result.error.message).toContain('刷新后重读');
    expect(result.error.message).toContain('读不到：ENOENT');
  });

  it('引擎没接刷新手段：被拒就直接报 auth，原因说明没有刷新手段', async () => {
    const t = setup(undefined);
    const result = first(await t.run());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('auth');
    expect(result.error.message).toContain('没有刷新手段');
    expect(t.calls).toHaveLength(1);
  });

  it('不是凭据问题的失败（502）不刷新，原样报 upstream', async () => {
    const files: Record<string, string> = { [authPath]: authWith(STALE) };
    let refreshes = 0;
    const f = fakeFetch(() => ({ status: 502, body: 'bad gateway' }));
    const report = await readAllQuotas(
      { pools: [pool] },
      fakeDeps({
        fetch: f.fetch,
        readFile: fakeFiles(files),
        asUser: {
          readers: ['cursor-dashboard'],
          readFile: fakeFiles(files),
          homeDir: '/home/tester',
          refreshCursorLogin: async () => {
            refreshes++;
          },
        },
      }),
    );
    const result = first(report);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('upstream');
    expect(refreshes).toBe(0);
  });

  it('同一轮两个 Cursor 池都被拒：只刷新一次，两个池都读成', async () => {
    const t = setup('ok', [pool, { ...pool, poolId: 'cursor-2' }]);
    const report = await t.run();
    expect(report.results.every((r) => r.ok)).toBe(true);
    expect(t.refreshes()).toBe(1);
  });

  it('故意造出失败：刷新后读到的还是旧令牌 → 报 auth（登录失效），不当成读成', async () => {
    const t = setup('ok-but-unchanged', [pool, { ...pool, poolId: 'cursor-2' }]);
    const report = await t.run();
    expect(report.results.every((r) => !r.ok)).toBe(true);
    for (const r of report.results) {
      if (!r.ok) {
        expect(r.error.code).toBe('auth');
        expect(r.error.message).toContain('刷新过一次仍被拒');
      }
    }
    expect(t.refreshes()).toBe(1);
  });
});
