// 测试开几个进程（按会话 scope 的内存上限算）。读不到、认不出上限的每条路都故意造一次。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  memoryLimitOf,
  RESERVE_MIB,
  realTestRunEnv,
  TestRunConfigError,
  type TestRunEnv,
  testWorkers,
  WORKER_MIB,
  workersThatFit,
} from '../src/test-run.ts';

const MIB = 1024 * 1024;
const SCOPE = '/fleet.slice/fleet-agents.slice/fleet-agent-1.scope';

/** 假的 Linux：files 里有的能读到，没有的是 ENOENT；给了 fail 的路径读的时候抛那个错。 */
function linux(
  files: Record<string, string>,
  over: Partial<TestRunEnv> = {},
  fail: Record<string, string> = {},
) {
  const reads: string[] = [];
  const env: TestRunEnv = {
    platform: 'linux',
    env: {},
    cpus: 6,
    read(path) {
      reads.push(path);
      const code = fail[path];
      if (code) throw Object.assign(new Error(`${code}: ${path}`), { code });
      return files[path];
    },
    ...over,
  };
  return { env, reads };
}

/** 会话的样子：进程在 scope 里，scope 有软、硬上限，上面几层不设限。 */
function session(
  highMib: number | 'max',
  maxMib: number | 'max' = 'max',
  extra: Record<string, string> = {},
) {
  const bytes = (v: number | 'max') => (v === 'max' ? 'max\n' : `${v * MIB}\n`);
  return {
    '/proc/self/cgroup': `0::${SCOPE}\n`,
    '/sys/fs/cgroup/cgroup.controllers': 'cpu io memory pids\n',
    [`/sys/fs/cgroup${SCOPE}/memory.high`]: bytes(highMib),
    [`/sys/fs/cgroup${SCOPE}/memory.max`]: bytes(maxMib),
    '/sys/fs/cgroup/fleet.slice/fleet-agents.slice/memory.high': 'max\n',
    '/sys/fs/cgroup/fleet.slice/fleet-agents.slice/memory.max': 'max\n',
    '/sys/fs/cgroup/fleet.slice/memory.max': 'max\n',
    ...extra,
  };
}

describe('测试开几个进程：按本进程所在 cgroup 的内存上限算', () => {
  it('会话 scope 上限 2G（#160 那次是软 1.5G、硬 2G）：比 vitest 默认（6 核开 5 个）少，说明里写清上限从哪来', () => {
    const { env } = linux(session(1536, 2048));
    const w = testWorkers(env);
    expect(w.maxWorkers).toBe(1);
    expect(w.note).toContain('1536 MiB');
    expect(w.note).toContain(`${SCOPE}/memory.high`);
    expect(w.note).toContain('默认 5 个');
    // 只有硬上限 2G 也一样少
    expect(testWorkers(linux(session('max', 2048)).env).maxWorkers).toBeLessThan(5);
  });

  it('放得下几个：(上限 - 留给主进程和 Claude Code 的) ÷ 每个进程，至少 1 个', () => {
    expect(workersThatFit(RESERVE_MIB + WORKER_MIB)).toBe(1);
    expect(workersThatFit(RESERVE_MIB + 2 * WORKER_MIB)).toBe(2);
    expect(workersThatFit(RESERVE_MIB + 3 * WORKER_MIB - 1)).toBe(2);
    expect(workersThatFit(0)).toBe(1);
    // 法国 3 个进程的实测峰值 3164 MiB 加 Claude Code 约 300：放得下 3 个的上限要比它大
    expect(RESERVE_MIB + 3 * WORKER_MIB).toBeGreaterThan(3164 + 300);
  });

  it('软上限、硬上限、上面几层取最小的：slice 的硬上限更小就按它', () => {
    const files = session(4096, 4608, {
      '/sys/fs/cgroup/fleet.slice/fleet-agents.slice/memory.max': `${3072 * MIB}`,
    });
    expect(memoryLimitOf(linux(files).env)).toEqual({
      kind: 'limited',
      mib: 3072,
      source: '/sys/fs/cgroup/fleet.slice/fleet-agents.slice/memory.max',
    });
  });

  it('没有上限（本机、CI：一路都是 max 或者没开内存控制）：照 vitest 默认，不设 maxWorkers', () => {
    expect(testWorkers(linux(session('max')).env)).toEqual({ maxWorkers: undefined });
    const noController = {
      '/proc/self/cgroup': '0::/user.slice/user-1000.slice/session-3.scope\n',
      '/sys/fs/cgroup/cgroup.controllers': 'cpu memory\n',
    };
    expect(memoryLimitOf(linux(noController).env)).toEqual({ kind: 'none' });
    expect(testWorkers(linux(noController).env)).toEqual({ maxWorkers: undefined });
  });

  it('容器里（cgroup 命名空间，自己就是「0::/」）：读 /sys/fs/cgroup/memory.max', () => {
    const files = {
      '/proc/self/cgroup': '0::/\n',
      '/sys/fs/cgroup/cgroup.controllers': 'memory\n',
      '/sys/fs/cgroup/memory.max': `${4096 * MIB}\n`,
    };
    expect(memoryLimitOf(linux(files).env)).toMatchObject({ kind: 'limited', mib: 4096 });
  });

  it('上限够开默认那么多：就开默认那么多，不打说明', () => {
    expect(testWorkers(linux(session(64 * 1024)).env)).toEqual({ maxWorkers: 5 });
  });

  it('上限小到一个都不够：照样开 1 个，说明里写明会很慢', () => {
    const w = testWorkers(linux(session(RESERVE_MIB)).env);
    expect(w.maxWorkers).toBe(1);
    expect(w.note).toContain('连一个都不够');
  });

  it('不是 Linux（本机 Windows、macOS 没有 cgroup）：照默认，一个文件都不读', () => {
    const { env, reads } = linux({}, { platform: 'win32' });
    expect(testWorkers(env)).toEqual({ maxWorkers: undefined });
    expect(reads).toEqual([]);
  });

  describe('读不到、认不出：报错，不猜成「没有上限」', () => {
    it('读不到 /proc/self/cgroup', () => {
      const { env } = linux({});
      expect(() => testWorkers(env)).toThrow(TestRunConfigError);
      expect(() => testWorkers(env)).toThrow(/读不到 \/proc\/self\/cgroup.*VITEST_MAX_WORKERS/);
    });

    it('/proc/self/cgroup 格式认不出（只有 cgroup v1 的行）', () => {
      const { env } = linux({ '/proc/self/cgroup': '12:memory:/user.slice\n11:cpu:/user.slice\n' });
      expect(() => testWorkers(env)).toThrow(/认不出 cgroup v2 那一行/);
    });

    it('/sys/fs/cgroup 不是 cgroup v2（没挂、或是 v1）', () => {
      const files: Record<string, string> = session(2048);
      delete files['/sys/fs/cgroup/cgroup.controllers'];
      expect(() => testWorkers(linux(files).env)).toThrow(/不是 cgroup v2/);
    });

    it('memory.high 的内容认不出：报错、写明哪个文件', () => {
      const files = session(2048, 2304, { [`/sys/fs/cgroup${SCOPE}/memory.high`]: '2G\n' });
      expect(() => testWorkers(linux(files).env)).toThrow(
        `/sys/fs/cgroup${SCOPE}/memory.high 的内容认不出（「2G」）`,
      );
    });

    it('读文件报别的错（没权限）：照抛，不当成那一层没设限', () => {
      const { env } = linux(session(2048), {}, { [`/sys/fs/cgroup${SCOPE}/memory.high`]: 'EACCES' });
      expect(() => testWorkers(env)).toThrow(/EACCES/);
    });

    it('VITEST_MAX_WORKERS 不是正整数：报错（vitest 自己读会把 abc 悄悄当成默认、2.5 当成 2）', () => {
      for (const bad of ['0', 'abc', '2.5', '-1']) {
        const { env } = linux(session(2048), { env: { VITEST_MAX_WORKERS: bad } });
        expect(() => testWorkers(env)).toThrow(/VITEST_MAX_WORKERS 要是正整数/);
      }
    });
  });

  it('给了 VITEST_MAX_WORKERS：交给 vitest 自己认，不读 cgroup（读不到也不报错）', () => {
    const { env, reads } = linux({}, { env: { VITEST_MAX_WORKERS: '2' } });
    expect(testWorkers(env)).toEqual({ maxWorkers: undefined });
    expect(reads).toEqual([]);
  });

  describe('真读文件', () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it('不在的文件回 undefined，别的错（读的是目录）照抛', () => {
      dir = mkdtempSync(join(tmpdir(), 'fleet-test-run-'));
      const env = realTestRunEnv();
      expect(env.read(join(dir, 'no-such-file'))).toBeUndefined();
      expect(() => env.read(dir as string)).toThrow();
    });
  });
});
