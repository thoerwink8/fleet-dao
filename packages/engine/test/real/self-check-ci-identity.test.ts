import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CI_IDENTITY_SCRIPT } from '../../src/real/self-check.ts';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-ci-identity-'));
  temps.push(dir);
  const tools = join(dir, '.tools');
  mkdirSync(tools);
  writeFileSync(
    join(tools, 'node'),
    '#!/bin/sh\nif [ "$1" = --version ]; then echo v22.23.2; else echo 5.0.1; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(join(tools, 'pnpm'), '#!/bin/sh\necho 11.28.2\n', { mode: 0o755 });
  const env = { ...process.env, GIT_CONFIG_COUNT: '0', PATH: `${tools}${delimiter}${process.env.PATH}` };
  const git = (...argv: string[]) =>
    execFileSync('git', argv, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  writeFileSync(join(dir, '.gitignore'), '.tools/\nnode_modules/\n');
  writeFileSync(join(dir, 'tracked.txt'), 'original\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
  // Windows 的真实 Git 在 mingw64/bin；仅测试替换工具位置，生产探针固定 root 工具 PATH。
  const testScript = CI_IDENTITY_SCRIPT.replace(
    'PATH=/usr/local/bin:/usr/bin:/bin; export PATH',
    'PATH="$PWD/.tools:$PATH"; export PATH',
  );
  const probe = () =>
    spawnSync('sh', ['-c', testScript], { cwd: dir, env, encoding: 'utf8', timeout: 10_000 });
  return { dir, tools, git, probe };
}

describe('实际Git工作树身份探针', () => {
  it('干净树返回准确head/tree与工具读数', () => {
    const f = tree();
    const got = f.probe();
    expect(got.status, got.stderr).toBe(0);
    expect(got.stdout.trim().split('\n')).toEqual([
      f.git('rev-parse', 'HEAD'),
      f.git('rev-parse', 'HEAD^{tree}'),
      'v22.23.2',
      '11.28.2',
      '5.0.1',
    ]);
  });
  it.each(['tracked', 'index', 'untracked', 'assume-unchanged', 'skip-worktree'])(
    '%s不允许沿用已测树',
    (kind) => {
      const f = tree();
      if (kind === 'untracked') writeFileSync(join(f.dir, 'new-test.ts'), 'new');
      else {
        if (kind === 'assume-unchanged' || kind === 'skip-worktree')
          f.git('update-index', `--${kind}`, 'tracked.txt');
        writeFileSync(join(f.dir, 'tracked.txt'), 'changed\n');
        if (kind === 'index') f.git('add', 'tracked.txt');
      }
      expect(f.probe().status).not.toBe(0);
    },
  );
  it('未初始化gitlink即便状态不报脏也回原路', () => {
    const f = tree();
    writeFileSync(
      join(f.dir, '.gitmodules'),
      '[submodule "sub"]\n path = sub\n url = https://example.invalid/sub\n',
    );
    f.git('add', '.gitmodules');
    f.git('update-index', '--add', '--cacheinfo', `160000,${f.git('rev-parse', 'HEAD')},sub`);
    f.git('-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'gitlink');
    mkdirSync(join(f.dir, 'sub'));
    expect(f.git('status', '--porcelain=v1')).toBe('');
    expect(f.probe().status).not.toBe(0);
  });
  it('Git读取失败不能因空输出被看成干净', () => {
    const f = tree();
    writeFileSync(join(f.tools, 'git'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(f.probe().status).not.toBe(0);
  });
});
