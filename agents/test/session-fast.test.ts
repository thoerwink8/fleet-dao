// 开会话钩子拆成两半（片 B 第 8 条，2026-10-13）：原来每次开会话、Mirasim 每条消息 resume 都同步跑取远端、规矩同步、问 GitHub、
// ssh 法国，中位 27.7 秒、最长 86 秒。现在同步那半只读本地（会话所在仓的本地核对、临时调整表、引导、仓合同、他最近的话）
// 和后台上一次写下的结果；取远端、同步、gh、ssh 放进脱离的后台子进程写结果文件，下次开会话读。
// 故意造出的失败：后台某一步出错、整个崩了、结果文件坏了，都要在下次开场如实说「没查成」和原因，不吞掉、不当成没事。
// 另：备用代理写进 $CLAUDE_ENV_FILE（片 B 第 9 条），Bash 里的 gh/curl/npm 不再穿 reclaude 的 56879。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild, runChildOk } from './child.ts';
import { interactiveHookEnv } from './hook-env.ts';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: (Error & { code?: string }) | undefined;
  timeoutMs?: number;
}
type Git = (cwd: string, args: string[], opts?: unknown) => Result;
type Sync = (repo: string, home: string) => Result;
type ScriptRun = (script: string, repo: string) => Result;
type Holds = () => { ok: boolean; skipped?: boolean; value?: unknown; why?: string };
interface Common {
  cwd: string;
  home: string;
  git: Git;
  localGit?: Git;
  now?: number;
  env?: Record<string, string | undefined>;
}
interface HookLib {
  QUIET_MS: number;
  BG_LOCK_MS: number;
  gitRunner(timeoutMs?: number): Git;
  bgCachePath(home: string, cwd: string, git: Git): string;
  fastSessionStart(
    o: Common & {
      progress?: ScriptRun;
      sessionId?: string | null;
      spawnBackground?: (o: { cwd: string; home: string }) => { ok: boolean; why?: string };
    },
  ): string[];
  runBackground(
    o: Common & {
      sync: Sync;
      idlePr?: ScriptRun;
      poolHolds?: Holds;
      fallbackProxy?: string;
    },
  ): 'done' | 'busy';
}
interface ProxyLib {
  writeProxyEnv(o: {
    home: string;
    envFile: string | undefined;
    env?: Record<string, string | undefined>;
  }): string[];
  proxyEnvOf(env: Record<string, string | undefined>, proxy: string): Record<string, string | undefined>;
}

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const HOOK = join(HOOKS, 'session-start.mjs');
const hook = (await import(pathToFileURL(HOOK).href)) as HookLib;
const proxyLib = (await import(pathToFileURL(join(HOOKS, 'proxy-env.mjs')).href)) as ProxyLib;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `session-fast-${name}-`));
  made.push(dir);
  return dir;
}
const g = (cwd: string, ...a: string[]) =>
  runChildOk(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a],
    {
      cwd,
    },
  );

/** 一个裸仓当 origin，work 是这台机器上的检出 */
function world() {
  const root = temp('w');
  const origin = join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  g(root, 'clone', '-q', origin, seed);
  writeFileSync(join(seed, 'AGENTS.md'), 'v1\n');
  g(seed, 'add', '-A');
  g(seed, 'commit', '-q', '-m', 'v1');
  g(seed, 'push', '-q', 'origin', 'HEAD:main');
  const work = join(root, 'work');
  g(root, 'clone', '-q', origin, work);
  const home = join(root, 'home');
  mkdirSync(join(home, '.fleet-dao'), { recursive: true });
  return { root, origin, work, home };
}

const real = hook.gitRunner();
/** 真 git，外加记下取过几次远端 */
function countingGit() {
  const seen = { fetch: 0 };
  const git: Git = (cwd, args, opts) => {
    if (args.includes('fetch')) seen.fetch += 1;
    return (real as (c: string, a: string[], o?: unknown) => Result)(cwd, args, opts);
  };
  return { git, seen };
}
const T0 = Date.parse('2026-10-13T08:00:00Z');
const SLOW = { timeout: 0 };
const okSync = (): { sync: Sync; calls: number } => {
  const box = { calls: 0, sync: (() => ({ status: 0, stdout: '结论：改动 0\n', stderr: '' })) as Sync };
  box.sync = () => {
    box.calls += 1;
    return { status: 0, stdout: '结论：改动 0\n', stderr: '' };
  };
  return box;
};
const overdueHold: Holds = () => ({
  ok: true,
  value: {
    'claude-max': { reason: '额度', decidedBy: '创始人', revokeWhen: '恢复', reviewBy: '2026-10-01' },
  },
});

describe('同步那半只读本地', SLOW, () => {
  it('不取远端、不跑同步、不问法国；没有后台结果时起一次后台，照实说还没出结果', () => {
    const w = world();
    const { git, seen } = countingGit();
    const spawned: unknown[] = [];
    const lines = hook.fastSessionStart({
      cwd: w.work,
      home: w.home,
      git,
      now: T0,
      env: {},
      spawnBackground: (o) => {
        spawned.push(o);
        return { ok: true };
      },
    });
    expect(seen.fetch).toBe(0);
    expect(spawned).toEqual([{ cwd: w.work, home: w.home }]);
    expect(lines.join('\n')).toMatch(/还没出结果/);
    expect(lines.join('\n')).toMatch(/已在后台起查/);
    expect(lines.join('\n')).not.toMatch(/规矩同步：/);
  });

  it('后台写下的结果下次照读：同步那句、整池暂停到期；三分钟内不再起后台，过了再起', () => {
    const w = world();
    const s = okSync();
    expect(
      hook.runBackground({
        cwd: w.work,
        home: w.home,
        git: real,
        sync: s.sync,
        now: T0,
        env: {},
        poolHolds: overdueHold,
      }),
    ).toBe('done');
    expect(existsSync(hook.bgCachePath(w.home, w.work, real))).toBe(true);
    const spawned: unknown[] = [];
    const spawnBackground = (o: unknown) => {
      spawned.push(o);
      return { ok: true };
    };
    const lines = hook.fastSessionStart({
      cwd: w.work,
      home: w.home,
      git: real,
      now: T0 + 60_000,
      env: {},
      spawnBackground,
    });
    const text = lines.join('\n');
    expect(text).toMatch(/规矩同步/);
    expect(text).toMatch(/后台 1 分钟前/);
    expect(text).toMatch(/整池暂停到期：claude-max/);
    expect(spawned).toHaveLength(0);
    hook.fastSessionStart({
      cwd: w.work,
      home: w.home,
      git: real,
      now: T0 + hook.QUIET_MS + 1,
      env: {},
      spawnBackground,
    });
    expect(spawned).toHaveLength(1);
  });

  it('引导段同步跑本地查询，不吃后台缓存；用缓存的行都带「后台 N 分钟前」（#2726）', () => {
    const w = world();
    g(w.work, 'remote', 'set-url', 'origin', 'https://github.com/thoerwink8/fleet-dao.git');
    const script = join(w.work, 'packages', 'conventions', 'src', 'bin', 'progress.ts');
    mkdirSync(join(script, '..'), { recursive: true });
    writeFileSync(script, '// stub\n');
    // 后台缓存是 35 分钟前的：当时的引导还在，现在已经收掉了
    hook.runBackground({
      cwd: w.work,
      home: w.home,
      git: real,
      sync: okSync().sync,
      now: T0,
      env: {},
      poolHolds: overdueHold,
    });
    const cachePath = hook.bgCachePath(w.home, w.work, real);
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    cached.steps.progress = {
      ok: true,
      value: {
        run: {
          status: 0,
          stdout:
            '1\t【创始人引导·待处理】2026-10-14 16:00 +0800\t原话：旧缓存里的\t无主\t2026-10-14T08:00:00Z\n',
          stderr: '',
        },
        script,
        root: w.work,
      },
    };
    writeFileSync(cachePath, JSON.stringify(cached));
    const calls: string[] = [];
    const lines = hook.fastSessionStart({
      cwd: w.work,
      home: w.home,
      git: real,
      now: T0 + 35 * 60_000,
      env: {},
      spawnBackground: () => ({ ok: true }),
      progress: (s) => {
        calls.push(s);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const text = lines.join('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.replaceAll('\\', '/')).toMatch(/packages\/conventions\/src\/bin\/progress\.ts$/);
    expect(text).not.toContain('旧缓存里的');
    expect(text).not.toContain('要你拍');
    const hold = lines.find((l) => l.includes('claude-max')) ?? '';
    expect(hold).toMatch(/后台 35 分钟前/);
  });

  it('【故意造出失败】引导查询本身失败：照实说没查成，不当成没有', () => {
    const w = world();
    g(w.work, 'remote', 'set-url', 'origin', 'https://github.com/thoerwink8/fleet-dao.git');
    const script = join(w.work, 'packages', 'conventions', 'src', 'bin', 'progress.ts');
    mkdirSync(join(script, '..'), { recursive: true });
    writeFileSync(script, '// stub\n');
    const lines = hook.fastSessionStart({
      cwd: w.work,
      home: w.home,
      git: real,
      now: T0,
      env: {},
      spawnBackground: () => ({ ok: true }),
      progress: () => ({ status: 1, stdout: '', stderr: 'git 找待处理的引导报错：boom' }),
    });
    expect(lines.join('\n')).toMatch(/创始人引导（进度单 #1055）没查成/);
  });

  it('不在 git 仓里也一样：同步、整池暂停照后台的结果说', () => {
    const home = temp('home');
    const plain = temp('plain');
    hook.runBackground({
      cwd: plain,
      home,
      git: real,
      sync: okSync().sync,
      now: T0,
      env: {},
      poolHolds: overdueHold,
    });
    const text = hook
      .fastSessionStart({
        cwd: plain,
        home,
        git: real,
        now: T0,
        env: {},
        spawnBackground: () => ({ ok: true }),
      })
      .join('\n');
    expect(text).toMatch(/规矩同步/);
    expect(text).toMatch(/整池暂停到期/);
  });
});

describe('【故意造出的失败】后台没成：下次如实说没查成和原因', SLOW, () => {
  it('同步那一步抛错、法国查不成：各说一行没查成和原因，别的照报', () => {
    const w = world();
    // 记着这台的检出：同步才会走到起 agents-sync 那一步（没记过的话 syncFleet 早早就说「没跑」了）
    writeFileSync(join(w.home, '.fleet-dao', 'synced.json'), JSON.stringify({ repo: w.work }));
    const boom: Sync = () => {
      throw new Error('磁盘满了');
    };
    hook.runBackground({
      cwd: w.work,
      home: w.home,
      git: real,
      sync: boom,
      now: T0,
      env: {},
      poolHolds: () => ({ ok: false, why: '连不上法国（超时）' }),
    });
    const text = hook
      .fastSessionStart({
        cwd: w.work,
        home: w.home,
        git: real,
        now: T0,
        env: {},
        spawnBackground: () => ({ ok: true }),
      })
      .join('\n');
    expect(text).toMatch(/规矩同步没查成：后台出错（磁盘满了）/);
    expect(text).toMatch(/整池暂停没查成：连不上法国（超时）/);
  });

  it('取不到远端：下次开场说 git fetch 失败和原因，不当成规矩是最新的', () => {
    const w = world();
    rmSync(w.origin, { recursive: true, force: true });
    hook.runBackground({ cwd: w.work, home: w.home, git: real, sync: okSync().sync, now: T0, env: {} });
    const text = hook
      .fastSessionStart({
        cwd: w.work,
        home: w.home,
        git: real,
        now: T0,
        env: {},
        spawnBackground: () => ({ ok: true }),
      })
      .join('\n');
    expect(text).toMatch(/没查成：后台 git fetch 失败/);
    expect(text).toMatch(/origin\/main/);
  });

  it('结果文件坏了：明说没查成，再起一次后台', () => {
    const w = world();
    const path = hook.bgCachePath(w.home, w.work, real);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{不是 JSON');
    const spawned: unknown[] = [];
    const text = hook
      .fastSessionStart({
        cwd: w.work,
        home: w.home,
        git: real,
        now: T0,
        env: {},
        spawnBackground: (o) => {
          spawned.push(o);
          return { ok: true };
        },
      })
      .join('\n');
    expect(text).toMatch(/后台的结果读不懂/);
    expect(spawned).toHaveLength(1);
  });

  it('后台起不来：说起不来和原因', () => {
    const w = world();
    const text = hook
      .fastSessionStart({
        cwd: w.work,
        home: w.home,
        git: real,
        now: T0,
        env: {},
        spawnBackground: () => ({ ok: false, why: 'spawn EPERM' }),
      })
      .join('\n');
    expect(text).toMatch(/后台起不来（spawn EPERM）/);
    expect(text).not.toMatch(/已在后台起查/);
  });

  it('后台正在跑（锁是新的）：不起第二个；锁过期了照起', () => {
    const w = world();
    const lock = `${hook.bgCachePath(w.home, w.work, real)}.lock`;
    mkdirSync(join(lock, '..'), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: T0 }));
    const spawned: unknown[] = [];
    const spawnBackground = (o: unknown) => {
      spawned.push(o);
      return { ok: true };
    };
    hook.fastSessionStart({ cwd: w.work, home: w.home, git: real, now: T0 + 1000, env: {}, spawnBackground });
    expect(spawned).toHaveLength(0);
    expect(
      hook.runBackground({
        cwd: w.work,
        home: w.home,
        git: real,
        sync: okSync().sync,
        now: T0 + 1000,
        env: {},
      }),
    ).toBe('busy');
    hook.fastSessionStart({
      cwd: w.work,
      home: w.home,
      git: real,
      now: T0 + hook.BG_LOCK_MS + 1,
      env: {},
      spawnBackground,
    });
    expect(spawned).toHaveLength(1);
  });
});

describe('命令行外壳：同步那半起脱离的后台，后台写完下次读到', SLOW, () => {
  it('第一次说还没出结果；后台写完结果，第二次说出同步那句', () => {
    const home = temp('home');
    const cwd = temp('plain');
    const run = () =>
      runChild(process.execPath, [HOOK], {
        input: JSON.stringify({ hook_event_name: 'SessionStart', cwd }),
        cwd: temp('cwd'),
        env: {
          ...interactiveHookEnv(),
          HOME: home,
          USERPROFILE: home,
          FLEET_FRANCE_SSH: '',
          CLAUDE_ENV_FILE: '',
          CLAUDE_CODE_SESSION_ID: '',
          CODEX_THREAD_ID: '',
          CODEX_SESSION_ID: '',
        },
      });
    const first = run();
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toMatch(/还没出结果/);
    const cache = hook.bgCachePath(home, cwd, real);
    const until = Date.now() + 60_000;
    while (!existsSync(cache) && Date.now() < until)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    expect(existsSync(cache), '后台 60 秒内没写出结果').toBe(true);
    const second = JSON.parse(run().stdout).hookSpecificOutput.additionalContext as string;
    expect(second).toMatch(/规矩同步没跑：|规矩同步没查成：/);
  });
});

describe('备用代理写进 $CLAUDE_ENV_FILE（Bash 里的 gh/curl/npm 走它）', () => {
  const setup = (proxyFile?: string) => {
    const home = temp('home');
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    if (proxyFile !== undefined) writeFileSync(join(home, '.fleet-dao', 'fallback-proxy'), proxyFile);
    return { home, envFile: join(temp('env'), 'env.sh') };
  };

  it('配了：每个变量一行 export，NO_PROXY 留着本机地址并带上原有的；写两次不重复', () => {
    const { home, envFile } = setup('http://127.0.0.1:7890\n');
    const env = { NO_PROXY: 'localhost,127.0.0.1,::1,corp.internal' };
    expect(proxyLib.writeProxyEnv({ home, envFile, env })).toEqual([]);
    proxyLib.writeProxyEnv({ home, envFile, env });
    expect(readFileSync(envFile, 'utf8')).toBe(
      [
        'export HTTPS_PROXY=http://127.0.0.1:7890',
        'export HTTP_PROXY=http://127.0.0.1:7890',
        'export https_proxy=http://127.0.0.1:7890',
        'export http_proxy=http://127.0.0.1:7890',
        'export NO_PROXY=localhost,127.0.0.1,::1,corp.internal',
        'export no_proxy=localhost,127.0.0.1,::1,corp.internal',
        '',
      ].join('\n'),
    );
  });

  it('别的钩子先写过的行留着（追加，不覆盖）', () => {
    const { home, envFile } = setup('socks5://127.0.0.1:7891');
    mkdirSync(join(envFile, '..'), { recursive: true });
    writeFileSync(envFile, 'export FOO=1\n');
    proxyLib.writeProxyEnv({ home, envFile, env: {} });
    const text = readFileSync(envFile, 'utf8');
    expect(text.startsWith('export FOO=1\nexport HTTPS_PROXY=socks5://127.0.0.1:7891\n')).toBe(true);
    expect(text).toContain('export NO_PROXY=localhost,127.0.0.1,::1\n');
  });

  it('【故意造出的失败】没配：不写；那一行认不出：不写，说一句；没有 CLAUDE_ENV_FILE：不写', () => {
    const none = setup();
    expect(proxyLib.writeProxyEnv({ home: none.home, envFile: none.envFile, env: {} })).toEqual([]);
    expect(existsSync(none.envFile)).toBe(false);
    const bad = setup('ftp://127.0.0.1:7890');
    expect(proxyLib.writeProxyEnv({ home: bad.home, envFile: bad.envFile, env: {} }).join('')).toMatch(
      /认不出/,
    );
    expect(existsSync(bad.envFile)).toBe(false);
    const ok = setup('http://127.0.0.1:7890');
    expect(proxyLib.writeProxyEnv({ home: ok.home, envFile: undefined, env: {} })).toEqual([]);
  });

  it('后台子进程的环境：四个代理变量换成备用代理，NO_PROXY 留着', () => {
    const env = proxyLib.proxyEnvOf(
      {
        HTTPS_PROXY: 'http://127.0.0.1:56879',
        http_proxy: 'http://127.0.0.1:56879',
        NO_PROXY: 'localhost',
        PATH: 'p',
      },
      'http://127.0.0.1:7890',
    );
    expect(env).toMatchObject({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      http_proxy: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      PATH: 'p',
    });
  });
});
