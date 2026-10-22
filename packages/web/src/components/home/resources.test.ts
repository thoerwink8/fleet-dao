// 主页的机器资源怎么读给人看（#1973）：整机内存 / CPU 的两格、每张卡片的占用。
// 读不到一律写「没读到」带原因，不拿 0 顶；没有会话在跑的单写「没在占用」，不画 0。
import { describe, expect, test } from 'vitest';
import { formatCpuSeconds, formatMb, hostMeters, lastSessionLine, ticketUsage } from './resources.ts';
import type { HomeResources, HomeRunning } from './types.ts';

const AT = '2026-10-12T08:00:00.000Z';
const NOW = Date.parse(AT) + 2_000;

const base: HomeRunning = {
  issueNumber: 12,
  title: '登录页加手机验证码',
  repo: 'acme/web',
  segment: 'doing',
  waitingReason: 'nothing',
  link: '/tasks/t12',
};

function res(over: Partial<HomeResources> = {}): HomeResources {
  return {
    at: AT,
    everyMs: 5_000,
    memory: { state: 'ok', totalMb: 12_000, availableMb: 4_000 },
    cpu: { state: 'ok', percent: 37.6, busyCores: 1.5, cores: 4, load1: 1.4 },
    sessions: {
      state: 'ok',
      byRun: {
        r1: { state: 'ok', memoryMb: 800, memoryPeakMb: 1_200, cpuPercent: 30 },
        r2: { state: 'ok', memoryMb: 400, memoryPeakMb: 500, cpuPercent: 12.5 },
        r3: { state: 'ok', memoryMb: 100 },
        bad: { state: 'unread', why: 'cpu.stat 的内容认不出' },
      },
    },
    ...over,
  };
}

describe('每张卡片的占用', () => {
  test('一张单两个会话：按单合计（内存、CPU 相加，峰值是各会话峰值之和）', () => {
    expect(ticketUsage({ ...base, worker: 'Opus', runIds: ['r1', 'r2'] }, res())).toEqual({
      kind: 'ok',
      sessions: 2,
      memoryMb: 1_200,
      peakMb: 1_700,
      cpuPercent: 42.5,
    });
  });

  test('没有会话在跑（排队、等人、等验）：没在占用，不是 0', () => {
    expect(ticketUsage({ ...base, runIds: [] }, res())).toEqual({ kind: 'idle' });
    expect(ticketUsage({ ...base }, res())).toEqual({ kind: 'idle' });
  });

  test('没在跑、有上一次会话：写「上次动手峰值 3.5G · CPU 12 分钟」；CPU 没记写「CPU 没读到」', () => {
    const last = {
      memory: { state: 'ok' as const, peakMb: 3_584 },
      cpu: { state: 'ok' as const, seconds: 720 },
    };
    const usage = ticketUsage({ ...base, runIds: [], lastSession: last }, res());
    expect(lastSessionLine(last)).toBe('上次动手峰值 3.5G · CPU 12 分钟');
    expect(usage).toMatchObject({ kind: 'last', text: '上次动手峰值 3.5G · CPU 12 分钟' });

    const unreadCpu = {
      memory: { state: 'ok' as const, peakMb: 3_584 },
      cpu: { state: 'unread' as const, why: '上一次会话没记 CPU 秒数' },
    };
    const missed = ticketUsage({ ...base, runIds: [], lastSession: unreadCpu }, res());
    expect(missed).toMatchObject({ kind: 'last', text: '上次动手峰值 3.5G · CPU 没读到' });

    const unreadMemory = {
      memory: { state: 'unread' as const, why: '上一次会话没记内存峰值' },
      cpu: { state: 'ok' as const, seconds: 720 },
    };
    expect(lastSessionLine(unreadMemory)).toBe('上次峰值没读到 · CPU 12 分钟');
    expect(formatCpuSeconds(45)).toBe('45 秒');
    expect(formatCpuSeconds(0)).toBe('0 秒');
  });

  test('有会话在跑：写此刻的占用，不用上一次的数顶', () => {
    const usage = ticketUsage(
      {
        ...base,
        worker: 'Opus',
        runIds: ['r1'],
        lastSession: {
          memory: { state: 'ok', peakMb: 3_584 },
          cpu: { state: 'ok', seconds: 720 },
        },
      },
      res(),
    );
    expect(usage).toMatchObject({ kind: 'ok', memoryMb: 800, cpuPercent: 30 });
  });

  test('scope 刚出现、只有一次读数：CPU 算不出（不写 0），内存照写', () => {
    expect(ticketUsage({ ...base, worker: 'Opus', runIds: ['r3'] }, res())).toEqual({
      kind: 'ok',
      sessions: 1,
      memoryMb: 100,
    });
  });

  test('cgroup 读不到（整池没读成）：没读到，带原因', () => {
    const r = res({
      sessions: { state: 'unread', why: '这台没有 /sys/fs/cgroup/fleet.slice/fleet-agents.slice' },
    });
    expect(ticketUsage({ ...base, worker: 'Opus', runIds: ['r1'] }, r)).toEqual({
      kind: 'unread',
      why: '这台没有 /sys/fs/cgroup/fleet.slice/fleet-agents.slice',
    });
  });

  test('一个会话的读数认不出：整张单没读到，不拿另一个会话的数顶', () => {
    expect(ticketUsage({ ...base, worker: 'Opus', runIds: ['r1', 'bad'] }, res())).toEqual({
      kind: 'unread',
      why: 'cpu.stat 的内容认不出',
    });
  });

  test('【故意造出读到 0】会话的 scope 是空的（里面没进程）：不写 0M / 0%，按没在跑写；一张单另有真在跑的照算', () => {
    const why = 'scope 还在，但 memory.current 是 0';
    const r = res({
      sessions: {
        state: 'ok',
        byRun: { r1: { state: 'ok', memoryMb: 800, cpuPercent: 30 }, gone: { state: 'empty', why } },
      },
    });
    const empty = ticketUsage({ ...base, worker: 'Opus', runIds: ['gone'] }, r);
    expect(empty).toEqual({ kind: 'empty', why });
    expect(ticketUsage({ ...base, worker: 'Opus', runIds: ['r1', 'gone'] }, r)).toEqual({
      kind: 'ok',
      sessions: 1,
      memoryMb: 800,
      cpuPercent: 30,
    });
  });

  test('scope 不在读数里：没读到，写明是哪一笔', () => {
    const got = ticketUsage({ ...base, worker: 'Opus', runIds: ['gone-run'] }, res());
    expect(got.kind).toBe('unread');
    expect(got.kind === 'unread' && got.why).toContain('gone-run');
  });

  test('后端没给资源读数 / 那台没推过：没读到，分开说', () => {
    const item = { ...base, worker: 'Opus', runIds: ['r1'] };
    expect(ticketUsage(item, undefined)).toEqual({ kind: 'unread', why: '这台后端没给资源读数' });
    expect(ticketUsage(item, undefined, { remote: true })).toEqual({
      kind: 'unread',
      why: '那台没推过资源读数（那台的版本还没有这一项）',
    });
  });

  test('老后端没给会话编号、却有人在做：没读到，不当没在占用', () => {
    expect(ticketUsage({ ...base, worker: 'Opus' }, res()).kind).toBe('unread');
  });
});

describe('整机两格', () => {
  test('读成了：内存已用 = 总量 − 可用，CPU 取整', () => {
    const m = hostMeters(res(), NOW);
    expect(m.memory).toMatchObject({ kind: 'ok', percent: 67, tight: false, text: '67%' });
    expect(m.cpu).toMatchObject({ kind: 'ok', percent: 38, tight: false, text: '38%' });
    expect(m.stale).toBe(false);
  });

  test('具体数值：内存写「已用 / 总量」，CPU 写「忙的核数 / 总核数」，和百分比出自同一份读数', () => {
    const m = hostMeters(res(), NOW);
    // 已用 = 12000 − 4000 = 8000M = 7.8G；总量 12000M = 11.7G；67% 也是 8000 / 12000
    expect(m.memory).toMatchObject({ amount: { kind: 'ok', text: '7.8G / 11.7G' } });
    expect(m.cpu).toMatchObject({ amount: { kind: 'ok', text: '1.5 核 / 4 核' } });
  });

  test('忙的核数写一位小数，整数核也写「.0」不跳字宽；总核数是整数', () => {
    const m = hostMeters(res({ cpu: { state: 'ok', percent: 50, busyCores: 2, cores: 4 } }), NOW);
    expect(m.cpu).toMatchObject({ amount: { kind: 'ok', text: '2.0 核 / 4 核' } });
  });

  test('那台推来的老快照没有忙的核数：数值写没读到带原因，不拿百分比 × 核数编一个', () => {
    const m = hostMeters(res({ cpu: { state: 'ok', percent: 40, cores: 4 } }), NOW, { remote: true });
    expect(m.cpu).toMatchObject({ kind: 'ok', text: '40%', amount: { kind: 'unread' } });
    expect(m.cpu.kind === 'ok' && m.cpu.amount.kind === 'unread' && m.cpu.amount.why).toContain('忙的核数');
  });

  test('紧（内存 ≥ 85%、CPU ≥ 90%）：标紧，由页面画成等待黄', () => {
    const m = hostMeters(
      res({
        memory: { state: 'ok', totalMb: 10_000, availableMb: 1_000 },
        cpu: { state: 'ok', percent: 95, cores: 4 },
      }),
      NOW,
    );
    expect(m.memory).toMatchObject({ tight: true, percent: 90 });
    expect(m.cpu).toMatchObject({ tight: true, percent: 95 });
  });

  test('/proc 读不到：两格都写没读到带原因，不写 0', () => {
    const m = hostMeters(
      res({
        memory: { state: 'unread', why: '读不到 /proc/meminfo（这台不是 Linux）' },
        cpu: { state: 'unread', why: '读不到 /proc/stat（这台不是 Linux）' },
      }),
      NOW,
    );
    expect(m.memory).toEqual({ kind: 'unread', why: '读不到 /proc/meminfo（这台不是 Linux）' });
    expect(m.cpu).toEqual({ kind: 'unread', why: '读不到 /proc/stat（这台不是 Linux）' });
  });

  test('后端没给 / 那台没推过：整块写明没有', () => {
    expect(hostMeters(undefined, NOW)).toEqual({
      missing: '这台后端没给资源读数',
      memory: { kind: 'unread', why: '这台后端没给资源读数' },
      cpu: { kind: 'unread', why: '这台后端没给资源读数' },
      disk: { kind: 'unread', why: '这台后端没给资源读数' },
      stale: false,
    });
    expect(hostMeters(undefined, NOW, { remote: true }).missing).toBe(
      '那台没推过资源读数（那台的版本还没有这一项）',
    );
  });

  test('超过三个间隔没来新读数：标旧了（本台）；远程快照不按这个算', () => {
    expect(hostMeters(res(), Date.parse(AT) + 16_000).stale).toBe(true);
    expect(hostMeters(res(), Date.parse(AT) + 16_000, { remote: true }).stale).toBe(false);
  });
});

test('内存写法：三位数以内写 M，四位数起写一位小数的 G（不出现「1006M」）', () => {
  expect(formatMb(812)).toBe('812M');
  expect(formatMb(999)).toBe('999M');
  expect(formatMb(1_006)).toBe('1.0G');
  expect(formatMb(1_536)).toBe('1.5G');
  expect(formatMb(12_000)).toBe('11.7G');
});
