// 测试里起子进程的那一层（child.ts）：卡死的被杀掉、起不来的和被信号杀掉的都抛出说清，不冒充「命令失败」。
// 这几条故意造出失败：不这样，git 卡住会让整轮测试挂到 CI 的时限，git 没起来会让期望「失败」的用例白白通过。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitIn, gitSyncIn, runChild } from './child.ts';

// 同步用例，不设 vitest 的超时（为什么见 child.ts 开头）。
describe('测试里起子进程', { timeout: 0 }, () => {
  it('非 0 退出码照样交回，不抛：由调用方判', () => {
    const r = runChild(process.execPath, ['-e', 'process.stderr.write("坏了"); process.exit(3)']);
    expect(r).toEqual({ status: 3, stdout: '', stderr: '坏了' });
  });

  it('不给输入：标准输入是空的，读输入的子进程马上读到结尾、不会等', () => {
    const r = runChild(process.execPath, [
      '-e',
      'let n = 0; process.stdin.on("data", (b) => (n += b.length)); process.stdin.on("end", () => console.log("读到 " + n + " 字节"));',
    ]);
    expect(r.stdout.trim()).toBe('读到 0 字节');
  });

  it('卡死不退出：到上限就杀掉，抛出是哪条命令，不一直等下去', () => {
    expect(() =>
      runChild(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { limitMs: 300 }),
    ).toThrow(/子进程没跑完（.*setInterval.*）：0\.3 秒没退出，杀掉了/);
  });

  it('命令起不来（不存在）：抛出，不当成退出码 1', () => {
    expect(() => runChild('fleet-hygiene-no-such-command', ['x'])).toThrow(
      /子进程没跑完（fleet-hygiene-no-such-command x）：.*ENOENT/,
    );
  });

  // Windows 上没有「被信号杀掉」这回事（自己杀自己只是退出码 1），只在 POSIX 上造得出来。
  it.skipIf(process.platform === 'win32')('被信号杀掉（没有退出码）：抛出，不当成退出码 1', () => {
    expect(() => runChild(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")'])).toThrow(
      /子进程没跑完（.*）：被信号 SIGKILL 杀掉了/,
    );
  });

  it('造测试数据的 git 失败了就抛（带上 git 自己说的）；交给判定函数的 git 原样交回退出码', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-hygiene-child-'));
    try {
      gitIn(dir, 'init', '-q', '-b', 'main');
      expect(() => gitIn(dir, 'rev-parse', '--verify', 'no-such-rev')).toThrow(
        /git rev-parse --verify no-such-rev 退出码 128：fatal/,
      );
      const r = gitSyncIn(() => dir)(['rev-parse', '--verify', '--quiet', 'no-such-rev']);
      expect(r.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
