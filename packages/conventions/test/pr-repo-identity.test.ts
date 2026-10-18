import { describe, expect, it, vi } from 'vitest';
import { canonicalPrArgs } from '../src/github-api.ts';
import { livePrGh } from '../src/pr-arm.ts';

function world(env: NodeJS.ProcessEnv = {}, origin?: () => string | undefined) {
  const run = vi.fn((_args: string[], _env: NodeJS.ProcessEnv) => ({ code: 0, stdout: 'ok', stderr: '' }));
  return { run, gh: livePrGh('.', 1000, { env, origin: origin ?? (() => undefined), run }) };
}

describe('标准 PR 的 canonical GitHub 运输', () => {
  it('显式仓只传入子进程，repo view 用位置参数', () => {
    const env = { GH_REPO: 'owner/repo' };
    const w = world(env);
    expect(w.gh(['pr', 'list']).code).toBe(0);
    expect(w.run).toHaveBeenCalledWith(
      ['pr', 'list', '--repo', 'owner/repo'],
      expect.objectContaining({ GH_REPO: 'owner/repo' }),
    );
    w.gh(['repo', 'view', '--json', 'nameWithOwner']);
    expect(w.run.mock.calls[1]?.[0]).toEqual(['repo', 'view', 'owner/repo', '--json', 'nameWithOwner']);
    expect(env).toEqual({ GH_REPO: 'owner/repo' });
  });
  it('没有显式仓时识别 relay origin 并传给 gh，不修改输入环境', () => {
    const env = {};
    const w = world(env, () => 'https://relay.example.invalid/v2/git/github.com/owner/repo.git');
    w.gh(['pr', 'create', '--head', 'local/3129-x']);
    expect(w.run).toHaveBeenCalledWith(
      ['pr', 'create', '--head', 'local/3129-x', '--repo', 'owner/repo'],
      expect.objectContaining({ GH_REPO: 'owner/repo' }),
    );
    expect(env).toEqual({});
  });
  it('非法显式仓不执行 gh，也不退回其他仓', () => {
    const w = world({ GH_REPO: 'invalid', GITHUB_REPOSITORY: 'other/repo' });
    expect(w.gh(['pr', 'create']).stderr).toContain('不是 owner/name');
    expect(w.run).not.toHaveBeenCalled();
  });
  it.each(['https://example.invalid/owner/repo.git', undefined])(
    '非 GitHub 或 origin 读失败 %s 明确拒绝',
    (origin) => {
      const w = world({}, () => origin);
      expect(w.gh(['pr', 'list']).stderr).toContain('当前 GitHub 仓认不出');
      expect(w.run).not.toHaveBeenCalled();
    },
  );
  it('非法 Actions 仓也不改认 origin', () => {
    const w = world({ GITHUB_REPOSITORY: 'invalid' }, () => 'https://github.com/other/repo.git');
    expect(w.gh(['pr', 'list']).code).toBe(1);
    expect(w.run).not.toHaveBeenCalled();
  });
  it.each([
    ['pr', 'view', 'https://github.com/other/repo/pull/1'],
    ['pr', 'list', '--repo', 'other/repo'],
    ['pr', 'list', '-Rother/repo'],
    ['repo', 'view', 'other/repo', '--json', 'nameWithOwner'],
    ['pr', 'list', '--repo=other/repo'],
  ])('保留显式调用目标 %j', (...args) => {
    expect(canonicalPrArgs(args, 'owner/repo')).toEqual(args);
  });
  it('label、create、merge 使用同一仓，保留 head 与 squash 参数', () => {
    expect(
      canonicalPrArgs(['pr', 'create', '--title', 'https://github.com/other/repo/pull/1'], 'owner/repo'),
    ).toContain('--repo');
    expect(canonicalPrArgs(['label', 'create', 'x'], 'owner/repo')).toEqual([
      'label',
      'create',
      'x',
      '--repo',
      'owner/repo',
    ]);
    expect(canonicalPrArgs(['pr', 'create', '--head', 'local/3129-x'], 'owner/repo')).toContain(
      'local/3129-x',
    );
    expect(canonicalPrArgs(['pr', 'merge', '1', '--auto', '--squash'], 'owner/repo')).toEqual([
      'pr',
      'merge',
      '1',
      '--auto',
      '--squash',
      '--repo',
      'owner/repo',
    ]);
  });
});
