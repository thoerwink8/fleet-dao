// 发版前先暂停手头的活（#618）：release-train-lib.mjs（一趟发版的各阶段）、worker-lib.mjs 的暂停标记、法国在跑会话数的只读查询
// （france-sessions-query.mjs / france-sessions-lib.mjs）。
// ssh、gh、git、pnpm、node 子进程、睡眠全部是假的（假时钟：sleep 只是把时间往前拨）；home 用真的临时目录，状态文件和暂停标记是真文件。
// 真跑的那条路（release-train.mjs 外壳里的 ssh）在这里一次都不碰。故意造的失败：没带 --founder-ok、等收尾超时、法国读不到会话数、
// 发完版历史末行是 unhealthy、发完恢复发版前的开关不成功（总开关开不回、仓开关开不回、没记发版前的状态）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
interface TrainIo {
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
interface Train {
  DEFAULT_LIMITS: Record<string, number>;
  runTrain(argv: string[], io: TrainIo): Promise<number>;
  parseWorkerStatus(out: string): { running: string[]; uncertain: string[]; unreadable: string[] };
  orderFromDescription(d: string): number[];
  rankIssues(
    issues: { number: number; title: string; labels?: { name: string }[] }[],
    order: number[],
  ): {
    rows: {
      rank: number;
      number: number;
      mother: boolean;
      local: boolean;
      handoff: boolean;
      listed: boolean;
    }[];
    missing: number[];
  };
  USAGE: string;
}
interface WorkerLib {
  runWorker(argv: string[], io: Record<string, unknown>): Promise<number>;
  readPauseMarker(home: string): { paused: boolean; why?: string };
}
interface SessionsLib {
  parseSessions(text: string): SessionsResult;
  fetchRunningSessions(o: Record<string, unknown>): Promise<SessionsResult>;
}
interface SessionsQuery {
  PSQL: string[];
  SQL: string;
  collect(
    run: (argv: readonly string[], input: string) => CmdResult,
    now?: () => Date,
  ): { ok: boolean; running?: number; rows?: unknown[]; why?: string };
  realRun(argv: readonly string[], input: string): CmdResult;
}

const train = (await load('release-train-lib.mjs')) as Train;
const workerLib = (await load('worker-lib.mjs')) as WorkerLib;
const sessionsLib = (await load('france-sessions-lib.mjs')) as SessionsLib;
const sessionsQuery = (await load('france-sessions-query.mjs')) as SessionsQuery;
const franceQuery = (await load('france-query.mjs')) as { PSQL: string[] };

const SHA = 'ab12cd34'.repeat(5);
const OLD = '0123abcd'.repeat(5);
const FOUNDER = '发版吧';
const FOUNDER_RESTORE = '发吧，发完恢复引擎和各仓开关';
const NODE = 'node-fake';
const RUNNING_WORKER =
  'w1：grok，档位 high，在跑，pid 123，从起来到现在 3 分钟\n  工作树 x（分支 y）\n  最后一句输出：在写\n  PR：没有';
const DONE_WORKER =
  'w1：grok，档位 high，已经不在跑了，pid 123，从起来到现在 30 分钟\n  工作树 x（分支 y）\n  最后一句输出：完成\n  PR：#9（MERGED）u';

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
    workers: '没有起过任何工人',
    lockBusy: false,
    franceHealthExit: 0,
    franceBad: 0,
    engineOn: true,
    engineStatusFails: false,
    engineLegacy: false, // 在用的版本还没有 engine 子命令：fleet-api 打用法、退出 1
    engineOnFails: false, // engine on 没成（连不上库）
    engineOnSticks: false, // engine on 说成了、读回来还是关着
    dispatchFails: false, // dispatch <仓> on 没成
    sessions: (async () => ({ ok: true, running: 0, rows: [] })) as () => Promise<SessionsResult>,
    repos: [
      { repo: 'o/a', auto_dispatch_since: '2026-10-01T00:00:00Z' },
      { repo: 'o/b', auto_dispatch_since: null },
    ] as { repo: string; auto_dispatch_since: string | null }[],
    history: `2026-10-05T01:00:00Z ${OLD} release`,
    releaseExit: 0,
    releaseWritesHistory: 'release',
    checkExit: 0,
    prState: 'MERGED',
    tagSha: null as string | null,
    publishOut: '开了「发布 v5」PR #200：https://example.invalid/pull/200（head release/v5 → main）',
    milestones: [
      {
        title: 'v4 统一',
        description: '<!-- fleet:order -->\n1. #30\n2. #10\n3. #99\n<!-- /fleet:order -->',
      },
      { title: 'v5 以后', description: '' },
    ] as { title: string; description: string }[],
    issues: [
      { number: 10, title: '小活', labels: [{ name: '需求' }] },
      { number: 30, title: '先做的', labels: [{ name: '本机做' }] },
      { number: 40, title: '母', labels: [{ name: '母单' }] },
      { number: 20, title: '后来的', labels: [] },
    ] as { number: number; title: string; labels: { name: string }[] }[],
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
      if (args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({ state: w.prState }));
      if (args[0] === 'api' && args[1]?.includes('milestones')) return ok(JSON.stringify(w.milestones));
      if (args[0] === 'issue' && args[1] === 'list') return ok(JSON.stringify(w.issues));
    }
    if (command === 'git' && args[0] === 'ls-remote') return ok(w.tagSha ? `${w.tagSha}\t${args[2]}\n` : '');
    if (command === 'pnpm' && args[0] === 'publish:pr') {
      w.tagSha = SHA; // 发布 PR 合了，release.yml 打标记（这里一步到位）
      w.history += `
2026-10-05T14:30:00Z ${SHA} release`; // 法国自动发布接手，也一步到位
      return ok(w.publishOut);
    }
    if (command === NODE && String(args[0]).endsWith('worker.mjs')) return ok(w.workers);
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
    if (cmd.endsWith('engine status')) {
      if (w.engineStatusFails) return { status: 1, stdout: '', stderr: '连不上库' };
      if (w.engineLegacy)
        return {
          status: 1,
          stdout: '',
          stderr: '不认识的命令 engine\n用法：fleet-api <命令> …\n  set-password …\n',
        };
      return ok(`引擎总开关：${w.engineOn ? '开着' : '关着'}：说明\n`);
    }
    if (cmd.includes(' engine off ')) {
      w.engineOn = false;
      return ok('已关');
    }
    if (cmd.includes(' engine on ')) {
      if (w.engineOnFails) return { status: 1, stdout: '', stderr: 'could not connect to database' };
      if (!w.engineOnSticks) w.engineOn = true;
      return ok('已开');
    }
    if (cmd.includes(' dispatch ')) {
      if (w.dispatchFails) return { status: 1, stdout: '', stderr: '库出错' };
      return ok('已开');
    }
    if (cmd.endsWith('release.sh --check')) return { status: w.checkExit, stdout: '', stderr: '' };
    if (cmd.includes('/deploy/release.sh ')) {
      const sha = cmd.split(' ').at(-1);
      w.history += `\n2026-10-05T14:30:00Z ${sha} ${w.releaseWritesHistory}`;
      return { status: w.releaseExit, stdout: '', stderr: '' };
    }
    if (cmd.startsWith('tail -n 1')) return ok(`${w.history.split('\n').at(-1)}\n`);
    return { status: 127, stdout: '', stderr: `假法国不认识：${cmd}` };
  };

  const io = (home: string, limits: Record<string, number> = {}): TrainIo => ({
    home,
    env: {},
    now: () => new Date(w.t),
    sleep: async (ms) => {
      w.t += ms;
    },
    cwd: () => home,
    nodePath: NODE,
    scriptsDir: 'scripts',
    limits: {
      pollMs: 1000,
      ciMs: 3000,
      franceMs: 3000,
      mergeMs: 3000,
      tagMs: 3000,
      releaseMs: 3000,
      deployMs: 3000,
      ...limits,
    },
    out: (t) => w.out.push(t),
    err: (t) => w.err.push(t),
    run: (c, a) => run(c, a),
    ssh: (c) => ssh(c),
    runningSessions: () => w.sessions(),
    franceRepos: async () => ({ ok: true, rows: w.repos }),
  });
  return { w, io };
}

const dirs: string[] = [];
const freshHome = () => {
  const d = mkdtempSync(join(tmpdir(), 'release-train-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const markerFile = (home: string) => join(home, '.fleet-dao', 'release-train.paused');
const stateOf = (home: string) =>
  JSON.parse(readFileSync(join(home, '.fleet-dao', 'release-train.json'), 'utf8')) as {
    status: string;
    phase: number;
    before: { master: boolean; repos: { repo: string; on: boolean }[] | null } | null;
    laggards: string[];
  };
const text = (lines: string[]) => lines.join('\n');
/**
 * 预检那次读到 0 个，之后法国一直有一个会话在跑：等收尾会一直等不到。本机工人、自动合并的 PR 只提示、不等了（母单 #1121），
 * 挡路的只剩法国会话和主线 CI。
 */
const franceBusyAfterPreflight = (w: { sessions: () => Promise<SessionsResult> }) => {
  let polls = 0;
  w.sessions = async () => {
    polls += 1;
    return polls === 1
      ? { ok: true, running: 0, rows: [] }
      : { ok: true, running: 1, rows: [{ repo: 'o/a', n: 5, stage: 'execute' }] };
  };
};
const franceFree = (w: { sessions: () => Promise<SessionsResult> }) => {
  w.sessions = async () => ({ ok: true, running: 0, rows: [] });
};
const releaseCalls = (ssh: string[]) =>
  ssh.filter((c) => c.includes('/deploy/release.sh ') && !c.endsWith('--check'));

describe('暂停标记：worker.mjs start 见标记就拒', () => {
  it('发版暂停期间 start 被拒（退出码 3、说明原因、什么都没起），status 照常', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    franceBusyAfterPreflight(w); // 等收尾会一直等不到
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(3);
    expect(existsSync(markerFile(home))).toBe(true);
    expect(workerLib.readPauseMarker(home).paused).toBe(true);

    const calls: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const spy = (name: string) => () => {
      calls.push(name);
      return { status: 0, stdout: '', stderr: '' };
    };
    const workerIo = {
      env: {},
      home,
      now: () => new Date(),
      nodePath: NODE,
      sleep: async () => {},
      cwd: () => home,
      git: spy('git'),
      gh: spy('gh'),
      pnpm: spy('pnpm'),
      spawnDetached: () => {
        calls.push('spawnDetached');
        return { pid: 1 };
      },
      isRunning: () => false,
      killTree: () => ({ ok: true }),
      out: (t: string) => out.push(t),
      err: (t: string) => err.push(t),
    };
    const started = await workerLib.runWorker(
      [
        'start',
        '--model',
        'grok',
        '--name',
        'x',
        '--brief',
        'b.md',
        '--no-issue',
        '试',
        '--detached',
        '测试里要脱离',
      ],
      workerIo,
    );
    expect(started).toBe(3);
    expect(text(err)).toContain('发版暂停中');
    expect(text(err)).toContain('release-train.mjs abort');
    expect(calls).toEqual([]); // git、gh、pnpm、起进程一个都没碰

    // status 照常：没有工人，退出 0
    expect(await workerLib.runWorker(['status'], workerIo)).toBe(0);
    expect(text(out)).toContain('没有起过任何工人');
  });

  it('标记在但内容读坏了也算暂停；没有标记不拦', () => {
    const home = freshHome();
    expect(workerLib.readPauseMarker(home).paused).toBe(false);
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    writeFileSync(markerFile(home), '这不是 JSON');
    const r = workerLib.readPauseMarker(home);
    expect(r.paused).toBe(true);
    expect(r.why).toContain('按暂停算');
  });
});

describe('start 的前置：没带 --founder-ok 不发版', () => {
  it('没带 --founder-ok：拒，什么都没做（没暂停、没写状态、没读任何东西）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await train.runTrain(['start', '--sha', SHA], io(home));
    expect(code).toBe(1);
    expect(text(w.err)).toContain('--founder-ok');
    expect(w.calls).toEqual([]);
    expect(w.sshCalls).toEqual([]);
    expect(existsSync(markerFile(home))).toBe(false);
    expect(existsSync(join(home, '.fleet-dao', 'release-train.json'))).toBe(false);
  });

  it('--founder-ok 是空的也拒', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    expect(await train.runTrain(['start', '--tag', 'v5', '--founder-ok', '   '], io(home))).toBe(1);
    expect(w.sshCalls).toEqual([]);
  });

  it('--sha 和 --tag 要恰好一个；提交号、版本号写法不对都拒', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    expect(await train.runTrain(['start', '--founder-ok', FOUNDER], io(home))).toBe(1);
    expect(
      await train.runTrain(['start', '--sha', SHA, '--tag', 'v5', '--founder-ok', FOUNDER], io(home)),
    ).toBe(1);
    expect(await train.runTrain(['start', '--sha', 'zzz', '--founder-ok', FOUNDER], io(home))).toBe(1);
    expect(await train.runTrain(['start', '--tag', 'v5.1', '--founder-ok', FOUNDER], io(home))).toBe(1);
    expect(w.sshCalls).toEqual([]);
  });

  it('--restore 不再要创始人在原话里写授权（只是还原发版前的样子）：原话只写「发吧」也照走，发完开回', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', '发吧', '--restore'], io(home))).toBe(
      0,
    );
    expect(w.engineOn).toBe(true);
    expect(train.USAGE).not.toContain('必须写明授权');
  });
});

describe('预检（只读）：不过就什么都不改', () => {
  it('法国读不到在跑几个会话：预检不过，不暂停、不关总开关、不发版（不把读不到当成 0）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.sessions = async () => ({ ok: false, kind: 'ssh-failed', why: 'ssh 连不上法国' });
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(2);
    expect(text(w.err)).toContain('在跑几个会话读不到');
    expect(existsSync(markerFile(home))).toBe(false);
    expect(w.sshCalls.some((c) => c.includes('engine off'))).toBe(false);
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });

  it('主线 CI 红、别的发布占着锁：都列出来，一次说全', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.ci = 'failure';
    w.lockBusy = true;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(2);
    expect(text(w.err)).toContain('主线 CI 不是绿的');
    expect(text(w.err)).toContain('另一个发布正在跑');
    expect(existsSync(markerFile(home))).toBe(false);
  });

  it('预检没过之后换一个目标可以直接重来（什么都没动过）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.ci = 'pending';
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(2);
    w.ci = 'success';
    expect(await train.runTrain(['start', '--tag', 'v5', '--founder-ok', FOUNDER], io(home))).toBe(0);
  });
});

describe('等收尾：到点列出拖后腿的，不硬来', () => {
  it('各阶段上限（毫秒）：等收尾只有主线 CI 20 分钟、法国会话 13 分钟；本机工人、自动合并的 PR 两项没有上限（只提示不等）', () => {
    expect(train.DEFAULT_LIMITS).toMatchObject({
      ciMs: 20 * 60_000,
      franceMs: 13 * 60_000,
      preflightMs: 2 * 60_000,
      pollMs: 30_000,
    });
    expect(train.DEFAULT_LIMITS).not.toHaveProperty('localMs');
    expect(train.DEFAULT_LIMITS).not.toHaveProperty('prMs');
  });

  it('法国会话到点没收：停下（退出码 3）、点名列出、标记还在、没发版；本机工人、自动合并的 PR 只提示、不算拖后腿', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.workers = RUNNING_WORKER;
    w.prs = [{ number: 77, title: '慢的那个', autoMergeRequest: { enabledAt: 'x' } }];
    franceBusyAfterPreflight(w);
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(3);
    const err = text(w.err);
    expect(err).toContain('拖后腿');
    expect(err).toContain('法国在跑的会话：o/a#5 execute');
    expect(err).not.toContain('本机工人：w1');
    expect(err).not.toContain('#77 慢的那个');
    // 提示打印出来了（打在 out 里），但没当成拖后腿
    const out = text(w.out);
    expect(out).toContain('本机工人 1（只提示，不等）');
    expect(out).toContain('自动合并的 PR 1（只提示，不等）');
    expect(out).toContain('本机工人：w1');
    expect(out).toContain('自动合并的 PR：#77 慢的那个');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
    expect(existsSync(markerFile(home))).toBe(true);
    const s = stateOf(home);
    expect(s.status).toBe('blocked');
    expect(s.phase).toBe(3);
    expect(s.laggards.length).toBe(1);
    expect(w.sshCalls.some((c) => c.includes(' engine off '))).toBe(true); // 暂停已经做了
  });

  it('【故意造出的失败】本机还有工人在跑、还有挂了自动合并没合的 PR，法国会话已经收完：不等，照样往下发版（只提示）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.workers = RUNNING_WORKER;
    w.prs = [{ number: 77, title: '慢的那个', autoMergeRequest: { enabledAt: 'x' } }];
    franceFree(w);
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(0);
    const out = text(w.out);
    expect(out).toContain('这几样只提示、不等');
    expect(out).toContain('本机工人：w1');
    expect(out).toContain('等收尾：都收完了');
    expect(releaseCalls(w.sshCalls).length).toBe(1);
  });

  it('法国会话数中途读不到：不往下走，到点把「读不到」列为拖后腿（不当成 0）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    let polls = 0;
    w.sessions = async () => {
      polls += 1;
      return polls === 1
        ? { ok: true, running: 0, rows: [] }
        : { ok: false, kind: 'timeout', why: 'ssh 60 秒没回完' };
    };
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(3);
    expect(text(w.err)).toContain('读不到（timeout）');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });

  it('等收尾期间主线 CI 红了：立刻停（不等到点）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.workers = RUNNING_WORKER; // 本机工人只提示、不影响 CI 红了立刻停
    let calls = 0;
    const base = io(home);
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === 'gh' && a[0] === 'api' && a[1]?.includes('check-runs')) {
          calls += 1;
          w.ci = calls >= 2 ? 'failure' : 'success'; // 预检绿，进了等收尾就红
        }
        return base.run(c, a);
      },
    });
    expect(code).toBe(3);
    expect(text(w.err)).toContain('主线 CI 红了');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });

  // 2026-10-07 夜：主线上自动合并一个接一个进来，主线头的 CI 每次被新合并取消重跑，「主线头 CI 空下来」等了 21 分钟都等不到。
  // 发出去的是要发的那个提交，看它自己的 CI；不看主线头。
  it('看的是要发的提交的 CI，不是主线头：预检、等收尾读的都是 commits/<提交号>/check-runs', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    const refs: string[] = [];
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === 'gh' && a[0] === 'api' && a[1]?.includes('check-runs')) refs.push(a[1]);
        return base.run(c, a);
      },
    });
    expect(code).toBe(0);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const r of refs) expect(r).toContain(`commits/${SHA}/check-runs`);
  });

  it('【故意造出的失败】要发的提交的 CI 红：预检就拒，什么都不动；不因为主线头是绿的放行', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === 'gh' && a[0] === 'api' && a[1]?.includes('check-runs')) {
          // 只有要发的提交是红的；要是还去读 commits/main，这里回绿，预检就会错放行
          const red = a[1].includes(`commits/${SHA}/`);
          return ok(JSON.stringify([{ status: 'completed', conclusion: red ? 'failure' : 'success' }]));
        }
        return base.run(c, a);
      },
    });
    expect(code).toBe(2);
    expect(text(w.err)).toContain('主线 CI 不是绿的');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });
});

describe('abort：恢复原状', () => {
  it('卡住之后 abort：清标记、法国总开关开回暂停前的样子、状态记成已撤销', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    franceBusyAfterPreflight(w);
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(3);
    expect(w.engineOn).toBe(false);
    expect(existsSync(markerFile(home))).toBe(true);

    w.out.length = 0;
    expect(await train.runTrain(['abort'], io(home))).toBe(0);
    expect(existsSync(markerFile(home))).toBe(false);
    expect(w.engineOn).toBe(true);
    expect(w.sshCalls.some((c) => c.includes(' engine on '))).toBe(true);
    expect(stateOf(home).status).toBe('aborted');
    expect(workerLib.readPauseMarker(home).paused).toBe(false);
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });

  it('暂停前法国总开关就是关的：abort 不去开它', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.engineOn = false;
    franceBusyAfterPreflight(w);
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(3);
    expect(text(w.out)).toContain('跳过（引擎总开关本来就关着');
    expect(w.sshCalls.some((c) => c.includes(' engine off '))).toBe(false);
    expect(await train.runTrain(['abort'], io(home))).toBe(0);
    expect(w.sshCalls.some((c) => c.includes(' engine on '))).toBe(false);
    expect(w.engineOn).toBe(false);
  });

  it('已经动手发过版再 abort：不碰法国总开关（发版后默认关）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.releaseWritesHistory = 'unhealthy';
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(2);
    expect(releaseCalls(w.sshCalls).length).toBe(1);
    w.sshCalls.length = 0;
    expect(await train.runTrain(['abort'], io(home))).toBe(0);
    expect(w.sshCalls.some((c) => c.includes(' engine on '))).toBe(false);
    expect(text(w.out)).toContain('已经动手发过版');
    expect(existsSync(markerFile(home))).toBe(false);
  });

  it('没有在走的一趟：abort 说明白、退出 0，留下的孤儿标记顺手清掉', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    expect(await train.runTrain(['abort'], io(home))).toBe(0);
    expect(text(w.out)).toContain('没有在走的一趟');
    expect(w.sshCalls).toEqual([]);
  });
});

describe('整趟走完', () => {
  it('--sha：预检→暂停→等收尾→发版→等部署→验证→恢复→清单；发版在关总开关之后，发完恢复到发版前（原来开着，开回）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.workers = DONE_WORKER;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(w.err).toEqual([]);
    expect(code).toBe(0);
    const i = (needle: string) => w.sshCalls.findIndex((c) => c.includes(needle));
    expect(i(' engine off ')).toBeGreaterThan(-1);
    expect(i(`/deploy/release.sh ${SHA}`)).toBeGreaterThan(i(' engine off '));
    expect(w.sshCalls.some((c) => c.endsWith('release.sh --check'))).toBe(true);
    expect(existsSync(markerFile(home))).toBe(false); // 发完清了
    expect(w.engineOn).toBe(true); // 发版前开着，发完默认开回（不用 --restore、不用授权）
    expect(i(' engine on ')).toBeGreaterThan(i(`/deploy/release.sh ${SHA}`)); // 发完才开
    expect(
      w.sshCalls.some((c) => c.includes('engine on --reason') && c.includes('发版后恢复发版前的状态')),
    ).toBe(true);
    expect(w.sshCalls.some((c) => c.endsWith('dispatch o/a on'))).toBe(true); // 发版前开着的仓
    expect(w.sshCalls.some((c) => c.includes('dispatch o/b'))).toBe(false); // 发版前关着的仓不动
    expect(stateOf(home).status).toBe('done');
    const out = text(w.out);
    expect(out).toContain('清单（v4 统一，开着 4 张）');
    // 先后段（30、10）在前，其余：20 在母单 40 前
    const order = [...out.matchAll(/^(\d+)\. #(\d+)/gm)].map((m) => Number(m[2]));
    expect(order).toEqual([30, 10, 20, 40]);
    expect(out).toContain('#99'); // 先后段里写了、但已不在开着的单里
    expect(out).toContain('创始人原话：「发版吧」');
  });

  it('发版前总开关就关着：发完仍关着，不去开（也不去碰各仓开关）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.workers = DONE_WORKER;
    w.engineOn = false;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(0);
    expect(w.engineOn).toBe(false);
    expect(w.sshCalls.some((c) => c.includes(' engine on '))).toBe(false);
    expect(w.sshCalls.some((c) => c.includes(' dispatch '))).toBe(false);
    expect(text(w.out)).toContain('发版前就关着，保持关');
  });

  it('发版前总开关就关着、发布过程中被人开了：不盖人的操作，不再关回去', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.engineOn = false;
    const base = io(home);
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      ssh: (c) => {
        const r = base.ssh(c);
        if (c.includes('/deploy/release.sh ') && !c.endsWith('--check')) w.engineOn = true;
        return r;
      },
    });
    expect(code).toBe(0);
    expect(w.engineOn).toBe(true);
    expect(w.sshCalls.some((c) => c.includes(' engine off '))).toBe(false);
    expect(text(w.out)).toContain('发版期间有人开了');
  });

  it('【故意造出的失败】发完恢复不成（engine on 失败）：没成（退出码 2），写明发版已经发出去了，不说「已开回」；同一个目标再跑一次 start 只重试这一步', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.engineOnFails = true;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(2);
    const err = text(w.err);
    expect(err).toContain('恢复没成');
    expect(err).toContain('发版已经发出去了');
    expect(err).toContain('could not connect to database');
    expect(err).toContain('只重试这一步');
    expect(text(w.out)).not.toContain('总开关已开回');
    const s = stateOf(home);
    expect(s.status).toBe('failed');
    expect(s.phase).toBe(7);
    expect(w.engineOn).toBe(false);
    expect(releaseCalls(w.sshCalls).length).toBe(1);
    // 库回来了：同一个目标再跑，从恢复这一步接着走，不再发一遍版
    w.engineOnFails = false;
    w.err.length = 0;
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(0);
    expect(w.engineOn).toBe(true);
    expect(releaseCalls(w.sshCalls).length).toBe(1);
    expect(stateOf(home).status).toBe('done');
  });

  it('【故意造出的失败】engine on 说成了、读回来总开关还是关着：没成，不信「成了」', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.engineOnSticks = true;
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(2);
    expect(text(w.err)).toContain('读回来总开关还是关着');
    expect(stateOf(home).status).toBe('failed');
  });

  it('【故意造出的失败】发版前开着的仓开不回去（dispatch on 失败）：没成，点名是哪个仓；总开关照样开回', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.dispatchFails = true;
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(2);
    expect(text(w.err)).toContain('o/a 的「让 AI 接活」开不回去');
    expect(w.engineOn).toBe(true); // 一项没成不拦着别的项
    expect(stateOf(home).phase).toBe(7);
  });

  it('【故意造出的失败】恢复那一步读不到总开关：没成，不猜着开或关', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    let releaseDone = false;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      ssh: (c) => {
        if (c.includes('/deploy/release.sh ') && !c.endsWith('--check')) releaseDone = true;
        // 发完版、验证之后（第 7 步）才读不到：用 --check 之后的第二次 engine status
        if (
          releaseDone &&
          c.endsWith('engine status') &&
          w.sshCalls.filter((x) => x.endsWith('engine status')).length >= 3
        )
          return { status: 1, stdout: '', stderr: 'could not connect to database' };
        return base.ssh(c);
      },
    });
    expect(code).toBe(2);
    expect(text(w.err)).toContain('恢复没成');
    expect(w.sshCalls.some((c) => c.includes(' engine on '))).toBe(false);
  });

  it('【故意造出的失败】进度记录里没有发版前的开关状态（before 缺）：恢复不猜，没成', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    // 停在第 7 步（恢复）、before 是空的进度记录（比如旧版本留下的）：同一个目标再跑 start 接着走
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    writeFileSync(
      join(home, '.fleet-dao', 'release-train.json'),
      JSON.stringify({
        schema: 1,
        status: 'failed',
        phase: 7,
        startedAt: '2026-10-05T14:00:00.000Z',
        updatedAt: '2026-10-05T14:10:00.000Z',
        target: { kind: 'sha', value: SHA, sha: SHA },
        founderOk: FOUNDER,
        restore: false,
        before: null,
        baseline: null,
        marker: false,
        laggards: [],
        release: { started: true },
      }),
    );
    w.engineOn = false;
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(2);
    expect(text(w.err)).toContain('没记下发版前的开关状态');
    expect(w.sshCalls.some((c) => c.includes(' engine on '))).toBe(false);
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });

  // 2026-10-06 第一次发版撞上：法国在用的版本还没有 engine 子命令（总开关 #1086 之后才有），fleet-api 打用法退出 1，
  // 第 2 步把它当「读不到」停下，发不出去；没有总开关就没有什么要暂停的，当关着、记跳过
  it('在用的版本还没有引擎总开关（engine 子命令不存在）：第 2 步记跳过，照常发版；连不上库之类照旧算读不到', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.workers = DONE_WORKER;
    w.engineLegacy = true;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(w.err).toEqual([]);
    expect(code).toBe(0);
    expect(text(w.out)).toContain('在用的版本还没有引擎总开关');
    expect(w.sshCalls.some((c) => c.includes(' engine off '))).toBe(false);
    expect(w.sshCalls.some((c) => c.includes(`/deploy/release.sh ${SHA}`))).toBe(true);
    // 【故意造出的失败】真的读不到（连不上库）还是停下
    const home2 = freshHome();
    const { w: w2, io: io2 } = makeWorld();
    w2.workers = DONE_WORKER;
    w2.engineStatusFails = true;
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io2(home2))).not.toBe(0);
    expect(text(w2.err)).toContain('总开关读不到');
  });

  it('--restore（明写）：和默认一样，暂停前开着的总开关和仓开关原样开回去，没开着的仓不动', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER_RESTORE, '--restore'],
      io(home),
    );
    expect(code).toBe(0);
    expect(w.engineOn).toBe(true);
    expect(w.sshCalls.some((c) => c.endsWith('dispatch o/a on'))).toBe(true);
    expect(w.sshCalls.some((c) => c.includes('dispatch o/b'))).toBe(false);
  });

  it('暂停前总开关就关着（跳过）：--restore 也不去开（关着的保持关）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.engineOn = false;
    const code = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER_RESTORE, '--restore'],
      io(home),
    );
    expect(code).toBe(0);
    expect(w.engineOn).toBe(false);
    expect(w.sshCalls.some((c) => c.includes(' engine on '))).toBe(false);
  });

  it('卡住之后同一个目标再跑一次 start 接着走；暂停前的样子不会被现在的「关着」盖掉', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    franceBusyAfterPreflight(w);
    expect(
      await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER_RESTORE, '--restore'], io(home)),
    ).toBe(3);
    // 换目标：拒
    expect(await train.runTrain(['start', '--tag', 'v5', '--founder-ok', FOUNDER], io(home))).toBe(1);
    expect(text(w.err)).toContain('还没了结');
    // 法国会话收了，同一个目标再来
    franceFree(w);
    w.err.length = 0;
    expect(
      await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER_RESTORE, '--restore'], io(home)),
    ).toBe(0);
    expect(text(w.out)).toContain('接着上一趟走');
    expect(stateOf(home).before?.master).toBe(true);
    expect(w.engineOn).toBe(true); // 恢复了
    expect(releaseCalls(w.sshCalls).length).toBe(1);
  });

  it('发完版历史末行是 unhealthy（没过健康检查）：停在等部署（退出码 2），标记还在，不恢复', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.releaseWritesHistory = 'unhealthy';
    const code = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER_RESTORE, '--restore'],
      io(home),
    );
    expect(code).toBe(2);
    expect(text(w.err)).toContain('没过健康检查或已退回');
    expect(existsSync(markerFile(home))).toBe(true);
    expect(w.engineOn).toBe(false);
    expect(stateOf(home).phase).toBe(5);
  });

  it('release.sh 退出码 1（有红）：停在发版这一步，不往下走', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.releaseExit = 1;
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(2);
    expect(stateOf(home).phase).toBe(4);
    expect(w.sshCalls.some((c) => c.startsWith('tail -n 1'))).toBe(false);
  });

  it('发完版法国多出新异常：停在验证（卡住），不恢复本机', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    let healthCalls = 0;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === NODE && String(a[0]).endsWith('france.mjs')) {
          healthCalls += 1;
          w.franceBad = healthCalls === 1 ? 1 : 3; // 预检基线 1，发完变 3
          w.franceHealthExit = 1;
        }
        return base.run(c, a);
      },
    });
    expect(code).toBe(3);
    expect(text(w.err)).toContain('多出了异常');
    expect(existsSync(markerFile(home))).toBe(true);
  });

  it('--tag：pnpm publish:pr → 等合并 → 标记出现 → 部署核对；发布 PR 被关了没合就停', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    expect(await train.runTrain(['start', '--tag', 'v5', '--founder-ok', FOUNDER], io(home))).toBe(0);
    expect(w.calls).toContain('pnpm publish:pr');
    expect(text(w.out)).toContain('#995');
    expect(releaseCalls(w.sshCalls)).toEqual([]); // 标记路径不 ssh 跑 release.sh，法国自动发布接手

    const home2 = freshHome();
    const world2 = makeWorld();
    world2.w.prState = 'CLOSED';
    expect(await train.runTrain(['start', '--tag', 'v5', '--founder-ok', FOUNDER], world2.io(home2))).toBe(2);
    expect(text(world2.w.err)).toContain('被关了没合');
  });

  it('--tag：发布 PR 一直不合：到点停下（卡住），点名 PR', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.prState = 'OPEN';
    expect(await train.runTrain(['start', '--tag', 'v5', '--founder-ok', FOUNDER], io(home))).toBe(3);
    expect(text(w.err)).toContain('PR #200 还没合');
  });
});

describe('status', () => {
  it('没有一趟：说没有；卡住的：说在第几步、拖后腿是谁', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    expect(await train.runTrain(['status'], io(home))).toBe(0);
    expect(text(w.out)).toContain('没有发版在走');
    w.out.length = 0;
    franceBusyAfterPreflight(w);
    await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    w.out.length = 0;
    expect(await train.runTrain(['status'], io(home))).toBe(0);
    const out = text(w.out);
    expect(out).toContain('卡住了');
    expect(out).toContain('第 3 步「等收尾」');
    expect(out).toContain('暂停标记：在');
    expect(out).toContain('拖后腿：法国在跑的会话：o/a#5 execute');
  });

  it('状态文件坏了：读不了就明说、退出 2，不覆盖它', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    await train.runTrain(['abort'], io(home)); // 先确保目录里没东西
    const dir = join(home, '.fleet-dao');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'release-train.json'), '{坏的');
    expect(await train.runTrain(['status'], io(home))).toBe(2);
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(2);
    expect(readFileSync(join(dir, 'release-train.json'), 'utf8')).toBe('{坏的');
    expect(w.sshCalls).toEqual([]);
  });
});

describe('认输出的小函数', () => {
  it('parseWorkerStatus：在跑的、说不准的、没查成的分开；已经不在跑了的不算', () => {
    const out = [
      RUNNING_WORKER,
      DONE_WORKER.replace('w1', 'w2'),
      'w3：没查成——meta.json 读不了',
      'w4：codex，档位 high，不确定在跑没跑（起的时候没记上 pid：x），从起来到现在 3 分钟',
    ].join('\n');
    expect(train.parseWorkerStatus(out)).toEqual({ running: ['w1'], uncertain: ['w4'], unreadable: ['w3'] });
    expect(train.parseWorkerStatus('没有起过任何工人')).toEqual({
      running: [],
      uncertain: [],
      unreadable: [],
    });
  });

  it('orderFromDescription / rankIssues：先后段在前，其余挡路的先、母单最后、同级小号在前', () => {
    expect(
      train.orderFromDescription('x\n<!-- fleet:order -->\n1. #5\n2. #3 说明\n<!-- /fleet:order -->'),
    ).toEqual([5, 3]);
    expect(train.orderFromDescription('没有标记')).toEqual([]);
    const r = train.rankIssues(
      [
        { number: 1, title: 'a', labels: [{ name: '母单' }] },
        { number: 2, title: 'b', labels: [{ name: '断链' }] },
        { number: 3, title: 'c', labels: [] },
        { number: 4, title: 'd', labels: [{ name: '本机做' }] },
      ],
      [4, 9],
    );
    expect(r.rows.map((x) => x.number)).toEqual([4, 2, 3, 1]);
    expect(r.missing).toEqual([9]);
    expect(r.rows[0]).toMatchObject({ local: true, handoff: false, listed: true });
    expect(r.rows[3]).toMatchObject({ mother: true, handoff: false });
  });
});

describe('法国在跑会话数的只读查询', () => {
  it('查询脚本：连接参数和 france-query.mjs 的 PSQL 一字不差（会话设成只读）；SQL 只有 select', () => {
    expect(sessionsQuery.PSQL).toEqual(franceQuery.PSQL);
    expect(sessionsQuery.PSQL.join(' ')).toContain('default_transaction_read_only=on');
    expect(sessionsQuery.SQL).toMatch(/^select /);
    expect(sessionsQuery.SQL).not.toMatch(/\b(insert|update|delete|drop|alter|truncate|create|grant)\b/i);
    expect(sessionsQuery.SQL).toContain('ended_at is null');
  });

  it('collect：读到几个就是几个；psql 起不来、退出非 0、回的不是 JSON、形状不对都是明确的失败，不是 0', () => {
    const at = () => new Date('2026-10-05T14:00:00Z');
    const good = sessionsQuery.collect(
      () => ({
        status: 0,
        stdout: '{"running":2,"rows":[{"repo":"o/a","n":1,"stage":"execute"}]}\n',
        stderr: '',
        error: null,
      }),
      at,
    );
    expect(good).toMatchObject({ ok: true, running: 2 });
    const zero = sessionsQuery.collect(
      () => ({ status: 0, stdout: '{"running":0,"rows":[]}', stderr: '', error: null }),
      at,
    );
    expect(zero).toMatchObject({ ok: true, running: 0 });
    for (const bad of [
      { status: null, stdout: '', stderr: '', error: 'ENOENT' },
      { status: 2, stdout: '', stderr: 'FATAL: no pg_hba entry', error: null },
      { status: 0, stdout: '不是 JSON', stderr: '', error: null },
      { status: 0, stdout: '{"running":"2","rows":[]}', stderr: '', error: null },
      { status: 0, stdout: '', stderr: '', error: null },
    ]) {
      const r = sessionsQuery.collect(() => bad, at);
      expect(r.ok).toBe(false);
      expect(r.running).toBeUndefined();
      expect(r.why).toBeTruthy();
    }
  });

  it('realRun：不是那一条 psql 命令就不起', () => {
    expect(sessionsQuery.realRun(['rm', '-rf', 'x'], '')).toMatchObject({
      status: null,
      error: '不许起这条命令',
    });
  });

  it('parseSessions：认得对的；认不出、法国自己报失败都是 ok: false', () => {
    const line = (o: object) => JSON.stringify({ app: 'fleet-france-sessions', schema: 1, at: 'x', ...o });
    expect(sessionsLib.parseSessions(line({ ok: true, running: 3, rows: [] }))).toMatchObject({
      ok: true,
      running: 3,
    });
    expect(sessionsLib.parseSessions(line({ ok: false, why: '连不上库' }))).toMatchObject({
      ok: false,
      kind: 'query-failed',
    });
    expect(sessionsLib.parseSessions(line({ ok: true, running: -1, rows: [] }))).toMatchObject({
      ok: false,
      kind: 'bad-shape',
    });
    expect(sessionsLib.parseSessions('{"app":"别的","schema":1}')).toMatchObject({
      ok: false,
      kind: 'bad-shape',
    });
    expect(sessionsLib.parseSessions('')).toMatchObject({ ok: false, kind: 'bad-json' });
    expect(sessionsLib.parseSessions('<html>')).toMatchObject({ ok: false, kind: 'bad-json' });
  });

  it('fetchRunningSessions：没配 ssh 名字就明说；用本机 node 冒充 ssh 走一遍整条路（读到、读不到、法国那头失败）', async () => {
    const empty = freshHome();
    expect(await sessionsLib.fetchRunningSessions({ home: empty, env: {} })).toMatchObject({
      ok: false,
      kind: 'not-configured',
    });

    const run = (script: string) =>
      sessionsLib.fetchRunningSessions({
        home: empty,
        env: { FLEET_FRANCE_SSH: 'fake-france' },
        scriptFile: join(SCRIPTS, 'france-sessions-query.mjs'),
        command: process.execPath, // 假 ssh：用本机 node 跑一段话，不连任何机器
        argsFor: () => ['-e', script],
        timeoutMs: 15_000,
      });
    const reply = (o: object) =>
      `console.log(JSON.stringify({app:'fleet-france-sessions',schema:1,at:'x',...${JSON.stringify(o)}}))`;
    expect(
      await run(reply({ ok: true, running: 2, rows: [{ repo: 'o/a', n: 3, stage: 'execute' }] })),
    ).toMatchObject({
      ok: true,
      running: 2,
    });
    expect(await run(reply({ ok: true, running: 0, rows: [] }))).toMatchObject({ ok: true, running: 0 });
    expect(await run('process.stderr.write("连不上库\\n"); process.exit(1)')).toMatchObject({
      ok: false,
      kind: 'query-failed',
    });
    expect(await run('process.stderr.write("Permission denied\\n"); process.exit(255)')).toMatchObject({
      ok: false,
      kind: 'ssh-failed',
    });
    expect(await run('console.log("乱的")')).toMatchObject({ ok: false, kind: 'bad-json' });
  });
});

describe('release.sh 发完不再置关（决定 0032 第 4 条、#1256）', () => {
  const releaseSh = readFileSync(fileURLToPath(new URL('../../deploy/release.sh', import.meta.url)), 'utf8');
  /** 发完置关那两层留下的痕迹：函数、命令、记录文件。 */
  const AUTO_OFF_TRACES = [
    'engine_off_after_release',
    'dispatch_off_on_milestone',
    'engine_off_run',
    'dispatch_off_run',
    '.dispatch-off-milestone',
    'fleet-api.ts engine',
    'fleet-api.ts dispatch',
  ];
  const tracesIn = (text: string) => AUTO_OFF_TRACES.filter((x) => text.includes(x));
  it('release.sh 里没有「发完一律置关总开关」「发 v<N> 版置关接活开关」这两层：函数、命令、记录文件都不在', () => {
    expect(tracesIn(releaseSh)).toEqual([]);
  });
  it('【故意造出的失败】放回一个发完置关的调用或命令：检查抓得到', () => {
    expect(tracesIn(`${releaseSh}\nengine_off_after_release "$SHA" || true\n`)).toEqual([
      'engine_off_after_release',
    ]);
    expect(tracesIn(`${releaseSh}\n"$NODE" packages/api/src/bin/fleet-api.ts engine off\n`)).toEqual([
      'fleet-api.ts engine',
    ]);
  });
});
