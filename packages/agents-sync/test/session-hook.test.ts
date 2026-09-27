// 装进去的开会话钩子真跑一遍：agents-sync --apply 装钩子、记下检出 → 主线往前走 → --check 看得见落后几个 →
// 开会话时钩子快进检出、用检出里的 agents-sync 同步，规矩跟上主线 → 主线上的原件坏了，同步不成，会话里有明确的提醒。
// 仓是临时拷的一份 fleet-dao（AGENTS.md、agents/、agents-sync 本身），origin 是临时的裸仓；家目录、PATH 都是临时的。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { END } from '../src/block.ts';
import { cleanup, fakeBin, get, git, gitify, tempDir } from './helpers.ts';

afterEach(cleanup);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 拷一份能跑同步的 fleet-dao：通用段、技能和钩子、同步脚本本身 */
function copyFleet(): string {
  const repo = tempDir('fleet');
  cpSync(join(ROOT, 'AGENTS.md'), join(repo, 'AGENTS.md'));
  cpSync(join(ROOT, 'agents'), join(repo, 'agents'), { recursive: true });
  const pkg = join(repo, 'packages', 'agents-sync');
  mkdirSync(pkg, { recursive: true });
  for (const part of ['bin', 'src', 'package.json']) {
    cpSync(join(ROOT, 'packages', 'agents-sync', part), join(pkg, part), { recursive: true });
  }
  return repo;
}

/** git 所在的目录：PATH 里只放它和假的 claude，别的 AI 命令一个都不带进来 */
function gitDir(): string {
  const exe = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, exe))) return dir;
  }
  throw new Error('PATH 上找不到 git');
}

function machine() {
  const repo = copyFleet();
  const origin = gitify(repo);
  const home = tempDir('home');
  const bin = tempDir('bin');
  fakeBin(bin, 'claude');
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    PATH: [bin, gitDir()].join(delimiter),
  };
  for (const k of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  const sync = (...args: string[]) => {
    const r = spawnSync(
      process.execPath,
      [join(repo, 'packages', 'agents-sync', 'bin', 'agents-sync'), ...args, '--repo', repo, '--home', home],
      { env, encoding: 'utf8' },
    );
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  /** 开一个会话：钩子装在家里的 ~/.fleet-dao/hooks/，会话开在别的目录（不在 fleet-dao 里） */
  const session = () => {
    const r = spawnSync(process.execPath, [join(home, '.fleet-dao', 'hooks', 'session-start.mjs')], {
      env,
      cwd: tempDir('cwd'),
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        source: 'startup',
        cwd: tempDir('elsewhere'),
      }),
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    return (JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
  };
  /** 从另一份克隆往主线上推一个改了 AGENTS.md 的提交 */
  const pushAgents = (edit: (text: string) => string) => {
    const other = join(tempDir('other'), 'clone');
    git(dirname(other), 'clone', '-q', origin, other);
    writeFileSync(join(other, 'AGENTS.md'), edit(readFileSync(join(other, 'AGENTS.md'), 'utf8')));
    git(other, 'commit', '-q', '-am', '改规矩');
    git(other, 'push', '-q', 'origin', 'HEAD:main');
  };
  return { repo, home, sync, session, pushAgents };
}

describe('开会话钩子装上、真跑同步', { timeout: 180_000 }, () => {
  it('装好 → 主线走了 → --check 判落后 → 开会话钩子快进、同步，规矩跟上 → 原件坏了，会话里明说没查成', () => {
    const m = machine();
    const installed = m.sync('--apply');
    expect(installed.code, installed.out).toBe(0);
    const settings = get(m.home, '.claude/settings.json');
    expect(settings).toContain('.fleet-dao/hooks/session-start.mjs');
    expect(settings).toContain('.fleet-dao/hooks/pretool.mjs');
    const clean = m.sync('--check');
    expect(clean.code, clean.out).toBe(0);
    expect(clean.out).toContain('就是主线最新');

    // 主线上通用段多了一条
    m.pushAgents((t) => t.replace(END, `- 测试加的一条规矩。\n${END}`));
    git(m.repo, 'fetch', '-q', 'origin');
    const behind = m.sync('--check');
    expect(behind.code).toBe(1);
    expect(behind.out).toContain('落后主线 1 个提交');

    // 开会话：钩子快进检出、同步，这台跟上主线
    const said = m.session();
    expect(said).toContain('规矩同步：这台刚同步到主线最新');
    expect(get(m.home, '.claude/CLAUDE.md')).toContain('- 测试加的一条规矩。');
    const after = m.sync('--check');
    expect(after.code, after.out).toBe(0);

    // 三分钟内再开会话不再同步；过了三分钟（删掉记号）照常。主线上的 AGENTS.md 标记坏了：同步不成，会话里明说
    expect(m.session()).toContain('分钟内刚同步成功过');
    rmSync(join(m.home, '.fleet-dao', 'session-sync.ok'));
    m.pushAgents((t) => t.replace(END, ''));
    const broken = m.session();
    expect(broken).toContain('规矩同步没查成');
    expect(broken).toContain('AGENTS.md');
    expect(broken).toContain('落后主线 1 个提交');
    // 这台的规矩还是上一版，没被坏的原件冲掉
    expect(get(m.home, '.claude/CLAUDE.md')).toContain('- 测试加的一条规矩。');
  });

  it('钩子没装（登记被人删了）：--check 判红，--apply 补回来', () => {
    const m = machine();
    expect(m.sync('--apply').code).toBe(0);
    writeFileSync(join(m.home, '.claude', 'settings.json'), '{}\n');
    const red = m.sync('--check');
    expect(red.code).toBe(1);
    expect(red.out).toContain('~/.claude/settings.json：缺失——没登记 SessionStart');
    expect(m.sync('--apply').code).toBe(0);
    expect(m.sync('--check').code).toBe(0);
  });
});
