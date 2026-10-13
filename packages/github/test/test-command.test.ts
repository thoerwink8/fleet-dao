import { describe, expect, it } from 'vitest';
import { testCommandFromRepo } from '../src/test-command.ts';

describe('从仓里的文件推出测试命令', () => {
  it('package.json 的 test 脚本，包管理器写在 packageManager 上', () => {
    const got = testCommandFromRepo({
      packageJson: JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts: { test: 'vitest run' } }),
      names: ['package.json'],
    });
    expect(got).toEqual({ ok: true, command: 'pnpm test' });
  });

  it('没有 test 就用 check；锁文件能认出包管理器', () => {
    const got = testCommandFromRepo({
      packageJson: JSON.stringify({ scripts: { check: 'tsc -b' } }),
      names: ['package.json', 'pnpm-lock.yaml'],
    });
    expect(got).toEqual({ ok: true, command: 'pnpm check' });
  });

  it('脚本自己带了运行器，就原样用它', () => {
    const got = testCommandFromRepo({
      packageJson: JSON.stringify({ scripts: { test: 'npm test' } }),
      names: ['package.json'],
    });
    expect(got).toEqual({ ok: true, command: 'npm test' });
  });

  it('没有 package.json、Makefile 里有 test 目标', () => {
    const got = testCommandFromRepo({
      packageJson: null,
      names: ['Makefile'],
      makefile: 'test:\n\tgo test ./...\n',
    });
    expect(got).toEqual({ ok: true, command: 'make test' });
  });

  it('认不出就不编一条', () => {
    expect(
      testCommandFromRepo({
        packageJson: JSON.stringify({ scripts: { build: 'tsc' } }),
        names: ['package.json'],
      }),
    ).toEqual({ ok: false, reason: 'package.json 里没有 test 或 check 脚本' });
    expect(testCommandFromRepo({ packageJson: null, names: ['README.md'] })).toEqual({
      ok: false,
      reason: '仓里没有能认出的测试命令',
    });
    expect(testCommandFromRepo({ packageJson: '{', names: ['package.json'] }).ok).toBe(false);
  });
});
