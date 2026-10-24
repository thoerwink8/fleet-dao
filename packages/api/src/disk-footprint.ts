// 按目录的磁盘占用（#1985、#3456）：法国上 root 的单元（deploy/france/fleet-footprint.service，定时器每 10 分钟拉起）对登记表（vps-apps.ts）
// 里每个目录跑 du，只把数字写进 /var/lib/fleet-footprint/sizes.json（644）；这里读它，再用 SQL 取库的大小。后端以 fleet 跑、
// 没有 root，读不了会话用户 700 的工作树、/home、别家应用的 750 目录，也不该读：所以不在 node 里逐个文件遍历（以前那样做，
// /var/lib/fleet-work 一个目录把共用的时限吃光，后面的目录全标「没测完」，页面写「≥ 不到 1M」），一律读 root 单元量好的数。
//
// 改这里之前必须知道：
// - 文件是 deploy/france/footprint/fleet-footprint.mjs 写的：每个目录一行 {path, bytes, measuredAt, attemptedAt, tookMs, skipped, error}。
//   这一回没量成的目录，bytes/measuredAt 是上次量成的、error 写这回为什么没成：这里照实报「旧数」（stale：数是 measuredAt 量的、
//   为什么没更新），从没量成过（bytes 为 null）报 unread 带原因。绝不显示「不到 1M」这种没有信息的下限。
// - 文件旧了（超过两个周期没更新——一个周期 = 间隔 + 一轮耗时，单元停了或坏了）：每个目录的数都标 stale，原因写「N 分钟没更新、上次写在几点」；
//   文件不在或认不出：整块 unread（不是 0，也不是 pending），原因写缺的是哪个文件、怎么装。
// - 登记表里有、文件里没有的目录（刚登记、清单跟着发版换，还没轮到）：unread，原因写清楚；文件里有、登记表里没有的忽略。
// - 每个目录各自的数各自带测量时刻；没有共用的时限（单元里每个目录各有自己的超时）。
// - 这里读文件很便宜（几 KB），采样器每 5 秒戳一下也只是几十秒才真读一回；库的大小（pg_database_size）10 分钟才查一回。
// - 库：pg_database_size（没有 CONNECT 权限的库单写没读到），不读数据目录（归 postgres、700）。
import { readFile } from 'node:fs/promises';
import type { DiskFootprintSchema } from '@fleet-dao/shared';
import { z } from 'zod';
import type { Logger } from './ports.ts';
import type { VpsApp } from './vps-apps.ts';

type DiskFootprint = z.infer<typeof DiskFootprintSchema>;
type Dirs = Extract<DiskFootprint, { state: 'ok' }>['dirs'];
type Databases = Extract<DiskFootprint, { state: 'ok' }>['databases'];

/** root 单元多久量一回（和 deploy/france/fleet-footprint.timer 的 OnUnitInactiveSec 一样）；超过两倍没更新就是旧了。 */
export const FOOTPRINT_EVERY_MS = 10 * 60_000;
/** root 单元写的文件（和 deploy/france/footprint/fleet-footprint.mjs 的 SIZES_FILE 一样）。 */
export const FOOTPRINT_SIZES_FILE = '/var/lib/fleet-footprint/sizes.json';
/** 多久重读一回文件（便宜）。 */
const REFRESH_MS = 30_000;

/** 库的大小：每个库一行；bytes 缺 = 没有这个库的 CONNECT 权限。 */
export type DatabaseSizes = () => Promise<{ name: string; bytes: number | undefined }[]>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const codeOf = (err: unknown) =>
  typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;

const SizesFileSchema = z.object({
  schema: z.literal(1),
  measuredAt: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  everyMs: z.number().int().positive().optional(),
  tookMs: z.number().int().min(0),
  timers: z
    .array(
      z.union([
        z.object({
          unit: z.string().min(1),
          runs24h: z.number().int().min(1),
          cpuSeconds24h: z.number().min(0),
          peakMemoryBytes: z.number().int().min(0).nullable(),
        }),
        z.object({ unit: z.string().min(1), why: z.string().min(1) }),
      ]),
    )
    .optional(),
  dirs: z.array(
    z.object({
      path: z.string().min(1),
      bytes: z.number().int().min(0).nullable(),
      measuredAt: z.string().nullable(),
      attemptedAt: z.string(),
      skipped: z.number().int().min(0).default(0),
      error: z.string().nullable(),
    }),
  ),
});

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));
const HOW = '（deploy/france.sh --auto-tier 装 fleet-footprint.timer；docs/ops.md「按目录的磁盘」）';

/** 把 root 单元写的文件原文（或读不到的原因）变成这一回的按目录占用。纯函数：不读盘、不查库。 */
export function footprintFromSizes(input: {
  apps: readonly VpsApp[];
  /** 文件原文；读不到是 { error }。 */
  file: string | { error: string };
  databases: Databases;
  now: Date;
}): DiskFootprint {
  if (typeof input.file !== 'string') return { state: 'unread', why: input.file.error };
  let parsed: z.infer<typeof SizesFileSchema>;
  try {
    const r = SizesFileSchema.safeParse(JSON.parse(input.file));
    if (!r.success) {
      return {
        state: 'unread',
        why: `${FOOTPRINT_SIZES_FILE} 的格式认不出（${r.error.issues[0]?.path.join('.') || '整份'}）：量磁盘的单元和后端版本对不上`,
      };
    }
    parsed = r.data;
  } catch (err) {
    return { state: 'unread', why: `${FOOTPRINT_SIZES_FILE} 不是合法的 JSON：${message(err)}` };
  }
  const everyMs = parsed.everyMs ?? FOOTPRINT_EVERY_MS;
  const age = input.now.getTime() - Date.parse(parsed.measuredAt);
  // 两次写文件之间隔 间隔 + 一轮耗时（定时器按「跑完之后」算；法国首轮量了 7 分钟）：两个这样的周期没动静才算旧了
  const cycleMs = everyMs + parsed.tookMs;
  const fileStale =
    age > 2 * cycleMs
      ? `量磁盘的单元已经 ${minutes(age)} 分钟没更新（上次写文件在 ${parsed.measuredAt}，该每 ${minutes(cycleMs)} 分钟一回）`
      : undefined;
  const byPath = new Map(parsed.dirs.map((d) => [d.path, d]));
  const dirs: Dirs = [];
  for (const app of input.apps) {
    for (const path of app.dirs) {
      const e = byPath.get(path);
      let size: Dirs[number]['size'];
      if (!e) {
        size = {
          state: 'unread',
          why: `量磁盘的单元清单里还没有 ${path}（清单跟着发版装，新登记的目录下一轮发完版才有）`,
        };
      } else if (e.bytes === null || e.measuredAt === null) {
        size = {
          state: 'unread',
          why: `${path} 从没量成过：${e.error ?? '没有数'}（最近一次试在 ${e.attemptedAt}）`,
        };
      } else {
        const why = e.error ?? fileStale;
        size = {
          state: 'ok',
          bytes: e.bytes,
          unreadTrees: e.skipped,
          measuredAt: e.measuredAt,
          ...(why ? { stale: { why, attemptedAt: e.attemptedAt } } : {}),
        };
      }
      dirs.push({ path, appId: app.id, appName: app.name, size });
    }
  }
  return {
    state: 'ok',
    measuredAt: parsed.measuredAt,
    everyMs,
    tookMs: parsed.tookMs,
    ...(parsed.timers ? { timers: parsed.timers } : {}),
    dirs,
    databases: input.databases,
  };
}

/** 库的大小：登记表里记库的那个应用名下，每个库一行。不抛。 */
export async function readDatabases(
  apps: readonly VpsApp[],
  databases: DatabaseSizes | undefined,
): Promise<Databases> {
  const dbApp = apps.find((a) => a.databases === 'all');
  if (!databases) return { state: 'unread', why: '这台后端没连数据库（开发用的内存版）' };
  if (!dbApp) return { state: 'unread', why: '登记表里没有记库的应用' };
  try {
    const rows = await databases();
    return {
      state: 'ok',
      items: rows.map((r) => ({
        name: r.name,
        appId: dbApp.id,
        appName: dbApp.name,
        size:
          r.bytes === undefined
            ? { state: 'unread' as const, why: '没有这个库的 CONNECT 权限，量不了' }
            : { state: 'ok' as const, bytes: r.bytes },
      })),
    };
  } catch (err) {
    return { state: 'unread', why: `库的大小没查成：${message(err)}` };
  }
}

/** 读 root 单元写的文件；读不到回 { error }（缺文件说明怎么装）。 */
export async function readSizesFile(path = FOOTPRINT_SIZES_FILE): Promise<string | { error: string }> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    return {
      error:
        codeOf(err) === 'ENOENT'
          ? `没有 ${path}：这台机器上量磁盘的单元还没装或还没跑过第一轮${HOW}`
          : `读不了 ${path}：${message(err)}`,
    };
  }
}

export interface FootprintMeter {
  /** 最近读到的一回；还没读过是 pending 带原因。 */
  latest(): DiskFootprint;
  /** 该重读了（没读过、上一回超过 30 秒）且没在读，就在后台读一回；不等它。 */
  poke(): void;
}

export function createFootprintMeter(input: {
  apps: readonly VpsApp[];
  /** 读文件原文；默认读 FOOTPRINT_SIZES_FILE。 */
  read?: () => Promise<string | { error: string }>;
  databases?: DatabaseSizes | undefined;
  now: () => Date;
  log?: Logger;
  refreshMs?: number;
}): FootprintMeter {
  const refreshMs = input.refreshMs ?? REFRESH_MS;
  const read = input.read ?? (() => readSizesFile());
  let last: DiskFootprint | undefined;
  let lastStart: number | undefined;
  let running = false;
  let db: { at: number; value: Databases } | undefined;
  return {
    latest() {
      return last ?? { state: 'pending', why: '正在读量磁盘的单元写的文件（几秒内就有）' };
    },
    poke() {
      const t = input.now().getTime();
      if (running || (lastStart !== undefined && t - lastStart < refreshMs)) return;
      running = true;
      lastStart = t;
      void (async () => {
        try {
          const file = await read();
          // 库的大小查一回要连库，10 分钟一回就够
          if (!db || t - db.at >= FOOTPRINT_EVERY_MS) {
            db = { at: t, value: await readDatabases(input.apps, input.databases) };
          }
          last = footprintFromSizes({ apps: input.apps, file, databases: db.value, now: input.now() });
        } catch (err) {
          input.log?.warn('按目录的磁盘占用这一回没读成', { error: message(err) });
          last = { state: 'unread', why: `读按目录的磁盘占用时出错：${message(err)}` };
        } finally {
          running = false;
        }
      })();
    },
  };
}
