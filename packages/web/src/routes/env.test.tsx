// @vitest-environment happy-dom
// 法国页上的六项事实（原环境页 #820 片 1，#1217 并进来，#3533 改成运行概况）：一项一个「查成了 / 没查成 + 原因」。
// 做完的标准：一项读失败时那一项显示「没读到 + 原因」、别的项不受影响；引擎按配置关着显示「按配置没开」不是红。
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse } from '../api/types';
import France from '../routes/france';
import { renderApp } from '../test/harness';

afterEach(cleanup);

/** 一份整的环境页数据；每个用例只改它关心的那几项。 */
function envData(
  overrides: Partial<EnvResponse['facts']> = {},
  name: EnvResponse['name'] = { name: '法国' },
): EnvResponse {
  return {
    name,
    asOf: '2026-10-05T02:00:00.000Z',
    facts: {
      engine: { ok: true, value: { state: 'on', detail: '探到了在拉活的工人' } },
      master: {
        ok: true,
        value: {
          on: true,
          why: 'set',
          by: 'user:frank',
          at: '2026-10-05T01:00:00.000Z',
          detail:
            '开着（2026-10-05T01:00:00.000Z 由 user:frank 打开）：引擎在接活（只有「让 AI 接活」开着的项目才派）',
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
      sessions: { ok: true, value: { total: 2, byStage: { execute: 1, verify: 1 } } },
      pools: { ok: true, value: { count: 3, running: 1, unread: 0, stale: 1 } },
      health: { ok: true, value: { ok: true, total: 9, failing: [], notWired: ['deploy_lag'] } },
      schedule: {
        ok: true,
        value: { status: 'fresh', lastSuccessAt: '2026-10-05T01:55:00.000Z', outcome: 'ok', scanned: 4 },
      },
      ...overrides,
    },
  };
}

/** 假后端 + 只换掉 env()：页面的其余读取照常。 */
function apiWith(data: EnvResponse): MockApi {
  const inner = createMockApi({ live: false });
  // 没有远程环境（nodes 空）：这些用例看的是本台；多台的在 routes/france.test.tsx 和 test/node-switch.test.tsx
  const nodes = async () => ({ ...(await inner.nodes()), nodes: [] });
  return { ...inner, env: () => Promise.resolve(data), nodes } as MockApi;
}

function renderEnv(data: EnvResponse) {
  return renderApp(<France />, { api: apiWith(data) as unknown as FleetApi, route: '/france' });
}

/** 描述列表里一项的值（标签是 dt，值是它后面的 dd）。 */
async function factValue(label: string): Promise<HTMLElement> {
  const all = await screen.findAllByText(label);
  const dt = all.find((el) => el.tagName === 'DT');
  const dd = dt?.nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`「${label}」后面没有值`);
  return dd;
}

describe('法国页的运行概况', () => {
  test('标题是「法国」；六项都在；引擎开着写「运行中」', async () => {
    renderEnv(envData());
    expect(await screen.findByRole('heading', { name: '法国' })).toBeTruthy();
    for (const label of ['引擎进程', '在跑的会话', '池占用', '健康', '最近拉单']) {
      expect(await factValue(label)).toBeTruthy();
    }
    expect(within(await factValue('引擎进程')).getByText('运行中')).toBeTruthy();
    // 名读不到时也照实写，不猜成某一台
    cleanup();
    renderEnv(
      envData({}, { name: '认不出', problem: '这台后端没配环境名（api.env 的 FLEET_MACHINE_NAME）' }),
    );
    expect((await screen.findAllByText(/FLEET_MACHINE_NAME/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('认不出').length).toBeGreaterThanOrEqual(1);
  });

  test('引擎按配置关着写「按配置没开」，用灰点，不是红', async () => {
    renderEnv(envData({ engine: { ok: true, value: { state: 'off', detail: '按 FLEET_SERVICES 没开' } } }));
    const off = within(await factValue('引擎进程'))
      .getByText('按配置没开')
      .closest('[data-level]') as HTMLElement;
    expect(off.dataset.level).toBe('default');
    // 引擎没连上（down）才用红：两者分开
    cleanup();
    renderEnv(envData({ engine: { ok: true, value: { state: 'down', detail: '探不到在线的工人' } } }));
    const down = within(await factValue('引擎进程'))
      .getByText('没连上')
      .closest('[data-level]') as HTMLElement;
    expect(down.dataset.level).toBe('error');
  });

  test('故意造出失败：某一项没读到时那一项写「没读到 + 原因」，别的项照常显示数', async () => {
    renderEnv(
      envData({
        sessions: { ok: false, reason: '读在跑的会话没成：库连不上（测试故意造的）' },
        health: { ok: true, value: { ok: false, total: 9, failing: ['temporal', 'engine'], notWired: [] } },
      }),
    );
    // 会话那一项：没读到 + 原因，不拿 0 顶
    const sessions = await factValue('在跑的会话');
    expect(within(sessions).getByText('没读到')).toBeTruthy();
    expect(sessions.textContent).toContain('读在跑的会话没成：库连不上（测试故意造的）');
    // 别的项不受影响：引擎照常运行中、池占用照常给数
    expect(within(await factValue('引擎进程')).getByText('运行中')).toBeTruthy();
    expect((await factValue('池占用')).textContent).toContain('3 块');
    // 健康那项：真红了就说红（这是「真坏了」，和按配置关着分开）
    expect((await factValue('健康')).textContent).toContain('红：temporal、engine');
  });

  test('版本读不到（非法国正式机器）：版本卡写「没读到 + 原因」，不拿 0 冒充', async () => {
    renderEnv(envData({ version: { ok: false, reason: '只在法国的正式机器上查' } }));
    expect(await screen.findByText('只在法国的正式机器上查')).toBeTruthy();
  });
});
