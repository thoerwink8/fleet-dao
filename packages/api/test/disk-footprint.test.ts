// 按目录的磁盘占用（#1985，disk-footprint.ts）：遍历文件按块算（和 du 一样：硬链接只算一次、不跟符号链接），
// 读不了的子树记「不全」、整个目录读不到记 unread；库的大小走 SQL。测量器 10 分钟内只测一回、不在 5 秒那一回里等。
import { DiskFootprintSchema } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';
import {
  createFootprintMeter,
  FOOTPRINT_EVERY_MS,
  type FootprintFs,
  measureDir,
  measureFootprint,
} from '../src/disk-footprint.ts';
import type { VpsApp } from '../src/vps-apps.ts';

type Node =
  | { kind: 'dir'; children: string[]; deny?: true }
  | { kind: 'file'; blocks: number; ino?: number; nlink?: number }
  | { kind: 'link' };

const err = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), { code });

/** 一棵假的文件树：路径 → 节点；deny 的目录列不出（EACCES），不在表里的 ENOENT。 */
function fakeFs(tree: Record<string, Node>, onLstat?: () => void): FootprintFs {
  return {
    async lstat(path) {
      onLstat?.();
      const n = tree[path];
      if (!n) throw err('ENOENT', path);
      if (n.kind === 'dir')
        return { dir: true, link: false, bytes: 4096, dev: 1, ino: path.length, nlink: 2 };
      if (n.kind === 'link')
        return { dir: false, link: true, bytes: 0, dev: 1, ino: path.length + 1000, nlink: 1 };
      return {
        dir: false,
        link: false,
        bytes: n.blocks * 512,
        dev: 1,
        ino: n.ino ?? path.length + 5000,
        nlink: n.nlink ?? 1,
      };
    },
    async readDir(path) {
      const n = tree[path];
      if (!n) throw err('ENOENT', path);
      if (n.kind !== 'dir') throw err('ENOTDIR', path);
      if (n.deny) throw err('EACCES', path);
      return n.children;
    },
  };
}

const TREE: Record<string, Node> = {
  '/srv/a': { kind: 'dir', children: ['x', 'sub', 'locked', 'ln', 'h1', 'h2'] },
  '/srv/a/x': { kind: 'file', blocks: 8 },
  '/srv/a/sub': { kind: 'dir', children: ['y'] },
  '/srv/a/sub/y': { kind: 'file', blocks: 16 },
  '/srv/a/locked': { kind: 'dir', children: [], deny: true },
  '/srv/a/ln': { kind: 'link' },
  // 同一个文件的两个硬链接：只算一次
  '/srv/a/h1': { kind: 'file', blocks: 100, ino: 77, nlink: 2 },
  '/srv/a/h2': { kind: 'file', blocks: 100, ino: 77, nlink: 2 },
};

describe('量一个目录', () => {
  test('按块相加；读不了的子树记一棵、带第一棵的路径；符号链接不跟；硬链接只算一次', async () => {
    const size = await measureDir('/srv/a', fakeFs(TREE), {
      deadline: Number.POSITIVE_INFINITY,
      seen: new Set(),
    });
    // 目录 3 个 × 4096 + 文件 (8 + 16 + 100) × 512
    expect(size).toEqual({
      state: 'ok',
      bytes: 3 * 4096 + (8 + 16 + 100) * 512,
      unreadTrees: 1,
      unreadSample: '/srv/a/locked：EACCES: /srv/a/locked',
    });
  });

  test('【故意造出读不到】目录不在：unread「没有这个目录」，不是 0', async () => {
    expect(
      await measureDir('/nope', fakeFs(TREE), { deadline: Number.POSITIVE_INFINITY, seen: new Set() }),
    ).toEqual({
      state: 'unread',
      why: '没有 /nope 这个目录（或后端看不见它）',
    });
  });

  test('【故意造出读不到】整个目录列不出（权限）：unread 带原因', async () => {
    const got = await measureDir('/srv/a/locked', fakeFs(TREE), {
      deadline: Number.POSITIVE_INFINITY,
      seen: new Set(),
    });
    expect(got).toEqual({ state: 'unread', why: '读不了 /srv/a/locked：EACCES: /srv/a/locked' });
  });

  test('到时限没测完：数是下限、标 capped', async () => {
    let t = 0;
    const size = await measureDir(
      '/srv/a',
      fakeFs(TREE, () => (t += 1)),
      {
        deadline: 3,
        seen: new Set(),
        now: () => t,
      },
    );
    expect(size).toMatchObject({ state: 'ok', capped: true });
  });
});

const APPS: VpsApp[] = [
  { id: 'a', name: 'A', place: '/srv/a', units: [], dirs: ['/srv/a', '/nope'], idleNote: 'x' },
  {
    id: 'db',
    name: '数据库',
    place: '/var/lib/postgresql',
    units: [],
    dirs: [],
    databases: 'all',
    idleNote: 'x',
  },
];

describe('测一回', () => {
  test('各目录照登记表量，库走 SQL 归到 databases: all 的应用名下；形状过 schema', async () => {
    let t = 1_000;
    const fp = await measureFootprint({
      apps: APPS,
      fs: fakeFs(TREE),
      databases: async () => [
        { name: 'fleet', bytes: 2_000_000 },
        { name: 'locked', bytes: undefined },
      ],
      now: () => {
        t += 10;
        return new Date(t);
      },
    });
    expect(DiskFootprintSchema.parse(fp)).toEqual(fp);
    if (fp.state !== 'ok') throw new Error('该测成');
    expect(fp.dirs.map((d) => [d.path, d.appId, d.size.state])).toEqual([
      ['/srv/a', 'a', 'ok'],
      ['/nope', 'a', 'unread'],
    ]);
    expect(fp.databases).toEqual({
      state: 'ok',
      items: [
        { name: 'fleet', appId: 'db', size: { state: 'ok', bytes: 2_000_000 } },
        { name: 'locked', appId: 'db', size: { state: 'unread', why: '没有这个库的 CONNECT 权限，量不了' } },
      ],
    });
  });

  test('【故意造出读不到】没连库 / 库查询抛错：databases 是 unread 带原因', async () => {
    const none = await measureFootprint({ apps: APPS, fs: fakeFs(TREE), now: () => new Date(0) });
    expect(none.state === 'ok' && none.databases).toEqual({
      state: 'unread',
      why: '这台后端没连数据库（开发用的内存版）',
    });
    const bad = await measureFootprint({
      apps: APPS,
      fs: fakeFs(TREE),
      databases: async () => {
        throw new Error('permission denied for function pg_database_size');
      },
      now: () => new Date(0),
    });
    expect(bad.state === 'ok' && bad.databases).toEqual({
      state: 'unread',
      why: '库的大小没查成：permission denied for function pg_database_size',
    });
  });
});

describe('测量器', () => {
  test('间隔写死：10 分钟', () => {
    expect(FOOTPRINT_EVERY_MS).toBe(10 * 60_000);
  });

  test('还没测过是 pending；戳一下才在后台测，测完 latest 给结果；10 分钟内再戳不再测', async () => {
    let runs = 0;
    let t = 0;
    let release: () => void = () => {};
    const meter = createFootprintMeter({
      measure: async () => {
        runs += 1;
        await new Promise<void>((r) => {
          release = r;
        });
        return {
          state: 'ok',
          measuredAt: new Date(t).toISOString(),
          everyMs: FOOTPRINT_EVERY_MS,
          tookMs: 1,
          dirs: [],
          databases: { state: 'ok', items: [] },
        };
      },
      now: () => new Date(t),
    });
    expect(meter.latest()).toEqual({ state: 'pending', why: '还没测过（有页面开着才测，每 10 分钟一次）' });
    meter.poke();
    expect(meter.latest()).toEqual({
      state: 'pending',
      why: '正在测第一回（要遍历文件，测完就有；之后每 10 分钟测一次）',
    });
    // 测着的时候再戳不另起
    meter.poke();
    expect(runs).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(meter.latest().state).toBe('ok');
    t = FOOTPRINT_EVERY_MS - 1;
    meter.poke();
    expect(runs).toBe(1);
    t = FOOTPRINT_EVERY_MS + 1;
    meter.poke();
    expect(runs).toBe(2);
    release();
  });

  test('【故意造出失败】测量抛错：还没有结果时 pending 写明没测成，不当成 0', async () => {
    const meter = createFootprintMeter({
      measure: async () => {
        throw new Error('炸了');
      },
      now: () => new Date(0),
    });
    meter.poke();
    await new Promise((r) => setTimeout(r, 0));
    expect(meter.latest()).toEqual({ state: 'pending', why: '上一回没测成：炸了（10 分钟后再测）' });
  });
});
