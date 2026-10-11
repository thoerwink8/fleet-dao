// @vitest-environment happy-dom
// 法国总览页（#618 第 1 版）：引擎、在用版本、健康、最近拉单 4 格 + 定时任务表。
// 做完的标准：① 每一项读不到就写「没查成 + 原因」，不拿 0 或假 ok 顶；② 故意造一项失败，那一格变虚线灰框，别的格照常；
// ③ 定时任务有失败亮红、没查全亮黄（判法照 schedules 页）。
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse, Jobs, Setting } from '../api/types';
import { HealthStrip } from '../components/home/health-strip';
import France from '../routes/france';
import { renderApp } from '../test/harness';

afterEach(cleanup);

function envData(overrides: Partial<EnvResponse['facts']> = {}): EnvResponse {
  return {
    name: { name: '法国' },
    asOf: '2026-10-05T02:00:00.000Z',
    facts: {
      engine: {
        ok: true,
        value: { state: 'on', detail: '探到了在拉活的工人' },
      },
      master: {
        ok: true,
        value: {
          on: true,
          why: 'set',
          by: 'user:frank',
          at: '2026-10-05T01:00:00.000Z',
          detail: '开着：引擎在接活',
        },
      },
      version: {
        ok: true,
        value: {
          current: 'abcdef1234567890',
          behind: 3,
          detail: '在用 abcdef123456，落后主线 3 个提交',
          problems: [],
        },
      },
      sessions: {
        ok: true,
        value: { total: 2, byStage: { execute: 1, verify: 1 } },
      },
      pools: { ok: true, value: { count: 3, running: 1, unread: 0, stale: 1 } },
      health: {
        ok: true,
        value: { ok: true, total: 9, failing: [], notWired: ['deploy_lag'] },
      },
      schedule: {
        ok: true,
        value: {
          status: 'fresh',
          lastSuccessAt: '2026-10-05T01:55:00.000Z',
          outcome: 'ok',
          scanned: 4,
        },
      },
      ...overrides,
    },
  };
}

function jobsData(overrides: Partial<Jobs['jobs'][number]>[] = []): Jobs {
  const base: Jobs['jobs'][number] = {
    id: 'quota',
    name: '额度读取',
    schedule: '*/5 * * * *',
    expectEveryMinutes: 10,
    status: 'fresh',
    lastSuccessAt: '2026-10-05T01:58:00.000Z',
    lastRun: {
      startedAt: '2026-10-05T01:58:00.000Z',
      endedAt: '2026-10-05T01:58:10.000Z',
      outcome: 'ok',
      scanned: 12,
    },
  };
  return {
    asOf: '2026-10-05T02:00:00.000Z',
    jobs:
      overrides.length === 0
        ? [base]
        : overrides.map((o, i) => ({
            ...base,
            id: `job-${i}`,
            name: `任务-${i}`,
            ...o,
          })),
  };
}

function apiWith(envD: EnvResponse, jobsD?: Jobs | { error: Error }): MockApi {
  const inner = createMockApi({ live: false });
  return {
    ...inner,
    env: () => Promise.resolve(envD),
    // 这些用例看的是只有一台：不画对照列。两台并排的在下面另写。
    nodes: async () => ({ ...(await inner.nodes()), nodes: [] }),
    jobs:
      jobsD && 'error' in jobsD
        ? () => Promise.reject(jobsD.error)
        : () => Promise.resolve(jobsD ?? jobsData()),
  } as MockApi;
}

function renderFrance(envD: EnvResponse, jobsD?: Jobs | { error: Error }) {
  return renderApp(<France />, {
    api: apiWith(envD, jobsD) as unknown as FleetApi,
    route: '/france',
  });
}

const tile = (name: string) => within(screen.getByText(name).closest('[data-france-fact]') as HTMLElement);

describe('法国总览页', () => {
  test('四格 + 定时任务表都在：引擎在跑、落后主线写明、健康没红的、最近拉单', async () => {
    renderFrance(envData(), jobsData());
    for (const label of ['引擎', '在用版本', '健康', '最近拉单']) {
      expect(await screen.findByText(label)).toBeTruthy();
    }
    // 页面上多处提到「定时任务」（顶栏摘要、Panel 标题、页尾说明、链接），断言至少有一个
    expect((await screen.findAllByText('定时任务')).length).toBeGreaterThanOrEqual(1);
    expect(tile('引擎').getByText('在跑')).toBeTruthy();
    expect(tile('在用版本').getAllByText(/abcdef123456/).length).toBeGreaterThanOrEqual(1);
    expect(tile('在用版本').getAllByText(/落后主线 3 个提交/).length).toBeGreaterThanOrEqual(1);
    expect(tile('健康').getByText('没红的')).toBeTruthy();
    // 定时任务列表里那一行
    expect(await screen.findByText('额度读取')).toBeTruthy();
  });

  test('定时任务是可展开的列表行：默认收起，点一行展开明细，再点收起（#1805）', async () => {
    renderFrance(envData(), jobsData());
    const row = (await screen.findByText('额度读取')).closest('li') as HTMLElement;
    const toggle = within(row).getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(row.querySelector('dl')).toBeNull();
    expect(document.querySelector('[data-job-list] table')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(row.querySelector('dl')?.textContent).toContain('周期');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('故意造版本一项读不到：那一格写「没查成 + 原因」，别的格照常显示数，不拿 0 冒充', async () => {
    renderFrance(
      envData({
        version: { ok: false, reason: '假后端没有发布目录，读不到在用版本' },
      }),
      jobsData(),
    );
    expect(await screen.findByText('假后端没有发布目录，读不到在用版本')).toBeTruthy();
    // 那一格的「没查成」字样（虚线灰框里）
    expect(tile('在用版本').getByText('没查成')).toBeTruthy();
    // 别的格不受影响
    expect(tile('引擎').getByText('在跑')).toBeTruthy();
    expect(tile('健康').getByText('没红的')).toBeTruthy();
  });

  test('引擎按配置没开用等待色、不是红；真 down 才红', async () => {
    renderFrance(
      envData({
        engine: {
          ok: true,
          value: { state: 'off', detail: '按 FLEET_SERVICES 没开' },
        },
      }),
      jobsData(),
    );
    const off = (await screen.findByText('按配置没开')) as HTMLElement;
    expect(off.className).toContain('text-ink-stall');
    expect(off.className).not.toContain('text-ink-fail');
    cleanup();
    renderFrance(
      envData({
        engine: {
          ok: true,
          value: { state: 'down', detail: '探不到在线的工人' },
        },
      }),
      jobsData(),
    );
    const down = (await screen.findByText('没连上')) as HTMLElement;
    expect(down.className).toContain('text-ink-fail');
  });

  test('定时任务里有一个失败的：那一行带 fail 的行 tone，结局红字', async () => {
    renderFrance(
      envData(),
      jobsData([
        {
          id: 'patrol',
          name: '巡检',
          lastRun: {
            startedAt: '2026-10-05T01:40:00.000Z',
            endedAt: '2026-10-05T01:41:00.000Z',
            outcome: 'failed',
          },
          lastSuccessAt: '2026-10-05T00:40:00.000Z',
          status: 'fresh',
        },
      ]),
    );
    const row = (await screen.findByText('巡检')).closest('li');
    expect(row?.dataset.outcome).toBe('failed');
  });

  test('故意造定时任务接口读不到：表里写「没读成 + 原因」，别的格照常显示', async () => {
    renderFrance(envData(), {
      error: new Error('拉 /api/jobs 没成（测试故意造的）'),
    });
    expect(await screen.findByText(/拉 \/api\/jobs 没成（测试故意造的）/)).toBeTruthy();
    // 四格照常显示
    expect(tile('引擎').getByText('在跑')).toBeTruthy();
    expect(tile('健康').getByText('没红的')).toBeTruthy();
  });
});

describe('法国页：一台不画对照列，两台并排', () => {
  test('只有一台：六项是卡片，不画对照列；总开关、定时任务、发版都在这一页', async () => {
    renderFrance(envData(), jobsData());
    expect(await screen.findByRole('heading', { name: '法国' })).toBeTruthy();
    expect(screen.getByTestId('engine-master')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /定时任务/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '发版' })).toBeTruthy();
    // 标题和总开关一渲染就在；六格要等本台数据和环境列表都回来，回来之前不画对照列。
    await screen.findByText('引擎');
    expect(document.querySelector('[data-env-columns]')).toBeNull();
    expect(document.querySelectorAll('[data-env-column]').length).toBe(0);
    expect(document.querySelectorAll('[data-france-fact]').length).toBe(6);
  });

  test('两台时并排：本台和远程各一列，六格都在，不画成单台卡片', async () => {
    const inner = createMockApi({ live: false });
    const api = {
      ...inner,
      env: () => Promise.resolve(envData()),
      nodes: async () => ({
        ...(await inner.nodes()),
        nodes: [
          {
            id: 'wsl',
            name: '本机 WSL',
            freshness: 'fresh' as const,
            receivedAt: new Date().toISOString(),
            reportedAt: new Date().toISOString(),
          },
        ],
      }),
      jobs: () => Promise.resolve(jobsData()),
    } as MockApi;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    await screen.findByRole('heading', { name: /本机 WSL/ });
    const cols = document.querySelectorAll('[data-env-column]');
    expect(Array.from(cols).map((c) => c.getAttribute('data-env-column'))).toEqual(['local', 'wsl']);
    expect(document.querySelector('[data-env-columns]')?.getAttribute('data-env-columns')).toBe('2');
    expect(document.querySelector('[data-france-fact]')).toBeNull();
    for (const col of cols) {
      for (const label of ['引擎', '在用版本', '在跑的会话', '池占用', '健康', '最近拉单']) {
        expect(within(col as HTMLElement).getByText(label)).toBeTruthy();
      }
    }
  });

  test('【故意造出的失败】两台并排时远程快照没读成：那一列写原因、不画空格子，本台六格照常', async () => {
    const inner = createMockApi({ live: false });
    const api = {
      ...inner,
      env: () => Promise.resolve(envData()),
      nodes: async () => ({
        ...(await inner.nodes()),
        nodes: [
          {
            id: 'wsl',
            name: '本机 WSL',
            freshness: 'fresh' as const,
            receivedAt: new Date().toISOString(),
            reportedAt: new Date().toISOString(),
          },
        ],
      }),
      node: async () => {
        throw new Error('快照读不了（测试故意造的）');
      },
      jobs: () => Promise.resolve(jobsData()),
    } as MockApi;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const wsl = (await screen.findByRole('heading', { name: /本机 WSL/ })).closest(
      '[data-env-column]',
    ) as HTMLElement;
    expect(await within(wsl).findByText(/快照读不了（测试故意造的）/)).toBeTruthy();
    expect(wsl.querySelector('[data-env-fact]')).toBeNull();
    const local = document.querySelector('[data-env-column="local"]') as HTMLElement;
    expect(within(local).getByText('在跑')).toBeTruthy();
    expect(local.querySelectorAll('[data-env-fact]').length).toBe(6);
  });
});

describe('失联与在用版本小标题', () => {
  test('失联环境整块置灰且不显示大号在跑', async () => {
    const inner = createMockApi({ live: false });
    const t = Date.now();
    const ago = 4 * 24 * 60 * 60_000 + 6 * 60 * 60_000;
    const snapFacts = envData({
      engine: { ok: true, value: { state: 'on', detail: '探到了在拉活的工人' } },
      health: {
        ok: true,
        value: { ok: false, total: 9, failing: ['routes', 'deploy_lag'], notWired: [] },
      },
    }).facts;
    const api = {
      ...inner,
      env: () => Promise.resolve(envData()),
      nodes: async () => ({
        ...(await inner.nodes()),
        nodes: [
          {
            id: 'wsl',
            name: '本机',
            freshness: 'stale' as const,
            receivedAt: new Date(t - ago).toISOString(),
            reportedAt: new Date(t - ago - 1000).toISOString(),
          },
        ],
      }),
      node: async () => {
        const detail = await inner.node('wsl');
        return {
          ...detail,
          id: 'wsl',
          name: '本机',
          freshness: 'stale' as const,
          receivedAt: new Date(t - ago).toISOString(),
          reportedAt: new Date(t - ago - 1000).toISOString(),
          env: {
            ...detail.env,
            name: { name: '本机' },
            asOf: new Date(t - ago).toISOString(),
            facts: snapFacts,
          },
        };
      },
      jobs: () => Promise.resolve(jobsData()),
    } as unknown as MockApi;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const col = (await screen.findByRole('heading', { name: /本机/ })).closest(
      '[data-env-column]',
    ) as HTMLElement;
    expect(col.getAttribute('data-env-column-state')).toBe('stale');
    expect(col.className).toMatch(/opacity|muted|grayscale/);
    expect(col.textContent).toContain('失联，以下是旧数据');
    const running = within(col).getByText('在跑');
    expect(running.className).not.toContain('text-title');
    expect(running.className).not.toContain('text-ink-done');
    expect(running.className).toMatch(/text-muted|text-sm|text-xs/);
    const red = within(col).getByText('2 项红');
    expect(red.className).not.toContain('text-title');
    expect(red.className).not.toContain('text-ink-fail');
  });

  test('在用版本小标题为落后主线几个提交', async () => {
    renderFrance(envData(), jobsData());
    await screen.findByText('在用版本');
    expect(tile('在用版本').getByText(/落后主线几个提交/)).toBeTruthy();
    expect(tile('在用版本').queryByText(/落后主线没有/)).toBeNull();
  });
});

describe('总开关和引擎进程是两件事', () => {
  test('总开关关、引擎在跑：开关和「在跑」那一格旁边都写明不派活、进程还在；健康条的名字含「引擎进程」', async () => {
    const inner = apiWith(
      envData({
        engine: { ok: true, value: { state: 'on', detail: '探到了在拉活的工人' } },
        master: {
          ok: true,
          value: { on: false, why: 'set', detail: '关着：不拉单、不派活' },
        },
      }),
      jobsData(),
    );
    const off: Setting = {
      key: 'engine.master',
      value: false,
      version: 2,
      updatedAt: '2026-10-05T01:00:00.000Z',
      updatedBy: 'user:frank',
    };
    const api = {
      ...inner,
      settings: async () => {
        const base = await inner.settings();
        return { settings: [...base.settings.filter((s) => s.key !== 'engine.master'), off] };
      },
    } as MockApi;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const sentence = /总开关关着只是不派活，引擎进程还在跑/;
    const card = await screen.findByTestId('engine-master');
    expect(await within(card).findByText(sentence)).toBeTruthy();
    await screen.findByText('在跑');
    expect(tile('引擎').getByText(sentence)).toBeTruthy();

    cleanup();
    renderApp(
      <HealthStrip
        health={{
          quota: { state: 'ok', detail: '够用' },
          routes: { state: 'ok', detail: '都通' },
          engine: { state: 'on' },
        }}
      />,
    );
    expect(screen.getByRole('status', { name: '持续状态' }).textContent).toContain('引擎进程');
  });
});
