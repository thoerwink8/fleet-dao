// 资源页「仓库」一节的写法（#1993）：每仓磁盘 = 镜像 + 树，量不了写下限和原因；树的状态照引擎判的写；
// 故意造出的失败：清单没出过、认不出、整轮没跑成，三种分开写，都不画成 0 棵树；会话读不到写没读到，不写 0。
import { describe, expect, it } from 'vitest';
import type { Worktrees } from '../../api/types';
import type { HomeResources, HomeRunning } from '../home/types';
import { cleanupWord, repoRows } from './repos';

const MIB = 1024 ** 2;
const T = '2026-10-13T08:00:00.000Z';

function inv(over: Partial<NonNullable<Worktrees['inventory']>> = {}): Worktrees {
  return {
    inventory: {
      takenAt: T,
      trigger: 'hourly',
      root: '/var/lib/fleet-work',
      trees: [
        {
          repo: 'acme/orbit',
          tree: '12-a',
          what: '需求 #12 的主树',
          issueNumber: 12,
          state: 'leftover',
          why: '有没推的提交：2 个',
          lastSessionAt: T,
          size: { state: 'ok', bytes: 300 * MIB },
        },
        {
          repo: 'acme/orbit',
          tree: '17-b',
          what: '需求 #17 的主树',
          issueNumber: 17,
          state: 'running',
          why: '任务工作流在跑',
          size: { state: 'unread', why: 'du 超时' },
        },
      ],
      removed: [],
      repos: [
        { repo: 'acme/orbit', mirror: { state: 'ok', bytes: 100 * MIB } },
        { repo: 'acme/site', mirror: { state: 'unread', why: '还没有镜像' } },
      ],
      unchecked: [],
      ...over,
    },
    cleanups: [],
    unreadable: 0,
  };
}

const resources: HomeResources = {
  at: T,
  everyMs: 5000,
  memory: { state: 'ok', totalMb: 8000, availableMb: 4000 },
  cpu: { state: 'ok', percent: 10, busyCores: 0.4, cores: 4 },
  sessions: { state: 'ok', byRun: { r1: { state: 'ok', memoryMb: 700, memoryPeakMb: 900, cpuPercent: 50 } } },
};
const running = [{ repo: 'acme/orbit', runIds: ['r1'] }] as unknown as HomeRunning[];

describe('每仓一行', () => {
  it('磁盘 = 镜像 + 量得到的树；有树量不了写「不全」和哪棵、为什么；会话按仓合计', () => {
    const r = repoRows(inv(), resources, running);
    if (r.kind !== 'ok') throw new Error(r.kind);
    const orbit = r.rows.find((x) => x.repo === 'acme/orbit');
    expect(orbit?.disk).toEqual({
      kind: 'ok',
      text: '400M',
      bytes: 400 * MIB,
      incomplete: '不全：树 17-b：du 超时',
    });
    expect(orbit?.memory).toEqual({ kind: 'ok', text: '700M' });
    expect(orbit?.cpu).toEqual({ kind: 'ok', text: '0.5 核' });
    expect(orbit?.sessions).toBe(1);
    expect(orbit?.trees.map((t) => [t.tree, t.label, t.tone])).toEqual([
      ['12-a', '有改动', 'stall'],
      ['17-b', '任务在用', 'run'],
    ]);
    expect(orbit?.held).toBe(1);
  });

  it('【故意造出的失败】一样都没量成：写没量到和原因，不写 0；没会话写「没在占用」，不写 0M', () => {
    const r = repoRows(inv(), resources, running);
    if (r.kind !== 'ok') throw new Error(r.kind);
    const site = r.rows.find((x) => x.repo === 'acme/site');
    expect(site?.disk).toEqual({ kind: 'unread', why: '镜像：还没有镜像' });
    expect(site?.memory.kind).toBe('idle');
    expect(site?.trees).toEqual([]);
  });

  it('【故意造出的失败】会话读数读不到：内存、CPU 写没读到和原因', () => {
    const r = repoRows(inv(), { ...resources, sessions: { state: 'unread', why: 'cgroup 读不了' } }, running);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.rows[0]?.memory).toEqual({ kind: 'unread', why: 'cgroup 读不了' });
  });

  it('按磁盘从大到小，量不到的压后', () => {
    const r = repoRows(inv(), resources, running);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.rows.map((x) => x.repo)).toEqual(['acme/orbit', 'acme/site']);
  });
});

describe('清单不可用的三种', () => {
  it('【故意造出的失败】引擎还没出过：none，不是 0 棵树', () => {
    expect(repoRows({ inventory: null, cleanups: [], unreadable: 0 }, resources, running)).toMatchObject({
      kind: 'none',
    });
  });
  it('【故意造出的失败】库里那份认不出：unread 带原因', () => {
    expect(
      repoRows({ inventory: null, inventoryWhy: '认不出', cleanups: [], unreadable: 0 }, resources, running),
    ).toEqual({ kind: 'unread', why: '认不出' });
  });
  it('【故意造出的失败】整轮没跑成：failed，树不列（不可信），镜像照算', () => {
    const r = repoRows(inv({ failed: '根读不了：EACCES' }), resources, running);
    expect(r.kind).toBe('failed');
    if (r.kind !== 'failed') return;
    expect(r.why).toBe('根读不了：EACCES');
    expect(r.rows.find((x) => x.repo === 'acme/orbit')?.trees).toEqual([]);
    expect(r.rows.find((x) => x.repo === 'acme/orbit')?.disk).toMatchObject({ kind: 'ok', bytes: 100 * MIB });
  });
});

describe('清理走到哪', () => {
  it('五种状态各有字和色', () => {
    const base = { requestId: 'x', by: 'u', requestedAt: T };
    expect(cleanupWord({ ...base, status: 'queued' })).toEqual({ label: '排队中', tone: 'wait' });
    expect(cleanupWord({ ...base, status: 'failed', error: 'x' }).tone).toBe('fail');
  });
});
