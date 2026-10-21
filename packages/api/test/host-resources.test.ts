// 主页的机器资源采样（#1973，host-resources.ts）：整机内存 / CPU 读 /proc，每个会话读自己 scope 的 cgroup。
// 读不到（文件不在、内容认不出、这台不是 Linux）一律是 unread + 原因，绝不拿 0 顶；CPU 要两次读数的差才算得出。
import { HomeResourcesSchema } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';
import {
  createHostResourceSampler,
  type HostReadDeps,
  parseCpuUsageUsec,
  parseMeminfo,
  parseProcStat,
  RESOURCE_SAMPLE_MS,
  readHostResources,
} from '../src/host-resources.ts';
import type { VpsApp } from '../src/vps-apps.ts';

const SLICE = '/cg/fleet.slice/fleet-agents.slice';

const MEMINFO =
  'MemTotal:       12267520 kB\nMemFree:  1000 kB\nMemAvailable:    6133760 kB\nBuffers: 1 kB\n';
const stat = (busy: number, idle: number) =>
  `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\ncpu1 1 0 0 1 0 0 0 0 0 0\nintr 1\n`;

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
}

/** 一台假机器：文件表里有的读得到，没有的 ENOENT。 */
function fakeMachine(files: Record<string, string>, dirs: Record<string, string[]> = {}): HostReadDeps {
  return {
    procRoot: '/proc',
    cgroupRoot: '/cg',
    slicePath: 'fleet.slice/fleet-agents.slice',
    async readText(path) {
      const v = files[path];
      if (v === undefined) throw enoent(path);
      return v;
    },
    async readDir(path) {
      const v = dirs[path];
      if (v === undefined) throw enoent(path);
      return v;
    },
  };
}

function scope(id: string, current: string, peak: string | undefined, usec: number): Record<string, string> {
  const dir = `${SLICE}/fleet-agent-${id}.scope`;
  return {
    [`${dir}/memory.current`]: current,
    ...(peak === undefined ? {} : { [`${dir}/memory.peak`]: peak }),
    [`${dir}/cpu.stat`]: `usage_usec ${usec}\nuser_usec 1\nsystem_usec 1\n`,
  };
}

describe('解析', () => {
  test('/proc/meminfo：总量、可用（kB → MiB）', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ totalMb: 11980, availableMb: 5990 });
  });

  test('/proc/meminfo 缺 MemAvailable：认不出，抛', () => {
    expect(() => parseMeminfo('MemTotal: 100 kB\n')).toThrow(/MemAvailable/);
  });

  test('/proc/stat：忙 = 总 − idle − iowait；核数数 cpuN 行', () => {
    expect(parseProcStat('cpu  10 1 4 80 5 0 0 0 0 0\ncpu0 x\ncpu1 x\ncpu2 x\n')).toEqual({
      busy: 15,
      total: 100,
      cores: 3,
    });
    expect(() => parseProcStat('intr 1\n')).toThrow(/认不出/);
  });

  test('cpu.stat：取 usage_usec；没有这一行认不出', () => {
    expect(parseCpuUsageUsec('usage_usec 123456\nuser_usec 1\n')).toBe(123456);
    expect(() => parseCpuUsageUsec('user_usec 1\n')).toThrow(/usage_usec/);
  });
});

describe('读一回', () => {
  const machine = (busy: number, idle: number, usecA: number) =>
    fakeMachine(
      {
        '/proc/meminfo': MEMINFO,
        '/proc/stat': stat(busy, idle),
        '/proc/loadavg': '1.25 0.80 0.50 2/300 4242\n',
        ...scope('run-a', String(800 * 1024 * 1024), String(1200 * 1024 * 1024), usecA),
        ...scope('run-b', String(100 * 1024 * 1024), undefined, 0),
      },
      { [SLICE]: ['fleet-agent-run-a.scope', 'fleet-agent-run-b.scope', 'cgroup.procs', 'memory.current'] },
    );

  test('第一回：内存读成；CPU 只有一次读数，写明算不出（不是 0）；scope 的 CPU 也先不给', async () => {
    const { resources } = await readHostResources(machine(100, 900, 1_000_000), undefined, new Date(10_000));
    expect(HomeResourcesSchema.parse(resources)).toEqual(resources);
    expect(resources.memory).toEqual({ state: 'ok', totalMb: 11980, availableMb: 5990 });
    expect(resources.cpu.state).toBe('unread');
    expect(resources.sessions).toEqual({
      state: 'ok',
      byRun: {
        'run-a': { state: 'ok', memoryMb: 800, memoryPeakMb: 1200 },
        'run-b': { state: 'ok', memoryMb: 100 },
      },
    });
  });

  test('第二回：整机 CPU 按两回的差算；scope 的 CPU = usage_usec 的差 ÷ 墙钟（100 = 一个核）', async () => {
    const first = await readHostResources(machine(100, 900, 1_000_000), undefined, new Date(10_000));
    // 5 秒后：整机忙 300 / 总 1000 = 30%；run-a 用了 2.5 秒 CPU = 50%
    const { resources } = await readHostResources(
      machine(400, 1600, 3_500_000),
      first.next,
      new Date(15_000),
    );
    // 忙的核数和百分比同源：同一对差 × 核数（2 核 × 30% = 0.6 核），不是另读一份
    expect(resources.cpu).toEqual({ state: 'ok', percent: 30, busyCores: 0.6, cores: 2, load1: 1.25 });
    expect(resources.sessions.state === 'ok' && resources.sessions.byRun['run-a']).toEqual({
      state: 'ok',
      memoryMb: 800,
      memoryPeakMb: 1200,
      cpuPercent: 50,
    });
  });

  test('这台不是 Linux（/proc 不在）、没有会话资源池（cgroup 不在）：三样都是 unread 带原因，没有一个 0', async () => {
    const { resources } = await readHostResources(fakeMachine({}), undefined, new Date(1_000));
    expect(resources.memory.state).toBe('unread');
    expect(resources.memory.state === 'unread' && resources.memory.why).toContain('/proc/meminfo');
    expect(resources.cpu.state).toBe('unread');
    expect(resources.sessions.state).toBe('unread');
    expect(resources.sessions.state === 'unread' && resources.sessions.why).toContain(SLICE);
    expect(JSON.stringify(resources)).not.toMatch(/"(totalMb|availableMb|percent|memoryMb)":0/);
  });

  test('一个 scope 的 memory.current 内容认不出：只这一个会话 unread，原因带文件名；别的照常', async () => {
    const files = {
      '/proc/meminfo': MEMINFO,
      '/proc/stat': stat(1, 1),
      ...scope('bad', '这不是数', undefined, 1),
      ...scope('good', String(64 * 1024 * 1024), undefined, 1),
    };
    const { resources } = await readHostResources(
      fakeMachine(files, { [SLICE]: ['fleet-agent-bad.scope', 'fleet-agent-good.scope'] }),
      undefined,
      new Date(1_000),
    );
    if (resources.sessions.state !== 'ok') throw new Error('整池不该没读到');
    const bad = resources.sessions.byRun.bad;
    expect(bad?.state).toBe('unread');
    expect(bad?.state === 'unread' && bad.why).toContain('memory.current');
    expect(resources.sessions.byRun.good).toEqual({ state: 'ok', memoryMb: 64 });
  });

  test('【故意造出读到 0】scope 还在、memory.current 是 0（里面没进程）：写 empty 带原因，不是 ok 的 0；真有的数照写', async () => {
    const files = {
      '/proc/meminfo': MEMINFO,
      '/proc/stat': stat(1, 1),
      ...scope('mirasim-a', '0\n', '0\n', 0),
      // 真有的数（哪怕很小）照写：300K 不当成 0
      ...scope('tiny', String(300 * 1024), undefined, 5),
      ...scope('real', String(64 * 1024 * 1024), undefined, 1),
    };
    const { resources } = await readHostResources(
      fakeMachine(files, {
        [SLICE]: ['fleet-agent-mirasim-a.scope', 'fleet-agent-tiny.scope', 'fleet-agent-real.scope'],
      }),
      undefined,
      new Date(1_000),
    );
    expect(HomeResourcesSchema.parse(resources)).toEqual(resources);
    if (resources.sessions.state !== 'ok') throw new Error('整池不该没读到');
    const empty = resources.sessions.byRun['mirasim-a'];
    expect(empty?.state).toBe('empty');
    expect(empty?.state === 'empty' && empty.why).toContain('memory.current 是 0');
    // 不到 1M 的真读数往上记成 1M（不四舍五入成 0）
    expect(resources.sessions.byRun.tiny).toEqual({ state: 'ok', memoryMb: 1 });
    expect(resources.sessions.byRun.real).toEqual({ state: 'ok', memoryMb: 64 });
    expect(JSON.stringify(resources.sessions.byRun['mirasim-a'])).not.toMatch(/memoryMb|cpuPercent/);
  });

  test('/proc/meminfo 内容认不出：内存 unread 带原因', async () => {
    const { resources } = await readHostResources(
      fakeMachine({ '/proc/meminfo': '乱码', '/proc/stat': stat(1, 1) }, { [SLICE]: [] }),
      undefined,
      new Date(1_000),
    );
    expect(resources.memory.state).toBe('unread');
    expect(resources.sessions).toEqual({ state: 'ok', byRun: {} });
  });
});

describe('采样器', () => {
  test('间隔上限写死在代码里：5 秒', () => {
    expect(RESOURCE_SAMPLE_MS).toBe(5_000);
  });

  test('current()：最近一回还新就直接给，不重读；旧了才现读', async () => {
    let reads = 0;
    const base = fakeMachine({ '/proc/meminfo': MEMINFO, '/proc/stat': stat(1, 1) }, { [SLICE]: [] });
    let t = 0;
    const sampler = createHostResourceSampler({
      read: {
        ...base,
        readText: (p) => {
          if (p === '/proc/meminfo') reads += 1;
          return base.readText(p);
        },
      },
      now: () => new Date(t),
    });
    await sampler.current();
    await sampler.current();
    expect(reads).toBe(1);
    t = RESOURCE_SAMPLE_MS * 3;
    await sampler.current();
    expect(reads).toBe(2);
  });

  test('start：只在有人看（active）时读并推给订阅的；stop 之后不再推', async () => {
    const pushed: unknown[] = [];
    let active = false;
    const sampler = createHostResourceSampler({
      read: fakeMachine({ '/proc/meminfo': MEMINFO, '/proc/stat': stat(1, 1) }, { [SLICE]: [] }),
      now: () => new Date(),
      everyMs: 20,
    });
    sampler.subscribe((r) => pushed.push(r));
    const stop = sampler.start(() => active);
    await new Promise((r) => setTimeout(r, 70));
    expect(pushed).toEqual([]);
    active = true;
    await new Promise((r) => setTimeout(r, 70));
    expect(pushed.length).toBeGreaterThan(0);
    stop();
    const n = pushed.length;
    await new Promise((r) => setTimeout(r, 70));
    expect(pushed.length).toBe(n);
  });

  test('有按目录的测量器：每回读数带上它最近一回；5 秒那一回只「戳」一下，不等遍历', async () => {
    let pokes = 0;
    const sampler = createHostResourceSampler({
      read: fakeMachine({ '/proc/meminfo': MEMINFO, '/proc/stat': stat(1, 1) }, { [SLICE]: [] }),
      now: () => new Date(1_000),
      footprint: {
        latest: () => ({ state: 'pending', why: '正在测第一回' }),
        poke: () => {
          pokes += 1;
        },
      },
    });
    const r = await sampler.current();
    expect(r.footprint).toEqual({ state: 'pending', why: '正在测第一回' });
    expect(pokes).toBe(1);
  });
});

// —— #1985：整机磁盘、每个上线项目 ——

const STATFS = { bsize: 4096, blocks: 50_000_000, bfree: 30_000_000, bavail: 27_500_000 };

describe('整机磁盘（statfs）', () => {
  test('已用 = (总块 − 空闲块) × 块大小；剩余 = bavail × 块大小', async () => {
    const deps = { ...fakeMachine({}), statfs: async () => STATFS };
    const { resources } = await readHostResources(deps, undefined, new Date(1_000));
    expect(resources.disk).toEqual({
      state: 'ok',
      path: '/',
      totalBytes: 50_000_000 * 4096,
      usedBytes: 20_000_000 * 4096,
      availableBytes: 27_500_000 * 4096,
    });
    expect(HomeResourcesSchema.parse(resources)).toEqual(resources);
  });

  test('【故意造出读不到】statfs 抛错：disk 是 unread 带原因，不是 0', async () => {
    const deps = {
      ...fakeMachine({}),
      statfs: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    };
    const { resources } = await readHostResources(deps, undefined, new Date(1_000));
    expect(resources.disk).toEqual({ state: 'unread', why: '/ 的 statfs 没读成：EACCES: permission denied' });
  });

  test('statfs 读回来总块数是 0：认不出，unread', async () => {
    const deps = { ...fakeMachine({}), statfs: async () => ({ ...STATFS, blocks: 0 }) };
    const { resources } = await readHostResources(deps, undefined, new Date(1_000));
    expect(resources.disk?.state).toBe('unread');
  });

  test('没装 statfs（老装配）：不带 disk 这一项，页面写后端没给', async () => {
    const { resources } = await readHostResources(fakeMachine({}), undefined, new Date(1_000));
    expect(resources.disk).toBeUndefined();
  });
});

describe('每个上线项目的 CPU、内存（各单元的 cgroup）', () => {
  const APPS: VpsApp[] = [
    {
      id: 'api',
      name: '驾驶舱',
      place: '/srv/x',
      units: [{ name: 'a.service', cgroup: 'system.slice/a.service' }],
      dirs: [],
      diskNote: 'x',
    },
    {
      id: 'two',
      name: '两个单元',
      place: '/srv/y',
      units: [
        { name: 'b.service', cgroup: 'system.slice/b.service' },
        { name: 'c.service', cgroup: 'system.slice/c.service' },
      ],
      dirs: [],
      diskNote: 'x',
    },
    {
      id: 'off',
      name: '没在跑',
      place: '/srv/z',
      units: [{ name: 'd.service', cgroup: 'system.slice/d.service' }],
      dirs: [],
      diskNote: 'x',
    },
    {
      id: 'disk',
      name: '只占磁盘',
      place: '/srv/w',
      units: [],
      dirs: ['/srv/w'],
      idleNote: '这一项没有进程，只占磁盘',
    },
  ];
  const unit = (name: string, mem: number, max: string, usec: number) => ({
    [`/cg/system.slice/${name}/memory.current`]: String(mem * 1024 * 1024),
    [`/cg/system.slice/${name}/memory.max`]: max,
    [`/cg/system.slice/${name}/cpu.stat`]: `usage_usec ${usec}\n`,
  });
  const machine = (usec: number, extra: Record<string, string> = {}) => ({
    ...fakeMachine({
      '/cg/cgroup.controllers': 'cpu memory\n',
      ...unit('a.service', 200, 'max\n', usec),
      ...unit('b.service', 100, String(512 * 1024 * 1024), usec),
      ...unit('c.service', 50, String(256 * 1024 * 1024), usec * 2),
      ...extra,
    }),
    apps: APPS,
  });

  test('第一回：内存读成、上限是在跑单元 memory.max 之和（有一个是 max 就不给）；CPU 只有一回，不给（不是 0）', async () => {
    const { resources } = await readHostResources(machine(1_000_000), undefined, new Date(10_000));
    expect(HomeResourcesSchema.parse(resources)).toEqual(resources);
    if (resources.apps?.state !== 'ok') throw new Error('整段不该没读到');
    const [api, two, off, disk] = resources.apps.items;
    expect(api).toMatchObject({
      id: 'api',
      name: '驾驶舱',
      units: ['a.service'],
      usage: { state: 'ok', running: 1, memoryMb: 200 },
    });
    expect(api?.usage.state === 'ok' && api.usage.memoryMaxMb).toBeUndefined();
    expect(two?.usage).toEqual({ state: 'ok', running: 2, memoryMb: 150, memoryMaxMb: 768 });
    // 单元的 cgroup 目录不在 = 没在跑：idle，不是 0
    expect(off?.usage).toEqual({ state: 'idle' });
    expect(disk?.usage).toEqual({ state: 'idle', why: '这一项没有进程，只占磁盘' });
  });

  test('第二回：CPU = usage_usec 的差 ÷ 墙钟，按核数（1 = 一个核），几个单元相加', async () => {
    const first = await readHostResources(machine(1_000_000), undefined, new Date(10_000));
    const { resources } = await readHostResources(machine(3_500_000), first.next, new Date(15_000));
    if (resources.apps?.state !== 'ok') throw new Error('整段不该没读到');
    // a：2.5 秒 / 5 秒 = 0.5 核；b 0.5 核 + c 1 核 = 1.5 核
    expect(resources.apps.items[0]?.usage).toMatchObject({ cpuCores: 0.5 });
    expect(resources.apps.items[1]?.usage).toMatchObject({ cpuCores: 1.5 });
  });

  test('【故意造出读不到】这台没有 cgroup v2：整段 unread 带原因', async () => {
    const deps = { ...fakeMachine({}), apps: APPS };
    const { resources } = await readHostResources(deps, undefined, new Date(1_000));
    expect(resources.apps).toEqual({
      state: 'unread',
      why: '这台没有 /cg/cgroup.controllers（不是 cgroup v2，或不是 Linux）',
    });
  });

  test('【故意造出读不到】一个单元的 memory.current 认不出：这个应用 unread 带文件名，别的照常', async () => {
    const { resources } = await readHostResources(
      machine(1, { '/cg/system.slice/a.service/memory.current': '乱码' }),
      undefined,
      new Date(1_000),
    );
    if (resources.apps?.state !== 'ok') throw new Error('整段不该没读到');
    const api = resources.apps.items[0];
    expect(api?.usage.state).toBe('unread');
    expect(api?.usage.state === 'unread' && api.usage.why).toContain(
      '/cg/system.slice/a.service/memory.current',
    );
    expect(resources.apps.items[1]?.usage.state).toBe('ok');
  });

  test('【故意造出读到 0】单元的 cgroup 在、memory.current 是 0：不算在跑，idle 带原因；同一应用里真在跑的照算', async () => {
    const { resources } = await readHostResources(
      machine(1, {
        '/cg/system.slice/a.service/memory.current': '0\n',
        '/cg/system.slice/c.service/memory.current': '0\n',
      }),
      undefined,
      new Date(1_000),
    );
    if (resources.apps?.state !== 'ok') throw new Error('整段不该没读到');
    const [api, two] = resources.apps.items;
    expect(api?.usage.state).toBe('idle');
    expect(api?.usage.state === 'idle' && api.usage.why).toContain('memory.current 是 0');
    // b 真在跑照写；c 读到 0 不算进 running、不加上限
    expect(two?.usage).toEqual({ state: 'ok', running: 1, memoryMb: 100, memoryMaxMb: 512 });
  });

  test('登记表里的补充带到页面：diskNote、external', async () => {
    const deps = {
      ...machine(1),
      apps: [{ ...APPS[0], external: true } as VpsApp],
    };
    const { resources } = await readHostResources(deps, undefined, new Date(1_000));
    expect(resources.apps?.state === 'ok' && resources.apps.items[0]).toMatchObject({
      external: true,
      diskNote: 'x',
    });
  });
});

describe('兜底：system.slice 下没登记的在跑服务（#3457）', () => {
  const APPS: VpsApp[] = [
    {
      id: 'api',
      name: '驾驶舱',
      place: '/srv/x',
      units: [{ name: 'a.service', cgroup: 'system.slice/a.service' }],
      dirs: [],
      diskNote: 'x',
    },
    {
      id: 'pg',
      name: '数据库',
      place: '/srv/pg',
      units: [
        {
          name: 'postgresql@16-main.service',
          cgroup: 'system.slice/system-postgresql.slice/postgresql@16-main.service',
        },
      ],
      dirs: [],
      diskNote: 'x',
    },
  ];
  const MB = 1024 * 1024;
  const unitFiles = (rel: string, mb: number, usec: number) => ({
    [`/cg/${rel}/memory.current`]: String(mb * MB),
    [`/cg/${rel}/memory.max`]: 'max\n',
    [`/cg/${rel}/cpu.stat`]: `usage_usec ${usec}\n`,
  });
  const machine = (
    usec: number,
    files: Record<string, string> = {},
    dirs: Record<string, string[]> = {},
  ) => ({
    ...fakeMachine(
      {
        '/cg/cgroup.controllers': 'cpu memory\n',
        ...unitFiles('system.slice/a.service', 100, usec),
        ...unitFiles('system.slice/system-postgresql.slice/postgresql@16-main.service', 300, usec),
        // 没登记的：一个在 system.slice 下，一个是模板实例在 system-foo.slice 下
        ...unitFiles('system.slice/newcomer.service', 20, usec),
        ...unitFiles('system.slice/system-worker.slice/worker@1.service', 7, usec),
        // 系统自带的（含模板实例）
        ...unitFiles('system.slice/ssh.service', 5, usec),
        ...unitFiles('system.slice/system-getty.slice/getty@tty1.service', 1, usec),
        // cgroup 在、里面没进程
        ...unitFiles('system.slice/ghost.service', 0, usec),
        ...files,
      },
      {
        '/cg/system.slice': [
          'a.service',
          'newcomer.service',
          'ssh.service',
          'ghost.service',
          'system-postgresql.slice',
          'system-worker.slice',
          'system-getty.slice',
          'cgroup.procs',
          'run-x.scope',
        ],
        '/cg/system.slice/system-postgresql.slice': ['postgresql@16-main.service'],
        '/cg/system.slice/system-worker.slice': ['worker@1.service'],
        '/cg/system.slice/system-getty.slice': ['getty@tty1.service'],
        ...dirs,
      },
    ),
    apps: APPS,
  });

  test('没登记的在跑服务各出一项（含子层里的模板实例）：给 CPU、内存、「没登记目录」；登记的、系统自带的、memory.current 为 0 的不出', async () => {
    const first = await readHostResources(machine(1_000_000), undefined, new Date(10_000));
    const { resources } = await readHostResources(machine(3_500_000), first.next, new Date(15_000));
    expect(HomeResourcesSchema.parse(resources)).toEqual(resources);
    if (resources.apps?.state !== 'ok') throw new Error('整段不该没读到');
    expect(resources.apps.items.map((i) => i.id)).toEqual([
      'api',
      'pg',
      'unregistered:newcomer.service',
      'unregistered:worker@1.service',
    ]);
    const [, , newcomer, worker] = resources.apps.items;
    expect(newcomer).toMatchObject({
      name: 'newcomer.service',
      units: ['newcomer.service'],
      unregistered: true,
      diskNote: '没登记目录',
      usage: { state: 'ok', running: 1, memoryMb: 20, cpuCores: 0.5 },
    });
    expect(worker?.usage).toMatchObject({ state: 'ok', memoryMb: 7, cpuCores: 0.5 });
    expect(resources.apps.items[0]?.unregistered).toBeUndefined();
    expect(resources.apps.unregisteredScanWhy).toBeUndefined();
  });

  test('没登记的服务的 memory.current 认不出：这一项 unread 带原因，不丢', async () => {
    const { resources } = await readHostResources(
      machine(1, { '/cg/system.slice/newcomer.service/memory.current': '乱码' }),
      undefined,
      new Date(1_000),
    );
    if (resources.apps?.state !== 'ok') throw new Error('整段不该没读到');
    const row = resources.apps.items.find((i) => i.id === 'unregistered:newcomer.service');
    expect(row?.usage.state).toBe('unread');
    expect(row?.usage.state === 'unread' && row.usage.why).toContain('newcomer.service/memory.current');
  });

  test('【故意造出读不到】system.slice 目录读不了（不是没有）：整段照常，unregisteredScanWhy 写原因', async () => {
    const deps = machine(1);
    const { resources } = await readHostResources(
      {
        ...deps,
        async readDir(path) {
          if (path === '/cg/system.slice') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          return deps.readDir(path);
        },
      },
      undefined,
      new Date(1_000),
    );
    if (resources.apps?.state !== 'ok') throw new Error('整段不该没读到');
    expect(resources.apps.unregisteredScanWhy).toContain('/cg/system.slice 没读成');
    expect(resources.apps.items.map((i) => i.id)).toEqual(['api', 'pg']);
  });

  test('没登记的定时器（/etc/systemd/system/*.timer）出一行定时任务；登记的、同名 .service 登记的、系统自带的不出', async () => {
    const deps = machine(
      1,
      {},
      {
        '/etc/systemd/system': [
          'newjob.timer',
          'a.timer', // 同名 a.service 登记了
          'fstrim.timer', // 系统自带
          'newjob.service',
          'multi-user.target.wants',
        ],
      },
    );
    const { resources } = await readHostResources(
      { ...deps, systemdDir: '/etc/systemd/system' },
      undefined,
      new Date(1_000),
    );
    expect(HomeResourcesSchema.parse(resources)).toEqual(resources);
    if (resources.apps?.state !== 'ok') throw new Error('整段不该没读到');
    const timers = resources.apps.items.filter((i) => i.id.endsWith('.timer'));
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({
      id: 'unregistered:newjob.timer',
      unregistered: true,
      scheduled: true,
      diskNote: '没登记目录',
      usage: { state: 'idle' },
    });
  });

  test('登记的定时任务带 scheduled；单元都没在跑时用量是 idle（不是 0）', async () => {
    const apps: VpsApp[] = [
      {
        id: 'job',
        name: 'job',
        place: '/opt/job',
        units: [
          { name: 'job.service', cgroup: 'system.slice/job.service' },
          { name: 'job.timer', cgroup: 'system.slice/job.timer' },
        ],
        dirs: ['/opt/job'],
        external: true,
        scheduled: true,
      },
    ];
    const { resources } = await readHostResources({ ...machine(1), apps }, undefined, new Date(1_000));
    if (resources.apps?.state !== 'ok') throw new Error('整段不该没读到');
    expect(resources.apps.items[0]).toMatchObject({ scheduled: true, usage: { state: 'idle' } });
  });

  test('system.slice 下一个服务都没有：不出没登记的行，也不写 scanWhy', async () => {
    const { resources } = await readHostResources(
      machine(1, {}, { '/cg/system.slice': [] }),
      undefined,
      new Date(1_000),
    );
    if (resources.apps?.state !== 'ok') throw new Error('整段不该没读到');
    expect(resources.apps.unregisteredScanWhy).toBeUndefined();
  });
});
