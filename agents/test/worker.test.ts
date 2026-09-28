// 帅位「开别家模型的会话去干活」的启动器（worker-lib.mjs）：git/gh/pnpm/spawn/进程查杀全部注入假的，
// home、brief 文件、prompt.txt、meta.json 用真的临时目录（和 seat-claim.test.ts 一个路数）。
// 每条失败路径都故意造一遍：工作树已存在、不认识的模型、pnpm install 失败、meta 缺失或损坏、clean 时 PR 没合没关——
// 都要明说、非 0 退出，不当成没事。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(new URL('../skills/commander-seat/scripts/', import.meta.url));
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
interface WorkerIo {
  env: Record<string, string | undefined>;
  home: string;
  now: () => Date;
  cwd: () => string;
  git: (args: string[], opts?: { cwd?: string }) => RunResult;
  gh: (args: string[], opts?: { cwd?: string }) => RunResult;
  pnpm: (args: string[], opts?: { cwd?: string }) => RunResult;
  spawnDetached: (spec: SpawnSpec) => { pid: number };
  isRunning: (pid: number) => boolean;
  killTree: (pid: number) => { ok: boolean; why?: string };
  out: (text: string) => void;
  err: (text: string) => void;
}
interface WorkerLib {
  USAGE: string;
  EFFORTS: string[];
  DEFAULT_EFFORT: string;
  GITHUB_HOSTS: string[];
  KIMI_UNSUPPORTED: string;
  mergeNoProxy(env: Record<string, string | undefined>): Record<string, string | undefined>;
  closingBrief(o: { branch: string; noShip: boolean }): string;
  runWorker(argv: string[], io: WorkerIo): Promise<number>;
}

const lib = (await import(pathToFileURL(join(SCRIPTS, 'worker-lib.mjs')).href)) as WorkerLib;
interface WindowsQuote {
  windowsQuoteArg(arg: string): string;
  windowsCmdLine(command: string, args: string[]): string;
}
// worker.mjs 顶层直接跑 runWorker（真的读 argv、真的起子进程），不能直接 import 来测；这两个函数单独放在
// windows-quote.mjs 就是为了能在这里安全 import。
const winQuote = (await import(pathToFileURL(join(SCRIPTS, 'windows-quote.mjs')).href)) as WindowsQuote;

const ok = (stdout = ''): RunResult => ({ status: 0, stdout, stderr: '' });
const bad = (stderr: string, status = 1): RunResult => ({ status, stdout: '', stderr });
/** 取数组第一项、明确它在——比非空断言（!）更安全，比每处都 ?. 更看得清是「就该有一个」。 */
function must<T>(v: T | undefined, msg: string): T {
  if (v === undefined) throw new Error(msg);
  return v;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** repo 是一个真实存在的临时目录（不是 git 仓，git/gh/pnpm 全是假的），worktreeDir 是它的兄弟目录 fd-w-<name>。 */
function world() {
  const home = mkdtempSync(join(tmpdir(), 'fleet-worker-home-'));
  const parent = mkdtempSync(join(tmpdir(), 'fleet-worker-parent-'));
  dirs.push(home, parent);
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
    env: { SOME_VAR: '1' },
    home,
    now: () => new Date(clock),
    cwd: () => repo,
    git: (args, opts) => {
      gitCalls.push({ args, cwd: opts?.cwd });
      return takeReply(gitReplies, `git（${gitCalls.length}：${args.join(' ')}）`);
    },
    gh: (args, opts) => {
      ghCalls.push({ args, cwd: opts?.cwd });
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
    run: (argv: string[]) => lib.runWorker(argv, io),
  };
}

/** start 的一份合格 meta：clean/status/stop 的用例不走 start，直接手写一份，省得每次都跑一遍 start 的六步。 */
function validMeta(w: ReturnType<typeof world>, name: string, over: Record<string, unknown> = {}) {
  const worktree = join(w.parent, `fd-w-${name}`);
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
    w.gitReplies.push(ok('true'), ok(''), ok(''), ok(''));
    w.pnpmReplies.push(ok('已经装好了'));
    w.spawnReplies.push({ pid: 4242 });

    const code = await w.run(['start', '--model', 'grok', '--name', 'w1', '--brief', briefFile]);

    expect(code).toBe(0);
    const worktreeDir = join(w.parent, 'fd-w-w1');
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
    ]);
    expect(spec.cwd).toBe(worktreeDir);
    expect(spec.stdinFile).toBeNull();
    expect(spec.env.NO_PROXY).toContain('github.com');
    expect(spec.env.SOME_VAR).toBe('1'); // 原有的环境变量原样带过去

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
    expect(prompt).toContain('gh pr create');
    expect(w.out.join('\n')).toContain('pid 4242');
    expect(w.out.join('\n')).toContain('档位 high');
  });

  it('codex：prompt 走标准输入描述符（不是命令行参数），带 --dangerously-bypass-approvals-and-sandbox 和思考档位；--no-ship 换收尾交代；--model-id 透传', async () => {
    const w = world();
    const briefFile = brief(w);
    w.gitReplies.push(ok('true'), ok(''), ok(''), ok(''));
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
    const worktreeDir = join(w.parent, 'fd-w-w2');
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
    const meta = w.meta('w2');
    expect(meta.modelId).toBe('gpt-5.6-luna');
    expect(meta.effort).toBe('low');
    expect(meta.noShip).toBe(true);
    const prompt = w.prompt('w2');
    expect(prompt).toContain('冒烟测试');
    expect(prompt).not.toContain('gh pr create');
  });

  it('--effort 不给就是 high，且总是显式传给命令行', async () => {
    const w = world();
    w.gitReplies.push(ok('true'), ok(''), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    w.spawnReplies.push({ pid: 1 });
    await w.run(['start', '--model', 'grok', '--name', 'w3', '--brief', brief(w)]);
    expect(w.spawnCalls).toHaveLength(1);
    const spec = must(w.spawnCalls[0], '没有 spawnCalls[0]');
    expect(spec.args).toEqual(expect.arrayContaining(['--reasoning-effort', 'high']));
    expect(w.meta('w3').effort).toBe('high');
  });
});

describe('start：【故意造出的失败】', () => {
  it('工作树已经存在：拒绝，退出码 3，不跑 git fetch/worktree add', async () => {
    const w = world();
    mkdirSync(join(w.parent, 'fd-w-dup'), { recursive: true }); // 提前占好目录，模拟已经有一棵工作树
    const code = await w.run(['start', '--model', 'grok', '--name', 'dup', '--brief', brief(w)]);
    expect(code).toBe(3);
    expect(w.err.join('\n')).toContain('工作树已经存在');
    expect(w.gitCalls).toEqual([]); // 本地 fs 检查在问 git 之前就短路，不该碰一次 git
  });

  it('git worktree list 里已经有这个分支：拒绝，退出码 3', async () => {
    const w = world();
    w.gitReplies.push(
      ok('true'),
      ok(
        `worktree ${w.repo}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${join(w.parent, 'fd-w-dup2')}\nHEAD def\nbranch refs/heads/w/dup2\n`,
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
    w.gitReplies.push(ok('true'), ok(''), bad('fatal: unable to access'));
    const code = await w.run(['start', '--model', 'grok', '--name', 'w8', '--brief', brief(w)]);
    expect(code).toBe(2);
    expect(w.err.at(-1)).toContain('git fetch origin main 没成');
  });

  it('git worktree add 没成：一般失败退出码 2；说已经存在的算冲突退出码 3', async () => {
    const w = world();
    w.gitReplies.push(ok('true'), ok(''), ok(''), bad('fatal: no space left on device'));
    expect(await w.run(['start', '--model', 'grok', '--name', 'w9', '--brief', brief(w)])).toBe(2);
    expect(w.err.at(-1)).toContain('git worktree add 没成');

    w.gitReplies.push(ok('true'), ok(''), ok(''), bad("fatal: 'w/w9' already exists"));
    expect(await w.run(['start', '--model', 'grok', '--name', 'w9', '--brief', brief(w)])).toBe(3);
    expect(w.err.at(-1)).toContain('git worktree add 说已经占了');
  });

  it('pnpm install 失败：非 0 退出、说明原因，且提示工作树没删、可以 clean --force', async () => {
    const w = world();
    w.gitReplies.push(ok('true'), ok(''), ok(''), ok(''));
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
    w.gitReplies.push(ok('true'), ok(''), ok(''), ok(''));
    w.pnpmReplies.push(ok());
    w.spawnReplies.push(new Error('spawn grok ENOENT'));
    const code = await w.run(['start', '--model', 'grok', '--name', 'w11', '--brief', brief(w)]);
    expect(code).toBe(2);
    expect(w.err.at(-1)).toContain('起不了 grok');
    expect(w.err.at(-1)).toContain('spawn grok ENOENT');
    expect(w.err.at(-1)).toContain('没删');
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

  it('kimi 的记录（理论上不会 start 出来，但 status 要认得）：档位标「不支持」', async () => {
    const w = world();
    w.writeMeta('s2b', validMeta(w, 's2b', { model: 'kimi', effort: 'high' }));
    w.setRunning(9001, false);
    w.ghReplies.push(ok('[]'));
    await w.run(['status', '--name', 's2b']);
    expect(w.out.join('\n')).toContain('档位 不支持');
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
      { args: ['worktree', 'remove', join(w.parent, 'fd-w-c1'), '--force'], cwd: w.repo },
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
});
