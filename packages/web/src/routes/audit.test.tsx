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
    // #3533：表格行首的展开按钮（aria-expanded），明细在行下面的展开行；
    // 断言等价：点开前没有明细、点开后明细里是人话差异，原始数据仍是默认合上的折叠（Collapse）。
    renderApp(<AuditPage />);
    const buttons = await screen.findAllByRole('button', { name: '展开' });
    expect(buttons[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-audit-detail]')).toBeNull();
    for (const b of buttons) fireEvent.click(b);
    const stage = await screen.findAllByText('（无） → 分诊');
    const block = stage[0]?.closest('[data-audit-detail]');
    if (!(block instanceof HTMLElement)) throw new Error('没有展开的明细');
    expect(within(block).getByText('阶段')).toBeTruthy();
    expect(await within(block).findByText('（无） → Sonnet 5')).toBeTruthy();
    expect(within(block).getByText('路由')).toBeTruthy();
    const rawToggle = within(block).getByRole('button', { name: '看原始数据' });
    expect(rawToggle.getAttribute('aria-expanded')).toBe('false');
    const raw = document.getElementById(rawToggle.getAttribute('aria-controls') ?? '');
    if (!(raw instanceof HTMLElement)) throw new Error('原始数据不是折叠');
    expect(raw.textContent).toContain('"routeId": "r-ca-sonnet"');
    expect(raw.contains(within(block).getByText('（无） → Sonnet 5'))).toBe(false);
  });

  test('没做成的记录：行标 fail（竖线）、带「没做成」状态标签，做成的行没有', async () => {
    // 失败行又退回手写的淡红底、或做成的行也带了标签，这一条会红。
    const api = createMockApi({ live: false });
    const sample = (await api.audit({ limit: 1 })).items[0];
    if (!sample) throw new Error('假数据没有操作记录');
    api.audit = () =>
      Promise.resolve({
        items: [
          { ...sample, id: 'a-ok', ok: true },
          { ...sample, id: 'a-bad', ok: false, error: '没权限' },
        ],
      });
    renderApp(<AuditPage />, { api });
    await screen.findAllByText('没权限');
    const [good, bad] = document.querySelectorAll('tr[data-row-key]');
    expect(good?.textContent).not.toContain('没做成');
    expect(bad?.textContent).toContain('没做成');
    // 折叠行里就能看到截断的出错原因，全文在展开里
    expect(
      within(bad as HTMLElement)
        .getByText('没权限')
        .getAttribute('title'),
    ).toBe('没权限');
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
    expect(box.textContent).toContain(`只搜了已加载的 ${loaded} 条`);
    const button = within(box).getByRole('button', { name: '再看 50 条' });
    expect(screen.getAllByRole('button', { name: '再看 50 条' })).toHaveLength(1);
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
    // 120 行在整包一起跑时画 DOM 会超过默认 5 秒，单独放宽。
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
    const rows = () => document.querySelectorAll('tr[data-row-key]').length;
    await waitFor(() => expect(rows()).toBe(50));
    expect(limits).toEqual([50]);
    fireEvent.click(screen.getByRole('button', { name: '再看 50 条' }));
    await waitFor(() => expect(rows()).toBe(100));
    fireEvent.click(screen.getByRole('button', { name: '再看 50 条' }));
    await waitFor(() => expect(rows()).toBe(120));
    expect(screen.queryByRole('button', { name: '再看 50 条' })).toBeNull();
  }, 15_000);
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
    // 认不出的键：只显示默认译名「其他操作」，原键收进展开后的「看原始数据」（动作原文），页上任何地方都不写「没翻译」
    const other = (await screen.findAllByText(/其他操作/))[0];
    expect(other?.getAttribute('title')).toBe('zzz.never.heard');
    expect(screen.queryByText('zzz.never.heard')).toBeNull();
    fireEvent.click(within(other?.closest('tr') as HTMLElement).getByRole('button', { name: '展开' }));
    const key = await screen.findByText('zzz.never.heard');
    expect(key.closest('[data-audit-detail]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('没翻译');
    expect(done?.textContent).not.toContain('zzz.never.heard');
  });

  test('「经引擎」不再逐行贴标签：来路放进下拉筛选，每行只在时间悬停里写', async () => {
    renderApp(<AuditPage />);
    await screen.findAllByText('派了会话');
    // 页上不再有一排排「经引擎」标签（下拉里的选项不算行）
    expect(screen.queryAllByText('经引擎').filter((el) => el.tagName !== 'OPTION')).toEqual([]);
    const via = screen.getByRole('combobox', { name: '按来路筛选' });
    const all = document.querySelectorAll('tr[data-row-key]').length;
    fireEvent.change(via, { target: { value: 'cockpit' } });
    await waitFor(() => expect(document.querySelectorAll('tr[data-row-key]').length).toBeLessThan(all));
    expect(document.querySelectorAll('tr[data-row-key]').length).toBeGreaterThan(0);
    for (const row of document.querySelectorAll('tr[data-row-key]')) {
      expect(row.querySelector('[title*="· 经"]')).not.toBeNull();
      expect(row.querySelector('[title*="经引擎"]')).toBeNull();
    }
  });

  test('有对照的行能点进对应的单：task 对象旁有「打开」链接去任务页', async () => {
    // #3533：「打开」改成表里「操作」列的「查看」链接；断言等价：task 行的「查看」去任务页。
    renderApp(<AuditPage />);
    await screen.findAllByText('派了会话');
    const row = screen.getAllByText('派了会话')[0]?.closest('tr') as HTMLElement;
    expect(within(row).getByRole('link', { name: '查看' }).getAttribute('href')).toMatch(/^\/tasks\//);
  });

  test('表头是谁 / 做了什么 / 对象 / 时间 / 操作；每格各占自己那一列，对象不和执行者、动作挤在一格', async () => {
    renderApp(<AuditPage />);
    await screen.findAllByText('派了会话');
    const heads = Array.from(document.querySelectorAll('th')).map((th) => th.textContent);
    for (const h of ['谁', '做了什么', '对象', '时间', '操作']) expect(heads).toContain(h);
    for (const row of document.querySelectorAll('tr[data-row-key]')) {
      const what = row.querySelector('[data-audit-what]');
      const who = row.querySelector('[data-audit-who]');
      expect(what?.closest('td')).not.toBe(who?.closest('td'));
      expect(what?.closest('td')).not.toBeNull();
    }
  });
});
