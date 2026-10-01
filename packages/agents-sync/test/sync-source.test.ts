// 同步用的专用检出（agents/hooks/sync-source.mjs）：永远停在 origin/main 的分离头上，
// 和开发机自己的检出现在在哪个分支、有没有没提交的改动无关；那个检出一个字都不动。
// 真 git，真临时目录（origin 就是本地一个裸仓，不出网）。这条路上每处失败都配了一条故意造出来的。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, git, put, tempDir } from './helpers.ts';

/** sync-source.mjs 是给开会话钩子用的普通 JS（钩子家的脚本一律自洽），这里按路径加载、不引类型 */
const MOD = new URL('../../../agents/hooks/sync-source.mjs', import.meta.url).href;
const mod = (await import(MOD)) as {
  SYNC_DIR: string;
  LOCK_FILE: string;
  LOCK_STALE_MS: number;
  syncDirIn(home: string): string;
  lockFileIn(home: string): string;
  gitRunner(timeoutMs?: number): (dir: string, args: string[], opts?: { timeoutMs?: number }) => Result;
  why(r: Result): string;
  samePath(a: string, b: string): boolean;
  prepareSource(
    home: string,
    seed: string | null,
    options?: {
      check?: boolean;
      offline?: boolean;
      repair?: boolean;
      deps?: { git?: Git; fetchMs?: number };
    },
  ): Prepared;
  takeSourceLock(
    home: string,
    deps?: { now?: number; pid?: number },
  ): { ok: true; release: () => void } | { ok: false; why: string };
};

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: (Error & { code?: string }) | undefined;
  timeoutMs?: number;
}
type Git = (dir: string, args: string[], opts?: { timeoutMs?: number }) => Result;
interface Prepared {
  ok: boolean;
  dir: string;
  head?: string;
  url?: string;
  repaired?: boolean;
  fresh?: boolean;
  moved?: boolean;
  unchecked?: boolean;
  why?: string;
}

afterEach(cleanup);

const read = (p: string) => readFileSync(p, 'utf8');
/** 每条要起十几次 git（建仓、克隆、推、取），Windows 上一条要几秒 */
const SLOW = { timeout: 120_000 };

/**
 * 一台机器：origin 是个裸仓，seed 是「开发机自己的检出」（克隆出来、推到 feature 分支、AGENTS.md 还改脏了——
 * 就是 2026-10-01 那台机器的样子），home 是临时家目录。
 */
function machine() {
  const root = tempDir('sync');
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);

  const seed = join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  put(seed, 'AGENTS.md', '# 规矩 v1\n');
  put(seed, 'packages/agents-sync/bin/agents-sync', '// 假的同步脚本\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'v1');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');

  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });

  /** 往主线上再推一个提交（从另一份克隆推，谁都不知道） */
  const advance = (text: string) => {
    const other = join(tempDir('other'), 'clone');
    git(dirname(other), 'clone', '-q', origin, other);
    put(other, 'AGENTS.md', text);
    git(other, 'commit', '-q', '-am', text.trim());
    git(other, 'push', '-q', 'origin', 'HEAD:main');
    return git(other, 'rev-parse', 'HEAD');
  };
  return { root, origin, seed, home, advance };
}

/** 把 seed 弄成「正在功能分支上干活、还有没提交的改动」 */
function detour(seed: string) {
  git(seed, 'checkout', '-q', '-b', 'feature');
  put(seed, 'AGENTS.md', '# 分支上没提交的规矩\n');
}

describe('专用检出：建起来、跟上主线', SLOW, () => {
  it('第一次：从种子建一份，停在 origin/main 的分离头上、干净、检出里就是主线上的文件', () => {
    const m = machine();
    const tip = git(m.seed, 'rev-parse', 'HEAD');
    const r = mod.prepareSource(m.home, m.seed, { repair: true });
    expect(r.ok, r.why).toBe(true);
    expect(r.dir).toBe(mod.syncDirIn(m.home));
    expect(r.fresh).toBe(true);
    expect(r.head).toBe(tip);
    expect(git(r.dir, 'rev-parse', 'HEAD')).toBe(tip);
    expect(read(join(r.dir, 'AGENTS.md'))).toBe('# 规矩 v1\n');
    expect(git(r.dir, 'status', '--porcelain')).toBe('');
    // 分离头：不在任何分支上
    expect(git(r.dir, 'branch', '--show-current')).toBe('');
  });

  it('主线上多了一个提交：取远端、切过去，检出里的文件跟着变', () => {
    const m = machine();
    expect(mod.prepareSource(m.home, m.seed, { repair: true }).ok).toBe(true);
    const tip = m.advance('# 规矩 v2\n');
    const r = mod.prepareSource(m.home, m.seed, { repair: true });
    expect(r.ok, r.why).toBe(true);
    expect(r.head).toBe(tip);
    expect(read(join(r.dir, 'AGENTS.md'))).toBe('# 规矩 v2\n');
    expect(git(r.dir, 'status', '--porcelain')).toBe('');
  });

  it('种子的检出停在功能分支、还有没提交的改动：照样同步，且同步的是主线上的内容', () => {
    const m = machine();
    const main1 = git(m.seed, 'rev-parse', 'HEAD');
    detour(m.seed);
    const r = mod.prepareSource(m.home, m.seed, { repair: true });
    expect(r.ok, r.why).toBe(true);
    expect(r.head).toBe(main1);
    expect(read(join(r.dir, 'AGENTS.md'))).toBe('# 规矩 v1\n');
  });

  it('种子的检出整个没了：专用检出还在，照样同步（这条不靠开发机自己的检出活着）', () => {
    const m = machine();
    expect(mod.prepareSource(m.home, m.seed, { repair: true }).ok).toBe(true);
    rmSync(m.seed, { recursive: true, force: true });
    const tip = m.advance('# 规矩 v2\n');
    const r = mod.prepareSource(m.home, m.seed, { repair: true });
    expect(r.ok, r.why).toBe(true);
    expect(r.head).toBe(tip);
  });

  it('【故意造出的失败】开发机自己的检出一个字都不动：分支还在、改脏的 AGENTS.md 还在', () => {
    const m = machine();
    detour(m.seed);
    const before = git(m.seed, 'status', '--porcelain');
    expect(mod.prepareSource(m.home, m.seed, { repair: true }).ok).toBe(true);
    expect(git(m.seed, 'branch', '--show-current')).toBe('feature');
    expect(git(m.seed, 'status', '--porcelain')).toBe(before);
    expect(read(join(m.seed, 'AGENTS.md'))).toBe('# 分支上没提交的规矩\n');
  });
});

describe('专用检出：脏了、坏了、取不到远端', SLOW, () => {
  it('里面被改了：整份挪到旁边（不删），再建一个干净的换上去，说得出改了哪几处', () => {
    const m = machine();
    expect(mod.prepareSource(m.home, m.seed, { repair: true }).ok).toBe(true);
    const dir = mod.syncDirIn(m.home);
    put(dir, 'AGENTS.md', '# 谁改的\n');
    put(dir, 'extra.txt', '新文件\n');
    const r = mod.prepareSource(m.home, m.seed, { repair: true });
    expect(r.ok, r.why).toBe(true);
    expect(r.repaired).toBe(true);
    expect(read(join(dir, 'AGENTS.md'))).toBe('# 规矩 v1\n');
    expect(existsSync(join(dir, 'extra.txt'))).toBe(false);
    // 原来那份没删，挪到了旁边
    const aside = readdirSync(dirname(dir)).filter((n) => n.startsWith('origin-main.bak-'));
    expect(aside).toHaveLength(1);
    expect(read(join(dirname(dir), aside[0] as string, 'extra.txt'))).toBe('新文件\n');
  });

  it('【故意造出的失败】--check 只读：脏了也不挪不建，只说清没查成', () => {
    const m = machine();
    expect(mod.prepareSource(m.home, m.seed, { repair: true }).ok).toBe(true);
    const dir = mod.syncDirIn(m.home);
    put(dir, 'AGENTS.md', '# 谁改的\n');
    const r = mod.prepareSource(m.home, m.seed, { check: true });
    expect(r.ok).toBe(false);
    expect(r.unchecked).toBe(true);
    expect(r.why).toContain('没提交的改动');
    expect(readdirSync(dirname(dir))).toEqual(['origin-main']);
  });

  it('里面不是 git 检出（被删了一半、或被别的什么占了）：挪到旁边重建，不当成能用的', () => {
    const m = machine();
    const dir = mod.syncDirIn(m.home);
    mkdirSync(dir, { recursive: true });
    put(dir, 'AGENTS.md', '# 不是仓\n');
    const r = mod.prepareSource(m.home, m.seed, { repair: true });
    expect(r.ok, r.why).toBe(true);
    expect(r.repaired).toBe(true);
    expect(read(join(dir, 'AGENTS.md'))).toBe('# 规矩 v1\n');
  });

  it('【故意造出的失败】取不到远端：明说没查成，不拿旧的冒充最新，也不动现有检出', () => {
    const m = machine();
    expect(mod.prepareSource(m.home, m.seed, { repair: true }).ok).toBe(true);
    const dir = mod.syncDirIn(m.home);
    const before = git(dir, 'rev-parse', 'HEAD');
    m.advance('# 规矩 v2\n');
    git(dir, 'remote', 'set-url', 'origin', join(m.root, 'nope.git'));
    const r = mod.prepareSource(m.home, m.seed, { repair: true });
    expect(r.ok).toBe(false);
    expect(r.why).toContain('取远端失败');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('没建过 + --offline：用本机的种子建起来，不走网', () => {
    const m = machine();
    const main1 = git(m.seed, 'rev-parse', 'HEAD');
    m.advance('# 规矩 v2\n');
    const r = mod.prepareSource(m.home, m.seed, { offline: true, repair: true });
    expect(r.ok, r.why).toBe(true);
    expect(r.head).toBe(main1); // 本机种子上有的那份，没出网
    expect(read(join(mod.syncDirIn(m.home), 'AGENTS.md'))).toBe('# 规矩 v1\n');
  });

  it('【故意造出的失败】--offline 又没有能当种子的东西：明说先跑一遍联网的同步', () => {
    const m = machine();
    const r = mod.prepareSource(m.home, join(m.root, 'gone'), { offline: true, repair: true });
    expect(r.ok).toBe(false);
    expect(r.why).toContain('先跑一遍联网的同步');
  });

  it('已经建好过 + --offline：不取远端，按本机上次取到的主线走', () => {
    const m = machine();
    const main1 = git(m.seed, 'rev-parse', 'HEAD');
    expect(mod.prepareSource(m.home, m.seed, { repair: true }).ok).toBe(true);
    m.advance('# 规矩 v2\n');
    const gone = mod.prepareSource(m.home, m.seed, { offline: true, repair: true });
    expect(gone.ok, gone.why).toBe(true);
    expect(gone.head).toBe(main1); // 还是上次取到的那份，没出网
  });

  it('【故意造出的失败】没有种子、也没建过：明说该怎么办，不静默跳过', () => {
    const m = machine();
    const r = mod.prepareSource(m.home, join(m.root, 'gone'), { repair: true });
    expect(r.ok).toBe(false);
    expect(r.why).toContain('pnpm agents:sync');
    expect(existsSync(mod.syncDirIn(m.home))).toBe(false);
  });

  it('【故意造出的失败】git 根本跑不起来（找不到命令）：说 git 跑不起来，不说「不是 git 检出」', () => {
    const m = machine();
    expect(mod.prepareSource(m.home, m.seed, { repair: true }).ok).toBe(true);
    const dead: Git = () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }),
    });
    const r = mod.prepareSource(m.home, m.seed, { deps: { git: dead } });
    expect(r.ok).toBe(false);
    expect(r.why).toContain('git 跑不起来');
    expect(r.why).toContain('ENOENT');
  });

  it('git 起来就被系统叫停（Windows 缺 DLL，退出码 3221225781）：说得出是哪个退出码', () => {
    const m = machine();
    expect(mod.prepareSource(m.home, m.seed, { repair: true }).ok).toBe(true);
    const dead: Git = () => ({ status: 3221225781, stdout: '', stderr: '' });
    const r = mod.prepareSource(m.home, m.seed, { deps: { git: dead } });
    expect(r.ok).toBe(false);
    expect(r.why).toContain('3221225781');
    expect(r.why).toContain('0xC0000135');
  });

  it('--check：没建过就明说先跑一遍同步', () => {
    const m = machine();
    const r = mod.prepareSource(m.home, m.seed, { check: true });
    expect(r.ok).toBe(false);
    expect(r.unchecked).toBeUndefined();
    expect(r.why).toContain('pnpm agents:sync');
  });
});

describe('同步全程拿的锁', () => {
  it('拿到了就能拿、拿不到说得出是谁；放掉之后别人能拿', () => {
    const home = tempDir('home');
    const a = mod.takeSourceLock(home);
    expect(a.ok).toBe(true);
    const b = mod.takeSourceLock(home);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.why).toContain('另一个同步正在做');
    if (a.ok) a.release();
    expect(mod.takeSourceLock(home).ok).toBe(true);
  });

  it('【故意造出的失败】锁的主人已经不在：当成上次崩了留下的，拿过来', () => {
    const home = tempDir('home');
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    writeFileSync(mod.lockFileIn(home), '999999 2026-01-01T00:00:00.000Z\n');
    expect(mod.takeSourceLock(home).ok).toBe(true);
  });

  it('锁的主人还在（本进程）：不抢，说清进程号和多久前', () => {
    const home = tempDir('home');
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    writeFileSync(mod.lockFileIn(home), `${process.pid} ${new Date().toISOString()}\n`);
    const r = mod.takeSourceLock(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain(String(process.pid));
  });

  it('【故意造出的失败】锁的主人认不出（文件被占着、读不出来）：不抢，说拿不到', () => {
    const home = tempDir('home');
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    mkdirSync(mod.lockFileIn(home), { recursive: true }); // 是个目录：读不出进程号，也删不掉
    const r = mod.takeSourceLock(home);
    expect(r.ok).toBe(false);
  });
});
