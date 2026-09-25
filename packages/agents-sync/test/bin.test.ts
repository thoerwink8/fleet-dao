// 真起可执行入口（node bin/agents-sync），确认入口、退出码、输出接对了。
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCK, cleanup, fakeBin, get, makeRepo, tempDir } from './helpers.ts';

afterEach(cleanup);

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agents-sync');

function run(args: string[], path: string): { code: number | null; out: string; err: string } {
  const env: Record<string, string> = { PATH: path, PATHEXT: '.CMD' };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('agents-sync 可执行入口', () => {
  it('--help：退出 0，stderr 干净', () => {
    const r = run(['--help'], '');
    expect(r.code).toBe(0);
    expect(r.out).toContain('agents-sync --check');
    expect(r.err).toBe('');
  });

  it('查出缺失退出 1；写完退出 0；再查退出 0', () => {
    const home = tempDir('home');
    const repo = makeRepo(null);
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
