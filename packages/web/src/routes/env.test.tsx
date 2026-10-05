// @vitest-environment happy-dom
// 环境页（#820 片 1）：这一台环境现在怎样，一项一个「查成了 / 没查成 + 原因」。
// 做完的标准（方案 §5 片 1）：一项读失败时那一项显示「没查成 + 原因」、别的项不受影响；引擎按配置关着显示「按配置没开」不是红。
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse } from '../api/types';
import Env from '../routes/env';
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
  return { ...inner, env: () => Promise.resolve(data) } as MockApi;
}

function renderEnv(data: EnvResponse) {
  return renderApp(<Env />, { api: apiWith(data) as unknown as FleetApi, route: '/env' });
}

/** 找一格的成败。 */
const tile = (name: string) => within(screen.getByText(name).closest('[data-env-fact]') as HTMLElement);

describe('环境页', () => {
  test('标题是这一台的名字；六格都在；引擎开着写「在跑」', async () => {
    renderEnv(envData());
    expect(await screen.findByRole('heading', { name: /法国/ })).toBeTruthy();
    for (const label of ['引擎', '在用版本', '在跑的会话', '池占用', '健康', '最近拉单']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(tile('引擎').getByText('在跑')).toBeTruthy();
    // 名读不到时也照实写，不猜成某一台
    cleanup();
    renderEnv(
      envData({}, { name: '认不出', problem: '这台后端没配环境名（api.env 的 FLEET_MACHINE_NAME）' }),
    );
    expect(await screen.findByRole('heading', { name: /认不出/ })).toBeTruthy();
    expect(screen.getByText(/FLEET_MACHINE_NAME/)).toBeTruthy();
  });

  test('引擎按配置关着写「按配置没开」，用等待色，不是红', async () => {
    renderEnv(envData({ engine: { ok: true, value: { state: 'off', detail: '按 FLEET_SERVICES 没开' } } }));
    const value = (await screen.findByText('按配置没开')) as HTMLElement;
    expect(value.className).toContain('text-ink-stall');
    expect(value.className).not.toContain('text-ink-fail');
    // 引擎没连上（down）才用红：两者分开
    cleanup();
    renderEnv(envData({ engine: { ok: true, value: { state: 'down', detail: '探不到在线的工人' } } }));
    const down = (await screen.findByText('没连上')) as HTMLElement;
    expect(down.className).toContain('text-ink-fail');
  });

  test('故意造出失败：某一项没查成时那一格写「没查成 + 原因」，别的格照常显示数', async () => {
    renderEnv(
      envData({
        sessions: { ok: false, reason: '读在跑的会话没成：库连不上（测试故意造的）' },
        health: { ok: true, value: { ok: false, total: 9, failing: ['temporal', 'engine'], notWired: [] } },
      }),
    );
    // 会话那一格：没查成 + 原因，不拿 0 顶
    expect(await screen.findByText('没查成')).toBeTruthy();
    expect(screen.getByText(/读在跑的会话没成：库连不上（测试故意造的）/)).toBeTruthy();
    expect(screen.queryByText('2')).toBeNull();
    // 别的格不受影响：引擎照常在跑、池占用照常给数
    expect(tile('引擎').getByText('在跑')).toBeTruthy();
    expect(tile('池占用').getByText('3 块')).toBeTruthy();
    // 健康那格：真红了就说红，用红字（这是「真坏了」，和按配置关着分开）
    expect(screen.getByText('2 项红')).toBeTruthy();
    expect(screen.getByText(/红：temporal、engine/)).toBeTruthy();
  });

  test('版本读不到（非法国正式机器）：那一格写「没查成 + 原因」，不拿 0 冒充', async () => {
    renderEnv(envData({ version: { ok: false, reason: '只在法国的正式机器上查' } }));
    expect(await screen.findByText('只在法国的正式机器上查')).toBeTruthy();
  });
});
