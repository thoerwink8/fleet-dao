// 测试开几个进程（按会话 scope 的内存上限算；本机人手跑再按核数和负载降一档）。读不到、认不出上限的每条路都故意造一次。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUSY_SIBLING_CORES,
  CPU_SAMPLE_MS,
  cpuShareOf,
  localWorkers,
  measureBusy,
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

/** 假的 Linux（默认在 CI 里、整机空闲）：files 里有的能读到，没有的是 ENOENT；给了 fail 的路径读的时候抛那个错。 */
function linux(
  files: Record<string, string>,
  over: Partial<TestRunEnv> = {},
  fail: Record<string, string> = {},
) {
  const reads: string[] = [];
  const env: TestRunEnv = {
    platform: 'linux',
    env: { CI: 'true' },
    cpus: 6,
    busy: () => 0,
    list: () => undefined,
    sleep: () => {},
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

  describe('本机人手跑（不在 CI、不是引擎的会话）：按核数和整机负载降一档，减少负载下的 5 秒超时假红', () => {
    const local = (over: Partial<TestRunEnv>, files: Record<string, string> = {}) =>
      linux(files, { env: {}, ...over });

    it('降一档：默认（核数 - 1）的一半，再不超过空着的核数 - 1，至少 1 个', () => {
      expect(localWorkers(16, 0)).toBe(7);
      expect(localWorkers(16, 0.5)).toBe(7);
      expect(localWorkers(16, 0.75)).toBe(3);
      expect(localWorkers(16, 1)).toBe(1);
      expect(localWorkers(6, 0)).toBe(2);
      expect(localWorkers(2, 0)).toBe(1);
      expect(localWorkers(1, 0)).toBe(1);
    });

    it('【故意造出的失败】整机忙不忙量不出：只取一半，不当成空闲照满开', () => {
      expect(localWorkers(16, undefined)).toBe(7);
      const w = testWorkers(local({ platform: 'win32', cpus: 16, busy: () => undefined }).env);
      expect(w.maxWorkers).toBe(7);
      expect(w.note).toContain('量不出');
    });

    it('本机 Windows 16 核、忙 75%：开 3 个，说明里写核数、负载、默认几个、CI 不降', () => {
      const { env, reads } = local({ platform: 'win32', cpus: 16, busy: () => 0.75 });
      const w = testWorkers(env);
      expect(w.maxWorkers).toBe(3);
      expect(w.note).toContain('16 核');
      expect(w.note).toContain('75%');
      expect(w.note).toContain('默认 15 个');
      expect(w.note).toContain('CI 不降');
      expect(reads).toEqual([]);
    });

    it('同样的机器在 CI 里：照 vitest 默认，不问负载', () => {
      const asked: string[] = [];
      const { env } = linux({}, { platform: 'win32', cpus: 16, busy: () => (asked.push('busy'), 1) });
      expect(testWorkers(env)).toEqual({ maxWorkers: undefined });
      expect(asked).toEqual([]);
    });

    it('本机 Linux 有内存上限：内存放得下的和降一档的取小的，两条都写进说明', () => {
      const w = testWorkers(local({}, session(1536, 2048)).env);
      expect(w.maxWorkers).toBe(1);
      expect(w.note).toContain('1536 MiB');
      expect(w.note).toContain('降一档');
      const roomy = testWorkers(local({}, session(64 * 1024)).env);
      expect(roomy.maxWorkers).toBe(localWorkers(6, 0));
    });

    it('引擎的会话（环境里有 FLEET_RUN_ID）：不降一档、不问整机负载，按内存算，每次都打一句「测试开 N 个进程」', () => {
      const asked: string[] = [];
      const busy = () => (asked.push('busy'), 1);
      const roomy = testWorkers(local({ env: { FLEET_RUN_ID: 'r1' }, busy }, session(64 * 1024)).env);
      expect(roomy.maxWorkers).toBe(5);
      expect(roomy.note).toContain('测试开 5 个进程（默认 5 个');
      expect(roomy.note).toContain('同一池子里的会话读不到，核数不分');
      expect(
        testWorkers(local({ env: { FLEET_RUN_ID: 'r1' }, busy }, session(1536, 2048)).env).maxWorkers,
      ).toBe(1);
      expect(testWorkers(local({ platform: 'win32', env: { FLEET_RUN_ID: 'r1' }, busy }).env)).toEqual({
        maxWorkers: undefined,
      });
      expect(asked).toEqual([]);
    });

    it('给了 VITEST_MAX_WORKERS：本机也交给 vitest 自己认，不降', () => {
      expect(testWorkers(local({ env: { VITEST_MAX_WORKERS: '12' } }).env)).toEqual({
        maxWorkers: undefined,
      });
    });

    it('真量一次：回 0–1 之间的数（量不出是 undefined，不回负数、不回大于 1）', () => {
      const b = measureBusy(process.platform, 50);
      if (b !== undefined) {
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(1);
      }
      expect(realTestRunEnv().busy).toBeTypeOf('function');
    });
  });

  describe('同一个池子（fleet-agents.slice）里几个会话一起跑：按池子剩多少内存、在跑的会话数分核', () => {
    const POOL = '/sys/fs/cgroup/fleet.slice/fleet-agents.slice';
    const engine = { FLEET_RUN_ID: 'r1' };

    /** 法国的样子：scope 软 5888M、硬 6144M，池子软 10152M、硬 10664M；poolUsed、selfUsed 是两层的 memory.current（MiB）。 */
    function pool(
      poolUsed: number | undefined,
      selfUsed: number | undefined,
      extra: Record<string, string> = {},
    ) {
      return session(5888, 6144, {
        [`${POOL}/memory.high`]: `${10152 * MIB}\n`,
        [`${POOL}/memory.max`]: `${10664 * MIB}\n`,
        ...(poolUsed === undefined ? {} : { [`${POOL}/memory.current`]: `${poolUsed * MIB}\n` }),
        ...(selfUsed === undefined
          ? {}
          : { [`/sys/fs/cgroup${SCOPE}/memory.current`]: `${selfUsed * MIB}\n` }),
        ...extra,
      });
    }

    /** 兄弟 scope：名字 → 采样那 300 毫秒里平均用了几个核（cpu.stat 的 usage_usec 前后两次之差）。 */
    function siblings(files: Record<string, string>, cores: Record<string, number>) {
      // 每等一次，各兄弟的累计用量涨「核数 × 采样毫秒」：同一个假环境问几次都对
      const sleeps: number[] = [];
      const usage = (name: string) =>
        `usage_usec ${1_000_000 + sleeps.length * Math.round((cores[name] ?? 0) * CPU_SAMPLE_MS * 1000)}\nuser_usec 1\n`;
      const { env, reads } = linux(files, {
        env: engine,
        list: (dir) =>
          dir === POOL
            ? ['cgroup.procs', 'memory.high', 'fleet-agent-1.scope', ...Object.keys(cores)]
            : undefined,
        sleep: (ms) => {
          sleeps.push(ms);
        },
      });
      const read = env.read;
      env.read = (path) => {
        const m = path.match(/^\/sys\/fs\/cgroup\/fleet\.slice\/fleet-agents\.slice\/([^/]+)\/cpu\.stat$/);
        if (m?.[1] && m[1] in cores) return usage(m[1]);
        return read(path);
      };
      return { env, reads, sleeps };
    }

    it('池子剩得少（法国那次：别的会话已用 3.8G + 2.9G + 1.8G）：按池子上限减别人已用的算，降到 1 个，说明里写清', () => {
      const { env } = linux(pool(8500 + 300, 300), { env: engine });
      expect(memoryLimitOf(env)).toEqual({
        kind: 'limited',
        mib: 10152 - 8500,
        source: `${POOL}/memory.high`,
        limitMib: 10152,
        othersMib: 8500,
      });
      const w = testWorkers(env);
      expect(w.maxWorkers).toBe(1);
      expect(w.note).toContain('测试开 1 个进程');
      expect(w.note).toContain('同层别的会话已用 8500 MiB');
      expect(w.note).toContain('连一个都不够');
    });

    it('池子剩一半：放得下几个开几个（剩 10152 − 5000 = 5152，(5152 − 1300) ÷ 900 = 4 个）；池子空着照 scope 自己的上限开 5 个', () => {
      expect(testWorkers(linux(pool(5000 + 200, 200), { env: engine }).env).maxWorkers).toBe(4);
      expect(testWorkers(linux(pool(200, 200), { env: engine }).env).maxWorkers).toBe(5);
      // 别人已用的超过了池子的上限：能用的记 0、照样开 1 个，不出负数
      expect(memoryLimitOf(linux(pool(12_000, 100)).env)).toMatchObject({ mib: 0, othersMib: 11_900 });
      expect(testWorkers(linux(pool(12_000, 100), { env: engine }).env).maxWorkers).toBe(1);
    });

    it('【故意造出的失败】池子或自己那层的 memory.current 读不到（不在、没权限、认不出）：照原来只按上限算，不报错', () => {
      for (const files of [
        pool(undefined, 300),
        pool(9000, undefined),
        pool(9000, 300, { [`${POOL}/memory.current`]: 'abc\n' }),
      ]) {
        const { env } = linux(files, { env: engine });
        expect(memoryLimitOf(env)).toEqual({
          kind: 'limited',
          mib: 5888,
          source: `/sys/fs/cgroup${SCOPE}/memory.high`,
        });
        expect(testWorkers(env).maxWorkers).toBe(5);
      }
      const { env } = linux(pool(9000, 300), { env: engine }, { [`${POOL}/memory.current`]: 'EACCES' });
      expect(testWorkers(env).maxWorkers).toBe(5);
    });

    it('6 核、池子里另有 2 个会话在跑测试（各用 2 个核）、1 个在等模型、中转桥闲着：3 个会话分，每个 2 个', () => {
      const { env, sleeps } = siblings(pool(3000, 200), {
        'fleet-agent-2.scope': 2,
        'fleet-agent-3.scope': 2,
        'fleet-agent-4.scope': 0.05,
        'fleet-agent-mirasim-5.scope': 0,
      });
      expect(cpuShareOf(env)).toEqual({ active: 3, cores: 2, parent: POOL });
      const w = testWorkers(env);
      expect(w.maxWorkers).toBe(2);
      expect(w.note).toContain('测试开 2 个进程');
      expect(w.note).toContain(`${POOL} 里 3 个会话在跑（含这个），6 核每个分 2 个`);
      expect(sleeps.every((ms) => ms === CPU_SAMPLE_MS)).toBe(true);
    });

    it('在跑的会话比核还多：每个 1 个；刚过门槛（半个核）算在跑，不到不算', () => {
      const many = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`fleet-agent-${i + 2}.scope`, 1]));
      expect(cpuShareOf(siblings(pool(200, 200), many).env)).toMatchObject({ active: 8, cores: 1 });
      expect(testWorkers(siblings(pool(200, 200), many).env).maxWorkers).toBe(1);
      expect(
        cpuShareOf(
          siblings(pool(200, 200), { 'a.scope': BUSY_SIBLING_CORES, 'b.scope': BUSY_SIBLING_CORES - 0.01 })
            .env,
        ),
      ).toMatchObject({ active: 2, cores: 3 });
    });

    it('只有自己在跑（兄弟都闲着）：不分核，照内存和默认开 5 个', () => {
      const { env } = siblings(pool(200, 200), { 'fleet-agent-2.scope': 0, 'fleet-agent-3.scope': 0.1 });
      expect(cpuShareOf(env)).toEqual({ active: 1, cores: 6, parent: POOL });
      expect(testWorkers(env).maxWorkers).toBe(5);
    });

    it('【故意造出的失败】池子列不出、兄弟的 cpu.stat 读着出错：照原来不分核，不报错', () => {
      const { env } = linux(pool(200, 200), { env: engine, list: () => undefined });
      expect(cpuShareOf(env)).toBeUndefined();
      expect(testWorkers(env).maxWorkers).toBe(5);
      const throwing = linux(pool(200, 200), {
        env: engine,
        list: () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      });
      expect(cpuShareOf(throwing.env)).toBeUndefined();
      expect(testWorkers(throwing.env).maxWorkers).toBe(5);
      const badStat = linux(
        pool(200, 200),
        { env: engine, list: () => ['fleet-agent-2.scope'] },
        {
          [`${POOL}/fleet-agent-2.scope/cpu.stat`]: 'EACCES',
        },
      );
      expect(cpuShareOf(badStat.env)).toEqual({ active: 1, cores: 6, parent: POOL });
    });

    it('本机那条（法国引擎交活前的自测不带 FLEET_RUN_ID）也看池子：降一档的和分到的核取小', () => {
      const { env } = siblings(
        pool(200, 200),
        Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`s${i}.scope`, 1])),
      );
      env.env = {};
      const w = testWorkers(env);
      expect(w.maxWorkers).toBe(1);
      expect(w.note).toContain('6 个会话在跑');
    });

    it('CI 里不分核、不读池子的兄弟', () => {
      const { env, sleeps } = siblings(pool(200, 200), { 'fleet-agent-2.scope': 6 });
      env.env = { CI: 'true' };
      expect(testWorkers(env)).toEqual({ maxWorkers: 5 });
      expect(sleeps).toEqual([]);
    });
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
      expect(env.list(join(dir, 'no-such-dir'))).toBeUndefined();
      expect(env.list(dir)).toEqual([]);
    });
  });
});
