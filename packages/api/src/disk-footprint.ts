// 按目录的磁盘占用（#1985）：照登记表（vps-apps.ts）把各应用名下的目录遍历一遍、按块算大小，再用 SQL 取库的大小。
// 遍历较重：测量器每 FOOTPRINT_EVERY_MS（10 分钟）最多测一回，只在有人看（采样器「戳」它）时测，测完缓存；
// 5 秒那一回读数只带上最近一回的结果，从不等遍历（host-resources.ts 的 createHostResourceSampler）。
//
// 改这里之前必须知道：
// - 口径和 du 一样：lstat 的 blocks × 512（占的块，不是文件名义大小），硬链接（nlink > 1）同一个 dev:ino 只算一次
//   （发布目录里各版的 node_modules 是 pnpm 硬链接出来的，按名义大小算会多算好几倍），符号链接不跟。
// - 读不了的子树（EACCES、中途没了）记一棵，数照算其余的，页面写「不全：有 N 棵树没读到」；
//   登记的目录本身不在或列不出，整个目录是 unread（绝不当成 0）。后端以 fleet 跑、没有 root，
//   /var/lib/fleet-work 里每棵树归会话用户、700，就是靠这一条照实报「不全」；不为了量全加 root 小工具。
// - 一回最多测 FOOTPRINT_BUDGET_MS：到时限没测完的目录标 capped（数是下限），不一直占着磁盘 IO。
// - 一个一个 lstat 顺序走（不并发），每一步都是 await，不卡事件循环；主页接口和推送照常。
// - 库：pg_database_size（没有 CONNECT 权限的库单写没读到），不读数据目录（归 postgres、700）。
import { lstat, readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import type { DirSizeSchema, DiskFootprintSchema } from '@fleet-dao/shared';
import type { z } from 'zod';
import type { Logger } from './ports.ts';
import type { VpsApp } from './vps-apps.ts';

type DirSize = z.infer<typeof DirSizeSchema>;
type DiskFootprint = z.infer<typeof DiskFootprintSchema>;

/** 多久最多测一回。 */
export const FOOTPRINT_EVERY_MS = 10 * 60_000;
/** 一回最多测多久。 */
export const FOOTPRINT_BUDGET_MS = 3 * 60_000;

export interface FootprintStat {
  dir: boolean;
  link: boolean;
  /** 占的字节（blocks × 512）。 */
  bytes: number;
  dev: number;
  ino: number;
  nlink: number;
}

export interface FootprintFs {
  lstat(path: string): Promise<FootprintStat>;
  readDir(path: string): Promise<string[]>;
}

export function realFootprintFs(): FootprintFs {
  return {
    async lstat(path) {
      const s = await lstat(path);
      return {
        dir: s.isDirectory(),
        link: s.isSymbolicLink(),
        // 有的文件系统不给 blocks（Windows）：退回名义大小
        bytes: Number.isFinite(s.blocks) && s.blocks >= 0 ? s.blocks * 512 : s.size,
        dev: s.dev,
        ino: s.ino,
        nlink: s.nlink,
      };
    },
    readDir: (path) => readdir(path),
  };
}

/** 库的大小：每个库一行；bytes 缺 = 没有这个库的 CONNECT 权限。 */
export type DatabaseSizes = () => Promise<{ name: string; bytes: number | undefined }[]>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const codeOf = (err: unknown) =>
  typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;

/** 量一个目录。seen 是这一回已经算过的硬链接（dev:ino），跨目录共用。 */
export async function measureDir(
  root: string,
  fs: FootprintFs,
  opts: { deadline: number; seen: Set<string>; now?: () => number },
): Promise<DirSize> {
  const now = opts.now ?? Date.now;
  let top: FootprintStat;
  try {
    top = await fs.lstat(root);
  } catch (err) {
    return {
      state: 'unread',
      why:
        codeOf(err) === 'ENOENT'
          ? `没有 ${root} 这个目录（或后端看不见它）`
          : `读不了 ${root}：${message(err)}`,
    };
  }
  if (!top.dir) return { state: 'unread', why: `${root} 不是目录` };
  let names: string[];
  try {
    names = await fs.readDir(root);
  } catch (err) {
    return { state: 'unread', why: `读不了 ${root}：${message(err)}` };
  }
  let bytes = top.bytes;
  let unreadTrees = 0;
  let unreadSample: string | undefined;
  let capped = false;
  // 拷一份再一个个弹：readDir 给的数组不归这里改
  const stack: { dir: string; names: string[] }[] = [{ dir: root, names: [...names] }];
  const miss = (path: string, err: unknown) => {
    unreadTrees += 1;
    unreadSample ??= `${path}：${message(err)}`;
  };
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (!frame) break;
    const name = frame.names.pop();
    if (name === undefined) {
      stack.pop();
      continue;
    }
    if (now() > opts.deadline) {
      capped = true;
      break;
    }
    const path = posix.join(frame.dir, name);
    let s: FootprintStat;
    try {
      s = await fs.lstat(path);
    } catch (err) {
      // 两步之间没了的不算缺口：它本来就不在了
      if (codeOf(err) !== 'ENOENT') miss(path, err);
      continue;
    }
    if (s.link) continue;
    if (!s.dir && s.nlink > 1) {
      const key = `${s.dev}:${s.ino}`;
      if (opts.seen.has(key)) continue;
      opts.seen.add(key);
    }
    bytes += s.bytes;
    if (s.dir) {
      try {
        stack.push({ dir: path, names: [...(await fs.readDir(path))] });
      } catch (err) {
        if (codeOf(err) !== 'ENOENT') miss(path, err);
      }
    }
  }
  return {
    state: 'ok',
    bytes,
    unreadTrees,
    ...(unreadSample ? { unreadSample } : {}),
    ...(capped ? { capped: true } : {}),
  };
}

/** 测一回：登记表里每个目录、每个库。 */
export async function measureFootprint(input: {
  apps: readonly VpsApp[];
  fs: FootprintFs;
  databases?: DatabaseSizes | undefined;
  now: () => Date;
  budgetMs?: number;
}): Promise<DiskFootprint> {
  const started = input.now().getTime();
  const deadline = started + (input.budgetMs ?? FOOTPRINT_BUDGET_MS);
  const seen = new Set<string>();
  const dirs: Extract<DiskFootprint, { state: 'ok' }>['dirs'] = [];
  for (const app of input.apps) {
    for (const path of app.dirs) {
      dirs.push({
        path,
        appId: app.id,
        appName: app.name,
        size: await measureDir(path, input.fs, { deadline, seen, now: () => input.now().getTime() }),
      });
    }
  }
  const dbApp = input.apps.find((a) => a.databases === 'all');
  let databases: Extract<DiskFootprint, { state: 'ok' }>['databases'];
  if (!input.databases) {
    databases = { state: 'unread', why: '这台后端没连数据库（开发用的内存版）' };
  } else if (!dbApp) {
    databases = { state: 'unread', why: '登记表里没有记库的应用' };
  } else {
    try {
      const rows = await input.databases();
      databases = {
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
      databases = { state: 'unread', why: `库的大小没查成：${message(err)}` };
    }
  }
  const done = input.now();
  return {
    state: 'ok',
    measuredAt: done.toISOString(),
    everyMs: FOOTPRINT_EVERY_MS,
    tookMs: Math.max(0, done.getTime() - started),
    dirs,
    databases,
  };
}

export interface FootprintMeter {
  /** 最近测完的一回；还没有就是 pending 带原因。 */
  latest(): DiskFootprint;
  /** 该测了（没测过、上一回超过间隔）且没在测，就在后台起一回；不等它。 */
  poke(): void;
}

export function createFootprintMeter(input: {
  measure: () => Promise<DiskFootprint>;
  now: () => Date;
  everyMs?: number;
  log?: Logger;
}): FootprintMeter {
  const everyMs = input.everyMs ?? FOOTPRINT_EVERY_MS;
  let last: DiskFootprint | undefined;
  let lastStart: number | undefined;
  let failed: string | undefined;
  let running = false;
  return {
    latest() {
      if (last) return last;
      if (running)
        return { state: 'pending', why: '正在测第一回（要遍历文件，测完就有；之后每 10 分钟测一次）' };
      if (failed) return { state: 'pending', why: `上一回没测成：${failed}（10 分钟后再测）` };
      return { state: 'pending', why: '还没测过（有页面开着才测，每 10 分钟一次）' };
    },
    poke() {
      const t = input.now().getTime();
      if (running || (lastStart !== undefined && t - lastStart < everyMs)) return;
      running = true;
      lastStart = t;
      input.measure().then(
        (fp) => {
          last = fp;
          failed = undefined;
          running = false;
        },
        (err: unknown) => {
          failed = message(err);
          running = false;
          input.log?.warn('按目录的磁盘占用这一回没测成', { error: failed });
        },
      );
    },
  };
}
