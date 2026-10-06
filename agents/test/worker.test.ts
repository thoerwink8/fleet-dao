// 帅位「开别家模型的会话去干活」的启动器（worker-lib.mjs）：git/gh/pnpm/spawn/进程查杀全部注入假的，
// home、brief 文件、prompt.txt、meta.json 用真的临时目录。
// 每条失败路径都故意造一遍：工作树已存在、不认识的模型、pnpm install 失败、meta 缺失或损坏、clean 时 PR 没合没关——
// 都要明说、非 0 退出，不当成没事。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SCRIPTS = fileURLToPath(new URL('../skills/commander/scripts/', import.meta.url));
const NOW = new Date('2026-09-28T02:00:00Z');

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string | undefined;
}
interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdinFile: string | null;
  outFile: string;
  errFile: string;
}
/** proxy：true 走环境里原有的代理，不给或 false 是去掉代理直连（外壳 worker.mjs 照这个设环境变量）；timeoutMs：这次调用的上限。 */
interface NetOpts {
  cwd?: string;
  proxy?: boolean;
  timeoutMs?: number;
}
interface WorkerIo {
  env: Record<string, string | undefined>;
  home: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  cwd: () => string;
  git: (args: string[], opts?: NetOpts) => RunResult;
  gh: (args: string[], opts?: NetOpts) => RunResult;
  /** 巡看并发查 PR 用：signal 一到就收手（返回 error: ABORT_ERR） */
  ghAsync?: (args: string[], opts?: NetOpts & { signal?: AbortSignal }) => Promise<RunResult>;
  pnpm: (args: string[], opts?: { cwd?: string }) => RunResult;
  spawnDetached: (spec: SpawnSpec) => { pid: number };
  isRunning: (pid: number) => boolean;
  killTree: (pid: number) => { ok: boolean; why?: string };
  out: (text: string) => void;
  err: (text: string) => void;
}
interface WorkerLib {
  USAGE: string;
  SESSION_EFFORTS: string[];
  EFFORTS: string[];
  DEFAULT_EFFORT: string;
  GITHUB_HOSTS: string[];
  SAFE_ENV_KEYS: string[];
  KIMI_UNSUPPORTED: string;
  mergeNoProxy(env: Record<string, string | undefined>): Record<string, string | undefined>;
  safeEnv(env: Record<string, string | undefined>): Record<string, string | undefined>;
  closingBrief(o: {
    branch: string;
    noShip: boolean;
    noAutomerge?: boolean;
    issue?: { number: number; refs: boolean } | { reason: string };
    githubRoute?: { via: string; proxy?: string };
  }): string;
  saidOf(line: string): string | null;
  noResultEvent(lines: string[]): boolean;
  WATCH_SLACK_MS: number;
  runWorker(argv: string[], io: WorkerIo): Promise<number>;
}

const lib = (await import(pathToFileURL(join(SCRIPTS, 'worker-lib.mjs')).href)) as WorkerLib;
interface WindowsQuote {
  windowsQuoteArg(arg: string): string;
  windowsCmdLine(command: string, args: string[]): string;
}
// worker.mjs 顶层直接跑 runWorker（真的读 argv、真的起子进程），不能直接 import 来测；这两个文件的函数单独
//拆出来就是为了能在这里安全 import。
const winQuote = (await import(pathToFileURL(join(SCRIPTS, 'windows-quote.mjs')).href)) as WindowsQuote;
interface SpawnDetachedSupport {
  powershellSpawnOptions(o: { timeoutMs: number }): { stdio: string; windowsHide: boolean; timeout: number };
  interpretLaunchResult(o: {
    spawnError: string | null;
    spawnStatus: number | null;
    resultText: string | null;
  }): { ok: true; pid: number } | { ok: false; confirmed: boolean; why: string };
}
const spawnSupport = (await import(
  pathToFileURL(join(SCRIPTS, 'spawn-detached-support.mjs')).href
)) as SpawnDetachedSupport;

interface SpawnDetachedMod {
  buildLaunchSpec(o: SpawnSpec): { commandLine: string; cwd: string; env: { name: string; value: string }[] };
  spawnDetached(o: SpawnSpec): { pid: number };
}
const spawnDetachedMod = (await import(
  pathToFileURL(join(SCRIPTS, 'spawn-detached.mjs')).href
)) as SpawnDetachedMod;

const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
const bad = (stderr: string, status = 1): RunResult => ({ status, stdout: '', stderr });
/** git worktree list --porcelain 的回话：第一条是主检出（w.repo），其余是已有的工作树。 */
const listed = (w: { repo: string }, ...trees: string[]): RunResult =>
  ok(
    [
      `worktree ${w.repo}\nHEAD abc\nbranch refs/heads/main`,
      ...trees.map((t) => `worktree ${t}\nHEAD def`),
    ].join('\n\n'),
  );
/** 取数组第一项、明确它在——比非空断言（!）更安全，比每处都 ?. 更看得清是「就该有一个」。 */
function must<T>(v: T | undefined, msg: string): T {
  if (v === undefined) throw new Error(msg);
  return v;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 仓里真的路由骨架：家目录的同步专用检出里默认放这一份（启动器的档位照它定，#470）。 */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REAL_SKELETON = readFileSync(join(REPO_ROOT, 'packages', 'db', 'routing.default.json'), 'utf8');
const skeletonFile = (home: string) =>
  join(home, '.fleet-dao', 'origin-main', 'packages', 'db', 'routing.default.json');
function writeSkeleton(home: string, text: string) {
  mkdirSync(join(home, '.fleet-dao', 'origin-main', 'packages', 'db'), { recursive: true });
  writeFileSync(skeletonFile(home), text);
}

/** repo 是一个真实存在的临时目录（不是 git 仓，git/gh/pnpm 全是假的），worktreeDir 是它里面的 .claude/worktrees/w-<name>。 */
function world() {
  const home = mkdtempSync(join(tmpdir(), 'fleet-worker-home-'));
  const parent = mkdtempSync(join(tmpdir(), 'fleet-worker-parent-'));
  dirs.push(home, parent);
  writeSkeleton(home, REAL_SKELETON);
  const repo = join(parent, 'fleet-dao');
  mkdirSync(repo, { recursive: true });

  const gitCalls: { args: string[]; cwd?: string | undefined }[] = [];
  const ghCalls: { args: string[]; cwd?: string | undefined }[] = [];
  const pnpmCalls: { args: string[]; cwd?: string | undefined }[] = [];
  const spawnCalls: SpawnSpec[] = [];
  const gitReplies: RunResult[] = [];
  const ghReplies: RunResult[] = [];
  const pnpmReplies: RunResult[] = [];
  const spawnReplies: ({ pid: number } | Error)[] = [];
  // start 先判「GitHub 走哪条路」的 git ls-remote 单独一个队列（不进 gitCalls/gitReplies，老用例的顺序不变）；
  // 队列空了就当通（直连通是老样子）。gitOpts/ghOpts 记每次调用带的完整选项（proxy、timeoutMs）。
  const probeReplies: RunResult[] = [];
  const probeCalls: { args: string[]; opts?: NetOpts | undefined }[] = [];
  const gitOpts: { args: string[]; opts?: NetOpts | undefined }[] = [];
  const ghOpts: { args: string[]; opts?: NetOpts | undefined }[] = [];
  const running = new Set<number>();
  const killed: number[] = [];
  const killReplies: { ok: boolean; why?: string }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let clock = NOW.getTime();

  const takeReply = <T>(queue: T[], label: string): T => {
    const r = queue.shift();
    if (r === undefined) throw new Error(`用例没给第 ${label} 次的回话`);
    return r;
  };

  const io: WorkerIo = {
    // PATH 是白名单里的（应该原样透传给模型）；另外两个不是——SOME_VAR 是普通变量，
    // GITHUB_PERSONAL_ACCESS_TOKEN 是看着就像密钥的变量，两个都不该出现在 spawnDetached 收到的 env 里
    // （09-28 的安全教训：白名单，不是挡「像密钥的名字」那种黑名单，所以两种都要挡住，见 safeEnv 那节）。
    env: { PATH: 'C:\\fake\\path', SOME_VAR: '1', GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_should_never_leak' },
    home,
    now: () => new Date(clock),
    // 假的等：不真睡，把钟拨过去
    sleep: async (ms: number) => {
      clock += ms;
    },
    cwd: () => repo,
    git: (args, opts) => {
      if (args[0] === 'ls-remote') {
        probeCalls.push({ args, opts });
        return probeReplies.shift() ?? ok('abc123\trefs/heads/main');
      }
      gitCalls.push({ args, cwd: opts?.cwd });
      gitOpts.push({ args, opts });
      return takeReply(gitReplies, `git（${gitCalls.length}：${args.join(' ')}）`);
    },
    gh: (args, opts) => {
      ghCalls.push({ args, cwd: opts?.cwd });
      ghOpts.push({ args, opts });
      return takeReply(ghReplies, `gh（${ghCalls.length}：${args.join(' ')}）`);
    },
    pnpm: (args, opts) => {
      pnpmCalls.push({ args, cwd: opts?.cwd });
      return takeReply(pnpmReplies, `pnpm（${pnpmCalls.length}）`);
    },
    spawnDetached: (spec) => {
      spawnCalls.push(spec);
      const r = takeReply(spawnReplies, `spawn（${spawnCalls.length}）`);
      if (r instanceof Error) throw r;
      running.add(r.pid);
      return r;
    },
    isRunning: (pid) => running.has(pid),
    killTree: (pid) => {
      killed.push(pid);
      const r = takeReply(killReplies, `killTree（${killed.length}）`);
      if (r.ok) running.delete(pid);
      return r;
    },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };

  return {
    io,
    home,
    repo,
    parent,
    gitCalls,
    ghCalls,
    pnpmCalls,
    spawnCalls,
    gitReplies,
    ghReplies,
    pnpmReplies,
    spawnReplies,
    probeReplies,
    probeCalls,
    gitOpts,
    ghOpts,
    killReplies,
    running,
    killed,
    out,
    err,
    advance: (min: number) => {
      clock += min * 60_000;
    },
    setRunning: (pid: number, value: boolean) => {
      if (value) running.add(pid);
      else running.delete(pid);
    },
    meta: (name: string) =>
      JSON.parse(readFileSync(join(home, '.fleet-dao', 'workers', name, 'meta.json'), 'utf8')),
    prompt: (name: string) => readFileSync(join(home, '.fleet-dao', 'workers', name, 'prompt.txt'), 'utf8'),
    writeMeta: (name: string, meta: Record<string, unknown>) => {
      const dir = join(home, '.fleet-dao', 'workers', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
      return dir;
    },
    /** 换掉同步专用检出里的路由骨架（text 是文件原文）；dropSkeleton 删掉它。 */
    skeleton: (text: string) => writeSkeleton(home, text),
    dropSkeleton: () => rmSync(skeletonFile(home)),
    /** 原样跑，不替 start 补挂单参数（测「缺了拒起」用）。 */
    runRaw: (argv: string[]) => lib.runWorker(argv, io),
    /** 跑一条命令；start 没给 --issue / --no-issue / --no-ship 的，补上 --issue 1052（#1052 起 start 缺了就拒起，别的测试不关心这个）；
     *  start 没给 --detached 的，补上一条理由（2026-10-06 起缺了拒起，别的测试不关心这个，单独测它用 runRaw）。 */
    run: (argv: string[]) => {
      let args = argv;
      if (
        args[0] === 'start' &&
        !args.some((a) => a === '--issue' || a === '--no-issue' || a === '--no-ship')
      )
        args = [...args, '--issue', '1052'];
      if (args[0] === 'start' && !args.includes('--detached')) args = [...args, '--detached', '测试里要脱离'];
      return lib.runWorker(args, io);
    },
  };
}

/** 一份最小的路由骨架：models 给什么就是什么。 */
const skeletonWith = (models: Record<string, unknown>) =>
  JSON.stringify({ purposes: { default: Object.keys(models) }, models });

/** start 的一份合格 meta：clean/status/stop 的用例不走 start，直接手写一份，省得每次都跑一遍 start 的六步。 */
function validMeta(w: ReturnType<typeof world>, name: string, over: Record<string, unknown> = {}) {
  const worktree = join(w.repo, '.claude', 'worktrees', `w-${name}`);
  return {
    name,
    model: 'grok',
    modelId: null,
    effort: 'high',
    pid: 9001,
    mainRepo: w.repo,
    worktree,
    branch: `w/${name}`,
    startedAt: NOW.toISOString(),
    promptFile: join(w.home, '.fleet-dao', 'workers', name, 'prompt.txt'),
    outLog: join(w.home, '.fleet-dao', 'workers', name, 'out.log'),
    errLog: join(w.home, '.fleet-dao', 'workers', name, 'err.log'),
    noShip: false,
    cleanedAt: null,
    ...over,
  };
}

function brief(w: ReturnType<typeof world>, text = '写一个文件') {
  const file = join(w.home, 'brief.txt');
  writeFileSync(file, text);
  return file;
}

describe('用法', () => {
  it('不带参数：打印用法、退出码 1；--help：退出码 0', async () => {
    const w = world();
    expect(await w.run([])).toBe(1);
    expect(w.out.join('\n')).toContain('用法：node worker.mjs');
    expect(await w.run(['--help'])).toBe(0);
    expect(w.out.join('\n')).toContain('用法：node worker.mjs');
  });

  it('【故意造出的失败】没有这个命令：退出码 1，不碰 git/gh/pnpm/spawn', async () => {
    const w = world();
    expect(await w.run(['bogus'])).toBe(1);
    expect(w.gitCalls).toEqual([]);
  });
});

describe('start：happy path', () => {
  it('grok：git rev-parse、worktree list、fetch、worktree add、pnpm install 按顺序跑完，起 grok，写 meta.json 和 prompt.txt', async () => {
    const w = world();
    const briefFile = brief(w, '在 _tmp/x.txt 写一行 hi');
    w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
    w.pnpmReplies.push(ok('已经装好了'));
    w.spawnReplies.push({ pid: 4242 });

    const code = await w.run(['start', '--model', 'grok', '--name', 'w1', '--brief', briefFile]);

    expect(code).toBe(0);
    const worktreeDir = join(w.repo, '.claude', 'worktrees', 'w-w1');
    expect(w.gitCalls).toEqual([
      { args: ['rev-parse', '--is-inside-work-tree'], cwd: w.repo },
      { args: ['worktree', 'list', '--porcelain'], cwd: w.repo },
      { args: ['fetch', 'origin', 'main'], cwd: w.repo },
      { args: ['worktree', 'add', '-b', 'w/w1', worktreeDir, 'origin/main'], cwd: w.repo },
    ]);
    expect(w.pnpmCalls).toEqual([
      { args: ['install', '--frozen-lockfile', '--prefer-offline'], cwd: worktreeDir },
    ]);
    expect(w.spawnCalls).toHaveLength(1);
    const spec = must(w.spawnCalls[0], '没有 spawnCalls[0]');
    expect(spec.command).toBe('grok');
    expect(spec.args).toEqual([
      '--prompt-file',
      join(w.home, '.fleet-dao', 'workers', 'w1', 'prompt.txt'),
      '--always-approve',
      '--cwd',
      worktreeDir,
      '--reasoning-effort',
      'high',
      '--no-plan',
    ]);
    expect(spec.cwd).toBe(worktreeDir);
    expect(spec.stdinFile).toBeNull();
    expect(spec.env.NO_PROXY).toContain('github.com');
    expect(spec.env.PATH).toBe('C:\\fake\\path'); // 白名单里的环境变量原样带过去
    expect(spec.env.SOME_VAR).toBeUndefined(); // 白名单之外的普通变量不传
    expect(spec.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined(); // 看着像密钥的更不能传（09-28 真撞过）
    // grok 目录信任 + 反问选择题：09-28 另一撞，见 launchOf 里的注释和 PR 正文的真跑对照
    expect(spec.env.GROK_FOLDER_TRUST).toBe('0');
    expect(spec.env.GROK_ASK_USER_QUESTION).toBe('0');

    const meta = w.meta('w1');
    expect(meta).toMatchObject({
      name: 'w1',
      model: 'grok',
      modelId: null,
      effort: 'high',
      pid: 4242,
      mainRepo: w.repo,
      worktree: worktreeDir,
      branch: 'w/w1',
      noShip: false,
      cleanedAt: null,
    });
    expect(meta.startedAt).toBe(NOW.toISOString());
    const prompt = w.prompt('w1');
    expect(prompt).toContain('在 _tmp/x.txt 写一行 hi');
    expect(prompt).toContain('收尾交代');
    expect(prompt).toContain('pnpm pr:open');
    expect(w.out.join('\n')).toContain('pid 4242');
    expect(w.out.join('\n')).toContain('档位 high');
  });

  it('codex：prompt 走标准输入描述符（不是命令行参数），带 --dangerously-bypass-approvals-and-sandbox 和思考档位；--no-ship 换收尾交代；--model-id 透传', async () => {
    const w = world();
    const briefFile = brief(w);
    w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    w.spawnReplies.push({ pid: 55 });

    const code = await w.run([
      'start',
      '--model',
      'codex',
      '--name',
      'w2',
      '--brief',
      briefFile,
      '--model-id',
      'gpt-5.6-luna',
      '--effort',
      'low',
      '--no-ship',
    ]);

    expect(code).toBe(0);
    const worktreeDir = join(w.repo, '.claude', 'worktrees', 'w-w2');
    const promptFile = join(w.home, '.fleet-dao', 'workers', 'w2', 'prompt.txt');
    expect(w.spawnCalls).toHaveLength(1);
    const spec = must(w.spawnCalls[0], '没有 spawnCalls[0]');
    expect(spec.command).toBe('codex');
    expect(spec.args).toEqual([
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      worktreeDir,
      '-c',
      'model_reasoning_effort="low"',
      '--model',
      'gpt-5.6-luna',
    ]);
    expect(spec.stdinFile).toBe(promptFile);
    // codex 没有 grok 那两个目录信任/反问相关的环境变量；env 过滤对它一样生效
    expect(spec.env.PATH).toBe('C:\\fake\\path');
    expect(spec.env.SOME_VAR).toBeUndefined();
    expect(spec.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    expect(spec.env.GROK_FOLDER_TRUST).toBeUndefined();
    expect(spec.env.GROK_ASK_USER_QUESTION).toBeUndefined();
    const meta = w.meta('w2');
    expect(meta.modelId).toBe('gpt-5.6-luna');
    expect(meta.effort).toBe('low');
    expect(meta.noShip).toBe(true);
    const prompt = w.prompt('w2');
    expect(prompt).toContain('冒烟测试');
    expect(prompt).not.toContain('pr:open');
  });

  it('--effort 不给、仓里的路由骨架没给这个模型配档位：就是 high，且总是显式传给命令行', async () => {
    const w = world();
    w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    w.spawnReplies.push({ pid: 1 });
    await w.run(['start', '--model', 'grok', '--name', 'w3', '--brief', brief(w)]);
    expect(w.spawnCalls).toHaveLength(1);
    const spec = must(w.spawnCalls[0], '没有 spawnCalls[0]');
    expect(spec.args).toEqual(expect.arrayContaining(['--reasoning-effort', 'high']));
    expect(w.meta('w3').effort).toBe('high');
    expect(w.out.join('\n')).toContain('档位 high（路由骨架里 grok-4.7 没配，用默认）');
  });

  it('--no-automerge：收尾交代改成开人闸 PR、不挂自动合并、CI 绿就停；不带则挂自动合并', async () => {
    // 创始人 09-28 晚上拍：改标准的活也要能派给别家模型，但改标准是人闸第四类（AGENTS.md），不能让模型自己
    // 挂自动合并把改标准的 PR 合了。
    const w = world();
    w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    w.spawnReplies.push({ pid: 1 });
    await w.run(['start', '--model', 'grok', '--name', 'w-gate', '--brief', brief(w), '--no-automerge']);
    const gated = w.prompt('w-gate');
    expect(gated).toContain('人闸：改标准');
    expect(gated).toContain('不要挂自动合并');
    expect(gated).toContain('pnpm pr:open');
    expect(gated).toContain('--no-automerge');
    expect(gated).toContain('四栏'); // #654：PR 模板只剩四栏，不再写「档位」栏

    const w2 = world();
    w2.gitReplies.push(ok('true'), listed(w2), ok(''), ok(''));
    w2.pnpmReplies.push(ok());
    w2.spawnReplies.push({ pid: 2 });
    await w2.run(['start', '--model', 'grok', '--name', 'w-fast', '--brief', brief(w2)]);
    const fast = w2.prompt('w-fast');
    // 开 PR、挂自动合并收成 pnpm pr:open 一步；格式和类型检查推前钩子跑，交代里不再重复
    expect(fast).toContain('pnpm pr:open');
    expect(fast).not.toContain('--no-automerge');
    expect(fast).not.toContain('gh pr create');
    expect(fast).not.toContain('pnpm format');
    expect(fast).not.toContain('pnpm typecheck');
    expect(fast).toContain('它说「人闸：改标准」就照第 6 条停手');
  });

  // 派活到合并提速第一片（#1066，2026-10-05 审计：工人 25.5% 的时间在本机整包测试，另有 7% 在盯 CI）
  describe('收尾交代：本机不跑整包、等后台命令不结束回合、不盯 CI；起的进程带 FLEET_WORKER=1', () => {
    for (const noAutomerge of [false, true]) {
      it(`${noAutomerge ? '--no-automerge' : '默认'}：本机只点名跑改到的测试文件，不教 test:changed 和单跑对应包`, () => {
        const text = lib.closingBrief({
          branch: 'w/x',
          noShip: false,
          noAutomerge,
          issue: { number: 1066, refs: true },
        });
        expect(text).toContain('npx vitest run <文件…>');
        expect(text).toContain('不跑 pnpm test:changed、不跑整包');
        expect(text).toContain('CI 红了再回来修');
        expect(text).not.toContain('改完跑 pnpm test:changed');
        expect(text).not.toContain('单跑对应包');
        expect(text).not.toContain('退出码 3');
      });

      it(`${noAutomerge ? '--no-automerge' : '默认'}：写死等后台命令时不许结束回合（≤55 秒的前台循环），开完 PR 不盯 CI、没有 --watch 的做法`, () => {
        const text = lib.closingBrief({
          branch: 'w/x',
          noShip: false,
          noAutomerge,
          issue: { number: 1066, refs: true },
        });
        expect(text).toContain('等自己起的后台命令时不许结束这一轮');
        expect(text).toContain('不超过 55 秒的前台循环');
        expect(text).toContain('不盯 CI、不 --watch');
        expect(text).not.toContain('盯到');
        // 唯一出现 --watch 的地方是「不 --watch」那句
        expect(text.match(/--watch/g)).toHaveLength(1);
      });
    }

    it('起的模型进程环境里带 FLEET_WORKER=1（safeEnv 白名单之外单独给，不靠 process.env 透传）；别的普通变量照旧不传', async () => {
      for (const model of ['grok', 'claude']) {
        const w = world();
        w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
        w.pnpmReplies.push(ok());
        w.spawnReplies.push({ pid: 7 });
        await w.run(['start', '--model', model, '--name', `w-env-${model}`, '--brief', brief(w)]);
        const spec = w.spawnCalls[0];
        expect(spec?.env.FLEET_WORKER).toBe('1');
        expect(spec?.env.SOME_VAR).toBeUndefined();
        expect(spec?.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
      }
    });
  });

  // 创始人 2026-10-06「我认为不能脱离……你拍板直接做」：脱离会话的工人不显示在 Mirasim 面板里，他看不见；默认改 Agent 子代理，
  // 起脱离的工人必须说清为什么（--detached "<理由>"），没说清就拒起、什么都不建不起
  describe('脱离会话要说理由（--detached）', () => {
    const base = (w: ReturnType<typeof world>, extra: string[]) => [
      'start',
      '--model',
      'grok',
      '--name',
      'wd',
      '--brief',
      brief(w),
      '--issue',
      '1052',
      ...extra,
    ];

    it('【故意造出的失败】没给 --detached：退出码 1，话里指向 Agent 子代理，什么都没建没起', async () => {
      const w = world();
      expect(await w.runRaw(base(w, []))).toBe(1);
      expect(w.err.join('\n')).toContain('Agent 工具');
      expect(w.err.join('\n')).toContain('--detached');
      expect(w.gitCalls).toEqual([]);
      expect(w.pnpmCalls).toEqual([]);
      expect(w.spawnCalls).toEqual([]);
    });

    it('【故意造出的失败】理由空着、太短：同样拒起', async () => {
      for (const why of ['', '  ', '嗯']) {
        const w = world();
        expect(await w.runRaw(base(w, ['--detached', why])), JSON.stringify(why)).toBe(1);
        expect(w.spawnCalls).toEqual([]);
      }
    });

    it('给了理由：起得来，理由记进这个工人的 meta.json', async () => {
      const w = world();
      w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
      w.pnpmReplies.push(ok());
      w.spawnReplies.push({ pid: 1 });
      const code = await w.runRaw(base(w, ['--detached', '创始人说了无人值守过夜']));
      expect(code, w.err.join(' / ')).toBe(0);
      expect(w.meta('wd').detached).toBe('创始人说了无人值守过夜');
    });
  });

  // #1052：2026-10-05 起 37 个 PR 没一个挂单，交代里写死的「不开单」是主因；派活这一步必须说清挂哪张单
  describe('挂单（--issue / --no-issue 二选一）', () => {
    const startArgs = (w: ReturnType<typeof world>, extra: string[]) => [
      'start',
      '--model',
      'grok',
      '--name',
      'wi',
      '--brief',
      brief(w),
      '--detached',
      '测试里要脱离',
      ...extra,
    ];
    const untouched = (w: ReturnType<typeof world>) => {
      expect(w.gitCalls).toEqual([]);
      expect(w.pnpmCalls).toEqual([]);
      expect(w.spawnCalls).toEqual([]);
    };

    it('故意造出失败：两个都没给，退出码 1、说明缺什么，什么都没建没起', async () => {
      const w = world();
      expect(await w.runRaw(startArgs(w, []))).toBe(1);
      expect(w.err.join('\n')).toContain('--issue');
      expect(w.err.join('\n')).toContain('--no-issue');
      untouched(w);
    });

    it('故意造出失败：两个都给、单号不是正整数、理由是空的、--refs 没配 --issue，都拒起', async () => {
      for (const extra of [
        ['--issue', '12', '--no-issue', '没有单'],
        ['--issue', 'abc'],
        ['--issue', '0'],
        ['--no-issue', '   '],
        ['--refs', '--no-issue', '没有单'],
        ['--refs'],
      ]) {
        const w = world();
        expect(await w.runRaw(startArgs(w, extra)), extra.join(' ')).toBe(1);
        untouched(w);
      }
    });

    it('--issue：收尾交代写「这个活挂在单 #N」和需求栏 Closes #N，pr:open 不带 --no-issue，不再有「不开单」', async () => {
      const w = world();
      w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
      w.pnpmReplies.push(ok());
      w.spawnReplies.push({ pid: 1 });
      expect(await w.runRaw(startArgs(w, ['--issue', '#1052']))).toBe(0);
      const prompt = w.prompt('wi');
      expect(prompt).toContain('挂在单 #1052 上');
      expect(prompt).toContain('Closes #1052');
      expect(prompt).not.toContain('Refs #');
      expect(prompt).not.toContain('--no-issue');
      expect(prompt).not.toContain('不开单');
    });

    it('--issue --refs：母单的分片，交代写 Refs #N、不写 Closes', async () => {
      const w = world();
      w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
      w.pnpmReplies.push(ok());
      w.spawnReplies.push({ pid: 1 });
      expect(await w.runRaw(startArgs(w, ['--issue', '1016', '--refs']))).toBe(0);
      const prompt = w.prompt('wi');
      expect(prompt).toContain('Refs #1016');
      expect(prompt).not.toContain('Closes #');
    });

    it('--no-issue "<理由>"：交代里 pr:open 带同一句理由，不写 Closes', async () => {
      const w = world();
      w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
      w.pnpmReplies.push(ok());
      w.spawnReplies.push({ pid: 1 });
      expect(await w.runRaw(startArgs(w, ['--no-issue', '一行文字修正，不值得开单']))).toBe(0);
      const prompt = w.prompt('wi');
      expect(prompt).toContain('--no-issue "一行文字修正，不值得开单"');
      expect(prompt).not.toContain('Closes #');
    });

    it('--no-ship 冒烟不开 PR，不要求挂单', async () => {
      const w = world();
      w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
      w.pnpmReplies.push(ok());
      w.spawnReplies.push({ pid: 1 });
      expect(await w.runRaw(startArgs(w, ['--no-ship']))).toBe(0);
    });

    it('--no-automerge 的人闸版交代也带挂单那句', async () => {
      const w = world();
      w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
      w.pnpmReplies.push(ok());
      w.spawnReplies.push({ pid: 1 });
      expect(await w.runRaw(startArgs(w, ['--issue', '77', '--no-automerge']))).toBe(0);
      expect(w.prompt('wi')).toContain('Closes #77');
    });
  });
});

describe('start：GitHub 走哪条路（直连不通就走环境里原有的代理）', () => {
  const PROXY = 'http://127.0.0.1:59822';

  it('直连通：照旧——fetch 去代理、模型命令行加 GitHub 的 NO_PROXY、收尾交代教 env -u；meta 记 direct', async () => {
    const w = world();
    w.io.env.https_proxy = PROXY;
    w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    w.spawnReplies.push({ pid: 7 });

    expect(await w.run(['start', '--model', 'grok', '--name', 'r1', '--brief', brief(w)])).toBe(0);

    expect(w.probeCalls).toHaveLength(1);
    const probe = must(w.probeCalls[0], '没有 probeCalls[0]');
    expect(probe.args).toEqual(['ls-remote', 'origin', 'main']);
    expect(probe.opts?.proxy).toBe(false);
    expect(probe.opts?.timeoutMs).toBe(8000);
    const fetch = must(
      w.gitOpts.find((c) => c.args[0] === 'fetch'),
      '没有 fetch',
    );
    expect(fetch.opts?.proxy).toBe(false);
    const spec = must(w.spawnCalls[0], '没有 spawnCalls[0]');
    expect(spec.env.NO_PROXY?.split(',')).toEqual(expect.arrayContaining(['github.com', 'api.github.com']));
    expect(spec.env.https_proxy).toBe(PROXY); // 模型自己连后端的代理照留
    expect(w.prompt('r1')).toContain('env -u https_proxy');
    expect(w.meta('r1')).toMatchObject({ githubRoute: 'direct' });
    expect(w.out.join('\n')).toContain('GitHub：直连');
  });

  it('【故意造出的失败】直连不通、代理通：脚本自己的 git 不去代理，模型命令行不加 GitHub 的 NO_PROXY，收尾交代不教去掉代理；meta 记 proxy', async () => {
    const w = world();
    w.io.env.https_proxy = PROXY;
    w.io.env.NO_PROXY = 'localhost';
    w.probeReplies.push(
      bad('fatal: unable to access github.com: Failed to connect: Timed out'),
      ok('abc\trefs/heads/main'),
    );
    w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    w.spawnReplies.push({ pid: 8 });

    expect(await w.run(['start', '--model', 'grok', '--name', 'r2', '--brief', brief(w)])).toBe(0);

    expect(w.probeCalls.map((c) => c.opts?.proxy)).toEqual([false, true]);
    const fetch = must(
      w.gitOpts.find((c) => c.args[0] === 'fetch'),
      '没有 fetch',
    );
    expect(fetch.opts?.proxy).toBe(true);
    const spec = must(w.spawnCalls[0], '没有 spawnCalls[0]');
    expect(spec.env.https_proxy).toBe(PROXY);
    expect(spec.env.NO_PROXY).toBe('localhost'); // 原样，不加 GitHub 域名
    expect(spec.env.no_proxy).toBeUndefined();
    const prompt = w.prompt('r2');
    expect(prompt).not.toContain('env -u');
    expect(prompt).toContain('不要去掉代理');
    expect(w.meta('r2')).toMatchObject({ githubRoute: 'proxy' });
    expect(w.out.join('\n')).toContain(`GitHub：走代理 ${PROXY}`);
  });

  it('【故意造出的失败】直连、代理都不通：退出码 2，两条各自的报错都写出来，不 fetch、不建工作树、不起模型', async () => {
    const w = world();
    w.io.env.https_proxy = PROXY;
    w.probeReplies.push(bad('direct: Connection timed out'), bad('proxy: Could not connect to 127.0.0.1'));
    w.gitReplies.push(ok('true'), listed(w));

    expect(await w.run(['start', '--model', 'grok', '--name', 'r3', '--brief', brief(w)])).toBe(2);

    const errText = w.err.join('\n');
    expect(errText).toContain('direct: Connection timed out');
    expect(errText).toContain('proxy: Could not connect to 127.0.0.1');
    expect(w.gitCalls.map((c) => c.args[0])).toEqual(['rev-parse', 'worktree']);
    expect(w.pnpmCalls).toEqual([]);
    expect(w.spawnCalls).toEqual([]);
  });

  it('【故意造出的失败】直连不通、环境里也没有代理：退出码 2，明说没有代理可走', async () => {
    const w = world();
    w.probeReplies.push(bad('direct: Connection timed out'));
    w.gitReplies.push(ok('true'), listed(w));

    expect(await w.run(['start', '--model', 'grok', '--name', 'r4', '--brief', brief(w)])).toBe(2);

    const errText = w.err.join('\n');
    expect(errText).toContain('direct: Connection timed out');
    expect(errText).toContain('没有代理');
    expect(w.probeCalls).toHaveLength(1);
    expect(w.spawnCalls).toEqual([]);
  });

  it('status 照 meta 里记的路走：proxy 的记录 gh 带代理，老记录（没有 githubRoute）照旧去代理', async () => {
    const w = world();
    w.writeMeta('r5', validMeta(w, 'r5', { githubRoute: 'proxy' }));
    w.writeMeta('r6', validMeta(w, 'r6'));
    w.ghReplies.push(ok('[]'), ok('[]'));
    expect(await w.run(['status'])).toBe(0);
    expect(w.ghOpts.map((c) => c.opts?.proxy)).toEqual([true, false]);
  });

  it('【故意造出的失败】meta 里的 githubRoute 认不出：没查成，不当成直连', async () => {
    const w = world();
    w.writeMeta('r7', validMeta(w, 'r7', { githubRoute: 'vpn' }));
    expect(await w.run(['status', '--name', 'r7'])).toBe(2);
    expect(w.out.join('\n')).toContain('githubRoute 认不出');
  });

  it('clean 照 meta 里记的路查 PR', async () => {
    const w = world();
    w.writeMeta('r8', validMeta(w, 'r8', { githubRoute: 'proxy' }));
    w.ghReplies.push(ok(JSON.stringify([{ number: 1, state: 'MERGED', url: 'u' }])));
    w.gitReplies.push(ok(), ok());
    expect(await w.run(['clean', '--name', 'r8'])).toBe(0);
    expect(w.ghOpts.map((c) => c.opts?.proxy)).toEqual([true]);
  });
});

// 叫法和档位照 packages/shared/src/effort.ts（驾驶舱、引擎用的那一份）：启动器是 .mjs、引不了它，这里钉住两边一样
const sharedEffort = (await import(
  pathToFileURL(join(REPO_ROOT, 'packages', 'shared', 'src', 'effort.ts')).href
)) as {
  SESSION_EFFORTS: readonly string[];
  GROK_EFFORTS: readonly string[];
  DEFAULT_SESSION_EFFORT: string;
};

describe('start：思考档位照仓里的路由骨架（#470，本机读不到法国库）', () => {
  /** 跑一次 start 到起模型那一步（git、pnpm、spawn 都给成功）。 */
  const started = async (w: ReturnType<typeof world>, args: string[]) => {
    w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    w.spawnReplies.push({ pid: 7 });
    const code = await w.run(['start', ...args, '--brief', brief(w)]);
    return { code, spec: w.spawnCalls[0] };
  };

  it('档位的叫法、默认档和驾驶舱、引擎用的同一份（packages/shared/src/effort.ts）', () => {
    expect(lib.SESSION_EFFORTS).toEqual([...sharedEffort.SESSION_EFFORTS]);
    expect(lib.DEFAULT_EFFORT).toBe(sharedEffort.DEFAULT_SESSION_EFFORT);
    // grok 命令行认的档：和引擎起 grok 会话认的一样
    expect(lib.EFFORTS).toEqual([...sharedEffort.GROK_EFFORTS]);
  });

  it('grok：骨架给 grok-4.7 配了 medium，命令行就是 --reasoning-effort medium，说清是骨架配的', async () => {
    const w = world();
    w.skeleton(
      skeletonWith({ 'grok-4.7': [{ routeId: 'grok:grok-4.7:grok', enabled: true, effort: 'medium' }] }),
    );
    const { code, spec } = await started(w, ['--model', 'grok', '--name', 'e1']);
    expect(code).toBe(0);
    expect(spec?.args).toEqual(expect.arrayContaining(['--reasoning-effort', 'medium']));
    expect(w.meta('e1').effort).toBe('medium');
    expect(w.out.join('\n')).toContain('档位 medium（路由骨架给 grok-4.7 配的）');
  });

  it('codex：照 GPT（gpt-5.6-luna）配的；没配的路由（cursor 的整串模型名）不算', async () => {
    const w = world();
    w.skeleton(
      skeletonWith({
        'gpt-5.6-luna': [
          { routeId: 'cursor:gpt-5.6-luna:cursor-agent', enabled: true },
          { routeId: 'mirasim-relay:gpt-5.6-luna:mirasim', enabled: false, effort: 'low' },
        ],
      }),
    );
    const { code, spec } = await started(w, ['--model', 'codex', '--name', 'e2']);
    expect(code).toBe(0);
    expect(spec?.args).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort="low"']));
  });

  it('--model-id 给了按它查；骨架里没有这个模型：high，说清没配', async () => {
    const w = world();
    const { code, spec } = await started(w, ['--model', 'grok', '--name', 'e3', '--model-id', 'grok-4.8']);
    expect(code).toBe(0);
    expect(spec?.args).toEqual(expect.arrayContaining(['--reasoning-effort', 'high', '--model', 'grok-4.8']));
    expect(w.out.join('\n')).toContain('档位 high（路由骨架里没有模型 grok-4.8，用默认）');
  });

  it('--effort 给了：这一次照它（不读骨架，骨架不在也行）', async () => {
    const w = world();
    w.skeleton(
      skeletonWith({ 'grok-4.7': [{ routeId: 'grok:grok-4.7:grok', enabled: true, effort: 'medium' }] }),
    );
    const first = await started(w, ['--model', 'grok', '--name', 'e4', '--effort', 'xhigh']);
    expect(first.spec?.args).toEqual(expect.arrayContaining(['--reasoning-effort', 'xhigh']));
    expect(w.out.join('\n')).toContain('档位 xhigh（--effort 指定的）');

    const w2 = world();
    w2.dropSkeleton();
    const second = await started(w2, ['--model', 'grok', '--name', 'e5', '--effort', 'low']);
    expect(second.code).toBe(0);
    expect(second.spec?.args).toEqual(expect.arrayContaining(['--reasoning-effort', 'low']));
  });

  describe('【故意造出的失败】骨架读不到、认不出：退出码 2、说清哪里不对，不碰 git、不起模型，不当成 high', () => {
    const refused = async (w: ReturnType<typeof world>, text: string | RegExp, model = 'grok') => {
      const code = await w.run(['start', '--model', model, '--name', 'bad', '--brief', brief(w)]);
      expect(code).toBe(2);
      expect(w.err.at(-1)).toMatch(text);
      expect(w.gitCalls).toEqual([]);
      expect(w.spawnCalls).toEqual([]);
    };

    it('同步专用检出里没有骨架', async () => {
      const w = world();
      w.dropSkeleton();
      await refused(w, /路由骨架读不到.*pnpm agents:sync/);
    });

    it('不是 JSON、没有 models、模型下不是路由列表', async () => {
      const w = world();
      w.skeleton('{ 坏的');
      await refused(w, /路由骨架不是 JSON/);
      const w2 = world();
      w2.skeleton(JSON.stringify({ purposes: {} }));
      await refused(w2, /没有 models/);
      const w3 = world();
      w3.skeleton(skeletonWith({ 'grok-4.7': { routeId: 'x' } }));
      await refused(w3, /models\.grok-4\.7 不是路由列表/);
    });

    it('档位写了认不出的值', async () => {
      const w = world();
      w.skeleton(
        skeletonWith({ 'grok-4.7': [{ routeId: 'grok:grok-4.7:grok', enabled: true, effort: 'turbo' }] }),
      );
      await refused(w, /grok:grok-4\.7:grok 的思考档位认不出："turbo"/);
    });

    it('配了这个命令行不认的档（grok 没有 max）', async () => {
      const w = world();
      w.skeleton(
        skeletonWith({ 'grok-4.7': [{ routeId: 'grok:grok-4.7:grok', enabled: true, effort: 'max' }] }),
      );
      await refused(w, /配的是 max，grok 命令行不认/);
    });

    it('同一模型几条路由配的不一样：不知道照哪条，不挑一个', async () => {
      const w = world();
      w.skeleton(
        skeletonWith({
          'gpt-5.6-luna': [
            { routeId: 'a', enabled: true, effort: 'low' },
            { routeId: 'b', enabled: true, effort: 'high' },
          ],
        }),
      );
      await refused(w, /几条路由配的档位不一样（a：low、b：high）/, 'codex');
    });
  });
});

describe('start：【故意造出的失败】', () => {
  it('工作树已经存在：拒绝，退出码 3，不跑 git fetch/worktree add', async () => {
    const w = world();
    mkdirSync(join(w.repo, '.claude', 'worktrees', 'w-dup'), { recursive: true }); // 提前占好目录，模拟已经有一棵工作树
    w.gitReplies.push(ok('true'), listed(w));
    const code = await w.run(['start', '--model', 'grok', '--name', 'dup', '--brief', brief(w)]);
    expect(code).toBe(3);
    expect(w.err.join('\n')).toContain('工作树已经存在');
    expect(w.gitCalls.map((c) => c.args[0])).toEqual(['rev-parse', 'worktree']); // 找完主检出就短路，不 fetch
  });

  it('【故意造出的失败】在某棵工作树里起（不带 --repo）：新树建在主检出的 .claude/worktrees/ 下，不在当前那棵树里再套一棵', async () => {
    const w = world();
    const outer = join(w.repo, '.claude', 'worktrees', 'w-outer');
    mkdirSync(outer, { recursive: true });
    w.io.cwd = () => outer;
    w.gitReplies.push(ok('true'), listed(w, outer), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    w.spawnReplies.push({ pid: 31 });

    expect(await w.run(['start', '--model', 'grok', '--name', 'inner', '--brief', brief(w)])).toBe(0);

    const want = join(w.repo, '.claude', 'worktrees', 'w-inner');
    expect(w.gitCalls[0]?.cwd).toBe(outer);
    expect(w.gitCalls.find((c) => c.args[1] === 'add')?.args).toEqual([
      'worktree',
      'add',
      '-b',
      'w/inner',
      want,
      'origin/main',
    ]);
    expect(w.meta('inner')).toMatchObject({ mainRepo: w.repo, worktree: want });
  });

  it('【故意造出的失败】git worktree list 的输出认不出主检出：退出码 2，不拿当前目录冒充主检出', async () => {
    const w = world();
    w.gitReplies.push(ok('true'), ok(''));
    expect(await w.run(['start', '--model', 'grok', '--name', 'nolist', '--brief', brief(w)])).toBe(2);
    expect(w.err.join('\n')).toContain('认不出主检出');
    expect(w.gitCalls).toHaveLength(2);
  });

  it('git worktree list 里已经有这个分支：拒绝，退出码 3', async () => {
    const w = world();
    w.gitReplies.push(
      ok('true'),
      ok(
        `worktree ${w.repo}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${join(w.repo, '.claude', 'worktrees', 'w-dup2')}\nHEAD def\nbranch refs/heads/w/dup2\n`,
      ),
    );
    const code = await w.run(['start', '--model', 'grok', '--name', 'dup2', '--brief', brief(w)]);
    expect(code).toBe(3);
    expect(w.err.join('\n')).toContain('已经有一棵工作树占着了');
    expect(w.gitCalls).toHaveLength(2); // rev-parse、worktree list；不该到 fetch
  });

  it('不认识的模型：退出码 1，不碰 git/gh/pnpm/spawn', async () => {
    const w = world();
    const code = await w.run(['start', '--model', 'bogus', '--name', 'w4', '--brief', brief(w)]);
    expect(code).toBe(1);
    expect(w.err.join('\n')).toContain('不认识的模型');
    expect(w.gitCalls).toEqual([]);
  });

  it('kimi：明确报「没有无人值守模式」，退出码 2，不碰 git/gh/pnpm/spawn', async () => {
    const w = world();
    const code = await w.run(['start', '--model', 'kimi', '--name', 'w5', '--brief', brief(w)]);
    expect(code).toBe(2);
    expect(w.err.join('\n')).toContain('kimi 没有无人值守模式');
    expect(w.gitCalls).toEqual([]);
  });

  // #1016：长活搬出聊天会话——Claude 工人也走这条独立进程的路
  it('claude：经外壳起 reclaude，prompt 走标准输入，默认 sonnet，带思考档位；收尾交代里有四类人闸那一段', async () => {
    const w = world();
    w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    w.spawnReplies.push({ pid: 77 });
    const code = await w.run([
      'start',
      '--model',
      'claude',
      '--name',
      'w7',
      '--brief',
      brief(w),
      '--effort',
      'high',
    ]);
    expect(code).toBe(0);
    const promptFile = join(w.home, '.fleet-dao', 'workers', 'w7', 'prompt.txt');
    const spec = must(w.spawnCalls[0], '没有 spawnCalls[0]');
    // 起的是外壳 worker-supervise.mjs（它看着 reclaude，网关掉线时续跑）；提示词由它读文件、再从标准输入喂给 reclaude
    expect(spec.command).toBe('node');
    const dashAt = spec.args.indexOf('--');
    expect(spec.args[0]).toBe(join(SCRIPTS, 'worker-supervise.mjs'));
    expect(spec.args.slice(1, dashAt)).toEqual([
      '--meta',
      join(w.home, '.fleet-dao', 'workers', 'w7', 'meta.json'),
      '--prompt',
      promptFile,
    ]);
    expect(spec.args.slice(dashAt + 1)).toEqual([
      'reclaude',
      '-p',
      '--dangerously-skip-permissions',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(spec.stdinFile).toBeNull();
    expect(spec.cwd).toBe(join(w.repo, '.claude', 'worktrees', 'w-w7'));
    const prompt = readFileSync(promptFile, 'utf8');
    for (const gate of ['对外发布', '花钱', '删数据', '改标准']) expect(prompt, gate).toContain(gate);
    expect(prompt).toContain('卡住：人闸——');
  });

  it('claude：--model-id opus 透传（默认是 sonnet，要 Opus 得显式给）', async () => {
    const w = world();
    w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    w.spawnReplies.push({ pid: 78 });
    const code = await w.run([
      'start',
      '--model',
      'claude',
      '--name',
      'w8',
      '--brief',
      brief(w),
      '--model-id',
      'opus',
      '--effort',
      'medium',
    ]);
    expect(code).toBe(0);
    const args = must(w.spawnCalls[0], '没有 spawnCalls[0]').args;
    expect(args).toContain('opus');
    expect(args).not.toContain('sonnet');
  });

  it('【故意造出的失败】claude 工人要用 Fable（或别的不是 Opus、Sonnet 的型号）：拒起，不碰 git/gh/pnpm/spawn', async () => {
    for (const id of ['claude-fable-5-1', 'fable', 'haiku', 'gpt-5.6-luna']) {
      const w = world();
      const code = await w.run([
        'start',
        '--model',
        'claude',
        '--name',
        'w9',
        '--brief',
        brief(w),
        '--model-id',
        id,
        '--effort',
        'high',
      ]);
      expect(code, id).not.toBe(0);
      expect(w.err.join('\n'), id).toContain('只用 Opus 或 Sonnet');
      expect(w.gitCalls, id).toEqual([]);
      expect(w.spawnCalls, id).toEqual([]);
    }
  });

  it('不认识的档位：退出码 1，不碰 git/gh/pnpm/spawn', async () => {
    const w = world();
    const code = await w.run([
      'start',
      '--model',
      'grok',
      '--name',
      'w5b',
      '--brief',
      brief(w),
      '--effort',
      'ultra',
    ]);
    expect(code).toBe(1);
    expect(w.err.join('\n')).toContain('不认识的档位「ultra」');
    expect(w.gitCalls).toEqual([]);
  });

  it('brief 文件读不到、是空的：退出码 2，不碰 git', async () => {
    const w = world();
    expect(
      await w.run(['start', '--model', 'grok', '--name', 'w6', '--brief', join(w.home, '没有这个文件')]),
    ).toBe(2);
    expect(w.err.at(-1)).toContain('brief 文件读不到');
    const emptyFile = brief(w, '   \n  ');
    expect(await w.run(['start', '--model', 'grok', '--name', 'w6', '--brief', emptyFile])).toBe(2);
    expect(w.err.at(-1)).toContain('brief 文件是空的');
    expect(w.gitCalls).toEqual([]);
  });

  it('--repo 不是 git 检出：退出码 2', async () => {
    const w = world();
    w.gitReplies.push(bad('fatal: not a git repository', 128));
    const code = await w.run(['start', '--model', 'grok', '--name', 'w7', '--brief', brief(w)]);
    expect(code).toBe(2);
    expect(w.err.at(-1)).toContain('不是 git 检出');
    expect(w.err.at(-1)).toContain('not a git repository');
  });

  it('git fetch origin main 没成：退出码 2', async () => {
    const w = world();
    w.gitReplies.push(ok('true'), listed(w), bad('fatal: unable to access'));
    const code = await w.run(['start', '--model', 'grok', '--name', 'w8', '--brief', brief(w)]);
    expect(code).toBe(2);
    expect(w.err.at(-1)).toContain('git fetch origin main 没成');
  });

  it('git worktree add 没成：一般失败退出码 2；说已经存在的算冲突退出码 3', async () => {
    const w = world();
    w.gitReplies.push(ok('true'), listed(w), ok(''), bad('fatal: no space left on device'));
    expect(await w.run(['start', '--model', 'grok', '--name', 'w9', '--brief', brief(w)])).toBe(2);
    expect(w.err.at(-1)).toContain('git worktree add 没成');

    w.gitReplies.push(ok('true'), listed(w), ok(''), bad("fatal: 'w/w9' already exists"));
    expect(await w.run(['start', '--model', 'grok', '--name', 'w9', '--brief', brief(w)])).toBe(3);
    expect(w.err.at(-1)).toContain('git worktree add 说已经占了');
  });

  it('pnpm install 失败：非 0 退出、说明原因，且提示工作树没删、可以 clean --force', async () => {
    const w = world();
    w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
    w.pnpmReplies.push(bad('ERR_PNPM_OUTDATED_LOCKFILE  lockfile 和 package.json 对不上', 1));
    const code = await w.run(['start', '--model', 'grok', '--name', 'w10', '--brief', brief(w)]);
    expect(code).toBe(2);
    expect(w.err.at(-1)).toContain('pnpm install 没成');
    expect(w.err.at(-1)).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    expect(w.err.at(-1)).toContain('clean --name w10 --force');
    expect(w.spawnCalls).toEqual([]); // 没到起模型这一步
  });

  it('起模型这步 spawn 抛出来：退出码 2，说明工作树和 pnpm install 都已经做完、没删', async () => {
    const w = world();
    w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    w.spawnReplies.push(new Error('spawn grok ENOENT'));
    const code = await w.run(['start', '--model', 'grok', '--name', 'w11', '--brief', brief(w)]);
    expect(code).toBe(2);
    expect(w.err.at(-1)).toContain('起不了 grok');
    expect(w.err.at(-1)).toContain('spawn grok ENOENT');
    expect(w.err.at(-1)).toContain('没删');
  });

  it('起模型这步 spawn 抛出「不确定」（err.uncertain=true）：不说「起不了」，写一份 pidUncertain 的 meta', async () => {
    // 09-28 真活撞过：launch-detached.ps1 其实已经把 grok 起起来了，只是这条链路没能把 pid 确认回来
    // （worker.mjs 那边的坑，细节写在那份文件头）；这种半成功绝不能被说成「起不了」。
    const w = world();
    w.gitReplies.push(ok('true'), listed(w), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    const e = Object.assign(new Error('powershell.exe 退出码 1，没读到有效的 launch-result.json'), {
      uncertain: true,
    });
    w.spawnReplies.push(e);
    const code = await w.run(['start', '--model', 'grok', '--name', 'w12', '--brief', brief(w)]);
    expect(code).toBe(2);
    expect(w.err.at(-1)).not.toContain('起不了');
    expect(w.err.at(-1)).toContain('进程可能已经在跑、没记上');
    expect(w.err.at(-1)).toContain('没读到有效的 launch-result.json');

    const meta = w.meta('w12');
    expect(meta.pid).toBeNull();
    expect(meta.pidUncertain).toBe(true);
    expect(meta.pidUncertainWhy).toContain('没读到有效的 launch-result.json');
    expect(meta.model).toBe('grok');
    expect(meta.worktree).toBe(join(w.repo, '.claude', 'worktrees', 'w-w12'));
  });
});

describe('Windows 引号（windows-quote.mjs）', () => {
  // 09-28 拿真的 pnpm.cmd（cmd.exe /d /s /c 包一层）和 Start-Process（PowerShell 那条路径）分别跑通过这几个
  // 刁钻输入，golden 值是当场算出来的实际输出，不是凭空编的（过程和复现方式写在 PR 正文）：这里只冻住
  // 「这份实现现在就是这么转义的」，回归了在这测破，不用每次改完再靠真跑 grok 才发现。
  it.each([
    ['hello', '^"hello^"'],
    ['a b', '^"a b^"'],
    ['with"quote', '^"with\\^"quote^"'],
    ['50% off', '^"50^% off^"'],
    ['a&b', '^"a^&b^"'],
    ['a^b', '^"a^^b^"'],
    ['a|b', '^"a^|b^"'],
    ['(x)', '^"^(x^)^"'],
    ['tail\\', '^"tail\\\\^"'],
    ['', '^"^"'],
    ['<x>', '^"^<x^>^"'],
    ['!bang', '^"^!bang^"'],
    ['a""b', '^"a\\^"\\^"b^"'],
    ['back\\"slash', '^"back\\\\\\^"slash^"'],
    ['pipe|and&amp', '^"pipe^|and^&amp^"'],
  ])('windowsQuoteArg(%j) -> %j', (input, expected) => {
    expect(winQuote.windowsQuoteArg(input)).toBe(expected);
  });

  it('windowsCmdLine：command 和每个参数各自转义、空格隔开，外面再包一层引号', () => {
    expect(winQuote.windowsCmdLine('node', ['-e', 'a&b', '50% x'])).toBe(
      '"^"node^" ^"-e^" ^"a^&b^" ^"50^% x^""',
    );
    expect(winQuote.windowsCmdLine('grok', [])).toBe('"^"grok^""');
  });
});

describe('spawn-detached-support.mjs（ETIMEDOUT 那次真活撞出来的修法）', () => {
  it("powershellSpawnOptions：钉死 stdio:'ignore'——这是修 ETIMEDOUT 的关键，回归了要在这测破", () => {
    // 09-28 真活撞过：默认的管道 stdio 会被 Start-Process 底下的 CreateProcess 传给孙进程（cmd.exe ->
    // grok/codex），Node 读这个管道会一直等到孙进程退出才算完，对一个跑好几分钟的模型会话就是卡到超时。
    expect(spawnSupport.powershellSpawnOptions({ timeoutMs: 20_000 })).toEqual({
      stdio: 'ignore',
      windowsHide: true,
      timeout: 20_000,
    });
  });

  describe('interpretLaunchResult', () => {
    it('确认成功：结果文件里有合法的 pid', () => {
      expect(
        spawnSupport.interpretLaunchResult({
          spawnError: null,
          spawnStatus: 0,
          resultText: '{"pid":4242,"error":null}',
        }),
      ).toEqual({ ok: true, pid: 4242 });
    });

    it('【故意造出的失败】确认失败：powershell.exe 自己都没能跑起来', () => {
      const r = spawnSupport.interpretLaunchResult({
        spawnError: 'ENOENT',
        spawnStatus: null,
        resultText: null,
      });
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ confirmed: true });
      expect((r as { why: string }).why).toContain('起不了 powershell.exe');
      expect((r as { why: string }).why).toContain('ENOENT');
    });

    it('【故意造出的失败】确认失败：launch-detached.ps1 自己报了 Start-Process 没成', () => {
      const r = spawnSupport.interpretLaunchResult({
        spawnError: null,
        spawnStatus: 1,
        resultText: '{"pid":null,"error":"找不到 cmd.exe"}',
      });
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ confirmed: true });
      expect((r as { why: string }).why).toContain('找不到 cmd.exe');
    });

    it('【故意造出的失败】不确定（绝不能说「起不了」）：结果文件没读到——可能已经在跑，09-28 真撞过这个场景', () => {
      const r = spawnSupport.interpretLaunchResult({ spawnError: null, spawnStatus: 0, resultText: null });
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ confirmed: false });
      expect((r as { why: string }).why).not.toContain('起不了');
      expect((r as { why: string }).why).toContain('不确定');
    });

    it('【故意造出的失败】不确定：结果文件不是合法 JSON', () => {
      const r = spawnSupport.interpretLaunchResult({
        spawnError: null,
        spawnStatus: 0,
        resultText: 'not json',
      });
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ confirmed: false });
    });

    it('【故意造出的失败】不确定：结果文件是合法 JSON，但既没有 pid 也没有 error', () => {
      const r = spawnSupport.interpretLaunchResult({ spawnError: null, spawnStatus: 1, resultText: '{}' });
      expect(r.ok).toBe(false);
      expect(r).toMatchObject({ confirmed: false });
    });
  });
});

describe('spawn-detached.mjs（WMI 起法：躲开会话的 Job Object，2026-10-06 过夜工人被一起掐死那次的修法）', () => {
  const baseSpec = {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['-e', 'a&b 50%'],
    cwd: 'C:\\w',
    env: { PATH: 'C:\\x', DROPPED: undefined, FLEET_WORKER: '1' } as Record<string, string | undefined>,
    stdinFile: null as string | null,
    outFile: 'C:\\w\\out.log',
    errFile: 'C:\\w\\err.log',
  };

  it('buildLaunchSpec：命令行转义好、重定向接在后面、没有 stdinFile 就 < NUL；env 变 {name,value} 数组并丢掉 undefined', () => {
    const spec = spawnDetachedMod.buildLaunchSpec(baseSpec);
    expect(spec.commandLine).toBe(
      '^"C:\\Program Files\\nodejs\\node.exe^" ^"-e^" ^"a^&b 50^%^" > "C:\\w\\out.log" 2> "C:\\w\\err.log" < NUL',
    );
    expect(spec.cwd).toBe('C:\\w');
    expect(spec.env).toEqual([
      { name: 'PATH', value: 'C:\\x' },
      { name: 'FLEET_WORKER', value: '1' },
    ]);
    const withIn = spawnDetachedMod.buildLaunchSpec({ ...baseSpec, stdinFile: 'C:\\w\\prompt.txt' });
    expect(withIn.commandLine.endsWith('< "C:\\w\\prompt.txt"')).toBe(true);
  });

  it('【故意造出的失败】重定向路径里有 cmd.exe 会再解释的字符：直接报错，不拼', () => {
    for (const bad of ['C:\\w%TEMP%\\out.log', 'C:\\w&calc\\out.log', 'C:\\w"x\\out.log']) {
      expect(() => spawnDetachedMod.buildLaunchSpec({ ...baseSpec, outFile: bad })).toThrow(/cmd\.exe/);
    }
  });

  it('launch-detached.ps1 / detach-job-check.ps1：纯 ASCII、没有 BOM（Windows PowerShell 5.1 会把无 BOM 的非 ASCII 当 GBK 读坏）', () => {
    for (const f of ['launch-detached.ps1', 'detach-job-check.ps1']) {
      const bytes = readFileSync(join(SCRIPTS, f));
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
      expect(bytes.findIndex((b) => b > 0x7f)).toBe(-1);
    }
  });

  it('launch-detached.ps1 用 Win32_Process.Create，不再用 Start-Process（Start-Process 起的进程留在会话的 Job Object 里）', () => {
    const ps1 = readFileSync(join(SCRIPTS, 'launch-detached.ps1'), 'utf8');
    const code = ps1
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(code).toContain('Win32_Process');
    expect(code).not.toMatch(/Start-Process|Invoke-Expression/);
  });

  it.skipIf(process.platform !== 'win32')(
    '真起一次（Windows）：stdin 文件进得去、stdout/stderr 落到文件、pid 是真的、env 只有传进去的（令牌不继承）',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'spawn-detached-'));
      dirs.push(dir);
      writeFileSync(join(dir, 'in.txt'), 'hello-stdin');
      process.env.FLEET_TEST_SECRET_NOT_PASSED = 'leak-me';
      try {
        const script =
          "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(s+'|'+(process.env.FLEET_TEST_SECRET_NOT_PASSED??'unset')+'|'+process.env.FLEET_WORKER);console.error('to-stderr')})";
        const { pid } = spawnDetachedMod.spawnDetached({
          command: process.execPath,
          args: ['-e', script],
          cwd: dir,
          env: { ...lib.safeEnv(process.env), FLEET_WORKER: '1' },
          stdinFile: join(dir, 'in.txt'),
          outFile: join(dir, 'out.log'),
          errFile: join(dir, 'err.log'),
        });
        expect(pid).toBeGreaterThan(0);
        let out = '';
        for (let i = 0; i < 60 && !out.includes('|'); i++) {
          await new Promise((r) => setTimeout(r, 250));
          try {
            out = readFileSync(join(dir, 'out.log'), 'utf8');
          } catch {
            // 还没写出来
          }
        }
        expect(out.trim()).toBe('hello-stdin|unset|1');
        expect(readFileSync(join(dir, 'err.log'), 'utf8').trim()).toBe('to-stderr');
        expect(readFileSync(join(dir, 'launch-spec.json'), 'utf8')).not.toContain('leak-me');
      } finally {
        delete process.env.FLEET_TEST_SECRET_NOT_PASSED;
      }
    },
    30_000,
  );
});

describe('mergeNoProxy', () => {
  it('原来没有 NO_PROXY：加上三个 GitHub 域名', () => {
    const out = lib.mergeNoProxy({ FOO: 'bar' });
    expect(out.NO_PROXY?.split(',').sort()).toEqual(['api.github.com', 'codeload.github.com', 'github.com']);
    expect(out.no_proxy?.split(',').sort()).toEqual(['api.github.com', 'codeload.github.com', 'github.com']);
    expect(out.FOO).toBe('bar');
  });

  it('原来已经有别的域名：保留，只补没有的；已经有的不重复；大小写分开处理', () => {
    const out = lib.mergeNoProxy({ NO_PROXY: 'localhost,github.com', no_proxy: '127.0.0.1' });
    expect(out.NO_PROXY?.split(',')).toEqual([
      'localhost',
      'github.com',
      'api.github.com',
      'codeload.github.com',
    ]);
    expect(out.no_proxy?.split(',')).toEqual([
      '127.0.0.1',
      'github.com',
      'api.github.com',
      'codeload.github.com',
    ]);
  });

  it('不碰其它代理变量（https_proxy 原样保留，给模型自己连后端用）', () => {
    const out = lib.mergeNoProxy({ https_proxy: 'http://127.0.0.1:7890' });
    expect(out.https_proxy).toBe('http://127.0.0.1:7890');
  });
});

describe('safeEnv（09-28 安全教训：白名单，不是挡「像密钥的名字」那种黑名单）', () => {
  it('【故意造出的失败】白名单里的原样带过去，不在白名单的一律不带——哪怕看着不像密钥', () => {
    const out = lib.safeEnv({
      PATH: 'C:\\x',
      TEMP: 'C:\\temp',
      SOME_RANDOM_VAR: 'whatever', // 不像密钥，但也不在白名单里，照样不该出现
      GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_real_looking_secret', // 09-28 真撞见过这个
      MIRASIM_LOCAL_TOKEN: 'also_a_real_secret_shape',
    });
    expect(out.PATH).toBe('C:\\x');
    expect(out.TEMP).toBe('C:\\temp');
    expect(out.SOME_RANDOM_VAR).toBeUndefined();
    expect(out.GITHUB_PERSONAL_ACCESS_TOKEN).toBeUndefined();
    expect(out.MIRASIM_LOCAL_TOKEN).toBeUndefined();
  });

  it('值是 undefined 的键不带（跟原来 spawnDetached 里过滤 undefined 的规矩一致）', () => {
    const out = lib.safeEnv({ PATH: undefined });
    expect('PATH' in out).toBe(false);
  });

  it('SAFE_ENV_KEYS 本身不含任何看着像密钥/令牌/密码的名字（钉住这条底线，以后加白名单条目时会在这测破）', () => {
    const looksSecret = /token|secret|key|password|credential|passwd|auth/i;
    const offenders = lib.SAFE_ENV_KEYS.filter((k) => looksSecret.test(k));
    expect(offenders).toEqual([]);
  });
});

describe('status', () => {
  it('在跑：读 pid、最后一句输出、跑了多久、对应的 PR', async () => {
    const w = world();
    const dir = w.writeMeta('s1', validMeta(w, 's1'));
    writeFileSync(join(dir, 'out.log'), 'line1\n\n  line2 (最后一句)  \n');
    w.setRunning(9001, true);
    w.ghReplies.push(
      ok(JSON.stringify([{ number: 88, state: 'OPEN', url: 'https://github.com/o/r/pull/88' }])),
    );
    w.advance(5);

    const code = await w.run(['status', '--name', 's1']);
    expect(code).toBe(0);
    const text = w.out.join('\n');
    expect(text).toContain('在跑');
    expect(text).toContain('从起来到现在 5 分钟');
    expect(text).toContain('最后一句输出：line2 (最后一句)');
    expect(text).toContain('#88（OPEN）');
    expect(text).toContain('档位 high');
    expect(w.ghCalls[0]).toEqual({
      args: ['pr', 'list', '--head', 'w/s1', '--state', 'all', '--json', 'number,state,url'],
      cwd: w.repo,
    });
  });

  it('已经不在跑了；还没有输出（out.log 不存在）；PR 没查到时明说原因，不留空', async () => {
    const w = world();
    w.writeMeta('s2', validMeta(w, 's2'));
    w.setRunning(9001, false);
    w.ghReplies.push(bad('gh: authentication required', 4));
    const code = await w.run(['status', '--name', 's2']);
    expect(code).toBe(0);
    const text = w.out.join('\n');
    expect(text).toContain('已经不在跑了');
    expect(text).toContain('还没有输出');
    expect(text).toContain('PR：没查到（gh: authentication required）');
  });

  it('已经不在跑、Claude 日志最后一个事件不是 result：提示不是正常收尾（多半被掐了）；有 result 就不提示', async () => {
    const w = world();
    const dir = w.writeMeta('s2d', validMeta(w, 's2d'));
    const ev = (o: unknown) => `${JSON.stringify(o)}\n`;
    const toolUse = ev({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    });
    writeFileSync(join(dir, 'out.log'), toolUse);
    w.setRunning(9001, false);
    w.ghReplies.push(ok('[]'));
    await w.run(['status', '--name', 's2d']);
    expect(w.out.join('\n')).toContain('日志停在半截、没有 result 事件');

    writeFileSync(join(dir, 'out.log'), toolUse + ev({ type: 'result', result: '完成：PR #1' }));
    w.ghReplies.push(ok('[]'));
    w.out.length = 0;
    await w.run(['status', '--name', 's2d']);
    expect(w.out.join('\n')).not.toContain('没有 result 事件');

    // 在跑的、别家模型的普通文字日志：都不提示
    writeFileSync(join(dir, 'out.log'), toolUse);
    w.setRunning(9001, true);
    w.ghReplies.push(ok('[]'));
    w.out.length = 0;
    await w.run(['status', '--name', 's2d']);
    expect(w.out.join('\n')).not.toContain('没有 result 事件');
    expect(lib.noResultEvent(['plain text', 'more'])).toBe(false);
  });

  it('kimi 的记录（理论上不会 start 出来，但 status 要认得）：档位标「不支持」', async () => {
    const w = world();
    w.writeMeta('s2b', validMeta(w, 's2b', { model: 'kimi', effort: 'high' }));
    w.setRunning(9001, false);
    w.ghReplies.push(ok('[]'));
    await w.run(['status', '--name', 's2b']);
    expect(w.out.join('\n')).toContain('档位 不支持');
  });

  it('pidUncertain 的记录：报「不确定在跑没跑」，不调 io.isRunning（没有真 pid 可查）', async () => {
    const w = world();
    w.writeMeta(
      's2c',
      validMeta(w, 's2c', { pid: null, pidUncertain: true, pidUncertainWhy: '没读到 launch-result.json' }),
    );
    w.ghReplies.push(ok('[]'));
    const code = await w.run(['status', '--name', 's2c']);
    expect(code).toBe(0);
    const text = w.out.join('\n');
    expect(text).toContain('不确定在跑没跑');
    expect(text).toContain('没读到 launch-result.json');
    expect(text).not.toContain('pid null'); // 不确定时不打 pid
  });

  it('【故意造出的失败】meta.json 不存在：明确失败，退出码 2', async () => {
    const w = world();
    const code = await w.run(['status', '--name', 'nope']);
    expect(code).toBe(2);
    expect(w.out.join('\n')).toContain('没查成');
    expect(w.out.join('\n')).toContain('没有记录');
  });

  it('【故意造出的失败】meta.json 不是 JSON、缺字段：都明确失败，退出码 2，不当成没在跑', async () => {
    const w = world();
    const dir = join(w.home, '.fleet-dao', 'workers', 'broken1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), '{not json');
    expect(await w.run(['status', '--name', 'broken1'])).toBe(2);
    expect(w.out.join('\n')).toContain('不是 JSON');

    const partial = validMeta(w, 'broken2') as Record<string, unknown>;
    delete partial.pid;
    w.writeMeta('broken2', partial);
    expect(await w.run(['status', '--name', 'broken2'])).toBe(2);
    expect(w.out.at(-1)).toContain('pid 认不出');
  });

  it('【故意造出的失败】pidUncertain 的 meta 形状不对：两种坏法都明确失败，退出码 2', async () => {
    const w = world();
    // 坏法一：pidUncertain=true 却带了个真 pid（应该是 null）
    w.writeMeta('broken3', { ...validMeta(w, 'broken3'), pidUncertain: true, pidUncertainWhy: '随便' });
    expect(await w.run(['status', '--name', 'broken3'])).toBe(2);
    expect(w.out.at(-1)).toContain('pidUncertain 时 pid 应该是 null');

    // 坏法二：pidUncertain=true、pid 也是 null，但没给 pidUncertainWhy
    const broken4 = validMeta(w, 'broken4', { pid: null, pidUncertain: true }) as Record<string, unknown>;
    delete broken4.pidUncertainWhy;
    w.writeMeta('broken4', broken4);
    expect(await w.run(['status', '--name', 'broken4'])).toBe(2);
    expect(w.out.at(-1)).toContain('pidUncertainWhy 认不出');
  });

  it('不带 --name：列出全部工人；有一个坏的照样往下走，整体退出码 2；一个都没有就说清楚、退出码 0', async () => {
    const w = world();
    expect(await w.run(['status'])).toBe(0);
    expect(w.out.join('\n')).toContain('没有起过任何工人');

    w.out.length = 0;
    w.writeMeta('good', validMeta(w, 'good'));
    const badDir = join(w.home, '.fleet-dao', 'workers', 'bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'meta.json'), '{not json');
    w.setRunning(9001, true);
    w.ghReplies.push(ok('[]'));
    const code = await w.run(['status']);
    expect(code).toBe(2);
    const text = w.out.join('\n');
    expect(text).toContain('good：');
    expect(text).toContain('bad：没查成');
  });
});

describe('stop', () => {
  it('在跑：杀整棵进程树；已经不在跑了：不算失败，照实说', async () => {
    const w = world();
    w.writeMeta('t1', validMeta(w, 't1'));
    w.setRunning(9001, true);
    w.killReplies.push({ ok: true });
    expect(await w.run(['stop', '--name', 't1'])).toBe(0);
    expect(w.killed).toEqual([9001]);
    expect(w.out.at(-1)).toContain('停了');

    w.out.length = 0;
    expect(await w.run(['stop', '--name', 't1'])).toBe(0); // killTree 已经把 running 里的 9001 删了
    expect(w.out.at(-1)).toContain('已经不在跑了');
    expect(w.killed).toEqual([9001]); // 没有再调一次 killTree
  });

  it('【故意造出的失败】meta 缺失：退出码 2；killTree 本身失败：退出码 2、带原因', async () => {
    const w = world();
    expect(await w.run(['stop', '--name', 'nope'])).toBe(2);

    w.writeMeta('t2', validMeta(w, 't2'));
    w.setRunning(9001, true);
    w.killReplies.push({ ok: false, why: 'taskkill 退出码 128：没有权限' });
    expect(await w.run(['stop', '--name', 't2'])).toBe(2);
    expect(w.err.at(-1)).toContain('没有权限');
  });

  it('【故意造出的失败】--name 里带路径穿越：退出码 1，不碰文件系统', async () => {
    const w = world();
    expect(await w.run(['stop', '--name', '../../evil'])).toBe(1);
  });

  it('【故意造出的失败】pidUncertain：没有真 pid 可杀，明确拒绝、不碰 killTree', async () => {
    const w = world();
    w.writeMeta(
      't3',
      validMeta(w, 't3', { pid: null, pidUncertain: true, pidUncertainWhy: '没读到 launch-result.json' }),
    );
    const code = await w.run(['stop', '--name', 't3']);
    expect(code).toBe(2);
    expect(w.err.at(-1)).toContain('没记上 pid');
    expect(w.err.at(-1)).toContain('手动结束');
    expect(w.killed).toEqual([]);
  });
});

describe('clean', () => {
  it('PR 合了：删工作树、删本地分支，meta.json 记 cleanedAt，日志留着', async () => {
    const w = world();
    const dir = w.writeMeta('c1', validMeta(w, 'c1'));
    writeFileSync(join(dir, 'out.log'), 'log content');
    w.setRunning(9001, false);
    w.ghReplies.push(ok(JSON.stringify([{ number: 1, state: 'MERGED', url: 'https://x/1' }])));
    w.gitReplies.push(ok(), ok());

    const code = await w.run(['clean', '--name', 'c1']);
    expect(code).toBe(0);
    expect(w.gitCalls).toEqual([
      { args: ['worktree', 'remove', join(w.repo, '.claude', 'worktrees', 'w-c1'), '--force'], cwd: w.repo },
      { args: ['branch', '-D', 'w/c1'], cwd: w.repo },
    ]);
    expect(w.meta('c1').cleanedAt).toBe(NOW.toISOString());
    expect(readFileSync(join(dir, 'out.log'), 'utf8')).toBe('log content'); // 日志留着
  });

  it('--force：跳过 PR 检查，直接删', async () => {
    const w = world();
    w.writeMeta('c2', validMeta(w, 'c2'));
    w.setRunning(9001, false);
    w.gitReplies.push(ok(), ok());
    expect(await w.run(['clean', '--name', 'c2', '--force'])).toBe(0);
    expect(w.ghCalls).toEqual([]);
  });

  it('【故意造出的失败】PR 没合也没关（还开着）、不带 --force：拒绝，退出码 3，不碰 git', async () => {
    const w = world();
    w.writeMeta('c3', validMeta(w, 'c3'));
    w.setRunning(9001, false);
    w.ghReplies.push(ok(JSON.stringify([{ number: 2, state: 'OPEN', url: 'https://x/2' }])));
    const code = await w.run(['clean', '--name', 'c3']);
    expect(code).toBe(3);
    expect(w.err.at(-1)).toContain('还开着、没合也没关');
    expect(w.gitCalls).toEqual([]);
  });

  it('【故意造出的失败】没找到 PR（比如 --no-ship 冒烟，从没开过）、不带 --force：拒绝，退出码 3', async () => {
    const w = world();
    w.writeMeta('c4', validMeta(w, 'c4', { noShip: true }));
    w.setRunning(9001, false);
    w.ghReplies.push(ok('[]'));
    const code = await w.run(['clean', '--name', 'c4']);
    expect(code).toBe(3);
    expect(w.err.at(-1)).toContain('没找到分支');
    expect(w.err.at(-1)).toContain('--force');
  });

  it('【故意造出的失败】PR 状态查不到：不敢删，退出码 2', async () => {
    const w = world();
    w.writeMeta('c5', validMeta(w, 'c5'));
    w.setRunning(9001, false);
    w.ghReplies.push(bad('HTTP 502', 1));
    const code = await w.run(['clean', '--name', 'c5']);
    expect(code).toBe(2);
    expect(w.err.at(-1)).toContain('不敢删');
    expect(w.gitCalls).toEqual([]);
  });

  it('【故意造出的失败】还在跑：拒绝，退出码 3，叫先 stop', async () => {
    const w = world();
    w.writeMeta('c6', validMeta(w, 'c6'));
    w.setRunning(9001, true);
    const code = await w.run(['clean', '--name', 'c6']);
    expect(code).toBe(3);
    expect(w.err.at(-1)).toContain('还在跑');
    expect(w.err.at(-1)).toContain('先 node worker.mjs stop');
    expect(w.ghCalls).toEqual([]);
  });

  it('【故意造出的失败】meta 缺失：退出码 2', async () => {
    const w = world();
    expect(await w.run(['clean', '--name', 'nope'])).toBe(2);
  });

  it('【故意造出的失败】worktree remove 没成：退出码 2；remove 成了但 branch -D 没成：也退出码 2、说明工作树已经删了', async () => {
    const w = world();
    w.writeMeta('c7', validMeta(w, 'c7'));
    w.setRunning(9001, false);
    w.gitReplies.push(bad('worktree is dirty'));
    expect(await w.run(['clean', '--name', 'c7', '--force'])).toBe(2);
    expect(w.err.at(-1)).toContain('git worktree remove 没成');

    w.writeMeta('c8', validMeta(w, 'c8', { pid: 9002 }));
    w.gitReplies.push(ok(), bad('branch is checked out somewhere'));
    expect(await w.run(['clean', '--name', 'c8', '--force'])).toBe(2);
    expect(w.err.at(-1)).toContain('工作树删了，但分支');
  });

  it('【故意造出的失败】pidUncertain 不带 --force：不敢删，退出码 3', async () => {
    const w = world();
    w.writeMeta(
      'c9',
      validMeta(w, 'c9', { pid: null, pidUncertain: true, pidUncertainWhy: '没读到 launch-result.json' }),
    );
    const code = await w.run(['clean', '--name', 'c9']);
    expect(code).toBe(3);
    expect(w.err.at(-1)).toContain('没记上 pid');
    expect(w.err.at(-1)).toContain('--force');
    expect(w.gitCalls).toEqual([]);
  });

  it('pidUncertain 带 --force：照样能删（跳过 isRunning 检查，因为没有真 pid）', async () => {
    const w = world();
    w.writeMeta(
      'c10',
      validMeta(w, 'c10', { pid: null, pidUncertain: true, pidUncertainWhy: '没读到 launch-result.json' }),
    );
    w.gitReplies.push(ok(), ok());
    const code = await w.run(['clean', '--name', 'c10', '--force']);
    expect(code).toBe(0);
    expect(w.gitCalls).toHaveLength(2);
  });
});

// #1016：Claude 工人边做边出日志（stream-json），status 要把事件翻成人话——第一件真活时中途只能报「还没有输出」
describe('工人的输出在说什么（saidOf）', () => {
  const ev = (o: unknown) => JSON.stringify(o);

  it('普通文字（grok、codex 的输出）：原样', () => {
    expect(lib.saidOf('完成：PR #12')).toBe('完成：PR #12');
  });

  it('在调工具：说出工具名和命令（截到 80 字）', () => {
    const line = ev({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm   test:changed' } }] },
    });
    expect(lib.saidOf(line)).toBe('在调 Bash：pnpm test:changed');
  });

  it('说了话：取最后一行；最后的结论（result 事件）也取最后一行——「完成：PR #号」靠它认', () => {
    expect(
      lib.saidOf(
        ev({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '先看类型错误。\n共 5 处。' }] },
        }),
      ),
    ).toBe('共 5 处。');
    expect(lib.saidOf(ev({ type: 'result', result: 'PR 已合并。\n\n完成：PR #1022' }))).toBe(
      '完成：PR #1022',
    );
  });

  it('【故意造出的失败】认不出的事件（system、工具结果）：返回 null，不拿事件原文冒充一句话', () => {
    expect(lib.saidOf(ev({ type: 'system', subtype: 'init' }))).toBeNull();
    expect(
      lib.saidOf(ev({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })),
    ).toBeNull();
    expect(lib.saidOf(ev({ type: 'result', result: 42 }))).toBeNull();
  });

  it('恰好以 { 开头、但不是 JSON 的普通文字：原样', () => {
    expect(lib.saidOf('{ 这不是 JSON')).toBe('{ 这不是 JSON');
  });
});

// #1016：巡看只说变了的——给定时叫起的巡看会话用，创始人不用来问进度
describe('watch', () => {
  const pr = (state: string) =>
    ok(JSON.stringify([{ number: 88, state, url: 'https://github.com/o/r/pull/88' }]));

  it('第一次见到在跑的工人报一行；状态没变再看就只剩「还在跑：1」', async () => {
    const w = world();
    const dir = w.writeMeta('k1', validMeta(w, 'k1'));
    writeFileSync(join(dir, 'out.log'), '在改 store\n');
    w.setRunning(9001, true);
    w.ghReplies.push(ok('[]'), ok('[]'));
    expect(await w.run(['watch'])).toBe(0);
    expect(w.out.join('\n')).toMatch(/变化：k1 在跑（.*）：在改 store\n还在跑：1$/);
    w.out.length = 0;
    expect(await w.run(['watch'])).toBe(0);
    expect(w.out).toEqual(['还在跑：1']);
  });

  it('PR 开出来、做完，各报一次：报过的不重报', async () => {
    const w = world();
    const dir = w.writeMeta('k2', validMeta(w, 'k2'));
    writeFileSync(join(dir, 'out.log'), '在改 store\n');
    w.setRunning(9001, true);
    w.ghReplies.push(ok('[]'), pr('OPEN'), pr('MERGED'), pr('MERGED'));
    await w.run(['watch']);
    w.out.length = 0;
    await w.run(['watch']);
    expect(w.out.join('\n')).toMatch(/变化：k2 在跑.*PR #88（OPEN）/);
    w.out.length = 0;
    writeFileSync(join(dir, 'out.log'), '在改 store\n完成：PR #88\n');
    w.setRunning(9001, false);
    await w.run(['watch']);
    expect(w.out).toEqual(['变化：k2 做完了：完成：PR #88；PR #88（MERGED）', '还在跑：0']);
    w.out.length = 0;
    await w.run(['watch']);
    expect(w.out).toEqual(['还在跑：0']);
  });

  it('【故意造出的失败】被强杀、没交活：报「不在跑了、也没交活」，不当成做完', async () => {
    const w = world();
    const dir = w.writeMeta('k3', validMeta(w, 'k3'));
    writeFileSync(join(dir, 'out.log'), '改到一半\n');
    w.setRunning(9001, false);
    w.ghReplies.push(ok('[]'));
    await w.run(['watch']);
    expect(w.out[0]).toBe('变化：k3 不在跑了、也没交活，最后一句：改到一半');
  });

  it('自己说卡住了：报卡在哪', async () => {
    const w = world();
    const dir = w.writeMeta('k4', validMeta(w, 'k4'));
    writeFileSync(join(dir, 'out.log'), '卡住：人闸——要删表\n');
    w.setRunning(9001, false);
    w.ghReplies.push(ok('[]'));
    await w.run(['watch']);
    expect(w.out[0]).toBe('变化：k4 卡住了：卡住：人闸——要删表');
  });

  it('clean 过的不看；一个工人都没有也给「还在跑：0」', async () => {
    const w = world();
    expect(await w.run(['watch'])).toBe(0);
    expect(w.out).toEqual(['还在跑：0']);
    w.out.length = 0;
    w.writeMeta('k5', validMeta(w, 'k5', { cleanedAt: '2026-10-05T00:00:00.000Z' }));
    w.setRunning(9001, false);
    w.ghReplies.push(ok('[]'));
    await w.run(['watch']);
    expect(w.out).toEqual(['还在跑：0']);
  });

  it('【故意造出的失败】记录读不了：报没查成、退出码 2，不当成没有工人', async () => {
    const w = world();
    const dir = join(w.home, '.fleet-dao', 'workers', 'k6');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), '{不是 JSON');
    expect(await w.run(['watch'])).toBe(2);
    expect(w.out[0]).toMatch(/^变化：k6：没查成——/);
  });
});

// 创始人 2026-10-05：进度只在当前会话里报——指挥官循环 watch --wait，没变化就等、有变化马上返回
describe('watch --wait', () => {
  it('没变化：等到点才返回「还在跑：1」，中间隔一会儿看一次（不是只看一次就傻等）', async () => {
    const w = world();
    const dir = w.writeMeta('q1', validMeta(w, 'q1'));
    writeFileSync(join(dir, 'out.log'), '在改 store\n');
    w.setRunning(9001, true);
    for (let i = 0; i < 12; i += 1) w.ghReplies.push(ok('[]'));
    await w.run(['watch']); // 先报过一次
    w.out.length = 0;
    const before = w.ghCalls.length;
    expect(await w.run(['watch', '--wait', '30'])).toBe(0);
    expect(w.out).toEqual(['还在跑：1']);
    expect(w.ghCalls.length - before).toBeGreaterThan(2);
  });

  it('等的中间工人做完了：马上返回那一行，不等到点', async () => {
    const w = world();
    const dir = w.writeMeta('q2', validMeta(w, 'q2'));
    writeFileSync(join(dir, 'out.log'), '在改 store\n');
    w.setRunning(9001, true);
    for (let i = 0; i < 12; i += 1) w.ghReplies.push(ok('[]'));
    await w.run(['watch']);
    w.out.length = 0;
    const realSleep = w.io.sleep;
    let naps = 0;
    w.io.sleep = async (ms: number) => {
      naps += 1;
      writeFileSync(join(dir, 'out.log'), '在改 store\n完成：PR #7\n');
      w.setRunning(9001, false);
      await realSleep(ms);
    };
    expect(await w.run(['watch', '--wait', '55'])).toBe(0);
    expect(w.out).toEqual(['变化：q2 做完了：完成：PR #7', '还在跑：0']);
    expect(naps).toBe(1);
  });

  // 2026-10-05 实测：5 个工人时 --wait 20 到 --wait 45 多次跑了 58 秒以上被前台上限掐掉——看一遍要逐个调 gh，
  // --wait 只管「睡」不管「看」，第一遍多久都得跑完。这里拿真定时器的假钟：gh 每次 15 秒
  describe('gh 慢的时候整条命令也不超过 --wait 加一点余量', () => {
    const GH_MS = 15_000;
    const NAMES = ['s1', 's2', 's3', 's4', 's5'];
    const slowWorld = (ghAsync: NonNullable<WorkerIo['ghAsync']>) => {
      const w = world();
      for (const n of NAMES) {
        const dir = w.writeMeta(n, validMeta(w, n));
        writeFileSync(join(dir, 'out.log'), '在改 store\n');
      }
      w.setRunning(9001, true);
      w.io.now = () => new Date();
      w.io.sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // 一次一次排着等的老办法：每次把钟拨过 15 秒
      w.io.gh = () => {
        vi.advanceTimersByTime(GH_MS);
        return ok('[]');
      };
      w.io.ghAsync = ghAsync;
      return w;
    };
    /** 跑一条 watch，量它在假钟上花了多久 */
    const timed = async (w: ReturnType<typeof world>, argv: string[]) => {
      const start = Date.now();
      let end = Number.NaN;
      const p = w.run(argv).then((code) => {
        end = Date.now();
        return code;
      });
      await vi.advanceTimersByTimeAsync(180_000);
      return { code: await p, ms: end - start };
    };
    const aborted = (): RunResult => ({ status: null, stdout: '', stderr: '', error: 'ABORT_ERR' });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('【故意造出的失败】gh 每次 15 秒、5 个工人、--wait 20：到点返回，没查成的工人逐个明说', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const w = slowWorld(
        (_args, opts) =>
          new Promise((resolve) => {
            const limit = opts?.timeoutMs ?? Number.POSITIVE_INFINITY;
            if (limit >= GH_MS) {
              setTimeout(() => resolve(ok('[]')), GH_MS);
              return;
            }
            const t = setTimeout(
              () => resolve({ status: null, stdout: '', stderr: '', error: 'ETIMEDOUT' }),
              limit,
            );
            opts?.signal?.addEventListener('abort', () => {
              clearTimeout(t);
              resolve(aborted());
            });
          }),
      );
      const { code, ms } = await timed(w, ['watch', '--wait', '20']);
      expect(ms).toBeLessThanOrEqual(20_000 + lib.WATCH_SLACK_MS);
      expect(code).toBe(2);
      for (const n of NAMES) expect(w.out.join('\n')).toMatch(new RegExp(`没查成：${n} 的 PR`));
      expect(w.out.at(-1)).toBe('还在跑：5');
    });

    it('【故意造出的失败】gh 卡死不回话：总截止一到就返回，没回来的明说没查成', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const w = slowWorld(
        (_args, opts) =>
          new Promise((resolve) => {
            opts?.signal?.addEventListener('abort', () => resolve(aborted()));
          }),
      );
      const { code, ms } = await timed(w, ['watch', '--wait', '20']);
      expect(ms).toBeLessThanOrEqual(20_000 + lib.WATCH_SLACK_MS);
      expect(code).toBe(2);
      for (const n of NAMES) expect(w.out.join('\n')).toMatch(new RegExp(`没查成：${n} 的 PR`));
    });

    it('gh 快：照旧隔一会儿看一次，等到点才返回「还在跑：5」', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      let calls = 0;
      const w = slowWorld(
        () =>
          new Promise((resolve) => {
            calls += 1;
            setTimeout(() => resolve(ok('[]')), 1_000);
          }),
      );
      await timed(w, ['watch']); // 先报过一次
      w.out.length = 0;
      calls = 0;
      const { code, ms } = await timed(w, ['watch', '--wait', '20']);
      expect(code).toBe(0);
      expect(w.out).toEqual(['还在跑：5']);
      expect(ms).toBeGreaterThanOrEqual(20_000);
      expect(ms).toBeLessThanOrEqual(20_000 + lib.WATCH_SLACK_MS);
      expect(calls).toBeGreaterThan(NAMES.length * 2);
    });
  });

  it('【故意造出的失败】--wait 超过 55 秒、不是整数：用法错，退出码 1（单次前台等待不许超过 60 秒）', async () => {
    for (const bad of ['56', '600', 'abc', '-1', '1.5']) {
      const w = world();
      expect(await w.run(['watch', '--wait', bad]), bad).toBe(1);
    }
  });
});

// #1066：status 看得到外壳续跑了几次；watch 在日志 4 分钟没动时报「停住」；--until-change 给后台长等用
describe('status / watch：续跑次数、停住、--until-change', () => {
  const stale = (file: string, minutesAgo: number) => {
    const t = new Date(Date.now() - minutesAgo * 60_000);
    utimesSync(file, t, t);
  };
  const quiet = (w: ReturnType<typeof world>, name: string, minutesAgo: number, last = '在等测试跑完') => {
    const dir = w.writeMeta(name, validMeta(w, name));
    const log = join(dir, 'out.log');
    writeFileSync(log, `${last}\n`);
    stale(log, minutesAgo);
    return { dir, log };
  };

  it('status：外壳续跑过就写出续了几次；没续过不提', async () => {
    const w = world();
    w.writeMeta('r1', validMeta(w, 'r1', { resumes: 2 }));
    w.writeMeta('r2', validMeta(w, 'r2'));
    w.setRunning(9001, true);
    w.ghReplies.push(ok('[]'), ok('[]'));
    await w.run(['status', '--name', 'r1']);
    await w.run(['status', '--name', 'r2']);
    expect(w.out[0]).toContain('网关掉线后自动续跑了 2 次');
    expect(w.out[1]).not.toContain('续跑');
  });

  it('【故意造出的失败】meta 里 resumes 不是非负整数：认不出，明说没查成', async () => {
    const w = world();
    w.writeMeta('r3', validMeta(w, 'r3', { resumes: 'many' }));
    expect(await w.run(['status', '--name', 'r3'])).toBe(2);
    expect(w.out.join('\n')).toContain('resumes 认不出');
  });

  it('watch：在跑、没交活、日志 4 分钟没动：变化行明说「停住 N 分钟：最后在等 …」，报过不重报；3 分钟不算', async () => {
    const w = world();
    quiet(w, 'p1', 5);
    w.setRunning(9001, true);
    w.ghReplies.push(ok('[]'), ok('[]'));
    expect(await w.run(['watch'])).toBe(0);
    expect(w.out).toEqual(['变化：p1 停住 5 分钟：最后在等 在等测试跑完', '还在跑：1']);
    w.out.length = 0;
    await w.run(['watch']);
    expect(w.out).toEqual(['还在跑：1']);
    const w2 = world();
    quiet(w2, 'p2', 3);
    w2.setRunning(9001, true);
    w2.ghReplies.push(ok('[]'));
    await w2.run(['watch']);
    expect(w2.out[0]).toMatch(/^变化：p2 在跑/);
  });

  it('watch：停到 30 分钟另报一次「卡住」（原来的那条保留）', async () => {
    const w = world();
    const { log } = quiet(w, 'p3', 5);
    w.setRunning(9001, true);
    w.ghReplies.push(ok('[]'), ok('[]'));
    await w.run(['watch']);
    w.out.length = 0;
    stale(log, 31);
    await w.run(['watch']);
    expect(w.out[0]).toBe('变化：p3 还在跑，但 31 分钟没动静，最后在：在等测试跑完');
  });

  it('watch：最后一句已经是「完成：」的在跑工人不报停住（马上就退出了）', async () => {
    const w = world();
    quiet(w, 'p4', 6, '完成：PR #9');
    w.setRunning(9001, true);
    w.ghReplies.push(ok('[]'));
    await w.run(['watch']);
    expect(w.out[0]).toMatch(/^变化：p4 在跑/);
  });

  it('watch：外壳续跑次数变了也算变化，会报给指挥官', async () => {
    const w = world();
    const { dir } = quiet(w, 'p5', 0);
    w.setRunning(9001, true);
    w.ghReplies.push(ok('[]'), ok('[]'));
    await w.run(['watch']);
    w.out.length = 0;
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(validMeta(w, 'p5', { resumes: 1 })));
    await w.run(['watch']);
    expect(w.out[0]).toContain('网关掉线后自动续跑了 1 次');
  });

  it('watch --until-change：不给 --wait 也行，没变化一直等；等的中间有变化马上返回（远超 55 秒也不被截断）', async () => {
    const w = world();
    const { dir } = quiet(w, 'u1', 0, '在改 store');
    w.setRunning(9001, true);
    for (let i = 0; i < 100; i += 1) w.ghReplies.push(ok('[]'));
    await w.run(['watch']); // 先报过一次
    w.out.length = 0;
    const realSleep = w.io.sleep;
    let naps = 0;
    w.io.sleep = async (ms: number) => {
      naps += 1;
      if (naps === 25) {
        writeFileSync(join(dir, 'out.log'), '在改 store\n完成：PR #7\n');
        w.setRunning(9001, false);
      }
      await realSleep(ms);
    };
    expect(await w.run(['watch', '--until-change'])).toBe(0);
    expect(w.out).toEqual(['变化：u1 做完了：完成：PR #7', '还在跑：0']);
    expect(naps).toBe(25); // 25 个 10 秒，远超 55 秒
  });

  it('watch --until-change --wait 120：没变化等满 120 秒就返回「还在跑：1」', async () => {
    const w = world();
    quiet(w, 'u2', 0, '在改 store');
    w.setRunning(9001, true);
    for (let i = 0; i < 100; i += 1) w.ghReplies.push(ok('[]'));
    await w.run(['watch']);
    w.out.length = 0;
    const t0 = w.io.now().getTime();
    expect(await w.run(['watch', '--until-change', '--wait', '120'])).toBe(0);
    expect(w.out).toEqual(['还在跑：1']);
    expect(w.io.now().getTime() - t0).toBeGreaterThanOrEqual(120_000);
  });

  it('【故意造出的失败】--until-change 的 --wait 超过 600 或不是整数：用法错；不带 --until-change 超过 55 照旧用法错', async () => {
    for (const bad of ['601', 'abc', '-1']) {
      expect(await world().run(['watch', '--until-change', '--wait', bad]), bad).toBe(1);
    }
    const w = world();
    expect(await w.run(['watch', '--wait', '56'])).toBe(1);
    expect(w.err.join('\n')).toContain('--until-change');
  });
});
