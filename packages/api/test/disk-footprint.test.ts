// 按目录的磁盘占用（#1985、#3456，disk-footprint.ts）：法国上 root 的单元用 du 量好写进文件，这里读它。
// 做完的判据（#3456 第 3 条）：这一回没量完时，给上次量成的大小和测量时间，不给「不到 1M」的下限；读不了的目录给明确原因。
// 另核对：root 单元的目录清单（deploy/france/footprint/dirs.json）和登记表（vps-apps.ts）一致。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DiskFootprintSchema } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';
import {
  createFootprintMeter,
  FOOTPRINT_EVERY_MS,
  FOOTPRINT_SIZES_FILE,
  footprintFromSizes,
  readDatabases,
  readSizesFile,
} from '../src/disk-footprint.ts';
import { VPS_APPS, type VpsApp } from '../src/vps-apps.ts';

const NOW = new Date('2026-10-21T03:00:00.000Z');
const iso = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const APPS: VpsApp[] = [
  {
    id: 'sessions',
    name: 'AI 会话',
    place: '/var/lib/fleet-work',
    units: [],
    dirs: ['/var/lib/fleet-work', '/home/fleet-agent-carpool', '/var/lib/daihuo'],
    idleNote: 'x',
  },
  { id: 'postgres', name: '数据库', place: '/pg', units: [], dirs: [], databases: 'all', idleNote: 'x' },
];
const DB_UNREAD = { state: 'unread' as const, why: '这台后端没连数据库' };

const entry = (path: string, over: Record<string, unknown> = {}) => ({
  path,
  bytes: 1000,
  measuredAt: iso(5),
  attemptedAt: iso(5),
  tookMs: 1200,
  skipped: 0,
  error: null,
  ...over,
});
const file = (dirs: unknown[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 1, measuredAt: iso(4), everyMs: FOOTPRINT_EVERY_MS, tookMs: 5000, dirs, ...over });

const GIB = 1024 ** 3;
type Ok = Extract<ReturnType<typeof footprintFromSizes>, { state: 'ok' }>;
const okOf = (fp: ReturnType<typeof footprintFromSizes>): Ok => {
  if (fp.state !== 'ok') throw new Error(`应当是 ok：${JSON.stringify(fp)}`);
  return fp;
};

describe('读 root 单元写的文件', () => {
  test('量成了：每个目录给大小和各自的测量时间；整份过线上契约', () => {
    const fp = footprintFromSizes({
      apps: APPS,
      file: file([
        entry('/var/lib/fleet-work', { bytes: 9 * GIB }),
        entry('/home/fleet-agent-carpool', { bytes: 3 * GIB, measuredAt: iso(6) }),
        entry('/var/lib/daihuo', { bytes: 12345 }),
      ]),
      databases: DB_UNREAD,
      now: NOW,
    });
    expect(DiskFootprintSchema.safeParse(fp).success).toBe(true);
    const dirs = okOf(fp).dirs;
    expect(dirs.map((d) => [d.path, d.size])).toEqual([
      ['/var/lib/fleet-work', { state: 'ok', bytes: 9 * GIB, unreadTrees: 0, measuredAt: iso(5) }],
      ['/home/fleet-agent-carpool', { state: 'ok', bytes: 3 * GIB, unreadTrees: 0, measuredAt: iso(6) }],
      ['/var/lib/daihuo', { state: 'ok', bytes: 12345, unreadTrees: 0, measuredAt: iso(5) }],
    ]);
    expect(okOf(fp).measuredAt).toBe(iso(4));
  });

  test('【#3456 第 3 条】这一回没量完：返回上次量成的大小和测量时间，带原因，不返回下限', () => {
    const fp = footprintFromSizes({
      apps: APPS,
      file: file([
        entry('/var/lib/fleet-work', {
          bytes: 9 * GIB,
          measuredAt: iso(35),
          attemptedAt: iso(5),
          error: '超过 300 秒没量完，被停掉',
        }),
        entry('/home/fleet-agent-carpool'),
        entry('/var/lib/daihuo'),
      ]),
      databases: DB_UNREAD,
      now: NOW,
    });
    const work = okOf(fp).dirs[0]?.size;
    expect(work).toEqual({
      state: 'ok',
      bytes: 9 * GIB,
      unreadTrees: 0,
      measuredAt: iso(35),
      stale: { why: '超过 300 秒没量完，被停掉', attemptedAt: iso(5) },
    });
    expect(JSON.stringify(fp)).not.toContain('capped');
    expect(DiskFootprintSchema.safeParse(fp).success).toBe(true);
  });

  test('读不了的目录：从没量成过给明确原因（不是 0、不是下限）；文件里没有的目录写清楚', () => {
    const fp = footprintFromSizes({
      apps: APPS,
      file: file([
        entry('/var/lib/fleet-work'),
        entry('/home/fleet-agent-carpool', {
          bytes: null,
          measuredAt: null,
          error: '没有这个目录（或这台机器上没有）',
        }),
      ]),
      databases: DB_UNREAD,
      now: NOW,
    });
    const [, home, daihuo] = okOf(fp).dirs;
    expect(home?.size.state).toBe('unread');
    expect(home?.size).toMatchObject({ why: expect.stringContaining('从没量成过：没有这个目录') });
    expect(daihuo?.size).toMatchObject({
      state: 'unread',
      why: expect.stringContaining('清单里还没有 /var/lib/daihuo'),
    });
  });

  test('文件旧了（超过两个间隔没更新）：数照给、每个都标旧，原因写几分钟没更新和上次写在几点', () => {
    const fp = footprintFromSizes({
      apps: APPS,
      file: file(
        [entry('/var/lib/fleet-work'), entry('/home/fleet-agent-carpool'), entry('/var/lib/daihuo')],
        {
          measuredAt: iso(45),
        },
      ),
      databases: DB_UNREAD,
      now: NOW,
    });
    for (const d of okOf(fp).dirs) {
      expect(d.size).toMatchObject({
        state: 'ok',
        stale: { why: expect.stringContaining('已经 45 分钟没更新') },
      });
    }
  });

  test('文件不在、不是 JSON、格式认不出：整块 unread 带原因，不当 0、不当 pending', async () => {
    const missing = await readSizesFile('/不存在/sizes.json');
    expect(missing).toEqual({ error: expect.stringContaining('量磁盘的单元还没装或还没跑过') });
    for (const f of [missing, 'not json', '{"schema":2}', file([entry('/x', { bytes: -1 })])]) {
      const fp = footprintFromSizes({ apps: APPS, file: f, databases: DB_UNREAD, now: NOW });
      expect(fp.state).toBe('unread');
      if (fp.state === 'unread') expect(fp.why).toBeTruthy();
      expect(DiskFootprintSchema.safeParse(fp).success).toBe(true);
    }
    expect(FOOTPRINT_SIZES_FILE).toBe('/var/lib/fleet-footprint/sizes.json');
  });

  test('定时任务近 24 小时的账原样带出；读不到的单元带原因', () => {
    const timers = [
      { unit: 'a.service', runs24h: 1422, cpuSeconds24h: 3193, peakMemoryBytes: 116 * 1024 * 1024 },
      { unit: 'b.service', why: 'journalctl 超过 60 秒没读完，被停掉' },
    ];
    const fp = footprintFromSizes({
      apps: APPS,
      file: file(
        [entry('/var/lib/fleet-work'), entry('/home/fleet-agent-carpool'), entry('/var/lib/daihuo')],
        {
          timers,
        },
      ),
      databases: DB_UNREAD,
      now: NOW,
    });
    expect(okOf(fp).timers).toEqual(timers);
    expect(DiskFootprintSchema.safeParse(fp).success).toBe(true);
  });
});

describe('库的大小', () => {
  test('每个库一行；没有 CONNECT 权限的单写没读到；查失败整块 unread', async () => {
    const ok = await readDatabases(APPS, async () => [
      { name: 'fleet', bytes: 100 },
      { name: 'secret', bytes: undefined },
    ]);
    expect(ok.state).toBe('ok');
    if (ok.state === 'ok') {
      expect(ok.items[0]?.size).toEqual({ state: 'ok', bytes: 100 });
      expect(ok.items[1]?.size).toMatchObject({ state: 'unread' });
    }
    expect(
      await readDatabases(APPS, async () => {
        throw new Error('连不上');
      }),
    ).toEqual({ state: 'unread', why: '库的大小没查成：连不上' });
    expect((await readDatabases(APPS, undefined)).state).toBe('unread');
  });
});

describe('测量器', () => {
  const wait = () => new Promise((r) => setTimeout(r, 5));
  test('还没读过是 pending；读一回后给结果；30 秒内不重读；库 10 分钟才查一回', async () => {
    let t = NOW.getTime();
    let reads = 0;
    let dbCalls = 0;
    const meter = createFootprintMeter({
      apps: APPS,
      now: () => new Date(t),
      read: async () => {
        reads += 1;
        return file([entry('/var/lib/fleet-work')]);
      },
      databases: async () => {
        dbCalls += 1;
        return [{ name: 'fleet', bytes: 1 }];
      },
    });
    expect(meter.latest().state).toBe('pending');
    meter.poke();
    await wait();
    expect(meter.latest().state).toBe('ok');
    meter.poke();
    await wait();
    expect(reads).toBe(1);
    t += 31_000;
    meter.poke();
    await wait();
    expect(reads).toBe(2);
    expect(dbCalls).toBe(1);
    t += FOOTPRINT_EVERY_MS;
    meter.poke();
    await wait();
    expect(dbCalls).toBe(2);
  });

  test('读文件抛了：这一回是 unread 带原因，不卡住、不留旧的冒充新的', async () => {
    const meter = createFootprintMeter({
      apps: APPS,
      now: () => NOW,
      read: async () => {
        throw new Error('炸了');
      },
    });
    meter.poke();
    await wait();
    const fp = meter.latest();
    expect(fp).toMatchObject({ state: 'unread', why: expect.stringContaining('炸了') });
  });
});

describe('root 单元的目录清单和登记表一致', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const manifest = JSON.parse(readFileSync(`${root}deploy/france/footprint/dirs.json`, 'utf8')) as {
    schema: number;
    dirs: string[];
    timers: string[];
  };
  const dirs = VPS_APPS.flatMap((a) => a.dirs);
  const timers = VPS_APPS.flatMap((a) => a.units.map((u) => u.name))
    .filter((n) => n.endsWith('.timer'))
    .map((n) => n.replace(/\.timer$/, '.service'));

  test('dirs.json 的目录 = 登记表里所有应用的目录（同顺序）', () => {
    expect(
      manifest.dirs,
      'deploy/france/footprint/dirs.json 的 dirs 要和 vps-apps.ts 里所有应用的 dirs 一样（france.sh 的自动档把它装给 root 的量磁盘单元）',
    ).toEqual(dirs);
  });

  test('dirs.json 的 timers = 登记表里带 .timer 的单元对应的 .service', () => {
    expect(
      manifest.timers,
      'deploy/france/footprint/dirs.json 的 timers 要和 vps-apps.ts 里带 .timer 的单元一致',
    ).toEqual(timers);
    expect(manifest.schema).toBe(1);
  });
});
