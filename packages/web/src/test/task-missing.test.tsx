// @vitest-environment happy-dom
// 单子详情打开不存在的编号（D 路发现：/tasks/t-1 一直停在加载骨架）：后端 404 写「没有这张单」和回主页的路，不重试、不转圈；
// 实时推送叫去重读时也不跳回骨架。读不到（网络、500）写原因和「重试」，点了重读、读成了就照常显示。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, type FleetApi, keys } from '../api/client';
import { createMockApi } from '../api/mock/server';
import TaskPage from '../routes/task';
import { renderApp } from './harness';

afterEach(cleanup);

function open(route: string, api: FleetApi) {
  return renderApp(
    <Routes>
      <Route path="/tasks/:taskId" element={<TaskPage />} />
    </Routes>,
    { route, api },
  );
}

// 加载骨架是带 aria-busy 的块。刷新按钮空闲也写 aria-busy="false"，忙时是按钮上的 "true"，都不算退回骨架。
const skeleton = () => document.querySelector('[aria-busy="true"]:not(button)');

describe('单子详情读不到', () => {
  test('【故意造出的失败】没有这张单（404）：写「没有这张单」和编号、给回主页；不重试；实时推送叫去重读也不跳回骨架', async () => {
    const inner = createMockApi({ live: false });
    let calls = 0;
    const api: FleetApi = {
      ...inner,
      task: async () => {
        calls += 1;
        throw new ApiError(404, 'task_not_found', '没有这个任务');
      },
    };
    const { qc } = open('/tasks/t-1', api);
    expect(await screen.findByText('没有这张单')).toBeTruthy();
    expect(screen.getByText('t-1')).toBeTruthy();
    // 正文里就有回主页的路（标题右边那个之外），是这一屏最显眼的下一步
    expect(within(screen.getByRole('alert')).getByRole('link', { name: '回主页' }).getAttribute('href')).toBe(
      '/',
    );
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(calls).toBe(1);

    // 推送来了（和 tasks 表一变就重读一样）：重读那一下也照样写「没有这张单」，不退回加载骨架
    void qc.invalidateQueries({ queryKey: keys.task('t-1') });
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByText('没有这张单')).toBeTruthy();
    expect(skeleton()).toBeNull();
  });

  test('【故意造出的失败】读不到（后端 500）：写原因和「重试」，不转圈；点重试、这回读成了就照常显示', async () => {
    const inner = createMockApi({ live: false });
    let broken = true;
    const api: FleetApi = {
      ...inner,
      task: async (id) => {
        if (broken) throw new ApiError(500, 'internal', '库连不上');
        return inner.task(id);
      },
    };
    open('/tasks/t-c9', api);
    expect(await screen.findByText(/这张单没读成：库连不上/, undefined, { timeout: 4000 })).toBeTruthy();
    expect(skeleton()).toBeNull();
    expect(screen.queryByText('没有这张单')).toBeNull();
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('heading', { level: 1, name: /README/ })).toBeTruthy();
    expect(screen.queryByText(/没读成/)).toBeNull();
  });
});
