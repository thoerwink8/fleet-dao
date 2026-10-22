// 停下等人的单的标签和颜色对得上（#3279）。原在 test/board-parked.test.tsx，画布删后这两条判法留在这里。
import { describe, expect, test } from 'vitest';
import { statusTextOf, toneOf } from './running-card';
import type { HomeRunning } from './types';

const base: HomeRunning = {
  issueNumber: 30,
  title: '换掉旧的登录页',
  repo: 'acme/orbit',
  segment: 'verify_pending',
  waitingReason: 'nothing',
  link: '/tasks/t-30',
  taskId: 't-30',
};

const parked: HomeRunning = {
  ...base,
  issueNumber: 31,
  link: '/tasks/t-31',
  taskId: 't-31',
  waitingReason: 'parked',
  parked: '额度超预算：这一单已用 31 万 token',
};

const redParked: HomeRunning = {
  ...parked,
  issueNumber: 32,
  link: '/tasks/t-32',
  taskId: 't-32',
  lastEvent: { text: '验收超时：30 分钟没交活', at: '2026-10-19T01:00:00.000Z', tone: 'trouble' },
};

describe('停下的标签和颜色对得上', () => {
  test('停下、最近一笔没做坏：等你色，写「停下等人」', () => {
    expect(toneOf(parked).tone).toBe('human');
    expect(statusTextOf(parked)).toBe('停下等人');
  });

  test('【故意造出的失败】停下、最近一笔超时：失败红，标签写「出问题停下」，不再写成等你色的「停下等人」', () => {
    expect(toneOf(redParked).tone).toBe('fail');
    expect(statusTextOf(redParked)).toBe('出问题停下');
  });
});
