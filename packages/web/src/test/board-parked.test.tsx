// @vitest-environment happy-dom
// 停下等人的单在看板上怎么读（#3279）：不按停在哪一段分，单独一组「停下等你」；最近一笔做坏了的停下标签和红色对得上。
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { BoardTree } from '../components/home/board/board-tree';
import { statusTextOf, toneOf } from '../components/home/running-card';
import type { HomeRunning } from '../components/home/types';
import { renderApp } from './harness';

afterEach(cleanup);

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

describe('手机上看板列表的分组', () => {
  test('复现 #3279：停在验收的停下等人的单进「停下等你」组，验收组只剩真在等验的', () => {
    renderApp(<BoardTree running={[base, parked, redParked]} flow={[]} />);
    const lanes = [...document.querySelectorAll<HTMLElement>('li[data-flow-lane]')].map(
      (li) => li.dataset.flowLane,
    );
    expect(lanes).toContain('parked');
    // 三段在前，「停下等你」排在三段之后
    expect(lanes.indexOf('parked')).toBeGreaterThan(lanes.indexOf('verify'));
    const verify = document.querySelector('li[data-flow-lane="verify"]');
    const group = document.querySelector('li[data-flow-lane="parked"]');
    expect(verify?.textContent).toContain('1 张在途');
    expect(group?.textContent).toContain('停下等你');
    expect(group?.textContent).toContain('2 张在途');
  });

  test('【故意造出的失败】对照：没有停下等人的单就不出这一组', () => {
    renderApp(<BoardTree running={[base]} flow={[]} />);
    expect(document.querySelector('li[data-flow-lane="parked"]')).toBeNull();
    expect(document.body.textContent).not.toContain('停下等你');
  });
});

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
