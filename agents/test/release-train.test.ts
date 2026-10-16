// 发版前先暂停手头的活（#618）：release-train-lib.mjs（一趟发版的各阶段）、法国在跑会话数的只读查询
// （france-sessions-query.mjs / france-sessions-lib.mjs）。
// ssh、gh、git、pnpm、node 子进程、睡眠全部是假的（假时钟：sleep 只是把时间往前拨）；home 用真的临时目录，状态文件是真文件。
// 真跑的那条路（release-train.mjs 外壳里的 ssh）在这里一次都不碰。故意造的失败：没带 --founder-ok、等收尾等 CI 超时、预检读不到会话数、
// 发完版历史末行是 unhealthy、发版期间总开关被人动了（照实报不一致、不替人开）、老现场开回不成功（总开关开不回、仓开关开不回）、
// 没记发版前的状态、验证时多出和发版有关的新提醒、重启打断的提醒到点没撤。发版不关总开关（#2038、决定 0093）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
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
  pid?: number;
  host?: string;
  isAlive?: (pid: number) => boolean;
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
  RELEASE_SH: string;
  LAUNCH_COMMAND_MAX: number;
  releaseBootCommand(sha: string): string;
  releaseLaunchCommand(sha: string, token: string): string;
  parseLaunchReport(out: string): { state: string; exit: number | null; log: string; tail: string } | null;
  runTrain(argv: string[], io: TrainIo): Promise<number>;
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
  driverVerdict(
    s: Record<string, unknown>,
    ctx: { now: Date; isAlive?: (pid: number) => boolean; host?: string; limits?: Record<string, number> },
  ): { dead: boolean; unknown?: boolean; why: string };
  trainAlertNote(ctx: { home: string; now: Date; isAlive?: (pid: number) => boolean; host?: string }): string;
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
const sessionsLib = (await load('france-sessions-lib.mjs')) as SessionsLib;
const sessionsQuery = (await load('france-sessions-query.mjs')) as SessionsQuery;
const franceQuery = (await load('france-query.mjs')) as { PSQL: string[] };
const franceLib = (await load('france-lib.mjs')) as {
  WHERE_NOTIFICATIONS: string;
  RELEASE_ALERT_PREFIXES: string[];
  VERIFY_RETRY_PREFIXES: string[];
};
/** 法国上驾驶舱发版按钮那份（装在 /usr/local/lib/fleet-dao/，读不到 agents/），自己存一份同名列表。 */
const releaseRequest = (await import(
  pathToFileURL(fileURLToPath(new URL('../../deploy/france/release-request/lib.mjs', import.meta.url))).href
)) as { RELEASE_ALERT_PREFIXES: string[]; VERIFY_RETRY_PREFIXES: string[] };

const SHA = 'ab12cd34'.repeat(5);
const OLD = '0123abcd'.repeat(5);
const FOUNDER = '发版吧';
const FOUNDER_RESTORE = '发吧，发完恢复引擎和各仓开关';
const NODE = 'node-fake';
const ok = (stdout = ''): CmdResult => ({ status: 0, stdout, stderr: '' });
/** check-runs?check_name=check 过滤后一页的回话（jq 之后的样子）。 */
const checkPage = (runs: { status: string; conclusion: string | null }[], total = runs.length): CmdResult =>
  ok(JSON.stringify({ total, runs }));
/** release-launch.sh 的回话：state= / exit= / log= 三行，「---」后面是日志末尾。 */
const launchReply = (state: string, exit: number | null = null, tail = ''): CmdResult =>
  ok(`state=${state}\nexit=${exit ?? 'none'}\nlog=/srv/fleet-dao-releases/.train/x.log\n---\n${tail}\n`);
/** ssh 被重置：和真 ssh 一样 status 255。 */
const sshDropped = (): CmdResult => ({
  status: 255,
  stdout: '',
  stderr: 'client_loop: send disconnect: Connection reset by peer',
});

/** 一个假世界：命令的回话都在这里改；calls 记下每条命令。 */
function makeWorld() {
  const w = {
    t: Date.parse('2026-10-05T14:00:00Z'),
    calls: [] as string[],
    sshCalls: [] as string[],
    out: [] as string[],
    err: [] as string[],
    ci: 'success' as 'success' | 'failure' | 'pending',
    ciChecks: 0, // 读了几次 check-runs
    ciStuck: false, // 为真：预检（第一次）之后要发的提交的 CI 一直在跑，第 3 步等不到
    prs: [] as { number: number; title: string; autoMergeRequest: unknown }[],
    lockBusy: false,
    franceHealthExit: 0,
    franceBad: 0,
    franceExtra: [] as { level: string; what: string; where: string; kind?: string; key?: string }[], // 额外的异常，带不带 kind 都行
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
    launchCalls: 0,
    launch: null as null | ((n: number, sha: string) => CmdResult),
    releaseWritesHistory: 'release',
    checkExit: 0,
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
      if (args[0] === 'api' && args[1]?.includes('check-runs')) {
        w.ciChecks += 1;
        const ci = w.ciStuck && w.ciChecks >= 2 ? 'pending' : w.ci;
        return checkPage(
          ci === 'pending'
            ? [{ status: 'in_progress', conclusion: null }]
            : [{ status: 'completed', conclusion: ci }],
        );
      }
      if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(w.prs));
      if (args[0] === 'api' && args[1]?.includes('milestones')) return ok(JSON.stringify(w.milestones));
      if (args[0] === 'issue' && args[1] === 'list') return ok(JSON.stringify(w.issues));
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
            ...w.franceExtra,
          ],
        }),
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
    if (cmd.includes('fleet-release-launch ')) {
      // 假的 release-launch.sh：默认第一次就「发完了」（写历史、回 finished 和退出码）；w.launch 可换成别的回话（断线、还在跑……）
      const sha = /fleet-release-launch ([0-9a-f]+) /.exec(cmd)?.[1];
      w.launchCalls += 1;
      if (w.launch) return w.launch(w.launchCalls, sha ?? '');
      w.history += `\n2026-10-05T14:30:00Z ${sha} ${w.releaseWritesHistory}`;
      return launchReply('finished', w.releaseExit);
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
const stateOf = (home: string) =>
  JSON.parse(readFileSync(join(home, '.fleet-dao', 'release-train.json'), 'utf8')) as {
    status: string;
    phase: number;
    before: { master: boolean; repos: { repo: string; on: boolean }[] | null } | null;
    laggards: string[];
  };
const text = (lines: string[]) => lines.join('\n');
/**
 * 预检那次读到 0 个，之后法国一直有一个会话在跑：等收尾会一直等不到。自动合并的 PR 只提示、不等了（母单 #1121），
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
/** 预检绿，之后要发的提交的 CI 一直在跑：第 3 步（只等 CI，#2038）到点卡住。 */
const ciStuckAfterPreflight = (w: { ciStuck: boolean }) => {
  w.ciStuck = true;
};
const ciGreen = (w: { ciStuck: boolean }) => {
  w.ciStuck = false;
};
/**
 * 老现场：上一回老版本发版车停在第 phase 步（默认第 3 步「等收尾」卡住），总开关是它关的——进度记录的 before
 * 记着发版前开着、各仓开关（o/a 开、o/b 关），没有 pausedMaster（老版本不写这个键）；法国总开关现在关着。
 */
const seedOldScene = (home: string, w: { engineOn: boolean }, over: Record<string, unknown> = {}) => {
  mkdirSync(join(home, '.fleet-dao'), { recursive: true });
  writeFileSync(
    join(home, '.fleet-dao', 'release-train.json'),
    JSON.stringify({
      schema: 1,
      status: 'blocked',
      phase: 3,
      startedAt: '2026-10-05T13:00:00.000Z',
      updatedAt: '2026-10-05T13:20:00.000Z',
      target: { kind: 'sha', value: SHA },
      founderOk: FOUNDER,
      restore: false,
      before: {
        master: true,
        repos: [
          { repo: 'o/a', on: true },
          { repo: 'o/b', on: false },
        ],
        recordedAt: '2026-10-05T13:01:00.000Z',
      },
      baseline: null,
      laggards: ['法国在跑的会话：o/a#5 execute'],
      release: {},
      ...over,
    }),
  );
  w.engineOn = false;
};
const releaseCalls = (ssh: string[]) => ssh.filter((c) => c.includes('fleet-release-launch '));

describe('发版入口是目标提交自带的 release.sh（#1294）', () => {
  it('ssh 的是 release-boot，命令里不调用检出里那份', () => {
    const cmd = train.releaseBootCommand(SHA);
    expect(cmd.startsWith('bash -c ')).toBe(true);
    expect(cmd.endsWith(`fleet-release-boot ${SHA}`)).toBe(true);
    expect(cmd.includes('.boot')).toBe(true); // 解到按提交号命名的私有目录
    expect(cmd.includes('.bootstrap-entry')).toBe(false); // 不共用一个目录
    expect(() => train.releaseBootCommand('不是提交')).toThrow(); // 【故意造出的失败】提交号认不出就不拼命令
    expect(cmd.includes('/srv/fleet-dao/deploy/release.sh')).toBe(false);
    expect(cmd.includes(`bash ${train.RELEASE_SH}`)).toBe(false);
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
    expect(existsSync(join(home, '.fleet-dao', 'release-train.json'))).toBe(false);
  });

  it('--founder-ok 是空的也拒', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', '   '], io(home))).toBe(1);
    expect(w.sshCalls).toEqual([]);
  });

  it('--sha 必给；提交号写法不对、--tag（决定 0032 起没有了）都拒', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    expect(await train.runTrain(['start', '--founder-ok', FOUNDER], io(home))).toBe(1);
    expect(text(w.err)).toContain('要给 --sha');
    expect(await train.runTrain(['start', '--sha', 'zzz', '--founder-ok', FOUNDER], io(home))).toBe(1);
    expect(await train.runTrain(['start', '--tag', 'v5', '--founder-ok', FOUNDER], io(home))).toBe(1);
    expect(
      await train.runTrain(['start', '--sha', SHA, '--tag', 'v5', '--founder-ok', FOUNDER], io(home)),
    ).toBe(1);
    expect(w.sshCalls).toEqual([]);
    expect(train.USAGE).not.toContain('--tag vN');
    expect(train.USAGE).not.toContain('publish:pr');
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
  });

  it('预检没过之后换一个目标可以直接重来（什么都没动过）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.ci = 'pending';
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(2);
    w.ci = 'success';
    expect(await train.runTrain(['start', '--sha', OLD, '--founder-ok', FOUNDER], io(home))).toBe(0);
  });
});

describe('等收尾（只等 CI）：到点列出拖后腿的，不硬来', () => {
  it('各阶段上限（毫秒）：等收尾只等主线 CI 20 分钟（franceMs 13 分钟留着判驱动死活的预算，第 3 步不再等会话）；自动合并的 PR 没有上限（只提示不等）', () => {
    expect(train.DEFAULT_LIMITS).toMatchObject({
      ciMs: 20 * 60_000,
      franceMs: 13 * 60_000,
      preflightMs: 2 * 60_000,
      pollMs: 30_000,
    });
    expect(train.DEFAULT_LIMITS).not.toHaveProperty('localMs');
    expect(train.DEFAULT_LIMITS).not.toHaveProperty('prMs');
  });

  it('法国会话一直在跑：第 3 步不等会话（#2038，release.sh 切版本时自己暂停），照样发版；自动合并的 PR 只提示、不算拖后腿', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.prs = [{ number: 77, title: '慢的那个', autoMergeRequest: { enabledAt: 'x' } }];
    franceBusyAfterPreflight(w);
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(0);
    const out = text(w.out);
    expect(out).toContain('自动合并的 PR 1（只提示，不等）');
    expect(out).toContain('自动合并的 PR：#77 慢的那个');
    expect(out).toContain('等收尾：都收完了');
    expect(out).not.toContain('法国在跑的会话 1');
    expect(text(w.err)).not.toContain('法国在跑的会话：o/a#5 execute');
    expect(releaseCalls(w.sshCalls).length).toBe(1);
    expect(w.sshCalls.some((c) => c.includes(' engine off '))).toBe(false); // 不关总开关（决定 0093）
  });

  it('第 3 步只等 CI：到点还没绿就停下（退出码 3）、点名 CI、没发版、没关总开关', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    ciStuckAfterPreflight(w); // 预检绿，进了等收尾一直在跑
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(3);
    const err = text(w.err);
    expect(err).toContain('拖后腿');
    expect(err).toContain('主线 CI：要发的提交');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
    const s = stateOf(home);
    expect(s.status).toBe('blocked');
    expect(s.phase).toBe(3);
    expect(s.laggards.length).toBe(1);
    expect(w.sshCalls.some((c) => c.includes(' engine off '))).toBe(false);
  });

  it('第 3 步不读法国会话：预检之后会话数读不到也不挡，照样发版（会话只在预检读一次给人看）', async () => {
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
    expect(code).toBe(0);
    expect(polls).toBe(1);
    expect(text(w.err)).not.toContain('读不到（timeout）');
    expect(releaseCalls(w.sshCalls).length).toBe(1);
  });

  it('等收尾期间主线 CI 红了：立刻停（不等到点）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
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
    const { io } = makeWorld();
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
          return checkPage([{ status: 'completed', conclusion: red ? 'failure' : 'success' }]);
        }
        return base.run(c, a);
      },
    });
    expect(code).toBe(2);
    expect(text(w.err)).toContain('主线 CI 不是绿的');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });

  // 2026-10-07 夜：GitHub 的 check-runs 接口连着回 HTTP 500 一个多小时，发版车读不到 CI 就整个卡住。
  // 后备：check-runs 读不出时，点名的提交改看它的 ci 工作流运行。
  const checkRunsDown = (
    base: ReturnType<ReturnType<typeof makeWorld>['io']>,
    runs: { status: string; conclusion: string | null }[] | 'unreadable',
  ) =>
    ({
      ...base,
      run: (c: string, a: string[]) => {
        if (c === 'gh' && a[0] === 'api' && a[1]?.includes('check-runs'))
          return { status: 1, stdout: '', stderr: 'gh: HTTP 500' } as CmdResult;
        if (c === 'gh' && a[0] === 'api' && a[1] === `repos/{owner}/{repo}/commits/${SHA}`)
          return ok(`${SHA}\n`);
        if (c === 'gh' && a[0] === 'api' && a[1]?.includes('actions/runs'))
          return runs === 'unreadable'
            ? ({ status: 1, stdout: '', stderr: 'gh: HTTP 500' } as CmdResult)
            : ok(JSON.stringify(runs));
        return base.run(c, a);
      },
    }) as typeof base;

  it('check-runs 接口读不出：后备看 ci 工作流运行，绿了照样放行', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER],
      checkRunsDown(io(home), [{ status: 'completed', conclusion: 'success' }]),
    );
    expect(code).toBe(0);
    expect(releaseCalls(w.sshCalls).length).toBeGreaterThan(0);
  });

  it('【故意造出的失败】check-runs 读不出、后备里 ci 运行是红的：预检拒；两处都读不出也拒（不当成绿）', async () => {
    const red = makeWorld();
    const redCode = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER],
      checkRunsDown(red.io(freshHome()), [{ status: 'completed', conclusion: 'failure' }]),
    );
    expect(redCode).toBe(2);
    expect(text(red.w.err)).toContain('CI 是红的');
    expect(releaseCalls(red.w.sshCalls)).toEqual([]);

    const down = makeWorld();
    const downCode = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER],
      checkRunsDown(down.io(freshHome()), 'unreadable'),
    );
    expect(downCode).toBe(2);
    expect(text(down.w.err)).toContain('后备也读不到');
    expect(releaseCalls(down.w.sshCalls)).toEqual([]);
  });

  // 2026-10-13：提交上 210 条检查，第一页 100 条里一条 check 都没有，不过滤读成 0 条、发版被拦。
  // 现在按名字过滤（check_name=check）取，并按 total_count 翻页取全。
  const withChecks = (
    base: ReturnType<ReturnType<typeof makeWorld>['io']>,
    onCheck: (url: string) => CmdResult,
    runs: { status: string; conclusion: string | null }[] | 'unreadable' = [],
  ) =>
    ({
      ...base,
      run: (c: string, a: string[]) => {
        if (c === 'gh' && a[0] === 'api' && a[1]?.includes('check-runs')) return onCheck(a[1]);
        if (c === 'gh' && a[0] === 'api' && a[1] === `repos/{owner}/{repo}/commits/${SHA}`)
          return ok(`${SHA}\n`);
        if (c === 'gh' && a[0] === 'api' && a[1]?.includes('actions/runs'))
          return runs === 'unreadable'
            ? ({ status: 1, stdout: '', stderr: 'gh: HTTP 500' } as CmdResult)
            : ok(JSON.stringify(runs));
        return base.run(c, a);
      },
    }) as typeof base;

  it('检查多到一页装不下：按 check_name=check 过滤取，不被别的检查挤出第一页，判绿', async () => {
    const { w, io } = makeWorld();
    const urls: string[] = [];
    const code = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER],
      withChecks(io(freshHome()), (u) => {
        urls.push(u);
        // 不带过滤就是 100 条别的检查、没有 check；带了过滤才有
        return u.includes('check_name=check')
          ? checkPage([{ status: 'completed', conclusion: 'success' }])
          : checkPage([]);
      }),
    );
    expect(code).toBe(0);
    for (const u of urls) expect(u).toContain('check_name=check');
    expect(releaseCalls(w.sshCalls).length).toBeGreaterThan(0);
  });

  it('total_count 比本页多：翻到第二页取全，第二页里红的也算', async () => {
    const { w, io } = makeWorld();
    const code = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER],
      withChecks(io(freshHome()), (u) =>
        u.endsWith('&page=1')
          ? checkPage([{ status: 'completed', conclusion: 'success' }], 2)
          : checkPage([{ status: 'completed', conclusion: 'failure' }], 2),
      ),
    );
    expect(code).toBe(2);
    expect(text(w.err)).toContain('CI 是红的');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });

  it('【故意造出的失败】check 过滤后 0 条：即使 ci 工作流运行已全绿也不放行（pending，佐证写进原因）', async () => {
    const { w, io } = makeWorld();
    const code = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER],
      withChecks(io(freshHome()), () => checkPage([]), [{ status: 'completed', conclusion: 'success' }]),
    );
    expect(code).toBe(2);
    expect(text(w.err)).toContain('还没有汇总检查');
    expect(text(w.err)).toContain('ci 工作流运行已全绿');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });

  it('【故意造出的失败】check 过滤后 0 条、ci 工作流没跑完 / 读不到：不放行', async () => {
    for (const runs of [[{ status: 'in_progress', conclusion: null }], 'unreadable'] as const) {
      const { w, io } = makeWorld();
      const code = await train.runTrain(
        ['start', '--sha', SHA, '--founder-ok', FOUNDER],
        withChecks(io(freshHome()), () => checkPage([]), runs as never),
      );
      expect(code).toBe(2);
      expect(text(w.err)).toContain('还没有汇总检查');
      expect(releaseCalls(w.sshCalls)).toEqual([]);
    }
  });

  it('【故意造出的失败】check 红：预检拒', async () => {
    const { w, io } = makeWorld();
    const code = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER],
      withChecks(io(freshHome()), () => checkPage([{ status: 'completed', conclusion: 'failure' }])),
    );
    expect(code).toBe(2);
    expect(text(w.err)).toContain('CI 是红的');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });

  it('【故意造出的失败】翻页时第二页读不出：unknown，不拿第一页的绿放行', async () => {
    const { w, io } = makeWorld();
    const code = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER],
      withChecks(
        io(freshHome()),
        (u) =>
          u.endsWith('&page=1')
            ? checkPage([{ status: 'completed', conclusion: 'success' }], 2)
            : ({ status: 1, stdout: '', stderr: 'gh: HTTP 502' } as CmdResult),
        'unreadable',
      ),
    );
    // 第一页读到的绿不算；check 读不出走既有后备（ci 工作流运行），后备也读不出就是 unknown、拒
    expect(code).toBe(2);
    expect(text(w.err)).toContain('第 2 页');
    expect(text(w.err)).toContain('后备也读不到');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });
});

describe('abort：撤掉这一趟（只有老现场要开回总开关）', () => {
  it('卡住之后 abort：这一趟没关过总开关，不碰它（不开不关）、状态记成已撤销', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    ciStuckAfterPreflight(w);
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(3);
    expect(w.engineOn).toBe(true);

    w.out.length = 0;
    expect(await train.runTrain(['abort'], io(home))).toBe(0);
    expect(w.engineOn).toBe(true);
    expect(w.sshCalls.some((c) => c.includes(' engine on ') || c.includes(' engine off '))).toBe(false);
    expect(text(w.out)).toContain('这一趟没关过法国总开关');
    expect(stateOf(home).status).toBe('aborted');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });

  it('老现场（老版本发版车关的总开关）还没发版就 abort：开回发版前的样子', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    seedOldScene(home, w);
    expect(await train.runTrain(['abort'], io(home))).toBe(0);
    expect(w.engineOn).toBe(true);
    expect(w.sshCalls.some((c) => c.includes(' engine on '))).toBe(true);
    expect(stateOf(home).status).toBe('aborted');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });

  it('发版前法国总开关就是关的：abort 不去开它', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.engineOn = false;
    ciStuckAfterPreflight(w);
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(3);
    expect(text(w.out)).toContain('发版前总开关关着，已记');
    expect(w.sshCalls.some((c) => c.includes(' engine off '))).toBe(false);
    expect(await train.runTrain(['abort'], io(home))).toBe(0);
    expect(w.sshCalls.some((c) => c.includes(' engine on '))).toBe(false);
    expect(w.engineOn).toBe(false);
  });

  it('已经动手发过版再 abort：不碰法国总开关；老现场（老版本关的）也保持关，说清已经动手发过版', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.releaseWritesHistory = 'unhealthy';
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(2);
    expect(releaseCalls(w.sshCalls).length).toBe(1);
    w.sshCalls.length = 0;
    expect(await train.runTrain(['abort'], io(home))).toBe(0);
    expect(w.sshCalls.some((c) => c.includes(' engine on '))).toBe(false);
    expect(w.engineOn).toBe(true);

    const home2 = freshHome();
    const { w: w2, io: io2 } = makeWorld();
    seedOldScene(home2, w2, { status: 'failed', phase: 5, release: { started: true } });
    expect(await train.runTrain(['abort'], io2(home2))).toBe(0);
    expect(w2.sshCalls.some((c) => c.includes(' engine on '))).toBe(false);
    expect(w2.engineOn).toBe(false);
    expect(text(w2.out)).toContain('已经动手发过版');
  });

  it('没有在走的一趟：abort 说明白、退出 0', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    expect(await train.runTrain(['abort'], io(home))).toBe(0);
    expect(text(w.out)).toContain('没有在走的一趟');
    expect(w.sshCalls).toEqual([]);
  });
});

describe('整趟走完', () => {
  it('--sha：预检→本机（占位）→暂停法国（只记总开关）→等收尾（只等 CI）→发版→等部署→验证→恢复（核对）→清单；全程不关不开总开关、不碰仓开关', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(w.err).toEqual([]);
    expect(code).toBe(0);
    const i = (needle: string) => w.sshCalls.findIndex((c) => c.includes(needle));
    expect(i(' engine off ')).toBe(-1); // 第 2 步不调 engine off（决定 0093）
    expect(i(' engine on ')).toBe(-1); // 第 7 步发版前开着、现在开着：一致，不碰
    expect(i(' dispatch ')).toBe(-1);
    expect(i(`fleet-release-launch ${SHA}`)).toBeGreaterThan(i('engine status')); // 先记下发版前的总开关再发
    expect(releaseCalls(w.sshCalls)).toHaveLength(1);
    const launch = releaseCalls(w.sshCalls)[0] ?? '';
    // 发布入口是 release-boot（gzip 后 base64 送过去），不是检出里那份 release.sh
    const b64 = launch.split(' ').at(-1) ?? '';
    expect(gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')).toBe(
      readFileSync(join(SCRIPTS, 'release-boot.sh'), 'utf8'),
    );
    expect(launch.includes(`bash ${train.RELEASE_SH}`)).toBe(false);
    expect(w.sshCalls.some((c) => c.endsWith('release.sh --check'))).toBe(true);
    expect(w.engineOn).toBe(true);
    const s = stateOf(home);
    expect(s.status).toBe('done');
    expect(s.before).toMatchObject({ master: true, pausedMaster: false });
    const out = text(w.out);
    expect(out).toContain('不关总开关：release.sh 切版本时只暂停在跑的任务（决定 0093）');
    expect(out).toContain('核对和发版前一致（开着）');
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
    w.engineOn = false;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(code).toBe(0);
    expect(w.engineOn).toBe(false);
    expect(w.sshCalls.some((c) => c.includes(' engine on '))).toBe(false);
    expect(w.sshCalls.some((c) => c.includes(' dispatch '))).toBe(false);
    expect(text(w.out)).toContain('核对和发版前一致（关着）');
  });

  it('发版前总开关就关着、发布过程中被人开了：不盖人的操作，不关回去，照实报不一致', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.engineOn = false;
    const base = io(home);
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      ssh: (c) => {
        const r = base.ssh(c);
        if (c.includes('fleet-release-launch ')) w.engineOn = true;
        return r;
      },
    });
    expect(code).toBe(0);
    expect(w.engineOn).toBe(true);
    expect(w.sshCalls.some((c) => c.includes(' engine off '))).toBe(false);
    expect(text(w.err)).toContain('和发版前不一致：发版前关着，现在开着');
  });

  it('【故意造出的失败】发版前开着、发布过程中被人关了：第 7 步不自动开，照实报不一致', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      ssh: (c) => {
        const r = base.ssh(c);
        if (c.includes('fleet-release-launch ')) w.engineOn = false;
        return r;
      },
    });
    expect(code).toBe(0);
    expect(w.engineOn).toBe(false); // 没替人开
    expect(w.sshCalls.some((c) => c.includes(' engine on ') || c.includes(' dispatch '))).toBe(false);
    const err = text(w.err);
    expect(err).toContain('和发版前不一致：发版前开着，现在关着');
    expect(err).toContain('不替人开');
    expect(text(w.out)).not.toContain('核对和发版前一致');
    expect(stateOf(home).status).toBe('done');
  });

  it('老现场（上一回老版本发版车关的总开关）：同一个目标再跑 start，第 7 步开回总开关和发版前开着的仓', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    seedOldScene(home, w);
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(0);
    // 停在第 3 步：从第 3 步接着走，第 2 步不再跑；第 7 步按老规矩开回
    expect(w.engineOn).toBe(true);
    expect(
      w.sshCalls.some((c) => c.includes('engine on --reason') && c.includes('老版本发版车关的总开关')),
    ).toBe(true);
    expect(w.sshCalls.some((c) => c.endsWith('dispatch o/a on'))).toBe(true); // 发版前开着的仓
    expect(w.sshCalls.some((c) => c.includes('dispatch o/b'))).toBe(false); // 发版前关着的仓不动
    expect(w.sshCalls.some((c) => c.includes(' engine off '))).toBe(false);
    expect(text(w.out)).toContain('已开回（上一回老版本发版车关的');
    expect(stateOf(home).status).toBe('done');

    // 停在第 2 步的老现场：第 2 步认出是老版本关的，before 不被现在的「关着」盖掉
    const home2 = freshHome();
    const { w: w2, io: io2 } = makeWorld();
    seedOldScene(home2, w2, { status: 'failed', phase: 2 });
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io2(home2))).toBe(0);
    expect(text(w2.out)).toContain('总开关是上一回老版本发版车关的');
    expect(stateOf(home2).before).toMatchObject({ master: true, pausedMaster: true });
    expect(w2.engineOn).toBe(true);
    expect(w2.sshCalls.some((c) => c.includes(' engine off '))).toBe(false);
  });

  it('【故意造出的失败】老现场发完开不回（engine on 失败）：没成（退出码 2），写明发版已经发出去了，不说「已开回」；同一个目标再跑一次 start 只重试这一步', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    seedOldScene(home, w);
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

  it('【故意造出的失败】老现场 engine on 说成了、读回来总开关还是关着：没成，不信「成了」', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    seedOldScene(home, w);
    w.engineOnSticks = true;
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home))).toBe(2);
    expect(text(w.err)).toContain('读回来总开关还是关着');
    expect(stateOf(home).status).toBe('failed');
  });

  it('【故意造出的失败】老现场发版前开着的仓开不回去（dispatch on 失败）：没成，点名是哪个仓；总开关照样开回', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    seedOldScene(home, w);
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
        if (c.includes('fleet-release-launch ')) releaseDone = true;
        // 发完版、验证之后（第 7 步）才读不到：第 2 步、第 6 步各读一次，第三次 engine status 是第 7 步
        if (
          releaseDone &&
          c.endsWith('engine status') &&
          w.sshCalls.filter((x) => x.endsWith('engine status')).length >= 2
        )
          return { status: 1, stdout: '', stderr: 'could not connect to database' };
        return base.ssh(c);
      },
    });
    expect(code).toBe(2);
    expect(text(w.err)).toContain('恢复没成');
    expect(w.sshCalls.some((c) => c.includes(' engine on '))).toBe(false);
    expect(stateOf(home).phase).toBe(7);
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
    w.engineLegacy = true;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    expect(w.err).toEqual([]);
    expect(code).toBe(0);
    expect(text(w.out)).toContain('在用的版本还没有引擎总开关');
    expect(w.sshCalls.some((c) => c.includes(' engine off '))).toBe(false);
    expect(w.sshCalls.some((c) => c.includes(`fleet-release-launch ${SHA}`))).toBe(true);
    // 【故意造出的失败】真的读不到（连不上库）还是停下
    const home2 = freshHome();
    const { w: w2, io: io2 } = makeWorld();
    w2.engineStatusFails = true;
    expect(await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io2(home2))).not.toBe(0);
    expect(text(w2.err)).toContain('总开关读不到');
  });

  it('--restore（明写）：和默认一样，这一趟没关过总开关就不碰它，也不碰各仓开关', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const code = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER_RESTORE, '--restore'],
      io(home),
    );
    expect(code).toBe(0);
    expect(w.engineOn).toBe(true);
    expect(w.sshCalls.some((c) => c.includes(' engine on ') || c.includes(' engine off '))).toBe(false);
    expect(w.sshCalls.some((c) => c.includes(' dispatch '))).toBe(false);
  });

  it('发版前总开关就关着：--restore 也不去开（关着的保持关）', async () => {
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

  it('卡住之后同一个目标再跑一次 start 接着走；发版前记下的总开关不被改写', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    ciStuckAfterPreflight(w);
    expect(
      await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER_RESTORE, '--restore'], io(home)),
    ).toBe(3);
    // 换目标：拒
    expect(await train.runTrain(['start', '--sha', OLD, '--founder-ok', FOUNDER], io(home))).toBe(1);
    expect(text(w.err)).toContain('还没了结');
    // CI 绿了，同一个目标再来
    ciGreen(w);
    w.err.length = 0;
    expect(
      await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER_RESTORE, '--restore'], io(home)),
    ).toBe(0);
    expect(text(w.out)).toContain('接着上一趟走');
    expect(stateOf(home).before?.master).toBe(true);
    expect(w.engineOn).toBe(true);
    expect(w.sshCalls.some((c) => c.includes(' engine on ') || c.includes(' engine off '))).toBe(false);
    expect(releaseCalls(w.sshCalls).length).toBe(1);
  });

  it('发完版历史末行是 unhealthy（没过健康检查）：停在等部署（退出码 2），不走到核对；总开关一直没动', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.releaseWritesHistory = 'unhealthy';
    const code = await train.runTrain(
      ['start', '--sha', SHA, '--founder-ok', FOUNDER_RESTORE, '--restore'],
      io(home),
    );
    expect(code).toBe(2);
    expect(text(w.err)).toContain('没过健康检查或已退回');
    expect(w.engineOn).toBe(true);
    expect(w.sshCalls.some((c) => c.includes(' engine on ') || c.includes(' engine off '))).toBe(false);
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
  });

  // #1740：第 6 步比「哪几条是新出现的」，只拦跟新版有关的；任务自己停下（kind task-park）只列出来
  type Extra = { level: string; what: string; where: string; kind?: string; key?: string };
  const parkStalled: Extra = {
    level: 'bad',
    what: '#1707 卡住了：验收 2 轮都没过',
    where: 'x',
    kind: 'task-park',
    key: 'task:o/fleet-dao#1707:stalled',
  };
  const parkAlert: Extra = {
    level: 'bad',
    what: '没处理的提醒：#79 动手 3 轮都没过（12 分钟前）',
    where: 'x',
    kind: 'task-park',
    key: 'task:o/fleet-dao#79:code-fail',
  };
  const jobFailing: Extra = {
    level: 'bad',
    what: '定时任务「巡查」最近一轮没跑成：超时',
    where: 'x',
    key: 'job:巡查',
  };
  const jobOld: Extra = { level: 'bad', what: '规矩同步没成：x', where: 'y', key: 'sync:rules' };
  /** 预检读到 before、验证读到 after；预检基线 franceBad 条（带 key 的假异常）。 */
  async function verifyWith(before: Extra[], after: Extra[], bad = 4) {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    let healthCalls = 0;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === NODE && String(a[0]).endsWith('france.mjs')) {
          healthCalls += 1;
          w.franceBad = bad;
          w.franceExtra = healthCalls === 1 ? before : after;
          w.franceHealthExit = 1;
        }
        return base.run(c, a);
      },
    });
    return { code, w, home };
  }

  it('预检 4 条，验证时多出「#1707 卡住了」和一条 task: 开头的提醒：第 6 步通过，另起一行列出单子停下的', async () => {
    const { code, w } = await verifyWith([], [parkStalled, parkAlert]);
    expect(code).toBe(0);
    expect(text(w.err)).not.toContain('多出了异常');
    const out = text(w.out);
    const line = out.split('\n').find((l) => l.includes('发版期间单子停下的'));
    expect(line).toBeDefined();
    expect(line).toContain('#1707 卡住了');
    expect(line).toContain('#79 动手 3 轮都没过');
    expect(out.indexOf('验证：法国')).toBeLessThan(out.indexOf('发版期间单子停下的'));
  });

  it('验证时多出一条定时任务没跑成（不是 task-park）：拦下，说明里只列这一条，不列单子停下的', async () => {
    const { code, w } = await verifyWith([], [parkStalled, jobFailing]);
    expect(code).toBe(3);
    const err = text(w.err);
    expect(err).toContain('多出了异常');
    expect(err).toContain('定时任务「巡查」最近一轮没跑成');
    expect(err).not.toContain('#1707 卡住了');
  });

  // #2038：第 6 步里提醒项只拦和这次发版有关的（键前缀），重启打断的几类在窗口里重试；健康项照旧拦
  /** france-lib.mjs 给提醒的 where（导出的 WHERE_NOTIFICATIONS），key 是提醒的 dedupe_key。 */
  const ALERT_WHERE = franceLib.WHERE_NOTIFICATIONS;
  const alertOf = (key: string, title: string): Extra => ({
    level: 'bad',
    what: `没处理的提醒：${title}（3 分钟前）`,
    where: ALERT_WHERE,
    key,
  });
  /** 第 n 次读 france.mjs 时的额外异常（1＝预检，2 起是第 6 步）。 */
  async function verifySeq(extraAt: (n: number) => Extra[], limits: Record<string, number> = {}) {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home, limits);
    let healthCalls = 0;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === NODE && String(a[0]).endsWith('france.mjs')) {
          healthCalls += 1;
          w.franceExtra = extraAt(healthCalls);
        }
        return base.run(c, a);
      },
    });
    return { code, w, home, healthCalls: () => healthCalls };
  }

  it('验证时多出一条和发版无关的新提醒（任务失败）：不拦，第 6 步通过，另起一行列出来', async () => {
    const unrelated = alertOf('wf:failure:o/a#5', '#5 动手失败了');
    const { code, w } = await verifySeq((n) => (n === 1 ? [] : [unrelated]));
    expect(code).toBe(0);
    expect(text(w.err)).not.toContain('多出了异常');
    const out = text(w.out);
    const line = out.split('\n').find((l) => l.includes('和这次发版无关'));
    expect(line).toBeDefined();
    expect(line).toContain('#5 动手失败了');
    expect(out.indexOf('验证：法国')).toBeLessThan(out.indexOf('和这次发版无关'));
  });

  it('【故意造出的失败】验证时多出和发版有关的新提醒（auto-release:、engine-drain、engine-session-io、cli-upgrade:、retired-schedule:）：拦下', async () => {
    for (const key of [
      'auto-release:rules:abc123',
      'engine-drain',
      'engine-session-io:/srv/x',
      'cli-upgrade:claude',
      'retired-schedule:nightly',
    ]) {
      const hit = alertOf(key, `提醒 ${key}`);
      const { code, w } = await verifySeq((n) =>
        n === 1 ? [] : [hit, alertOf('wf:failure:o/a#5', '无关的')],
      );
      expect(code, key).toBe(3);
      const err = text(w.err);
      expect(err, key).toContain('多出了异常');
      expect(err, key).toContain(`提醒 ${key}`);
      expect(err, key).not.toContain('无关的');
    }
  });

  it('提醒口径只有一份：发版车用的就是 france-lib.mjs 导出的；和法国上发版按钮那份（release-request/lib.mjs）逐项相等，漂了就红', () => {
    const t = train as unknown as { RELEASE_ALERT_PREFIXES: string[]; VERIFY_RETRY_PREFIXES: string[] };
    expect(t.RELEASE_ALERT_PREFIXES).toBe(franceLib.RELEASE_ALERT_PREFIXES);
    expect(t.VERIFY_RETRY_PREFIXES).toBe(franceLib.VERIFY_RETRY_PREFIXES);
    expect(franceLib.RELEASE_ALERT_PREFIXES).toEqual([
      'auto-release:',
      'engine-drain',
      'engine-session-io',
      'cli-upgrade:',
      'retired-schedule:',
    ]);
    expect(franceLib.VERIFY_RETRY_PREFIXES).toEqual(['watchdog:job:', 'watchdog-down:', 'deploy-lag:']);
    expect(releaseRequest.RELEASE_ALERT_PREFIXES).toEqual(franceLib.RELEASE_ALERT_PREFIXES);
    expect(releaseRequest.VERIFY_RETRY_PREFIXES).toEqual(franceLib.VERIFY_RETRY_PREFIXES);
  });

  it('【故意造出的失败】提醒的 where 改一个字就不认作提醒：按健康项拦（判别靠导出的常量，不靠文案片段）', async () => {
    const fake: Extra = { ...alertOf('wf:failure:o/a#5', '无关的'), where: `${ALERT_WHERE} ` };
    const { code } = await verifySeq((n) => (n === 1 ? [] : [fake]));
    expect(code).toBe(3);
  });

  it('健康项照旧拦：键长得像无关提醒、但不是提醒（where 不是提醒表）也拦', async () => {
    const health: Extra = { level: 'bad', what: '服务 fleet-api 是 failed', where: 'x', key: 'wf:failure:x' };
    const { code, w } = await verifySeq((n) => (n === 1 ? [] : [health]));
    expect(code).toBe(3);
    expect(text(w.err)).toContain('服务 fleet-api 是 failed');
  });

  it('重启打断的新提醒（watchdog:job:）过一会儿自己撤了：第 6 步重读，撤了就过', async () => {
    const lag = alertOf('watchdog:job:hourly-reconcile', '每小时对账被重启打断');
    const { code, w, healthCalls } = await verifySeq((n) => (n === 2 || n === 3 ? [lag] : []), {
      verifyMs: 10_000,
    });
    expect(code).toBe(0);
    expect(healthCalls()).toBe(4);
    expect(text(w.out)).toContain('发布重启打断的 1 条还没撤');
    expect(text(w.err)).not.toContain('多出了异常');
  });

  it('【故意造出的失败】重启打断的新提醒（watchdog-down:、deploy-lag:）到 verifyMs 还没撤：卡住（退出码 3），点名', async () => {
    const down = alertOf('watchdog-down:engine', '看门狗没按期跑完');
    const lag = alertOf('deploy-lag:main', '跟不上主线');
    const { code, w, home } = await verifySeq((n) => (n === 1 ? [] : [down, lag]), { verifyMs: 3000 });
    expect(code).toBe(3);
    const err = text(w.err);
    expect(err).toContain('发布重启打断的 2 条');
    expect(err).toContain('看门狗没按期跑完');
    expect(err).toContain('跟不上主线');
    expect(stateOf(home).phase).toBe(6);
  });

  it('条数不变但换了一条（旧的消失、新的非 task-park 出现）：拦下', async () => {
    const { code, w } = await verifyWith([jobOld], [jobFailing]);
    expect(code).toBe(3);
    expect(text(w.err)).toContain('定时任务「巡查」最近一轮没跑成');
    expect(text(w.err)).not.toContain('规矩同步没成');
  });

  it('预检就有的异常验证时还在：不算新出现；单子停下的超过 8 条只列 8 条并写共几条', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...parkStalled,
      what: `#${2000 + i} 卡住了：x`,
      key: `task:o/fleet-dao#${2000 + i}:stalled`,
    }));
    const { code, w } = await verifyWith([jobOld], [jobOld, ...many]);
    expect(code).toBe(0);
    const line = text(w.out)
      .split('\n')
      .find((l) => l.includes('发版期间单子停下的'));
    expect(line).toContain('共 10 条');
    expect(line).toContain('#2007 卡住了');
    expect(line).not.toContain('#2008 卡住了');
  });

  // #1292：暂停期单必然「没动」，按异常类别 kind 过滤，不看文案
  const idleIssue = {
    level: 'bad',
    what: '#1287 29 分钟没动，手上也没有会话（在干活 · implement）：多半停在等人或等一个派不出的路由',
    where: 'x',
    kind: 'task-idle',
  };

  it('暂停期多出「单没动、手上没会话」（kind task-idle）：第 6 步照过，发版车走完恢复本机', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    let healthCalls = 0;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === NODE && String(a[0]).endsWith('france.mjs')) {
          healthCalls += 1;
          w.franceBad = 1;
          w.franceExtra =
            healthCalls === 1 ? [] : [idleIssue, { ...idleIssue, level: 'note', what: '#9 70 分钟没动' }];
          w.franceHealthExit = 1;
        }
        return base.run(c, a);
      },
    });
    expect(code).toBe(0);
    expect(healthCalls).toBe(2);
    expect(text(w.err)).not.toContain('多出了异常');
  });

  it('只看 kind、不看文案：别的异常哪怕文案也写「没动」，没有 kind 照拦', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    let healthCalls = 0;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === NODE && String(a[0]).endsWith('france.mjs')) {
          healthCalls += 1;
          w.franceExtra =
            healthCalls === 1
              ? []
              : [{ level: idleIssue.level, what: idleIssue.what, where: idleIssue.where }];
          w.franceHealthExit = 1;
        }
        return base.run(c, a);
      },
    });
    expect(code).toBe(3);
    expect(text(w.err)).toContain('多出了异常');
    expect(text(w.err)).toContain('29 分钟没动');
  });

  it('暂停期同时多出「没动」和一条别的异常：别的那条照拦（「没动」不计，别的计）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    let healthCalls = 0;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === NODE && String(a[0]).endsWith('france.mjs')) {
          healthCalls += 1;
          w.franceExtra =
            healthCalls === 1
              ? [idleIssue] // 预检时就有一条「没动」：基线口径和验证一致，不给新增异常留空位
              : [idleIssue, { level: 'bad', what: '规矩同步没成：x', where: 'y' }];
          w.franceHealthExit = 1;
        }
        return base.run(c, a);
      },
    });
    expect(code).toBe(3);
    expect(text(w.err)).toContain('多出了异常');
    expect(text(w.err)).toContain('规矩同步没成');
    expect(text(w.err)).not.toContain('29 分钟没动');
  });

  // #1520：暂停期路由探针不跑，在线路由的结论必然变旧（过 45 分钟算旧），按类别 kind 忽略，不看文案
  const staleRoute = {
    level: 'bad',
    what: '路由 claude-solo:opus-5.5:claude-code 算在线，但结论 51 分钟没更新（过 45 分钟算旧：在线是旧结论）',
    where: 'routes',
    kind: 'route-stale',
  };

  it('暂停期多出一条「路由结论 51 分钟没更新」（kind route-stale）：第 6 步照过，发版车走完恢复本机', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    let healthCalls = 0;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === NODE && String(a[0]).endsWith('france.mjs')) {
          healthCalls += 1;
          w.franceBad = 1; // 预检基线 1 条异常
          w.franceExtra = healthCalls === 1 ? [] : [staleRoute];
          w.franceHealthExit = 1;
        }
        return base.run(c, a);
      },
    });
    expect(code).toBe(0);
    expect(healthCalls).toBe(2);
    expect(text(w.err)).not.toContain('多出了异常');
    expect(text(w.out)).toContain('路由结论没更新 1 处');
  });

  it('暂停期多出路由旧结论，同时多出一条别的异常（服务不 active）：别的那条照拦', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    let healthCalls = 0;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === NODE && String(a[0]).endsWith('france.mjs')) {
          healthCalls += 1;
          w.franceBad = 1;
          w.franceExtra =
            healthCalls === 1
              ? []
              : [staleRoute, { level: 'bad', what: '服务 fleet-engine 不是 active（failed）', where: 'y' }];
          w.franceHealthExit = 1;
        }
        return base.run(c, a);
      },
    });
    expect(code).toBe(3);
    expect(text(w.err)).toContain('多出了异常');
    expect(text(w.err)).toContain('不是 active');
    expect(text(w.err)).not.toContain('51 分钟没更新');
  });

  it('【故意造出的失败】文案和路由旧结论一模一样但没带 kind：照拦，不靠文案放过', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    let healthCalls = 0;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === NODE && String(a[0]).endsWith('france.mjs')) {
          healthCalls += 1;
          w.franceExtra =
            healthCalls === 1
              ? []
              : [{ level: staleRoute.level, what: staleRoute.what, where: staleRoute.where }];
          w.franceHealthExit = 1;
        }
        return base.run(c, a);
      },
    });
    expect(code).toBe(3);
    expect(text(w.err)).toContain('多出了异常');
    expect(text(w.err)).toContain('51 分钟没更新');
  });

  it('新增的是「没读到」：照拦', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    let healthCalls = 0;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === NODE && String(a[0]).endsWith('france.mjs')) {
          healthCalls += 1;
          w.franceExtra = healthCalls === 1 ? [] : [{ level: 'unread', what: '没读到：库（x）', where: 'y' }];
          w.franceHealthExit = 1;
        }
        return base.run(c, a);
      },
    });
    expect(code).toBe(3);
    expect(text(w.err)).toContain('多出了异常');
  });

  it('【故意造出的失败】france.mjs --json 输出不是 JSON：验证是「没成」，不当没异常放过', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const base = io(home);
    let healthCalls = 0;
    const code = await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], {
      ...base,
      run: (c, a) => {
        if (c === NODE && String(a[0]).endsWith('france.mjs')) {
          healthCalls += 1;
          if (healthCalls === 2)
            return { status: 0, stdout: '断链排查：0 处异常、0 处没读到、0 处留意', stderr: '' };
        }
        return base.run(c, a);
      },
    });
    expect(code).toBe(2);
    expect(text(w.err)).toContain('不是 JSON');
  });
});

describe('status', () => {
  it('没有一趟：说没有；卡住的：说在第几步、拖后腿是谁', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    expect(await train.runTrain(['status'], io(home))).toBe(0);
    expect(text(w.out)).toContain('没有发版在走');
    w.out.length = 0;
    ciStuckAfterPreflight(w);
    await train.runTrain(['start', '--sha', SHA, '--founder-ok', FOUNDER], io(home));
    w.out.length = 0;
    expect(await train.runTrain(['status'], io(home))).toBe(0);
    const out = text(w.out);
    expect(out).toContain('卡住了');
    expect(out).toContain('第 3 步「等收尾」');
    expect(out).toContain('法国总开关发版前：开着；');
    expect(out).toContain('拖后腿：主线 CI：要发的提交');
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

describe('驱动死了：认得出、接着走（#1674）', () => {
  const MIN = 60_000;
  // 轮询按真实的 30 秒：总时限 15 分钟配 1 秒一圈要转 900 圈，CI 忙时单条测试超过 5 秒
  const LIMITS = { releaseMs: 15 * MIN, deadMarginMs: 5 * MIN, pollMs: 30_000 };
  const withDriver = (io: TrainIo, extra: Partial<TrainIo> = {}): TrainIo => ({
    ...io,
    pid: 4242,
    host: 'box',
    isAlive: () => true,
    ...extra,
  });
  const stateFile = (home: string) => join(home, '.fleet-dao', 'release-train.json');
  const driverOf = (home: string) =>
    (
      JSON.parse(readFileSync(stateFile(home), 'utf8')) as {
        driver?: { pid: number; host: string; heartbeatAt: string };
      }
    ).driver;

  /** 一趟走到第 4 步、驱动就没了留下的现场：状态 running、总开关关着、法国发布历史由调用方定。 */
  function deadAt4(
    home: string,
    w: { t: number; engineOn: boolean },
    beatMinutesAgo: number,
    over: Record<string, unknown> = {},
  ) {
    const beat = new Date(w.t - beatMinutesAgo * MIN).toISOString();
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    writeFileSync(
      stateFile(home),
      JSON.stringify({
        schema: 1,
        status: 'running',
        phase: 4,
        startedAt: new Date(w.t - 40 * MIN).toISOString(),
        updatedAt: beat,
        target: { kind: 'sha', value: SHA },
        founderOk: FOUNDER,
        restore: false,
        before: {
          master: true,
          repos: [
            { repo: 'o/a', on: true },
            { repo: 'o/b', on: false },
          ],
          recordedAt: beat,
        },
        baseline: { bad: 0, unread: 0, note: 2 },
        laggards: [],
        release: { started: true },
        driver: { pid: 4242, host: 'box', heartbeatAt: beat },
        ...over,
      }),
    );
    w.engineOn = false;
  }
  const startArgs = ['start', '--sha', SHA, '--founder-ok', FOUNDER];

  it('旧状态文件的 baseline 没有 keys：按条数比较，行为和以前一样', async () => {
    for (const [bad, expected] of [
      [0, 0],
      [1, 3],
    ] as const) {
      const home = freshHome();
      const { w, io } = makeWorld();
      w.history += `\n2026-10-05T13:50:00Z ${SHA} release`;
      deadAt4(home, w, 30);
      w.franceBad = bad;
      w.franceHealthExit = bad ? 1 : 0;
      const code = await train.runTrain(startArgs, withDriver(io(home, LIMITS), { pid: 5555 }));
      expect(code, `bad=${bad}`).toBe(expected);
    }
  });

  it('每次落盘都写 pid、机器名、心跳时刻；等收尾的轮询里心跳在走', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    ciStuckAfterPreflight(w);
    expect(await train.runTrain(startArgs, withDriver(io(home)))).toBe(3);
    const d = driverOf(home);
    expect(d).toMatchObject({ pid: 4242, host: 'box' });
    // 等收尾每圈都刷新：最后一次心跳不早于等了 2 圈之后的时刻
    expect(Date.parse(d?.heartbeatAt ?? '')).toBeGreaterThanOrEqual(Date.parse('2026-10-05T14:00:02Z'));
  });

  it('driverVerdict：心跳在上限加余量内＝活；超过＝死；pid 不在＝死（换了机器的 pid 不算）；时刻认不出不判死', () => {
    const now = new Date('2026-10-05T15:00:00Z');
    const at = (min: number) => new Date(now.getTime() - min * MIN).toISOString();
    const s = (beat: string, phase = 4) => ({
      phase,
      updatedAt: beat,
      driver: { pid: 9, host: 'box', heartbeatAt: beat },
    });
    const ctx = { now, limits: LIMITS, host: 'box' };
    expect(train.driverVerdict(s(at(19)), ctx).dead).toBe(false); // 第 4 步上限 15 + 余量 5 = 20
    const old = train.driverVerdict(s(at(21)), ctx);
    expect(old.dead).toBe(true);
    expect(old.why).toContain('心跳');
    expect(train.driverVerdict(s(at(1)), { ...ctx, isAlive: () => false })).toMatchObject({ dead: true });
    expect(train.driverVerdict(s(at(1)), { ...ctx, isAlive: () => true }).dead).toBe(false);
    // 记的是别的机器的 pid：这里查不了，只看心跳
    expect(train.driverVerdict(s(at(1)), { ...ctx, host: 'other', isAlive: () => false }).dead).toBe(false);
    // 第 6 步上限只有 5 分钟：同样 21 分钟前的心跳，第 4 步死了，第 6 步更死；第 3 步上限 20 分钟，21 分钟没超过 25
    expect(train.driverVerdict(s(at(21), 3), ctx).dead).toBe(false);
    // 老状态（没有 driver 字段）按 updatedAt 判
    expect(train.driverVerdict({ phase: 4, updatedAt: at(30) }, ctx).dead).toBe(true);
    // 【故意造出的失败】时刻读不出：既不是死也不是活，明说判不了
    expect(train.driverVerdict({ phase: 4, updatedAt: '乱写的' }, ctx)).toMatchObject({
      dead: false,
      unknown: true,
    });
  });

  it('status：驱动没了就写「驱动没了，停在第 4 步」并给出接着走的命令；活着的照旧写在走', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    deadAt4(home, w, 30);
    expect(await train.runTrain(['status'], withDriver(io(home, LIMITS)))).toBe(0);
    const out = text(w.out);
    expect(out).toContain('驱动没了，停在第 4 步「发版」');
    expect(out).toContain(`node release-train.mjs start --sha ${SHA.slice(0, 12)}`);
    expect(out).toContain('--founder-ok');

    const home2 = freshHome();
    const world2 = makeWorld();
    deadAt4(home2, world2.w, 2);
    expect(await train.runTrain(['status'], withDriver(world2.io(home2, LIMITS)))).toBe(0);
    expect(text(world2.w.out)).toContain('在走');
    expect(text(world2.w.out)).toContain('驱动还活着');
    expect(text(world2.w.out)).not.toContain('驱动没了');
  });

  it('死在第 4 步、法国已发成：start 不重发，从第 5 步起走到恢复，总开关和仓开关开回', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.history += `\n2026-10-05T13:50:00Z ${SHA} release`;
    deadAt4(home, w, 30);
    const code = await train.runTrain(startArgs, withDriver(io(home, LIMITS), { pid: 5555 }));
    expect(code).toBe(0);
    expect(releaseCalls(w.sshCalls)).toEqual([]);
    expect(text(w.out)).toContain('发版发成了，从第 5 步');
    expect(text(w.out)).not.toContain('第 4 步「发版」——');
    expect(w.engineOn).toBe(true);
    expect(w.sshCalls.some((c) => c.includes(' dispatch o/a on'))).toBe(true);
    expect(w.sshCalls.some((c) => c.includes(' dispatch o/b on'))).toBe(false);
    expect(stateOf(home).status).toBe('done');
    expect(driverOf(home)?.pid).toBe(5555); // 换成新驱动
  });

  it('死在第 4 步、法国没发成：从第 4 步重发（发一次），再走完恢复', async () => {
    const home = freshHome();
    const { w, io } = makeWorld(); // 历史末行还是旧提交
    deadAt4(home, w, 30);
    const code = await train.runTrain(startArgs, withDriver(io(home, LIMITS), { pid: 5555 }));
    expect(code).toBe(0);
    expect(releaseCalls(w.sshCalls).length).toBe(1);
    expect(text(w.out)).toContain('目标没上');
    expect(text(w.out)).toContain('从第 4 步「发版」重发');
    expect(w.engineOn).toBe(true);
    expect(stateOf(home).status).toBe('done');
  });

  it('死在第 4 步、末行是目标但事件是 unhealthy：当没发成，重发', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.history += `\n2026-10-05T13:50:00Z ${SHA} unhealthy`;
    deadAt4(home, w, 30);
    await train.runTrain(startArgs, withDriver(io(home, LIMITS)));
    expect(releaseCalls(w.sshCalls).length).toBe(1);
    expect(text(w.out)).toContain('事件是 unhealthy');
  });

  it('pid 不在：心跳再新也算死，直接接着走', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.history += `\n2026-10-05T13:50:00Z ${SHA} release`;
    deadAt4(home, w, 1);
    const code = await train.runTrain(startArgs, withDriver(io(home, LIMITS), { isAlive: () => false }));
    expect(code).toBe(0);
    expect(text(w.out)).toContain('pid 4242）不在了');
  });

  it('【故意造出的失败】驱动活着时 start 照旧拒起：退出码 1，法国什么都没碰', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    deadAt4(home, w, 2);
    const code = await train.runTrain(startArgs, withDriver(io(home, LIMITS)));
    expect(code).toBe(1);
    expect(text(w.err)).toContain('有一趟正在走');
    expect(text(w.err)).toContain('驱动还活着');
    expect(w.sshCalls).toEqual([]);
    expect(stateOf(home).status).toBe('running');
  });

  it('【故意造出的失败】驱动死了但换了目标：拒，不接别人的现场', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    deadAt4(home, w, 30);
    const code = await train.runTrain(
      ['start', '--sha', OLD, '--founder-ok', FOUNDER],
      withDriver(io(home, LIMITS)),
    );
    expect(code).toBe(1);
    expect(text(w.err)).toContain('驱动没了');
    expect(w.sshCalls).toEqual([]);
  });

  it('重跑时法国上发布还在跑（锁占着）：不报锁冲突、不起第二个，回第 4 步接着轮询，发完才往下走（#1995）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.lockBusy = true;
    deadAt4(home, w, 30);
    // 法国上的发布服务还在跑：头两次回 attached，第三次发完
    w.launch = (n, sha) => {
      if (n < 3) return launchReply('attached');
      w.history += `\n2026-10-05T14:30:00Z ${sha} release`;
      return launchReply('finished', 0);
    };
    const code = await train.runTrain(startArgs, withDriver(io(home, LIMITS)));
    expect(w.err).toEqual([]);
    expect(code).toBe(0);
    expect(text(w.out)).toContain('回第 4 步接着看它，不起第二个');
    expect(text(w.out)).toContain('已经在跑（接着看，不起第二个');
    expect(releaseCalls(w.sshCalls)).toHaveLength(3);
    // 三次是同一条命令（同一个令牌）：法国上认得出「这是我起的」，不会起第二个
    expect(new Set(releaseCalls(w.sshCalls)).size).toBe(1);
    expect(stateOf(home).status).toBe('done');
  });

  it('【故意造出的失败】重跑时发布一直在跑、到总时限还没发完：判没成（退出码 2），不写成成功，也不重发', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.lockBusy = true;
    deadAt4(home, w, 30);
    w.launch = () => launchReply('attached');
    const code = await train.runTrain(startArgs, withDriver(io(home, LIMITS)));
    expect(code).toBe(2);
    expect(text(w.err)).toContain('没看到发布结束');
    expect(text(w.out)).not.toContain('这一趟做完了');
    expect(stateOf(home).status).toBe('failed');
    expect(stateOf(home).phase).toBe(4);
  });

  it('【故意造出的失败】死在第 4 步但读不到法国发布历史：不猜，退出码 2', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    deadAt4(home, w, 30);
    const base = withDriver(io(home, LIMITS));
    const code = await train.runTrain(startArgs, {
      ...base,
      ssh: (c) => (c.startsWith('tail -n 1') ? { status: 255, stdout: '', stderr: '连不上' } : base.ssh(c)),
    });
    expect(code).toBe(2);
    expect(text(w.err)).toContain('不敢猜');
    expect(releaseCalls(w.sshCalls)).toEqual([]);
  });

  it('第 4 步发版轮询期间每圈刷新心跳：状态里的心跳跟着走（不再靠一条长 ssh 的 onTick）', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const beats: string[] = [];
    w.launch = (n, sha) => {
      beats.push(driverOf(home)?.heartbeatAt ?? '');
      if (n < 4) return launchReply('attached');
      w.history += `\n2026-10-05T14:30:00Z ${sha} release`;
      return launchReply('finished', 0);
    };
    const code = await train.runTrain(startArgs, withDriver(io(home)));
    expect(code).toBe(0);
    expect(beats).toHaveLength(4);
    expect(new Set(beats).size).toBe(4); // 每圈一个新的心跳时刻
    expect(Date.parse(beats[3] ?? '')).toBeGreaterThan(Date.parse(beats[0] ?? ''));
  });

  // 2026-10-13 连续两次发版都撞：ssh 被重置，法国上的发布其实跑完了，本机却报「第 4 步没成」（#1995）
  it('ssh 中途断开但法国已发完：重连后读到发完（退出码 0），不当成失败、不起第二个发布', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.launch = (n, sha) => {
      if (n === 1) return launchReply('started'); // 起了发布
      if (n <= 3) return sshDropped(); // 之后连着被重置
      w.history += `\n2026-10-05T14:30:00Z ${sha} release`; // 法国上早发完了
      return launchReply('finished', 0, 'fleet-dao-release-exit=0');
    };
    const code = await train.runTrain(startArgs, withDriver(io(home)));
    expect(w.err).toEqual([]);
    expect(code).toBe(0);
    expect(text(w.out)).toContain('ssh 断了或连不上');
    expect(text(w.out)).toContain('发布不受影响');
    expect(releaseCalls(w.sshCalls)).toHaveLength(4);
    expect(new Set(releaseCalls(w.sshCalls)).size).toBe(1); // 每次都是同一条（同令牌）：不会起第二个
    expect(stateOf(home).status).toBe('done'); // 往下走完了第 5 步以后（历史末行是目标）
  });

  it('【故意造出的失败】ssh 断开且法国没发（一直连不上、到总时限）：判没成（退出码 2），不写成成功', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.launch = () => sshDropped();
    const code = await train.runTrain(startArgs, withDriver(io(home)));
    expect(code).toBe(2);
    expect(text(w.err)).toContain('没看到发布结束');
    expect(text(w.err)).toContain('ssh 断了或连不上');
    expect(text(w.out)).not.toContain('这一趟做完了');
    expect(w.history.split('\n').at(-1)).toContain(OLD); // 历史末行没动：确实没发
    const s = stateOf(home);
    expect(s.status).toBe('failed');
    expect(s.phase).toBe(4);
  });

  it('【故意造出的失败】断开后连上了，法国说发布服务没了且没留退出码（lost）：没成，点名看日志，不当成功', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.launch = (n) => (n === 1 ? sshDropped() : launchReply('lost', null, 'Killed'));
    const code = await train.runTrain(startArgs, withDriver(io(home)));
    expect(code).toBe(2);
    expect(text(w.err)).toContain('没有退出码');
    expect(stateOf(home).status).toBe('failed');
  });

  it('发完但 release.sh 退出码非 0（有红）：没成，不写成成功', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.launch = () => launchReply('finished', 1, '有红');
    expect(await train.runTrain(startArgs, withDriver(io(home)))).toBe(2);
    expect(text(w.err)).toContain('release.sh 退出码 1');
  });

  it('parseLaunchReport：认得对的回话；认不出的是 null（不当成功）', () => {
    expect(train.parseLaunchReport('state=finished\nexit=0\nlog=/x.log\n---\na\nb\n')).toEqual({
      state: 'finished',
      exit: 0,
      log: '/x.log',
      tail: 'a / b',
    });
    expect(train.parseLaunchReport('state=attached\nexit=none\nlog=/x.log\n---\n')).toMatchObject({
      state: 'attached',
      exit: null,
    });
    expect(train.parseLaunchReport('')).toBeNull();
    expect(train.parseLaunchReport('state=ok\nexit=0\n')).toBeNull();
    expect(train.parseLaunchReport('state=finished\nexit=abc\n')).toBeNull();
  });

  it('releaseLaunchCommand：提交号、令牌不合格式就不拼命令', () => {
    const cmd = train.releaseLaunchCommand(SHA, 'abc123');
    expect(cmd.startsWith('bash -c ')).toBe(true);
    expect(cmd.includes(` fleet-release-launch ${SHA} abc123 `)).toBe(true);
    expect(() => train.releaseLaunchCommand('不是提交', 'abc')).toThrow();
    expect(() => train.releaseLaunchCommand(SHA, 'a b;rm')).toThrow();
  });

  it('releaseLaunchCommand：整条命令不超过 Windows 命令行上限（#2015，超了 ssh 收到半截 base64）', () => {
    const cmd = train.releaseLaunchCommand(SHA, 'abc123');
    expect(cmd.length).toBeLessThanOrEqual(train.LAUNCH_COMMAND_MAX);
    expect(train.LAUNCH_COMMAND_MAX).toBeLessThan(8191);
  });

  it('status 给出的接着走命令（提交号只写前 12 位）原样拿去 start：认得是同一个目标，接着走、不被拒', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    w.history += `\n2026-10-05T13:50:00Z ${SHA} release`;
    deadAt4(home, w, 30);
    expect(await train.runTrain(['status'], withDriver(io(home, LIMITS)))).toBe(0);
    const line = text(w.out)
      .split('\n')
      .find((l) => l.includes('node release-train.mjs start --sha'));
    const m = /start --sha (\S+) --founder-ok "([^"]*)"/.exec(line ?? '');
    expect(m).not.toBeNull();
    expect(m?.[1]).toHaveLength(12);
    const code = await train.runTrain(['start', '--sha', m?.[1] ?? '', '--founder-ok', m?.[2] ?? ''], {
      ...withDriver(io(home, LIMITS), { pid: 5555 }),
    });
    expect(code).toBe(0);
    expect(text(w.out)).toContain('发版发成了，从第 5 步');
    expect(stateOf(home).status).toBe('done');
    expect(
      (JSON.parse(readFileSync(stateFile(home), 'utf8')) as { target: { value: string } }).target.value,
    ).toBe(SHA); // 整串不被短的盖掉
    expect(w.engineOn).toBe(true);
  });

  it('接着走（卡住、没成）也认前 12 位；换成别的提交仍拒', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    deadAt4(home, w, 2, { status: 'blocked' });
    const code = await train.runTrain(
      ['start', '--sha', OLD.slice(0, 12), '--founder-ok', FOUNDER],
      withDriver(io(home, LIMITS)),
    );
    expect(code).toBe(1);
    expect(releaseCalls(w.sshCalls)).toEqual([]);
    const ok2 = await train.runTrain(
      ['start', '--sha', SHA.slice(0, 12), '--founder-ok', FOUNDER],
      withDriver(io(home, LIMITS)),
    );
    expect(ok2).toBe(0);
    expect(text(w.out)).toContain('接着上一趟走');
  });

  it('trainAlertNote：驱动死了写明「死在第 N 步，没人恢复」；没有状态、卡住、读不了也各写各的', async () => {
    const home = freshHome();
    const { w, io } = makeWorld();
    const ctx = { home, now: new Date(w.t), host: 'box', isAlive: () => true };
    expect(train.trainAlertNote(ctx)).toContain('没有发版车在走');
    deadAt4(home, w, 30);
    expect(train.trainAlertNote(ctx)).toContain('发版车驱动死在第 4 步「发版」，没人恢复');
    deadAt4(home, w, 2);
    expect(train.trainAlertNote(ctx)).toContain('发版车在走');
    expect(train.trainAlertNote(ctx)).not.toContain('死在');
    deadAt4(home, w, 2, { status: 'blocked' });
    expect(train.trainAlertNote(ctx)).toContain('卡住了');
    writeFileSync(stateFile(home), '{坏的');
    expect(train.trainAlertNote(ctx)).toContain('读不到');
    void io;
  });
});

describe('认输出的小函数', () => {
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

  // 2026-10-13：预检写「法国在跑的会话 0 个」，release.sh 排空却在等 execute 会话——三段一次性会话只写 runs，不写老会话表（#1995）
  it('查询数 runs（三段一次性会话，排空登记的就是它们）；老 Fusion 的会话表已删（#2357），不许再读它，读了库里报「关系不存在」', () => {
    const sql = sessionsQuery.SQL;
    expect(sql).not.toMatch(/session_runs/);
    expect(sql).toMatch(/from runs r/);
    expect(sql).toMatch(/'running', \(select count\(\*\) from runs where ended_at is null\)/);
    expect(sql).toContain("'segment:' || r.segment");
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
