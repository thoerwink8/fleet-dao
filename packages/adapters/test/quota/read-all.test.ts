import { describe, expect, it } from 'vitest';
import {
  type PoolConfig,
  type PoolQuotaResult,
  QuotaReadError,
  type QuotaReading,
  type Reader,
  readAllQuotas,
} from '../../src/quota/index.ts';
import { blockNetwork, fakeDeps } from './helpers.ts';

blockNetwork();

const pool = (poolId: string, extra: Partial<PoolConfig> = {}): PoolConfig =>
  ({ poolId, channelId: 'c', reader: 'mirasim-relay', ...extra }) as PoolConfig;

const reading = (poolId: string, label: string, over: Partial<QuotaReading> = {}): QuotaReading => ({
  poolId,
  window: '5h',
  label,
  unit: 'points',
  used: 1,
  limit: 10,
  reading: 'measured',
  readAt: '2026-09-24T19:00:00.000Z',
  source: 'test',
  ...over,
});

const code = (r: PoolQuotaResult | undefined) => (r && !r.ok ? r.error.code : 'ok');

describe('一轮读完所有池：每个池一定有一条结果', () => {
  it('结果与配置一一对应、顺序相同；读成的、读到 0 个窗口的、没读成的分得清', async () => {
    const reader: Reader = async (ctx) => {
      if (ctx.pool.poolId === 'empty') return { windows: [], notes: ['上游说没有窗口'] };
      if (ctx.pool.poolId === 'broken') throw new QuotaReadError('auth', '要重新登录');
      return { windows: [reading(ctx.pool.poolId, '5h')] };
    };
    const report = await readAllQuotas(
      { pools: [pool('a'), pool('empty'), pool('broken')] },
      fakeDeps({ readers: { 'mirasim-relay': reader } }),
    );
    expect(report.results.map((r) => [r.poolId, r.ok])).toEqual([
      ['a', true],
      ['empty', true],
      ['broken', false],
    ]);
    const [a, empty, broken] = report.results;
    expect(a?.ok && a.windows).toHaveLength(1);
    expect(empty?.ok && empty.windows).toEqual([]);
    expect(broken).toMatchObject({ ok: false, error: { code: 'auth', message: '要重新登录' } });
    expect(report.startedAt).toBe('2026-09-24T19:00:00.000Z');
  });

  it('各读取器并发跑：一个等另一个开工才返回，串行就会超时', async () => {
    let bStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      bStarted = resolve;
    });
    const reader: Reader = async (ctx) => {
      if (ctx.pool.poolId === 'a') await started;
      else bStarted();
      return { windows: [reading(ctx.pool.poolId, '5h')] };
    };
    const report = await readAllQuotas(
      { timeoutMs: 1000, pools: [pool('a'), pool('b')] },
      fakeDeps({ readers: { 'mirasim-relay': reader } }),
    );
    expect(report.results.map(code)).toEqual(['ok', 'ok']);
  });

  it('各自有超时：卡住的那个到点给 timeout，并收到叫停信号；别的池不受影响', async () => {
    let aborted = false;
    const reader: Reader = (ctx) => {
      if (ctx.pool.poolId === 'stuck') {
        return new Promise(() => {
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
          });
        });
      }
      return Promise.resolve({ windows: [reading(ctx.pool.poolId, '5h')] });
    };
    const report = await readAllQuotas(
      { pools: [pool('stuck', { timeoutMs: 30 }), pool('fine')] },
      fakeDeps({ readers: { 'mirasim-relay': reader } }),
    );
    expect(report.results.map(code)).toEqual(['timeout', 'ok']);
    expect(aborted).toBe(true);
  });

  it('读取器自己崩了：记成 crashed，错误信息先脱敏', async () => {
    const reader: Reader = async () => {
      throw new TypeError('boom Bearer abc.def.ghi from owner@example.com at 10.0.0.1');
    };
    const report = await readAllQuotas(
      { pools: [pool('a')] },
      fakeDeps({ readers: { 'mirasim-relay': reader } }),
    );
    const r = report.results[0];
    expect(code(r)).toBe('crashed');
    const message = r && !r.ok ? r.error.message : '';
    expect(message).toContain('TypeError');
    for (const leak of ['abc.def.ghi', 'owner@example.com', '10.0.0.1']) expect(message).not.toContain(leak);
  });

  it('读取器交回来的数再过一道：别的池的、重名的、不是有限数的丢掉并写明，不静默', async () => {
    const reader: Reader = async () => ({
      windows: [
        reading('a', '5h'),
        reading('b', '7d'),
        reading('a', '5h'),
        reading('a', '7d', { used: Number.NaN }),
        reading('a', '7d_claude', { window: '7d_model', scope: 'claude' }),
      ],
    });
    const report = await readAllQuotas(
      { pools: [pool('a')] },
      fakeDeps({ readers: { 'mirasim-relay': reader } }),
    );
    const r = report.results[0];
    expect(r?.ok && r.windows.map((w) => w.label)).toEqual(['5h', '7d_claude']);
    expect(r?.notes).toEqual([
      '窗口 7d 池不对，没收',
      '窗口 5h 名字重复，没收',
      '窗口 7d 数字不是有限数，没收',
    ]);
  });

  it('同一轮里同一个 key 的共用调用只跑一次', async () => {
    let runs = 0;
    const reader: Reader = async (ctx) => {
      const n = await ctx.shared('same', async () => {
        runs++;
        return 7;
      });
      return { windows: [reading(ctx.pool.poolId, `n${n}`)] };
    };
    await readAllQuotas(
      { pools: [pool('a'), pool('b')] },
      fakeDeps({ readers: { 'mirasim-relay': reader } }),
    );
    expect(runs).toBe(1);
  });
});
