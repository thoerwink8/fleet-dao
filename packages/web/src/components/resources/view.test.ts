// 资源页的读数怎么写给人看（#1986，view.ts）：读成了写数；没在跑写「没在占用」；读不到写「没读到」带原因；
// 目录读不全写「不全：有 N 棵树没读到」；老后端没有 apps / footprint 写明没给。任何一种都不拿 0 顶。
import { describe, expect, test } from 'vitest';
import { diskMeter, formatBytes } from '../home/resources.ts';
import type { HomeResources, HomeRunning } from '../home/types.ts';
import { appRows, formatCores } from './view.ts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

type App = Extract<NonNullable<HomeResources['apps']>, { state: 'ok' }>['items'][number];

const app = (id: string, usage: App['usage'], extra: Partial<App> = {}): App => ({
  id,
  name: id,
  place: `/srv/${id}`,
  units: [`${id}.service`],
  usage,
  ...extra,
});

function resources(over: Partial<HomeResources> = {}): HomeResources {
  return {
    at: '2026-10-13T02:00:00.000Z',
    everyMs: 5_000,
    memory: { state: 'ok', totalMb: 12_000, availableMb: 6_000 },
    cpu: { state: 'ok', percent: 20, busyCores: 1.2, cores: 6 },
    sessions: {
      state: 'ok',
      byRun: {
        r1: { state: 'ok', memoryMb: 500, cpuPercent: 40 },
        r2: { state: 'ok', memoryMb: 300, cpuPercent: 10 },
        probe: { state: 'ok', memoryMb: 100, cpuPercent: 5 },
      },
    },
    disk: { state: 'ok', path: '/', totalBytes: 100 * GIB, usedBytes: 40 * GIB, availableBytes: 55 * GIB },
    apps: {
      state: 'ok',
      items: [
        app(
          'cockpit',
          { state: 'ok', running: 1, memoryMb: 220, cpuCores: 0.06 },
          { diskNote: '代码在发布版本目录里' },
        ),
        app('engine', { state: 'ok', running: 1, memoryMb: 400 }),
        app('release', { state: 'idle' }),
        app('broken', { state: 'unread', why: 'memory.current 的内容认不出' }),
        app('sessions', { state: 'ok', running: 3, memoryMb: 900, memoryMaxMb: 1000, cpuCores: 0.55 }),
        app('postgres', { state: 'ok', running: 1, memoryMb: 300, cpuCores: 0.02 }),
        app('self-proxy', { state: 'ok', running: 2, memoryMb: 50, cpuCores: 0 }, { external: true }),
      ],
    },
    footprint: {
      state: 'ok',
      measuredAt: '2026-10-13T01:56:00.000Z',
      everyMs: 600_000,
      tookMs: 12_000,
      dirs: [
        {
          path: '/var/lib/fleet-dao/engine',
          appId: 'engine',
          size: { state: 'ok', bytes: 3 * GIB, unreadTrees: 0 },
        },
        {
          path: '/var/lib/fleet-work',
          appId: 'sessions',
          size: { state: 'ok', bytes: 300 * MIB, unreadTrees: 7 },
        },
        {
          path: '/home/fleet-agent-carpool',
          appId: 'sessions',
          size: { state: 'unread', why: 'EACCES：后端看不见 /home' },
        },
        { path: '/var/lib/broken', appId: 'broken', size: { state: 'unread', why: '没有这个目录' } },
        {
          path: '/usr/local/lib/fleet-dao',
          appId: 'release',
          size: { state: 'ok', bytes: 2 * MIB, unreadTrees: 0 },
        },
      ],
      databases: {
        state: 'ok',
        items: [{ name: 'fleet', appId: 'postgres', size: { state: 'ok', bytes: 2 * GIB } }],
      },
    },
    ...over,
  };
}

const running = (repo: string, runIds: string[]): HomeRunning => ({
  issueNumber: 1,
  title: 't',
  repo,
  segment: 'doing',
  waitingReason: 'nothing',
  link: '/tasks/t-1',
  runIds,
});

function rowsOf(r: HomeResources | undefined, run: HomeRunning[] = [], remote = false) {
  const out = appRows(r, run, { remote });
  if (out.kind !== 'ok') throw new Error(`没出行：${out.why}`);
  return Object.fromEntries(out.rows.map((row) => [row.id, row]));
}

describe('写法', () => {
  test('字节：不到 1M 写「不到 1M」，不写 0；三位数 M、四位数起 G、到 T', () => {
    expect(formatBytes(12 * 1024)).toBe('不到 1M');
    expect(formatBytes(312 * MIB)).toBe('312M');
    expect(formatBytes(1000 * MIB)).toBe('1.0G');
    expect(formatBytes(61.8 * GIB)).toBe('61.8G');
    expect(formatBytes(2048 * GIB)).toBe('2.0T');
  });

  test('核数：太小写两位，不写成 0.0 核', () => {
    expect(formatCores(0.02)).toBe('0.02 核');
    expect(formatCores(0.55)).toBe('0.6 核');
  });
});

describe('整机磁盘格', () => {
  test('读成了：已用 / 总量、百分比、剩余；≥ 90% 算紧', () => {
    const m = diskMeter({
      state: 'ok',
      path: '/',
      totalBytes: 100 * GIB,
      usedBytes: 40 * GIB,
      availableBytes: 55 * GIB,
    });
    expect(m).toMatchObject({ kind: 'ok', percent: 40, tight: false, brief: '剩余 55.0G' });
    expect(m.kind === 'ok' && m.amount).toEqual({ kind: 'ok', text: '40.0G / 100.0G' });
    const t = diskMeter({
      state: 'ok',
      path: '/',
      totalBytes: 100 * GIB,
      usedBytes: 91 * GIB,
      availableBytes: 4 * GIB,
    });
    expect(t.kind === 'ok' && t.tight).toBe(true);
  });

  test('statfs 读不到：没读到带原因；老后端没给：写明没给', () => {
    expect(diskMeter({ state: 'unread', why: 'EACCES' })).toEqual({ kind: 'unread', why: 'EACCES' });
    expect(diskMeter(undefined)).toMatchObject({
      kind: 'unread',
      why: expect.stringContaining('后端没给磁盘读数'),
    });
    expect(diskMeter(undefined, { remote: true })).toMatchObject({
      why: expect.stringContaining('那台推来的读数里没有磁盘'),
    });
  });
});

describe('每个上线项目一行', () => {
  test('在跑的写数；CPU 只读到一回写采样中（不是 0）；内存有上限写「已用 / 上限」', () => {
    const rows = rowsOf(resources());
    expect(rows.cockpit?.cpu).toMatchObject({ kind: 'ok', text: '0.1 核' });
    expect(rows.cockpit?.memory).toMatchObject({ kind: 'ok', text: '220M' });
    expect(rows.engine?.cpu.kind).toBe('sampling');
    expect(rows.sessions?.memory).toMatchObject({ kind: 'ok', text: '900M / 1.0G', tight: true });
  });

  test('没在跑：CPU、内存都写「没在占用」，不是 0', () => {
    const rows = rowsOf(resources());
    expect(rows.release?.cpu).toEqual({ kind: 'idle' });
    expect(rows.release?.memory).toEqual({ kind: 'idle' });
  });

  test('cgroup 读不到：没读到带原因', () => {
    const rows = rowsOf(resources());
    expect(rows.broken?.cpu).toEqual({ kind: 'unread', why: 'memory.current 的内容认不出' });
    expect(rows.broken?.disk).toEqual({ kind: 'unread', why: '没有这个目录' });
  });

  test('磁盘：名下目录 + 库相加；有读不全的写「不全」带棵数和整个没读到的目录数，数是下限', () => {
    const rows = rowsOf(resources());
    expect(rows.engine?.disk).toMatchObject({ kind: 'ok', text: '3.0G' });
    expect(rows.postgres?.disk).toMatchObject({ kind: 'ok', text: '2.0G' });
    expect(rows.sessions?.disk).toMatchObject({
      kind: 'ok',
      text: '300M',
      incomplete: '不全：有 7 棵树没读到，有 1 个目录整个没读到',
    });
    // 名下没登记目录：写登记表里的补充，不写 0
    expect(rows.cockpit?.disk).toEqual({ kind: 'none', why: '代码在发布版本目录里' });
  });

  test('别家的排在本仓的后面', () => {
    const out = appRows(resources(), []);
    expect(out.kind === 'ok' && out.rows.map((r) => r.id).at(-1)).toBe('self-proxy');
  });

  test('定时任务没在跑：CPU、内存写近 24 小时；没给写「近 24 小时没给」，不写没在占用也不写 0', () => {
    const base = resources();
    if (base.apps?.state !== 'ok') throw new Error('夹具没有 apps');
    const idle = { state: 'idle' } as const;
    const out = appRows(
      resources({
        apps: {
          ...base.apps,
          items: [
            app('missing', idle, { scheduled: true }),
          ],
        },
      }),
      [],
    );
    if (out.kind !== 'ok') throw new Error('不该没读到');
    const by = Object.fromEntries(out.rows.map((r) => [r.id, r]));
    expect(by.missing?.cpu).toMatchObject({ kind: 'unread', word: '近 24 小时没给' });
    expect(by.missing?.memory).toMatchObject({ kind: 'unread', word: '近 24 小时没给' });
  });

  test('没登记的（兜底扫出来的）排在最后，连别家的也在它前面；老后端没有这个字段照常', () => {
    const base = resources();
    if (base.apps?.state !== 'ok') throw new Error('夹具没有 apps');
    const withExtra = resources({
      apps: {
        ...base.apps,
        items: [
          app('newcomer', { state: 'ok', running: 1, memoryMb: 20, cpuCores: 0.01 }, { unregistered: true }),
          ...base.apps.items,
        ],
      },
    });
    const out = appRows(withExtra, []);
    if (out.kind !== 'ok') throw new Error('不该没读到');
    expect(out.rows.map((r) => r.id).slice(-2)).toEqual(['self-proxy', 'newcomer']);
    expect(out.rows.at(-1)).toMatchObject({
      unregistered: true,
      disk: { kind: 'none', why: '名下没登记目录' },
    });
    expect(out.rows[0]?.unregistered).toBe(false);
  });

  test('AI 会话按仓折成子行；对不上单的归「别的会话」，压在最后', () => {
    const rows = rowsOf(resources(), [running('acme/a', ['r2']), running('acme/b', ['r1'])]);
    expect(rows.sessions?.children?.map((c) => [c.name, c.memory, c.cpu])).toEqual([
      ['acme/b', { kind: 'ok', text: '500M' }, { kind: 'ok', text: '0.4 核' }],
      ['acme/a', { kind: 'ok', text: '300M' }, { kind: 'ok', text: '0.1 核' }],
      ['别的会话（路由探针、对不上单的）', { kind: 'ok', text: '100M' }, { kind: 'ok', text: '0.1 核' }],
    ]);
  });

  test('【故意造出读到 0】空 scope（里面没进程）不算会话、不进合计；只剩空 scope 的那一组写「空 scope」，不写 0M / 0 核', () => {
    const base = resources();
    const why = 'scope 还在，但 memory.current 是 0';
    const r = resources({
      sessions: {
        state: 'ok',
        byRun: {
          ...(base.sessions.state === 'ok' ? base.sessions.byRun : {}),
          'mirasim-a': { state: 'empty', why },
          'mirasim-b': { state: 'empty', why },
          r9: { state: 'empty', why },
        },
      },
    });
    const rows = rowsOf(r, [running('acme/a', ['r2']), running('acme/c', ['r9'])]);
    const kids = Object.fromEntries((rows.sessions?.children ?? []).map((c) => [c.name, c]));
    // 真有的数照写；「别的会话」是 r1 + probe 两个，两个空 scope 不算进会话数、不进合计
    expect(kids['acme/a']).toMatchObject({ sessions: 1, memory: { kind: 'ok', text: '300M' } });
    expect(kids['别的会话（路由探针、对不上单的）']).toMatchObject({
      sessions: 2,
      emptyScopes: 2,
      memory: { kind: 'ok', text: '600M' },
    });
    // 只剩空 scope 的仓：写「空 scope」带原因，0 个会话在跑
    expect(kids['acme/c']).toMatchObject({
      sessions: 0,
      memory: { kind: 'empty', why },
      cpu: { kind: 'empty', why },
    });
    expect(JSON.stringify(kids['acme/c'])).not.toMatch(/0M|0\.0 核/);
  });

  test('按目录的还没测完：磁盘写还没测完（pending），不是 0', () => {
    const rows = rowsOf(resources({ footprint: { state: 'pending', why: '正在测第一回' } }));
    expect(rows.engine?.disk).toEqual({ kind: 'pending', why: '正在测第一回' });
  });

  test('库整块没读成：数据库那一行写没读到', () => {
    const r = resources();
    if (r.footprint?.state !== 'ok') throw new Error('造数错了');
    r.footprint.databases = { state: 'unread', why: '这台后端没连数据库' };
    expect(rowsOf(r).postgres?.disk).toEqual({ kind: 'unread', why: '库的大小没读成：这台后端没连数据库' });
  });

  test('老后端没有 apps：整段写明后端没给；远程写那台没推；整块没给资源读数也写明', () => {
    const r = resources();
    delete r.apps;
    expect(appRows(r, [])).toEqual({
      kind: 'unread',
      why: '后端没给每个上线项目的占用（后端的版本还没有这一项）',
    });
    expect(appRows(r, [], { remote: true })).toEqual({
      kind: 'unread',
      why: '那台推来的读数里没有每个上线项目的占用（那台的版本还没有这一项）',
    });
    expect(appRows(undefined, [])).toEqual({ kind: 'unread', why: '这台后端没给资源读数' });
  });

  test('整块没读到（量磁盘的单元没装、文件认不出）：每行磁盘写没读到和原因，不是 0 也不是下限', () => {
    const r = resources({ footprint: { state: 'unread', why: '没有 sizes.json：单元还没装' } });
    expect(rowsOf(r).engine?.disk).toEqual({ kind: 'unread', why: '没有 sizes.json：单元还没装' });
  });

  test('这一回没量成、用上次的旧数：数照写，缺口写「有 N 个目录是上次量成的旧数」', () => {
    const r = resources();
    if (r.footprint?.state !== 'ok') throw new Error('造数错了');
    const d = r.footprint.dirs.find((x) => x.appId === 'sessions');
    if (!d) throw new Error('造数错了：没有 sessions 的目录');
    d.size = {
      state: 'ok',
      bytes: 9 * GIB,
      unreadTrees: 0,
      measuredAt: '2026-10-13T01:00:00.000Z',
      stale: { why: '超过 300 秒没量完，被停掉' },
    };
    const disk = rowsOf(r).sessions?.disk;
    expect(disk?.kind).toBe('ok');
    if (disk?.kind === 'ok') expect(disk.incomplete).toContain('有 1 个目录是上次量成的旧数');
  });

  test('定时任务：CPU 写近 24 小时平均核数和次数、内存写单次峰值；读不到写原因', () => {
    const base = resources();
    const withTimers = (
      timers: NonNullable<Extract<NonNullable<HomeResources['footprint']>, { state: 'ok' }>['timers']>,
    ) => {
      const r = resources();
      if (r.footprint?.state !== 'ok') throw new Error('造数错了');
      r.footprint.timers = timers;
      return r;
    };
    expect(base.footprint?.state).toBe('ok');
    const row = rowsOf(
      withTimers([
        { unit: 'release.service', runs24h: 1422, cpuSeconds24h: 3193, peakMemoryBytes: 116 * MIB },
      ]),
    ).release;
    expect(row?.cpu).toMatchObject({ kind: 'ok', text: '近 24 小时平均 0.04 核（跑了 1422 次）' });
    expect(row?.memory).toMatchObject({ kind: 'ok', text: '单次峰值 116M' });
    const radar = rowsOf(
      withTimers([{ unit: 'release.service', runs24h: 126, cpuSeconds24h: 179, peakMemoryBytes: 68 * MIB }]),
    ).release;
    expect(radar?.cpu).toMatchObject({
      text: '近 24 小时平均 <0.01 核（跑了 126 次）',
    });
    const bad = rowsOf(
      withTimers([{ unit: 'release.service', why: 'journalctl 超过 60 秒没读完，被停掉' }]),
    ).release;
    expect(bad?.cpu).toMatchObject({ kind: 'unread', why: expect.stringContaining('超过 60 秒') });
  });

  test('老后端没有 footprint：每行磁盘写没读到、原因是没给', () => {
    const r = resources();
    delete r.footprint;
    expect(rowsOf(r).engine?.disk).toEqual({
      kind: 'unread',
      why: '后端没给按目录的磁盘占用（后端的版本还没有这一项）',
    });
  });
});
