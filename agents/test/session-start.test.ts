// 开会话钩子（agents/hooks/session-start.mjs）：会话所在的仓快进或提醒；这台机器的 fleet-dao 检出快进后跑同步，结论一句话；
// 没查成、没做成都要明说原因和落后几个。真 git（临时目录里的裸仓当 origin），同步换成假的（agents-sync 本身的测试在它的包里，
// 装进去的钩子真跑一遍同步在 packages/agents-sync/test/session-hook.test.ts）。
// 第 3 件「生效中的临时调整」表：真 git 仓里放 .md，到期、缺列、日期认不出、表坏了、git 坏了各一条。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  sessionStart(o: {
    cwd: string;
    home: string;
    git: Git;
    sync: Sync;
    localGit?: Git;
    now?: number;
  }): string[];
  checkTemporary(cwd: string, git: Git, now?: number): string[];
  beijingToday(now?: number): string;
  render(lines: string[]): string;
  pickCwd(input: unknown): string;
}

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const HOOK = join(HOOKS, 'session-start.mjs');
const hook = (await import(pathToFileURL(HOOK).href)) as HookLib;

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
const SLOW = { timeout: 60_000 };

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

describe('同步这台机器：没查成、没做成都明说', SLOW, () => {
  it('没记检出在哪、记录读不懂、记的检出不在了：各说各的原因，不去同步', () => {
    const w = world();
    const f = fakeSync();
    expect(hook.syncFleet({ home: w.home, git, sync: f.sync })).toMatch(/没记 fleet-dao 检出在哪/);
    mkdirSync(join(w.home, '.fleet-dao'), { recursive: true });
    writeFileSync(join(w.home, '.fleet-dao', 'synced.json'), '{ 坏了');
    expect(hook.syncFleet({ home: w.home, git, sync: f.sync })).toMatch(/synced\.json 读不懂/);
    record(w.home, join(w.root, 'gone'));
    expect(hook.syncFleet({ home: w.home, git, sync: f.sync })).toMatch(/检出 .*gone 不在了/);
    expect(f.calls).toEqual([]);
  });

  it('落后且干净：先快进再同步；同步改了东西要说改了哪些、下次开会话才生效', () => {
    const w = world();
    const v1 = g(w.work, 'rev-parse', 'HEAD');
    record(w.home, w.work, v1);
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
    expect(g(w.work, 'rev-parse', 'HEAD')).toBe(v2);
    expect(f.calls).toEqual([[w.work, w.home]]);
    expect(line).toContain(`刚同步到主线最新（${v2.slice(0, 7)}），改了 1 处（~/.claude/CLAUDE.md）`);
    expect(line).toContain('下次开会话才生效');
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

  it('检出不在 main 上、main 有没提交的改动、AGENTS.md 有没提交的改动：不拿它同步，说出落后几个', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const f = fakeSync();
    g(w.work, 'checkout', '-q', '-b', 'feature');
    expect(hook.syncFleet({ home: w.home, git, sync: f.sync })).toMatch(
      /不在 main 上（在 feature），不拿别的分支同步/,
    );
    g(w.work, 'checkout', '-q', 'main');
    writeFileSync(join(w.work, 'AGENTS.md'), '没提交的规矩\n');
    expect(hook.syncFleet({ home: w.home, git, sync: f.sync })).toMatch(
      /AGENTS\.md 或 agents\/ 有没提交的改动/,
    );
    w.push('v2\n');
    const dirty = hook.syncFleet({ home: w.home, git, sync: f.sync });
    expect(dirty).toMatch(/main 有没提交的改动，快进不了/);
    expect(dirty).toMatch(/落后主线 1 个提交/);
    expect(f.calls).toEqual([]);
  });

  it('取不到远端：没查成，按本机上次取到的主线说落后几个', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    g(w.work, 'remote', 'set-url', 'origin', join(w.root, 'nope.git'));
    const f = fakeSync();
    const line = hook.syncFleet({ home: w.home, git, sync: f.sync });
    expect(line).toMatch(/规矩同步没查成：在 .* 取远端失败/);
    expect(line).toContain('按本机上次取到的主线算');
    expect(f.calls).toEqual([]);
  });

  // 2026-09-30 本机 git 缺 DLL（退出码 3221225781、什么都不打），钩子说成「记下的检出不是 git 仓」，把真毛病盖住了
  it('【故意造出的失败】git 起来就被系统叫停（退出码 3221225781，没有任何输出）：说 git 跑不起来，不说不是 git 仓', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const f = fakeSync();
    const dead: Git = () => ({ status: 3221225781, stdout: '', stderr: '' });
    const line = hook.syncFleet({ home: w.home, git: dead, sync: f.sync });
    expect(line).toMatch(/规矩同步没查成：这台的 git 跑不起来/);
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

  it('git 说话了、这里不是仓（退出码 128）：还是「不是 git 仓」，带 git 的原话', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const notRepo: Git = () => ({
      status: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
    });
    const line = hook.syncFleet({ home: w.home, git: notRepo, sync: fakeSync().sync });
    expect(line).toMatch(/不是 git 仓（fatal: not a git repository/);
    expect(line).not.toMatch(/git 跑不起来/);
  });

  it('会话所在的仓那一件：git 跑不起来时不出声、不崩（同步那一句会说清）', () => {
    const dead: Git = () => ({ status: 3221225781, stdout: '', stderr: '' });
    expect(hook.checkHere(temp('plain'), dead)).toEqual({ line: null, fetch: null });
  });

  it('会话就开在 fleet-dao 检出里：远端只取一次', () => {
    const w = world();
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    w.push('v2\n');
    const fetches: string[] = [];
    const counting: Git = (cwd, args) => {
      if (args[0] === 'fetch') fetches.push(cwd);
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

  it('这台没记检出在哪：退出 0，上下文里写明没查成', () => {
    const home = temp('home');
    const r = run(home, JSON.stringify({ hook_event_name: 'SessionStart', cwd: temp('plain') }));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('规矩同步没查成：这台没记 fleet-dao 检出在哪');
  });

  it('输入读不懂：照样退出 0、照样说结论', () => {
    const r = run(temp('home'), '不是 JSON');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('规矩同步没查成');
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

  /** 一个只有本地提交的仓：files 全部提交（untracked 里的不提交） */
  function repo(files: Record<string, string>, untracked: Record<string, string> = {}) {
    const dir = temp('tmp-adj');
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
    const dir = repo({ 'docs/plan.md': plan(subagent, '撤回就删行。\n\n') });
    expect(hook.checkTemporary(dir, git, Date.parse('2026-10-03T02:00:00Z'))).toEqual([]);
    expect(hook.checkTemporary(repo({ 'docs/plan.md': plan('') }), git, NOW)).toEqual([]);
  });

  it('到了最迟复查日期（含今天）：一行列出来，提醒照读法②问创始人', () => {
    const today = row('停法国池', '机器坏了', '创始人 2026-10-01「先停」', '机器修好', '2026-10-06');
    const later = row('只开一条路由', '额度紧', '创始人 2026-10-01「先这样」', '额度恢复', '2026-10-20');
    const dir = repo({ 'docs/plan.md': plan(subagent + today + later) });
    const lines = hook.checkTemporary(join(dir, 'docs'), git, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('临时调整到了最迟复查日期 2 条（docs/plan.md，今天 2026-10-06）');
    expect(lines[0]).toContain('不开子代理（最迟 2026-10-05）；停法国池（最迟 2026-10-06）');
    expect(lines[0]).toContain('读法②问创始人');
    expect(lines[0]).not.toContain('只开一条路由');
  });

  it('北京时间过了零点就算到期，不按 UTC 晚一天', () => {
    const dir = repo({ 'docs/plan.md': plan(subagent) });
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
    const lines = hook.checkTemporary(repo({ 'docs/plan.md': plan(rows) }), git, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('临时调整表有 3 行最迟复查日期认不出（docs/plan.md）');
    expect(lines[0]).toContain('「甲」的「下周五」');
    expect(lines[0]).toContain('「乙」的「2026-02-30」');
    expect(lines[0]).toContain('「丙」的「10-05」');
  });

  it('【故意造出的失败】有标题、表认不出：没有表格、没有分隔行、表头不是五列，都明说没查成', () => {
    const none = repo({
      'docs/plan.md': '## 生效中的临时调整\n\n（还没有）\n\n## 版本\n| a | b |\n|---|---|\n',
    });
    expect(hook.checkTemporary(none, git, NOW)).toEqual([
      '临时调整表没查成（docs/plan.md）：标题下面没有表格。',
    ]);
    const noSep = repo({ 'docs/plan.md': `## 生效中的临时调整\n\n${HEAD.split('\n')[0]}\n${subagent}` });
    expect(hook.checkTemporary(noSep, git, NOW)[0]).toMatch(
      /临时调整表没查成（docs\/plan\.md）：第 3 行的表头下面没有 \|---\| 分隔行/,
    );
    const fourCols = repo({
      'docs/plan.md': '## 生效中的临时调整\n| 内容 | 为什么 | 谁拍的 | 复查 |\n|---|---|---|---|\n',
    });
    expect(hook.checkTemporary(fourCols, git, NOW)[0]).toMatch(
      /临时调整表没查成.*表头是「内容｜为什么｜谁拍的｜复查」，要五列/,
    );
  });

  it('没有这张表不出声：没提这个标题、只在句子里提到、只在没跟踪的文件里有、不是 git 仓', () => {
    expect(hook.checkTemporary(repo({ 'docs/plan.md': '# 计划\n' }), git, NOW)).toEqual([]);
    const inline = repo({ 'AGENTS.md': '登进「## 生效中的临时调整」表\n' }, { 'scratch.md': plan(subagent) });
    expect(hook.checkTemporary(inline, git, NOW)).toEqual([]);
    expect(hook.checkTemporary(temp('plain'), git, NOW)).toEqual([]);
  });

  it('中文路径照样认得出；一个仓里有两张表要说并成一张', () => {
    const dir = repo({ 'specs/12-额度/需求.md': plan(subagent), 'docs/plan.md': plan('') });
    const lines = hook.checkTemporary(dir, git, NOW);
    expect(lines[0]).toMatch(/临时调整表不止一张（.*docs\/plan\.md:3.*specs\/12-额度\/需求\.md:3.*）/);
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
        ? { status: 0, stdout: 'docs/plan.md:3:## 生效中的临时调整\n', stderr: '' }
        : git(cwd, args);
    expect(hook.checkTemporary(dir, grepGarbled, NOW)[0]).toMatch(/临时调整表没查成：git grep 的输出认不出/);
  });

  it('开会话时这几行进上下文，排在同步那一句前面', () => {
    const w = world();
    writeFileSync(join(w.work, 'plan.md'), plan(subagent));
    g(w.work, 'add', '-A');
    g(w.work, 'commit', '-q', '-m', 'plan');
    record(w.home, w.work, g(w.work, 'rev-parse', 'HEAD'));
    const lines = hook.sessionStart({ cwd: w.work, home: w.home, git, sync: fakeSync().sync, now: NOW });
    expect(lines[0]).toMatch(/临时调整到了最迟复查日期 1 条（plan\.md/);
    expect(lines.at(-1)).toMatch(/^规矩同步/);
  });
});
