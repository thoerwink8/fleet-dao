// 一键同步（src/sync-now.ts，pnpm agents:sync）：快进到主线再同步；前置条件不满足就明说、不同步。真的 git 仓，假的 agents-sync。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitResult } from '../src/position.ts';
import { realGit, syncNow } from '../src/sync-now.ts';
import { cleanup, git, gitify, makeRepo, PLATFORM, pushAhead, put, tempDir } from './helpers.ts';

afterEach(cleanup);

/** 假仓要有 packages/agents-sync/bin/agents-sync 这个文件，一键同步才认它是 fleet-dao 检出 */
function fleetRepo(): { repo: string; origin: string } {
  const repo = makeRepo({});
  put(repo, 'packages/agents-sync/bin/agents-sync', '// 假的\n');
  const origin = gitify(repo);
  return { repo, origin };
}

interface Run {
  code: number;
  out: string;
  err: string;
  synced: { repo: string; mode: string }[];
}

function run(
  argv: string[],
  over: {
    home?: string;
    defaultRepo?: string;
    syncStatus?: number | null;
    git?: (r: string, a: string[]) => GitResult;
    fetch?: (r: string) => GitResult;
  } = {},
): Run {
  const out: string[] = [];
  const err: string[] = [];
  const synced: { repo: string; mode: string }[] = [];
  const home = over.home ?? tempDir('home');
  const code = syncNow(argv, {
    home,
    platform: PLATFORM,
    defaultRepo: over.defaultRepo ?? '/nonexistent',
    git: over.git ?? realGit(15_000),
    fetch: over.fetch ?? ((repo) => realGit(30_000)(repo, ['fetch', '-q', 'origin'])),
    sync: (repo, mode) => {
      synced.push({ repo, mode });
      return { status: over.syncStatus === undefined ? 0 : over.syncStatus };
    },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  });
  return { code, out: out.join(''), err: err.join(''), synced };
}

describe('一键同步：能同步的时候', { timeout: 60_000 }, () => {
  it('落后主线：取远端、快进、再跑 --apply，退出码原样交回', () => {
    const { repo, origin } = fleetRepo();
    const tip = pushAhead(origin, 'AGENTS.md.new', 'x\n');
    const r = run(['--repo', repo]);
    expect(r.code).toBe(0);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(tip);
    expect(r.synced).toEqual([{ repo, mode: '--apply' }]);
    expect(r.out).toContain('一键同步完成');
    expect(r.out).toContain('重开会话才生效');
  });

  it('已经在主线最新：照样跑一遍同步', () => {
    const { repo } = fleetRepo();
    const r = run(['--repo', repo]);
    expect(r.code).toBe(0);
    expect(r.synced).toHaveLength(1);
  });

  it('--check：不取远端、不快进，只跑只读检查', () => {
    const { repo, origin } = fleetRepo();
    const before = git(repo, 'rev-parse', 'HEAD');
    pushAhead(origin, 'x.txt', 'x\n');
    const r = run(['--check', '--repo', repo]);
    expect(r.code).toBe(0);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(r.synced).toEqual([{ repo, mode: '--check' }]);
  });

  it('不带 --repo：用 ~/.fleet-dao/synced.json 记的检出，没有记录就用本脚本所在的检出', () => {
    const { repo } = fleetRepo();
    const home = tempDir('home');
    const rec = join(home, '.fleet-dao');
    mkdirSync(rec, { recursive: true });
    put(home, '.fleet-dao/synced.json', JSON.stringify({ repo }));
    expect(run([], { home, defaultRepo: '/nonexistent' }).synced).toEqual([{ repo, mode: '--apply' }]);
    expect(run([], { defaultRepo: repo }).synced).toEqual([{ repo, mode: '--apply' }]);
  });

  it('同步里有 ✗（退出码 1）、没查成（2）：一键同步不说成功，退出码照交回', () => {
    const { repo } = fleetRepo();
    const one = run(['--repo', repo], { syncStatus: 1 });
    expect(one.code).toBe(1);
    expect(one.err).toContain('没全成');
    expect(one.out).not.toContain('一键同步完成');
    expect(run(['--repo', repo], { syncStatus: 2 }).code).toBe(2);
  });
});

// 故意造出失败：前置条件不满足就明说、不同步，不当成「已经是最新」
describe('一键同步：不能同步的时候', { timeout: 60_000 }, () => {
  const refused = (r: Run, part: string) => {
    expect(r.code).toBe(1);
    expect(r.err).toContain('一键同步没做');
    expect(r.err).toContain(part);
    expect(r.synced).toEqual([]);
  };

  it('这台的 git 跑不起来（缺 DLL）：明说，不说成「不是仓」', () => {
    const { repo } = fleetRepo();
    const r = run(['--repo', repo], {
      git: () => ({ status: 0xc0000135, stdout: '', stderr: '' }),
    });
    refused(r, 'git 跑不起来');
    expect(r.err).toContain('缺 DLL');
  });

  it('取不到远端：报失败，不拿本机旧的当最新；--offline 才放行', () => {
    const { repo } = fleetRepo();
    git(repo, 'remote', 'set-url', 'origin', join(tempDir('gone'), 'nope.git'));
    refused(run(['--repo', repo]), '取远端失败');
    const off = run(['--repo', repo, '--offline']);
    expect(off.code).toBe(0);
    expect(off.synced).toHaveLength(1);
  });

  it('检出不在 main 上：不拿别的分支同步', () => {
    const { repo } = fleetRepo();
    git(repo, 'switch', '-q', '-c', 'feature');
    refused(run(['--repo', repo]), '不在 main 上');
  });

  it('main 有没提交的改动、又落后：快进不了', () => {
    const { repo, origin } = fleetRepo();
    pushAhead(origin, 'AGENTS.md.new', 'y\n');
    put(repo, 'AGENTS.md', `${'# 改过\n'}`);
    refused(run(['--repo', repo]), '没提交的改动');
  });

  it('AGENTS.md 或 agents/ 有没提交的改动（已经在最新）：不拿它们同步', () => {
    const { repo } = fleetRepo();
    put(repo, 'agents/skills/x/SKILL.md', '# 新\n');
    refused(run(['--repo', repo]), 'AGENTS.md 或 agents/ 有没提交的改动');
  });

  it('main 和 origin/main 分叉了：快进不了', () => {
    const { repo, origin } = fleetRepo();
    put(repo, 'local.txt', '本地\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', '本地多一个提交');
    pushAhead(origin, 'remote.txt', '远端\n');
    refused(run(['--repo', repo]), '快进不了');
  });

  it('指的目录不是 fleet-dao 检出：明说', () => {
    refused(run(['--repo', tempDir('empty')]), '不是 fleet-dao 检出');
  });

  it('synced.json 读不懂：明说，不悄悄换一个检出', () => {
    const home = tempDir('home');
    put(home, '.fleet-dao/synced.json', '{ nope');
    refused(run([], { home }), 'synced.json');
  });

  it('agents-sync 起不来（没有退出码）：报没跑成，不当成成功', () => {
    const { repo } = fleetRepo();
    const r = run(['--repo', repo], { syncStatus: null });
    expect(r.code).toBe(1);
    expect(r.err).toContain('没跑成');
  });
});

describe('一键同步：参数', () => {
  it('认不出的参数、--repo 缺目录：退出码 64', () => {
    expect(run(['--nope']).code).toBe(64);
    expect(run(['--repo']).code).toBe(64);
  });
  it('--help 打用法，退出码 0', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('pnpm agents:sync');
  });
});
