// @vitest-environment happy-dom
// /france 页发版一键卡（#618）：release-train 状态（在走 / 暂停 / 没在走 / 没查成）+ 「发版预检」按钮。
// 做完的标准：① 每种状态各画各的、读不到写明原因；② 预检点下后写「进程内读事实」、退出码、一项一行，
//   退出码 0 标「能发」、非 0 标「不能发」；③ 预检请求起不来（网络挂）写明没发出去；④ unreadable 写明没接上；
//   ⑤ 连点「发版预检」只发一次。
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { FleetApi } from '../api/client';
import { createMockApi, type MockApi } from '../api/mock/server';
import type { EnvResponse, FrancePreflightResponse, FranceReleaseState, Jobs } from '../api/types';
import France from '../routes/france';
import { renderApp } from '../test/harness';
import { installStageTrace } from '../test/stage-trace';

afterEach(cleanup);
// 只加观测，超时和断言都不动：测试卡住时日志里要能读到时间花在了哪一步（#3372）。
// 未结责任（#3372）：首次完整 CI 红灯（run 39358167914 / job 118417833091）只记了「本文件首个用例超过 5000ms」
//   （当时的 :90 就是首个用例，含整个文件的冷启动：首次加载页面代码、首次渲染），那一次还没装阶段记录，
//   超时落在首个用例里的哪一个 findBy、是渲染、异步等待还是整进程没排上 CPU，没有证据，至今没查明，
//   这里也没有声称修好。下次在 CI 再红，先读 stderr 里的「[阶段记录·快超时]」那一行，再回 #3372 接着查。
installStageTrace();

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

/**
 * 发版一键卡用不到的读取收成「只有本台」：假后端默认带一台远程环境「本机 WSL」，页面会再读它的快照、多画一整列对照，
 * 和发版卡无关。这只是减少无关渲染的工作量，不是首次 CI 红灯的已证实根因：
 * 本机 1 核加压复现里这些多出的渲染约占本文件三成耗时，没有 CI 那次运行的阶段数据可对照（#3372 未结）。
 */
function baseApi(): MockApi {
  const inner = createMockApi({ live: false });
  return {
    ...inner,
    env: () => Promise.resolve(envOk()),
    nodes: () => Promise.resolve({ self: { name: '法国', engine: { state: 'on' } }, nodes: [] }),
    jobs: () => Promise.resolve(jobsEmpty()),
  } as MockApi;
}

function apiWith({ release, preflight }: PreflightCall): MockApi {
  return {
    ...baseApi(),
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
    command: '进程内读事实',
    code: 0,
    signal: null,
    stdout: '主线头和 CI：通过 提交 abcdef123456「刷新耗时表」，CI 绿',
    stderr: '',
    durationMs: 1800,
    timedOut: false,
    truncated: false,
    asOf: '2026-10-05T02:00:03.000Z',
    ...overrides,
  };
}

const idleRelease: FranceReleaseState = { state: 'idle', asOf: '2026-10-05T02:00:00.000Z' };

/** 一个能等到本轮测试手动放行的 Promise（预检还没回来）。 */
function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('/france 页发版一键卡', () => {
  test('没在走 + 点「发版预检」能发：状态写没在走、写进程内读事实、退出码 0 标能发', async () => {
    renderWith({ release: idleRelease, preflight: donePreflight() });
    // Panel 标题和 Read 标签都叫「发版一键」，至少一个出现即可
    expect((await screen.findAllByText('发版一键')).length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText('没在走')).toBeTruthy();
    expect(await screen.findByText(/真发版点上面「在用版本」里的「发布到法国」/)).toBeTruthy();
    const btn = await screen.findByRole('button', { name: '发版预检' });
    fireEvent.click(btn);
    expect(await screen.findByText('能发')).toBeTruthy();
    expect(await screen.findByText('进程内读事实')).toBeTruthy();
    expect(await screen.findByText(/用了 1\.8 秒/)).toBeTruthy();
    expect(await screen.findByText(/主线头和 CI：通过/)).toBeTruthy();
  });

  test('在走 + 走到第 4 步「发版」：写明 phase、target、暂停标记', async () => {
    renderWith({
      release: {
        state: 'running',
        status: 'running',
        why: null,
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

  test('孤儿暂停标记：state=paused 写「暂停标记没人收」，并说明真发版点「发布到法国」', async () => {
    renderWith({
      release: { state: 'paused', asOf: '2026-10-05T02:00:00.000Z' },
      preflight: donePreflight(),
    });
    expect(await screen.findByText('暂停标记没人收')).toBeTruthy();
    expect(await screen.findByText(/暂停标记在、但一趟的记录不在/)).toBeTruthy();
    expect(await screen.findByText(/真发版点上面「在用版本」里的「发布到法国」/)).toBeTruthy();
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
    expect(await screen.findByText(/没接上 release-train 状态文件的读取/)).toBeTruthy();
    const panel = screen.getByRole('heading', { name: '发版一键' }).closest('section');
    if (!(panel instanceof HTMLElement)) throw new Error('找不到发版一键');
    expect(within(panel).getByText('没查成')).toBeTruthy();
  });

  test('不能发（退出码 2）：标不能发，卡住写在那一行；另有报错时进报错块', async () => {
    renderWith({
      release: idleRelease,
      preflight: donePreflight({
        code: 2,
        stdout: '主线头和 CI：卡住 提交 abcdef123456「刷新耗时表」，CI 红：fleet-dao #1107 挂着',
        stderr: '读的时候旁边还有一句',
      }),
    });
    expect(await screen.findByText('没在走')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '发版预检' }));
    expect(await screen.findByText('不能发')).toBeTruthy();
    expect(await screen.findByText(/不能发，看下面哪一项卡住或读不到/)).toBeTruthy();
    expect(await screen.findByText(/CI 红：fleet-dao #1107 挂着/)).toBeTruthy();
    expect(await screen.findByText(/退出码 2/)).toBeTruthy();
    expect(await screen.findByText('报错：')).toBeTruthy();
    expect(await screen.findByText('读的时候旁边还有一句')).toBeTruthy();
  });

  test('预检没接上（unreadable）：写明「没查成 + 原因」，不拿「能发」顶', async () => {
    renderWith({
      release: idleRelease,
      preflight: {
        state: 'unreadable',
        why: '这台后端没接上发版预检（开发、内存版）；到法国那台的驾驶舱开才有这颗按钮',
        asOf: '2026-10-05T02:00:00.000Z',
      },
    });
    expect(await screen.findByText('没在走')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '发版预检' }));
    expect(await screen.findByText(/没接上发版预检/)).toBeTruthy();
    expect(screen.queryByText('能发')).toBeNull();
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

  test('连点「发版预检」只发一次：同一帧两下、忙着再点，francePreflight 只被调一次', async () => {
    const d = deferred<FrancePreflightResponse>();
    const calls: number[] = [];
    const api = {
      ...baseApi(),
      franceReleaseState: () => Promise.resolve(idleRelease),
      francePreflight: () => {
        calls.push(1);
        return d.promise;
      },
    } as unknown as MockApi;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    const btn = await screen.findByRole('button', { name: '发版预检' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(btn);
    expect(calls).toHaveLength(1);
    await act(async () => {
      d.resolve(donePreflight());
    });
    expect(await screen.findByText('能发')).toBeTruthy();
  });

  // 只锁夹具的形状，防以后改回默认远程环境又多画一整列；它不复现、也不证明首次 CI 超时的原因（#3372 未结）。
  test('夹具只画本台：不带进假后端默认的远程环境，不读它的快照、不画对照列', async () => {
    const snapshotReads: string[] = [];
    const base = baseApi();
    const api = {
      ...base,
      node: (id: string) => {
        snapshotReads.push(id);
        return base.node(id);
      },
      franceReleaseState: () => Promise.resolve(idleRelease),
    } as MockApi;
    renderApp(<France />, { api: api as unknown as FleetApi, route: '/france' });
    expect(await screen.findByText('没在走')).toBeTruthy();
    expect(document.querySelector('[data-env-columns]')).toBeNull();
    expect(screen.queryByText(/本机 WSL/)).toBeNull();
    expect(snapshotReads).toEqual([]);
  });
});
