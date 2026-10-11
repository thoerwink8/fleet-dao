// @vitest-environment happy-dom
// 选中的卡片被详情面板盖住时画布平移避开（单 #1819）：被盖住调用平移，没被盖住不调。
// 排版换成固定坐标、画布和面板的尺寸用假的（happy-dom 量不出），平移用桩接住。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiProvider } from '../../../api/client';
import { createMockApi } from '../../../api/mock/server';
import { TaskActionsProvider } from '../../task-actions';
import { ThemeProvider } from '../../theme-provider';
import { TooltipProvider } from '../../ui/tooltip';
import type { HomeRunning } from '../types';
import { BoardCanvas } from './board-canvas';

MotionGlobalConfig.skipAnimations = true;
configure({ asyncUtilTimeout: 10_000 });

const setViewport = vi.fn();

vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    useReactFlow: () => ({ ...actual.useReactFlow(), setViewport }),
  };
});

// 两张单：1 号在画布左半（面板打开后仍看得见），2 号在右半（会被面板盖住）
vi.mock('./layout', async () => {
  const actual = await vi.importActual<typeof import('./layout')>('./layout');
  return {
    ...actual,
    layoutGraph: async (graph: { nodes: { id: string }[] }) =>
      new Map(
        graph.nodes.map((n, i) => [
          n.id,
          n.id.startsWith('ticket:1:')
            ? { x: 100, y: 100 }
            : n.id.startsWith('ticket:2:')
              ? { x: 700, y: 100 }
              : { x: 20 + i, y: 400 },
        ]),
      ),
  };
});

const base = { repo: 'o/r', waitingReason: 'nothing' as const, link: '/x', segment: 'doing' as const };
const running: HomeRunning[] = [
  { ...base, issueNumber: 1, title: '左边的单' },
  { ...base, issueNumber: 2, title: '右边的单' },
];
const flow = [
  { segment: 'scope' as const, inFlight: 0, samples: 0 },
  { segment: 'manual' as const, inFlight: 2, samples: 0 },
  { segment: 'verify' as const, inFlight: 0, samples: 0 },
];

const proto = HTMLElement.prototype;
const rectDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
const widthDesc = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');

beforeEach(() => {
  setViewport.mockClear();
  // 画布 1000×700；详情面板 392 宽
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const wide = this.matches('[role="application"]');
    const w = wide ? 1000 : 0;
    const h = wide ? 700 : 0;
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON() {} } as DOMRect;
  };
  Object.defineProperty(proto, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-board-detail') ? 392 : 0;
    },
  });
});

afterEach(() => {
  cleanup();
  if (rectDesc) Object.defineProperty(Element.prototype, 'getBoundingClientRect', rectDesc);
  if (widthDesc) Object.defineProperty(proto, 'offsetWidth', widthDesc);
});

test('选中的卡片被详情面板盖住：调用平移；没盖住：不调', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={['/']}>
      <QueryClientProvider client={qc}>
        <ApiProvider api={createMockApi({ live: false })}>
          <ThemeProvider>
            <TooltipProvider>
              <TaskActionsProvider>
                <div style={{ width: 1000, height: 700 }}>
                  <BoardCanvas running={running} flow={flow} />
                </div>
              </TaskActionsProvider>
            </TooltipProvider>
          </ThemeProvider>
        </ApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const left = await screen.findByText('左边的单');
  const right = await screen.findByText('右边的单');
  await waitFor(() => expect(document.querySelector('[data-board-now]')).toBeTruthy());
  setViewport.mockClear();

  // 左边那张：右边界 404，可见区右边界 = 1000 - (392 + 12) - 16 = 580 → 在里面，不挪
  fireEvent.click(left);
  await screen.findByLabelText('详情');
  expect(setViewport).not.toHaveBeenCalled();

  // 右边那张：右边界 1004，被面板盖住 → 平移
  fireEvent.click(right);
  await waitFor(() => expect(setViewport).toHaveBeenCalledTimes(1));
  const [vp] = setViewport.mock.calls[0] ?? [];
  expect(vp.x).toBeLessThan(0);
  expect(vp.zoom).toBe(1);
});
