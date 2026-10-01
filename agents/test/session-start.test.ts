// 开会话钩子（agents/hooks/session-start.mjs）：会话所在的仓快进或提醒；这台机器的规矩、技能、钩子、权限跟着
// 同步专用的检出（~/.fleet-dao/origin-main）走——那一边永远停在 origin/main 上，这台自己的检出在哪个分支、
// 有没有没提交的改动都不影响。没查成、没做成都要明说原因和落后几个，不说成「已是最新」。
// 真 git（临时目录里的裸仓当 origin），同步换成假的（agents-sync 本身的测试在它的包里，
// 装进去的钩子真跑一遍同步在 packages/agents-sync/test/session-hook.test.ts；专用检出本身在 sync-source.test.ts）。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: (Error & { code?: string }) | undefined;
  timeoutMs?: number;
}
type Git = (cwd: string, args: string[]) => Result;
type Sync = (repo: string, home: string) => Result;
interface Fetch {
  common: string | null;
  ok: boolean;
  why: string;
}
interface HookLib {
  QUIET_MS: number;
  gitRunner(timeoutMs?: number): Git;
  checkHere(cwd: string, git: Git): { line: string | null; fetch: Fetch | null };
  syncFleet(o: { home: string; git: Git; sync: Sync; fetch?: Fetch | null; now?: number }): string;
  sessionStart(o: { cwd: string; home: string; git: Git; sync: Sync; now?: number }): string[];
  render(lines: string[]): string;
  pickCwd(input: unknown): string;
}

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const HOOK = join(HOOKS, 'session-start.mjs');
const hook = (await import(pathToFileURL(HOOK).href)) as HookLib;
/** 专用检出的位置（钩子是从 sync-source.mjs 里按家的目录拼出来的） */
const mirrorIn = (home: string) => join(home, '.fleet-dao', 'origin-main');

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `session-start-${name}-`));
  made.push(dir);
  return dir;
}

const g = (cwd: string, ...a: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

/** 一个裸仓当 origin，seed 往上推，work 是这台机器上的检出 */
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
  const push = (content: string) => {
    writeFileSync(join(seed, 'AGENTS.md'), content);
    g(seed, 'commit', '-q', '-am', content.trim());
    g(seed, 'push', '-q', 'origin', 'HEAD:main');
    return g(seed, 'rev-parse', 'HEAD');
  };
  const home = join(root, 'home');
  mkdirSync(home);
  return { root, origin, seed, work, home, push };
}

function record(home: string, repo: string, commit?: string): void {
  mkdirSync(join(home, '.fleet-dao'), { recursive: true });
  const synced = commit ? { synced: { commit, dirty: false, at: '2026-09-26T00:00:00.000Z' } } : {};
  writeFileSync(join(home, '.fleet-dao', 'synced.json'), JSON.stringify({ repo, ...synced }));
}

/** 假同步：记下被怎么调，回给定的结果 */
function fakeSync(result: Partial<Result> = {}) {
  const calls: [string, string][] = [];
  const sync: Sync = (repo, home) => {
    calls.push([repo, home]);
    return { status: 0, stdout: '结论：改动 0\n', stderr: '', ...result };
  };
  return { sync, calls };
}

const git = hook.gitRunner();
/** 每条都要起十几次 git（建仓、推、取），Windows 上一条要几秒 */
const SLOW = { timeout: 120_000 };

describe('会话所在的仓（原来的开场核规矩）', SLOW, () => {
  it('不是 git 仓：不出声', () => {
    expect(hook.checkHere(temp('plain'), git).line).toBeNull();
  });

  it('main 落后且干净：快进；已经最新：不出声', () => {
    const w = world();
    w.push('v2\n');
    expect(hook.checkHere(w.work, git).line).toMatch(/已把 main 快进到最新（原来落后 1 个提交）/);
    expect(g(w.work, 'show', 'HEAD:AGENTS.md')).toBe('v2');
    expect(hook.checkHere(w.work, git).line).toBeNull();
  });

  it('main 落后但有改动：提醒，不动手', () => {
    const w = world();
    w.push('v2\n');
    writeFileSync(join(w.work, 'AGENTS.md'), 'local edit\n');
    expect(hook.checkHere(w.work, git).line).toMatch(/main 落后 origin\/main 1 个提交，有没提交的改动/);
  });

  it('别的分支 AGENTS.md 和主线不同：提醒', () => {
    const w = world();
    g(w.work, 'checkout', '-q', '-b', 'feature');
    w.push('v2\n');
    expect(hook.checkHere(w.work, git).line).toMatch(/当前分支 feature 的 AGENTS\.md 和 origin\/main 不一样/);
  });

  it('取不到远端：明说没查成', () => {
    const w = world();
    g(w.work, 'remote', 'set-url', 'origin', join(w.root, 'nope.git'));
    const r = hook.checkHere(w.work, git);
    expect(r.line).toMatch(/开场核规矩没查成：git fetch 失败/);
    expect(r.fetch?.ok).toBe(false);
  });
});

describe('同步这台机器：专用检出 + 同步，没查成、没做成都明说', SLOW, () => {
  it('落后且干净：专用检出的建立按 record 里记的检出走；同步改了东西要说改了哪些、下次开会话才生效', () => {
    const w = world();
    const v1 = g(w.work, 'rev-parse', 'HEAD');
    record(w.home, w.work, v1);
    expect(hook.syncFleet({ home: w.home, git, sync: fakeSync().sync })).toMatch(/已同步到主线最新/);
    rmSync(join(w.home, '.fleet-dao', 'session-sync.ok'), { force: true });
    const v2 = w.push('v2\n');
    const f = fakeSync({
      stdout: [
        '通用段（AGENTS.md 上半段）',
        '  ↻ ~/.claude/CLAUDE.md：受管块换成了仓里的版本',
        '同步位置',
        '  ↻ ~/.fleet-dao/synced.json：这台同步到 abc，记下了',
        '结论：改动 2',
        '',
      ].join('\n'),
    });
    const line = hook.syncFleet({ home: w.home, git, sync: f.sync });
    // 同步用的是专用检出（永远停在 origin/main 上），不是这台自己的检出
    expect(f.calls).toEqual([[mirrorIn(w.home), w.home]]);
    expect(g(mirrorIn(w.home), 'rev-parse', 'HEAD')).toBe(v2);
    expect(line).toContain(`刚同步到主线最新（${v2.slice(0, 7)}），改了 1 处（~/.claude/CLAUDE.md）`);
    expect(line).toContain('下次开会话才生效');
  });

  it('这台自己的检出停在功能分支、还有没提交的改动：照样同步到 origin/main（原来就卡在这儿）', () => {
    const w = world();
    const v1 = g(w.work, 'rev-parse', 'HEAD');
    record(w.home, w.work, v1);
    g(w.work, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(w.work, 'AGENTS.md'), '分支上没提交的规矩\n');
    const v2 = w.push('v2\n');
    const f = fakeSync();
    const line = hook.syncFleet({ home: w.home, git, sync: f.sync });
    expect(f.calls).toHaveLength(1);
    expect(g(mirrorIn(w.home), 'rev-parse', 'HEAD')).toBe(v2);
    // 这台自己的检出一个字都没动
    expect(g(w.work, 'branch', '--show-current')).toBe('feature');
    expect(readFileSync(join(w.work, 'AGENTS.md'), 'utf8')).toBe('分支上没提交的规矩\n');
    expect(line).toContain('已同步到主线最新');
  });

  it('刚同步成功过：三分钟内不再取远端、不再同步；过了就照常', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const f = fakeSync();
    expect(hook.syncFleet({ home: w.home, git, sync: f.sync })).toMatch(/已同步到主线最新/);
    expect(hook.syncFleet({ home: w.home, git, sync: f.sync })).toMatch(/分钟内刚同步成功过/);
    expect(f.calls).toHaveLength(1);
    const old = new Date(Date.now() - hook.QUIET_MS - 60_000);
    utimesSync(join(w.home, '.fleet-dao', 'session-sync.ok'), old, old);
    hook.syncFleet({ home: w.home, git, sync: f.sync });
    expect(f.calls).toHaveLength(2);
  });

  it('同步有没做成的：说出是哪几项、这台落后主线几个；不记「刚同步成功过」', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    w.push('v2\n');
    w.push('v3\n');
    const f = fakeSync({
      status: 1,
      stdout:
        '钩子（agents/hooks/）\n  ✗ ~/.claude/settings.json：没动——不是合法的 JSON；要人看\n结论：没做成 1\n',
    });
    const line = hook.syncFleet({ home: w.home, git, sync: f.sync });
    expect(line).toContain('规矩同步有没做成的（1 处）：~/.claude/settings.json：没动——不是合法的 JSON');
    expect(line).toContain('落后主线 2 个提交');
    expect(line).toContain('--check');
    hook.syncFleet({ home: w.home, git, sync: f.sync });
    expect(f.calls).toHaveLength(2);
  });

  it('同步没查成（比如另一个同步正在写）、崩了、超时：都说没查成和原因', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const busy = fakeSync({
      status: 2,
      stdout:
        '写锁\n  … ~/.fleet-dao/agents-sync.lock：没做成——另一个 agents-sync 在写（进程 1，3 秒前拿的锁）\n结论：没查成 1\n',
    });
    expect(hook.syncFleet({ home: w.home, git, sync: busy.sync })).toMatch(
      /规矩同步没查成：.*另一个 agents-sync 在写/,
    );
    const crashed = fakeSync({ status: 1, stdout: '', stderr: 'Error: Cannot find module agents-sync\n' });
    expect(hook.syncFleet({ home: w.home, git, sync: crashed.sync })).toMatch(
      /没给出逐项结论（Error: Cannot find module agents-sync）/,
    );
    const slow = fakeSync({
      status: null,
      stdout: '',
      error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      timeoutMs: 30_000,
    });
    expect(hook.syncFleet({ home: w.home, git, sync: slow.sync })).toMatch(/agents-sync 30 秒没跑完/);
  });

  it('这台没记过检出在哪、也没建过专用检出：明说没查成、该跑哪条命令，不去同步', () => {
    const w = world();
    const f = fakeSync();
    const line = hook.syncFleet({ home: w.home, git, sync: f.sync });
    expect(line).toMatch(/规矩同步没跑：这台还没建同步专用的检出/);
    expect(line).toContain('pnpm agents:sync');
    expect(f.calls).toEqual([]);
  });

  it('记录读不懂但有专用检出：照旧同步，并说这次会把记录重写一份', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const f = fakeSync();
    hook.syncFleet({ home: w.home, git, sync: f.sync });
    expect(f.calls).toHaveLength(1);
    writeFileSync(join(w.home, '.fleet-dao', 'synced.json'), '{ 坏了');
    rmSync(join(w.home, '.fleet-dao', 'session-sync.ok'), { force: true });
    const f2 = fakeSync();
    const line = hook.syncFleet({ home: w.home, git, sync: f2.sync });
    expect(f2.calls).toHaveLength(1);
    expect(line).toContain('synced.json 读不懂');
    expect(line).toContain('会重写一份');
  });

  it('取不到远端：没查成，按本机上次取到的主线说落后几个；专用检出里的文件没被动', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const f = fakeSync();
    hook.syncFleet({ home: w.home, git, sync: f.sync });
    rmSync(join(w.home, '.fleet-dao', 'session-sync.ok'), { force: true });
    const before = g(mirrorIn(w.home), 'rev-parse', 'HEAD');
    g(mirrorIn(w.home), 'remote', 'set-url', 'origin', join(w.root, 'nope.git'));
    const f2 = fakeSync();
    const line = hook.syncFleet({ home: w.home, git, sync: f2.sync });
    expect(line).toMatch(/规矩同步没跑：取远端失败/);
    expect(line).toContain('按本机上次取到的主线算');
    expect(f2.calls).toEqual([]);
    expect(g(mirrorIn(w.home), 'rev-parse', 'HEAD')).toBe(before);
  });

  // 2026-09-30 本机 git 缺 DLL（退出码 3221225781、什么都不打），钩子说成「记下的检出不是 git 仓」，把真毛病盖住了
  it('【故意造出的失败】git 起来就被系统叫停（退出码 3221225781，没有任何输出）：说 git 跑不起来，不说不是 git 仓', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const f = fakeSync();
    const dead: Git = () => ({ status: 3221225781, stdout: '', stderr: '' });
    const line = hook.syncFleet({ home: w.home, git: dead, sync: f.sync });
    expect(line).toMatch(/规矩同步没跑：这台的 git 跑不起来/);
    expect(line).toContain('3221225781（0xC0000135');
    expect(line).not.toMatch(/不是 git 仓/);
    expect(f.calls).toEqual([]);
  });

  it('【故意造出的失败】git 根本起不来（找不到命令）、超时：同样说 git 跑不起来', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const missing: Git = () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }),
    });
    expect(hook.syncFleet({ home: w.home, git: missing, sync: fakeSync().sync })).toMatch(
      /这台的 git 跑不起来（起不来：spawnSync git ENOENT）/,
    );
    const slow: Git = () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      timeoutMs: 15_000,
    });
    expect(hook.syncFleet({ home: w.home, git: slow, sync: fakeSync().sync })).toMatch(
      /这台的 git 跑不起来（超过 15 秒没完）/,
    );
  });

  it('另一个同步正在做（拿不到那把锁）：说清是谁拿着，这次什么都没动', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    mkdirSync(join(w.home, '.fleet-dao'), { recursive: true });
    writeFileSync(
      join(w.home, '.fleet-dao', 'origin-main.lock'),
      `${process.pid} ${new Date().toISOString()}\n`,
    );
    const f = fakeSync();
    const line = hook.syncFleet({ home: w.home, git, sync: f.sync });
    expect(line).toMatch(/规矩同步没跑：另一个同步正在做（进程 \d+/);
    expect(f.calls).toEqual([]);
    expect(existsSync(mirrorIn(w.home))).toBe(false);
  });

  it('会话所在的仓那一件：git 跑不起来时不出声、不崩（同步那一句会说清）', () => {
    const dead: Git = () => ({ status: 3221225781, stdout: '', stderr: '' });
    expect(hook.checkHere(temp('plain'), dead)).toEqual({ line: null, fetch: null });
  });

  it('会话就开在 fleet-dao 检出里：远端只取一次（专用检出的取远端不算在里）', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    w.push('v2\n');
    const fetches: string[] = [];
    const counting: Git = (cwd, args) => {
      if (args[0] === 'fetch' && cwd === w.work) fetches.push(cwd);
      return git(cwd, args);
    };
    const lines = hook.sessionStart({ cwd: w.work, home: w.home, git: counting, sync: fakeSync().sync });
    expect(fetches).toHaveLength(1);
    expect(lines[0]).toMatch(/已把 main 快进到最新/);
    expect(lines[1]).toMatch(/已同步到主线最新/);
  });
});

describe('命令行外壳：一律退出 0，输出是各家都认的开会话 JSON', SLOW, () => {
  // 钩子进程的工作目录放在临时目录：输入里没有会话目录时它退回到自己的工作目录，别让它去取仓的远端
  const run = (home: string, stdin: string) =>
    spawnSync(process.execPath, [HOOK], {
      input: stdin,
      encoding: 'utf8',
      cwd: temp('cwd'),
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

  it('这台没记检出、也没建过专用检出：退出 0，上下文里写明没查成', () => {
    const home = temp('home');
    const r = run(home, JSON.stringify({ hook_event_name: 'SessionStart', cwd: temp('plain') }));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('规矩同步没跑：');
  });

  it('输入读不懂：照样退出 0、照样说结论', () => {
    const r = run(temp('home'), '不是 JSON');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('规矩同步');
  });

  it('各家给会话目录的字段不一样', () => {
    expect(hook.pickCwd({ cwd: '/a' })).toBe('/a');
    expect(hook.pickCwd({ workspaceRoot: '/b' })).toBe('/b');
    expect(hook.pickCwd({ workspace_roots: ['/c'] })).toBe('/c');
    expect(hook.pickCwd({})).toBe(process.cwd());
    expect(JSON.parse(hook.render(['一', '二'])).hookSpecificOutput.additionalContext).toBe('一\n二');
  });
});
