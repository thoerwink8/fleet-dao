// 发版一键命令（release-onekey-lib.mjs）：薄封装 release-train，只到预检。
// 假 ssh、假 gh、假时钟；home 用真临时目录（状态文件、暂停标记是真文件）。
// 覆盖：preflight 成功（哨兵拦在第 1 步前、状态文件删掉、暂停标记没写）、preflight 失败、
// --founder-ok 缺失拒绝、--sha/--tag 互斥、中文摘要（主线 CI / 自动合并的 PR / 法国在跑会话数）、
// 已有一趟时 preflight 拒、start 透传 runTrain。
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
    target: { kind: 'sha' | 'tag'; value: string | null },
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
        return ok(
          JSON.stringify(
            w.ci === 'pending'
              ? [{ status: 'in_progress', conclusion: null }]
              : [{ status: 'completed', conclusion: w.ci }],
          ),
        );
      if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(w.prs));
    }
    if (command === NODE && String(args[0]).endsWith('worker.mjs')) return ok('没有起过任何工人');
    if (command === NODE && String(args[0]).endsWith('france.mjs'))
      return {
        status: w.franceHealthExit,
        stdout: `法国引擎 · 现在\n断链排查：${w.franceBad} 处异常、0 处没读到、2 处留意\n`,
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
const markerFile = (home: string) => join(home, '.fleet-dao', 'release-train.paused');
const stateFilePath = (home: string) => join(home, '.fleet-dao', 'release-train.json');
const text = (lines: string[]) => lines.join('\n');

describe('preflight：只读，什么都不改', () => {
  it('全绿：回 0；哨兵拦在第 1 步前（暂停标记没写过）；临时状态文件删掉；输出含中文摘要', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.prs = [
      { number: 11, title: '挂着自动合并的', autoMergeRequest: { enabledAt: 'x' } },
      { number: 12, title: '没挂的', autoMergeRequest: null },
    ];
    w.sessions = async () => ({ ok: true, running: 3, rows: [] });
    const code = await onekey.runOnekey(['preflight', '--sha', SHA], io(home));
    expect(code).toBe(0);
    // 拦截生效：第 1 步「暂停本机」没过去——从头到尾都没写过暂停标记
    expect(existsSync(markerFile(home))).toBe(false);
    // 临时状态文件删掉
    expect(existsSync(stateFilePath(home))).toBe(false);
    const o = text(w.out);
    // 中文摘要（同一批只读接口问出来的）
    expect(o).toContain('预检摘要');
    expect(o).toContain('主线 CI：绿');
    expect(o).toContain('挂了自动合并的 PR：1 个（#11）');
    expect(o).toContain('法国在跑的会话：3 个');
    // release-train 自己的预检输出原样带上
    expect(o).toContain('预检：法国现状');
    // 过了
    expect(o).toContain('预检过了');
    expect(o).not.toContain('暂停本机：标记已写');
  });

  it('主线 CI 红：回 2；同样什么都没改（没标记、没状态）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.ci = 'failure';
    const code = await onekey.runOnekey(['preflight', '--sha', SHA], io(home));
    expect(code).toBe(2);
    expect(existsSync(markerFile(home))).toBe(false);
    expect(existsSync(stateFilePath(home))).toBe(false);
    expect(text(w.out)).toContain('预检没过');
  });

  it('不带 --sha/--tag 也行：只说环境', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await onekey.runOnekey(['preflight'], io(home));
    expect(code).toBe(0);
    expect(text(w.out)).toContain('只说环境，没指定目标');
  });

  it('--sha 和 --tag 一起给：拒（回 1）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await onekey.runOnekey(['preflight', '--sha', SHA, '--tag', 'v12'], io(home));
    expect(code).toBe(1);
    expect(text(w.err)).toContain('只能给一个');
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
    expect(existsSync(markerFile(home))).toBe(false);
    expect(existsSync(stateFilePath(home))).toBe(false);
  });

  it('--founder-ok 是空的也拒', async () => {
    const home = freshHome();
    const { io } = makeWorld();
    const code = await onekey.runOnekey(['start', '--sha', SHA, '--founder-ok', '  '], io(home));
    expect(code).toBe(1);
    expect(existsSync(stateFilePath(home))).toBe(false);
  });

  it('--sha 和 --tag 一起给：拒（回 1）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await onekey.runOnekey(
      ['start', '--sha', SHA, '--tag', 'v12', '--founder-ok', FOUNDER],
      io(home),
    );
    expect(code).toBe(1);
    expect(text(w.err)).toContain('只能给一个');
    expect(w.calls).toEqual([]);
  });

  it('--sha 和 --tag 都不给：拒（回 1）', async () => {
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

  it('过了检查的照原样进 runTrain：写了暂停标记（说明真走到了第 1 步）', async () => {
    const home = freshHome();
    const { io } = makeWorld();
    // 法国有个会话一直在跑（预检那次读到 0 个，之后 1 个），让等收尾卡住，这趟不会走远但够看到「真在走 runTrain」
    // （本机工人、自动合并的 PR 只提示不等了，卡不住它）
    const run0 = io(home);
    let polls = 0;
    run0.runningSessions = async () => {
      polls += 1;
      return polls === 1
        ? { ok: true, running: 0, rows: [] }
        : { ok: true, running: 1, rows: [{ repo: 'o/a', n: 5, stage: 'execute' }] };
    };
    const code = await onekey.runOnekey(['start', '--sha', SHA, '--founder-ok', FOUNDER], run0);
    // 卡在等收尾（3），但暂停标记已经写了——证明 runTrain 真跑起来了
    expect(code).toBe(3);
    expect(existsSync(markerFile(home))).toBe(true);
    const st = JSON.parse(readFileSync(stateFilePath(home), 'utf8')) as { status: string; phase: number };
    expect(st.status).toBe('blocked');
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
    expect(existsSync(markerFile(home))).toBe(false);
    expect(existsSync(stateFilePath(home))).toBe(false);
  });
});
