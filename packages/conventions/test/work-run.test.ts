// pnpm work run（单 #2761 第二片）：脱离聊天进程派无头工人、看护进程靠租约心跳、网关断了从断点续、结束写结果文件。
// 故意造出的失败：网关 502、会话还没建起来就断、看护进程自己死了再起、登录坏了、次数用完、容量不够 / 没查成、已经有一个在跑。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GhResult } from '../src/issue-new.ts';
import { type LocalClaimRequest, work } from '../src/work.ts';
import {
  type AttemptOutput,
  BEAT_STALE_MS,
  backoffMs,
  FIRST_BACKOFF_MS,
  judgeAttempt,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  RESUME_PROMPT,
  type RunResult,
  type RunSpec,
  type RunStatus,
  readJson,
  runDir,
  runFiles,
  type SuperviseDeps,
  superviseRun,
  workerArgs,
  writeJson,
} from '../src/work-run.ts';

const dirs: string[] = [];
afterEach(() => {
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
    expect(w.calls[0]?.env).toEqual({ PATH: '/bin', FLEET_WORKER: '1' });
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
function runWorld(o: { enough?: boolean | null; lease?: boolean; spawnOk?: boolean } = {}) {
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
  const run = (...argv: string[]) =>
    work(argv, {
      gh: async (args) => {
        if (args[0] === 'repo') return ok(JSON.stringify({ nameWithOwner: 'acme/app' }));
        if (args[0] === 'issue' && args[1] === 'view')
          return ok(JSON.stringify({ title: 'Add captcha', state: 'OPEN' }));
        if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
        if (args[0] === 'issue' && args[1] === 'edit') return ok();
        return { code: 1, stdout: '', stderr: `没想到的 gh：${args.join(' ')}` };
      },
      post: async (body) => {
        sent.push(body);
        return { status: 200, text: JSON.stringify({ ok: true, leaseUntil: '2026-10-16T12:00:00.000Z' }) };
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      run: {
        capacity: async () => ({
          enough: o.enough === undefined ? true : o.enough,
          text:
            o.enough === null
              ? '本机容量没查成：CIM 超时'
              : o.enough === false
                ? '本机容量不够（空闲内存不够）'
                : '本机容量够',
        }),
        spawnDetached: (file, args, opts) => {
          spawned.push({ file, args, ...opts });
          return o.spawnOk === false ? { ok: false, why: 'WMI 返回 9' } : { ok: true, pid: 4242, how: 'wmi' };
        },
        git: async (args) => {
          gitCalls.push(args);
          if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute')
            return ok(`${join(repoRoot, '.git')}\n`);
          if (args[0] === 'rev-parse' && args[1] === '--verify') return { code: 1, stdout: '', stderr: '' };
          if (args[0] === 'worktree' && args[1] === 'add') made.add(args[2] ?? '');
          return ok();
        },
        env: { CLAUDE_CODE_SESSION_ID: 'sess-main', PATH: '/bin', GH_TOKEN: 'secret' },
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
  return { run, runs, repoRoot, sent, gitCalls, spawned, out, err, dir: runDir(runs, 'acme/app', 42), now };
}

describe('pnpm work run：派之前过容量、领单、建工作树，经脱离的看护进程起', () => {
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
    expect(readFileSync(runFiles(w.dir).brief, 'utf8')).toContain('gh issue view 42');
    expect(w.spawned).toEqual([{ file: '/node', args: ['/sup.ts', w.dir], cwd: w.repoRoot }]);
    expect(w.out.join('\n')).toContain('派出去了 #42：看护进程 4242');
    expect(w.out.join('\n')).toContain('work-watch.mjs');
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
