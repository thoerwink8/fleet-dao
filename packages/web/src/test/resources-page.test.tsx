// @vitest-environment happy-dom
// 资源页（#1986）整页：假后端给什么画什么——三段都在；某个应用没在跑写「没在占用」；目录读不全写「不全」；
// 磁盘读不到写「没读到」；老后端没有磁盘、上线项目、按目录的占用时写明没给。任何地方都不拿 0 顶。
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { HomeResponse } from '../api/types';
import type { HomeResources } from '../components/home/types';
import { isRemotePage } from '../components/node-notice';
import ResourcesPage from '../routes/resources';
import { renderApp } from './harness';

afterEach(cleanup);

const GIB = 1024 ** 3;

const BASE: HomeResources = {
  at: new Date().toISOString(),
  everyMs: 5_000,
  memory: { state: 'ok', totalMb: 12_000, availableMb: 6_000 },
  cpu: { state: 'ok', percent: 20, busyCores: 1.2, cores: 6 },
  sessions: { state: 'ok', byRun: {} },
};

const FULL: HomeResources = {
  ...BASE,
  disk: { state: 'ok', path: '/', totalBytes: 200 * GIB, usedBytes: 60 * GIB, availableBytes: 130 * GIB },
  apps: {
    state: 'ok',
    items: [
      {
        id: 'cockpit',
        name: '驾驶舱',
        place: '/srv/fleet-dao-releases/current（后端代码）',
        units: ['fleet-api.service'],
        diskNote: '代码在发布版本目录里',
        usage: { state: 'ok', running: 1, memoryMb: 220, cpuCores: 0.1 },
      },
      {
        id: 'release',
        name: '自动发布',
        place: '/usr/local/lib/fleet-dao',
        units: ['fleet-auto-release.service'],
        usage: { state: 'idle' },
      },
      {
        id: 'sessions',
        name: 'AI 会话',
        place: '/var/lib/fleet-work（工作树）',
        units: ['fleet-agents.slice'],
        usage: { state: 'ok', running: 1, memoryMb: 900, cpuCores: 0.5 },
      },
      {
        id: 'unregistered:newcomer.service',
        name: 'newcomer.service',
        place: 'system.slice/newcomer.service',
        units: ['newcomer.service'],
        unregistered: true,
        diskNote: '没登记目录',
        usage: { state: 'ok', running: 1, memoryMb: 38, cpuCores: 0.01 },
      },
    ],
  },
  footprint: {
    state: 'ok',
    measuredAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    everyMs: 600_000,
    tookMs: 9_000,
    dirs: [
      {
        path: '/usr/local/lib/fleet-dao',
        appId: 'release',
        size: { state: 'ok', bytes: 3 * GIB, unreadTrees: 0 },
      },
      {
        path: '/var/lib/fleet-work',
        appId: 'sessions',
        size: { state: 'ok', bytes: 1 * GIB, unreadTrees: 4 },
      },
    ],
    databases: { state: 'unread', why: '这台后端没连数据库' },
  },
};

function withResources(resources: HomeResources | undefined) {
  const api = createMockApi({ live: false });
  const home = api.home.bind(api);
  api.home = async (): Promise<HomeResponse> => {
    const h = await home();
    const { resources: _drop, ...rest } = h;
    return resources ? { ...rest, resources } : rest;
  };
  return api;
}

const text = (sel: string) => document.querySelector(sel)?.textContent ?? '';
/** 上线项目表里一个项目那一行的字（行是 <tr>，标记在第一格里）。 */
const appRow = (id: string) => document.querySelector(`[data-app="${id}"]`)?.closest('tr')?.textContent ?? '';
/** 点开一个项目那一行的展开键。 */
const expandApp = (id: string) => {
  const button = document.querySelector(`[data-app="${id}"]`)?.closest('tr')?.querySelector('button');
  if (!button) throw new Error(`找不到 ${id} 的展开键`);
  fireEvent.click(button);
};

test('三段都在：整机三格、每个项目一行、没有按目录的占用榜', async () => {
  renderApp(<ResourcesPage />, { api: withResources(FULL) });
  await waitFor(() => expect(document.querySelector('[data-resources-host]')).toBeTruthy());
  expect(text('[data-gauge="disk"]')).toContain('60.0G');
  expect(text('[data-gauge="disk"]')).toContain('/ 200.0G');
  expect(text('[data-gauge="disk"]')).toContain('30%');
  // 整机三格只写「已用 / 总量」和一根条：「可用 / 剩余」那一句删了（样稿减法）
  expect(text('[data-gauge="disk"]')).not.toContain('剩余');
  expect(appRow('cockpit')).toContain('驾驶舱');
  expect(appRow('cockpit')).toContain('/srv/fleet-dao-releases/current');
  expect(appRow('cockpit')).toContain('220M');
  // 没在跑：写没在占用，不写 0
  expect(appRow('release')).toContain('没在占用');
  expect(appRow('release')).not.toMatch(/\b0(\.0)? 核|\b0M/);
  // 目录读不全：写不全，数前面带 ≥
  expect(appRow('sessions')).toContain('≥ 1.0G');
  expect(appRow('sessions')).toContain('不全');
  // 没登记的服务：标「没登记」、行里不写源码路径（展开才写怎么登记）、有 CPU 内存
  expect(appRow('unregistered:newcomer.service')).toContain('没登记');
  expect(appRow('unregistered:newcomer.service')).toContain('展开看怎么登记');
  expect(appRow('unregistered:newcomer.service')).not.toContain('packages/api/src/vps-apps.ts');
  expect(appRow('unregistered:newcomer.service')).toContain('38M');
  expandApp('unregistered:newcomer.service');
  expect(text('[data-app-detail="unregistered:newcomer.service"]')).toContain('没登记目录');
  expect(text('[data-app-detail="unregistered:newcomer.service"]')).toContain('packages/api/src/vps-apps.ts');
  // 按目录的占用榜收掉了（创始人 2026-10-13）：页上没有这一段
  expect(document.querySelector('[data-resources-board]')).toBeNull();
  // 点开一行看全文（手机上没有悬停）
  expandApp('sessions');
  expect(text('[data-app-detail="sessions"]')).toContain('fleet-agents.slice');
  expect(text('[data-app-detail="sessions"]')).toContain('有 4 棵树没读到');
});

test('【故意造出的读不到】磁盘、上线项目都读不到：写没读到带原因，不写 0', async () => {
  renderApp(<ResourcesPage />, {
    api: withResources({
      ...FULL,
      disk: { state: 'unread', why: '/ 的 statfs 没读成：EACCES' },
      apps: { state: 'unread', why: '这台没有 /sys/fs/cgroup/cgroup.controllers' },
    }),
  });
  await waitFor(() => expect(document.querySelector('[data-resources-host]')).toBeTruthy());
  expect(text('[data-gauge="disk"]')).toContain('没读到');
  expect(text('[data-gauge="disk"]')).toContain('/ 的 statfs 没读成：EACCES');
  expect(text('[data-gauge="disk"]')).not.toContain('0%');
  expect(text('[data-resources-apps-missing]')).toBe('没读到：这台没有 /sys/fs/cgroup/cgroup.controllers');
});

test('老后端：没有磁盘、上线项目、按目录的占用，写明后端没给', async () => {
  renderApp(<ResourcesPage />, { api: withResources(BASE) });
  await waitFor(() => expect(document.querySelector('[data-resources-host]')).toBeTruthy());
  expect(text('[data-gauge="disk"]')).toContain('后端没给磁盘读数');
  expect(text('[data-resources-apps-missing]')).toContain('后端没给每个上线项目的占用');
  expect(document.querySelector('[data-resources-board-missing]')).toBeNull();
});

test('整块没有资源读数：写明这台后端没给', async () => {
  renderApp(<ResourcesPage />, { api: withResources(undefined) });
  await waitFor(() => expect(document.querySelector('[data-resources-missing]')).toBeTruthy());
  expect(text('[data-resources-missing]')).toBe('这台后端没给资源读数');
});

test('选了远程环境时资源页照样渲染（外壳不换成「只看得了本台」）：首页小卡带 ?node= 跳过来不落空', () => {
  expect(isRemotePage('/resources')).toBe(true);
});
