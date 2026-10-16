// @vitest-environment happy-dom
// 项目卡：四个仓各一张，本周上线 / 在跑 / 卡住 / 里程碑都写出来；有问题的排前面。
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { createMockApi } from '../../api/mock/server';
import { ProjectCards } from './project-cards';
import type { HomeProject } from './types';

afterEach(cleanup);

function project(over: Partial<HomeProject> & Pick<HomeProject, 'id' | 'repo'>): HomeProject {
  return {
    shippedThisWeek: 0,
    running: 0,
    stuck: 0,
    decisions: 0,
    milestone: { state: 'none' },
    ...over,
  };
}

const FOUR: HomeProject[] = [
  project({
    id: 'site',
    repo: 'acme/website',
    shippedThisWeek: 1,
    running: 1,
    milestone: { state: 'ok', title: '首页改版', done: 1, total: 3 },
  }),
  project({
    id: 'canary',
    repo: 'acme/orbit-canary',
    shippedThisWeek: 0,
    milestone: { state: 'ok', title: '巡检', done: 1, total: 1 },
  }),
  project({
    id: 'flux',
    repo: 'acme/fluxwatch',
    decisions: 1,
    milestone: { state: 'none' },
  }),
  project({
    id: 'orbit',
    repo: 'acme/orbit',
    shippedThisWeek: null,
    running: 4,
    stuck: 3,
    decisions: 3,
    milestone: { state: 'ok', title: '登录和订单', done: 4, total: 9 },
  }),
];

function order(): string[] {
  return [...document.querySelectorAll('[data-project]')].map((el) => el.getAttribute('data-project') ?? '');
}

test('四个仓各一张：本周上线、在跑、卡住、里程碑都在；读不到的上线写没记', () => {
  render(<ProjectCards projects={FOUR} />);
  expect(order()).toHaveLength(4);
  const orbit = document.querySelector('[data-project="acme/orbit"]');
  expect(orbit?.textContent).toContain('本周上线');
  expect(orbit?.textContent).toContain('没记');
  expect(orbit?.textContent).toContain('在跑');
  expect(orbit?.textContent).toContain('4 张');
  expect(orbit?.textContent).toContain('卡住');
  expect(orbit?.textContent).toContain('3 张');
  expect(orbit?.textContent).toContain('里程碑');
  expect(orbit?.textContent).toContain('登录和订单 4/9');
  const flux = document.querySelector('[data-project="acme/fluxwatch"]');
  expect(flux?.textContent).toContain('没有');
  expect(document.querySelector('[data-project="acme/website"]')?.textContent).toContain('1 版');
  expect(document.querySelector('[data-project="acme/orbit-canary"]')?.textContent).toContain('0 版');
});

test('有问题的排前面：卡住的最先，只有要拍的其次', () => {
  render(<ProjectCards projects={FOUR} />);
  expect(order()).toEqual(['acme/orbit', 'acme/fluxwatch', 'acme/orbit-canary', 'acme/website']);
  expect(document.querySelector('[data-project="acme/orbit"]')?.getAttribute('data-problem')).toBe('yes');
  expect(document.querySelector('[data-project="acme/website"]')?.getAttribute('data-problem')).toBe('no');
});

test('假数据里的四个仓各渲染一张，有问题的在前', async () => {
  const home = await createMockApi({ live: false }).home();
  expect(home.projects?.map((p) => p.repo).sort()).toEqual([
    'acme/fluxwatch',
    'acme/orbit',
    'acme/orbit-canary',
    'acme/website',
  ]);
  render(<ProjectCards projects={home.projects} />);
  expect(order()).toHaveLength(4);
  const shown = order();
  expect(shown.indexOf('acme/orbit')).toBeLessThan(shown.indexOf('acme/website'));
  expect(shown.indexOf('acme/fluxwatch')).toBeLessThan(shown.indexOf('acme/orbit-canary'));
  expect(shown[0]).toBe('acme/orbit');
  for (const repo of shown) {
    const card = document.querySelector(`[data-project="${repo}"]`);
    expect(card?.textContent).toContain('本周上线');
    expect(card?.textContent).toContain('在跑');
    expect(card?.textContent).toContain('卡住');
    expect(card?.textContent).toContain('里程碑');
  }
});

test('老后端没给项目：写没给，不画成还没有项目', () => {
  render(<ProjectCards projects={undefined} />);
  expect(document.querySelector('[data-project-cards="missing"]')?.textContent).toContain('项目这一块没给');
  expect(document.body.textContent).not.toContain('还没有项目');
});
