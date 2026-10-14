// 本仓的测试开几个进程：有内存上限（引擎的会话被关在有上限的 scope 里）就按上限算；CI、引擎的会话里没有上限照 vitest 默认；
// 本机人手跑的（不在 CI、环境里没有 FLEET_RUN_ID）再按核数和整机负载降一档（localWorkers）。vitest.config.ts 用这里；只读 /proc、/sys/fs/cgroup
// 两处和整机 CPU 忙不忙，其余都能换成假的来测。
//
// 为什么本机降一档（决定 0093）：vitest 默认开「核数 - 1」个进程，本机同时还有别的会话、浏览器、另一个测试槽
// （test-slots.ts 同时放 2 个）在跑，十几个进程抢核时起子进程的测试常超 vitest 的 5 秒（单跑 1–2 秒的也会），假红。
// 开一半、再按空着的核数往下压。CI（专用运行机，CI=true）不变；引擎的会话也不变：交活前的自测限 8 分钟
// （docs/design.md「引擎自测」），法国 6 核降一档只剩 2 个，超时就记「没跑」，得不偿失。
//
// 为什么：vitest 默认开「核数 - 1」个进程（法国 6 核就是 5 个），不看内存上限；每个进程还要自己建一份内存里的 Postgres
// （packages/db/src/testing.ts 的 PGlite 模板，跑完迁移再按测试文件克隆），一个进程常驻就要 0.9–1.3G。#160 的写码会话在
// 软上限 1.5G 的 scope 里开 5 个进程，被内核压着回收、十几分钟一动不动。读不到、认不出上限就报错、不猜成「没有上限」：
// 要跑就用 VITEST_MAX_WORKERS=<进程数> 指定（vitest 自己认这个变量，盖过这里算的）。
// 不用 process.constrainedMemory()：它「没有上限」和「没读到」都回 0，分不开。
import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg } from 'node:os';

/**
 * 每多开一个测试进程，峰值多出多少（MiB）。实测（同一组测试：packages/api、packages/db、packages/engine/test/real，57 个文件）：
 * - 法国（临时 scope，含页缓存）：开 1、2、3 个进程峰值约 1613、2493、3164，每多一个多 880、671；
 * - 本机 Windows（整棵进程树的工作集）：1510、2344、2971，每多一个多 834、627。
 * 取两边最大的 880，往上取整。
 * #220：上面两组实测都是「每个进程一份内存 PGlite」的时候测的。CI 改成共用一个真 Postgres、从模板库克隆之后，
 * 需求文档估每个进程降到 ~300 MiB。这个值还没在 CI（带 FLEET_TEST_PG_URL 的那条分片）实测过，所以现在不改；
 * 测过之后再调，连同下面 RESERVE_MIB 一起。
 */
export const WORKER_MIB = 900;
/**
 * 同一个 cgroup 里，除了「每多一个进程」那部分以外要留的（MiB）：开 1 个进程时的峰值（法国另一次读到回收不掉的至少约 1697，
 * 比上面含页缓存的 1613 还高，按 1700 算）减掉一个 WORKER_MIB，加会话自己的 Claude Code 进程（#160 那次约 270，按 300 算）
 * 和外面那层 pnpm（约 60），再留约 140（峰值的 5% 上下）：1700 - 900 + 300 + 60 + 140 = 1300。
 * 在法国复测：docs/ops.md 第五节「会话的内存上限和测试进程数」。
 * #220：和 WORKER_MIB 一起等 CI 实测过真 Postgres 后端再调（一个进程建库克隆那部分省掉了，但 pnpm 和 Claude Code 那俩
 * 一直是 360 上下）。
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
  /** 整机 CPU 忙的比例（0–1）；量不出是 undefined。只在本机人手跑时问。 */
  busy(): number | undefined;
}

/** 照旧（不降一档）的环境：CI（GitHub Actions 设 CI=true，和 test-changed.ts 的认法一样）、引擎起的会话（带 FLEET_RUN_ID，同 test-changed.ts 的 ENGINE_SESSION_MARKER）。 */
function keepsDefault(env: Readonly<Record<string, string | undefined>>): boolean {
  const v = env.CI?.trim().toLowerCase();
  const ci = v !== undefined && v !== '' && v !== 'false' && v !== '0';
  return ci || Boolean(env.FLEET_RUN_ID?.trim());
}

/**
 * 量整机 CPU 忙的比例。Windows 没有 loadavg（恒为 0），隔 ms 毫秒取两次各核的累计时间算；别的平台用 1 分钟 loadavg ÷ 核数
 * （封顶 1）。量不出（时间没走、读数不对）回 undefined，调用方按「不知道」处理，不当成空闲。
 */
export function measureBusy(platform: NodeJS.Platform = process.platform, ms = 200): number | undefined {
  if (platform !== 'win32') {
    const load = loadavg()[0];
    const n = availableParallelism();
    return load === undefined || !Number.isFinite(load) || n <= 0
      ? undefined
      : Math.min(Math.max(load / n, 0), 1);
  }
  const sum = () =>
    cpus().reduce(
      (acc, c) => {
        const t = c.times;
        return { idle: acc.idle + t.idle, all: acc.all + t.user + t.nice + t.sys + t.idle + t.irq };
      },
      { idle: 0, all: 0 },
    );
  const a = sum();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const b = sum();
  const all = b.all - a.all;
  if (!(all > 0)) return undefined;
  return Math.min(Math.max(1 - (b.idle - a.idle) / all, 0), 1);
}

export function realTestRunEnv(): TestRunEnv {
  return {
    platform: process.platform,
    env: process.env,
    cpus: availableParallelism(),
    busy: () => measureBusy(),
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

/**
 * 本机人手跑时开几个：vitest 默认（核数 - 1）的一半，再不超过「空着的核数 - 1」（busy 量不出就只取一半），至少 1 个。
 * 16 核空闲开 7 个；整机忙一半开 7 个；忙到 75% 开 3 个。
 */
export function localWorkers(cpuCount: number, busy: number | undefined): number {
  const byDefault = Math.max(cpuCount - 1, 1);
  const tier = Math.max(Math.floor(byDefault / 2), 1);
  if (busy === undefined) return tier;
  return Math.max(Math.min(tier, Math.floor(cpuCount * (1 - busy)) - 1), 1);
}

/** 测试开几个进程：CI、引擎的会话里只按内存上限算（不超过 vitest 默认的「核数 - 1」）；本机人手跑再按核数和负载降一档。至少 1 个。 */
export function testWorkers(env: TestRunEnv = realTestRunEnv()): TestWorkers {
  const override = env.env.VITEST_MAX_WORKERS?.trim();
  if (override) {
    // vitest 自己读这个变量时用 parseInt：「abc」读成 NaN、悄悄退回默认，「2.5」读成 2。认不出的这里先拦下。
    if (!/^[1-9]\d*$/.test(override)) {
      throw new TestRunConfigError(`VITEST_MAX_WORKERS 要是正整数，现在是「${override}」`);
    }
    return { maxWorkers: undefined };
  }
  const byDefault = Math.max(env.cpus - 1, 1);
  const limit: MemoryLimit = env.platform === 'linux' ? memoryLimitOf(env) : { kind: 'none' };
  const byMemory = limit.kind === 'limited' ? workersThatFit(limit.mib) : byDefault;
  const memNote =
    limit.kind === 'limited' && byMemory < byDefault
      ? `内存上限 ${limit.mib} MiB（${limit.source}）${
          limit.mib < RESERVE_MIB + WORKER_MIB
            ? `，连一个都不够（要 ${RESERVE_MIB + WORKER_MIB} MiB），照样开 1 个、会很慢`
            : ''
        }`
      : undefined;
  if (keepsDefault(env.env)) {
    if (limit.kind === 'none') return { maxWorkers: undefined };
    const maxWorkers = Math.min(byDefault, byMemory);
    if (maxWorkers >= byDefault) return { maxWorkers };
    return { maxWorkers, note: `测试按${memNote}开 ${maxWorkers} 个进程（默认 ${byDefault} 个）` };
  }
  const busy = env.busy();
  const local = localWorkers(env.cpus, busy);
  const maxWorkers = Math.min(local, byMemory);
  const load = busy === undefined ? '整机忙不忙量不出' : `整机 CPU 忙 ${Math.round(busy * 100)}%`;
  const why = [`本机按 ${env.cpus} 核、${load}，降一档`, ...(memNote === undefined ? [] : [memNote])].join(
    '；',
  );
  return {
    maxWorkers,
    note: `测试开 ${maxWorkers} 个进程（默认 ${byDefault} 个；${why}；CI、引擎的会话不降，要指定用 VITEST_MAX_WORKERS）`,
  };
}
