// 每个读取器的回包契约（#3592）：录下的真机回包断言读数；上游改了字段名的回包（*-renamed）必须报
// bad_response 带原因，不许收成「零个窗口」或 0——否则用满的池会被当成不限额。
import { describe, expect, it } from 'vitest';
import {
  carpoolSubscription,
  findUsageReport,
  type QuotaErrorCode,
  readAllQuotas,
  readingsFromCarpoolQuota,
  readingsFromGrokBilling,
  readingsFromPeriodUsage,
  readingsFromRelayFrame,
  readingsFromUsageReport,
} from '../../src/quota/index.ts';
import { blockNetwork, fakeDeps, fixture, fixtureJson } from './helpers.ts';

blockNetwork();

const readAt = '2026-09-24T19:00:00.000Z';

/** 解析函数抛出的 QuotaReadError 的码和原因；没抛就返回 undefined。 */
function failure(parse: () => unknown): { code: QuotaErrorCode; message: string } | undefined {
  try {
    parse();
  } catch (e) {
    const { code, message } = e as { code: QuotaErrorCode; message: string };
    return { code, message };
  }
  return undefined;
}

describe('读取器回包夹具：认得的格式读出数字', () => {
  it('claude-usage：5h 2%、7d 12%', () => {
    const report = findUsageReport(fixture('claude-usage-2026-09-24.ndjson'));
    const { windows } = readingsFromUsageReport(report ?? {}, { poolId: 'claude-solo', readAt });
    expect(windows.map((w) => [w.window, w.used])).toEqual([
      ['5h', 2],
      ['7d', 12],
      ['7d_model', 0],
    ]);
  });

  it('cursor-dashboard：账期 222.81/400 美元', () => {
    const { windows } = readingsFromPeriodUsage(fixtureJson('cursor-period-usage-2026-09-24.json'), {
      poolId: 'cursor',
      readAt,
    });
    expect(windows[0]).toMatchObject({ label: 'plan_usd', used: 222.81, limit: 400 });
  });

  it('grok-billing：周窗口 47%', () => {
    const { windows } = readingsFromGrokBilling(fixtureJson('grok-billing-2026-09-24.json'), {
      poolId: 'grok',
      readAt,
    });
    expect(windows).toMatchObject([{ window: '7d', used: 47, limit: 100 }]);
  });

  it('reclaude-carpool：5h 9.38/80 美元', () => {
    const body = fixtureJson('reclaude-carpool-quota-2026-09-25.json');
    const { windows } = readingsFromCarpoolQuota(body, { poolId: 'claude-carpool', readAt });
    expect(windows).toMatchObject([{ window: '5h', used: 9.3835775, limit: 80 }]);
    expect(carpoolSubscription).toBeTypeOf('function');
  });

  it('mirasim-relay：四个窗口，5h 的 used 是点数', () => {
    const { windows } = readingsFromRelayFrame(fixtureJson('mirasim-relay-2026-09-24.json'), {
      poolId: 'mirasim-relay',
      fetchedAt: readAt,
    });
    expect(windows.map((w) => w.label)).toEqual(['5h', '7d', '7d_claude', '7d_fable']);
    expect(windows[0]).toMatchObject({ used: 1140.30619063, limit: 143528 });
  });
});

describe('读取器回包夹具：上游改了字段名 → bad_response 带原因，不写 0', () => {
  it('claude-usage：limits 里的字段全换名', () => {
    const renamed = fixture('claude-usage-2026-09-24.ndjson')
      .replaceAll('"kind":', '"type":')
      .replaceAll('"percent":', '"used_percent":');
    const report = findUsageReport(renamed);
    expect(report).toBeDefined();
    const f = failure(() => readingsFromUsageReport(report ?? {}, { poolId: 'claude-solo', readAt }));
    expect(f).toMatchObject({ code: 'bad_response' });
    expect(f?.message).toContain('一行都认不出');
  });

  it('cursor-dashboard', () => {
    const f = failure(() =>
      readingsFromPeriodUsage(fixtureJson('cursor-period-usage-renamed.json'), { poolId: 'cursor', readAt }),
    );
    expect(f).toMatchObject({ code: 'bad_response' });
    expect(f?.message).toContain('一个额度窗口都认不出');
  });

  it('grok-billing', () => {
    const f = failure(() =>
      readingsFromGrokBilling(fixtureJson('grok-billing-renamed.json'), { poolId: 'grok', readAt }),
    );
    expect(f).toMatchObject({ code: 'bad_response' });
    expect(f?.message).not.toBe('');
  });

  it('reclaude-carpool', () => {
    const f = failure(() =>
      readingsFromCarpoolQuota(fixtureJson('reclaude-carpool-quota-renamed.json'), {
        poolId: 'claude-carpool',
        readAt,
      }),
    );
    expect(f).toMatchObject({ code: 'bad_response' });
    expect(f?.message).toContain('金额认不出');
  });

  it('mirasim-relay', () => {
    const f = failure(() =>
      readingsFromRelayFrame(fixtureJson('mirasim-relay-renamed.json'), {
        poolId: 'mirasim-relay',
        fetchedAt: readAt,
      }),
    );
    expect(f).toMatchObject({ code: 'bad_response' });
    expect(f?.message).toContain('认不出');
  });

  it('estimate：日账文件缺 tokens 字段 → bad_response（经读取层，不当 0 用量）', async () => {
    const report = await readAllQuotas(
      {
        pools: [
          {
            poolId: 'jev',
            channelId: 'jev',
            reader: 'estimate',
            windows: [
              {
                label: 'day_usd',
                window: 'period_usd',
                unit: 'usd',
                periodHours: 24,
                anchor: '2026-01-01T00:00:00.000Z',
                limit: 0.3,
              },
            ],
            usage: { type: 'daily-token-files', dir: '/srv/ledger/judge-spend', usdPerMTok: 0.042 },
          },
        ],
      } as never,
      fakeDeps({ listDir: async () => ['2026-09-24.json'], readFile: async () => '{"calls":3}' }),
    );
    const r = report.results[0];
    expect(r && !r.ok && r.error.code).toBe('bad_response');
    expect(r && !r.ok && r.error.message).not.toBe('');
  });
});
