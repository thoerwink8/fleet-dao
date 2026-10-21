// 主页的机器资源（#1973）：这台机器此刻的整机内存、CPU，和每个会话 scope 自己占的内存、CPU。
// 后端和引擎在同一台机器上（法国），直接读本机的 /proc 和 cgroup，不经引擎、不查库。每 RESOURCE_SAMPLE_MS 读一回，
// 经推送（SSE 的 resources 事件，sse.ts）发给开着的页面；主页接口（snapshots.ts）带最近一回。
//
// 改这里之前必须知道：
// - 读不到一律是 unread + 原因（文件不在、读不了、内容认不出、这台不是 Linux），页面写「没读到」；绝不拿 0 顶、不拿「正常」顶。
// - 整机 CPU 是 /proc/stat 两回读数的差（忙 = 总 − idle − iowait）；会话 CPU 是 cpu.stat 的 usage_usec 两回的差 ÷ 墙钟，
//   100 = 占满一个核。整机忙的核数 = 同一对差的忙的比例 × 核数（核数数 /proc/stat 的 cpuN 行，真读、不写常数），
//   和百分比同源。只有一回读数时算不出：整机写 unread（说明还差一回），会话不给 cpuPercent（页面写「采样中」），都不是 0。
// - 会话 scope 在 fleet-agents.slice 下，名字是 `fleet-agent-<编号>.scope`（deploy/france/fleet-agent-scope.sh 起的，
//   编号就是三段流水的编号，引擎 segment-spawner.ts 的 cgroup.id）。一回只 readdir 一次、各 scope 并排读，不逐单查库。
// - scope 在两步之间收场（文件 ENOENT）就当它不在了，不算没读到；整个 slice 目录不在才是整池没读到。
// - 只在有人看（有 SSE 连接）时才按间隔读；没人看时主页接口来要，最近一回旧了就现读一回。
// - fleet-api.service 开了 ProtectControlGroups / ProtectKernelTunables：那只是把 /sys/fs/cgroup、/proc/sys 设成只读，读不受影响。
import { readdir, readFile, statfs } from 'node:fs/promises';
import { posix } from 'node:path';
import type { DiskFootprintSchema, HomeResourcesSchema, SessionUsageSchema } from '@fleet-dao/shared';
import type { z } from 'zod';
import type { Logger } from './ports.ts';
import { VPS_APPS, type VpsApp } from './vps-apps.ts';

type HomeResources = z.infer<typeof HomeResourcesSchema>;
type SessionUsage = z.infer<typeof SessionUsageSchema>;
type DiskFootprint = z.infer<typeof DiskFootprintSchema>;
type HostApp = Extract<NonNullable<HomeResources['apps']>, { state: 'ok' }>['items'][number];

/** 采样间隔，也是页面上读数最多旧多久（推送正常时）的上限。 */
export const RESOURCE_SAMPLE_MS = 5_000;

/** cgroup v2 挂在哪；和引擎 packages/engine/src/real/memory-admission.ts 的 CGROUP_ROOT 一致。 */
export const CGROUP_ROOT = '/sys/fs/cgroup';
/** 会话资源池在 cgroup 树里的位置；和 memory-admission.ts 的 AGENT_SLICE_PATH、deploy/france/fleet-agents.slice 一致。 */
export const AGENT_SLICE_PATH = 'fleet.slice/fleet-agents.slice';

const SCOPE_RE = /^fleet-agent-(.+)\.scope$/;
const MIB = 1024 * 1024;
/** 字节 → MiB：真读到的不到 1M 往上记 1M，只有真的 0 才是 0（#1992：不把小读数四舍五入成 0）。 */
const toMb = (bytes: number): number => (bytes > 0 ? Math.max(1, Math.round(bytes / MIB)) : 0);

export interface StatfsResult {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}

export interface HostReadDeps {
  readText(path: string): Promise<string>;
  readDir(path: string): Promise<string[]>;
  procRoot: string;
  cgroupRoot: string;
  slicePath: string;
  /** 整机磁盘（#1985）：没装（老装配、测试）就不带 disk 这一项。 */
  statfs?: (path: string) => Promise<StatfsResult>;
  /** 量哪个挂载点：一般是 /。 */
  diskPath?: string;
  /** 上线项目登记表（#1985）：没装就不带 apps 这一项。 */
  apps?: readonly VpsApp[];
}

export function realHostReader(overrides: Partial<HostReadDeps> = {}): HostReadDeps {
  return {
    readText: (path) => readFile(path, 'utf8'),
    readDir: (path) => readdir(path),
    procRoot: '/proc',
    cgroupRoot: CGROUP_ROOT,
    slicePath: AGENT_SLICE_PATH,
    statfs: (path) => statfs(path),
    diskPath: '/',
    apps: VPS_APPS,
    ...overrides,
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isMissing = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';

/** /proc/meminfo：MemTotal、MemAvailable（kB）。缺哪一行、不是数，抛。 */
export function parseMeminfo(text: string): { totalMb: number; availableMb: number } {
  const kb = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(text);
    if (!m?.[1]) throw new Error(`/proc/meminfo 里认不出 ${key} 那一行`);
    return Number(m[1]);
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (total <= 0) throw new Error('/proc/meminfo 的 MemTotal 是 0，认不出');
  return { totalMb: Math.round(total / 1024), availableMb: Math.round(available / 1024) };
}

/** /proc/stat 第一行（cpu 合计）：忙 = 前八项（user … steal）合计 − idle − iowait；核数 = cpuN 行数。认不出抛。 */
export function parseProcStat(text: string): { busy: number; total: number; cores: number } {
  const lines = text.split('\n');
  const head = lines.find((l) => /^cpu\s/.test(l));
  const nums = head?.trim().split(/\s+/).slice(1, 9).map(Number);
  if (!nums || nums.length < 8 || nums.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error(
      `/proc/stat 的 cpu 那一行认不出（前 80 字节）：${JSON.stringify((head ?? text).slice(0, 80))}`,
    );
  }
  const total = nums.reduce((a, b) => a + b, 0);
  const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
  const cores = lines.filter((l) => /^cpu\d+\s/.test(l)).length;
  if (cores === 0) throw new Error('/proc/stat 里一行 cpuN 都没有，认不出有几个核');
  return { busy: total - idle, total, cores };
}

/** /proc/loadavg 的 1 分钟负载。认不出抛。 */
export function parseLoad1(text: string): number {
  const n = Number(text.trim().split(/\s+/)[0]);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`/proc/loadavg 认不出：${JSON.stringify(text.slice(0, 40))}`);
  return n;
}

/** cgroup 的 cpu.stat：usage_usec（微秒，只增不减）。认不出抛。 */
export function parseCpuUsageUsec(text: string): number {
  const m = /^usage_usec (\d+)$/m.exec(text);
  if (!m?.[1])
    throw new Error(
      `cpu.stat 里认不出 usage_usec 那一行（前 80 字节）：${JSON.stringify(text.slice(0, 80))}`,
    );
  return Number(m[1]);
}

/** memory.current / memory.peak：纯数字，字节。认不出抛。 */
function parseBytes(text: string, name: string): number {
  const t = text.trim();
  if (!/^\d+$/.test(t))
    throw new Error(`${name} 的内容认不出（前 80 字节）：${JSON.stringify(t.slice(0, 80))}`);
  return Number(t);
}

/** 上一回读数：算 CPU 的差用。 */
export interface ResourceMemo {
  at: number;
  host?: { busy: number; total: number };
  scopes: Map<string, number>;
  /** 各 systemd 单元上一回的 usage_usec（#1985）。 */
  units?: Map<string, number>;
}

/** 整机磁盘：statfs 一回。块数认不出（总块数 0、不是数）也算没读到。 */
async function readDisk(deps: HostReadDeps): Promise<HomeResources['disk']> {
  if (!deps.statfs) return undefined;
  const path = deps.diskPath ?? '/';
  try {
    const s = await deps.statfs(path);
    const nums = [s.bsize, s.blocks, s.bfree, s.bavail];
    if (
      nums.some((n) => !Number.isFinite(n) || n < 0) ||
      s.blocks === 0 ||
      s.bsize === 0 ||
      s.bfree > s.blocks
    ) {
      return { state: 'unread', why: `${path} 的 statfs 读回来的块数认不出：${JSON.stringify(s)}` };
    }
    return {
      state: 'ok',
      path,
      totalBytes: s.blocks * s.bsize,
      usedBytes: (s.blocks - s.bfree) * s.bsize,
      availableBytes: s.bavail * s.bsize,
    };
  } catch (err) {
    return { state: 'unread', why: `${path} 的 statfs 没读成：${message(err)}` };
  }
}

type UnitRead =
  | { kind: 'off' }
  /** cgroup 还在、memory.current 是 0：里面没进程，不算在跑（#1992）。 */
  | { kind: 'empty'; why: string }
  | { kind: 'ok'; memoryBytes: number; maxBytes?: number; usec: number }
  | { kind: 'unread'; why: string };

/** 一个单元一回：cgroup 目录不在 = 没在跑；memory.max 是 max 就没有上限。 */
async function readUnit(deps: HostReadDeps, cgroup: string): Promise<UnitRead> {
  const dir = posix.join(deps.cgroupRoot, cgroup);
  const file = (name: string) => posix.join(dir, name);
  let current: string;
  try {
    current = await deps.readText(file('memory.current'));
  } catch (err) {
    if (isMissing(err)) return { kind: 'off' };
    return { kind: 'unread', why: `${file('memory.current')} 没读成：${message(err)}` };
  }
  try {
    const [maxText, cpuText] = await Promise.all([
      deps.readText(file('memory.max')).catch((err: unknown) => {
        if (isMissing(err)) return 'max';
        throw err;
      }),
      deps.readText(file('cpu.stat')),
    ]);
    const memoryBytes = parseBytes(current, file('memory.current'));
    if (memoryBytes === 0) {
      return {
        kind: 'empty',
        why: `${cgroup} 的 cgroup 还在，但 memory.current 是 0：里面没有进程，不算在跑`,
      };
    }
    const maxBytes = maxText.trim() === 'max' ? undefined : parseBytes(maxText, file('memory.max'));
    const usec = parseCpuUsageUsec(cpuText);
    return { kind: 'ok', memoryBytes, ...(maxBytes === undefined ? {} : { maxBytes }), usec };
  } catch (err) {
    // 读到一半单元收场了：当它不在
    if (isMissing(err)) return { kind: 'off' };
    return { kind: 'unread', why: `${dir} 没读成：${message(err)}` };
  }
}

/**
 * 每个上线项目一回（#1985）：名下各单元的 cgroup 相加。CPU 口径：各单元 cpu.stat 的 usage_usec 这一回减上一回，
 * 除以两回之间的墙钟（微秒），得到忙的核数（1 = 占满一个核）；有一个在跑的单元还只有一回读数，整个应用就不给 CPU（采样中）。
 */
async function readApps(
  deps: HostReadDeps,
  prev: ResourceMemo | undefined,
  elapsedMs: number,
): Promise<{ apps: HomeResources['apps']; units: Map<string, number> }> {
  const units = new Map<string, number>();
  if (!deps.apps) return { apps: undefined, units };
  const controllers = posix.join(deps.cgroupRoot, 'cgroup.controllers');
  try {
    await deps.readText(controllers);
  } catch (err) {
    return {
      apps: {
        state: 'unread',
        why: isMissing(err)
          ? `这台没有 ${controllers}（不是 cgroup v2，或不是 Linux）`
          : `${controllers} 没读成：${message(err)}`,
      },
      units,
    };
  }
  const items = await Promise.all(
    deps.apps.map(async (app): Promise<HostApp> => {
      const reads = await Promise.all(app.units.map((u) => readUnit(deps, u.cgroup)));
      const usage = ((): HostApp['usage'] => {
        const bad = reads.find((r) => r.kind === 'unread');
        if (bad?.kind === 'unread') return { state: 'unread', why: bad.why };
        let running = 0;
        let memoryBytes = 0;
        let maxBytes: number | undefined = 0;
        let cpuCores: number | undefined = 0;
        reads.forEach((r, i) => {
          const name = app.units[i]?.name;
          if (r.kind !== 'ok' || !name) return;
          running += 1;
          memoryBytes += r.memoryBytes;
          maxBytes = maxBytes === undefined || r.maxBytes === undefined ? undefined : maxBytes + r.maxBytes;
          units.set(name, r.usec);
          const before = prev?.units?.get(name);
          cpuCores =
            cpuCores === undefined || before === undefined || r.usec < before || elapsedMs <= 0
              ? undefined
              : cpuCores + (r.usec - before) / (elapsedMs * 1000);
        });
        if (running === 0) {
          const empty = reads.find((r) => r.kind === 'empty');
          if (empty?.kind === 'empty') return { state: 'idle', why: empty.why };
          return app.idleNote ? { state: 'idle', why: app.idleNote } : { state: 'idle' };
        }
        return {
          state: 'ok',
          running,
          memoryMb: Math.round(memoryBytes / MIB),
          ...(maxBytes === undefined || maxBytes === 0 ? {} : { memoryMaxMb: Math.round(maxBytes / MIB) }),
          ...(cpuCores === undefined ? {} : { cpuCores: Math.round(cpuCores * 100) / 100 }),
        };
      })();
      return {
        id: app.id,
        name: app.name,
        place: app.place,
        units: app.units.map((u) => u.name),
        ...(app.external ? { external: true } : {}),
        ...(app.diskNote ? { diskNote: app.diskNote } : {}),
        usage,
      };
    }),
  );
  return { apps: { state: 'ok', items }, units };
}

async function readMemory(deps: HostReadDeps): Promise<HomeResources['memory']> {
  const path = posix.join(deps.procRoot, 'meminfo');
  try {
    return { state: 'ok', ...parseMeminfo(await deps.readText(path)) };
  } catch (err) {
    return {
      state: 'unread',
      why: isMissing(err)
        ? `读不到 ${path}（这台不是 Linux，或没有 /proc）`
        : `${path} 没读成：${message(err)}`,
    };
  }
}

async function readCpu(
  deps: HostReadDeps,
  prev: ResourceMemo | undefined,
): Promise<{ cpu: HomeResources['cpu']; host?: { busy: number; total: number } }> {
  const path = posix.join(deps.procRoot, 'stat');
  let now: { busy: number; total: number; cores: number };
  try {
    now = parseProcStat(await deps.readText(path));
  } catch (err) {
    return {
      cpu: {
        state: 'unread',
        why: isMissing(err)
          ? `读不到 ${path}（这台不是 Linux，或没有 /proc）`
          : `${path} 没读成：${message(err)}`,
      },
    };
  }
  const host = { busy: now.busy, total: now.total };
  const p = prev?.host;
  const dTotal = p ? now.total - p.total : 0;
  if (!p || dTotal <= 0) {
    return {
      cpu: { state: 'unread', why: 'CPU 要两回读数的差才算得出，刚开始采样、还只有一回（下一回就有）' },
      host,
    };
  }
  // 百分比和忙的核数出自同一对差：忙的比例 × 核数（核数是这一回 /proc/stat 里数出来的 cpuN 行数）
  const ratio = Math.min(1, Math.max(0, (now.busy - p.busy) / dTotal));
  const percent = Math.round(ratio * 1000) / 10;
  const busyCores = Math.round(ratio * now.cores * 10) / 10;
  // 负载是附带的一句：读不到就不写，不影响 CPU 那一格
  let load1: number | undefined;
  try {
    load1 = parseLoad1(await deps.readText(posix.join(deps.procRoot, 'loadavg')));
  } catch {
    load1 = undefined;
  }
  return {
    cpu: { state: 'ok', percent, busyCores, cores: now.cores, ...(load1 === undefined ? {} : { load1 }) },
    host,
  };
}

/** 一个 scope 一回的读数；scope 在读的中途收场了回 null（当它不在）。 */
async function readScope(
  deps: HostReadDeps,
  dir: string,
  prevUsec: number | undefined,
  elapsedMs: number,
): Promise<{ usage: SessionUsage; usec?: number } | null> {
  const file = (name: string) => posix.join(dir, name);
  try {
    const [current, peakText, cpuText] = await Promise.all([
      deps.readText(file('memory.current')),
      // memory.peak 要内核 5.19 起才有：没有这个文件只是不给峰值，不算没读到
      deps.readText(file('memory.peak')).catch((err: unknown) => {
        if (isMissing(err)) return undefined;
        throw err;
      }),
      deps.readText(file('cpu.stat')),
    ]);
    const bytes = parseBytes(current, file('memory.current'));
    const usec = parseCpuUsageUsec(cpuText);
    // 跑着的会话不可能 0（#1992）：scope 还在、里面没进程，明说成 empty，不报 ok 的 0
    if (bytes === 0) {
      return {
        usage: {
          state: 'empty',
          why: `${dir} 还在，但 memory.current 是 0：里面没有进程（会话已收场、scope 没回收），不算在跑`,
        },
        usec,
      };
    }
    const memoryMb = toMb(bytes);
    const peak = peakText === undefined ? undefined : toMb(parseBytes(peakText, file('memory.peak')));
    const cpuPercent =
      prevUsec !== undefined && usec >= prevUsec && elapsedMs > 0
        ? Math.round(((usec - prevUsec) / (elapsedMs * 1000)) * 1000) / 10
        : undefined;
    return {
      usage: {
        state: 'ok',
        memoryMb,
        ...(peak === undefined ? {} : { memoryPeakMb: peak }),
        ...(cpuPercent === undefined ? {} : { cpuPercent }),
      },
      usec,
    };
  } catch (err) {
    if (isMissing(err)) return null;
    return { usage: { state: 'unread', why: `${dir} 没读成：${message(err)}` } };
  }
}

/** 读一回：整机内存、CPU，会话池下每个 scope。prev 是上一回的读数（算 CPU 差用），next 留给下一回。 */
export async function readHostResources(
  deps: HostReadDeps,
  prev: ResourceMemo | undefined,
  at: Date,
): Promise<{ resources: HomeResources; next: ResourceMemo }> {
  const nowMs = at.getTime();
  const elapsed = prev ? nowMs - prev.at : 0;
  const slice = posix.join(deps.cgroupRoot, deps.slicePath);
  const readSessions = async (): Promise<{
    sessions: HomeResources['sessions'];
    scopes: Map<string, number>;
  }> => {
    const scopes = new Map<string, number>();
    let names: string[];
    try {
      names = await deps.readDir(slice);
    } catch (err) {
      return {
        sessions: {
          state: 'unread',
          why: isMissing(err)
            ? `这台没有 ${slice}（不在法国机器上，或会话资源池没挂）`
            : `${slice} 没读成：${message(err)}`,
        },
        scopes,
      };
    }
    const ids = names.flatMap((n) => {
      const m = SCOPE_RE.exec(n);
      return m?.[1] ? [{ id: m[1], dir: posix.join(slice, n) }] : [];
    });
    const read = await Promise.all(ids.map((s) => readScope(deps, s.dir, prev?.scopes.get(s.id), elapsed)));
    const byRun: Record<string, SessionUsage> = {};
    ids.forEach((s, i) => {
      const r = read[i];
      if (!r) return;
      byRun[s.id] = r.usage;
      if (r.usec !== undefined) scopes.set(s.id, r.usec);
    });
    return { sessions: { state: 'ok', byRun }, scopes };
  };
  const [memory, cpu, sessions, disk, apps] = await Promise.all([
    readMemory(deps),
    readCpu(deps, prev),
    readSessions(),
    readDisk(deps),
    readApps(deps, prev, elapsed),
  ]);
  return {
    resources: {
      at: at.toISOString(),
      everyMs: RESOURCE_SAMPLE_MS,
      memory,
      cpu: cpu.cpu,
      sessions: sessions.sessions,
      ...(disk ? { disk } : {}),
      ...(apps.apps ? { apps: apps.apps } : {}),
    },
    next: {
      at: nowMs,
      ...(cpu.host ? { host: cpu.host } : {}),
      scopes: sessions.scopes,
      units: apps.units,
    },
  };
}

/** 按目录的磁盘占用（disk-footprint.ts 的测量器）：采样器每回带上最近一回，并「戳」它一下（该测了它自己在后台测）。 */
export interface FootprintSource {
  latest(): DiskFootprint;
  poke(): void;
}

export interface HostResourceSampler {
  /** 给主页接口：最近一回还新（两个间隔内）就给它，旧了或还没有就现读一回。不抛：读不到的都在 unread 里。 */
  current(): Promise<HomeResources>;
  /** 最近一回（还没读过是 undefined）。 */
  latest(): HomeResources | undefined;
  /** 每读成一回（按间隔读的那种）就叫一次；返回退订。 */
  subscribe(listener: (resources: HomeResources) => void): () => void;
  /** 开始按间隔读：先读一回垫底（下一回才有 CPU 的差），之后 active() 为真才读、读完推给订阅的。返回停止函数。 */
  start(active: () => boolean): () => void;
}

export function createHostResourceSampler(input: {
  read: HostReadDeps;
  now: () => Date;
  log?: Logger;
  everyMs?: number;
  /** 按目录的磁盘占用（#1985）：给了就每回带上它最近一回；读文件在它自己那边后台做，不在这一回里等。 */
  footprint?: FootprintSource;
}): HostResourceSampler {
  const everyMs = input.everyMs ?? RESOURCE_SAMPLE_MS;
  const listeners = new Set<(r: HomeResources) => void>();
  let memo: ResourceMemo | undefined;
  let last: HomeResources | undefined;
  let inFlight: Promise<HomeResources> | undefined;

  const sample = (): Promise<HomeResources> => {
    // 有人在看（推送一轮、主页来要）才走到这里：顺手戳一下测量器，该测了它自己在后台测
    input.footprint?.poke();
    inFlight ??= readHostResources(input.read, memo, input.now())
      .then(({ resources, next }) => {
        memo = next;
        const withFootprint = input.footprint
          ? { ...resources, footprint: input.footprint.latest() }
          : resources;
        last = withFootprint;
        return withFootprint;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return {
    async current() {
      if (last && input.now().getTime() - Date.parse(last.at) < everyMs * 2) return last;
      return sample();
    },
    latest: () => last,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start(active) {
      let stopped = false;
      void sample().catch((err: unknown) =>
        input.log?.warn('机器资源垫底那一回没读成', { error: message(err) }),
      );
      const timer = setInterval(() => {
        if (stopped || !active()) return;
        sample().then(
          (r) => {
            if (stopped) return;
            for (const l of [...listeners]) l(r);
          },
          (err: unknown) => input.log?.warn('机器资源这一回没读成', { error: message(err) }),
        );
      }, everyMs);
      timer.unref?.();
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}
