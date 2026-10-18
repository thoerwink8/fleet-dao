import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawn, exec } = vi.hoisted(() => ({ spawn: vi.fn(), exec: vi.fn() }));
// 只替换运输函数，不实际同步起进程；真实子进程测试仍统一走 child.ts。
vi.mock('node:child_process', async (original) => {
  const mocked = { ...(await original<typeof import('node:child_process')>()) };
  Reflect.set(mocked, 'spawnSync', spawn);
  Reflect.set(mocked, 'execFileSync', exec);
  return mocked;
});

import { canonicalPrArgs } from '../src/github-api.ts';
import { livePrGh } from '../src/pr-arm.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  spawn.mockReset();
  exec.mockReset();
});
describe('标准 PR 的 canonical GitHub 运输', () => {
  it('relay 环境显式仓覆盖 remote 猜测，并只在子进程设置身份', () => {
    vi.stubEnv('GH_REPO', 'owner/repo');
    spawn.mockReturnValue({ status: 0, stdout: 'ok', stderr: '' });
    const gh = livePrGh('.');
    expect(gh(['pr', 'list']).code).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      'gh',
      ['pr', 'list', '--repo', 'owner/repo'],
      expect.objectContaining({ env: expect.objectContaining({ GH_REPO: 'owner/repo' }) }),
    );
    gh(['repo', 'view', '--json', 'nameWithOwner']);
    expect(spawn.mock.calls[1]?.[1]).toEqual(['repo', 'view', 'owner/repo', '--json', 'nameWithOwner']);
  });
  it('没有显式仓时识别 relay origin，并明确传给 gh', () => {
    vi.stubEnv('GH_REPO', '');
    vi.stubEnv('GITHUB_REPOSITORY', '');
    exec.mockReturnValue('https://relay.example.invalid/v2/git/github.com/owner/repo.git');
    spawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    livePrGh('.')(['pr', 'create', '--head', 'local/3129-x']);
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      'pr',
      'create',
      '--head',
      'local/3129-x',
      '--repo',
      'owner/repo',
    ]);
  });
  it.each(['https://example.invalid/owner/repo.git', null])(
    '非 GitHub 或 origin 读失败 %s 不执行 gh',
    (origin) => {
      vi.stubEnv('GH_REPO', '');
      vi.stubEnv('GITHUB_REPOSITORY', '');
      exec.mockImplementation(() => {
        if (origin === null) throw new Error('read failed');
        return origin;
      });
      expect(livePrGh('.')(['pr', 'list']).code).toBe(1);
      expect(spawn).not.toHaveBeenCalled();
    },
  );
  it('非法显式仓不执行 gh，也不退回其他仓', () => {
    vi.stubEnv('GH_REPO', 'invalid');
    vi.stubEnv('GITHUB_REPOSITORY', 'other/repo');
    expect(livePrGh('.')(['pr', 'create']).stderr).toContain('不是 owner/name');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('非 GitHub 或读不到 origin 明确失败', () => {
    vi.stubEnv('GH_REPO', '');
    vi.stubEnv('GITHUB_REPOSITORY', 'invalid');
    expect(livePrGh('.')(['pr', 'list']).stderr).toContain('当前 GitHub 仓认不出');
    expect(spawn).not.toHaveBeenCalled();
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
  it('label 与创建使用同一仓，保留 head 与 squash 参数', () => {
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
