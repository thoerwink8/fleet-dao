// 发版一键命令（release-onekey-lib.mjs）：预检只读，不递发布请求；start / status / abort 交给 release-train。
// 假 ssh、假 gh、假时钟；home 用真临时目录。
// 覆盖：preflight 成功（不关引擎、不写请求、中文摘要）、主线 CI 红、不带 --sha、
// --founder-ok 缺失拒绝、--tag 已删（决定 0032）、已有旧状态文件时 preflight 拒、start 真的进 runTrain。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(new URL('../skills/commander/scripts/', import.meta.url));
const load = async (file: string) => import(pathToFileURL(join(SCRIPTS, file)).href);

interface CmdResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string | null | undefined;
}
type SessionsResult =
  | { ok: true; running: number; rows: { repo?: string; n?: number; stage: string }[] }
  | { ok: false; kind: string; why: string };
interface OnekeyIo {
  home: string;
  env: Record<string, string | undefined>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  cwd: () => string;
  nodePath: string;
  scriptsDir: string;
  limits?: Record<string, number>;
  out: (t: string) => void;
  err: (t: string) => void;
  run: (command: string, args: string[], opts?: unknown) => CmdResult;
  ssh: (command: string, opts?: unknown) => CmdResult;
  runningSessions: () => Promise<SessionsResult>;
  franceRepos: () => Promise<
    { ok: true; rows: { repo: string; auto_dispatch_since: string | null }[] } | { ok: false; why: string }
  >;
}
interface Onekey {
  runOnekey(argv: string[], io: OnekeyIo): Promise<number>;
  runPreflight(
    io: OnekeyIo,
    target: { kind: 'sha'; value: string | null },
  ): Promise<{ code: number; lines: string[] }>;
  ONEKEY_USAGE: string;
}

const onekey = (await load('release-onekey-lib.mjs')) as Onekey;

const SHA = 'ab12cd34'.repeat(5);
const FOUNDER = '发版吧，发完不用开引擎';
const NODE = 'node-fake';
const ok = (stdout = ''): CmdResult => ({ status: 0, stdout, stderr: '' });

/** 一个假世界：命令的回话都在这里改；calls 记下每条命令。 */
function makeWorld() {
  const w = {
    t: Date.parse('2026-10-05T14:00:00Z'),
    calls: [] as string[],
    sshCalls: [] as string[],
    out: [] as string[],
    err: [] as string[],
    ci: 'success' as 'success' | 'failure' | 'pending',
    prs: [] as { number: number; title: string; autoMergeRequest: unknown }[],
    lockBusy: false,
    franceHealthExit: 0,
    franceBad: 0,
    sessions: (async () => ({ ok: true, running: 0, rows: [] })) as () => Promise<SessionsResult>,
    engineOn: true,
  };

  const run = (command: string, args: string[]): CmdResult => {
    const line = `${command} ${args.join(' ')}`;
    w.calls.push(line);
    if (command === 'gh') {
      if (args[0] === 'api' && args[1]?.includes('check-runs'))
        // 新读法：check_name=check 过滤、jq 之后的一页 {total, runs}
        return ok(
          JSON.stringify({
            total: 1,
            runs:
              w.ci === 'pending'
                ? [{ status: 'in_progress', conclusion: null }]
                : [{ status: 'completed', conclusion: w.ci }],
          }),
        );
      if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(w.prs));
    }
    if (command === NODE && String(args[0]).endsWith('france.mjs'))
      return {
        status: w.franceHealthExit,
        stdout: JSON.stringify({
          anomalies: [
            ...Array.from({ length: w.franceBad }, (_, i) => ({
              level: 'bad',
              what: `异常 ${i}`,
              where: 'x',
            })),
            { level: 'note', what: '留意 1', where: 'x' },
            { level: 'note', what: '留意 2', where: 'x' },
          ],
        }),
        stderr: '',
      };
    return { status: 127, stdout: '', stderr: `假世界不认识这条命令：${line}` };
  };

  const ssh = (cmd: string): CmdResult => {
    w.sshCalls.push(cmd);
    if (cmd.startsWith('flock')) return { status: w.lockBusy ? 75 : 0, stdout: '', stderr: '' };
    if (cmd.endsWith('engine status')) return ok(`引擎总开关：${w.engineOn ? '开着' : '关着'}：说明\n`);
    if (cmd.includes(' engine off ')) {
      w.engineOn = false;
      return ok('已关');
    }
    if (cmd.includes(' engine on ')) {
      w.engineOn = true;
      return ok('已开');
    }
    // status 读法国进度：没有文件就是没有一趟
    if (cmd.includes('---TRAIN---')) return ok('---TRAIN---\n\n\n---LAST---\n\n');
    return { status: 127, stdout: '', stderr: `假法国不认识：${cmd}` };
  };

  const io = (home: string, limits: Record<string, number> = {}): OnekeyIo => ({
    home,
    env: {},
    now: () => new Date(w.t),
    sleep: async (ms) => {
      w.t += ms;
    },
    cwd: () => home,
    nodePath: NODE,
    scriptsDir: 'scripts',
    limits: { pollMs: 1000, preflightMs: 60_000, ...limits },
    out: (t) => w.out.push(t),
    err: (t) => w.err.push(t),
    run: (c, a) => run(c, a),
    ssh: (c) => ssh(c),
    runningSessions: () => w.sessions(),
    franceRepos: async () => ({ ok: true, rows: [] }),
  });
  return { w, io };
}

const dirs: string[] = [];
const freshHome = () => {
  const d = mkdtempSync(join(tmpdir(), 'release-onekey-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const stateFilePath = (home: string) => join(home, '.fleet-dao', 'release-train.json');
const text = (lines: string[]) => lines.join('\n');

describe('preflight：只读，什么都不改', () => {
  it('全绿：回 0；不关引擎、不写发布请求；输出含中文摘要', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.prs = [
      { number: 11, title: '挂着自动合并的', autoMergeRequest: { enabledAt: 'x' } },
      { number: 12, title: '没挂的', autoMergeRequest: null },
    ];
    w.sessions = async () => ({ ok: true, running: 3, rows: [] });
    const code = await onekey.runOnekey(['preflight', '--sha', SHA], io(home));
    expect(code).toBe(0);
    expect(w.sshCalls.some((c) => c.includes(' engine off '))).toBe(false);
    expect(w.sshCalls.some((c) => c.includes('request.json'))).toBe(false);
    expect(existsSync(stateFilePath(home))).toBe(false);
    const o = text(w.out);
    expect(o).toContain('预检摘要');
    expect(o).toContain('主线 CI：绿');
    expect(o).toContain('挂了自动合并的 PR：1 个（#11）');
    expect(o).toContain('法国在跑的会话：3 个');
    expect(o).toContain('预检：法国现状');
    expect(o).toContain('预检过了');
    expect(o).not.toContain('本机：没有要暂停的东西');
    expect(o).not.toContain('递请求');
  });

  it('主线 CI 红：回 2；同样什么都没改（没状态）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.ci = 'failure';
    const code = await onekey.runOnekey(['preflight', '--sha', SHA], io(home));
    expect(code).toBe(2);
    expect(existsSync(stateFilePath(home))).toBe(false);
    expect(text(w.out)).toContain('预检没过');
  });

  it('不带 --sha 也行：只说环境', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await onekey.runOnekey(['preflight'], io(home));
    expect(code).toBe(0);
    expect(text(w.out)).toContain('只说环境，没指定目标');
  });

  it('--tag 已经没有了（决定 0032）：拒（回 1），指到 --sha', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await onekey.runOnekey(['preflight', '--tag', 'v12'], io(home));
    expect(code).toBe(1);
    expect(text(w.err)).toContain('--tag 已经没有了');
    expect(text(w.err)).toContain('--sha');
    expect(w.calls).toEqual([]);
  });

  it('已经有一趟在走：拒（回 1），不碰它', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    // 让 release-train 先真开始一趟（CI 也绿，能走过预检然后被哨兵断在第 1 步前）——这里用 runPreflight 自己的拦截造出
    // 干脆直接写个状态文件
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    writeFileSync(
      stateFilePath(home),
      JSON.stringify({
        schema: 1,
        status: 'running',
        phase: 2,
        startedAt: 'x',
        updatedAt: 'x',
        target: { kind: 'sha', value: SHA },
      }),
    );
    const code = await onekey.runOnekey(['preflight', '--sha', SHA], io(home));
    expect(code).toBe(1);
    expect(text(w.out)).toContain('已经有一趟');
    // 没碰它：状态原样在
    const s = JSON.parse(readFileSync(stateFilePath(home), 'utf8')) as { status: string };
    expect(s.status).toBe('running');
  });
});

describe('start：先拦用法，过了照原样进 runTrain', () => {
  it('没带 --founder-ok：拒（回 1），什么都没做', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await onekey.runOnekey(['start', '--sha', SHA], io(home));
    expect(code).toBe(1);
    expect(text(w.err)).toContain('--founder-ok');
    expect(w.calls).toEqual([]);
    expect(w.sshCalls).toEqual([]);
    expect(existsSync(stateFilePath(home))).toBe(false);
  });

  it('--founder-ok 是空的也拒', async () => {
    const home = freshHome();
    const { io } = makeWorld();
    const code = await onekey.runOnekey(['start', '--sha', SHA, '--founder-ok', '  '], io(home));
    expect(code).toBe(1);
    expect(existsSync(stateFilePath(home))).toBe(false);
  });

  it('start 带 --tag：拒（回 1），什么都没做', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await onekey.runOnekey(['start', '--tag', 'v12', '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(1);
    expect(text(w.err)).toContain('--tag 已经没有了');
    expect(w.calls).toEqual([]);
    expect(w.sshCalls).toEqual([]);
  });

  it('--sha 不给：拒（回 1）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await onekey.runOnekey(['start', '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(1);
    expect(text(w.err)).toContain('发哪个没说');
  });

  it('--sha 不是提交号：拒（回 1）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await onekey.runOnekey(['start', '--sha', 'notasha', '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(1);
    expect(text(w.err)).toContain('十六进制');
  });

  it('过了检查的照原样进 runTrain：递了请求，法国进度卡住就回 3', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base0 = io(home);
    let reads = 0;
    const run0: OnekeyIo = {
      ...base0,
      ssh: (cmd) => {
        w.sshCalls.push(cmd);
        if (cmd.includes('printf %s') && cmd.includes('request.json')) return ok('');
        if (cmd.includes('---TRAIN---')) {
          reads += 1;
          if (reads === 1) return ok('---TRAIN---\n\n\n---LAST---\n\n');
          const train = { schema: 1, status: 'blocked', phase: 3, why: '等收尾到点', waiting: null };
          const last = { v: 1, outcome: 'blocked', sha: SHA, by: 'commander', why: '等收尾到点' };
          return ok(`---TRAIN---\n${JSON.stringify(train)}\n\n---LAST---\n${JSON.stringify(last)}\n`);
        }
        return { status: 127, stdout: '', stderr: `假法国不认识：${cmd}` };
      },
    };
    const code = await onekey.runOnekey(['start', '--sha', SHA, '--founder-ok', FOUNDER], run0);
    expect(code).toBe(3);
    expect(text(w.out)).toContain('递请求');
    expect(text(w.err)).toContain('卡住了');
    expect(existsSync(stateFilePath(home))).toBe(false);
  });
});

describe('status / abort：透传 runTrain', () => {
  it('status 在没有一趟时回 0 并打「没有发版在走」', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await onekey.runOnekey(['status'], io(home));
    expect(code).toBe(0);
    expect(text(w.out)).toContain('没有发版在走');
  });
});

describe('runPreflight 直接调（lib 面）', () => {
  it('返回 lines 里含摘要和「预检过了」', async () => {
    const home = freshHome();
    const { io } = makeWorld();
    const r = await onekey.runPreflight(io(home), { kind: 'sha', value: SHA });
    expect(r.code).toBe(0);
    expect(r.lines.join('\n')).toContain('预检摘要');
    expect(r.lines.join('\n')).toContain('预检过了');
    expect(existsSync(stateFilePath(home))).toBe(false);
  });
});
