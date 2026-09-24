import { describe, expect, it } from 'vitest';
import {
  findUsageReport,
  parseOrgList,
  type QuotaConfig,
  QuotaReadError,
  readAllQuotas,
  readingsFromUsageReport,
  verifyNoCost,
} from '../../src/quota/index.ts';
import { blockNetwork, fakeCommands, fakeDeps, fixture, WORK_DIR } from './helpers.ts';

blockNetwork();

const ctx = { poolId: 'claude-solo', readAt: '2026-09-24T19:00:00.000Z' };
const usageStream = () => fixture('claude-usage-2026-09-24.ndjson');
const orgList = () => fixture('claude-org-list.txt');

function report(rateLimits: unknown) {
  return { session: {}, rate_limits: rateLimits };
}

describe('Claude /usage 的结构化结果（VPS 真跑，零模型调用）', () => {
  it('真机输出里找得到 usage_report', () => {
    expect(findUsageReport(usageStream())).toBeDefined();
    expect(findUsageReport('{"type":"result"}\nnot json')).toBeUndefined();
  });

  it('三行额度：session → 5h，weekly_all → 7d，weekly_scoped(Fable) → 只扣 fable 的周窗口', () => {
    const r = findUsageReport(usageStream());
    const { windows, notes } = readingsFromUsageReport(r ?? {}, ctx);
    expect(windows).toEqual([
      {
        poolId: 'claude-solo',
        window: '5h',
        label: 'session',
        unit: 'percent',
        used: 2,
        limit: 100,
        utilization: 0.02,
        resetsAt: '2026-09-24T23:59:59.589Z',
        upstreamStatus: 'allowed',
        statusRaw: 'normal',
        reading: 'measured',
        readAt: '2026-09-24T19:00:00.000Z',
        source: 'claude-usage',
      },
      expect.objectContaining({
        window: '7d',
        label: 'weekly_all',
        used: 12,
        resetsAt: '2026-09-26T19:59:59.589Z',
      }),
      expect.objectContaining({ window: '7d_model', scope: 'fable', label: 'weekly_scoped:fable', used: 0 }),
    ]);
    expect(notes).toContain('额外用量没开：超出套餐不会自动扣钱');
  });

  it('rate_limits 为空值 = Claude Code 没拿到，报错；limits 为 [] = 服务端明说没有额度行，零个窗口', () => {
    expect(() => readingsFromUsageReport(report(null), ctx)).toThrowError(QuotaReadError);
    const empty = readingsFromUsageReport(report({ limits: [] }), ctx);
    expect(empty.windows).toEqual([]);
    expect(empty.notes?.join()).toContain('没有额度行');
  });

  it('新出的额度行不用改代码就收下：kind 原样当名字，按 kind 归类，不按展示文字', () => {
    const { windows } = readingsFromUsageReport(
      report({
        limits: [
          { kind: 'monthly_all', group: 'monthly', percent: 40, resets_at: null, severity: 'warning' },
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 91,
            resets_at: '2026-09-26T20:00:00Z',
            scope: { model: null, surface: { display_name: 'Claude.ai' } },
            severity: 'critical',
          },
        ],
      }),
      ctx,
    );
    expect(windows).toMatchObject([
      { label: 'monthly_all', window: 'other', used: 40, upstreamStatus: 'warning' },
      {
        label: 'weekly_scoped:surface:claude.ai',
        window: '7d_model',
        scope: 'surface:claude.ai',
        statusRaw: 'critical',
      },
    ]);
    expect(windows[0]?.resetsAt).toBeUndefined();
  });

  it('额外用量开着：按月美元窗口，金额从美分换成美元，并提醒会花钱', () => {
    const { windows, notes } = readingsFromUsageReport(
      report({
        limits: [],
        extra_usage: {
          is_enabled: true,
          monthly_limit: 5000,
          used_credits: 1234,
          utilization: 0.2468,
          currency: 'USD',
        },
      }),
      ctx,
    );
    expect(windows).toMatchObject([
      { window: 'month_usd', label: 'extra_usage', unit: 'usd', used: 12.34, limit: 50 },
    ]);
    expect(notes?.join()).toContain('会继续花钱');
  });

  it('上游改了字段名、收到的行一行都认不出：bad_response——不能把 97%、99% 的池报成「没有窗口」', () => {
    const renamed = report({
      limits: [
        { type: 'session', used_percent: 97, reset: '2026-09-25T00:00:00Z', level: 'critical' },
        { type: 'weekly_all', used_percent: 99, reset: '2026-09-27T00:00:00Z', level: 'critical' },
      ],
    });
    expect(() => readingsFromUsageReport(renamed, ctx)).toThrowError(/一行都认不出/);
    try {
      readingsFromUsageReport(renamed, ctx);
    } catch (e) {
      expect((e as QuotaReadError).code).toBe('bad_response');
    }
  });

  it('只丢了百分比、还带着状态字的行照收，留住状态字；认不出的行写明', () => {
    const { windows, notes } = readingsFromUsageReport(
      report({
        limits: [
          { kind: 'session', pct: 99, severity: 'critical', resets_at: '2026-09-25T00:00:00Z' },
          { kind: 'weekly_all', pct: 40 },
        ],
      }),
      ctx,
    );
    expect(windows).toEqual([
      expect.objectContaining({ label: 'session', upstreamStatus: 'warning', statusRaw: 'critical' }),
    ]);
    expect(windows[0]?.used).toBeUndefined();
    expect(notes?.join('\n')).toContain('第 2 行额度认不出');
    expect(notes?.join('\n')).toContain('没读到额外用量');
  });
});

describe('核实 /usage 没花钱', () => {
  const withResult = (patch: Record<string, unknown> | null) =>
    usageStream()
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const doc = JSON.parse(line) as Record<string, unknown>;
        if (doc.type !== 'result') return [line];
        return patch === null ? [] : [JSON.stringify({ ...doc, ...patch })];
      })
      .join('\n');

  it('真机输出：num_turns 0、total_cost_usd 0，放行', () => {
    expect(() => verifyNoCost(usageStream())).not.toThrow();
  });

  it('花了 $0.41：read_cost，读数不采信', () => {
    try {
      verifyNoCost(withResult({ num_turns: 1, total_cost_usd: 0.41 }));
      expect.unreachable('应当报读额度花了钱');
    } catch (e) {
      expect((e as QuotaReadError).code).toBe('read_cost');
      expect((e as QuotaReadError).message).toContain('0.41');
    }
  });

  it('没有 result 行：核实不了，bad_response，不当成没花钱', () => {
    try {
      verifyNoCost(withResult(null));
      expect.unreachable('应当报核实不了');
    } catch (e) {
      expect((e as QuotaReadError).code).toBe('bad_response');
    }
  });

  it('读取器端到端：/usage 花了钱，这个池报 read_cost', async () => {
    const { run } = fakeCommands((argv) =>
      argv.includes('/usage') ? { stdout: withResult({ num_turns: 1, total_cost_usd: 0.41 }) } : { code: 1 },
    );
    const rep = await readAllQuotas(
      { pools: [{ poolId: 'claude', channelId: 'claude-sub', reader: 'claude-usage', command: ['claude'] }] },
      fakeDeps({ runCommand: run }),
    );
    const r = rep.results[0];
    expect(!r?.ok && r?.error.code).toBe('read_cost');
  });
});

describe('reclaude org list：只留类型和是否当前', () => {
  it('team = 拼车，personal = 独享，* 是当前；编号、名字、邮箱不往外带', () => {
    const rows = parseOrgList(orgList());
    expect(rows).toEqual([
      { kind: 'solo', current: true },
      { kind: 'carpool', current: false },
    ]);
  });

  it('认不出的类型记空值，不猜', () => {
    expect(parseOrgList('* 42\tX\tenterprise\t<邮箱>')).toEqual([{ kind: null, current: true }]);
  });
});

describe('Claude 读取器：只读当前组织，绝不切号', () => {
  const pools: QuotaConfig['pools'] = [
    {
      poolId: 'claude-solo',
      channelId: 'claude-sub',
      reader: 'claude-usage',
      command: ['reclaude'],
      orgKind: 'solo',
    },
    {
      poolId: 'claude-carpool',
      channelId: 'claude-sub',
      reader: 'claude-usage',
      command: ['reclaude'],
      orgKind: 'carpool',
    },
  ];
  const answer = (argv: string[]) =>
    argv.includes('org')
      ? { stdout: orgList() }
      : argv.includes('/usage')
        ? { stdout: usageStream() }
        : { code: 1 };

  it('当前是独享：独享池实读，拼车池报 not_current 并说明不切号；两个池共用一次 org list、一次 /usage', async () => {
    const { run, calls } = fakeCommands(answer);
    const rep = await readAllQuotas({ pools }, fakeDeps({ runCommand: run }));
    const [solo, carpool] = rep.results;
    expect(solo?.ok && solo.windows.map((w) => w.label)).toEqual([
      'session',
      'weekly_all',
      'weekly_scoped:fable',
    ]);
    expect(carpool?.ok).toBe(false);
    expect(!carpool?.ok && carpool?.error.code).toBe('not_current');
    expect(!carpool?.ok && carpool?.error.message).toContain('不切号');
    // 读前核一次组织、读后再核一次；从头到尾没有 org use。
    expect(calls.map((c) => c.argv.slice(1).join(' '))).toEqual([
      'org list',
      '-p --output-format stream-json --verbose --setting-sources project --no-session-persistence /usage',
      'org list',
    ]);
    expect(calls.some((c) => c.argv.includes('use'))).toBe(false);
  });

  it('读的过程中组织被切走：这次读数作废，不记到错的池上', async () => {
    let orgCalls = 0;
    const flipped = orgList().replace('* 1000001', '  1000001').replace('  1000002', '* 1000002');
    const { run } = fakeCommands((argv) =>
      argv.includes('org') ? { stdout: orgCalls++ === 0 ? orgList() : flipped } : { stdout: usageStream() },
    );
    const rep = await readAllQuotas(
      { pools: [pools[0] as QuotaConfig['pools'][number]] },
      fakeDeps({ runCommand: run }),
    );
    const r = rep.results[0];
    expect(!r?.ok && r?.error.code).toBe('upstream');
    expect(!r?.ok && r?.error.message).toContain('作废');
  });

  it('/usage 是本地命令：不点模型、不带 --bare、只加载项目级设置', async () => {
    const { run, calls } = fakeCommands(answer);
    await readAllQuotas({ pools: [pools[0] as QuotaConfig['pools'][number]] }, fakeDeps({ runCommand: run }));
    const usage = calls.find((c) => c.argv.includes('/usage'));
    expect(usage?.argv).not.toContain('--bare');
    expect(usage?.argv).not.toContain('--model');
    expect(usage?.argv.join(' ')).toContain('--setting-sources project');
  });

  it('没配工作目录：每次都在同一个私有空目录里跑——不加载别人的项目设置，也不每读一次就多留一个项目目录', async () => {
    const { run, calls } = fakeCommands(answer);
    await readAllQuotas({ pools: [pools[0] as QuotaConfig['pools'][number]] }, fakeDeps({ runCommand: run }));
    expect(calls.map((c) => c.options.cwd)).toEqual([WORK_DIR, WORK_DIR, WORK_DIR]);
  });

  it('工作目录不可用（不是空的、不是真目录）：这个池报 config，不在别处凑合着跑', async () => {
    const { run, calls } = fakeCommands(answer);
    const rep = await readAllQuotas(
      { pools: [pools[0] as QuotaConfig['pools'][number]] },
      fakeDeps({
        runCommand: run,
        workDir: async () => {
          throw new Error('/home/tester/.cache/fleet-dao/quota-cwd 不是空的（.claude）');
        },
      }),
    );
    const r = rep.results[0];
    expect(!r?.ok && r?.error.code).toBe('config');
    expect(calls).toHaveLength(0);
  });

  it('子进程环境显式构造：宿主环境里的 ANTHROPIC_* 不带过去（带了就绕开 reclaude）', async () => {
    const { run, calls } = fakeCommands(answer);
    await readAllQuotas(
      { pools: [pools[0] as QuotaConfig['pools'][number]] },
      fakeDeps({
        runCommand: run,
        env: {
          PATH: '/usr/bin',
          HOME: '/home/tester',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/x',
          ANTHROPIC_API_KEY: 'k',
          CLAUDECODE: '1',
        },
      }),
    );
    for (const c of calls) {
      expect(Object.keys(c.options.env).sort()).toEqual(['HOME', 'PATH']);
    }
  });

  it('没登录、起不来、超时各给明确原因', async () => {
    const code = async (answerFn: (argv: string[]) => Record<string, unknown>) => {
      const { run } = fakeCommands(answerFn);
      const rep = await readAllQuotas(
        { pools: [pools[0] as QuotaConfig['pools'][number]] },
        fakeDeps({ runCommand: run }),
      );
      const r = rep.results[0];
      return r && !r.ok ? r.error.code : 'ok';
    };
    expect(
      await code((argv) =>
        argv.includes('org') ? { stdout: orgList() } : { code: 1, stderr: 'Not logged in' },
      ),
    ).toBe('auth');
    expect(await code(() => ({ code: null, spawnError: 'spawn reclaude ENOENT' }))).toBe('config');
    expect(await code(() => ({ code: null, killed: true }))).toBe('timeout');
    // 2026-09-23 真实报错原文：组织绑定的账号被封，reclaude 回 403 account_banned。
    const banned =
      'sync current account: unexpected status 403: {"error":{"code":"account_banned","status":403,"message":"当前绑定账号暂不可用，系统将自动处理，请稍后重试"}}';
    expect(
      await code((argv) => (argv.includes('org') ? { stdout: orgList() } : { code: 1, stderr: banned })),
    ).toBe('upstream');
    expect(await code((argv) => (argv.includes('org') ? { stdout: 'Available organizations:\n' } : {}))).toBe(
      'bad_response',
    );
    // org list 本身退出非 0、/usage 退出 0 却没有结构化结果（Claude Code 太旧）：都不许当成读成了。
    expect(await code(() => ({ code: 2, stderr: 'boom' }))).toBe('bad_response');
    expect(
      await code((argv) =>
        argv.includes('org') ? { stdout: orgList() } : { code: 0, stdout: '{"type":"result","result":"x"}' },
      ),
    ).toBe('bad_response');
  });

  it('没给 orgKind 时不跑 org list（不经 reclaude 的普通登录也能读）', async () => {
    const { run, calls } = fakeCommands(answer);
    const rep = await readAllQuotas(
      { pools: [{ poolId: 'claude', channelId: 'claude-sub', reader: 'claude-usage', command: ['claude'] }] },
      fakeDeps({ runCommand: run }),
    );
    expect(rep.results[0]?.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
