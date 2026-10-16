// 本仓的测试开几个进程：按「真正能用」的内存算（每一层 cgroup 的上限减掉同层别的会话已用的，取最小）；CI 里没有上限照 vitest 默认；
// 引擎的会话（环境里有 FLEET_RUN_ID）再按同一个池子里同时在跑的会话分核（cpuShareOf）；本机人手跑的（不在 CI、没有 FLEET_RUN_ID，
// 法国引擎交活前的自测也走这条）再按核数和整机负载降一档（localWorkers）。vitest.config.ts 用这里；只读 /proc、/sys/fs/cgroup
// 两处和整机 CPU 忙不忙，其余都能换成假的来测。
//
// 为什么看父节点剩多少、按兄弟会话分核（决定 0093）：法国的会话各关在 fleet-agent-<编号>.scope 里（软上限 5888M），都挂在
// fleet-agents.slice（软上限 10152M）下面、共用 6 个核。只看自己那层，每个会话都以为自己能开 5 个进程：三个会话同时 pnpm check，
// 池子冲到 10.8G（超了软上限）、整机可用只剩 1.2G、swap 用了 2.7G，1 分钟负载 29（6 核），测试被压着回收、互相抢核，变慢、超时。
// 所以内存按「这一层上限 − 同层别的会话已用」算，核按「在跑的会话数」平分。父节点、兄弟会话读不到就按原来的只看上限、不分核，不报错。
//
// 为什么本机降一档：vitest 默认开「核数 - 1」个进程，本机同时还有别的会话、浏览器、另一个测试槽
// （test-slots.ts 同时放 2 个）在跑，十几个进程抢核时起子进程的测试常超 vitest 的 5 秒（单跑 1–2 秒的也会），假红。
// 开一半、再按空着的核数往下压。CI（专用运行机，CI=true）不变。
//
// 引擎交活前的自测限 30 分钟（docs/design.md「引擎自测」）：它不带 FLEET_RUN_ID，走的是本机那条（降一档、看整机负载）。
// 分核不会让它更容易超时：池子里 k 个会话同时跑测试时，每个会话实际只抢得到 6/k 个核，开多了只多占内存、多抢上下文，
// 总活量（CPU 时间）不变；只在「开跑那一刻兄弟忙、之后闲下来」时少用了空出来的核。
//
// 为什么：vitest 默认开「核数 - 1」个进程（法国 6 核就是 5 个），不看内存上限；每个进程还要自己建一份内存里的 Postgres
// （packages/db/src/testing.ts 的 PGlite 模板，跑完迁移再按测试文件克隆），一个进程常驻就要 0.9–1.3G。#160 的写码会话在
// 软上限 1.5G 的 scope 里开 5 个进程，被内核压着回收、十几分钟一动不动。读不到、认不出上限就报错、不猜成「没有上限」：
// 要跑就用 VITEST_MAX_WORKERS=<进程数> 指定（vitest 自己认这个变量，盖过这里算的）。
// 不用 process.constrainedMemory()：它「没有上限」和「没读到」都回 0，分不开。
import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg } from 'node:os';

/**
 * 每多开一个测试进程，峰值多出多少（MiB）。实测（同一组测试：packages/api、packages/db、packages/engine/test/real，57 个文件）：
 * - 法国（临时 scope，含页缓存）：开 1、2、3 个进程峰值约 1613、2493、3164，每多一个多 880、671；
 * - 本机 Windows（整棵进程树的工作集）：1510、2344、2971，每多一个多 834、627。
 * 取两边最大的 880，往上取整。
 * #220：上面两组实测都是「每个进程一份内存 PGlite」的时候测的。CI 改成共用一个真 Postgres、从模板库克隆之后，
 * 需求文档估每个进程降到 ~300 MiB。这个值还没在 CI（带 FLEET_TEST_PG_URL 的那条分片）实测过，所以现在不改；
 * 测过之后再调，连同下面 RESERVE_MIB 一起。
 * 法国复测（三个会话同时 pnpm check，各开 5 个进程，每个 scope 的 memory.peak）：4566、4684、4758 MiB，扣掉 RESERVE_MIB 再 ÷ 5
 * 是每个进程 653–692 MiB；同一刻各 scope 里 vitest 主进程加 5 个子进程的 RSS 合计 1988–3151 MiB，扣掉主进程（420–530）÷ 5 是
 * 每个 300–520。「22 个 vitest 进程占 3.8G」那次数的是进程树里所有带 vitest 的 node（含测试自己起的子进程），平均每个约 177 MiB，
 * 不是每个测试进程的量。900 比实测的最高（692）还宽，不调。
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
  /** 列目录（cgroup 的子层）：不在回 undefined，别的错照抛。 */
  list(path: string): string[] | undefined;
  /** 等 ms 毫秒（两次读 cpu.stat 之间）。 */
  sleep(ms: number): void;
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
    list(path) {
      try {
        return readdirSync(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw e;
      }
    },
    sleep(ms) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  };
}

/**
 * mib 是这次能用的：那一层的上限（limitMib）减掉同层别的会话已用的（othersMib，= 那一层 memory.current − 自己这层的）。
 * 本进程自己那层、或上面那层的 memory.current 读不到时只按上限算（没有 othersMib），和原来一样。
 */
export type MemoryLimit =
  | { kind: 'none' }
  | { kind: 'limited'; mib: number; source: string; limitMib?: number; othersMib?: number };

const OVERRIDE_HINT = '要跑就用 VITEST_MAX_WORKERS=<进程数> 指定';

/** /proc/self/cgroup 里 cgroup v2 那一行（「0::/…」）的路径；认不出回 undefined。 */
function selfCgroupPath(self: string): string | undefined {
  const line = self.split('\n').find((l) => l.startsWith('0::'));
  const path = line?.slice(3).trim();
  return path?.startsWith('/') ? path : undefined;
}

function parentOf(dir: string): string {
  return dir.slice(0, dir.lastIndexOf('/')) || '/';
}

function cgroupDir(dir: string): string {
  return `${CGROUP_ROOT}${dir === '/' ? '' : dir}`;
}

/** 读一个只有一个整数的文件（memory.current）。不在、读不了、认不出都回 undefined：只用来扣掉别人已用的，读不到就不扣。 */
function readBytes(env: TestRunEnv, path: string): number | undefined {
  try {
    const value = env.read(path)?.trim();
    return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
  } catch {
    return undefined;
  }
}

type Limited = Extract<MemoryLimit, { kind: 'limited' }>;

/**
 * 本进程这次能用多少内存：从自己那层往上走到根，每层取 memory.high（软上限：超了被压着回收）和 memory.max（硬上限）里小的那个；
 * 上面的层（法国是 fleet-agents.slice，几个会话共用）再减掉同层别的会话已用的（那一层的 memory.current − 自己这层的），
 * 各层里取最小。自己这层只看上限：自己已用的（Claude Code、pnpm、vitest 主进程）在 RESERVE_MIB 里算过了。
 * 某层没有上限文件是那层没开内存控制（根上本来就没有），不算读不到；memory.current 读不到就只按上限算（原来的算法），不报错。
 * 只认 cgroup v2。
 */
export function memoryLimitOf(env: TestRunEnv): MemoryLimit {
  const self = env.read('/proc/self/cgroup');
  if (self === undefined) {
    throw new TestRunConfigError(`读不到 /proc/self/cgroup，不知道本进程的内存上限：${OVERRIDE_HINT}`);
  }
  const path = selfCgroupPath(self);
  if (path === undefined) {
    throw new TestRunConfigError(
      `/proc/self/cgroup 里认不出 cgroup v2 那一行（「0::/…」），不知道本进程的内存上限：${OVERRIDE_HINT}`,
    );
  }
  if (env.read(`${CGROUP_ROOT}/cgroup.controllers`) === undefined) {
    throw new TestRunConfigError(
      `${CGROUP_ROOT} 下不是 cgroup v2（没有 cgroup.controllers），不知道本进程的内存上限：${OVERRIDE_HINT}`,
    );
  }
  const selfCurrent = readBytes(env, `${cgroupDir(path)}/memory.current`);
  let best: Limited | undefined;
  for (let dir = path; ; dir = parentOf(dir)) {
    let level: { mib: number; source: string } | undefined;
    for (const file of ['memory.high', 'memory.max']) {
      const full = `${cgroupDir(dir)}/${file}`;
      const raw = env.read(full);
      if (raw === undefined) continue;
      const value = raw.trim();
      if (value === 'max') continue;
      if (!/^\d+$/.test(value)) {
        throw new TestRunConfigError(`${full} 的内容认不出（「${value.slice(0, 40)}」）：${OVERRIDE_HINT}`);
      }
      const mib = Math.floor(Number(value) / MIB);
      if (!level || mib < level.mib) level = { mib, source: full };
    }
    if (level) {
      let candidate: Limited = { kind: 'limited', ...level };
      const levelCurrent = dir === path ? undefined : readBytes(env, `${cgroupDir(dir)}/memory.current`);
      if (selfCurrent !== undefined && levelCurrent !== undefined) {
        const othersMib = Math.floor(Math.max(levelCurrent - selfCurrent, 0) / MIB);
        candidate = {
          kind: 'limited',
          mib: Math.max(level.mib - othersMib, 0),
          source: level.source,
          limitMib: level.mib,
          othersMib,
        };
      }
      if (!best || candidate.mib < best.mib) best = candidate;
    }
    if (dir === '/') break;
  }
  return best ?? { kind: 'none' };
}

/** 两次读 cpu.stat 隔多久（毫秒）。vitest 读配置时只等这一次。 */
export const CPU_SAMPLE_MS = 300;
/** 兄弟会话算「在跑」的门槛：采样那段时间平均至少用了这么多个核。 */
export const BUSY_SIBLING_CORES = 0.5;

export interface CpuShare {
  /** 同一个父层下面在跑的会话数（含自己）。 */
  active: number;
  /** 每个会话分到几个核（核数 ÷ active，取整，至少 1）。 */
  cores: number;
  /** 父层的目录（法国是 /sys/fs/cgroup/fleet.slice/fleet-agents.slice）。 */
  parent: string;
}

/** cpu.stat 里的 usage_usec（cgroup v2 不开 cpu 控制也有这一行）。不是 cgroup、读不了、认不出回 undefined。 */
function usageUsec(env: TestRunEnv, dir: string): number | undefined {
  try {
    const m = env.read(`${dir}/cpu.stat`)?.match(/^usage_usec (\d+)$/m);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 同一个父层（法国是 fleet-agents.slice）下面同时在跑几个会话，按它平分核数。
 * 「在跑」= 隔 CPU_SAMPLE_MS 毫秒读两次兄弟层的 cpu.stat，这段时间平均用了 BUSY_SIBLING_CORES 个核以上。只数忙的、不数所有兄弟：
 * 会话多半时间在等模型回话（几乎不占核），池子里还挂着中转桥、查额度这些常驻的小 scope，按个数分会把一个人跑时也压到 1 个。
 * 读不到（自己在根上、父层列不出、读的时候出错）回 undefined，调用方照旧不分核、不报错；一个兄弟都没有（或都读不到 cpu.stat）是只有自己。
 */
export function cpuShareOf(env: TestRunEnv): CpuShare | undefined {
  try {
    const self = env.read('/proc/self/cgroup');
    const path = self === undefined ? undefined : selfCgroupPath(self);
    if (path === undefined || path === '/') return undefined;
    const parent = cgroupDir(parentOf(path));
    const own = path.slice(path.lastIndexOf('/') + 1);
    const names = env.list(parent);
    if (names === undefined) return undefined;
    const before = new Map<string, number>();
    for (const name of names) {
      if (name === own) continue;
      const usage = usageUsec(env, `${parent}/${name}`);
      if (usage !== undefined) before.set(name, usage);
    }
    let busy = 0;
    if (before.size > 0) {
      env.sleep(CPU_SAMPLE_MS);
      for (const [name, start] of before) {
        const end = usageUsec(env, `${parent}/${name}`);
        if (end !== undefined && end - start >= BUSY_SIBLING_CORES * CPU_SAMPLE_MS * 1000) busy += 1;
      }
    }
    const active = busy + 1;
    return { active, cores: Math.max(Math.floor(env.cpus / active), 1), parent };
  } catch {
    return undefined;
  }
}

export interface TestWorkers {
  /** 给 vitest 的 maxWorkers；undefined 是照 vitest 默认（或 VITEST_MAX_WORKERS）。 */
  maxWorkers: number | undefined;
  /** 进程数比默认少时（引擎的会话里每次都有）的一句说明：跑测试时打出来，免得有人以为机器慢；法国读回也看它。 */
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

/** CI（GitHub Actions 设 CI=true），认法和 test-changed.ts 一样。 */
function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const v = env.CI?.trim().toLowerCase();
  return v !== undefined && v !== '' && v !== 'false' && v !== '0';
}

function describeMemory(limit: Limited): string {
  const base =
    limit.othersMib === undefined
      ? `内存上限 ${limit.mib} MiB（${limit.source}）`
      : `内存能用 ${limit.mib} MiB（${limit.source} 是 ${limit.limitMib} MiB，同层别的会话已用 ${limit.othersMib} MiB）`;
  return limit.mib < RESERVE_MIB + WORKER_MIB
    ? `${base}，连一个都不够（要 ${RESERVE_MIB + WORKER_MIB} MiB），照样开 1 个、会很慢`
    : base;
}

function describeShare(share: CpuShare, cpus: number): string {
  return `${share.parent} 里 ${share.active} 个会话在跑（含这个），${cpus} 核每个分 ${share.cores} 个`;
}

/**
 * 测试开几个进程，至少 1 个：
 * - CI（CI=true 且没有 FLEET_RUN_ID）：只按内存算（不超过 vitest 默认的「核数 - 1」），不分核、不问负载；
 * - 引擎的会话（带 FLEET_RUN_ID，同 test-changed.ts 的 ENGINE_SESSION_MARKER）：内存放得下的、同一池子里分到的核、vitest 默认，
 *   三者取小，每次都打一句说明；
 * - 本机人手跑（含法国引擎交活前的自测）：再按核数和整机负载降一档。
 */
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
  const linux = env.platform === 'linux';
  const limit: MemoryLimit = linux ? memoryLimitOf(env) : { kind: 'none' };
  const byMemory = limit.kind === 'limited' ? workersThatFit(limit.mib) : byDefault;
  const memNote = limit.kind === 'limited' && byMemory < byDefault ? describeMemory(limit) : undefined;
  // 先认引擎的会话再认 CI：会话里的写码 CLI 给它起的命令设 CI=1（法国实测 grok 的 run_terminal_command，vitest 主进程里是
  // CI=true），先认 CI 会话就走成「不分核」；真 CI 里没有 FLEET_RUN_ID。
  const engine = Boolean(env.env.FLEET_RUN_ID?.trim());
  if (!engine && isCi(env.env)) {
    if (limit.kind === 'none') return { maxWorkers: undefined };
    const maxWorkers = Math.min(byDefault, byMemory);
    if (maxWorkers >= byDefault) return { maxWorkers };
    return { maxWorkers, note: `测试按${memNote}开 ${maxWorkers} 个进程（默认 ${byDefault} 个）` };
  }
  const share = linux ? cpuShareOf(env) : undefined;
  const byCpu = share?.cores ?? byDefault;
  if (engine) {
    if (limit.kind === 'none' && share === undefined) return { maxWorkers: undefined };
    const maxWorkers = Math.min(byDefault, byMemory, byCpu);
    const why = [
      limit.kind === 'limited' ? `${describeMemory(limit)}，放得下 ${byMemory} 个` : '内存没有上限',
      share === undefined ? '同一池子里的会话读不到，核数不分' : describeShare(share, env.cpus),
    ].join('；');
    return {
      maxWorkers,
      note: `测试开 ${maxWorkers} 个进程（默认 ${byDefault} 个；${why}；引擎的会话，要指定用 VITEST_MAX_WORKERS）`,
    };
  }
  const busy = env.busy();
  const local = localWorkers(env.cpus, busy);
  const maxWorkers = Math.min(local, byMemory, byCpu);
  const load = busy === undefined ? '整机忙不忙量不出' : `整机 CPU 忙 ${Math.round(busy * 100)}%`;
  const why = [
    `本机按 ${env.cpus} 核、${load}，降一档`,
    ...(memNote === undefined ? [] : [memNote]),
    ...(share !== undefined && share.cores < local ? [describeShare(share, env.cpus)] : []),
  ].join('；');
  return {
    maxWorkers,
    note: `测试开 ${maxWorkers} 个进程（默认 ${byDefault} 个；${why}；CI 不降，要指定用 VITEST_MAX_WORKERS）`,
  };
}
