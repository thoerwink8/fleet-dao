import { beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({ realpath: vi.fn(), lstat: vi.fn(), readFile: vi.fn() }));
vi.mock('node:fs/promises', () => fs);

import { trustedReleaseCommit } from '../../src/real/self-check-ci.ts';

const sha = 'a'.repeat(40);
const root = `/srv/fleet-dao-releases/${sha}`;
beforeEach(() => {
  fs.realpath.mockReset().mockResolvedValue(root);
  fs.lstat.mockReset().mockResolvedValue({ uid: 0, mode: 0o100644, isSymbolicLink: () => false });
  fs.readFile.mockReset().mockResolvedValue(`commit=${sha}\non_main=1\nbuilt=2026-10-19T00:00:00Z\n`);
});
describe('受信运行发布目录来源', () => {
  it('正式root保护目录、主线marker和目录SHA一致才受信', async () => {
    expect(await trustedReleaseCommit()).toBe(sha);
    expect(fs.lstat).toHaveBeenCalledTimes(5);
  });
  it.each([0o100664, 0o100646])('group/other可写不受信：%s', async (mode) => {
    fs.lstat.mockResolvedValue({ uid: 0, mode, isSymbolicLink: () => false });
    expect(await trustedReleaseCommit()).toBeNull();
  });
  it('会话可写属主不受信', async () => {
    fs.lstat.mockResolvedValue({ uid: 1000, mode: 0o100644, isSymbolicLink: () => false });
    expect(await trustedReleaseCommit()).toBeNull();
  });
  it('marker符号链接不受信', async () => {
    fs.lstat.mockImplementation(async (path: string) => ({
      uid: 0,
      mode: 0o100644,
      isSymbolicLink: () => path.endsWith('.fleet-release'),
    }));
    expect(await trustedReleaseCommit()).toBeNull();
  });
  it.each([
    `commit=${'b'.repeat(40)}\non_main=1\n`,
    `commit=${sha}\non_main=0\n`,
    `commit=${sha}\ncommit=${sha}\non_main=1\n`,
  ])('marker不完整/歧义/非主线不受信', async (marker) => {
    fs.readFile.mockResolvedValue(marker);
    expect(await trustedReleaseCommit()).toBeNull();
  });
  it('开发树或current不能伪装固定正式发布目录', async () => {
    fs.realpath.mockResolvedValue('/work/candidate');
    expect(await trustedReleaseCommit()).toBeNull();
    fs.realpath.mockResolvedValue('/srv/fleet-dao-releases/current');
    expect(await trustedReleaseCommit()).toBeNull();
  });
  it('读不到明确不复用', async () => {
    fs.lstat.mockRejectedValue(new Error('EACCES'));
    expect(await trustedReleaseCommit()).toBeNull();
  });
});
