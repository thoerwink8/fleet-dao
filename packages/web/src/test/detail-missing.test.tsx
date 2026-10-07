// @vitest-environment happy-dom
// 详情页读不到（#1221，照 #1220 单子详情的修法）。QueryClient 的 retry 设成 1（和 root.tsx 一样），
// 才能看出「404 不重试」是查询自己关的，不是测试外壳关的。
//
// 路由逐个看过（routes.ts）。详情 = 按编号读一个东西，404 就是没有这个：
// - /tasks/:taskId 单子详情：#1220 已修（404 不重试、记住失败）。这次只把记住失败抽到 lib/shown-error.ts，行为不变。
// - /?node=<编号> 主页上看一个远程环境。接口是 GET /api/nodes/:nodeId，驾驶舱没有 /nodes/:id 这条路由。有毛病，下面修。
// - /env 里收到过快照的远程列，读的是同一个接口。有毛病，下面修。
// 不是详情（整页一份列表或单例，没有「没有这个……」）：
// / 本台主页、/quota、/schedules、/notifications、/audit、/settings、/demo-links、/changelog、
// /routing、/routing/status（?p= 是在已经读到的列表里挑一个渠道，不是另读一个会 404 的编号）、
// /efforts、/france、/login、/models、/billing、/record、/judge（占位，soon.tsx）、* 找不到页。
// /env 的本台列是 GET /api/env，不是按编号。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, type FleetApi, keys } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { NodeDetail, Nodes } from '../api/types';
import Env from '../routes/env';
import Home from '../routes/home';
import { renderApp } from './harness';

afterEach(cleanup);

const skeleton = () => document.querySelector('[aria-busy]');

function open(ui: ReactElement, route: string, api: FleetApi) {
  return renderApp(ui, { route, api, retry: 1 });
}

/** 环境列表里放一个收到过快照的远程环境，详情读口换成传入的。 */
function apiWithNode(node: (id: string) => Promise<NodeDetail>): FleetApi {
  const inner = createMockApi({ live: false });
  return {
    ...inner,
    nodes: async (): Promise<Nodes> => {
      const base = await inner.nodes();
      return {
        ...base,
        nodes: [
          {
            id: 'ghost',
            name: '幽灵环境',
            freshness: 'stale',
            receivedAt: '2026-10-07T00:00:00.000Z',
            reportedAt: '2026-10-07T00:00:00.000Z',
          },
        ],
      };
    },
    node,
  };
}

describe('主页上看一个远程环境（/?node=）', () => {
  test('【故意造出的失败】没有这个环境（404）：写「没有这个环境」和编号、给回主页；不重试；实时推送叫去重读也不跳回骨架', async () => {
    const inner = createMockApi({ live: false });
    let calls = 0;
    const api: FleetApi = {
      ...inner,
      node: async () => {
        calls += 1;
        throw new ApiError(404, 'node_not_found', '没有这个环境');
      },
    };
    const { qc } = open(<Home />, '/?node=ghost', api);
    expect(await screen.findByText('没有这个环境')).toBeTruthy();
    expect(screen.getByText('ghost')).toBeTruthy();
    expect(within(screen.getByRole('alert')).getByRole('link', { name: '回主页' }).getAttribute('href')).toBe(
      '/',
    );
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(calls).toBe(1);
    expect(skeleton()).toBeNull();

    void qc.invalidateQueries({ queryKey: keys.node('ghost') });
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByText('没有这个环境')).toBeTruthy();
    expect(skeleton()).toBeNull();
  });

  test('【故意造出的失败】读不到（后端 500）：写原因和「重试」，不转圈；点重试、这回读成了就照常显示', async () => {
    const inner = createMockApi({ live: false });
    let broken = true;
    let calls = 0;
    const api: FleetApi = {
      ...inner,
      node: async () => {
        calls += 1;
        if (broken) throw new ApiError(500, 'internal', '库连不上');
        return inner.node('wsl');
      },
    };
    open(<Home />, '/?node=ghost', api);
    expect(await screen.findByText(/这个环境没读成：库连不上/)).toBeTruthy();
    expect(calls).toBe(2);
    expect(skeleton()).toBeNull();
    expect(screen.queryByText('没有这个环境')).toBeNull();
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('heading', { name: '要你拍的' })).toBeTruthy();
    expect(screen.queryByText(/这个环境没读成/)).toBeNull();
  });
});

describe('环境页的远程列', () => {
  test('【故意造出的失败】没有这个环境（404）：这一列写「没有这个环境」和编号、给回主页；不重试；推送重读也不跳回骨架', async () => {
    let calls = 0;
    const api = apiWithNode(async () => {
      calls += 1;
      throw new ApiError(404, 'node_not_found', '没有这个环境');
    });
    const { qc } = open(<Env />, '/env', api);
    expect(await screen.findByText('没有这个环境')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: /假数据/ })).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('ghost');
    expect(within(alert).getByRole('link', { name: '回主页' }).getAttribute('href')).toBe('/');
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(calls).toBe(1);
    expect(skeleton()).toBeNull();

    void qc.invalidateQueries({ queryKey: keys.node('ghost') });
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByText('没有这个环境')).toBeTruthy();
    expect(skeleton()).toBeNull();
  });

  test('【故意造出的失败】快照读不到（后端 500）：写原因和「重试」；点重试、这回读成了这一列照常显示', async () => {
    const inner = createMockApi({ live: false });
    let broken = true;
    let calls = 0;
    const api = apiWithNode(async (id) => {
      calls += 1;
      if (broken) throw new ApiError(500, 'internal', '库连不上');
      const detail = await inner.node('wsl');
      return { ...detail, id, name: '幽灵环境' };
    });
    open(<Env />, '/env', api);
    expect(await screen.findByText(/幽灵环境的快照没读成：库连不上/)).toBeTruthy();
    expect(calls).toBe(2);
    expect(skeleton()).toBeNull();
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    const column = document.querySelector('[data-env-column="ghost"]') as HTMLElement;
    expect(await within(column).findByText('引擎')).toBeTruthy();
    // 快照事实里本身有「没读成 0」这种计数，只认这次失败的那句。
    expect(screen.queryByText(/幽灵环境的快照没读成/)).toBeNull();
  });
});
