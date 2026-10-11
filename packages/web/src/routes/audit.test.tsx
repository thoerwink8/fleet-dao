// @vitest-environment happy-dom
// 操作记录页：展开默认是人话差异，原始 JSON 收在折叠里；空态在还有更早记录时才给出翻页。
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { AuditEntry } from '../api/types';
import { renderApp } from '../test/harness';
import AuditPage from './audit';

afterEach(cleanup);

const search = () => screen.getByLabelText('搜索操作记录');

describe('操作记录页', () => {
  test('展开「看改了什么」默认是人话差异，原始 JSON 在「看原始数据」里且默认合上', async () => {
    // 展开后仍把 routeId 的 JSON 摊在外面，或人话里留着 r-ca-sonnet 没换成 Sonnet 5，这一条会红。
    renderApp(<AuditPage />);
    const summary = (await screen.findAllByText('看改了什么'))[0];
    if (!summary) throw new Error('没有「看改了什么」');
    const block = summary.closest('details');
    if (!(block instanceof HTMLElement)) throw new Error('展开区不是 details');
    fireEvent.click(summary);
    expect(within(block).getByText('阶段：（无） → 分诊')).toBeTruthy();
    expect(await within(block).findByText('路由：（无） → Sonnet 5')).toBeTruthy();
    const rawSummary = within(block).getByText('看原始数据');
    const raw = rawSummary.closest('details');
    if (!(raw instanceof HTMLDetailsElement)) throw new Error('原始数据不是折叠');
    expect(raw.open).toBe(false);
    expect(raw.textContent).toContain('"routeId": "r-ca-sonnet"');
    expect(raw.contains(within(block).getByText('路由：（无） → Sonnet 5'))).toBe(false);
  });

  test('过滤后没有记录、也没有更早的：不提往前翻，没有按钮', async () => {
    // 空态仍写「往前翻更早的」或凭空放按钮，这一条会红。
    renderApp(<AuditPage />);
    await screen.findAllByText('派了会话');
    fireEvent.change(search(), { target: { value: '根本没有这种记录' } });
    expect(await screen.findByText('没有符合条件的记录')).toBeTruthy();
    expect(screen.getByText('换个过滤条件。')).toBeTruthy();
    expect(screen.queryByText(/往前翻更早的/)).toBeNull();
    expect(screen.queryByRole('button', { name: '再看 50 条' })).toBeNull();
  });

  test('搜索无结果时提示只搜了已加载的', async () => {
    // 仍写「没有」却不说只搜了已加载的，或点了不读下一页，这一条会红。
    const api = createMockApi({ live: false });
    const first = await api.audit({ limit: 100 });
    const sample = first.items[0];
    if (!sample) throw new Error('假数据没有操作记录');
    const older: AuditEntry = {
      ...sample,
      id: 'a-older',
      actor: { kind: 'user', id: 'u-older', name: '更早的人' },
      action: 'login',
      target: 'cockpit',
      before: undefined,
      after: { method: 'password' },
      reason: undefined,
      error: undefined,
    };
    api.audit = (query) =>
      Promise.resolve(
        query?.cursor
          ? { items: [older] }
          : { items: first.items, nextCursor: '2099-01-01T00:00:00.000Z|a-more' },
      );
    renderApp(<AuditPage />, { api });
    await screen.findAllByText('派了会话');
    fireEvent.change(search(), { target: { value: '更早的人' } });
    const title = await screen.findByText('没有符合条件的记录');
    const box = title.parentElement;
    if (!box) throw new Error('空态没有外框');
    const loaded = first.items.length;
    const button = within(box).getByRole('button', {
      name: `只搜了已加载的 ${loaded} 条，点这里再往前翻`,
    });
    expect(screen.queryByRole('button', { name: '再看 50 条' })).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('更早的人')).toBeTruthy());
  });

  test('过滤后没有记录、还有更早的：按钮在空态里，点了继续往前读', async () => {
    // 按钮留在列表底部、或点了不读下一页，这一条会红。
    const api = createMockApi({ live: false });
    const first = await api.audit({ limit: 100 });
    const sample = first.items[0];
    if (!sample) throw new Error('假数据没有操作记录');
    const older: AuditEntry = {
      ...sample,
      id: 'a-older',
      actor: { kind: 'agent', id: 'agent-older', name: '更早的会话' },
      action: 'run.start',
      target: 'task:t-12',
      before: undefined,
      after: { stage: 'triage', routeId: 'r-ca-sonnet' },
      reason: undefined,
      error: undefined,
    };
    api.audit = (query) =>
      Promise.resolve(
        query?.cursor
          ? { items: [older] }
          : { items: first.items, nextCursor: '2099-01-01T00:00:00.000Z|a-more' },
      );
    renderApp(<AuditPage />, { api });
    await screen.findAllByText('派了会话');
    expect(screen.getByRole('button', { name: '再看 50 条' })).toBeTruthy();
    // 假数据第一页没有「会话」操作人；下一页有。
    fireEvent.click(screen.getByRole('tab', { name: '会话' }));
    const title = await screen.findByText('没有符合条件的记录');
    const box = title.parentElement;
    if (!box) throw new Error('空态没有外框');
    expect(box.textContent).toContain('往前翻更早的');
    const button = within(box).getByRole('button', { name: '再看 50 条' });
    expect(screen.getAllByRole('button', { name: '再看 50 条' })).toHaveLength(1);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('更早的会话')).toBeTruthy());
  });
});

describe('操作记录页：50 条一页（#1837）', () => {
  test('默认只读、只画 50 条，点「再看 50 条」再读下一页，读完按钮没了', async () => {
    // 一次铺全部（手机端近两万像素）、或按钮不接着读下一页，这一条会红。
    const api = createMockApi({ live: false });
    const sample = (await api.audit({ limit: 1 })).items[0];
    if (!sample) throw new Error('假数据没有操作记录');
    const all: AuditEntry[] = Array.from({ length: 120 }, (_, i) => ({
      ...sample,
      id: `a-page-${i}`,
      target: `cockpit-${i}`,
      before: undefined,
      after: undefined,
    }));
    const limits: (number | undefined)[] = [];
    api.audit = (query) => {
      limits.push(query?.limit);
      const start = query?.cursor ? Number(query.cursor) : 0;
      const size = query?.limit ?? all.length;
      const end = Math.min(start + size, all.length);
      return Promise.resolve({
        items: all.slice(start, end),
        ...(end < all.length ? { nextCursor: String(end) } : {}),
      });
    };
    renderApp(<AuditPage />, { api });
    const rows = () => document.querySelectorAll('ol > li').length;
    await waitFor(() => expect(rows()).toBe(50));
    expect(limits).toEqual([50]);
    fireEvent.click(screen.getByRole('button', { name: '再看 50 条' }));
    await waitFor(() => expect(rows()).toBe(100));
    fireEvent.click(screen.getByRole('button', { name: '再看 50 条' }));
    await waitFor(() => expect(rows()).toBe(120));
    expect(screen.queryByRole('button', { name: '再看 50 条' })).toBeNull();
  });
});

describe('操作记录页：事件名翻成中文（#1821）', () => {
  test('routing.probe.done 显示成「探针探完」，原名只在悬停里；没收录的显示原名加灰字「（没翻译）」', async () => {
    // 把事件名直接露出来，或没收录的也被硬翻成一句话，这一条会红。
    const api = createMockApi({ live: false });
    const first = await api.audit({ limit: 100 });
    const sample = first.items[0];
    if (!sample) throw new Error('假数据没有操作记录');
    const unknown: AuditEntry = {
      ...sample,
      id: 'a-unknown',
      action: 'zzz.never.heard',
      target: 'cockpit',
      before: undefined,
      after: undefined,
      reason: undefined,
      error: undefined,
    };
    api.audit = () => Promise.resolve({ items: [unknown, ...first.items] });
    renderApp(<AuditPage />, { api });
    const done = (await screen.findAllByText('探针探完'))[0];
    expect(done?.getAttribute('title')).toBe('routing.probe.done');
    expect(screen.queryByText('routing.probe.done')).toBeNull();
    const raw = (await screen.findAllByText(/zzz\.never\.heard/))[0];
    expect(raw?.textContent).toContain('（没翻译）');
    expect(done?.textContent).not.toContain('（没翻译）');
  });

  test('有对照的行能点进对应的单：task 对象旁有「打开」链接去任务页', async () => {
    renderApp(<AuditPage />);
    await screen.findAllByText('派了会话');
    const links = screen.getAllByRole('link', { name: '打开' });
    expect(links.some((a) => a.getAttribute('href')?.startsWith('/tasks/'))).toBe(true);
  });
});
