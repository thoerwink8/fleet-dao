// Haiku 改代码的本机账本和收回策略（单 #2821）：钩子（pretool.mjs）只读本机文件、不联网。
// 账本 ~/.fleet-dao/subagent-ledger.jsonl 一行一次 Haiku 派工；策略 ~/.fleet-dao/subagent-policy.json 记收回。
// 这里测 subagent-ledger.mjs 的纯函数、pretool.mjs 的接线，以及收轮前对账顺手跑 --enforce（queue-stop.mjs）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

interface Block {
  code: 2;
  message: string;
}
interface LedgerLib {
  briefIssue(prompt: string): number | null;
  policyPath(home: string): string;
  ledgerPath(home: string): string;
  readPolicy(
    home: string,
  ): { revoked: boolean; reason?: string; at?: string; liftedAt?: string } | { error: string };
  revokePolicy(home: string, why: { reason: string; at: string }): { written: boolean; already: boolean };
  liftPolicy(home: string, at: string): { lifted: boolean };
  haikuVerdict(raw: string, deps: { home: string }): Block | null;
  recordHaikuDispatch(
    raw: string,
    deps: { home: string; now?: () => Date },
  ): { recorded: boolean; issue?: number; why?: string };
}
interface PretoolLib {
  haikuGuardVerdict(raw: string, deps: { home: string }): Block | null;
}
interface QueueStopLib {
  decideQueueStop(
    opts: Record<string, unknown>,
  ): Promise<{ block: boolean; notice?: string; reason?: string }>;
}

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const ledger = (await import(pathToFileURL(join(HOOKS, 'subagent-ledger.mjs')).href)) as LedgerLib;
const pretool = (await import(pathToFileURL(join(HOOKS, 'pretool.mjs')).href)) as PretoolLib;
const queueStop = (await import(pathToFileURL(join(HOOKS, 'queue-stop.mjs')).href)) as QueueStopLib;

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'subagent-ledger-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const dispatch = (input: Record<string, unknown>, tool = 'Agent'): string =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: tool,
    tool_input: { description: 'x', prompt: '## 活：#2821，写点东西', ...input },
    cwd: '/work/fleet-dao',
  });
const haiku = (input: Record<string, unknown> = {}) =>
  dispatch({ subagent_type: 'general-purpose', model: 'haiku', ...input });

describe('从派工交代里认单号', () => {
  it.each([
    ['## 活：#2821，子代理护栏', 2821],
    ['前面一段\n## 活：#77\n后面', 77],
    ['## 活:#9（半角冒号）', 9],
    ['租约：先 `pnpm work claim 2821`，已被领就续', 2821],
    ['pnpm work claim #55', 55],
  ])('%s', (text, n) => {
    expect(ledger.briefIssue(text)).toBe(n);
  });

  it('两种都有：优先认「## 活：#N」', () => {
    expect(ledger.briefIssue('pnpm work claim 5\n\n## 活：#8')).toBe(8);
  });

  it('认不出：null（正文里随手提到的 #12 不算）', () => {
    expect(ledger.briefIssue('顺便看看 #12 的做法')).toBeNull();
    expect(ledger.briefIssue('')).toBeNull();
  });
});

describe('收回策略文件', () => {
  it('没有文件：没收回', () => {
    expect(ledger.readPolicy(tmp())).toEqual({ revoked: false });
  });

  it('收回写进文件，带原因和时刻；再收回不覆盖第一次的原因', () => {
    const home = tmp();
    const r = ledger.revokePolicy(home, { reason: '返工率 40%', at: '2026-10-16T12:00:00.000Z' });
    expect(r).toEqual({ written: true, already: false });
    expect(ledger.readPolicy(home)).toMatchObject({
      revoked: true,
      reason: '返工率 40%',
      at: '2026-10-16T12:00:00.000Z',
    });
    const again = ledger.revokePolicy(home, { reason: '别的原因', at: '2026-10-17T00:00:00.000Z' });
    expect(again).toEqual({ written: false, already: true });
    expect(ledger.readPolicy(home)).toMatchObject({ reason: '返工率 40%' });
  });

  it('恢复：revoked 变 false，记下恢复时刻', () => {
    const home = tmp();
    ledger.revokePolicy(home, { reason: 'x', at: '2026-10-16T12:00:00.000Z' });
    expect(ledger.liftPolicy(home, '2026-10-20T00:00:00.000Z')).toEqual({ lifted: true });
    expect(ledger.readPolicy(home)).toMatchObject({ revoked: false, liftedAt: '2026-10-20T00:00:00.000Z' });
  });

  it('文件读不懂：明说读不懂，不当成没收回', () => {
    const home = tmp();
    writeFileSync(ledger.policyPath(home), '{坏的');
    const p = ledger.readPolicy(home);
    expect('error' in p && p.error).toMatch(/策略文件/);
  });
});

describe('钩子：收回后拦下 general-purpose 加 model haiku 的派工', () => {
  it('没收回、单没派过：放行', () => {
    expect(ledger.haikuVerdict(haiku(), { home: tmp() })).toBeNull();
  });

  it('收回了：拦下，提示改派 Sonnet 并给出原因和时刻', () => {
    const home = tmp();
    ledger.revokePolicy(home, { reason: '返工率 40%（2/5）', at: '2026-10-16T12:00:00.000Z' });
    const v = ledger.haikuVerdict(haiku(), { home });
    expect(v?.code).toBe(2);
    expect(v?.message).toMatch(/Sonnet/);
    expect(v?.message).toMatch(/返工率 40%（2\/5）/);
    expect(v?.message).toMatch(/2026-10-16T12:00:00/);
  });

  it('收回了，但派的不是 Haiku、或是只读的斥候：放行', () => {
    const home = tmp();
    ledger.revokePolicy(home, { reason: 'x', at: '2026-10-16T12:00:00.000Z' });
    expect(ledger.haikuVerdict(dispatch({ subagent_type: 'general-purpose' }), { home })).toBeNull();
    expect(
      ledger.haikuVerdict(dispatch({ subagent_type: 'general-purpose', model: 'sonnet' }), { home }),
    ).toBeNull();
    expect(ledger.haikuVerdict(dispatch({ subagent_type: 'Explore' }), { home })).toBeNull();
    expect(ledger.haikuVerdict(dispatch({ subagent_type: 'Explore', model: 'haiku' }), { home })).toBeNull();
  });

  it('model 写完整 id、不写 subagent_type（默认就是工人）、Task 工具名：一样算', () => {
    const home = tmp();
    ledger.revokePolicy(home, { reason: 'x', at: '2026-10-16T12:00:00.000Z' });
    expect(ledger.haikuVerdict(dispatch({ model: 'claude-haiku-5-5' }), { home })?.code).toBe(2);
    expect(
      ledger.haikuVerdict(dispatch({ subagent_type: 'general-purpose', model: 'haiku' }, 'Task'), { home })
        ?.code,
    ).toBe(2);
  });

  it('恢复之后放行', () => {
    const home = tmp();
    ledger.revokePolicy(home, { reason: 'x', at: '2026-10-16T12:00:00.000Z' });
    ledger.liftPolicy(home, '2026-10-20T00:00:00.000Z');
    expect(ledger.haikuVerdict(haiku(), { home })).toBeNull();
  });

  it('策略文件读不懂：拦下并明说（不当成没收回）', () => {
    const home = tmp();
    writeFileSync(ledger.policyPath(home), 'not json');
    const v = ledger.haikuVerdict(haiku(), { home });
    expect(v?.code).toBe(2);
    expect(v?.message).toMatch(/读不懂|没查成/);
  });
});

describe('钩子：同一张单不给 Haiku 第二次', () => {
  it('第一次派：放行并记进账本（单号、时刻）', () => {
    const home = tmp();
    const r = ledger.recordHaikuDispatch(haiku(), { home, now: () => new Date('2026-10-16T09:00:00.000Z') });
    expect(r).toEqual({ recorded: true, issue: 2821 });
    const lines = readFileSync(ledger.ledgerPath(home), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ issue: 2821, at: '2026-10-16T09:00:00.000Z' });
  });

  it('同一张单再派 Haiku：拦下，提示换 Sonnet，带上次时刻', () => {
    const home = tmp();
    ledger.recordHaikuDispatch(haiku(), { home, now: () => new Date('2026-10-16T09:00:00.000Z') });
    const v = ledger.haikuVerdict(haiku(), { home });
    expect(v?.code).toBe(2);
    expect(v?.message).toMatch(/#2821/);
    expect(v?.message).toMatch(/Sonnet/);
    expect(v?.message).toMatch(/2026-10-16T09:00:00/);
  });

  it('别的单、不是 Haiku 的派工：放行', () => {
    const home = tmp();
    ledger.recordHaikuDispatch(haiku(), { home });
    expect(ledger.haikuVerdict(haiku({ prompt: '## 活：#9' }), { home })).toBeNull();
    expect(ledger.haikuVerdict(dispatch({ subagent_type: 'general-purpose' }), { home })).toBeNull();
  });

  it('同一张单派 Sonnet 不记账本', () => {
    const home = tmp();
    const r = ledger.recordHaikuDispatch(dispatch({ subagent_type: 'general-purpose' }), { home });
    expect(r.recorded).toBe(false);
    expect(existsSync(ledger.ledgerPath(home))).toBe(false);
  });

  it('交代里认不出单号：不记、不拦，说明为什么没记', () => {
    const home = tmp();
    const raw = haiku({ prompt: '随手改个文案' });
    expect(ledger.haikuVerdict(raw, { home })).toBeNull();
    const r = ledger.recordHaikuDispatch(raw, { home });
    expect(r.recorded).toBe(false);
    expect(r.why).toMatch(/单号/);
  });

  it('账本里有坏行：跳过坏行，好行照认', () => {
    const home = tmp();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      ledger.ledgerPath(home),
      `垃圾\n${JSON.stringify({ at: '2026-10-16T01:00:00.000Z', issue: 2821 })}\n`,
    );
    expect(ledger.haikuVerdict(haiku(), { home })?.code).toBe(2);
  });

  it('pretool 导出的接线和 subagent-ledger 是同一个判法', () => {
    const home = tmp();
    ledger.recordHaikuDispatch(haiku(), { home });
    expect(pretool.haikuGuardVerdict(haiku(), { home })?.code).toBe(2);
    expect(pretool.haikuGuardVerdict(haiku({ prompt: '## 活：#3' }), { home })).toBeNull();
  });
});

describe('钩子整条跑：收回后 Haiku 派工退出码 2，别的派工不受影响', () => {
  it('收回了：退出码 2，stderr 给原因（在容量闸之前，不依赖本机读数）', () => {
    const home = tmp();
    ledger.revokePolicy(home, { reason: '返工率 40%', at: '2026-10-16T12:00:00.000Z' });
    const r = runChild(process.execPath, [join(HOOKS, 'pretool.mjs')], {
      input: haiku(),
      env: { ...process.env, FLEET_DAO_HOME: home },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Sonnet/);
    expect(r.stderr).toMatch(/返工率 40%/);
  });

  it('只读的斥候派工不受收回影响（仍走原来的路径，退出码 0）', () => {
    const home = tmp();
    ledger.revokePolicy(home, { reason: 'x', at: '2026-10-16T12:00:00.000Z' });
    const r = runChild(process.execPath, [join(HOOKS, 'pretool.mjs')], {
      input: dispatch({ subagent_type: 'Explore' }),
      env: { ...process.env, FLEET_DAO_HOME: home },
    });
    expect(r.status).toBe(0);
  });
});

describe('收轮前对账顺手跑 --enforce（queue-stop.mjs）', () => {
  const baseOpts = (over: Record<string, unknown>) => ({
    input: { cwd: process.cwd() },
    dir: tmp(),
    sessionId: 'sess-1',
    readQueue: () => Promise.resolve({ ok: true, items: [], problems: [] }),
    readCap: () => Promise.resolve({ ok: true, freeBytes: 32 * 1024 ** 3, load1: 1, cores: 16, how: '假的' }),
    ...over,
  });

  it('每次收轮都问一下：到点就跑，跑成了不说话、不挡', async () => {
    const calls: string[] = [];
    const r = await queueStop.decideQueueStop(
      baseOpts({
        enforceStats: (root: string) => {
          calls.push(root);
          return { ran: true };
        },
      }),
    );
    expect(r.block).toBe(false);
    expect(r.notice).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('起不来：只提示「没跑成」和原因，不挡收轮', async () => {
    const r = await queueStop.decideQueueStop(
      baseOpts({ enforceStats: () => ({ ran: false, why: '起不了 node' }) }),
    );
    expect(r.block).toBe(false);
    expect(r.notice).toMatch(/subagent:stats --enforce/);
    expect(r.notice).toMatch(/起不了 node/);
  });

  it('跑它的函数自己抛错：只提示，不挡', async () => {
    const r = await queueStop.decideQueueStop(
      baseOpts({
        enforceStats: () => {
          throw new Error('炸了');
        },
      }),
    );
    expect(r.block).toBe(false);
    expect(r.notice).toMatch(/炸了/);
  });
});

describe('startEnforce：起后台进程、限频、把后台留的话说出来', () => {
  interface StartLib {
    startEnforce(
      root: string,
      deps: { home: string; now: () => Date; spawnFn: (...a: unknown[]) => unknown; everyMs?: number },
    ): { ran: boolean; why?: string; notice?: string };
  }
  const start = queueStop as unknown as StartLib;
  const fakeSpawn =
    (calls: unknown[][]) =>
    (...a: unknown[]) => {
      calls.push(a);
      const opts = a[0] as { statePath: string; now: number; timeoutMs: number };
      mkdirSync(join(opts.statePath, '..'), { recursive: true });
      writeFileSync(
        opts.statePath,
        JSON.stringify({
          startedAt: opts.now,
          pid: process.pid,
          receipt: `${opts.statePath}.result`,
          timeoutMs: opts.timeoutMs,
        }),
      );
      writeFileSync(`${opts.statePath}.result`, JSON.stringify({ kind: 'done', at: opts.now }));
      return { ok: true, pid: process.pid, how: 'setsid' };
    };

  it('起一个脱离的 node 进程跑 subagent-stats.ts --enforce；6 小时内不再起', () => {
    const home = tmp();
    const calls: unknown[][] = [];
    const t0 = new Date('2026-10-16T00:00:00.000Z');
    expect(start.startEnforce('/repo', { home, now: () => t0, spawnFn: fakeSpawn(calls) })).toEqual({
      ran: true,
    });
    expect(calls).toHaveLength(1);
    const args = ((calls[0]?.[0] ?? {}) as { args: string[] }).args;
    expect(String(args[0])).toMatch(/subagent-stats\.ts$/);
    expect(args[1]).toBe('--enforce');
    expect(calls[0]?.[0]).toMatchObject({ cwd: '/repo', timeoutMs: 600_000, env: { FLEET_DAO_HOME: home } });
    const soon = new Date(t0.getTime() + 3600 * 1000);
    start.startEnforce('/repo', { home, now: () => soon, spawnFn: fakeSpawn(calls) });
    expect(calls).toHaveLength(1);
    const later = new Date(t0.getTime() + 7 * 3600 * 1000);
    start.startEnforce('/repo', { home, now: () => later, spawnFn: fakeSpawn(calls) });
    expect(calls).toHaveLength(2);
  });

  it('起不来：ran 为假并写明原因，不抛', () => {
    const r = start.startEnforce('/repo', {
      home: tmp(),
      now: () => new Date(),
      spawnFn: () => {
        throw new Error('EPERM');
      },
    });
    expect(r.ran).toBe(false);
    expect(r.why).toMatch(/EPERM/);
  });

  it('后台跑完留在便条里的话：下一次说出来，只说一次', () => {
    const home = tmp();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'subagent-stats-stamp.json'),
      JSON.stringify({ startedAt: new Date().toISOString(), report: 'Haiku 改代码已收回：返工率 40%' }),
    );
    const deps = { home, now: () => new Date(), spawnFn: fakeSpawn([]) };
    expect(start.startEnforce('/repo', deps).notice).toMatch(/已收回/);
    expect(start.startEnforce('/repo', deps).notice).toBeUndefined();
  });

  it('启动失败不写 startedAt，失败限频一分钟而非六小时', () => {
    const home = tmp();
    const t0 = new Date('2026-10-16T00:00:00.000Z');
    let calls = 0;
    const spawnFn = () => {
      calls += 1;
      return { ok: false, why: 'WMI denied' };
    };
    expect(start.startEnforce('/repo', { home, now: () => t0, spawnFn }).ran).toBe(false);
    expect(
      JSON.parse(readFileSync(join(home, 'subagent-stats-stamp.json'), 'utf8')).startedAt,
    ).toBeUndefined();
    start.startEnforce('/repo', { home, now: () => new Date(t0.getTime() + 30_000), spawnFn });
    expect(calls).toBe(1);
    start.startEnforce('/repo', { home, now: () => new Date(t0.getTime() + 61_000), spawnFn });
    expect(calls).toBe(2);
  });

  it('只记了 startedAt 或后台已早退，都能在六小时内按证据重试', () => {
    for (const dead of [false, true]) {
      const home = tmp();
      const t0 = Date.parse('2026-10-16T00:00:00.000Z');
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, 'subagent-stats-stamp.json'),
        JSON.stringify({ startedAt: new Date(t0).toISOString() }),
      );
      if (dead)
        writeFileSync(
          join(home, 'subagent-stats-run.json'),
          JSON.stringify({
            startedAt: t0,
            pid: 2147483647,
            receipt: join(home, 'absent'),
            timeoutMs: 600_000,
          }),
        );
      const calls: unknown[][] = [];
      const result = start.startEnforce('/repo', {
        home,
        now: () => new Date(t0 + 120_000),
        spawnFn: fakeSpawn(calls),
      });
      expect(result.ran).toBe(true);
      expect(calls).toHaveLength(1);
      if (dead) expect(result.notice).toMatch(/早退/);
    }
  });
});
