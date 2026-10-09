// 开会话钩子（agents/hooks/session-start.mjs）：会话所在的仓快进或提醒；这台机器的规矩、技能、钩子、权限跟着
// 同步专用的检出（~/.fleet-dao/origin-main）走——那一边永远停在 origin/main 上，这台自己的检出在哪个分支、
// 有没有没提交的改动都不影响。没查成、没做成都要明说原因和落后几个，不说成「已是最新」。
// 真 git（临时目录里的裸仓当 origin），同步换成假的（agents-sync 本身的测试在它的包里，
// 装进去的钩子真跑一遍同步在 packages/agents-sync/test/session-hook.test.ts；专用检出本身在 sync-source.test.ts）。
// 第 3 件「生效中的临时调整」表：真 git 仓里放 .md，到期、缺列、日期认不出、表坏了、git 坏了各一条。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild, runChildOk } from './child.ts';

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
  checkHere(
    cwd: string,
    git: Git,
    opts?: { network?: boolean },
  ): { line: string | null; fetch: Fetch | null };
  syncFleet(o: { home: string; git: Git; sync: Sync; fetch?: Fetch | null; now?: number }): string;
  sessionStart(o: {
    cwd: string;
    home: string;
    git: Git;
    sync: Sync;
    localGit?: Git;
    now?: number;
    sessionId?: string | null;
    env?: Record<string, string | undefined>;
    poolHolds?: () => { ok: boolean; skipped?: boolean; value?: unknown; why?: string };
  }): string[];
  readFrancePoolHolds(o: {
    home: string;
    env?: Record<string, string | undefined>;
    now?: number;
    spawn?: (cmd: string, args: string[], opts: unknown) => Result;
  }): { ok: boolean; skipped?: boolean; value?: unknown; why?: string };
  poolHoldPromptLines(
    read: { ok: boolean; skipped?: boolean; value?: unknown; why?: string },
    today: string,
  ): string[];
  RECENT_TOTAL_CHARS: number;
  checkTemporary(cwd: string, git: Git, now?: number): string[];
  checkDirectives(cwd: string, git: Git): string[];
  sweepWorktrees(cwd: string, git: Git, now?: number, home?: string): string[];
  workerLines(home: string, now?: number, alive?: (pid: number) => boolean): string[];
  beijingToday(now?: number): string;
  render(lines: string[]): string;
  pickCwd(input: unknown): string;
  PROGRESS_MS: number;
  progressRunner(timeoutMs?: number): ScriptRun;
  checkProgressIssue(o: { cwd: string; git: Git; run: ScriptRun; mirror?: string | null }): string[];
  IDLE_PR_MS: number;
  idlePrRunner(timeoutMs?: number): ScriptRun;
  checkIdlePrs(o: {
    cwd: string;
    git: Git;
    run: ScriptRun;
    fetch: Fetch | null;
    mirror?: string | null;
  }): string[];
}
type ScriptRun = (script: string, repo: string) => Result;

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
  runChildOk(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a],
    {
      cwd,
    },
  );

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
const SLOW = { timeout: 0 };

/** 一个只有本地提交的仓：files 全部提交（untracked 里的不提交） */
function repo(files: Record<string, string>, untracked: Record<string, string> = {}) {
  const dir = temp('tmp-repo');
  g(dir, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries({ 'README.md': '# 仓\n', ...files })) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  for (const [name, text] of Object.entries(untracked)) writeFileSync(join(dir, name), text);
  return dir;
}

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
    expect(hook.checkHere(w.work, git).line).toMatch(/当前分支 feature 的规矩（.*）和 origin\/main 不一样/);
  });

  it('别的分支只有通用段原件（agents/shared-rules.md）和主线不同：一样提醒——只比 AGENTS.md 会漏', () => {
    const w = world();
    g(w.work, 'checkout', '-q', '-b', 'feature');
    mkdirSync(join(w.work, 'agents'), { recursive: true });
    writeFileSync(join(w.work, 'agents', 'shared-rules.md'), '分支上的通用段\n');
    g(w.work, 'add', '-A');
    g(w.work, 'commit', '-q', '-m', 'rules');
    expect(hook.checkHere(w.work, git).line).toMatch(/和 origin\/main 不一样/);
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

  it('同一天、三分钟已过：再同步，留下的「今天已同步」日期也不跳过、也不再写', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const f = fakeSync();
    const NOW = Date.parse('2026-10-05T06:00:00Z'); // 北京 2026-10-05 14:00
    const day = join(w.home, '.fleet-dao', 'session-sync.date');
    expect(hook.syncFleet({ home: w.home, git, sync: f.sync, now: NOW })).toMatch(/已同步到主线最新/);
    expect(f.calls).toHaveLength(1);
    expect(existsSync(day)).toBe(false);
    mkdirSync(join(w.home, '.fleet-dao'), { recursive: true });
    writeFileSync(day, '2026-10-05\n');
    rmSync(join(w.home, '.fleet-dao', 'session-sync.ok'), { force: true });
    const later = hook.syncFleet({ home: w.home, git, sync: f.sync, now: NOW + 60 * 60_000 });
    expect(later).toMatch(/已同步到主线最新/);
    expect(f.calls).toHaveLength(2);
    expect(readFileSync(day, 'utf8').trim()).toBe('2026-10-05');
  });

  it('留下的日期文件不参与判断：昨天的、读不懂的都原样留着，同步照常跑', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const f = fakeSync();
    const NOW = Date.parse('2026-10-05T06:00:00Z'); // 北京 2026-10-05
    const day = join(w.home, '.fleet-dao', 'session-sync.date');
    mkdirSync(join(w.home, '.fleet-dao'), { recursive: true });
    writeFileSync(day, '2026-10-04\n');
    expect(hook.syncFleet({ home: w.home, git, sync: f.sync, now: NOW })).toMatch(/已同步到主线最新/);
    expect(f.calls).toHaveLength(1);
    expect(readFileSync(day, 'utf8').trim()).toBe('2026-10-04');
    writeFileSync(day, '垃圾\n');
    rmSync(join(w.home, '.fleet-dao', 'session-sync.ok'), { force: true });
    const f2 = fakeSync();
    expect(hook.syncFleet({ home: w.home, git, sync: f2.sync, now: NOW + 60 * 60_000 })).toMatch(
      /已同步到主线最新/,
    );
    expect(f2.calls).toHaveLength(1);
    expect(readFileSync(day, 'utf8').trim()).toBe('垃圾');
  });

  it('同步失败：不写「今天已同步」的记号，过了三分钟下次还会真跑', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const NOW = Date.parse('2026-10-05T06:00:00Z');
    const bad = fakeSync({
      status: 1,
      stdout: '钩子\n  ✗ ~/.claude/settings.json：没动；要人看\n结论：没做成 1\n',
    });
    hook.syncFleet({ home: w.home, git, sync: bad.sync, now: NOW });
    expect(existsSync(join(w.home, '.fleet-dao', 'session-sync.ok'))).toBe(false);
    const good = fakeSync();
    hook.syncFleet({ home: w.home, git, sync: good.sync, now: NOW + 60_000 });
    expect(good.calls).toHaveLength(1);
    expect(existsSync(join(w.home, '.fleet-dao', 'session-sync.date'))).toBe(false);
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
    expect(hook.syncFleet({ home: w.home, git: missing, sync: fakeSync().sync })).toContain(
      '这台的 git 跑不起来（起不来：spawnSync git ENOENT）',
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

  it('network:false 不取远端，只用手里已有的 origin/main', () => {
    const w = world();
    w.push('v2\n');
    const fetches: string[] = [];
    const counting: Git = (cwd, args) => {
      if (args[0] === 'fetch') fetches.push(cwd);
      return git(cwd, args);
    };
    expect(hook.checkHere(w.work, counting, { network: false }).line).toBeNull();
    expect(fetches).toEqual([]);
  });

  it('三分钟内不再取远端、不再问 GitHub、不再扫工作树；引导对账每轮都做；过了再做。工人不走这扇门', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const log = join(w.home, '.fleet-dao', 'prompt-log');
    mkdirSync(log, { recursive: true });
    const now = Date.now();
    const day = hook.beijingToday(now);
    writeFileSync(
      join(log, `${day}.jsonl`),
      `${JSON.stringify({ at: new Date(now - 5_000).toISOString(), sessionId: 'other', prompt: '上一场没答的话' })}\n`,
    );
    const fetches: string[] = [];
    const lists: string[] = [];
    let originAsks = 0;
    const counting: Git = (cwd, args) => {
      if (args[0] === 'fetch' && cwd === w.work) fetches.push(cwd);
      return git(cwd, args);
    };
    const local: Git = (cwd, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') lists.push(cwd);
      if (args[0] === 'config' && args[1] === '--get' && args[2] === 'remote.origin.url') originAsks += 1;
      return git(cwd, args);
    };
    const first = hook.sessionStart({
      cwd: w.work,
      home: w.home,
      git: counting,
      localGit: local,
      sync: fakeSync().sync,
      now,
      sessionId: 'me',
    });
    expect(fetches).toHaveLength(1);
    expect(lists).toHaveLength(1);
    expect(originAsks).toBe(2);
    expect(first.join('\n')).toContain('上一场没答的话');
    expect(existsSync(join(w.home, '.fleet-dao', 'fetch-ok'))).toBe(true);

    const second = hook.sessionStart({
      cwd: w.work,
      home: w.home,
      git: counting,
      localGit: local,
      sync: fakeSync().sync,
      now: now + 1_000,
      sessionId: 'me',
    });
    expect(fetches).toHaveLength(1);
    expect(lists).toHaveLength(1);
    expect(originAsks).toBe(2);
    expect(second.join('\n')).toContain('上一场没答的话');

    const netDir = join(w.home, '.fleet-dao', 'session-net');
    const okDir = join(w.home, '.fleet-dao', 'fetch-ok');
    const old = new Date(now - hook.QUIET_MS - 60_000);
    for (const dir of [netDir, okDir]) {
      const stamp = join(dir, readdirSync(dir)[0] ?? '');
      utimesSync(stamp, old, old);
    }
    hook.sessionStart({
      cwd: w.work,
      home: w.home,
      git: counting,
      localGit: local,
      sync: fakeSync().sync,
      now: now + 2_000,
      sessionId: 'me',
    });
    expect(fetches).toHaveLength(2);
    expect(lists).toHaveLength(2);

    const beforeWorker = fetches.length;
    hook.sessionStart({
      cwd: w.work,
      home: w.home,
      git: counting,
      sync: fakeSync().sync,
      now: now + 3_000,
      env: { FLEET_WORKER: '1' },
    });
    expect(fetches).toHaveLength(beforeWorker + 1);
  });

  it('取远端失败也记上这一笔：三分钟内不再连着等超时', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    let fetches = 0;
    const failing: Git = (cwd, args) => {
      if (args[0] === 'fetch' && cwd === w.work) {
        fetches += 1;
        return { status: 1, stdout: '', stderr: 'no route' };
      }
      return git(cwd, args);
    };
    const now = Date.now();
    const first = hook.sessionStart({
      cwd: w.work,
      home: w.home,
      git: failing,
      sync: fakeSync().sync,
      now,
    });
    expect(first.join('\n')).toMatch(/git fetch 失败/);
    expect(existsSync(join(w.home, '.fleet-dao', 'fetch-ok'))).toBe(false);
    // 环境里有代理时，同一次取远端会再直连试一次，所以第一次可能是 2 次 fetch；第二轮必须一次都不加
    const afterFirst = fetches;
    expect(afterFirst).toBeGreaterThan(0);
    const second = hook.sessionStart({
      cwd: w.work,
      home: w.home,
      git: failing,
      sync: fakeSync().sync,
      now: now + 1_000,
    });
    expect(fetches).toBe(afterFirst);
    expect(second.join('\n')).not.toMatch(/git fetch 失败/);
  });
});

describe('命令行外壳：一律退出 0，输出是各家都认的开会话 JSON', SLOW, () => {
  // 钩子进程的工作目录放在临时目录：输入里没有会话目录时它退回到自己的工作目录，别让它去取仓的远端
  const run = (home: string, stdin: string) =>
    runChild(process.execPath, [HOOK], {
      input: stdin,
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

describe('会话所在仓的「生效中的临时调整」表', SLOW, () => {
  const HEAD =
    '| 内容 | 当时为什么 | 谁拍的（原话和日期） | 撤回条件 | 最迟复查日期 |\n|---|---|---|---|---|\n';
  /** 北京时间 2026-10-06 上午十点 */
  const NOW = Date.parse('2026-10-06T02:00:00Z');
  const plan = (rows: string, before = '') =>
    `# 计划\n\n## 生效中的临时调整\n\n${before}${HEAD}${rows}\n## 版本\n\n- 交付 3\n`;
  const row = (...cells: string[]) => `| ${cells.join(' | ')} |\n`;
  const subagent = row(
    '不开子代理',
    '额度不够',
    '创始人 2026-09-28「我额度不太够」',
    '额度恢复或创始人说撤',
    '2026-10-05',
  );

  it('今天按北京时间算：UTC 还是前一天的下午，北京已经是第二天', () => {
    expect(hook.beijingToday(Date.parse('2026-10-04T17:00:00Z'))).toBe('2026-10-05');
    expect(hook.beijingToday(Date.parse('2026-10-04T15:59:00Z'))).toBe('2026-10-04');
  });

  it('表在、都没到复查日期：不出声（表前有说明、表是空的也一样）', () => {
    const dir = repo({ 'docs/PROGRESS.md': plan(subagent, '撤回就删行。\n\n') });
    expect(hook.checkTemporary(dir, git, Date.parse('2026-10-03T02:00:00Z'))).toEqual([]);
    expect(hook.checkTemporary(repo({ 'docs/PROGRESS.md': plan('') }), git, NOW)).toEqual([]);
  });

  it('到了最迟复查日期（含今天）：一行列出来，提醒照读法②问创始人', () => {
    const today = row('停法国池', '机器坏了', '创始人 2026-10-01「先停」', '机器修好', '2026-10-06');
    const later = row('只开一条路由', '额度紧', '创始人 2026-10-01「先这样」', '额度恢复', '2026-10-20');
    const dir = repo({ 'docs/PROGRESS.md': plan(subagent + today + later) });
    const lines = hook.checkTemporary(join(dir, 'docs'), git, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('临时调整到了最迟复查日期 2 条（docs/PROGRESS.md，今天 2026-10-06）');
    expect(lines[0]).toContain('不开子代理（最迟 2026-10-05）；停法国池（最迟 2026-10-06）');
    expect(lines[0]).toContain('读法②问创始人');
    expect(lines[0]).not.toContain('只开一条路由');
  });

  it('北京时间过了零点就算到期，不按 UTC 晚一天', () => {
    const dir = repo({ 'docs/PROGRESS.md': plan(subagent) });
    expect(hook.checkTemporary(dir, git, Date.parse('2026-10-04T17:00:00Z'))[0]).toMatch(
      /到了最迟复查日期 1 条/,
    );
  });

  it('【故意造出的失败】缺列：少一列、有一格空着，都报是哪一行', () => {
    const short = '| 不开子代理 | 额度不够 | 创始人 09-28 | 2026-10-05 |\n';
    const empty = row('停池', '机器坏了', '创始人 2026-10-01「先停」', '', '2026-10-30');
    const dir = repo({ 'docs/PROGRESS.md': plan(short + empty) });
    const lines = hook.checkTemporary(dir, git, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/临时调整表有 2 行缺列（docs\/PROGRESS\.md）/);
    expect(lines[0]).toContain('第 7 行「不开子代理」只有 4 列');
    expect(lines[0]).toContain('第 8 行「停池」的「撤回条件」空着');
    expect(lines[0]).toContain('补齐五列');
  });

  it('【故意造出的失败】最迟复查日期认不出：写成口语、不存在的日子、少了年份都报', () => {
    const rows =
      row('甲', '额度', '创始人 2026-09-28', '额度恢复', '下周五') +
      row('乙', '额度', '创始人 2026-09-28', '额度恢复', '2026-02-30') +
      row('丙', '额度', '创始人 2026-09-28', '额度恢复', '10-05');
    const lines = hook.checkTemporary(repo({ 'docs/PROGRESS.md': plan(rows) }), git, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('临时调整表有 3 行最迟复查日期认不出（docs/PROGRESS.md）');
    expect(lines[0]).toContain('「甲」的「下周五」');
    expect(lines[0]).toContain('「乙」的「2026-02-30」');
    expect(lines[0]).toContain('「丙」的「10-05」');
  });

  it('【故意造出的失败】有标题、表认不出：没有表格、没有分隔行、表头不是五列，都明说没查成', () => {
    const none = repo({
      'docs/PROGRESS.md': '## 生效中的临时调整\n\n（还没有）\n\n## 版本\n| a | b |\n|---|---|\n',
    });
    expect(hook.checkTemporary(none, git, NOW)).toEqual([
      '临时调整表没查成（docs/PROGRESS.md）：标题下面没有表格。',
    ]);
    const noSep = repo({ 'docs/PROGRESS.md': `## 生效中的临时调整\n\n${HEAD.split('\n')[0]}\n${subagent}` });
    expect(hook.checkTemporary(noSep, git, NOW)[0]).toMatch(
      /临时调整表没查成（docs\/PROGRESS\.md）：第 3 行的表头下面没有 \|---\| 分隔行/,
    );
    const fourCols = repo({
      'docs/PROGRESS.md': '## 生效中的临时调整\n| 内容 | 为什么 | 谁拍的 | 复查 |\n|---|---|---|---|\n',
    });
    expect(hook.checkTemporary(fourCols, git, NOW)[0]).toMatch(
      /临时调整表没查成.*表头是「内容｜为什么｜谁拍的｜复查」，要五列/,
    );
  });

  it('没有这张表不出声：没提这个标题、只在句子里提到、只在没跟踪的文件里有、不是 git 仓', () => {
    expect(hook.checkTemporary(repo({ 'docs/PROGRESS.md': '# 计划\n' }), git, NOW)).toEqual([]);
    const inline = repo({ 'AGENTS.md': '登进「## 生效中的临时调整」表\n' }, { 'scratch.md': plan(subagent) });
    expect(hook.checkTemporary(inline, git, NOW)).toEqual([]);
    expect(hook.checkTemporary(temp('plain'), git, NOW)).toEqual([]);
  });

  it('中文路径照样认得出；一个仓里有两张表要说并成一张', () => {
    const dir = repo({ 'specs/12-额度/需求.md': plan(subagent), 'docs/PROGRESS.md': plan('') });
    const lines = hook.checkTemporary(dir, git, NOW);
    expect(lines[0]).toMatch(/临时调整表不止一张（.*docs\/PROGRESS\.md:3.*specs\/12-额度\/需求\.md:3.*）/);
    expect(lines[1]).toContain('临时调整到了最迟复查日期 1 条（specs/12-额度/需求.md:3');
  });

  it('【故意造出的失败】git 跑不起来、git grep 出错：明说没查成，不当成没有表', () => {
    const dead: Git = () => ({ status: 3221225781, stdout: '', stderr: '' });
    expect(hook.checkTemporary(temp('plain'), dead, NOW)).toEqual([
      '临时调整表没查成：这台的 git 跑不起来（退出码 3221225781（0xC0000135，Windows 上程序没起来，多半缺 DLL）），会话所在仓里有没有到期的临时调整不知道。',
    ]);
    const dir = repo({});
    const grepBroken: Git = (cwd, args) =>
      args[0] === 'grep'
        ? {
            status: null,
            stdout: '',
            stderr: '',
            error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }),
            timeoutMs: 5_000,
          }
        : git(cwd, args);
    expect(hook.checkTemporary(dir, grepBroken, NOW)).toEqual([
      '临时调整表没查成：git grep 找表没成（超过 5 秒没完）。',
    ]);
    const grepGarbled: Git = (cwd, args) =>
      args[0] === 'grep'
        ? { status: 0, stdout: 'docs/PROGRESS.md:3:## 生效中的临时调整\n', stderr: '' }
        : git(cwd, args);
    expect(hook.checkTemporary(dir, grepGarbled, NOW)[0]).toMatch(/临时调整表没查成：git grep 的输出认不出/);
  });

  it('开会话时这几行进上下文，排在同步那一句前面', () => {
    const w = world();
    writeFileSync(join(w.work, 'PROGRESS.md'), plan(subagent));
    g(w.work, 'add', '-A');
    g(w.work, 'commit', '-q', '-m', 'progress');
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const lines = hook.sessionStart({ cwd: w.work, home: w.home, git, sync: fakeSync().sync, now: NOW });
    expect(lines[0]).toMatch(/临时调整到了最迟复查日期 1 条（PROGRESS\.md/);
    expect(lines.at(-1)).toMatch(/^规矩同步/);
  });

  it('工人（FLEET_WORKER=1）开场只留规矩同步：不出创始人引导、临时调整、他最近的话、工作树清单、工人状态；不带它的会话照旧都出', () => {
    const w = world();
    writeFileSync(
      join(w.work, 'PROGRESS.md'),
      `${plan(subagent)}\n## 创始人引导（待处理）\n\n- 04:42 「坏的要删」\n`,
    );
    g(w.work, 'add', '-A');
    g(w.work, 'commit', '-q', '-m', 'progress');
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    // 工人状态目录里放一个不在跑的工人：普通会话会提醒，工人会话不该看到
    const dir = join(w.home, '.fleet-dao', 'workers', 'gone');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        name: 'gone',
        pid: 2147483000,
        startedAt: '2026-10-05T01:00:00Z',
        worktree: '/w/gone',
      }),
    );
    const base = { cwd: w.work, home: w.home, git, sync: fakeSync().sync, now: NOW };
    const normal = hook.sessionStart({ ...base, env: {} }).join('\n');
    expect(normal).toContain('创始人引导还有 1 条没处理');
    expect(normal).toContain('临时调整到了最迟复查日期');
    expect(normal).toContain('工人 gone');

    const lines = hook.sessionStart({ ...base, env: { FLEET_WORKER: '1' } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^规矩同步/);
  });
});

describe('会话所在仓的「创始人引导（待处理）」清单', SLOW, () => {
  const head = '# 进度\n\n## 创始人引导（待处理）\n\n';
  const tail = '\n## 别的节\n';

  it('有没处理完的引导：一行报几条，提醒办完标已处理或删掉', () => {
    const text = `${head}- 04:42 「坏的要删」\n- 05:33 「删库表选 1」\n${tail}`;
    const dir = repo({ 'docs/PROGRESS.md': text });
    const lines = hook.checkDirectives(dir, git);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('创始人引导还有 2 条没处理');
    expect(lines[0]).toContain('坏的要删');
    expect(lines[0]).toContain('删库表选 1');
  });

  it('都标了「已处理」：不出声', () => {
    const text = `${head}- 04:42「坏的要删」已处理\n${tail}`;
    expect(hook.checkDirectives(repo({ 'docs/PROGRESS.md': text }), git)).toEqual([]);
  });

  it('没有这一节、不是 git 仓：都不出声', () => {
    expect(hook.checkDirectives(repo({ 'docs/PROGRESS.md': '# 进度\n\n## 版本\n' }), git)).toEqual([]);
  });

  it('【故意造出失败】把待处理那条标成「已处理」之后就不再报——断言它真读了内容，不是恒返回空', () => {
    const pending = repo({ 'docs/PROGRESS.md': `${head}- 04:42「坏的要删」\n${tail}` });
    const done = repo({ 'docs/PROGRESS.md': `${head}- 04:42「坏的要删」已处理\n${tail}` });
    expect(hook.checkDirectives(pending, git)).toHaveLength(1);
    expect(hook.checkDirectives(done, git)).toEqual([]);
  });

  it('【故意造出的失败】git 跑不起来：明说没查成，不当成没事', () => {
    const dead: Git = () => ({ status: 3221225781, stdout: '', stderr: '' });
    expect(hook.checkDirectives(repo({ 'docs/PROGRESS.md': head }), dead)[0]).toMatch(
      /创始人引导待处理清单没查成/,
    );
  });
});

describe('顺手清 .claude/worktrees/ 里攒着的旧树', SLOW, () => {
  /** 在 work 检出里建一棵树，返回它的名字 */
  function tree(w: ReturnType<typeof world>, name: string): string {
    const dir = join(w.work, '.claude', 'worktrees', name);
    mkdirSync(join(w.work, '.claude', 'worktrees'), { recursive: true });
    g(w.work, 'worktree', 'add', '-q', '--detach', dir, 'HEAD');
    return name;
  }
  const listTrees = (w: ReturnType<typeof world>) => {
    const dir = join(w.work, '.claude', 'worktrees');
    if (!existsSync(dir)) return [];
    return readdirSync(dir);
  };

  it('提交都在远端上、没有未提交的改动、也搁了两小时：删掉，并说一句', () => {
    const w = world();
    tree(w, 'old-merged');
    expect(listTrees(w)).toContain('old-merged');
    const lines = hook.sweepWorktrees(w.work, git, Date.now() + 121 * 60_000);
    expect(listTrees(w)).not.toContain('old-merged');
    expect(lines.join('\n')).toMatch(/清掉了 1 棵/);
  });

  it('有没提交的改动：留着，并报给人', () => {
    const w = world();
    tree(w, 'has-dirty');
    writeFileSync(join(w.work, '.claude', 'worktrees', 'has-dirty', 'notes.md'), '没提交的东西\n');
    const lines = hook.sweepWorktrees(w.work, git);
    expect(listTrees(w)).toContain('has-dirty');
    expect(lines.join('\n')).toMatch(/还有 1 棵没清.*has-dirty/s);
  });

  it('有没推上去的提交：绝不删（2026-10-02 靠这条救回决定 0006）', () => {
    const w = world();
    tree(w, 'unpushed');
    const dir = join(w.work, '.claude', 'worktrees', 'unpushed');
    writeFileSync(join(dir, 'decision.md'), '# 一个还没进主线的决定\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', '一个还没进主线的决定');
    const lines = hook.sweepWorktrees(w.work, git);
    expect(listTrees(w)).toContain('unpushed');
    expect(lines.join('\n')).toMatch(/还有 1 棵没清.*unpushed/s);
  });

  it('没有这个目录：不出声', () => {
    const w = world();
    expect(hook.sweepWorktrees(w.work, git)).toEqual([]);
  });

  it('跑在非 git 目录里：不出声，不报错', () => {
    const dir = temp('nogit');
    expect(hook.sweepWorktrees(dir, git)).toEqual([]);
  });
});

describe('刚动过的树不碰（可能有人正在里面干活）', SLOW, () => {
  it('刚建出来的树：这一轮不收走', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', 'just-now');
    mkdirSync(join(w.work, '.claude', 'worktrees'), { recursive: true });
    g(w.work, 'worktree', 'add', '-q', '--detach', dir, 'HEAD');
    // 不给 now：用当前时间，树刚建出来
    const lines = hook.sweepWorktrees(w.work, git);
    expect(existsSync(dir)).toBe(true);
    expect(lines.join('\n')).toMatch(/还有 1 棵没清/);
    // 过了两小时再跑：收走
    const later = hook.sweepWorktrees(w.work, git, Date.now() + 121 * 60_000);
    expect(existsSync(dir)).toBe(false);
    expect(later.join('\n')).toMatch(/清掉了 1 棵/);
  });

  it('【故意造出的失败】树根那一层很久没动、但刚在里面提交过：不收走（2026-10-05 一棵正在用的树就是只看树根被删成空壳的）', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', 'in-use');
    mkdirSync(join(w.work, '.claude', 'worktrees'), { recursive: true });
    g(w.work, 'worktree', 'add', '-q', '-b', 'in-use', dir, 'HEAD');
    g(dir, 'push', '-q', 'origin', 'in-use'); // 提交都在远端上、也没有未提交的改动：前三条全过
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(dir, old, old); // 树根三小时没动；管理目录里的 index、HEAD 是刚写的
    const lines = hook.sweepWorktrees(w.work, git);
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(lines.join('\n')).toMatch(/还有 1 棵没清.*in-use/s);
  });
});

// #1016：工人脱离会话跑，被强杀、卡死、做完都不会通知谁——由开会话钩子看一眼，不靠工人自己活着来报
describe('本机独立工人现在怎样（worker.mjs 起的）', () => {
  const NOW = Date.parse('2026-10-05T06:00:00Z');
  function worker(home: string, name: string, meta: Record<string, unknown>, out = ''): void {
    const dir = join(home, '.fleet-dao', 'workers', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'out.log'), out);
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        name,
        pid: 4242,
        startedAt: '2026-10-05T05:30:00Z',
        outLog: join(dir, 'out.log'),
        worktree: `/w/fd-w-${name}`,
        ...meta,
      }),
    );
  }
  const dead = () => false;
  const live = () => true;

  it('这台没起过工人：不出声', () => {
    expect(hook.workerLines(temp('home'), NOW, dead)).toEqual([]);
  });

  it('不在跑了、最后一句不是「完成」：报没交活，带最后一句和工作树', () => {
    const home = temp('home');
    worker(home, 'w1', {}, '改到一半\n卡住：CI 红修不动\n');
    const lines = hook.workerLines(home, NOW, dead);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/工人 w1 不在跑了、也没交活（最后一句：卡住：CI 红修不动）/);
    expect(lines[0]).toContain('/w/fd-w-w1');
  });

  it('【故意造出的失败】被强杀、一个字没输出：照样报没交活，不当成没事', () => {
    const home = temp('home');
    worker(home, 'w2', {});
    expect(hook.workerLines(home, NOW, dead)[0]).toMatch(/工人 w2 不在跑了、也没交活（最后一句：没有输出）/);
  });

  it('做完了没收拾：提一句去 clean；clean 过的不再提', () => {
    const home = temp('home');
    worker(home, 'w3', {}, '完成：PR #1234\n');
    worker(home, 'w4', { cleanedAt: '2026-10-05T05:50:00Z' }, '完成：PR #1235\n');
    const lines = hook.workerLines(home, NOW, dead);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/工人 w3 做完了（完成：PR #1234）.*clean --name w3/);
  });

  it('还在跑：三小时以内不出声，超过了提一句', () => {
    const home = temp('home');
    worker(home, 'w5', {});
    expect(hook.workerLines(home, NOW, live)).toEqual([]);
    worker(home, 'w6', { startedAt: '2026-10-05T02:00:00Z' });
    expect(hook.workerLines(home, NOW, live).join('\n')).toMatch(/工人 w6 跑了 240 分钟还没退/);
  });

  it('【故意造出的失败】记录坏了、没记上进程号：明说没查成，不当成没有工人', () => {
    const home = temp('home');
    mkdirSync(join(home, '.fleet-dao', 'workers', 'bad'), { recursive: true });
    writeFileSync(join(home, '.fleet-dao', 'workers', 'bad', 'meta.json'), '{不是 JSON');
    worker(home, 'nopid', { pid: null });
    const text = hook.workerLines(home, NOW, dead).join('\n');
    expect(text).toMatch(/工人 bad 的记录没查成/);
    expect(text).toMatch(/工人 nopid 起的时候没记上进程号/);
  });
});

describe('删到一半留下的空壳（目录在、.git 没了）', SLOW, () => {
  it('搁了两小时以上的空壳：清掉并说一句——留着它，在里面跑的 git 会落到主检出上', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', 'half-gone');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}\n');
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(dir, old, old);
    const lines = hook.sweepWorktrees(w.work, git);
    expect(existsSync(dir)).toBe(false);
    expect(lines.join('\n')).toMatch(/清掉了 1 个以前删到一半留下的工作树空壳/);
  });

  it('刚建的没有 .git 的目录：不碰（git worktree add 是先建目录、后写 .git）', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', 'being-made');
    mkdirSync(dir, { recursive: true });
    expect(hook.sweepWorktrees(w.work, git)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('真的工作树（有 .git）不当空壳删', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', 'real');
    mkdirSync(join(w.work, '.claude', 'worktrees'), { recursive: true });
    g(w.work, 'worktree', 'add', '-q', '--detach', dir, 'HEAD');
    writeFileSync(join(dir, 'notes.md'), '没提交的东西\n');
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(dir, old, old);
    hook.sweepWorktrees(w.work, git);
    expect(existsSync(join(dir, 'notes.md'))).toBe(true);
  });
});

// #1007：有没提交的改动或没推的提交就有主（刚动过也算；两小时只挡住干净树的删除）。
// 不删（2026-10-02 靠这条救回决定 0006），记成指挥官的认领，下次开会话再读同一条期限。
// 查不出、记不上就照实说；已经认领过的，这一轮没查成不撤认领，不当成处理了。
describe('有活的残留树：有主，不是只打一行', SLOW, () => {
  function tree(w: ReturnType<typeof world>, name: string): string {
    const dir = join(w.work, '.claude', 'worktrees', name);
    mkdirSync(join(w.work, '.claude', 'worktrees'), { recursive: true });
    g(w.work, 'worktree', 'add', '-q', '--detach', dir, 'HEAD');
    return name;
  }
  const ledgerPath = (home: string) => join(home, '.fleet-dao', 'kept-worktrees.json');
  interface Claim {
    name?: string;
    owner?: string;
    why?: string;
    firstSeen?: string;
    deadline?: string;
  }
  const readLedger = (home: string): { claims: Claim[] } =>
    JSON.parse(readFileSync(ledgerPath(home), 'utf8')) as { claims: Claim[] };

  it('搁过两小时、里面还有活：不删，记成指挥官的认领（下次开会话接着报同一条期限）', () => {
    const w = world();
    const name = tree(w, 'has-dirty');
    const dir = join(w.work, '.claude', 'worktrees', name);
    writeFileSync(join(dir, 'notes.md'), '没提交的东西\n');
    const now = Date.now() + 3 * 60 * 60_000;
    const lines = hook.sweepWorktrees(w.work, git, now, w.home);
    expect(existsSync(dir)).toBe(true);
    const text = lines.join('\n');
    expect(text).toMatch(
      /残留工作树 has-dirty 有主：指挥官，\d{4}-\d{2}-\d{2} \d{2}:\d{2} 北京时间前处理（没提交的改动）/,
    );
    expect(text).toContain('kept-worktrees.json');
    expect(text).not.toMatch(/还有 \d+ 棵没清/);
    const claim = readLedger(w.home).claims[0];
    expect(claim?.owner).toBe('指挥官');
    expect(claim?.why).toBe('没提交的改动');
    expect(Date.parse(String(claim?.deadline)) - Date.parse(String(claim?.firstSeen))).toBe(24 * 60 * 60_000);
    expect(claim?.firstSeen).toBe(new Date(now).toISOString());

    const again = hook.sweepWorktrees(w.work, git, now + 60 * 60_000, w.home);
    expect(readLedger(w.home).claims[0]?.deadline).toBe(claim?.deadline);
    expect(again.join('\n')).toMatch(/残留工作树 has-dirty 有主：指挥官/);

    const overdue = hook.sweepWorktrees(w.work, git, now + 25 * 60 * 60_000, w.home);
    expect(existsSync(dir)).toBe(true);
    expect(overdue.join('\n')).toMatch(
      /残留工作树 has-dirty 过了期限还没处理：负责人仍是指挥官（没提交的改动/,
    );
  });

  it('有没推上去的提交、搁过两小时：同样记上，不删', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', tree(w, 'unpushed'));
    writeFileSync(join(dir, 'decision.md'), '# 还没进远端\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', '一个还没进远端的决定');
    const lines = hook.sweepWorktrees(w.work, git, Date.now() + 3 * 60 * 60_000, w.home);
    expect(existsSync(dir)).toBe(true);
    expect(lines.join('\n')).toMatch(/残留工作树 unpushed 有主：指挥官，.*前处理（没推上去的提交）/);
  });

  it('刚动过、但已有没提交的改动：不删，记上认领（负责人、期限），不是只打一行', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', tree(w, 'just-dirty'));
    writeFileSync(join(dir, 'notes.md'), '正在写\n');
    const now = Date.now();
    const lines = hook.sweepWorktrees(w.work, git, now, w.home);
    expect(existsSync(dir)).toBe(true);
    const text = lines.join('\n');
    expect(text).toMatch(
      /残留工作树 just-dirty 有主：指挥官，\d{4}-\d{2}-\d{2} \d{2}:\d{2} 北京时间前处理（没提交的改动）/,
    );
    expect(text).not.toMatch(/还有 \d+ 棵没清/);
    const claim = readLedger(w.home).claims[0];
    expect(claim?.owner).toBe('指挥官');
    expect(claim?.why).toBe('没提交的改动');
    expect(Date.parse(String(claim?.deadline)) - Date.parse(String(claim?.firstSeen))).toBe(24 * 60 * 60_000);
    expect(claim?.firstSeen).toBe(new Date(now).toISOString());
  });

  it('刚动过、但有没推上去的提交：不删，同样记上认领', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', tree(w, 'just-unpushed'));
    writeFileSync(join(dir, 'decision.md'), '# 还没进远端\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', '一个还没进远端的决定');
    const lines = hook.sweepWorktrees(w.work, git, Date.now(), w.home);
    expect(existsSync(dir)).toBe(true);
    expect(lines.join('\n')).toMatch(/残留工作树 just-unpushed 有主：指挥官，.*前处理（没推上去的提交）/);
  });

  it('刚动过、提交都在远端、也没有未提交的改动：不删，也不派认领（可能有人正在用）', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', tree(w, 'just-clean'));
    const lines = hook.sweepWorktrees(w.work, git, Date.now(), w.home);
    expect(existsSync(dir)).toBe(true);
    expect(lines.join('\n')).toMatch(/还有 1 棵没清.*just-clean/s);
    expect(lines.join('\n')).not.toMatch(/有主/);
    expect(existsSync(ledgerPath(w.home))).toBe(false);
  });

  it('活推上去、树也干净了：收走这棵树，认领跟着撤', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', 'pushed');
    mkdirSync(join(w.work, '.claude', 'worktrees'), { recursive: true });
    g(w.work, 'worktree', 'add', '-q', '-b', 'pushed', dir, 'HEAD');
    writeFileSync(join(dir, 'decision.md'), '# 要推上去\n');
    g(dir, 'add', '-A');
    g(dir, 'commit', '-q', '-m', '推上去就没事');
    const now = Date.now() + 3 * 60 * 60_000;
    hook.sweepWorktrees(w.work, git, now, w.home);
    expect(readLedger(w.home).claims.map((c) => c.name)).toContain('pushed');
    g(dir, 'push', '-q', 'origin', 'pushed');
    const lines = hook.sweepWorktrees(w.work, git, now + 1000, w.home);
    expect(existsSync(dir)).toBe(false);
    expect(lines.join('\n')).toMatch(/清掉了 1 棵/);
    expect(readLedger(w.home).claims.filter((c) => c.name === 'pushed')).toEqual([]);
  });

  it('【故意造出的失败】git status 没跑成：明说没查成，不当成有主，也不删', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', tree(w, 'has-dirty'));
    writeFileSync(join(dir, 'notes.md'), '没提交的东西\n');
    const failing: Git = (cwd, args) =>
      args.includes('status') ? { status: 1, stdout: '', stderr: 'status exploded' } : git(cwd, args);
    const lines = hook.sweepWorktrees(w.work, failing, Date.now() + 3 * 60 * 60_000, w.home);
    expect(existsSync(dir)).toBe(true);
    expect(lines.join('\n')).toMatch(
      /工作树 has-dirty 没查成（git status 没跑成（status exploded）），不当成已经有人负责，也没删/,
    );
    expect(lines.join('\n')).not.toMatch(/有主/);
    expect(existsSync(ledgerPath(w.home))).toBe(false);
  });

  it('【故意造出的失败】已经认领的树这一轮 git status 没跑成：原认领留着，不当成处理了，也不删', () => {
    const w = world();
    const stuck = join(w.work, '.claude', 'worktrees', tree(w, 'stuck'));
    writeFileSync(join(stuck, 'notes.md'), '没提交的东西\n');
    const now = Date.now() + 3 * 60 * 60_000;
    hook.sweepWorktrees(w.work, git, now, w.home);
    const before = readLedger(w.home).claims.find((c) => c.name === 'stuck');
    expect(before?.owner).toBe('指挥官');

    const also = join(w.work, '.claude', 'worktrees', tree(w, 'also-dirty'));
    writeFileSync(join(also, 'notes.md'), '另一棵的活\n');
    // git 的 cwd 永远是主检出，工作树在 -C 后面
    const failing: Git = (cwd, args) =>
      args.includes('status') && args.some((a) => a.endsWith('/stuck') || a.endsWith('\\stuck'))
        ? { status: 1, stdout: '', stderr: 'status exploded' }
        : git(cwd, args);
    const lines = hook.sweepWorktrees(w.work, failing, now + 60 * 60_000, w.home);
    expect(existsSync(stuck)).toBe(true);
    const text = lines.join('\n');
    expect(text).toMatch(
      /工作树 stuck 没查成（git status 没跑成（status exploded）），原认领还在：负责人仍是指挥官，\d{4}-\d{2}-\d{2} \d{2}:\d{2} 北京时间前处理（没提交的改动）。不当成已经处理了，也没删/,
    );
    expect(text).toMatch(/残留工作树 also-dirty 有主：指挥官/);
    const claims = readLedger(w.home).claims;
    const after = claims.find((c) => c.name === 'stuck');
    expect(after?.owner).toBe('指挥官');
    expect(after?.deadline).toBe(before?.deadline);
    expect(after?.firstSeen).toBe(before?.firstSeen);
    expect(after?.why).toBe('没提交的改动');
    expect(claims.some((c) => c.name === 'also-dirty')).toBe(true);
  });

  it('【故意造出的失败】已经认领的树这一轮最后动过的时间没查成：原认领留着，不当成没有主', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', tree(w, 'stuck'));
    writeFileSync(join(dir, 'notes.md'), '没提交的东西\n');
    const now = Date.now() + 3 * 60 * 60_000;
    hook.sweepWorktrees(w.work, git, now, w.home);
    const before = readLedger(w.home).claims.find((c) => c.name === 'stuck');
    expect(before?.deadline).toBeTruthy();

    const failing: Git = (cwd, args) =>
      args.includes('--absolute-git-dir')
        ? { status: 1, stdout: '', stderr: 'git-dir exploded' }
        : git(cwd, args);
    const lines = hook.sweepWorktrees(w.work, failing, now + 60 * 60_000, w.home);
    expect(existsSync(dir)).toBe(true);
    expect(lines.join('\n')).toMatch(
      /工作树 stuck 没查成（最后动过的时间没查成），原认领还在：负责人仍是指挥官/,
    );
    expect(lines.join('\n')).toMatch(/不当成已经处理了，也没删/);
    const after = readLedger(w.home).claims.find((c) => c.name === 'stuck');
    expect(after?.owner).toBe('指挥官');
    expect(after?.deadline).toBe(before?.deadline);
    expect(after?.firstSeen).toBe(before?.firstSeen);
  });

  it('【故意造出的失败】认领清单记不上：照实说没记上，不当成有主，也不删', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', tree(w, 'has-dirty'));
    writeFileSync(join(dir, 'notes.md'), '没提交的东西\n');
    writeFileSync(join(w.home, '.fleet-dao'), 'not-a-dir\n');
    const lines = hook.sweepWorktrees(w.work, git, Date.now() + 3 * 60 * 60_000, w.home);
    expect(existsSync(dir)).toBe(true);
    expect(lines.join('\n')).toMatch(/残留工作树 has-dirty 认领没记上（.+），不当成已经有人负责，也没删/);
    expect(lines.join('\n')).not.toMatch(/有主/);
    expect(readFileSync(join(w.home, '.fleet-dao'), 'utf8')).toBe('not-a-dir\n');
  });

  it('认领清单不是 JSON：没查成，不覆盖原文件，不当成有主', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', tree(w, 'has-dirty'));
    writeFileSync(join(dir, 'notes.md'), '没提交的东西\n');
    mkdirSync(join(w.home, '.fleet-dao'));
    writeFileSync(ledgerPath(w.home), '{不是\n');
    const lines = hook.sweepWorktrees(w.work, git, Date.now() + 3 * 60 * 60_000, w.home);
    expect(existsSync(dir)).toBe(true);
    expect(lines.join('\n')).toMatch(/认领没记上（不是 JSON），不当成已经有人负责，也没删/);
    expect(lines.join('\n')).not.toMatch(/有主/);
    expect(readFileSync(ledgerPath(w.home), 'utf8')).toBe('{不是\n');
  });

  it('【故意造出的失败】列不出工作树：明说没列成，认领清单不动，不当成没有残留', () => {
    const w = world();
    mkdirSync(join(w.home, '.fleet-dao'), { recursive: true });
    writeFileSync(ledgerPath(w.home), '{"version":1,"claims":[]}\n');
    const failing: Git = (cwd, args) =>
      args[0] === 'worktree' && args[1] === 'list'
        ? { status: 1, stdout: '', stderr: 'list exploded' }
        : git(cwd, args);
    const lines = hook.sweepWorktrees(w.work, failing, Date.now(), w.home);
    expect(lines.join('\n')).toMatch(/工作树没列成（list exploded），认领清单没动，不当成已经没有残留/);
    expect(readFileSync(ledgerPath(w.home), 'utf8')).toBe('{"version":1,"claims":[]}\n');
  });

  it('开会话把认领说进上下文（本机这半的读方就是下一次开会话）', () => {
    const w = world();
    const dir = join(w.work, '.claude', 'worktrees', tree(w, 'has-dirty'));
    writeFileSync(join(dir, 'notes.md'), '没提交的东西\n');
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const lines = hook.sessionStart({
      cwd: w.work,
      home: w.home,
      git,
      sync: fakeSync().sync,
      now: Date.now() + 3 * 60 * 60_000,
    });
    expect(lines.join('\n')).toMatch(/残留工作树 has-dirty 有主：指挥官/);
  });
});

// 第 4 件：绿了没挂自动合并的 PR（pnpm pr:open 的兜底）。查的是 packages/conventions/src/bin/pr-idle.ts，硬超时；
// gh 没查成、超时、输出认不出都说一行没查成，不当成「没有」，也不挡开会话。
describe('绿了没挂自动合并的 PR：只在 fleet-dao 里提醒，没查成不当成没有', SLOW, () => {
  // 替身脚本只要真存在（钩子先看它在不在）；真脚本的判法在 packages/conventions/test/pr-open.test.ts 里测
  const IDLE = HOOK;
  const fetched: Fetch = { common: null, ok: true, why: '' };
  function fleetRepo(): string {
    const dir = repo({});
    g(dir, 'remote', 'add', 'origin', 'https://github.com/thoerwink8/fleet-dao.git');
    return dir;
  }
  function fakeRun(result: Partial<Result>) {
    const calls: [string, string][] = [];
    const run: ScriptRun = (script, r) => {
      calls.push([script, r]);
      return { status: 0, stdout: '', stderr: '', ...result };
    };
    return { run, calls };
  }
  const idle = (...numbers: number[]) =>
    JSON.stringify({ idle: numbers.map((number) => ({ number, title: `t${number}` })) });

  it('不是 fleet-dao 的检出、不是 git 仓：不查、不出声', () => {
    const w = world();
    const f = fakeRun({ stdout: idle(1) });
    expect(hook.checkIdlePrs({ cwd: w.work, git, run: f.run, fetch: fetched, mirror: IDLE })).toEqual([]);
    expect(hook.checkIdlePrs({ cwd: temp('plain'), git, run: f.run, fetch: null, mirror: IDLE })).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('有绿了没挂的：一行列 PR 号和怎么挂；没有不出声', () => {
    const dir = fleetRepo();
    const f = fakeRun({ stdout: idle(1031, 1032) });
    const lines = hook.checkIdlePrs({ cwd: dir, git, run: f.run, fetch: fetched, mirror: IDLE });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('绿了没挂自动合并的 PR 2 个：#1031、#1032');
    expect(lines[0]).toContain('gh pr merge <号> --auto --squash');
    expect(f.calls.map(([script]) => script)).toEqual([IDLE]);
    expect(
      hook.checkIdlePrs({
        cwd: dir,
        git,
        run: fakeRun({ stdout: idle() }).run,
        fetch: fetched,
        mirror: IDLE,
      }),
    ).toEqual([]);
  });

  it('【故意造出的失败】gh 没查成（脚本退出 2）、超时、取不到远端：说一行没查成，不当成没有', () => {
    const dir = fleetRepo();
    const broken = fakeRun({
      status: 2,
      stderr: 'gh pr list 退出码 1：error connecting to api.github.com\n',
    });
    expect(hook.checkIdlePrs({ cwd: dir, git, run: broken.run, fetch: fetched, mirror: IDLE })).toEqual([
      '绿了没挂自动合并的 PR 没查成：gh pr list 退出码 1：error connecting to api.github.com。',
    ]);
    const slow = fakeRun({
      status: null,
      error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      timeoutMs: 8_000,
    });
    expect(hook.checkIdlePrs({ cwd: dir, git, run: slow.run, fetch: fetched, mirror: IDLE })).toEqual([
      '绿了没挂自动合并的 PR 没查成：超过 8 秒没完。',
    ]);
    const offline = fakeRun({ stdout: idle(1) });
    expect(
      hook.checkIdlePrs({
        cwd: dir,
        git,
        run: offline.run,
        fetch: { common: null, ok: false, why: '超过 15 秒没完' },
        mirror: IDLE,
      }),
    ).toEqual(['绿了没挂自动合并的 PR 没查成：取不到远端（超过 15 秒没完）。']);
    expect(offline.calls).toEqual([]);
  });

  it('【故意造出的失败】输出认不出、少了 idle、找不到脚本：没查成', () => {
    const dir = fleetRepo();
    const run = (stdout: string) =>
      hook.checkIdlePrs({ cwd: dir, git, run: fakeRun({ stdout }).run, fetch: fetched, mirror: IDLE })[0];
    expect(run('不是 JSON')).toMatch(/^绿了没挂自动合并的 PR 没查成：pr-idle\.ts 的输出认不出/);
    expect(run('{}')).toMatch(/少了 idle 列表/);
    expect(run('{"idle":[{"title":"x"}]}')).toMatch(/少了 idle 列表/);
    const f = fakeRun({ stdout: idle() });
    const lines = hook.checkIdlePrs({
      cwd: dir,
      git,
      run: f.run,
      fetch: fetched,
      mirror: join(dir, 'nope.ts'),
    });
    // 镜像里没有就用会话所在检出里的；那里也没有（这个临时仓里没有）就说没查成
    expect(lines).toEqual(['绿了没挂自动合并的 PR 没查成：找不到 packages/conventions/src/bin/pr-idle.ts。']);
    expect(f.calls).toEqual([]);
  });

  it('【故意造出的失败】真起脚本、硬超时：到点杀掉、说没查成，不拖着开会话', () => {
    const dir = fleetRepo();
    const sleeper = join(temp('idle-sleeper'), 'sleep.mjs');
    writeFileSync(sleeper, 'setTimeout(() => {}, 20_000);\n');
    const started = Date.now();
    const lines = hook.checkIdlePrs({
      cwd: dir,
      git,
      run: hook.idlePrRunner(1_000),
      fetch: fetched,
      mirror: sleeper,
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(lines).toEqual(['绿了没挂自动合并的 PR 没查成：超过 1 秒没完。']);
    expect(hook.IDLE_PR_MS).toBe(8_000);
  });
});

describe('fleet-dao 的创始人引导在进度单 #1055 上（开会话钩子读它）', SLOW, () => {
  const SCRIPT = HOOK;
  function fleetRepo(): string {
    const dir = repo({});
    g(dir, 'remote', 'add', 'origin', 'https://github.com/thoerwink8/fleet-dao.git');
    return dir;
  }
  function fakeRun(result: Partial<Result>) {
    const calls: [string, string][] = [];
    const run: ScriptRun = (script, r) => {
      calls.push([script, r]);
      return { status: 0, stdout: '', stderr: '', ...result };
    };
    return { run, calls };
  }
  const row = (id: number, head: string, text: string) => `${id}\t${head}\t${text}\n`;
  const check = (dir: string, run: ScriptRun, mirror: string | null = SCRIPT) =>
    hook.checkProgressIssue({ cwd: dir, git, run, mirror });

  it('不是 fleet-dao 的检出、不是 git 仓：不查、不出声', () => {
    const f = fakeRun({ stdout: row(1, '【创始人引导·待处理】x', '原话：y') });
    expect(check(world().work, f.run)).toEqual([]);
    expect(check(temp('plain-progress'), f.run)).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('有待处理的：一行写条数、评论号、原话开头；没有不出声', () => {
    const dir = fleetRepo();
    const f = fakeRun({
      stdout:
        row(11, '【创始人引导·待处理】2026-10-05 17:50', '原话：太慢了，我建议优先gpt6luna，不行就grok') +
        row(12, '【创始人引导·待处理】2026-10-05 17:05', '原话：都按照你推荐'),
    });
    const lines = check(dir, f.run);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('创始人引导还有 2 条没处理（进度单 #1055）');
    expect(lines[0]).toContain('11（2026-10-05 17:50）太慢了');
    expect(lines[0]).toContain('pnpm progress:done');
    expect(f.calls.map(([script]) => script)).toEqual([SCRIPT]);
    expect(check(dir, fakeRun({ stdout: '' }).run)).toEqual([]);
  });

  it('【故意造出的失败】脚本退出 2（gh 没成）、超时、输出认不出、找不到脚本：说一行没查成，不当成没有待办', () => {
    const dir = fleetRepo();
    expect(check(dir, fakeRun({ status: 2, stderr: 'gh 读 #1055 的评论报错：network down\n' }).run)).toEqual([
      '创始人引导（进度单 #1055）没查成：gh 读 #1055 的评论报错：network down。',
    ]);
    const slow = fakeRun({
      status: null,
      error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      timeoutMs: 8_000,
    });
    expect(check(dir, slow.run)).toEqual(['创始人引导（进度单 #1055）没查成：超过 8 秒没完。']);
    expect(check(dir, fakeRun({ stdout: '乱七八糟\n' }).run)[0]).toMatch(/没查成：progress\.ts 的输出认不出/);
    const f = fakeRun({ stdout: row(1, 'h', 't') });
    expect(check(dir, f.run, join(dir, 'nope.ts'))).toEqual([
      '创始人引导（进度单 #1055）没查成：找不到 packages/conventions/src/bin/progress.ts。',
    ]);
    expect(f.calls).toEqual([]);
  });

  it('【故意造出的失败】真起脚本、硬超时：到点杀掉、说没查成，不拖着开会话', () => {
    const dir = fleetRepo();
    const sleeper = join(temp('progress-sleeper'), 'sleep.mjs');
    writeFileSync(sleeper, 'setTimeout(() => {}, 20_000);\n');
    const started = Date.now();
    const lines = check(dir, hook.progressRunner(1_000), sleeper);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(lines).toEqual(['创始人引导（进度单 #1055）没查成：超过 1 秒没完。']);
    expect(hook.PROGRESS_MS).toBe(8_000);
  });
});

describe('创始人最近落盘的话（上一个会话没送到的，新会话开场能看到）', () => {
  const NOW = Date.parse('2026-10-04T11:30:00Z');
  const rec = (dir: string, day: string, rows: unknown[]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${day}.jsonl`), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  };
  const recent = (o: { home: string; now?: number; dir?: string | null; sessionId?: string | null }) =>
    (hook as unknown as { recentPrompts(o: unknown): string[] }).recentPrompts(o);

  it('最近 1 小时内的话列出来，带北京时间；更早的、将来的不列', () => {
    const home = temp('rp-home');
    rec(join(home, '.fleet-dao', 'prompt-log'), '2026-10-04', [
      { at: '2026-10-04T08:00:00Z', prompt: '三个半小时前的话' },
      { at: '2026-10-04T11:21:00Z', prompt: '你能接收到我这条消息吗？我发了hi' },
      { at: '2026-10-04T11:29:00Z', prompt: '你改好了没有？' },
      { at: '2026-10-04T13:00:00Z', prompt: '时钟乱了才会有的将来的话' },
    ]);
    const [line] = recent({ home, now: NOW });
    expect(line).toContain('共 2 条');
    expect(line).toContain('［19:21］你能接收到我这条消息吗？我发了hi');
    expect(line).toContain('［19:29］你改好了没有？');
    expect(line).not.toContain('三个半小时前');
    expect(line).not.toContain('将来的话');
  });

  it('跨零点：23:50 的话在 00:10 开会话时还在前一天的文件里，要列出来', () => {
    const home = temp('rp-home');
    const dir = join(home, '.fleet-dao', 'prompt-log');
    rec(dir, '2026-10-04', [{ at: '2026-10-04T15:50:00Z', prompt: '北京 23:50 那条' }]);
    const now = Date.parse('2026-10-04T16:10:00Z'); // 北京 10-05 00:10
    expect(recent({ home, now })[0]).toContain('北京 23:50 那条');
  });

  it('不再限最后 5 条：本会话没见过的全列，每条截到 200 字', () => {
    const home = temp('rp-home');
    const rows = Array.from({ length: 8 }, (_, i) => ({
      at: new Date(NOW - (8 - i) * 60_000).toISOString(),
      prompt: i === 7 ? 'x'.repeat(500) : `第${i}条`,
    }));
    rec(join(home, '.fleet-dao', 'prompt-log'), '2026-10-04', rows);
    const [line] = recent({ home, now: NOW });
    expect(line).toContain('共 8 条；');
    for (const i of [0, 1, 2, 3, 4, 5, 6]) expect(line).toContain(`第${i}条`);
    expect(line).toContain(`${'x'.repeat(200)}……`);
    expect(line).not.toContain('x'.repeat(201));
  });

  it('总字数封顶：超了留最新的、写明封顶只列几条；再长的最新一条也留着', () => {
    const home = temp('rp-home');
    // 每条截断后 200 字 + 前缀，3000 封顶装不下 20 条
    const rows = Array.from({ length: 20 }, (_, i) => ({
      at: new Date(NOW - (20 - i) * 60_000).toISOString(),
      prompt: `${String(i).padStart(2, '0')}${'字'.repeat(300)}`,
    }));
    rec(join(home, '.fleet-dao', 'prompt-log'), '2026-10-04', rows);
    const [line] = recent({ home, now: NOW });
    expect(line).toMatch(/共 20 条，字数封顶只列最新 (\d+) 条/);
    const shown = Number(/只列最新 (\d+) 条/.exec(line ?? '')?.[1]);
    expect(shown).toBeGreaterThan(5);
    expect(shown).toBeLessThan(20);
    expect(line).toContain('19字'); // 最新的在
    expect(line).not.toContain('［19:10］00字'); // 最早的被封顶挤掉
    expect((line ?? '').length).toBeLessThan(hook.RECENT_TOTAL_CHARS + 400);
  });

  it('本会话自己落盘的话不再列（它早见过）；别的会话的照列', () => {
    const home = temp('rp-home');
    rec(join(home, '.fleet-dao', 'prompt-log'), '2026-10-04', [
      { at: '2026-10-04T11:20:00Z', sessionId: 'other', prompt: '别的会话里他说的话' },
      { at: '2026-10-04T11:25:00Z', sessionId: 'me', prompt: '本会话里他说过的话' },
    ]);
    const line = recent({ home, now: NOW, sessionId: 'me' }).join('\n');
    expect(line).toContain('别的会话里他说的话');
    expect(line).not.toContain('本会话里他说过的话');
    expect(line).toContain('共 1 条');
  });

  it('机器派的会话的提示不算他的话：反方、工人工作树里起的会话（10-05 之前已落盘的也滤掉）；真话不被挤出', () => {
    const home = temp('rp-home');
    rec(join(home, '.fleet-dao', 'prompt-log'), '2026-10-04', [
      { at: '2026-10-04T11:10:00Z', prompt: '创始人真说的话', cwd: 'D:\\frank\\fleet-dao' },
      { at: '2026-10-04T11:22:00Z', prompt: '你是「反方」：一个全新会话，另一家模型。', cwd: 'D:\\x' },
      {
        at: '2026-10-04T11:23:00Z',
        prompt: '派活的交代：在 _tmp 写一行 hi',
        cwd: 'D:\\frank\\fleet-dao\\.claude\\worktrees\\w-speed-a',
      },
      { at: '2026-10-04T11:25:00Z', prompt: '创始人又说的一句话', cwd: '/r/.claude/worktrees/939-drop-asks' },
    ]);
    const line = recent({ home, now: NOW }).join('\n');
    expect(line).toContain('共 2 条；');
    expect(line).toContain('创始人真说的话');
    expect(line).toContain('创始人又说的一句话');
    for (const bad of ['反方', '派活的交代']) expect(line).not.toContain(bad);
  });

  it('没有文件、没有最近的话：不出声；坏的一行跳过、不连累别的', () => {
    const home = temp('rp-home');
    expect(recent({ home, now: NOW })).toEqual([]);
    const dir = join(home, '.fleet-dao', 'prompt-log');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-10-04.jsonl'),
      `{坏了\n${JSON.stringify({ at: '2026-10-04T11:29:00Z', prompt: '好的那条' })}\n`,
    );
    expect(recent({ home, now: NOW })[0]).toContain('好的那条');
  });

  it('【故意造出的失败】文件在但读不了（那一天的路径是个目录）：明说没读成，不当成「没有话」', () => {
    const home = temp('rp-home');
    mkdirSync(join(home, '.fleet-dao', 'prompt-log', '2026-10-04.jsonl'), { recursive: true });
    const [line] = recent({ home, now: NOW });
    expect(line).toMatch(/创始人落盘的话没读成.*读不了/);
  });
});

describe('创始人最近落盘的话：系统消息不算', () => {
  it('后台任务通知、系统提醒（也走 UserPromptSubmit，落盘时原样记）不列；只剩系统消息就不出声', () => {
    const NOW = Date.parse('2026-10-04T11:30:00Z');
    const home = temp('rp-sys');
    const dir = join(home, '.fleet-dao', 'prompt-log');
    mkdirSync(dir, { recursive: true });
    const rows = [
      { at: '2026-10-04T11:28:00Z', prompt: '<task-notification>\n<task-id>x</task-id>' },
      { at: '2026-10-04T11:28:30Z', prompt: '<system-reminder>\nfoo' },
      { at: '2026-10-04T11:29:00Z', prompt: '[SYSTEM NOTIFICATION - NOT USER INPUT]\nbar' },
    ];
    writeFileSync(join(dir, '2026-10-04.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
    const recent = (hook as unknown as { recentPrompts(o: unknown): string[] }).recentPrompts;
    expect(recent({ home, now: NOW })).toEqual([]);
    writeFileSync(
      join(dir, '2026-10-04.jsonl'),
      `${rows.map((r) => JSON.stringify(r)).join('\n')}\n${JSON.stringify({ at: '2026-10-04T11:29:30Z', prompt: '创始人真说的话' })}\n`,
    );
    const [line] = recent({ home, now: NOW });
    expect(line).toContain('共 1 条');
    expect(line).toContain('创始人真说的话');
    expect(line).not.toContain('task-notification');
  });
});

describe('发了没收到的话：拿 Mirasim 的「发了的账」和 prompt-log 的「收到的账」对（创始人 10-06「你好像没接收到【选方案a】」）', () => {
  const NOW = Date.parse('2026-10-06T03:45:00Z'); // 北京 11:45
  const T = (iso: string) => Date.parse(iso);
  const recent = (o: { home: string; now?: number; sessionId?: string | null }) =>
    (hook as unknown as { recentPrompts(o: unknown): string[] }).recentPrompts(o);
  const received = (home: string, rows: unknown[]) => {
    const dir = join(home, '.fleet-dao', 'prompt-log');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-10-06.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  };
  const mirasim = (
    home: string,
    id: string,
    turns: unknown[],
    record: unknown = { workdir: 'D:\\frank\\fleet-dao' },
  ) => {
    const dir = join(home, '.mirasim', 'sessions', 'claude', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'record.json'), JSON.stringify(record));
    writeFileSync(join(dir, 'turns.jsonl'), turns.map((t) => `${JSON.stringify(t)}\n`).join(''));
  };

  it('一轮被打断时攒着的两条引导丢了：列成单独一行、放最前、叫先答；收到过的提问不算丢', () => {
    const home = temp('inbox');
    mirasim(home, 'm1', [
      {
        sessionId: 's1',
        startedAt: T('2026-10-06T03:24:48Z'),
        prompt: 'wsl好像流程关了，你确认下；然后安排优先级多subagent做完',
        steers: [
          { text: '选方案a', at: T('2026-10-06T03:31:37Z') },
          { text: '你好像没接收到【选方案a】，能不能把这个问题修复好', at: T('2026-10-06T03:32:41Z') },
        ],
        error: 'Interrupted by user.',
        incomplete: true,
      },
    ]);
    received(home, [
      {
        at: '2026-10-06T03:24:49Z',
        sessionId: 's1',
        prompt: 'wsl好像流程关了，你确认下；然后安排优先级多subagent做完',
      },
    ]);
    const lines = recent({ home, now: NOW, sessionId: 's1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^创始人发了、但 Claude Code 没收到的话/);
    expect(lines[0]).toContain('共 2 条');
    expect(lines[0]).toContain('［11:31］选方案a');
    expect(lines[0]).toContain('［11:32］你好像没接收到【选方案a】');
    expect(lines[0]).toContain('先答这些');
    expect(lines[0]).not.toContain('wsl好像流程关了');
  });

  it('进程还没起来就被打断的提问也算没收到；收到了、但是别的会话收的照旧列在「落盘的话」那行', () => {
    const home = temp('inbox');
    mirasim(home, 'm1', [
      {
        sessionId: 's1',
        startedAt: T('2026-10-06T03:10:00Z'),
        prompt: '重新用k3，可以多subagent继续接手',
        error: null,
      },
      { sessionId: 's2', startedAt: T('2026-10-06T03:20:00Z'), prompt: '还剩下什么任务', steers: [] },
    ]);
    received(home, [{ at: '2026-10-06T03:20:01Z', sessionId: 's2', prompt: '还剩下什么任务' }]);
    const lines = recent({ home, now: NOW, sessionId: 'me' });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('没收到的话');
    expect(lines[0]).toContain('重新用k3');
    expect(lines[0]).not.toContain('还剩下什么任务');
    expect(lines[1]).toMatch(/^创始人最近 60 分钟落盘的话（共 1 条/);
    expect(lines[1]).toContain('还剩下什么任务');
  });

  it('同一句话发了两次只收到一次：收到的配时间最近的那次；丢的那条他之后原话重发并收到了就不再列，重发之前丢的才列；附图那一行不影响对账', () => {
    const home = temp('inbox');
    const turns = (second: string) => [
      {
        sessionId: 's1',
        startedAt: T('2026-10-06T03:00:00Z'),
        prompt: '开工',
        steers: [
          { text: '进展怎么样？', at: T('2026-10-06T03:05:00Z') },
          { text: '进展怎么样？', at: T(second) },
        ],
      },
    ];
    // 03:05 丢了、03:09 重发收到：不列
    mirasim(home, 'm1', turns('2026-10-06T03:09:00Z'));
    received(home, [
      {
        at: '2026-10-06T03:00:01Z',
        sessionId: 's1',
        prompt: '[The image above is also on disk at: C:\\x.png]\n开工',
      },
      { at: '2026-10-06T03:09:02Z', sessionId: 's1', prompt: '进展怎么样？' },
    ]);
    expect(recent({ home, now: NOW, sessionId: 's1' })).toEqual([]);
    // 03:05 收到、03:09 丢了：列 03:09 那条
    received(home, [
      { at: '2026-10-06T03:00:01Z', sessionId: 's1', prompt: '开工' },
      { at: '2026-10-06T03:05:02Z', sessionId: 's1', prompt: '进展怎么样？' },
    ]);
    const lines = recent({ home, now: NOW, sessionId: 's1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('共 1 条');
    expect(lines[0]).toContain('［11:09］进展怎么样？');
    expect(lines[0]).not.toContain('11:05');
  });

  it('不算他的话：斜杠命令、系统消息、机器派会话（工人工作树）里的、1 小时以前的；没有 Mirasim 目录不出声', () => {
    const home = temp('inbox');
    mirasim(home, 'm1', [
      { sessionId: 's1', startedAt: T('2026-10-06T03:30:00Z'), prompt: '/compact' },
      {
        sessionId: 's1',
        startedAt: T('2026-10-06T03:31:00Z'),
        prompt: '<task-notification>\n<task-id>x</task-id>',
      },
      { sessionId: 's1', startedAt: T('2026-10-06T01:00:00Z'), prompt: '两个多小时前的话' },
    ]);
    mirasim(home, 'w1', [{ sessionId: 'w', startedAt: T('2026-10-06T03:40:00Z'), prompt: '派活的交代' }], {
      workdir: 'D:\\frank\\fleet-dao\\.claude\\worktrees\\w-speed-a',
    });
    expect(recent({ home, now: NOW })).toEqual([]);
    const bare = temp('inbox-bare');
    received(bare, [{ at: '2026-10-06T03:40:00Z', sessionId: 'x', prompt: '只有收到的账' }]);
    const lines = recent({ home: bare, now: NOW });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^创始人最近 60 分钟落盘的话/);
  });

  it('【故意造出的失败】Mirasim 的记录读不了、有行认不出：明说没读全，不当成「没丢」', () => {
    const home = temp('inbox');
    const dir = join(home, '.mirasim', 'sessions', 'claude', 'm1');
    mkdirSync(join(dir, 'turns.jsonl'), { recursive: true }); // 路径是个目录：读不了
    const lines = recent({ home, now: NOW });
    expect(lines[0]).toMatch(/创始人在 Mirasim 里发的话没读全：.*读不了/);
    mirasim(home, 'm2', [{ sessionId: 's', startedAt: T('2026-10-06T03:40:00Z'), prompt: '好的那条' }]);
    writeFileSync(join(home, '.mirasim', 'sessions', 'claude', 'm2', 'turns.jsonl'), '{坏了\n', {
      flag: 'a',
    });
    const again = recent({ home, now: NOW });
    expect(again.some((l) => /1 行认不出/.test(l))).toBe(true);
    expect(again.some((l) => /没收到的话.*好的那条/.test(l))).toBe(true);
  });
});

describe('整池暂停到期（#954）', SLOW, () => {
  const TODAY = '2026-10-05';
  const hold = (over: Record<string, unknown> = {}) => ({
    reason: '创始人要大用独享',
    decidedBy: '「先停」2026-10-05',
    revokeWhen: '创始人说可以用了',
    reviewBy: '2026-10-30',
    ...over,
  });

  it('到期的提示池、原因、去哪撤；没写负责人按指挥官；没到期不出声', () => {
    const lines = hook.poolHoldPromptLines(
      {
        ok: true,
        value: {
          'claude-solo': hold({ reviewBy: '2026-10-01', owner: '张三' }),
          relay: hold(),
        },
      },
      TODAY,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('claude-solo');
    expect(lines[0]).toContain('创始人要大用独享');
    expect(lines[0]).toContain('张三');
    expect(lines[0]).toContain('驾驶舱设置页「整池暂停」');
    expect(lines[0]).not.toContain('relay');
    const bare = hook.poolHoldPromptLines(
      { ok: true, value: { relay: hold({ reviewBy: '2026-10-05' }) } },
      TODAY,
    );
    expect(bare[0]).toContain('负责人：指挥官');
    expect(hook.poolHoldPromptLines({ ok: true, skipped: true }, TODAY)).toEqual([]);
    expect(hook.poolHoldPromptLines({ ok: true, value: undefined }, TODAY)).toEqual([]);
  });

  it('【故意造出的失败】认不出、没查成：明说，不当成没到期', () => {
    const bad = hook.poolHoldPromptLines(
      {
        ok: true,
        value: { 'claude-a': hold({ reviewBy: '2026-02-30' }), relay: hold({ reviewBy: '2026-10-01' }) },
      },
      TODAY,
    );
    expect(bad.join('\n')).toContain('认不出');
    expect(bad.join('\n')).toContain('claude-a');
    expect(bad.join('\n')).toContain('整池暂停到期：relay');
    expect(hook.poolHoldPromptLines({ ok: false, why: '连不上法国（退出码 255）' }, TODAY)).toEqual([
      '整池暂停没查成：连不上法国（退出码 255）。有没有到期的不知道。',
    ]);
    expect(hook.poolHoldPromptLines({ ok: true, value: '停' }, TODAY)[0]).toContain('整份认不出');
  });

  it('【故意造出的失败】没配登法国的 ssh：不出声，也不去 ssh；名字坏了、连不上的原因里不带那个名字', () => {
    const home = temp('holds');
    let spawned = 0;
    const spawn = () => {
      spawned += 1;
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(hook.readFrancePoolHolds({ home, now: 1, spawn })).toEqual({ ok: true, skipped: true });
    expect(spawned).toBe(0);
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    writeFileSync(join(home, '.fleet-dao', 'france-ssh'), '-evil-host\n');
    const badName = hook.readFrancePoolHolds({ home, now: 2, spawn });
    expect(badName.ok).toBe(false);
    expect(JSON.stringify(badName)).not.toContain('-evil-host');
    expect(spawned).toBe(0);
    writeFileSync(join(home, '.fleet-dao', 'france-ssh'), 'france-box\n');
    const down = hook.readFrancePoolHolds({
      home,
      now: 3,
      spawn: () => ({
        status: 255,
        stdout: '',
        stderr: 'ssh: connect to host france-box port 22: Connection refused\n',
      }),
    });
    expect(down.ok).toBe(false);
    expect(JSON.stringify(down)).not.toContain('france-box');
    let second = 0;
    hook.readFrancePoolHolds({
      home,
      now: 4,
      spawn: () => {
        second += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(second).toBe(0);
  });

  it('开会话见到到期的会提示；工人不查、不出这句', () => {
    const w = world();
    const value = { 'claude-solo': hold({ reviewBy: '2026-10-01' }) };
    let reads = 0;
    const poolHolds = () => {
      reads += 1;
      return { ok: true, value };
    };
    const lines = hook.sessionStart({
      cwd: w.work,
      home: w.home,
      git,
      sync: fakeSync().sync,
      now: Date.parse('2026-10-05T04:00:00Z'),
      poolHolds,
    });
    expect(reads).toBe(1);
    expect(
      lines.some((l) => l.includes('整池暂停到期：claude-solo') && l.includes('驾驶舱设置页「整池暂停」')),
    ).toBe(true);
    const workerReads = { n: 0 };
    const workerLines = hook.sessionStart({
      cwd: w.work,
      home: w.home,
      git,
      sync: fakeSync().sync,
      now: Date.parse('2026-10-05T04:00:00Z'),
      env: { FLEET_WORKER: '1' },
      poolHolds: () => {
        workerReads.n += 1;
        return { ok: true, value };
      },
    });
    expect(workerReads.n).toBe(0);
    expect(workerLines.join('\n')).not.toContain('整池暂停');
  });
});
