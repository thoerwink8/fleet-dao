// 一键同步（src/sync-now.ts，pnpm agents:sync）：把同步专用的检出（~/.fleet-dao/origin-main）切到 origin/main 再同步；
// 前置条件不满足就明说、不同步，不说成「已经是最新」。真 git 仓，假的 agents-sync。
// 这台机器自己的检出一个字都不动：功能分支、没提交的改动都留着。
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitResult } from '../src/position.ts';
import { realGit, syncNow } from '../src/sync-now.ts';
import { cleanup, git, gitify, makeRepo, PLATFORM, pushAhead, put, tempDir } from './helpers.ts';

afterEach(cleanup);

/** 假仓要有 packages/agents-sync/bin/agents-sync 这个文件，一键同步才认它是 fleet-dao 检出（能当种子） */
function fleetRepo(): { repo: string; origin: string } {
  const repo = makeRepo({});
  put(repo, 'packages/agents-sync/bin/agents-sync', '// 假的\n');
  const origin = gitify(repo);
  return { repo, origin };
}

/** 专用的同步检出放哪（sync-now 是从 sync-source.mjs 里按家的目录拼出来的） */
const mirrorIn = (home: string) => join(home, '.fleet-dao', 'origin-main');

interface Run {
  code: number;
  out: string;
  err: string;
  home: string;
  synced: { repo: string; mode: string }[];
}

/** syncNow 是 async（要动态加载 agents/hooks/sync-source.mjs）；测试里一律经这个帮手跑 */
async function run(
  argv: string[],
  over: {
    home?: string;
    defaultRepo?: string;
    syncStatus?: number | null;
    git?: (r: string, a: string[]) => GitResult;
    fetch?: (r: string, a: string[]) => GitResult;
  } = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const synced: { repo: string; mode: string }[] = [];
  const home = over.home ?? tempDir('home');
  const code = await syncNow(argv, {
    home,
    platform: PLATFORM,
    defaultRepo: over.defaultRepo ?? '/nonexistent',
    git: over.git ?? realGit(15_000),
    fetch: over.fetch ?? ((dir, args) => realGit(60_000)(dir, args)),
    sync: (repo, mode) => {
      synced.push({ repo, mode });
      return { status: over.syncStatus === undefined ? 0 : over.syncStatus };
    },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, out: out.join(''), err: err.join(''), home, synced };
}

describe('一键同步：能同步的时候', { timeout: 120_000 }, () => {
  it('第一次：拿种子建起专用检出，切到主线、再跑 --apply，退出码原样交回', async () => {
    const { repo, origin } = fleetRepo();
    const tip = pushAhead(origin, 'AGENTS.md.new', 'x\n');
    const r = await run(['--seed', repo]);
    expect(r.code, r.err).toBe(0);
    expect(git(mirrorIn(r.home), 'rev-parse', 'HEAD')).toBe(tip);
    expect(r.synced).toEqual([{ repo: mirrorIn(r.home), mode: '--apply' }]);
    expect(r.out).toContain('一键同步完成');
    expect(r.out).toContain('重开会话才生效');
  });

  it('种子在功能分支、AGENTS.md 有没提交的改动：照样同步到 origin/main，种子一个字没动', async () => {
    const { repo, origin } = fleetRepo();
    const before = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'feature');
    put(repo, 'AGENTS.md', '# 分支上没提交的\n');
    const tip = pushAhead(origin, 'AGENTS.md.new', 'x\n');
    const r = await run(['--seed', repo]);
    expect(r.code, r.err).toBe(0);
    expect(git(mirrorIn(r.home), 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(repo, 'branch', '--show-current')).toBe('feature');
    expect(git(repo, 'status', '--porcelain')).toBe('M AGENTS.md');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('已经在主线最新：照样跑一遍同步；再跑一遍不多事', async () => {
    const { repo } = fleetRepo();
    const home = tempDir('home');
    const first = await run(['--seed', repo], { home });
    expect(first.code, first.err).toBe(0);
    const again = await run(['--seed', repo], { home });
    expect(again.code, again.err).toBe(0);
    expect(again.synced).toHaveLength(1);
    expect(again.out).toContain('本来就在主线');
  });

  it('--check：不取远端、不切，只跑只读检查（专用检出没建过时明说该先跑一遍）', async () => {
    const { repo, origin } = fleetRepo();
    const home = tempDir('home');
    const before = await run(['--check', '--seed', repo], { home });
    expect(before.code).toBe(1);
    expect(before.err).toContain('还没建过');
    expect(before.synced).toEqual([]);

    await run(['--seed', repo], { home });
    const head = git(mirrorIn(home), 'rev-parse', 'HEAD');
    pushAhead(origin, 'x.txt', 'x\n');
    const r = await run(['--check', '--seed', repo], { home });
    expect(r.code, r.err).toBe(0);
    expect(git(mirrorIn(home), 'rev-parse', 'HEAD')).toBe(head);
    expect(r.synced).toEqual([{ repo: mirrorIn(home), mode: '--check' }]);
  });

  it('不带 --seed：用 ~/.fleet-dao/synced.json 记的检出当种子，没有记录就用本脚本所在的检出', async () => {
    const { repo } = fleetRepo();
    const home = tempDir('home');
    const rec = join(home, '.fleet-dao');
    mkdirSync(rec, { recursive: true });
    put(home, '.fleet-dao/synced.json', JSON.stringify({ repo }));
    expect((await run([], { home, defaultRepo: '/nonexistent' })).synced).toEqual([
      { repo: mirrorIn(home), mode: '--apply' },
    ]);
    const home2 = tempDir('home');
    expect((await run([], { home: home2, defaultRepo: repo })).synced).toEqual([
      { repo: mirrorIn(home2), mode: '--apply' },
    ]);
  });

  it('同步里有 ✗（退出码 1）、没查成（2）：一键同步不说成功，退出码照交回', async () => {
    const { repo } = fleetRepo();
    const one = await run(['--seed', repo], { syncStatus: 1 });
    expect(one.code).toBe(1);
    expect(one.err).toContain('没全成');
    expect(one.out).not.toContain('一键同步完成');
    expect((await run(['--seed', repo], { syncStatus: 2 })).code).toBe(2);
  });
});

// 故意造出失败：前置条件不满足就明说、不同步，不当成「已经是最新」
describe('一键同步：不能同步的时候', { timeout: 120_000 }, () => {
  const refused = (r: Run, part: string) => {
    expect(r.code).toBe(1);
    expect(r.err).toContain('一键同步没做');
    expect(r.err).toContain(part);
    expect(r.synced).toEqual([]);
  };

  it('这台的 git 跑不起来（缺 DLL）：明说，不说成「不是仓」', async () => {
    const { repo } = fleetRepo();
    const r = await run(['--seed', repo], {
      git: () => ({ status: 0xc0000135, stdout: '', stderr: '' }),
    });
    refused(r, 'git 跑不起来');
    expect(r.err).toContain('缺 DLL');
  });

  it('取不到远端：报失败，不拿本机旧的当最新；--offline 才放行', async () => {
    const { repo } = fleetRepo();
    const home = tempDir('home');
    // 先正常建一份，再把远端弄成取不到
    const first = await run(['--seed', repo], { home });
    expect(first.code, first.err).toBe(0);
    git(mirrorIn(home), 'remote', 'set-url', 'origin', join(tempDir('gone'), 'nope.git'));
    const dead = () => ({ status: 128, stdout: '', stderr: 'fatal: could not read from remote\n' });
    refused(await run(['--seed', repo], { home, fetch: dead }), '取远端失败');
    const off = await run(['--seed', repo, '--offline'], { home, fetch: dead });
    expect(off.code, off.err).toBe(0);
    expect(off.synced).toHaveLength(1);
  });

  it('【故意造出的失败】种子给了个不是 fleet-dao 的目录：明说', async () => {
    refused(await run(['--seed', tempDir('empty')]), '不是 fleet-dao 检出');
  });

  it('【故意造出的失败】没有种子、专用检出也没建过：明说该跑哪条命令，不静默跳过', async () => {
    const r = await run([], { defaultRepo: '/nonexistent' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('还没建');
    expect(r.err).toContain('pnpm agents:sync');
    expect(r.synced).toEqual([]);
  });

  it('【故意造出的失败】专用检出里被人改了东西：整份挪到旁边、重建一份，照样同步，并说明修过', async () => {
    const { repo } = fleetRepo();
    const home = tempDir('home');
    expect((await run(['--seed', repo], { home })).code).toBe(0);
    put(mirrorIn(home), 'AGENTS.md', '# 谁改的\n');
    const r = await run(['--seed', repo], { home });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('修好了一份');
    expect(r.synced).toHaveLength(1);
  });

  it('【故意造出的失败】另一个同步正在做（锁被占着）：说清是谁拿着，这次什么都没动', async () => {
    const { repo } = fleetRepo();
    const home = tempDir('home');
    mkdirSync(join(home, '.fleet-dao'), { recursive: true });
    put(home, '.fleet-dao/origin-main.lock', `${process.pid} ${new Date().toISOString()}\n`);
    const r = await run(['--seed', repo], { home });
    expect(r.code).toBe(1);
    expect(r.err).toContain('另一个同步正在做');
    expect(r.synced).toEqual([]);
    expect(existsSync(mirrorIn(home))).toBe(false);
  });

  it('agents-sync 起不来（没有退出码）：报没跑成，不当成成功', async () => {
    const { repo } = fleetRepo();
    const r = await run(['--seed', repo], { syncStatus: null });
    expect(r.code).toBe(1);
    expect(r.err).toContain('没跑成');
  });
});

describe('一键同步：参数', () => {
  it('认不出的参数、--seed 缺目录：退出码 64', async () => {
    expect((await run(['--nope'])).code).toBe(64);
    expect((await run(['--seed'])).code).toBe(64);
  });
  it('--help 打用法，退出码 0', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('pnpm agents:sync');
  });
});
