// 真起可执行入口（node bin/agents-sync），确认入口、退出码、输出接对了。
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';
import { BLOCK, cleanup, fakeBin, get, gitDir, makeRepo, put, tempDir } from './helpers.ts';

afterEach(cleanup);

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agents-sync');

function run(args: string[], path: string): { code: number | null; out: string; err: string } {
  // git 得在 PATH 里：--apply 会跑 git-excludes.ts 的 git config，不管 --repo 是不是真的 git 检出都会跑。
  const env: Record<string, string> = { PATH: `${path}${delimiter}${gitDir()}`, PATHEXT: '.CMD' };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const r = runChild(process.execPath, [BIN, ...args], { env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('agents-sync 可执行入口', () => {
  it('--help：退出 0，stderr 干净', () => {
    const r = run(['--help'], '');
    expect(r.code).toBe(0);
    expect(r.out).toContain('agents-sync --check');
    expect(r.err).toBe('');
  });

  it('--check 与 --help 都不执行旧封装迁移；--apply 把迁移交给真实入口且使用指定的家目录', {
    timeout: 20_000,
  }, () => {
    const home = tempDir('home');
    const repo = makeRepo({});
    const bin = tempDir('bin');
    fakeBin(bin, 'claude');
    // 坏格式能证明入口真的检查了旧接入；没安装任何 node_modules 的同步检出也能运行。
    put(home, '.mirasim/setting.json', '{broken');
    expect(run(['--check', '--home', home, '--repo', repo], bin).err).not.toContain('Mirasim');
    const help = run(['--apply', '--help', '--home', home, '--repo', repo], bin);
    expect(help.code).toBe(0);
    expect(help.err).toBe('');
    if (process.platform === 'linux') return;
    const apply = run(['--apply', '--home', home, '--repo', repo], bin);
    expect(apply.code).toBe(1);
    expect(apply.err).toContain('Mirasim');
  });

  // 起 3 次真的子进程（node 跑 bin/agents-sync，里面还各自真 spawn 一两次 git）：默认 5 秒在机器忙的时候不够
  it('查出缺失退出 1；写完退出 0；再查退出 0', { timeout: 20_000 }, () => {
    const home = tempDir('home');
    const repo = makeRepo({});
    const bin = tempDir('bin');
    fakeBin(bin, 'claude');
    const before = run(['--check', '--home', home, '--repo', repo], bin);
    expect(before.code).toBe(1);
    expect(before.out).toContain('~/.claude/CLAUDE.md：缺失');
    expect(run(['--apply', '--home', home, '--repo', repo], bin).code).toBe(0);
    expect(get(home, '.claude/CLAUDE.md')).toBe(`${BLOCK}\n`);
    const after = run(['--check', '--home', home, '--repo', repo], bin);
    expect(after.code).toBe(0);
    expect(after.err).toBe('');
  });

  it('参数不对：退出 64', () => {
    expect(run(['--nope'], '').code).toBe(64);
  });
});
