// @vitest-environment happy-dom
// 路由页「动手战绩」：表头五列，一行样本数据都渲染出来。
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import RoutingPage from '../routes/routing';
import { renderApp } from './harness';

afterEach(cleanup);

const HEADS = ['一段过', '单数', '下界', '没做成', '平均分钟'] as const;

describe('路由页动手战绩', () => {
  test('表头五列和一行样本都渲染出来', async () => {
    const api = createMockApi({ live: false });
    const layers = await api.routingLayers();
    api.routingLayers = async () => ({
      ...layers,
      manualTracks: [
        {
          modelId: 'opus-5.5',
          modelName: 'Opus 5.5',
          tier: 'heavyweight',
          onePass: 2,
          tasks: 4,
          lower: 0.31,
          notDone: 1,
          avgMinutes: 48,
        },
      ],
    });
    renderApp(<RoutingPage />, { route: '/routing', api });
    const table = await screen.findByRole('table', { name: '动手战绩' });
    for (const name of HEADS) {
      expect(within(table).getByRole('columnheader', { name })).toBeTruthy();
    }
    const row = table.querySelector('[data-manual-track="opus-5.5"]');
    expect(row?.textContent).toContain('Opus 5.5');
    expect(row?.textContent).toContain('主力档');
    expect(row?.querySelector('[data-track="onePass"]')?.textContent).toBe('2');
    expect(row?.querySelector('[data-track="tasks"]')?.textContent).toBe('4');
    expect(row?.querySelector('[data-track="lower"]')?.textContent).toBe('0.31');
    expect(row?.querySelector('[data-track="notDone"]')?.textContent).toBe('1');
    expect(row?.querySelector('[data-track="avgMinutes"]')?.textContent).toBe('48');
  });
});
