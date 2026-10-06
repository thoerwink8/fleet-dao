// 取远端、取不成换直连再取一次（agents/hooks/fresh-main.mjs），以及起子代理前先把 origin/main 取到最新。
// 起因（创始人 2026-10-05）：子代理的工作树从本地记着的 origin/main 切，本机取不到远端时它停在隔夜的提交上。
// 这台机器经 reclaude 的本地口（HTTP(S)_PROXY=http://127.0.0.1:59822）出网：先照环境原样取、不改代理，没成才直连再取一次。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface R {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: (Error & { code?: string }) | undefined;
  timeoutMs?: number;
}
type Git = (cwd: string, args: string[], opts?: { direct?: boolean }) => R;
interface Lib {
  PROXY_VARS: string[];
  hasProxy(env: Record<string, string | undefined>): boolean;
  withoutProxy(env: Record<string, string | undefined>): Record<string, string | undefined>;
  fetchWithFallback(
    git: Git,
    cwd: string,
    args: string[],
    h: { okOf: (r: R) => boolean; whyOf: (r: R) => string; env?: Record<string, string | undefined> },
  ): { ok: boolean; via: 'env' | 'direct'; why: string };
  freshBeforeSubagent(o: {
    tool: unknown;
    toolInput: unknown;
    cwd: string;
    git: Git;
    okOf: (r: R) => boolean;
    whyOf: (r: R) => string;
    env?: Record<string, string | undefined>;
    home?: string;
    now?: number;
  }): { block: true; message: string } | null;
  FETCH_QUIET_MS: number;
  SUBAGENT_FETCH_MS: number;
  SUBAGENT_DIRECT_MS: number;
  isRefRace(r: R): boolean;
  gitOk(r: R): boolean;
  gitWhy(r: R): string;
}

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
// 代理变量、git 成没成和为什么没成在钩子共用的 git-run.mjs 里，取远端的办法在 fresh-main.mjs 里：两份合起来测
const lib = {
  ...(await import(pathToFileURL(join(HOOKS, 'git-run.mjs')).href)),
  ...(await import(pathToFileURL(join(HOOKS, 'fresh-main.mjs')).href)),
} as Lib;

const PROXY = { HTTPS_PROXY: 'http://127.0.0.1:59822', HTTP_PROXY: 'http://127.0.0.1:59822' };
const refused = (): R => ({
  status: 128,
  stdout: '',
  stderr:
    "fatal: unable to access 'https://github.com/x.git/': Failed to connect to github.com:443 over proxy 127.0.0.1 after 0 ms\n",
});
const good = (stdout = ''): R => ({ status: 0, stdout, stderr: '' });
const h = (env: Record<string, string | undefined>) => ({ okOf: lib.gitOk, whyOf: lib.gitWhy, env });

/** 一个假 git：按顺序给结果，记下每次调用 */
function script(results: R[]) {
  const calls: { args: string[]; direct: boolean }[] = [];
  const git: Git = (_cwd, args, opts) => {
    calls.push({ args, direct: opts?.direct === true });
    return results[Math.min(calls.length - 1, results.length - 1)] as R;
  };
  return { git, calls };
}

describe('取远端：先照环境原样，没成再直连一次', () => {
  it('第一次就成：只取一次，不碰代理', () => {
    const s = script([good()]);
    expect(lib.fetchWithFallback(s.git, '/r', ['fetch'], h(PROXY))).toEqual({
      ok: true,
      via: 'env',
      why: '',
    });
    expect(s.calls.map((c) => c.direct)).toEqual([false]);
  });

  it('环境里设着代理、第一次被拒（口还没起来）：直连再取一次，成了就成了', () => {
    const s = script([refused(), good()]);
    expect(lib.fetchWithFallback(s.git, '/r', ['fetch'], h(PROXY))).toEqual({
      ok: true,
      via: 'direct',
      why: '',
    });
    expect(s.calls.map((c) => c.direct)).toEqual([false, true]);
  });

  it('环境里没设代理：失败就是失败，不白取第二次', () => {
    const s = script([refused()]);
    const r = lib.fetchWithFallback(s.git, '/r', ['fetch'], h({ PATH: '/bin' }));
    expect(r.ok).toBe(false);
    expect(s.calls).toHaveLength(1);
  });

  // 故意造出失败：两条路都不通，不许说成成功，两次各自的原因都要在里面
  it('【故意造出的失败】代理和直连都不通：ok 为 false，原因写明两条路各自怎么没成', () => {
    const s = script([
      refused(),
      {
        status: null,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }),
        timeoutMs: 4000,
      },
    ]);
    const r = lib.fetchWithFallback(s.git, '/r', ['fetch'], h(PROXY));
    expect(r.ok).toBe(false);
    expect(r.why).toContain('经环境里的代理没成');
    expect(r.why).toContain('Failed to connect to github.com:443 over proxy');
    expect(r.why).toContain('去掉代理直连也没成（超过 4 秒没完）');
  });

  it('大小写、ALL_PROXY 都算设了代理；去掉时只拿代理变量，别的原样留着（NO_PROXY 也留）', () => {
    expect(lib.hasProxy({ all_proxy: 'socks5://127.0.0.1:1' })).toBe(true);
    expect(lib.hasProxy({ HTTPS_PROXY: '' })).toBe(false);
    const out = lib.withoutProxy({ ...PROXY, https_proxy: 'x', PATH: '/bin', NO_PROXY: 'localhost' });
    expect(out).toEqual({ PATH: '/bin', NO_PROXY: 'localhost' });
  });
});

const worktreeAgent = { subagent_type: 'general-purpose', isolation: 'worktree', prompt: 'x' };
const run = (g: Git, tool: unknown, toolInput: unknown, env = PROXY) =>
  lib.freshBeforeSubagent({ tool, toolInput, cwd: '/r', git: g, okOf: lib.gitOk, whyOf: lib.gitWhy, env });

/** rev-parse 说在仓里、有 origin，然后 fetch 按 fetchResults，log 说 origin/main 停在 9 小时前。
 * common 给绝对路径时才会记「取成过」（假 git 回 true 不记，避免写进真家目录）。 */
function repoGit(fetchResults: R[], common: string | null = null) {
  const calls: string[][] = [];
  let f = 0;
  const git: Git = (_cwd, args) => {
    calls.push(args);
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir'))
      return good(common ? `${common}\n` : 'true\n');
    if (args[0] === 'rev-parse') return good('true\n');
    if (args[0] === 'remote') return good('https://example/x.git\n');
    if (args[0] === 'fetch') return fetchResults[Math.min(f++, fetchResults.length - 1)] as R;
    if (args[0] === 'log') return good('abc1234（9 hours ago）\n');
    return good();
  };
  return { git, calls };
}

const raced = (): R => ({
  status: 1,
  stdout: '',
  stderr:
    "error: cannot lock ref 'refs/remotes/origin/main': is at bd7767ba514b409169f02eb24c008c5e6eb5929d but expected 10e888c85e440094a5228d2dfe6f68be98d5a897\n",
});

describe('几个进程同时取同一个远端：撞上引用竞争原路再取，不当成网络不通', () => {
  it('认得出「别的进程刚更新了这个引用」，认不出普通的连不上', () => {
    expect(lib.isRefRace(raced())).toBe(true);
    expect(lib.isRefRace(refused())).toBe(false);
  });

  it('第一次撞竞争、原路再取就成：只在代理那条路上试，不去直连', () => {
    const s = script([raced(), good()]);
    expect(lib.fetchWithFallback(s.git, '/r', ['fetch'], h(PROXY))).toEqual({
      ok: true,
      via: 'env',
      why: '',
    });
    expect(s.calls.map((c) => c.direct)).toEqual([false, false]);
  });

  // 故意造出失败：一直撞竞争也不能无限重试，且最后要说清原因，不说成成功
  it('【故意造出的失败】一直撞竞争：原路最多再试 2 次，再换直连也撞，最终判失败并写明原因', () => {
    const s = script([raced()]);
    const r = lib.fetchWithFallback(s.git, '/r', ['fetch'], h(PROXY));
    expect(r.ok).toBe(false);
    expect(r.why).toContain('cannot lock ref');
    expect(s.calls).toHaveLength(6);
  });

  it('普通的连不上不重试同一条路：直接换直连', () => {
    const s = script([refused(), good()]);
    expect(lib.fetchWithFallback(s.git, '/r', ['fetch'], h(PROXY)).via).toBe('direct');
    expect(s.calls.map((c) => c.direct)).toEqual([false, true]);
  });
});

describe('起子代理前取远端的时间预算', () => {
  // 调工具前钩子总共只有 10 秒（targets.ts）：超了钩子被杀，子代理照起、origin/main 却没取成，等于没拦住也没说
  it('代理那一次加直连那一次，加起来留够余量（< 10 秒）；首选路比兜底的直连给得多', () => {
    expect(lib.SUBAGENT_FETCH_MS + lib.SUBAGENT_DIRECT_MS).toBeLessThanOrEqual(9_000);
    expect(lib.SUBAGENT_FETCH_MS).toBeGreaterThan(lib.SUBAGENT_DIRECT_MS);
  });
});

describe('起子代理前先把 origin/main 取到最新', () => {
  it('取成了：放行（null），而且取的是 origin main', () => {
    const s = repoGit([good()]);
    expect(run(s.git, 'Agent', worktreeAgent)).toBeNull();
    expect(s.calls.find((a) => a[0] === 'fetch')).toEqual(['fetch', '-q', 'origin', 'main']);
  });

  it('三分钟内这个仓刚取成过：不再取，直接放行；过了再取。取失败不记，下一轮仍取、要建工作树仍拦', () => {
    const home = mkdtempSync(join(tmpdir(), 'fresh-ok-'));
    const common = join(home, 'repo.git');
    const now = Date.now();
    const go = (results: R[], at: number) => {
      const s = repoGit(results, common);
      const out = lib.freshBeforeSubagent({
        tool: 'Agent',
        toolInput: worktreeAgent,
        cwd: '/r',
        git: s.git,
        okOf: lib.gitOk,
        whyOf: lib.gitWhy,
        env: PROXY,
        home,
        now: at,
      });
      return { out, fetches: s.calls.filter((a) => a[0] === 'fetch').length };
    };
    const first = go([good()], now);
    expect(first.out).toBeNull();
    expect(first.fetches).toBe(1);
    const second = go([refused(), refused()], now + 1_000);
    expect(second.out).toBeNull();
    expect(second.fetches).toBe(0);

    const dir = join(home, '.fleet-dao', 'fetch-ok');
    const stamp = join(dir, readdirSync(dir)[0] ?? '');
    const old = new Date(now - lib.FETCH_QUIET_MS - 60_000);
    utimesSync(stamp, old, old);
    const third = go([good()], now + 2_000);
    expect(third.fetches).toBe(1);

    rmSync(dir, { recursive: true, force: true });
    const failed = go([refused(), refused()], now + 3_000);
    expect(failed.out?.block).toBe(true);
    expect(failed.fetches).toBe(2);
    const again = go([refused(), refused()], now + 4_000);
    expect(again.out?.block).toBe(true);
    expect(again.fetches).toBe(2);
    expect(existsSync(dir)).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it('代理被拒、直连成了：放行', () => {
    expect(run(repoGit([refused(), good()]).git, 'Agent', worktreeAgent)).toBeNull();
  });

  it('【故意造出的失败】要建工作树、两条路都取不到：拦下，说清 origin/main 停在多久以前', () => {
    const v = run(repoGit([refused(), refused()]).git, 'Agent', worktreeAgent);
    expect(v?.block).toBe(true);
    expect(v?.message).toContain('停在 abc1234（9 hours ago）');
    expect(v?.message).toContain('去掉代理直连也没成');
  });

  it('不建工作树的子代理取不到远端：不拦（它不从 origin/main 切）', () => {
    expect(
      run(repoGit([refused(), refused()]).git, 'Agent', { subagent_type: 'Explore', prompt: 'x' }),
    ).toBeNull();
  });

  it('不是 Agent / Task：一个 git 都不跑；不在仓里、没有 origin：不说话', () => {
    const s = script([good()]);
    expect(run(s.git, 'Bash', { command: 'ls' })).toBeNull();
    expect(s.calls).toHaveLength(0);
    expect(
      run(() => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository' }), 'Agent', worktreeAgent),
    ).toBeNull();
    const noOrigin: Git = (_c, args) =>
      args[0] === 'rev-parse' ? good('true\n') : { status: 2, stdout: '', stderr: 'error: No such remote' };
    expect(run(noOrigin, 'Task', worktreeAgent)).toBeNull();
  });
});

// 每条要起一个真的钩子进程、跑两三条 git（Windows 上慢，本机实测 5 秒多），默认 5 秒的超时太紧
const SLOW_MS = 30_000;

describe('真的钩子进程：远端取不到时，建工作树的子代理被拦、别的照放行', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repoWithDeadOrigin(): { repo: string; home: string } {
    const root = mkdtempSync(join(tmpdir(), 'fresh-main-'));
    made.push(root);
    const repo = join(root, 'r');
    mkdirSync(repo);
    const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('remote', 'add', 'origin', join(root, 'nope.git'));
    return { repo, home: join(root, 'home') };
  }

  const hook = join(HOOKS, 'pretool.mjs');
  const call = (toolInput: unknown) => {
    const { repo, home } = repoWithDeadOrigin();
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        tool_name: 'Agent',
        tool_input: toolInput,
        cwd: repo,
        session_id: 'fresh-main-test',
      }),
      encoding: 'utf8',
      env: { ...process.env, FLEET_UNATTENDED_DIR: join(home, 'u'), ...PROXY },
      timeout: 20_000,
    });
    return r;
  };

  it(
    'isolation: worktree 又取不到远端：退出码 2、说清原因',
    () => {
      const r = call(worktreeAgent);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('本机取不到远端');
    },
    SLOW_MS,
  );

  it(
    '没要工作树：退出码 0',
    () => {
      expect(call({ subagent_type: 'Explore', prompt: 'x' }).status).toBe(0);
    },
    SLOW_MS,
  );
});
