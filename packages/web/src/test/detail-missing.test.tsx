// @vitest-environment happy-dom
// 详情页读不到（#1221，照 #1220 单子详情的修法）。QueryClient 的 retry 设成 1（和 root.tsx 一样），
// 才能看出「404 不重试」是查询自己关的，不是测试外壳关的。
// 哪些路由是详情、哪些有毛病，写在 routes/detail-page-pr-body.ts 的 PR 正文里，不写在这里。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, type FleetApi, keys } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { NodeDetail, Nodes } from '../api/types';
import { DETAIL_PAGE_PR_BODY } from '../routes/detail-page-pr-body';
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

/** 从 PR 正文的一条「- `路由` …」里取出路由。 */
function routeOf(line: string): string {
  const m = /^- `([^`]+)`/.exec(line);
  if (!m?.[1]) throw new Error(`清单这条认不出路由：${line}`);
  return m[1];
}

describe('PR 正文里的详情页路由清单', () => {
  test('逐个列出 routes.ts 里的路由，并标出哪些有推送跳骨架和 404 重试', () => {
    const src = readFileSync(join(process.cwd(), 'packages/web/src/routes.ts'), 'utf8');
    const declared = [...src.matchAll(/route\(\s*'([^']+)'/g)].flatMap((m) => {
      const path = m[1];
      return path === undefined ? [] : [path === '*' ? '*' : `/${path}`];
    });
    expect(declared.length).toBeGreaterThan(10);
    expect(src).toContain("index('routes/home.tsx')");

    expect(DETAIL_PAGE_PR_BODY.startsWith('**做了什么**：')).toBe(true);
    const bullets = DETAIL_PAGE_PR_BODY.split('\n').filter((l) => l.startsWith('- `'));
    const routes = bullets.map(routeOf);
    for (const path of ['/', ...declared]) {
      expect(routes, path).toContain(path);
    }
    expect(routes).toContain('/?node=<编号>');
    expect(routes).toContain('/nodes/:id');

    const buggy: string[] = [];
    const clean: string[] = [];
    for (const line of bullets) {
      const has = line.includes('有毛病') && !line.includes('没有这个毛病');
      const none = line.includes('没有这个毛病');
      expect(has !== none, line).toBe(true);
      (has ? buggy : clean).push(routeOf(line));
    }
    expect(buggy).toEqual(['/?node=<编号>', '/tasks/:taskId', '/env']);
    expect(clean).toContain('/nodes/:id');
    expect(DETAIL_PAGE_PR_BODY).toContain('**需求**：#1221');
    expect(DETAIL_PAGE_PR_BODY).not.toMatch(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#/i);
  });
});
