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
    expect(resources.cpu).toEqual({ state: 'ok', percent: 30, cores: 2, load1: 1.25 });
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
});
