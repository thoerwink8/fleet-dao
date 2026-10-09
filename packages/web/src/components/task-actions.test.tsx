// @vitest-environment happy-dom
// 任务页顶上的暂停、继续、叫停（#1496）：按状态能点或置灰；已完成、已失败一个都不画。
// 置灰的按钮悬停要写明为什么。地址是纯数字时，「没有这张单」要多写一句单号和任务编号的区别。
import { cleanup, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import TaskPage from '../routes/task';
import { renderApp } from '../test/harness';
import { ActionButtons, type ActionTarget } from './task-actions';

afterEach(cleanup);

const base: ActionTarget = {
  taskId: 't-12',
  issueNumber: 12,
  title: '登录页加手机验证码',
  state: 'running',
};

const labels = () => [...document.querySelectorAll('[data-task-actions] button')].map((b) => b.textContent);

describe('任务页操作按钮按状态', () => {
  test('在跑且没暂停：暂停、叫停能点；继续置灰，悬停写明还没暂停', () => {
    renderApp(<ActionButtons target={base} />);
    expect(labels()).toEqual(['暂停', '继续', '叫停']);
    const resume = screen.getByRole('button', { name: '继续' });
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    expect(resume.getAttribute('title')).toBe('还没暂停，没有可继续的');
    expect((screen.getByRole('button', { name: '暂停' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '叫停' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('已暂停：继续、叫停能点；暂停置灰，悬停写明已经暂停', () => {
    renderApp(<ActionButtons target={{ ...base, paused: '已暂停：被人暂停（frank）' }} />);
    expect(labels()).toEqual(['暂停', '继续', '叫停']);
    const pause = screen.getByRole('button', { name: '暂停' });
    expect((pause as HTMLButtonElement).disabled).toBe(true);
    expect(pause.getAttribute('title')).toBe('已经暂停了，点「继续」接着走');
    expect((screen.getByRole('button', { name: '继续' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '叫停' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('已完成、已失败：不画任何按钮', () => {
    for (const state of ['done', 'failed'] as const) {
      const view = renderApp(<ActionButtons target={{ ...base, state }} />);
      expect(view.container.querySelector('[data-task-actions]'), state).toBeNull();
      expect(view.container.querySelector('button'), state).toBeNull();
      view.unmount();
    }
  });
});

describe('没有这张单：纯数字地址像 GitHub 单号', () => {
  function open(route: string) {
    const inner = createMockApi({ live: false });
    const api: FleetApi = {
      ...inner,
      task: async () => {
        throw new ApiError(404, 'task_not_found', '没有这个任务');
      },
    };
    return renderApp(
      <Routes>
        <Route path="/tasks/:taskId" element={<TaskPage />} />
      </Routes>,
      { route, api },
    );
  }

  test('地址全是数字时多写一句：这是单号，任务页要用任务编号', async () => {
    open('/tasks/12');
    expect(await screen.findByText('没有这张单')).toBeTruthy();
    expect(
      screen.getByText(
        '这看起来是 GitHub 单号。任务页地址要用任务编号（例如 t-12），到主页的在跑列表里点进去',
      ),
    ).toBeTruthy();
  });

  test('不是纯数字时不写单号那句', async () => {
    open('/tasks/t-missing');
    expect(await screen.findByText('没有这张单')).toBeTruthy();
    expect(screen.queryByText(/这看起来是 GitHub 单号/)).toBeNull();
  });
});
