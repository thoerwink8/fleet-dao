import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runQuotaCli } from '../../src/quota/cli.ts';
import {
  formatQuotaTable,
  type QuotaDeps,
  QuotaReadError,
  type QuotaReport,
  type Reader,
} from '../../src/quota/index.ts';
import { blockNetwork, fakeDeps } from './helpers.ts';

blockNetwork();

const report: QuotaReport = {
  startedAt: '2026-09-24T19:00:00.000Z',
  finishedAt: '2026-09-24T19:00:02.000Z',
  results: [
    {
      poolId: 'mirasim-relay',
      channelId: 'mirasim',
      reader: 'mirasim-relay',
      startedAt: '2026-09-24T19:00:00.000Z',
      durationMs: 120,
      ok: true,
      notes: [],
      windows: [
        {
          poolId: 'mirasim-relay',
          window: '7d_model',
          scope: 'fable',
          label: '7d_fable',
          unit: 'points',
          used: 322156.15205,
          limit: 325291,
          utilization: 0.9904,
          resetsAt: '2026-09-26T19:00:00.000Z',
          upstreamStatus: 'limit_reached',
          reading: 'measured',
          readAt: '2026-09-24T18:59:47.384Z',
          source: 'mirasim-relay',
        },
      ],
    },
    {
      poolId: 'cursor',
      channelId: 'cursor',
      reader: 'cursor-dashboard',
      startedAt: '2026-09-24T19:00:00.000Z',
      durationMs: 300,
      ok: true,
      notes: ['账号不允许按量计费：超出套餐不会自动扣钱'],
      subscription: { plan: 'Ultra', expiresAt: '2026-10-16T19:08:36.000Z' },
      windows: [
        {
          poolId: 'cursor',
          window: 'month_usd',
          label: 'plan_usd',
          unit: 'usd',
          used: 222.81,
          limit: 400,
          utilization: 0.557,
          resetsAt: '2026-10-16T19:08:36.000Z',
          reading: 'measured',
          readAt: '2026-09-24T19:00:00.000Z',
          source: 'cursor-dashboard',
        },
      ],
    },
    {
      poolId: 'jev',
      channelId: 'jev',
      reader: 'estimate',
      startedAt: '2026-09-24T19:00:00.000Z',
      durationMs: 3,
      ok: true,
      notes: [],
      windows: [
        {
          poolId: 'jev',
          window: 'period_usd',
          label: 'day_usd',
          unit: 'usd',
          used: 0.018,
          limit: 0.3,
          utilization: 0.06,
          resetsAt: '2026-09-25T00:00:00.000Z',
          reading: 'estimated',
          readAt: '2026-09-24T19:00:00.000Z',
          source: 'estimate',
        },
      ],
    },
    {
      poolId: 'claude-carpool',
      channelId: 'claude-sub',
      reader: 'claude-usage',
      startedAt: '2026-09-24T19:00:00.000Z',
      durationMs: 9000,
      ok: false,
      notes: [],
      error: { code: 'not_current', message: '这台机器当前挂的是独享组织，读不到拼车组织' },
    },
    {
      poolId: 'grok',
      channelId: 'xai',
      reader: 'grok-billing',
      startedAt: '2026-09-24T19:00:00.000Z',
      durationMs: 200,
      ok: true,
      notes: [],
      windows: [],
    },
  ],
};

describe('命令行表格', () => {
  const text = formatQuotaTable(report, { timeZone: 'UTC' });

  it('表头按约定的八列', () => {
    expect(text.split('\n')[0]?.split(/\s{2,}/)).toEqual([
      '账号池',
      '窗口',
      '已用/上限',
      '百分比',
      '清零时间',
      '实读/估算',
      '来源',
      '错误',
    ]);
  });

  it('点数、美元、状态字、模型组、实读与估算都写清楚', () => {
    expect(text).toContain('7d_fable（只扣 fable）');
    expect(text).toContain('322,156 点 / 325,291 点');
    expect(text).toContain('99.0%（已满）');
    expect(text).toContain('$222.81 / $400.00');
    expect(text).toContain('09/25 00:00（5.0 小时后）');
    expect(text).toMatch(/jev .*估算/);
  });

  it('没读成的池单独一行写原因；读到 0 个窗口的也单独写，不混', () => {
    expect(text).toMatch(/claude-carpool .*not_current：这台机器当前挂的是独享组织/);
    expect(text).toContain('（上游说没有窗口）');
    expect(text).toContain('共 5 个账号池：实读 2，估算 1，读到 0 个窗口 1，没读成 1');
  });

  it('套餐和说明列在表下面', () => {
    expect(text).toContain('cursor：套餐 Ultra，付到 10/16 19:08');
    expect(text).toContain('账号不允许按量计费');
  });
});

describe('命令行入口', () => {
  let dir = '';
  let configPath = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-quota-cli-'));
    configPath = join(dir, 'quota.json');
    await writeFile(
      configPath,
      JSON.stringify({
        pools: [
          { poolId: 'good', channelId: 'c', reader: 'mirasim-relay' },
          { poolId: 'bad', channelId: 'c', reader: 'mirasim-relay' },
        ],
      }),
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const reader: Reader = async (ctx) => {
    if (ctx.pool.poolId === 'bad') throw new QuotaReadError('unreachable', '连不上');
    return {
      windows: [
        {
          poolId: ctx.pool.poolId,
          window: '5h',
          label: '5h',
          unit: 'points',
          used: 1,
          limit: 10,
          reading: 'measured',
          readAt: ctx.fetchedAt,
          source: 'test',
        },
      ],
    };
  };
  const deps: QuotaDeps = fakeDeps({ readers: { 'mirasim-relay': reader } });

  const run = async (argv: string[], env: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runQuotaCli(argv, { out: (s) => out.push(s), err: (s) => err.push(s), env }, deps);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('有池没读成：退出码 1，表里写着原因', async () => {
    const r = await run([], { FLEET_QUOTA_CONFIG: configPath });
    expect(r.code).toBe(1);
    expect(r.out).toContain('unreachable：连不上');
  });

  it('--json 给程序读：结果能原样解析，读成与没读成都在', async () => {
    const r = await run(['--json', '--config', configPath]);
    const parsed = JSON.parse(r.out) as QuotaReport;
    expect(parsed.results.map((x) => [x.poolId, x.ok])).toEqual([
      ['good', true],
      ['bad', false],
    ]);
  });

  it('--pool 只读指定的池；全读到退出码 0', async () => {
    const r = await run(['--config', configPath, '--pool', 'good']);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('bad');
  });

  it('参数不对、配置不在、池名不对：退出码 2', async () => {
    expect((await run(['--nope'])).code).toBe(2);
    expect((await run([], { FLEET_QUOTA_CONFIG: join(dir, 'missing.json') })).code).toBe(2);
    expect((await run(['--config', configPath, '--pool', 'ghost'])).code).toBe(2);
  });
});
