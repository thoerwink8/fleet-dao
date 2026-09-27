// 本仓的测试开几个进程：有内存上限（引擎的会话被关在有上限的 scope 里）就按上限算，没有上限（本机、CI）照 vitest 默认。
// vitest.config.ts 用这里；只读 /proc、/sys/fs/cgroup 两处，其余都能换成假的来测。
//
// 为什么：vitest 默认开「核数 - 1」个进程（法国 6 核就是 5 个），不看内存上限；每个进程还要自己建一份内存里的 Postgres
// （packages/db/src/testing.ts 的 PGlite 模板，跑完迁移再按测试文件克隆），一个进程常驻就要 0.9–1.3G。#160 的写码会话在
// 软上限 1.5G 的 scope 里开 5 个进程，被内核压着回收、十几分钟一动不动。读不到、认不出上限就报错、不猜成「没有上限」：
// 要跑就用 VITEST_MAX_WORKERS=<进程数> 指定（vitest 自己认这个变量，盖过这里算的）。
// 不用 process.constrainedMemory()：它「没有上限」和「没读到」都回 0，分不开。
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

/**
 * 每多开一个测试进程，峰值多出多少（MiB）。实测（同一组测试：packages/api、packages/db、packages/engine/test/real，57 个文件）：
 * - 法国 2026-09-26（临时 scope，含页缓存）：开 1、2、3 个进程峰值约 1613、2493、3164，每多一个多 880、671；
 * - 本机 Windows 2026-09-27（整棵进程树的工作集）：1510、2344、2971，每多一个多 834、627。
 * 取两边最大的 880，往上取整。
 */
export const WORKER_MIB = 900;
/**
 * 同一个 cgroup 里，除了「每多一个进程」那部分以外要留的（MiB）：开 1 个进程时的峰值（法国另一次读到回收不掉的至少约 1697，
 * 比上面含页缓存的 1613 还高，按 1700 算）减掉一个 WORKER_MIB，加会话自己的 Claude Code 进程（#160 那次约 270，按 300 算）
 * 和外面那层 pnpm（约 60），再留约 140（峰值的 5% 上下）：1700 - 900 + 300 + 60 + 140 = 1300。
 * 在法国复测：docs/ops.md 第五节「会话的内存上限和测试进程数」。
 */
export const RESERVE_MIB = 1300;

const MIB = 1024 * 1024;
const CGROUP_ROOT = '/sys/fs/cgroup';

export class TestRunConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestRunConfigError';
  }
}

export interface TestRunEnv {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** 能用的核数（os.availableParallelism，vitest 默认进程数也是按它算的）。 */
  cpus: number;
  /** 读文件：不在（ENOENT）返回 undefined，别的错照抛。 */
  read(path: string): string | undefined;
}

export function realTestRunEnv(): TestRunEnv {
  return {
    platform: process.platform,
    env: process.env,
    cpus: availableParallelism(),
    read(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw e;
      }
    },
  };
}

export type MemoryLimit = { kind: 'none' } | { kind: 'limited'; mib: number; source: string };

const OVERRIDE_HINT = '要跑就用 VITEST_MAX_WORKERS=<进程数> 指定';

/**
 * 本进程所在 cgroup 的内存上限：从自己那层往上走到根，每层的 memory.high（软上限：超了被压着回收）和 memory.max（硬上限）
 * 里最小的那个。某层没有这两个文件是那层没开内存控制（根上本来就没有），不算读不到；只认 cgroup v2。
 */
export function memoryLimitOf(env: TestRunEnv): MemoryLimit {
  const self = env.read('/proc/self/cgroup');
  if (self === undefined) {
    throw new TestRunConfigError(`读不到 /proc/self/cgroup，不知道本进程的内存上限：${OVERRIDE_HINT}`);
  }
  const line = self.split('\n').find((l) => l.startsWith('0::'));
  const path = line?.slice(3).trim();
  if (!path?.startsWith('/')) {
    throw new TestRunConfigError(
      `/proc/self/cgroup 里认不出 cgroup v2 那一行（「0::/…」），不知道本进程的内存上限：${OVERRIDE_HINT}`,
    );
  }
  if (env.read(`${CGROUP_ROOT}/cgroup.controllers`) === undefined) {
    throw new TestRunConfigError(
      `${CGROUP_ROOT} 下不是 cgroup v2（没有 cgroup.controllers），不知道本进程的内存上限：${OVERRIDE_HINT}`,
    );
  }
  let best: { mib: number; source: string } | undefined;
  for (let dir = path; ; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') {
    for (const file of ['memory.high', 'memory.max']) {
      const full = `${CGROUP_ROOT}${dir === '/' ? '' : dir}/${file}`;
      const raw = env.read(full);
      if (raw === undefined) continue;
      const value = raw.trim();
      if (value === 'max') continue;
      if (!/^\d+$/.test(value)) {
        throw new TestRunConfigError(`${full} 的内容认不出（「${value.slice(0, 40)}」）：${OVERRIDE_HINT}`);
      }
      const mib = Math.floor(Number(value) / MIB);
      if (!best || mib < best.mib) best = { mib, source: full };
    }
    if (dir === '/') break;
  }
  return best ? { kind: 'limited', ...best } : { kind: 'none' };
}

export interface TestWorkers {
  /** 给 vitest 的 maxWorkers；undefined 是照 vitest 默认（或 VITEST_MAX_WORKERS）。 */
  maxWorkers: number | undefined;
  /** 进程数比默认少时的一句说明（跑测试时打出来，免得有人以为机器慢）。 */
  note?: string;
}

/** 一个上限放得下几个测试进程（至少 1 个：一个都放不下也照样开 1 个，由调用方写明会很慢）。 */
export function workersThatFit(limitMib: number): number {
  return Math.max(Math.floor((limitMib - RESERVE_MIB) / WORKER_MIB), 1);
}

/** 按内存上限算测试开几个进程：不超过 vitest 默认的「核数 - 1」，至少 1 个。 */
export function testWorkers(env: TestRunEnv = realTestRunEnv()): TestWorkers {
  const override = env.env.VITEST_MAX_WORKERS?.trim();
  if (override) {
    // vitest 自己读这个变量时用 parseInt：「abc」读成 NaN、悄悄退回默认，「2.5」读成 2。认不出的这里先拦下。
    if (!/^[1-9]\d*$/.test(override)) {
      throw new TestRunConfigError(`VITEST_MAX_WORKERS 要是正整数，现在是「${override}」`);
    }
    return { maxWorkers: undefined };
  }
  if (env.platform !== 'linux') return { maxWorkers: undefined };
  const limit = memoryLimitOf(env);
  if (limit.kind === 'none') return { maxWorkers: undefined };
  const byDefault = Math.max(env.cpus - 1, 1);
  const maxWorkers = Math.min(byDefault, workersThatFit(limit.mib));
  if (maxWorkers >= byDefault) return { maxWorkers };
  const tight =
    limit.mib < RESERVE_MIB + WORKER_MIB
      ? `，连一个都不够（要 ${RESERVE_MIB + WORKER_MIB} MiB），照样开 1 个、会很慢`
      : '';
  return {
    maxWorkers,
    note: `测试按内存上限 ${limit.mib} MiB（${limit.source}）开 ${maxWorkers} 个进程（默认 ${byDefault} 个）${tight}`,
  };
}
