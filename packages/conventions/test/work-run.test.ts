// pnpm work run（单 #2761 第二片）：脱离聊天进程派无头工人、看护进程靠租约心跳、网关断了从断点续、结束写结果文件。
// 故意造出的失败：网关 502、会话还没建起来就断、看护进程自己死了再起、登录坏了、次数用完、容量不够 / 没查成、已经有一个在跑。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhResult } from '../src/issue-new.ts';
import { type FeedbackEvent, feedbackBody, feedbackDigest } from '../src/managed-feedback.ts';
import { validateManagedDelivery } from '../src/managed-work.ts';
import { type LocalClaimRequest, type WorkDeps, work } from '../src/work.ts';
import {
  type AttemptOutput,
  acceptRework,
  BEAT_STALE_MS,
  backoffMs,
  claimRunLock,
  DeliveryCheckError,
  FIRST_BACKOFF_MS,
  judgeAttempt,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  RESUME_PROMPT,
  type ReworkIntent,
  type RunResult,
  type RunSpec,
  type RunStatus,
  readJson,
  releaseRunLock,
  renderRuns,
  runDir,
  runFiles,
  runLockHeld,
  SUPERVISOR_START_LOCK,
  type SuperviseDeps,
  setRunLockWorker,
  superviseRun,
  WORKER_SLOT_LOCK,
  workerArgs,
  writeJson,
} from '../src/work-run.ts';
import { runChild } from './child.ts';

const hookUrl = new URL('../../../agents/hooks/unattended.mjs', import.meta.url).href;
const { selectSessionId, main: unattended } = (await import(hookUrl)) as {
  selectSessionId: NonNullable<WorkDeps['run']>['selectSessionId'];
  main: (
    argv: string[],
    io: { env: NodeJS.ProcessEnv; out: (s: string) => void; err: (s: string) => void },
  ) => number;
};
const dirs: string[] = [];
beforeEach(() => {
  vi.stubEnv('GH_REPO', '');
  vi.stubEnv('GITHUB_REPOSITORY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'work-run-'));
  dirs.push(d);
  return d;
}

const resultJson = (o: Record<string, unknown>) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...o });
const SID = '11111111-2222-3333-4444-555555555555';

describe('judgeAttempt：工人这一次跑完怎么办', () => {
  it('退出码 0、结果不是错：做完，带最后一条回复和会话号', () => {
    expect(
      judgeAttempt({ code: 0, stdout: resultJson({ result: 'PR #9 合了', session_id: SID }), stderr: '' }),
    ).toEqual({
      kind: 'done',
      summary: 'PR #9 合了',
      sessionId: SID,
    });
  });

  it('【故意造出的失败】网关 502（结果是错、退出码 1）：续，不算做完', () => {
    const v = judgeAttempt({
      code: 1,
      stdout: resultJson({ is_error: true, result: 'API Error: 502 Bad Gateway', session_id: SID }),
      stderr: '',
    });
    expect(v).toMatchObject({ kind: 'retry', session: 'unknown', sessionId: SID });
    if (v.kind === 'retry') expect(v.why).toContain('网关或网络断了');
  });

  it('【故意造出的失败】没输出就断（fetch failed / 被停）：续', () => {
    expect(judgeAttempt({ code: 1, stdout: '', stderr: 'TypeError: fetch failed' })).toMatchObject({
      kind: 'retry',
    });
    expect(judgeAttempt({ code: null, stdout: '', stderr: '' })).toMatchObject({ kind: 'retry' });
  });

  it('--resume 说会话不在 → 退回新起；--session-id 说号已经用了 → 改 --resume', () => {
    expect(
      judgeAttempt({ code: 1, stdout: '', stderr: 'No conversation found with session ID: x' }),
    ).toMatchObject({
      kind: 'retry',
      session: 'missing',
    });
    expect(
      judgeAttempt({ code: 1, stdout: '', stderr: 'Error: Session ID x is already in use.' }),
    ).toMatchObject({
      kind: 'retry',
      session: 'exists',
    });
  });

  it('【故意造出的失败】登录坏了、回合用完：不续，照实报', () => {
    expect(judgeAttempt({ code: 1, stdout: '', stderr: 'Invalid API key · Please run /login' }).kind).toBe(
      'fatal',
    );
    expect(
      judgeAttempt({
        code: 1,
        stdout: resultJson({ subtype: 'error_max_turns', is_error: true, result: '' }),
        stderr: '',
      }).kind,
    ).toBe('fatal');
  });

  it('退出码 0 但结果是错：不算做完', () => {
    expect(
      judgeAttempt({
        code: 0,
        stdout: resultJson({ is_error: true, result: 'API Error: 529 overloaded' }),
        stderr: '',
      }).kind,
    ).toBe('retry');
  });

  it('等多久：1、2、4……分钟，最多 10 分钟', () => {
    expect(backoffMs(1)).toBe(FIRST_BACKOFF_MS);
    expect(backoffMs(2)).toBe(2 * FIRST_BACKOFF_MS);
    expect(backoffMs(3)).toBe(4 * FIRST_BACKOFF_MS);
    expect(backoffMs(20)).toBe(MAX_BACKOFF_MS);
  });

  it('命令行：第一次定会话号，续的时候 --resume 同一个；经 general-purpose 工人角色、JSON 输出', () => {
    expect(workerArgs(SID, false)).toEqual([
      '-p',
      '--output-format',
      'json',
      '--agent',
      'general-purpose',
      '--session-id',
      SID,
    ]);
    expect(workerArgs(SID, true)).toEqual([
      '-p',
      '--output-format',
      'json',
      '--agent',
      'general-purpose',
      '--resume',
      SID,
    ]);
  });
});

/** 一个运行目录：spec + 交代 */
function runFixture(): { dir: string; spec: RunSpec } {
  const dir = join(temp(), 'acme__app__42');
  mkdirSync(dir, { recursive: true });
  const spec: RunSpec = {
    v: 1,
    repo: 'acme/app',
    issue: 42,
    title: 'Add captcha',
    repoRoot: '/repo',
    worktree: '/repo/.claude/worktrees/42-add-captcha',
    branch: 'local/42-add-captcha',
    dispatcher: 'sess-main',
    reclaude: 'C:/bin/reclaude.exe',
    env: { PATH: '/bin' },
    createdAt: '2026-10-16T10:00:00.000Z',
  };
  writeJson(runFiles(dir).spec, spec);
  writeFileSync(runFiles(dir).brief, '单 #42：Add captcha\n');
  return { dir, spec };
}

/** 假的看护环境：工人每次的输出按顺序给；时钟随 sleep 往前走 */
function fakeDeps(outputs: AttemptOutput[], o: { renewOk?: boolean } = {}) {
  let t = Date.parse('2026-10-16T10:00:00.000Z');
  const calls: { args: string[]; stdin: string; env: Record<string, string>; cwd: string }[] = [];
  const sleeps: number[] = [];
  const renews: number[] = [];
  const timers: { ms: number; stopped: boolean }[] = [];
  const deps: SuperviseDeps = {
    now: () => new Date(t),
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    pid: 777,
    newSessionId: () => SID,
    runWorker: async (w) => {
      calls.push({ args: w.args, stdin: w.stdin, env: w.env, cwd: w.cwd });
      t += 5 * 60_000;
      const next = outputs.shift();
      if (!next) throw new Error('工人多起了一次');
      return next;
    },
    renew: async () => {
      renews.push(t);
      return { ok: o.renewOk ?? true, text: '续上了' };
    },
    repeat: (_fn, ms) => {
      const timer = { ms, stopped: false };
      timers.push(timer);
      return () => {
        timer.stopped = true;
      };
    },
    log: () => {},
  };
  return { deps, calls, sleeps, renews, timers };
}

describe('superviseRun：看护到终态、网关断了从断点续', () => {
  it('【故意造出的失败】第一次网关 502、第二次做完：等 1 分钟用 --resume 同一个会话续，写 result.json（done），续过租约，心跳和续租的定时器停了', async () => {
    const { dir } = runFixture();
    const w = fakeDeps([
      {
        code: 1,
        stdout: resultJson({ is_error: true, result: 'API Error: 502 Bad Gateway', session_id: SID }),
        stderr: '',
      },
      { code: 0, stdout: resultJson({ result: 'PR #9 合了', session_id: SID }), stderr: '' },
    ]);
    const r = await superviseRun(dir, w.deps);
    expect(r).toMatchObject({ state: 'done', summary: 'PR #9 合了', attempts: 2, sessionId: SID, why: null });
    expect(w.calls.map((c) => c.args.slice(-2))).toEqual([
      ['--session-id', SID],
      ['--resume', SID],
    ]);
    expect(w.calls[0]?.stdin).toBe('单 #42：Add captcha\n');
    expect(w.calls[1]?.stdin).toBe(RESUME_PROMPT);
    expect(w.calls[0]?.env).toEqual({
      PATH: '/bin',
      FLEET_WORKER: '1',
      FLEET_WORK_RUNS_DIR: dirname(dir),
      FLEET_WORK_RUN: '2026-10-16T10:00:00.000Z',
      FLEET_WORK_SESSION: SID,
    });
    expect(w.calls[0]?.cwd).toBe('/repo/.claude/worktrees/42-add-captcha');
    expect(w.sleeps).toEqual([FIRST_BACKOFF_MS]);
    expect(w.renews.length).toBe(1);
    expect(w.timers.map((x) => x.stopped)).toEqual([true, true]);
    const f = runFiles(dir);
    expect(readJson<RunResult>(f.result)).toEqual(r);
    const s = readJson<RunStatus>(f.state);
    expect(s).toMatchObject({
      state: 'done',
      attempts: 2,
      sessionStarted: true,
      supervisorPid: 777,
      dispatcher: 'sess-main',
      lastRenewOk: true,
    });
  });

  it('【故意造出的失败】会话还没建起来就断（没输出）→ 先试 --resume，说会话不在 → 退回用原会话号新起', async () => {
    const { dir } = runFixture();
    const w = fakeDeps([
      { code: 1, stdout: '', stderr: 'API Error: 502' },
      { code: 1, stdout: '', stderr: 'Error: Session ID x is already in use.' },
      { code: 0, stdout: resultJson({ result: '好了', session_id: SID }), stderr: '' },
    ]);
    const r = await superviseRun(dir, w.deps);
    expect(r?.state).toBe('done');
    expect(w.calls.map((c) => c.args.slice(-2))).toEqual([
      ['--session-id', SID],
      ['--session-id', SID],
      ['--resume', SID],
    ]);
    // 只有真断了才等；会话号用法换一下不等
    expect(w.sleeps).toEqual([FIRST_BACKOFF_MS, 0]);

    const { dir: dir2 } = runFixture();
    const w2 = fakeDeps([
      {
        code: 1,
        stdout: resultJson({ is_error: true, result: 'API Error: 503', session_id: SID }),
        stderr: '',
      },
      { code: 1, stdout: '', stderr: 'No conversation found with session ID: x' },
      { code: 0, stdout: resultJson({ result: '好了' }), stderr: '' },
    ]);
    await superviseRun(dir2, w2.deps);
    expect(w2.calls.map((c) => c.args.slice(-2))).toEqual([
      ['--session-id', SID],
      ['--resume', SID],
      ['--session-id', SID],
    ]);
  });

  it('【故意造出的失败】看护进程自己死了（beatAt 早就不动、不是终态）：再起一个接着同一个状态续，--resume 原会话，次数接着数', async () => {
    const { dir } = runFixture();
    const stale: RunStatus = {
      v: 1,
      repo: 'acme/app',
      issue: 42,
      state: 'running',
      dispatcher: 'sess-main',
      worktree: '/repo/.claude/worktrees/42-add-captcha',
      branch: 'local/42-add-captcha',
      supervisorPid: 555,
      sessionId: 'old-session',
      sessionStarted: true,
      attempts: 3,
      startedAt: '2026-10-16T08:00:00.000Z',
      updatedAt: '2026-10-16T09:00:00.000Z',
      beatAt: new Date(Date.parse('2026-10-16T10:00:00.000Z') - BEAT_STALE_MS - 1000).toISOString(),
      lastRenewAt: null,
      lastRenewOk: null,
      lastError: '网关或网络断了',
      nextTryAt: null,
    };
    writeJson(runFiles(dir).state, stale);
    const w = fakeDeps([{ code: 0, stdout: resultJson({ result: '续上了，做完' }), stderr: '' }]);
    const r = await superviseRun(dir, w.deps);
    expect(r).toMatchObject({ state: 'done', attempts: 4, sessionId: 'old-session' });
    expect(w.calls[0]?.args.slice(-2)).toEqual(['--resume', 'old-session']);
    expect(readJson<RunStatus>(runFiles(dir).state)).toMatchObject({
      startedAt: '2026-10-16T08:00:00.000Z',
      supervisorPid: 777,
    });
  });

  it('已经有一个活着的看护进程在管（beatAt 刚动过）：回 null，不起工人、不动状态', async () => {
    const { dir } = runFixture();
    const live = { supervisorPid: 555, state: 'running', beatAt: '2026-10-16T09:59:30.000Z' } as RunStatus;
    writeJson(runFiles(dir).state, live);
    const w = fakeDeps([]);
    expect(await superviseRun(dir, w.deps)).toBeNull();
    expect(w.calls).toEqual([]);
    expect(readJson(runFiles(dir).state)).toEqual(live);
  });

  it('【故意造出的失败】登录坏了：写 result.json（failed）带原因，不续', async () => {
    const { dir } = runFixture();
    const w = fakeDeps([{ code: 1, stdout: '', stderr: 'Invalid API key · Please run /login' }]);
    const r = await superviseRun(dir, w.deps);
    expect(r).toMatchObject({ state: 'failed', attempts: 1 });
    expect(r?.why).toContain('登录');
    expect(w.calls.length).toBe(1);
  });

  it('【故意造出的失败】一直断：起满 MAX_ATTEMPTS 次落成 failed，不无限续；续租没成照实记', async () => {
    const { dir } = runFixture();
    const outs = Array.from({ length: MAX_ATTEMPTS }, () => ({
      code: 1,
      stdout: '',
      stderr: 'API Error: 502',
    }));
    const w = fakeDeps(outs, { renewOk: false });
    const r = await superviseRun(dir, w.deps);
    expect(r).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS });
    expect(r?.why).toContain(`起了 ${MAX_ATTEMPTS} 次`);
    expect(readJson<RunStatus>(runFiles(dir).state)?.lastRenewOk).toBe(false);
  });

  it('已经有 result.json：直接回它，不再起工人', async () => {
    const { dir } = runFixture();
    const done = { state: 'done', summary: 'x' } as RunResult;
    writeJson(runFiles(dir).result, done);
    const w = fakeDeps([]);
    expect(await superviseRun(dir, w.deps)).toEqual(done);
    expect(w.calls).toEqual([]);
  });
});

const ok = (stdout = ''): GhResult => ({ code: 0, stdout, stderr: '' });

/** pnpm work run 的假世界：gh、法国、git、容量、起进程都记下来 */
function runWorld(
  o: {
    enough?: boolean | null;
    lease?: boolean;
    spawnOk?: boolean;
    env?: NodeJS.ProcessEnv;
    /** 容量检查让出事件循环，用来把两个恢复叠在占位还没交接的窗口里 */
    capacityDelayMs?: number;
    spawnPid?: number;
    /** 模拟看护已启动后占位被别人换代，验证入口 finally 不会释放新占位 */
    onSpawnDetached?: () => void;
    gh?: WorkDeps['gh'];
  } = {},
) {
  const root = temp();
  const runs = join(root, 'runs');
  const repoRoot = join(root, 'repo');
  const sent: LocalClaimRequest[] = [];
  const gitCalls: string[][] = [];
  const spawned: { file: string; args: string[]; cwd?: string }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const made = new Set<string>();
  const now = new Date('2026-10-16T10:00:00.000Z');
  const env = o.env ?? { CLAUDE_CODE_SESSION_ID: 'sess-main', PATH: '/bin', GH_TOKEN: 'secret' };
  const run = (...argv: string[]) =>
    work(argv, {
      gh:
        o.gh ??
        (async (args) => {
          if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/app' }));
          if (args[0] === 'issue' && args[1] === 'view')
            return ok(JSON.stringify({ title: 'Add captcha', state: 'OPEN' }));
          if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
          if (args[0] === 'issue' && args[1] === 'edit') return ok();
          return { code: 1, stdout: '', stderr: `没想到的 gh：${args.join(' ')}` };
        }),
      post: async (body) => {
        sent.push(body);
        return { status: 200, text: JSON.stringify({ ok: true, leaseUntil: '2026-10-16T12:00:00.000Z' }) };
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      run: {
        capacity: async () => {
          if (o.capacityDelayMs !== undefined)
            await new Promise((resolve) => setTimeout(resolve, o.capacityDelayMs));
          return {
            enough: o.enough === undefined ? true : o.enough,
            text:
              o.enough === null
                ? '本机容量没查成：CIM 超时'
                : o.enough === false
                  ? '本机容量不够（空闲内存不够）'
                  : '本机容量够',
          };
        },
        spawnDetached: (file, args, opts) => {
          spawned.push({ file, args, ...opts });
          o.onSpawnDetached?.();
          return o.spawnOk === false
            ? { ok: false, why: 'WMI 返回 9' }
            : { ok: true, pid: o.spawnPid ?? 4242, how: 'wmi' };
        },
        git: async (args) => {
          gitCalls.push(args);
          if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute')
            return ok(`${join(repoRoot, '.git')}\n`);
          if (args[0] === 'rev-parse' && args[1] === '--verify') return { code: 1, stdout: '', stderr: '' };
          if (args[0] === 'worktree' && args[1] === 'add') made.add(args[2] ?? '');
          return ok();
        },
        env,
        selectSessionId,
        now: () => now,
        runsRoot: runs,
        repoRoot,
        node: '/node',
        supervisor: '/sup.ts',
        findReclaude: () => 'C:/bin/reclaude.exe',
        hasLease: () => o.lease ?? false,
        exists: (p) => made.has(p) || existsSync(p),
        readText: (p) => readFileSync(p, 'utf8'),
      },
    });
  return {
    run,
    runs,
    repoRoot,
    env,
    sent,
    gitCalls,
    spawned,
    out,
    err,
    dir: runDir(runs, 'acme/app', 42),
    now,
  };
}

describe('pnpm work run：派之前过容量、领单、建工作树，经脱离的看护进程起', () => {
  it.each(['claude', 'codex'] as const)(
    '%s 生产的真实 spec 经同步 Stop 消费终态：运行中不报完成、隔离其他会话、只消费一次',
    async (cli) => {
      const id = `${cli}-dispatcher`;
      const w = runWorld({
        env:
          cli === 'claude'
            ? { CLAUDE_CODE_SESSION_ID: id }
            : { CODEX_THREAD_ID: id, CODEX_SESSION_ID: 'different-root-session' },
      });
      expect(await w.run('run', '42'), w.err.join('\n')).toBe(0);
      expect(readJson<RunSpec>(runFiles(w.dir).spec)?.dispatcher).toBe(id);
      // 派工断言保留不同root别名；无人值守阶段使用可证当前rollout的独立临时身份。
      const codexHome = join(temp(), 'codex-home');
      const date = join(codexHome, 'sessions', '2026', '10', '19');
      mkdirSync(date, { recursive: true });
      writeFileSync(
        join(date, `rollout-isolated-${id}.jsonl`),
        `${JSON.stringify({
          type: 'session_meta',
          payload: { id, source: 'cli' },
        })}\n`,
      );
      const env = {
        ...process.env,
        CLAUDE_CODE_SESSION_ID: '',
        CODEX_THREAD_ID: '',
        ...w.env,
        CODEX_SESSION_ID: '',
        CODEX_HOME: codexHome,
        FLEET_HEADLESS: '',
        FLEET_WORKER: '',
        FLEET_UNATTENDED_DIR: join(temp(), 'unattended'),
        FLEET_WORK_RUNS_DIR: w.runs,
      };
      const stop = fileURLToPath(new URL('../../../agents/hooks/stop.mjs', import.meta.url));
      const consume = (sessionId: string) => {
        const r = runChild(process.execPath, [stop], {
          cwd: temp(),
          env,
          input: JSON.stringify({ session_id: sessionId }),
        });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout;
      };
      expect(unattended(['on'], { env, out: () => {}, err: () => {} })).toBe(0);
      writeJson(runFiles(w.dir).state, { state: 'running', beatAt: new Date().toISOString() });
      expect(consume(id)).not.toContain('verified production result');
      writeJson(runFiles(w.dir).result, {
        state: 'done',
        issue: 42,
        summary: 'verified production result',
        attempts: 1,
      });
      const other = { ...env, CLAUDE_CODE_SESSION_ID: 'other-session', CODEX_THREAD_ID: '' };
      expect(unattended(['on'], { env: other, out: () => {}, err: () => {} })).toBe(0);
      expect(consume('other-session')).not.toContain('verified production result');
      expect(JSON.parse(consume(id))).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('verified production result'),
      });
      expect(consume(id)).not.toContain('verified production result');
      expect(w.out.join('\n')).toContain('Codex 不会因后台完成主动开启新轮');
    },
  );

  it.each([{}, { CODEX_SESSION_ID: 'root-only' }])(
    '缺真实会话归属 %j 明说未关联，保留可手工读取结果',
    async (env) => {
      const w = runWorld({ env });
      expect(await w.run('run', '42')).toBe(0);
      expect(readJson<RunSpec>(runFiles(w.dir).spec)?.dispatcher).toBeNull();
      expect(w.out.join('\n')).toContain('dispatcher=null');
      expect(w.out.join('\n')).toContain('pnpm work runs');
    },
  );

  it.each([
    { CLAUDE_CODE_SESSION_ID: '../bad', CODEX_THREAD_ID: 'valid-thread' },
    { CODEX_THREAD_ID: '../bad', CODEX_SESSION_ID: 'valid-root' },
    { CLAUDE_CODE_SESSION_ID: 'claude-session', CODEX_THREAD_ID: 'codex-thread' },
  ])('非法高优先或跨 CLI 冲突 %j 在领单、写 spec、派工前拒绝', async (env) => {
    const w = runWorld({ env });
    expect(await w.run('run', '42')).toBe(1);
    expect(w.err.join('\n')).toMatch(/不合法|冲突/);
    expect(w.sent).toEqual([]);
    expect(w.spawned).toEqual([]);
    expect(existsSync(runFiles(w.dir).spec)).toBe(false);
  });

  it.each(['original-session', null])(
    '续跑保留原归属 %j，不偷绑当前会话或补填旧 null',
    async (dispatcher) => {
      const w = runWorld({ env: { CODEX_THREAD_ID: 'new-thread' } });
      mkdirSync(w.dir, { recursive: true });
      writeJson(runFiles(w.dir).spec, { worktree: '/wt', dispatcher });
      writeJson(runFiles(w.dir).state, { state: 'retrying', beatAt: '2026-10-16T09:00:00.000Z' });
      const before = readFileSync(runFiles(w.dir).spec, 'utf8');
      expect(await w.run('run', '42')).toBe(0);
      expect(readFileSync(runFiles(w.dir).spec, 'utf8')).toBe(before);
      expect(w.sent).toEqual([]);
    },
  );

  it('派出去：领单、从 origin/main 建 local/42- 工作树、写交代和 spec（dispatcher 是本会话、只带 PATH 不带令牌）、看护进程经 spawnDetached 起', async () => {
    const w = runWorld();
    expect(await w.run('run', '42'), w.err.join('\n')).toBe(0);
    expect(w.sent).toEqual([{ action: 'claim', repo: 'acme/app', issue: 42, title: 'Add captcha' }]);
    const worktree = join(w.repoRoot, '.claude', 'worktrees', '42-add-captcha');
    expect(w.gitCalls).toContainEqual(['fetch', 'origin', 'main']);
    expect(w.gitCalls).toContainEqual([
      'worktree',
      'add',
      worktree,
      '-b',
      'local/42-add-captcha',
      'origin/main',
    ]);
    const spec = readJson<RunSpec>(runFiles(w.dir).spec);
    expect(spec).toMatchObject({
      repo: 'acme/app',
      issue: 42,
      worktree,
      branch: 'local/42-add-captcha',
      dispatcher: 'sess-main',
      reclaude: 'C:/bin/reclaude.exe',
      env: { PATH: '/bin' },
    });
    const brief = readFileSync(runFiles(w.dir).brief, 'utf8');
    expect(brief).toContain('gh issue view 42');
    expect(brief).toContain('受管 PR 建好后不自动挂合并');
    expect(brief).toContain('先 pnpm work feedback 42 读取完整意见');
    expect(brief).toContain('由审查方 resolve，工人不能代替审查方解除退回');
    expect(brief).toContain('再 pnpm work deliver 42');
    expect(brief).toContain('gh pr checks <PR号> --watch --fail-fast 只等检查结果');
    expect(brief).toContain('gh pr view <PR号> --json state,mergedAt 核实真实合并');
    expect(brief).not.toContain('等到合并或红');
    expect(w.spawned).toEqual([{ file: '/node', args: ['/sup.ts', w.dir], cwd: w.repoRoot }]);
    expect(w.out.join('\n')).toContain('派出去了 #42：看护进程 4242');
    expect(w.out.join('\n')).toContain('同步 Stop 消费一次终态');
  });

  it('【故意造出的失败】容量不够、没查成：都不派，不领单、不起进程', async () => {
    for (const enough of [false, null] as const) {
      const w = runWorld({ enough });
      expect(await w.run('run', '42')).toBe(1);
      expect(w.sent).toEqual([]);
      expect(w.spawned).toEqual([]);
      expect(w.err.join('\n')).toContain(enough === null ? '没查成不当成够' : '等一个工人收口');
    }
  });

  it('本机已经领着：不再领', async () => {
    const w = runWorld({ lease: true });
    expect(await w.run('run', '42')).toBe(0);
    expect(w.sent).toEqual([]);
    expect(w.out.join('\n')).toContain('不再领');
  });

  it('【故意造出的失败】已经有一个在跑（看护进程心跳刚动）：不派第二个', async () => {
    const w = runWorld();
    mkdirSync(w.dir, { recursive: true });
    writeJson(runFiles(w.dir).state, { state: 'running', beatAt: w.now.toISOString() });
    expect(await w.run('run', '42')).toBe(1);
    expect(w.err.join('\n')).toContain('已经有工人在跑');
    expect(w.spawned).toEqual([]);
  });

  it('看护进程没了：再跑一次接着续——不领单、不建工作树，清掉「叫醒过」的标记，起看护进程', async () => {
    const w = runWorld();
    mkdirSync(w.dir, { recursive: true });
    writeJson(runFiles(w.dir).spec, { worktree: '/wt' });
    writeJson(runFiles(w.dir).state, { state: 'retrying', beatAt: '2026-10-16T09:00:00.000Z' });
    writeFileSync(runFiles(w.dir).reported, 'x');
    expect(await w.run('run', '42'), w.err.join('\n')).toBe(0);
    expect(w.sent).toEqual([]);
    expect(w.gitCalls).toEqual([]);
    expect(existsSync(runFiles(w.dir).reported)).toBe(false);
    expect(w.spawned.length).toBe(1);
    expect(w.out.join('\n')).toContain('接着上次的会话续');
  });

  it('【故意造出的失败】上次已经终了：不加 --again 不重来；加了旧记录改名留着', async () => {
    const w = runWorld();
    mkdirSync(w.dir, { recursive: true });
    writeJson(runFiles(w.dir).result, { state: 'done' });
    expect(await w.run('run', '42')).toBe(1);
    expect(w.err.join('\n')).toContain('--again');
    expect(await w.run('run', '42', '--again'), w.err.join('\n')).toBe(0);
    expect(existsSync(runFiles(w.dir).result)).toBe(false);
    expect(existsSync(runFiles(w.dir).spec)).toBe(true);
  });

  it('【故意造出的失败】看护进程没起成：退出码 1，照实说为什么、怎么续', async () => {
    const w = runWorld({ spawnOk: false });
    expect(await w.run('run', '42')).toBe(1);
    expect(w.err.join('\n')).toContain('看护进程没起成：WMI 返回 9');
  });

  it('pnpm work runs：列出在跑、终了、看护进程没了的', async () => {
    const w = runWorld();
    expect(await w.run('runs')).toBe(0);
    expect(w.out).toEqual(['没有 pnpm work run 派过的工人']);
    mkdirSync(w.dir, { recursive: true });
    writeJson(runFiles(w.dir).state, {
      issue: 42,
      repo: 'acme/app',
      state: 'retrying',
      attempts: 2,
      beatAt: '2026-10-16T09:00:00.000Z',
    });
    w.out.length = 0;
    expect(await w.run('runs')).toBe(0);
    expect(w.out[0]).toContain('#42（acme/app） 看护进程没了');
  });
});

const HEAD = 'a'.repeat(40);
const MERGE = 'c'.repeat(40);

function mergedPull(n: number, body: string, repo = 'acme/app', extra: Record<string, unknown> = {}) {
  return {
    number: n,
    state: 'closed',
    merged: true,
    merged_at: '2026-10-19T01:36:55Z',
    merge_commit_sha: MERGE,
    title: 'delivered elsewhere',
    body,
    head: { ref: `fleet/${n}-other`, sha: HEAD },
    base: { repo: { full_name: repo } },
    ...extra,
  };
}

describe('supervisor独立交付核验与精确恢复', () => {
  it('审查未结不续工人：停在 waiting，复核通过后才记完成，不再起 CLI', async () => {
    const { dir } = runFixture();
    const w = fakeDeps([{ code: 0, stdout: resultJson({ result: '做完了', session_id: SID }), stderr: '' }]);
    let checks = 0;
    w.deps.validateDelivery = async () => {
      checks += 1;
      if (checks === 1) throw new DeliveryCheckError('review', '本机审查退回尚未解决；不能记完成');
    };
    const first = await superviseRun(dir, w.deps);
    expect(first?.state).toBe('waiting');
    expect(w.calls).toHaveLength(1);
    expect(w.sleeps).toEqual([]);
    expect(readJson(runFiles(dir).result)).toBeNull();
    expect(readJson<RunStatus>(runFiles(dir).state)?.hold?.kind).toBe('review');
    expect(readJson<RunStatus>(runFiles(dir).state)?.sessionId).toBe(SID);
    const second = await superviseRun(dir, w.deps);
    expect(second?.state).toBe('done');
    expect(checks).toBe(2);
    expect(w.calls).toHaveLength(1);
  });
  it('恢复读源失败不派工人、不伪造空意见或完成', async () => {
    const { dir } = runFixture();
    const w = fakeDeps([]);
    w.deps.feedbackContext = async () => {
      throw new Error('GitHub未读成');
    };
    await expect(superviseRun(dir, w.deps)).rejects.toThrow('GitHub未读成');
    expect(w.calls).toHaveLength(0);
    expect(readJson(runFiles(dir).result)).toBeNull();
  });
  it('历史done不能用来结清新退回，重启会重新核验并纠正终态', async () => {
    const { dir } = runFixture();
    const w = fakeDeps([{ code: 0, stdout: resultJson({ result: 'done', session_id: SID }), stderr: '' }]);
    expect((await superviseRun(dir, w.deps))?.state).toBe('done');
    w.deps.validateDelivery = async () => {
      throw new Error('新增退回未解决');
    };
    const reread = await superviseRun(dir, w.deps);
    expect(reread?.state).toBe('failed');
    expect(reread?.why).toContain('新增退回');
    expect(readJson<RunResult>(runFiles(dir).result)?.state).toBe('failed');
    expect(w.calls).toHaveLength(1);
  });

  it('正常本分支交付：核验通过就 done，只起一次工人', async () => {
    const { dir } = runFixture();
    const w = fakeDeps([
      { code: 0, stdout: resultJson({ result: 'PR #9 合了', session_id: SID }), stderr: '' },
    ]);
    let checks = 0;
    w.deps.validateDelivery = async () => {
      checks += 1;
    };
    const result = await superviseRun(dir, w.deps);
    expect(result).toMatchObject({ state: 'done', summary: 'PR #9 合了', why: null });
    expect(checks).toBe(1);
    expect(w.calls).toHaveLength(1);
  });

  it('交付核验的网络失败只退避复核，不起第二个工人；读通后记完成', async () => {
    const { dir } = runFixture();
    const w = fakeDeps([{ code: 0, stdout: resultJson({ result: '做完了', session_id: SID }), stderr: '' }]);
    let checks = 0;
    w.deps.validateDelivery = async () => {
      checks += 1;
      if (checks < 3) throw new DeliveryCheckError('retry', '受管PR读取失败：socket hang up');
    };
    const result = await superviseRun(dir, w.deps);
    expect(result?.state).toBe('done');
    expect(checks).toBe(3);
    expect(w.calls).toHaveLength(1);
    expect(w.sleeps).toEqual([FIRST_BACKOFF_MS, 2 * FIRST_BACKOFF_MS]);
  });

  it('【故意造出的失败】交付核验一直读不成：到次数后停住，不记 done，也不再起工人', async () => {
    const { dir } = runFixture();
    const w = fakeDeps([{ code: 0, stdout: resultJson({ result: '做完了', session_id: SID }), stderr: '' }]);
    let checks = 0;
    w.deps.validateDelivery = async () => {
      checks += 1;
      throw new Error('GitHub退回读取失败：timed out');
    };
    const result = await superviseRun(dir, w.deps);
    expect(result?.state).toBe('waiting');
    expect(checks).toBe(MAX_ATTEMPTS);
    expect(w.calls).toHaveLength(1);
    expect(w.sleeps).toHaveLength(MAX_ATTEMPTS - 1);
    expect(readJson(runFiles(dir).result)).toBeNull();
    expect(readJson<RunStatus>(runFiles(dir).state)?.lastError).toContain('没读成');
  });

  it('【故意造出的失败】读到认不出的结果不当已交付，不续工人', async () => {
    const { dir } = runFixture();
    const w = fakeDeps([{ code: 0, stdout: resultJson({ result: '做完了', session_id: SID }), stderr: '' }]);
    w.deps.validateDelivery = async () => {
      throw new Error('受管PR列表认不出，不能当已交付');
    };
    const result = await superviseRun(dir, w.deps);
    expect(result?.state).toBe('waiting');
    expect(result && 'why' in result ? result.why : '').toContain('认不出');
    expect(w.calls).toHaveLength(1);
    expect(w.sleeps).toEqual([]);
    expect(readJson<RunResult>(runFiles(dir).result)?.state).not.toBe('done');
  });

  it('等待复核时另一个看护还在：不启动工人、不改状态', async () => {
    const { dir } = runFixture();
    const live = {
      state: 'waiting',
      supervisorPid: 555,
      beatAt: '2026-10-16T09:59:30.000Z',
      hold: { kind: 'review', why: '审查未结' },
      sessionId: SID,
    };
    writeJson(runFiles(dir).state, live);
    const w = fakeDeps([{ code: 0, stdout: resultJson({ result: '不该跑', session_id: SID }), stderr: '' }]);
    expect(await superviseRun(dir, w.deps)).toBeNull();
    expect(w.calls).toEqual([]);
    expect(readJson(runFiles(dir).state)).toEqual(live);
  });
});

describe('他分支已交付与恢复不派工', () => {
  function world(
    acceptance: 'open' | 'settled' | 'unknown',
    pull = mergedPull(3194, '**需求**：Closes #42\n'),
  ) {
    const { dir, spec } = runFixture();
    const tree = join(temp(), 'wt');
    mkdirSync(tree);
    writeFileSync(join(tree, 'unpushed.txt'), 'keep-me');
    spec.worktree = tree;
    writeJson(runFiles(dir).spec, spec);
    const calls: string[][] = [];
    const gh: Parameters<typeof validateManagedDelivery>[0] = async (args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'list' && args.includes('--head')) {
        return { code: 0, stdout: '[]', stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        return { code: 0, stdout: JSON.stringify([{ number: 3194 }]), stderr: '' };
      }
      if (args[0] === 'api') return { code: 0, stdout: JSON.stringify(pull), stderr: '' };
      if (args[0] === 'issue') return { code: 0, stdout: JSON.stringify({ state: 'CLOSED' }), stderr: '' };
      if (args.includes('create') || args.includes('merge')) return { code: 0, stdout: 'forged', stderr: '' };
      return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    };
    const w = fakeDeps([
      { code: 0, stdout: resultJson({ result: '按审查停下', session_id: SID }), stderr: '' },
    ]);
    w.deps.validateDelivery = (s) =>
      validateManagedDelivery(gh, s, true, dirname(dir), async () => acceptance);
    return { dir, tree, calls, w };
  }

  it('他分支已合且有本机未推成果、验收未结：waiting，不记 done，不续工人，成果还在', async () => {
    const { dir, tree, calls, w } = world('open');
    const first = await superviseRun(dir, w.deps);
    expect(first?.state).toBe('waiting');
    expect(w.calls).toHaveLength(1);
    expect(readJson(runFiles(dir).result)).toBeNull();
    expect(readFileSync(join(tree, 'unpushed.txt'), 'utf8')).toBe('keep-me');
    const status = readJson<RunStatus>(runFiles(dir).state);
    expect(status).toMatchObject({
      state: 'waiting',
      sessionId: SID,
      worktree: tree,
      supervisorPid: null,
      hold: {
        kind: 'external',
        acceptance: 'open',
        external: { repo: 'acme/app', pr: 3194, head: HEAD, mergeCommit: MERGE },
      },
    });
    expect(calls.some((c) => c.includes('create') || c.includes('merge'))).toBe(false);
    const again = await superviseRun(dir, w.deps);
    expect(again?.state).toBe('waiting');
    expect(w.calls).toHaveLength(1);
    expect(readFileSync(join(tree, 'unpushed.txt'), 'utf8')).toBe('keep-me');
  });

  it('外部交付且验收已结清：stopped，不是 done；再进一次不起工人', async () => {
    const { dir, tree, w } = world('settled');
    const first = await superviseRun(dir, w.deps);
    expect(first?.state).toBe('stopped');
    expect(first?.state).not.toBe('done');
    expect(readJson<RunResult>(runFiles(dir).result)?.state).toBe('stopped');
    expect(readJson<RunResult>(runFiles(dir).result)?.why).toContain('PR #3194');
    expect(readJson<RunResult>(runFiles(dir).result)?.why).toContain(MERGE);
    expect(readFileSync(join(tree, 'unpushed.txt'), 'utf8')).toBe('keep-me');
    const again = await superviseRun(dir, w.deps);
    expect(again?.state).toBe('stopped');
    expect(w.calls).toHaveLength(1);
  });

  it('验收没读成：有外部事实也只 waiting，不当已交付', async () => {
    const { dir, w } = world('unknown');
    const result = await superviseRun(dir, w.deps);
    expect(result?.state).toBe('waiting');
    expect(readJson<RunStatus>(runFiles(dir).state)?.hold?.acceptance).toBe('unknown');
    expect(readJson(runFiles(dir).result)).toBeNull();
    expect(w.calls).toHaveLength(1);
  });

  it('外部事实齐了但本机退回意图还在：waiting，不记 stopped，不再起工人', async () => {
    const { dir } = runFixture();
    const w = fakeDeps([{ code: 0, stdout: resultJson({ result: '停下', session_id: SID }), stderr: '' }]);
    w.deps.validateDelivery = async () => {
      throw new DeliveryCheckError(
        'external',
        '需求已由同仓其他真实PR #3194 交付。本机退回意图仍保留，不能终结。',
        {
          acceptance: 'settled',
          external: {
            repo: 'acme/app',
            pr: 3194,
            head: HEAD,
            mergeCommit: MERGE,
            mergedAt: '2026-10-19T01:36:55Z',
          },
          retain: true,
        },
      );
    };
    const result = await superviseRun(dir, w.deps);
    expect(result?.state).toBe('waiting');
    expect(readJson(runFiles(dir).result)).toBeNull();
    expect(readJson<RunStatus>(runFiles(dir).state)?.hold?.kind).toBe('external');
    expect(w.calls).toHaveLength(1);
    expect(w.sleeps).toEqual([]);
  });
});

describe('pnpm work run 对等待和已停不重派', () => {
  it('waiting 再跑只起看护复核；心跳还在或 --again 都不再派', async () => {
    const w = runWorld();
    mkdirSync(w.dir, { recursive: true });
    writeJson(runFiles(w.dir).spec, { worktree: '/wt', repo: 'acme/app', issue: 42, branch: 'local/42-x' });
    writeJson(runFiles(w.dir).state, {
      state: 'waiting',
      supervisorPid: null,
      beatAt: '2026-10-16T09:00:00.000Z',
      sessionId: SID,
      hold: { kind: 'review', why: '审查未结' },
      lastError: '审查未结',
    });
    expect(await w.run('run', '42'), w.err.join('\n')).toBe(0);
    expect(w.sent).toEqual([]);
    expect(w.gitCalls).toEqual([]);
    expect(w.spawned).toHaveLength(1);
    expect(w.out.join('\n')).toContain('复核等待，不新开工人');
    writeJson(runFiles(w.dir).state, {
      state: 'waiting',
      supervisorPid: 4242,
      beatAt: w.now.toISOString(),
      hold: { kind: 'review', why: '审查未结' },
    });
    w.spawned.length = 0;
    w.err.length = 0;
    expect(await w.run('run', '42')).toBe(1);
    expect(w.err.join('\n')).toContain('已经有工人在跑');
    expect(w.spawned).toEqual([]);
    w.err.length = 0;
    expect(await w.run('run', '42', '--again')).toBe(1);
    expect(w.err.join('\n')).toContain('不重派');
    expect(w.spawned).toEqual([]);
  });

  it('stopped 不再派工，--again 也不另开', async () => {
    const w = runWorld();
    mkdirSync(w.dir, { recursive: true });
    writeJson(runFiles(w.dir).spec, { worktree: '/wt', repo: 'acme/app', issue: 42 });
    writeJson(runFiles(w.dir).state, { state: 'stopped', supervisorPid: null, beatAt: w.now.toISOString() });
    writeJson(runFiles(w.dir).result, { state: 'stopped', why: '需求已由其他真实PR交付', attempts: 1 });
    expect(await w.run('run', '42')).toBe(1);
    expect(w.err.join('\n')).toContain('不再派工');
    expect(w.spawned).toEqual([]);
    w.err.length = 0;
    expect(await w.run('run', '42', '--again')).toBe(1);
    expect(w.err.join('\n')).toContain('不重派');
    expect(w.spawned).toEqual([]);
  });

  it('pnpm work runs 把等待和已停写出来', () => {
    const now = new Date('2026-10-16T10:00:00.000Z');
    const waiting = renderRuns(
      [
        {
          dir: '/runs/42',
          problem: null,
          result: null,
          status: {
            issue: 42,
            repo: 'acme/app',
            state: 'waiting',
            attempts: 1,
            beatAt: '2026-10-16T09:00:00.000Z',
            lastError: '审查未结',
            worktree: '/wt',
            sessionId: SID,
            supervisorPid: null,
          } as RunStatus,
        },
      ],
      now,
    );
    expect(waiting[0]).toContain('在等，不续工人');
    expect(waiting[0]).toContain('/wt');
    const stopped = renderRuns(
      [
        {
          dir: '/runs/42',
          problem: null,
          status: { issue: 42, repo: 'acme/app', state: 'stopped' } as RunStatus,
          result: {
            state: 'stopped',
            why: '需求已由 PR #3194 交付',
            attempts: 1,
            finishedAt: '2026-10-19T01:36:55Z',
            summary: '',
          } as RunResult,
        },
      ],
      now,
    );
    expect(stopped[0]).toContain('已停，不再派工');
    expect(stopped[0]).toContain('PR #3194');
  });
});

function checkpointOf(v: RunStatus | null): RunStatus {
  if (!v) throw new Error('核验前没读到只复核状态');
  return v;
}

function deadPid(): number {
  for (let pid = 1 << 22; pid < (1 << 22) + 4096; pid++) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('没找到已退出的进程号');
}

describe('恢复入口的原子占位', () => {
  function lostRun(w: ReturnType<typeof runWorld>) {
    mkdirSync(w.dir, { recursive: true });
    writeJson(runFiles(w.dir).spec, {
      worktree: '/wt',
      dispatcher: 'sess-main',
      repo: 'acme/app',
      issue: 42,
    });
    writeJson(runFiles(w.dir).state, {
      state: 'retrying',
      beatAt: '2026-10-16T09:00:00.000Z',
      sessionId: SID,
      attempts: 4,
      supervisorPid: null,
    });
  }

  it('占位进程还活着时再恢复不起第二个，也不改 state/result', async () => {
    const w = runWorld();
    lostRun(w);
    const token = claimRunLock(w.dir, SUPERVISOR_START_LOCK, process.pid, w.now);
    expect(token).toBeTruthy();
    const before = readFileSync(runFiles(w.dir).state, 'utf8');
    expect(await w.run('run', '42')).toBe(1);
    expect(w.spawned).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(w.err.join('\n')).toContain('已有恢复占位，不再并发起工人');
    expect(readFileSync(runFiles(w.dir).state, 'utf8')).toBe(before);
    expect(existsSync(runFiles(w.dir).result)).toBe(false);
    if (token) releaseRunLock(w.dir, SUPERVISOR_START_LOCK, token);
  });

  it('两个并发恢复都判失联时只起一个看护，败的那个不改 state/result', async () => {
    const w = runWorld({ capacityDelayMs: 30 });
    lostRun(w);
    const before = readFileSync(runFiles(w.dir).state, 'utf8');
    const codes = await Promise.all([w.run('run', '42'), w.run('run', '42')]);
    expect(codes.filter((c) => c === 0)).toHaveLength(1);
    expect(codes.filter((c) => c === 1)).toHaveLength(1);
    expect(w.spawned).toHaveLength(1);
    expect(w.err.join('\n')).toContain('已有恢复占位，不再并发起工人');
    expect(readFileSync(runFiles(w.dir).state, 'utf8')).toBe(before);
    expect(existsSync(runFiles(w.dir).result)).toBe(false);
    expect(w.sent).toEqual([]);
  });

  it('心跳还没写上、看护进程号仍活着：再恢复不另起', async () => {
    const w = runWorld({ spawnPid: process.pid });
    lostRun(w);
    expect(await w.run('run', '42'), w.err.join('\n')).toBe(0);
    expect(w.spawned).toHaveLength(1);
    expect(runLockHeld(w.dir, SUPERVISOR_START_LOCK, w.now)).toBe(true);
    w.spawned.length = 0;
    w.err.length = 0;
    expect(await w.run('run', '42')).toBe(1);
    expect(w.spawned).toEqual([]);
    expect(w.err.join('\n')).toContain('已有恢复占位，不再并发起工人');
  });

  it('死掉的占位可以接手，只起一个', async () => {
    const w = runWorld();
    lostRun(w);
    const pid = deadPid();
    mkdirSync(join(w.dir, SUPERVISOR_START_LOCK));
    writeJson(join(w.dir, SUPERVISOR_START_LOCK, 'owner.json'), {
      pid,
      token: 'stale',
      claimedAt: '2026-10-16T09:00:00.000Z',
    });
    expect(runLockHeld(w.dir, SUPERVISOR_START_LOCK, w.now)).toBe(false);
    expect(await w.run('run', '42'), w.err.join('\n')).toBe(0);
    expect(w.spawned).toHaveLength(1);
  });

  it('每次占位发布一个只增不减的代次，放开只做标记，下一代才清旧代', () => {
    const dir = join(temp(), 'generation');
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, SUPERVISOR_START_LOCK);
    const first = claimRunLock(dir, SUPERVISOR_START_LOCK, process.pid, new Date());
    expect(first).toBeTruthy();
    expect(readJson<{ token: string }>(join(lock, 'gen-1', 'generation.json'))?.token).toBe(first);
    expect(readJson<{ token: string }>(join(lock, 'gen-1', 'owner.json'))?.token).toBe(first);
    if (!first) return;
    releaseRunLock(dir, SUPERVISOR_START_LOCK, first);
    expect(existsSync(join(lock, 'gen-1', 'released.json'))).toBe(true);
    expect(runLockHeld(dir, SUPERVISOR_START_LOCK, new Date())).toBe(false);
    const second = claimRunLock(dir, SUPERVISOR_START_LOCK, process.pid, new Date());
    expect(second).toBeTruthy();
    expect(readJson<{ token: string }>(join(lock, 'gen-2', 'owner.json'))?.token).toBe(second);
    expect(existsSync(join(lock, 'gen-1'))).toBe(false);
    // 旧 token 放不掉新一代
    releaseRunLock(dir, SUPERVISOR_START_LOCK, first);
    expect(runLockHeld(dir, SUPERVISOR_START_LOCK, new Date())).toBe(true);
    if (second) releaseRunLock(dir, SUPERVISOR_START_LOCK, second);
  });

  it('owner 进程已死的一代可以接替，接替只建下一代', () => {
    const dir = join(temp(), 'dead-generation');
    mkdirSync(dir, { recursive: true });
    const dead = claimRunLock(dir, SUPERVISOR_START_LOCK, deadPid(), new Date());
    expect(dead).toBeTruthy();
    expect(runLockHeld(dir, SUPERVISOR_START_LOCK, new Date())).toBe(false);
    const token = claimRunLock(dir, SUPERVISOR_START_LOCK, process.pid, new Date());
    expect(token).toBeTruthy();
    expect(readJson<{ token: string }>(join(dir, SUPERVISOR_START_LOCK, 'gen-2', 'owner.json'))?.token).toBe(
      token,
    );
    expect(claimRunLock(dir, SUPERVISOR_START_LOCK, process.pid, new Date())).toBeNull();
    if (token) releaseRunLock(dir, SUPERVISOR_START_LOCK, token);
  });

  it('看护没起成就放开占位，下一次还能占上', async () => {
    const w = runWorld({ spawnOk: false });
    lostRun(w);
    expect(await w.run('run', '42')).toBe(1);
    expect(w.err.join('\n')).toContain('看护进程没起成');
    expect(runLockHeld(w.dir, SUPERVISOR_START_LOCK, w.now)).toBe(false);
    const token = claimRunLock(w.dir, SUPERVISOR_START_LOCK, process.pid, w.now);
    expect(token).toBeTruthy();
    if (token) releaseRunLock(w.dir, SUPERVISOR_START_LOCK, token);
  });

  it('旧版本留下的活占位（根 owner 或候选）照样算占着，升级时不抢', () => {
    const dir = join(temp(), 'legacy-live');
    mkdirSync(join(dir, SUPERVISOR_START_LOCK, 'candidates', 'old'), { recursive: true });
    writeJson(join(dir, SUPERVISOR_START_LOCK, 'candidates', 'old', 'owner.json'), {
      pid: process.pid,
      token: 'old-candidate',
      claimedAt: '2026-10-16T09:00:00.000Z',
    });
    expect(runLockHeld(dir, SUPERVISOR_START_LOCK, new Date())).toBe(true);
    expect(claimRunLock(dir, SUPERVISOR_START_LOCK, process.pid, new Date())).toBeNull();
    expect(existsSync(join(dir, SUPERVISOR_START_LOCK, 'gen-1'))).toBe(false);
  });

  it('主锁已新建但 owner 尚未发布时，另一恢复者拒绝回收或覆盖', () => {
    const dir = join(temp(), 'publish-window');
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, SUPERVISOR_START_LOCK);
    mkdirSync(lock);
    // 模拟 A 已完成 mkdir、尚未写 owner.json；新鲜且无归属的目录仍是占位。
    expect(runLockHeld(dir, SUPERVISOR_START_LOCK, new Date())).toBe(true);
    expect(claimRunLock(dir, SUPERVISOR_START_LOCK, process.pid, new Date())).toBeNull();
    writeJson(join(lock, 'owner.json'), {
      pid: process.pid,
      token: 'published-by-a',
      claimedAt: new Date().toISOString(),
    });
    expect(claimRunLock(dir, SUPERVISOR_START_LOCK, process.pid, new Date())).toBeNull();
    expect(readJson<{ token: string }>(join(lock, 'owner.json'))?.token).toBe('published-by-a');
  });

  it('看护已启动但占位交接失败时，不释放后来接手的占位', async () => {
    let replacement = false;
    const w = runWorld({
      onSpawnDetached: () => {
        const lock = join(w.runs, 'acme__app__42', SUPERVISOR_START_LOCK);
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        writeJson(join(lock, 'owner.json'), {
          pid: process.pid,
          token: 'replacement',
          claimedAt: w.now.toISOString(),
        });
        replacement = true;
      },
    });
    expect(await w.run('run', '42')).toBe(1);
    expect(w.err.join('\n')).toContain('占位没交接');
    expect(replacement).toBe(true);
    expect(runLockHeld(w.dir, SUPERVISOR_START_LOCK, w.now)).toBe(true);
    rmSync(join(w.dir, SUPERVISOR_START_LOCK), { recursive: true, force: true });
  });

  it('两个进程同时占同一把锁，只有一个占上', async () => {
    const dir = join(temp(), 'lock');
    mkdirSync(dir);
    const mod = pathToFileURL(fileURLToPath(new URL('../src/work-run.ts', import.meta.url))).href;
    const script = [
      'const { claimRunLock, SUPERVISOR_START_LOCK } = await import(process.env.FLEET_LOCK_MOD);',
      'const token = claimRunLock(process.env.FLEET_LOCK_DIR, SUPERVISOR_START_LOCK, process.pid, new Date());',
      'if (!token) process.stdout.write("lost\\n");',
      'else { process.stdout.write("won\\n"); await new Promise((r) => setTimeout(r, 400)); }',
    ].join('\n');
    const once = () =>
      new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--experimental-strip-types', '--input-type=module', '-e', script],
          {
            env: { ...process.env, FLEET_LOCK_MOD: mod, FLEET_LOCK_DIR: dir },
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b: Buffer) => {
          stdout += b;
        });
        child.stderr.on('data', (b: Buffer) => {
          stderr += b;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ stdout, stderr, code }));
      });
    const [a, b] = await Promise.all([once(), once()]);
    const detail = `${a.stderr}\n${b.stderr}`;
    expect(
      [a.stdout.trim(), b.stdout.trim()].filter((s) => s === 'won'),
      detail,
    ).toHaveLength(1);
    expect(
      [a.stdout.trim(), b.stdout.trim()].filter((s) => s === 'lost'),
      detail,
    ).toHaveLength(1);
  });

  it('两个进程同时接手死 owner，只有一个能发布新代 owner', async () => {
    const dir = join(temp(), 'stale-lock');
    mkdirSync(dir);
    mkdirSync(join(dir, SUPERVISOR_START_LOCK));
    mkdirSync(join(dir, `${SUPERVISOR_START_LOCK}.reclaim`));
    const stale = deadPid();
    writeJson(join(dir, SUPERVISOR_START_LOCK, 'owner.json'), {
      pid: stale,
      token: 'old-generation',
      claimedAt: '2026-10-16T09:00:00.000Z',
    });
    writeJson(join(dir, `${SUPERVISOR_START_LOCK}.reclaim`, 'owner.json'), {
      pid: stale,
      token: 'old-reclaim-generation',
      claimedAt: '2026-10-16T09:00:00.000Z',
    });
    const mod = pathToFileURL(fileURLToPath(new URL('../src/work-run.ts', import.meta.url))).href;
    const script = [
      'const { claimRunLock, SUPERVISOR_START_LOCK } = await import(process.env.FLEET_LOCK_MOD);',
      'const token = claimRunLock(process.env.FLEET_LOCK_DIR, SUPERVISOR_START_LOCK, process.pid, new Date());',
      'process.stdout.write(token ? "won\\n" : "lost\\n");',
      'if (token) await new Promise((r) => setTimeout(r, 400));',
    ].join('\n');
    const once = () =>
      new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--experimental-strip-types', '--input-type=module', '-e', script],
          {
            env: { ...process.env, FLEET_LOCK_MOD: mod, FLEET_LOCK_DIR: dir },
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b: Buffer) => {
          stdout += b;
        });
        child.stderr.on('data', (b: Buffer) => {
          stderr += b;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ stdout, stderr, code }));
      });
    const [a, b] = await Promise.all([once(), once()]);
    const detail = `${a.stderr}\n${b.stderr}`;
    expect(
      [a.stdout.trim(), b.stdout.trim()].filter((s) => s === 'won'),
      detail,
    ).toHaveLength(1);
    expect(
      [a.stdout.trim(), b.stdout.trim()].filter((s) => s === 'lost'),
      detail,
    ).toHaveLength(1);
  });

  it('列表能看见正在起来的占位', () => {
    const dir = join(temp(), 'row');
    mkdirSync(dir, { recursive: true });
    const token = claimRunLock(dir, SUPERVISOR_START_LOCK, process.pid, new Date('2026-10-16T10:00:00.000Z'));
    expect(token).toBeTruthy();
    const line = renderRuns(
      [
        {
          dir,
          problem: null,
          result: null,
          status: {
            issue: 42,
            repo: 'acme/app',
            state: 'retrying',
            attempts: 2,
            beatAt: '2026-10-16T09:00:00.000Z',
            worktree: '/wt',
            supervisorPid: null,
          } as RunStatus,
        },
      ],
      new Date('2026-10-16T10:00:00.000Z'),
    );
    expect(line[0]).toContain('看护进程正在起来，不再另派');
    expect(line[0]).toContain('/wt');
    if (token) releaseRunLock(dir, SUPERVISOR_START_LOCK, token);
  });
});

describe('看护进程的工人名额', () => {
  it('名额被占住时不起工人、不改状态', async () => {
    const { dir } = runFixture();
    const state = {
      state: 'retrying',
      beatAt: '2026-10-16T09:00:00.000Z',
      sessionId: SID,
      attempts: 2,
      supervisorPid: null,
    };
    writeJson(runFiles(dir).state, state);
    const before = readFileSync(runFiles(dir).state, 'utf8');
    const token = claimRunLock(dir, WORKER_SLOT_LOCK, process.pid, new Date());
    expect(token).toBeTruthy();
    const w = fakeDeps([{ code: 0, stdout: resultJson({ result: '不该跑', session_id: SID }), stderr: '' }]);
    expect(await superviseRun(dir, w.deps)).toBeNull();
    expect(w.calls).toEqual([]);
    expect(readFileSync(runFiles(dir).state, 'utf8')).toBe(before);
    expect(existsSync(runFiles(dir).result)).toBe(false);
    if (token) releaseRunLock(dir, WORKER_SLOT_LOCK, token);
  });

  it('两个看护同时进同一运行只起一个工人', async () => {
    const { dir } = runFixture();
    writeJson(runFiles(dir).state, {
      state: 'retrying',
      beatAt: '2026-10-16T09:00:00.000Z',
      sessionId: SID,
      attempts: 2,
      supervisorPid: null,
    });
    const w1 = fakeDeps([
      { code: 0, stdout: resultJson({ result: '只该这一次', session_id: SID }), stderr: '' },
    ]);
    const w2 = fakeDeps([{ code: 0, stdout: resultJson({ result: '不该跑', session_id: SID }), stderr: '' }]);
    const [a, b] = await Promise.all([superviseRun(dir, w1.deps), superviseRun(dir, w2.deps)]);
    expect(w1.calls.length + w2.calls.length).toBe(1);
    expect([a, b].filter((x) => x === null)).toHaveLength(1);
    expect([a, b].some((x) => x !== null && x.state === 'done')).toBe(true);
  });

  it('死掉的工人名额可以接手，只起一个工人', async () => {
    const { dir } = runFixture();
    const pid = deadPid();
    mkdirSync(join(dir, WORKER_SLOT_LOCK));
    writeJson(join(dir, WORKER_SLOT_LOCK, 'owner.json'), {
      pid,
      token: 'stale',
      claimedAt: '2026-10-16T09:00:00.000Z',
    });
    const w = fakeDeps([{ code: 0, stdout: resultJson({ result: '接手了', session_id: SID }), stderr: '' }]);
    const result = await superviseRun(dir, w.deps);
    expect(result?.state).toBe('done');
    expect(w.calls).toHaveLength(1);
  });

  it('看护进程死了但真实工人还活着时，worker-slot 仍不能接管', () => {
    const { dir } = runFixture();
    const deadSupervisor = deadPid();
    mkdirSync(join(dir, WORKER_SLOT_LOCK));
    writeJson(join(dir, WORKER_SLOT_LOCK, 'owner.json'), {
      pid: deadSupervisor,
      workerPid: process.pid,
      token: 'worker-still-running',
      claimedAt: '2026-10-16T09:00:00.000Z',
    });
    expect(runLockHeld(dir, WORKER_SLOT_LOCK, new Date())).toBe(true);
  });

  it('真实工人 spawn 后把 PID 写进 worker-slot，结束后可清掉', () => {
    const { dir } = runFixture();
    const token = claimRunLock(dir, WORKER_SLOT_LOCK, process.pid, new Date());
    expect(token).toBeTruthy();
    if (!token) return;
    expect(setRunLockWorker(dir, WORKER_SLOT_LOCK, token, process.pid)).toBe(true);
    expect(runLockHeld(dir, WORKER_SLOT_LOCK, new Date())).toBe(true);
    expect(setRunLockWorker(dir, WORKER_SLOT_LOCK, token, null)).toBe(true);
    releaseRunLock(dir, WORKER_SLOT_LOCK, token);
  });
});

describe('工人退出后先落只复核，审查返工才续原会话', () => {
  const intent: ReworkIntent = {
    v: 1,
    run: '2026-10-16T10:00:00.000Z',
    session: SID,
    generation: 1,
    returnId: 'return1',
  };

  function writeWaiting(dir: string, hold: NonNullable<RunStatus['hold']>) {
    writeJson(runFiles(dir).state, {
      state: 'waiting',
      supervisorPid: null,
      beatAt: '2026-10-16T09:00:00.000Z',
      sessionId: SID,
      sessionStarted: true,
      attempts: 1,
      hold,
      worktree: '/wt',
    });
  }

  it('首次核验前已经写成只复核；这份状态过 10 分钟再进来也不再起工人', async () => {
    const { dir } = runFixture();
    const w = fakeDeps([{ code: 0, stdout: resultJson({ result: '做完了', session_id: SID }), stderr: '' }]);
    let snap: RunStatus | null = null;
    w.deps.validateDelivery = async () => {
      snap = readJson<RunStatus>(runFiles(dir).state);
      throw new Error('probe-exit');
    };
    await superviseRun(dir, w.deps);
    expect(snap).toMatchObject({ state: 'waiting', attempts: 1, sessionStarted: true, supervisorPid: 777 });
    expect(w.calls).toHaveLength(1);
    const saved = checkpointOf(snap);
    writeJson(runFiles(dir).state, { ...saved, beatAt: '2026-10-16T09:00:00.000Z' });
    const again = fakeDeps([
      { code: 0, stdout: resultJson({ result: '不该再写', session_id: SID }), stderr: '' },
    ]);
    let checks = 0;
    again.deps.validateDelivery = async () => {
      checks += 1;
      throw new DeliveryCheckError('review', '审查未结');
    };
    const second = await superviseRun(dir, again.deps);
    expect(again.calls).toEqual([]);
    expect(checks).toBe(1);
    expect(second?.state).toBe('waiting');
  });

  it('审查返工核上当前退回才 --resume 原会话；再进来没有请求就只复核', async () => {
    const { dir } = runFixture();
    writeWaiting(dir, { kind: 'review', why: '审查未结' });
    writeJson(runFiles(dir).rework, intent);
    writeFileSync(runFiles(dir).reported, 'old\n');
    const seen: ReworkIntent[] = [];
    const w = fakeDeps([
      { code: 0, stdout: resultJson({ result: '按意见改了', session_id: SID }), stderr: '' },
    ]);
    w.deps.rework = true;
    w.deps.confirmRework = async (_spec, got) => {
      seen.push(got);
    };
    w.deps.feedbackContext = async () => '意见：必须改';
    w.deps.validateDelivery = async () => {
      throw new DeliveryCheckError('review', '审查仍未结');
    };
    const first = await superviseRun(dir, w.deps);
    expect(first?.state).toBe('waiting');
    expect(seen).toEqual([intent]);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]?.args).toEqual(workerArgs(SID, true));
    expect(w.calls[0]?.stdin).toContain('意见：必须改');
    expect(existsSync(runFiles(dir).rework)).toBe(false);
    expect(existsSync(runFiles(dir).reported)).toBe(false);
    const again = fakeDeps([
      { code: 0, stdout: resultJson({ result: '不该再写', session_id: SID }), stderr: '' },
    ]);
    again.deps.rework = true;
    again.deps.confirmRework = async () => {
      throw new Error('没有请求不该核');
    };
    again.deps.validateDelivery = async () => {
      throw new DeliveryCheckError('review', '审查仍未结');
    };
    expect((await superviseRun(dir, again.deps))?.state).toBe('waiting');
    expect(again.calls).toEqual([]);
  });

  it('退回代次核不上、或没装核验：不起工人', async () => {
    const { dir } = runFixture();
    writeWaiting(dir, { kind: 'review', why: '审查未结' });
    writeJson(runFiles(dir).rework, intent);
    const denied = fakeDeps([
      { code: 0, stdout: resultJson({ result: '不该跑', session_id: SID }), stderr: '' },
    ]);
    denied.deps.rework = true;
    denied.deps.confirmRework = async () => {
      throw new Error('当前退回代次已变');
    };
    const result = await superviseRun(dir, denied.deps);
    expect(denied.calls).toEqual([]);
    expect(existsSync(runFiles(dir).rework)).toBe(false);
    expect(result && 'why' in result ? result.why : '').toContain('不续写码');
    writeJson(runFiles(dir).rework, intent);
    const bare = fakeDeps([
      { code: 0, stdout: resultJson({ result: '不该跑', session_id: SID }), stderr: '' },
    ]);
    bare.deps.rework = true;
    const skipped = await superviseRun(dir, bare.deps);
    expect(bare.calls).toEqual([]);
    expect(skipped && 'why' in skipped ? skipped.why : '').toContain('未经当前退回代次核验');
  });

  it('外部交付即使带着返工请求也不起工人', async () => {
    const { dir } = runFixture();
    writeWaiting(dir, { kind: 'external', why: '需求已由其他真实PR交付' });
    writeJson(runFiles(dir).rework, intent);
    const w = fakeDeps([{ code: 0, stdout: resultJson({ result: '不该跑', session_id: SID }), stderr: '' }]);
    w.deps.rework = true;
    w.deps.confirmRework = async () => {
      throw new Error('不该核');
    };
    w.deps.validateDelivery = async () => {
      throw new DeliveryCheckError('review', '仍未结');
    };
    expect((await superviseRun(dir, w.deps))?.state).toBe('waiting');
    expect(w.calls).toEqual([]);
  });

  it('两个返工看护同时进来只起一个工人', async () => {
    const { dir } = runFixture();
    writeWaiting(dir, { kind: 'review', why: '审查未结' });
    writeJson(runFiles(dir).rework, intent);
    const w1 = fakeDeps([
      { code: 0, stdout: resultJson({ result: '只该这一次', session_id: SID }), stderr: '' },
    ]);
    const w2 = fakeDeps([{ code: 0, stdout: resultJson({ result: '不该跑', session_id: SID }), stderr: '' }]);
    for (const w of [w1, w2]) {
      w.deps.rework = true;
      w.deps.confirmRework = async () => {};
      w.deps.validateDelivery = async () => {
        throw new DeliveryCheckError('review', '审查仍未结');
      };
    }
    const [a, b] = await Promise.all([superviseRun(dir, w1.deps), superviseRun(dir, w2.deps)]);
    expect(w1.calls.length + w2.calls.length).toBe(1);
    expect([a, b].filter((x) => x === null)).toHaveLength(1);
  });
});

describe('acceptRework 与 pnpm work rework', () => {
  function event(over: Partial<FeedbackEvent> = {}): FeedbackEvent {
    const text = '必须修复真实数据';
    return {
      v: 1,
      action: 'return',
      repoId: 1,
      repo: 'acme/app',
      issue: 42,
      pr: 34,
      run: '2026-10-16T10:00:00.000Z',
      session: SID,
      requestId: 'request1',
      returnId: 'return1',
      generation: 1,
      head: HEAD,
      text,
      digest: feedbackDigest(text),
      dispatcherId: 2,
      ...over,
    };
  }

  function reviewGh(reviews: unknown[]): NonNullable<WorkDeps['gh']> {
    return async (args) => {
      if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/app' }));
      if (args[0] === 'pr' && args[1] === 'list') {
        return ok(
          JSON.stringify([{ number: 34, headRefOid: HEAD, state: 'OPEN', mergedAt: null, isDraft: false }]),
        );
      }
      if (args[0] === 'api') {
        const path = args[3];
        if (path === '/users/github-actions%5Bbot%5D') {
          return ok(JSON.stringify({ id: 3, type: 'Bot', login: 'github-actions[bot]' }));
        }
        if (path === '/repos/acme/app') {
          return ok(JSON.stringify({ id: 1, full_name: 'acme/app', owner: { id: 2, type: 'User' } }));
        }
        if (typeof path === 'string' && path.includes('/pulls/34/reviews'))
          return ok(JSON.stringify(reviews));
        return { code: 1, stdout: '', stderr: `没想到的 api ${String(path)}` };
      }
      return { code: 1, stdout: '', stderr: `没想到的 gh：${args.join(' ')}` };
    };
  }

  function seed(dir: string, hold: NonNullable<RunStatus['hold']> = { kind: 'review', why: '审查未结' }) {
    mkdirSync(dir, { recursive: true });
    writeJson(runFiles(dir).spec, {
      v: 1,
      repo: 'acme/app',
      issue: 42,
      title: 'Add captcha',
      repoRoot: '/repo',
      worktree: '/wt',
      branch: 'local/42-add-captcha',
      dispatcher: 'sess-main',
      reclaude: 'C:/bin/reclaude.exe',
      env: {},
      createdAt: '2026-10-16T10:00:00.000Z',
    });
    writeJson(runFiles(dir).state, {
      state: 'waiting',
      supervisorPid: null,
      beatAt: '2026-10-16T09:00:00.000Z',
      sessionId: SID,
      sessionStarted: true,
      attempts: 1,
      hold,
      repo: 'acme/app',
      issue: 42,
      worktree: '/wt',
      branch: 'local/42-add-captcha',
    });
  }

  it('只认对得上原 run/session 的未解决退回；外部交付和代次重复都拒绝', () => {
    const { spec } = runFixture();
    const waiting = {
      state: 'waiting',
      sessionId: SID,
      hold: { kind: 'review', why: '审查未结' },
    } as RunStatus;
    const row = (generation: number, resolved = false, session = SID) => ({
      resolved,
      event: {
        action: 'return',
        run: spec.createdAt,
        session,
        generation,
        returnId: `return${generation}`,
      },
    });
    expect(acceptRework(spec, waiting, [row(1, true), row(2)])).toMatchObject({
      generation: 2,
      returnId: 'return2',
      run: spec.createdAt,
      session: SID,
    });
    expect(() => acceptRework(spec, waiting, [row(1, false, 'other-session')])).toThrow(
      /没有对得上原 run\/session/,
    );
    expect(() =>
      acceptRework(spec, { ...waiting, hold: { kind: 'external', why: '已交付' } }, [row(1)]),
    ).toThrow(/不重派/);
    expect(() =>
      acceptRework(spec, waiting, [
        row(2),
        { resolved: false, event: { ...row(2).event, returnId: 'return-other' } },
      ]),
    ).toThrow(/对不上唯一/);
  });

  it('pnpm work rework 按当前未解决退回起一个看护；重复请求不再起第二个', async () => {
    const review = {
      id: 1,
      user: { id: 3, type: 'Bot' },
      state: 'COMMENTED',
      commit_id: HEAD,
      body: feedbackBody(event()),
    };
    const w = runWorld({ spawnPid: process.pid, gh: reviewGh([review]) });
    seed(w.dir);
    expect(await w.run('rework', '42'), w.err.join('\n')).toBe(0);
    expect(w.spawned).toHaveLength(1);
    expect(w.spawned[0]?.args.at(-1)).toBe('--rework');
    expect(readJson<ReworkIntent>(runFiles(w.dir).rework)).toMatchObject({
      generation: 1,
      returnId: 'return1',
      session: SID,
      run: '2026-10-16T10:00:00.000Z',
    });
    expect(w.out.join('\n')).toContain('第 1 代');
    w.err.length = 0;
    expect(await w.run('rework', '42')).toBe(1);
    expect(w.err.join('\n')).toContain('已有恢复占位');
    expect(w.spawned).toHaveLength(1);
  });

  it('同时两下返工只起一个看护', async () => {
    const review = {
      id: 1,
      user: { id: 3, type: 'Bot' },
      state: 'COMMENTED',
      commit_id: HEAD,
      body: feedbackBody(event()),
    };
    const w = runWorld({ spawnPid: process.pid, gh: reviewGh([review]) });
    seed(w.dir);
    const [a, b] = await Promise.all([w.run('rework', '42'), w.run('rework', '42')]);
    expect(w.spawned).toHaveLength(1);
    expect([a, b].sort()).toEqual([0, 1]);
    expect(w.err.join('\n')).toContain('已有恢复占位');
  });

  it('外部交付、对不上的会话、没有未解决退回都不起看护', async () => {
    const external = runWorld();
    seed(external.dir, { kind: 'external', why: '需求已由其他真实PR交付' });
    expect(await external.run('rework', '42')).toBe(1);
    expect(external.err.join('\n')).toContain('不重派');
    expect(external.spawned).toEqual([]);

    const wrong = runWorld({ gh: reviewGh([]) });
    seed(wrong.dir);
    expect(await wrong.run('rework', '42')).toBe(1);
    expect(wrong.err.join('\n')).toContain('没有对得上原 run/session');
    expect(wrong.spawned).toEqual([]);
    expect(existsSync(runFiles(wrong.dir).rework)).toBe(false);

    const other = event({ session: 'other-session', requestId: 'request-other', returnId: 'return-other' });
    const mismatched = runWorld({
      gh: reviewGh([
        {
          id: 1,
          user: { id: 3, type: 'Bot' },
          state: 'COMMENTED',
          commit_id: HEAD,
          body: feedbackBody(other),
        },
      ]),
    });
    seed(mismatched.dir);
    expect(await mismatched.run('rework', '42')).toBe(1);
    expect(mismatched.err.join('\n')).toContain('没有对得上原 run/session');
    expect(mismatched.spawned).toEqual([]);
  });

  it('有返工文件时 pnpm work run 仍只复核，不把 --rework 传给看护', async () => {
    const w = runWorld();
    seed(w.dir);
    writeJson(runFiles(w.dir).rework, {
      v: 1,
      run: '2026-10-16T10:00:00.000Z',
      session: SID,
      generation: 1,
      returnId: 'return1',
    });
    expect(await w.run('run', '42'), w.err.join('\n')).toBe(0);
    expect(w.spawned[0]?.args).not.toContain('--rework');
    expect(w.out.join('\n')).toContain('复核等待，不新开工人');
  });
});
