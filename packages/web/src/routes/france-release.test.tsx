// @vitest-environment happy-dom
// /france 页发版一键卡（#618）：release-train 状态（在走 / 暂停 / 没在走 / 没查成）+ 「发版预检」按钮。
// 做完的标准：① 每种状态各画各的、读不到写明原因；② 预检按钮点下后 show 命令、退出码、stdout / stderr，
//   退出码 0 标绿、非 0 标红；③ 预检请求起不来（网络挂）写明没发出去；④ unreadable 写明没接上，不拿「没在走」顶。
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse, FrancePreflightResponse, FranceReleaseState, Jobs } from '../api/types';
import France from '../routes/france';
import { renderApp } from '../test/harness';

afterEach(cleanup);

function envOk(): EnvResponse {
  const fact = <T,>(value: T) => ({ ok: true as const, value });
  return {
    name: { name: '法国' },
    asOf: '2026-10-05T02:00:00.000Z',
    facts: {
      engine: fact({ state: 'on' }),
      version: fact({ current: 'abcdef1234567890', behind: 3, detail: '在用 abcdef123456', problems: [] }),
      sessions: fact({ total: 0, byStage: {} }),
      pools: fact({ count: 0, running: 0, unread: 0, stale: 0 }),
      health: fact({ ok: true, total: 0, failing: [], notWired: [] }),
      schedule: fact({ status: 'fresh', lastSuccessAt: '2026-10-05T01:55:00.000Z', outcome: 'ok' }),
    },
  };
}

function jobsEmpty(): Jobs {
  return { asOf: '2026-10-05T02:00:00.000Z', jobs: [] };
}

interface PreflightCall {
  release: FranceReleaseState;
  preflight: FrancePreflightResponse | { error: Error };
}

function apiWith({ release, preflight }: PreflightCall): MockApi {
  const inner = createMockApi({ live: false });
  return {
    ...inner,
    env: () => Promise.resolve(envOk()),
    jobs: () => Promise.resolve(jobsEmpty()),
    franceReleaseState: () => Promise.resolve(release),
    francePreflight:
      'error' in preflight ? () => Promise.reject(preflight.error) : () => Promise.resolve(preflight),
  } as MockApi;
}

function renderWith(call: PreflightCall) {
  return renderApp(<France />, {
    api: apiWith(call) as unknown as FleetApi,
    route: '/france',
  });
}

function donePreflight(
  overrides: Partial<Extract<FrancePreflightResponse, { state: 'done' }>> = {},
): FrancePreflightResponse {
  return {
    state: 'done',
    command: 'pnpm release:onekey preflight',
    code: 0,
    signal: null,
    stdout: '—— 预检摘要 ——\n主线 CI：绿\n预检过了',
    stderr: '',
    durationMs: 1800,
    timedOut: false,
    truncated: false,
    asOf: '2026-10-05T02:00:03.000Z',
    ...overrides,
  };
}

const idleRelease: FranceReleaseState = { state: 'idle', asOf: '2026-10-05T02:00:00.000Z' };

describe('/france 页发版一键卡', () => {
  test('没在走 + 点「发版预检」预检过了：状态写没在走、结果块命令照写、退出码 0 那行绿', async () => {
    renderWith({ release: idleRelease, preflight: donePreflight() });
    // Panel 标题和 Read 标签都叫「发版一键」，至少一个出现即可
    expect((await screen.findAllByText('发版一键')).length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText('没在走')).toBeTruthy();
    const btn = await screen.findByRole('button', { name: '发版预检' });
    fireEvent.click(btn);
    expect(await screen.findByText('预检过了')).toBeTruthy();
    // 命令原样 show，让人看到跑的是哪一条
    expect(await screen.findByText('pnpm release:onekey preflight')).toBeTruthy();
    // stdout 内容（release-train 自己的话）也进结果块
    expect(await screen.findByText(/主线 CI：绿/)).toBeTruthy();
  });

  test('在走 + 走到第 4 步「发版」：写明 phase、target、暂停标记', async () => {
    renderWith({
      release: {
        state: 'running',
        phase: '第 4 步「发版」',
        target: '提交 abcdef123456',
        marker: true,
        asOf: '2026-10-05T02:00:00.000Z',
      },
      preflight: donePreflight(),
    });
    expect(await screen.findByText('在走')).toBeTruthy();
    expect(await screen.findByText(/第 4 步「发版」/)).toBeTruthy();
    expect(await screen.findByText(/提交 abcdef123456/)).toBeTruthy();
    expect(await screen.findByText(/派活已暂停/)).toBeTruthy();
  });

  test('孤儿暂停标记：state=paused 写「暂停标记没人收」+ 提示用 abort 收掉', async () => {
    renderWith({
      release: { state: 'paused', asOf: '2026-10-05T02:00:00.000Z' },
      preflight: donePreflight(),
    });
    expect(await screen.findByText('暂停标记没人收')).toBeTruthy();
    expect(await screen.findByText(/pnpm release:onekey abort/)).toBeTruthy();
  });

  test('读不到状态：写「没查成 + 原因」，不拿「没在走」顶', async () => {
    renderWith({
      release: {
        state: 'unreadable',
        why: '这台后端没接上 release-train 状态文件的读取（开发、内存版）',
        asOf: '2026-10-05T02:00:00.000Z',
      },
      preflight: donePreflight(),
    });
    expect(await screen.findByText('没查成')).toBeTruthy();
    expect(await screen.findByText(/没接上 release-train 状态文件的读取/)).toBeTruthy();
  });

  test('预检没过（退出码 2）：标红、原因行进 stderr 块', async () => {
    renderWith({
      release: idleRelease,
      preflight: donePreflight({
        code: 2,
        stdout: '—— 预检摘要 ——\n主线 CI：绿',
        stderr: '第 0 步「预检」没成：主线 CI 红（fleet-dao #1107 挂着）',
      }),
    });
    expect(await screen.findByText('没在走')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '发版预检' }));
    expect(await screen.findByText(/预检没过/)).toBeTruthy();
    expect(await screen.findByText(/主线 CI 红（fleet-dao #1107 挂着）/)).toBeTruthy();
    expect(await screen.findByText(/退出码 2/)).toBeTruthy();
  });

  test('预检起进程都没起来（unreadable）：写明「没查成 + 原因」，不拿「预检过了」顶', async () => {
    renderWith({
      release: idleRelease,
      preflight: {
        state: 'unreadable',
        why: '这台后端没接上 release:onekey 的执行（开发、内存版）；到法国那台的驾驶舱开才有这颗按钮',
        asOf: '2026-10-05T02:00:00.000Z',
      },
    });
    expect(await screen.findByText('没在走')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '发版预检' }));
    expect(await screen.findByText(/没接上 release:onekey 的执行/)).toBeTruthy();
  });

  test('预检请求没发出去（网络挂）：写明没发出去', async () => {
    renderWith({
      release: idleRelease,
      preflight: { error: new Error('网络断了（测试故意造的）') },
    });
    expect(await screen.findByText('没在走')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '发版预检' }));
    expect(await screen.findByText(/预检请求没发出去/)).toBeTruthy();
    expect(await screen.findByText(/网络断了（测试故意造的）/)).toBeTruthy();
  });
});
