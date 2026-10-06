// @vitest-environment happy-dom
// 法国总览页（#618 第 1 版）：引擎、在用版本、健康、最近拉单 4 格 + 定时任务表。
// 做完的标准：① 每一项读不到就写「没查成 + 原因」，不拿 0 或假 ok 顶；② 故意造一项失败，那一格变虚线灰框，别的格照常；
// ③ 定时任务有失败亮红、没查全亮黄（判法照 schedules 页）。
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse, Jobs } from '../api/types';
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
    // 定时任务表里那一行
    expect(await screen.findByText('额度读取')).toBeTruthy();
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
    const row = (await screen.findByText('巡检')).closest('tr');
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
