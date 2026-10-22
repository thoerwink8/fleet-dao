// @vitest-environment happy-dom
// 设置页照路由页样板重做（#1917）：仓库一行一个主信息、一个状态，按钮同一行。#3533 起仓库是一张表（样稿 Settings.dc.html）：
// 仓名加主线小字、让 AI 接活一个状态、CI 模式一格字、操作格里两个按钮；整理记录、CI 切换在行首展开区里。
// 整池暂停不在这页，开关在额度页。
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { RowDetail } from '../components/layout/list';
import SettingsPage from '../routes/settings';
import { renderApp } from './harness';

afterEach(cleanup);

async function findOrbitRow(): Promise<HTMLElement> {
  return await waitFor(() => {
    const r = document.querySelector('tr[data-row-key="r-orbit"]');
    if (!(r instanceof HTMLElement)) throw new Error('还没画出这一行');
    return r;
  });
}

describe('设置页仓库行（#1917）', () => {
  test('一行：仓名加一行小字（主线）、一个状态（StatusBadge 字典）；开的时刻在悬停里', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    const row = await findOrbitRow();
    const name = within(row).getByText('acme/orbit');
    expect(name.getAttribute('title')).toBe('acme/orbit');
    expect(name.className).toContain('truncate');
    expect(within(row).getByText('主线 main')).toBeTruthy();
    const state = await screen.findByTestId('dispatch-state-r-orbit');
    expect(state.querySelector('[data-status]')?.getAttribute('data-status')).toBe('machine:dispatch:on');
    expect(state.textContent).toContain('接活中');
    expect(state.getAttribute('title')).toContain('开的');
    // 一行只有一个状态：CI 模式是普通文字，不是第二个状态点
    expect(row.querySelectorAll('[data-status]')).toHaveLength(1);
  });

  test('点行首的展开箭头看整理记录和 CI 切换，再点收起', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    const row = await findOrbitRow();
    const toggle = within(row).getByRole('button', { name: '展开' });
    expect(document.querySelector('[data-detail-for="r-orbit"]')).toBeNull();
    fireEvent.click(toggle);
    const detail = document.querySelector('[data-detail-for="r-orbit"]') as HTMLElement;
    expect(detail).toBeTruthy();
    expect(within(detail).getByTestId('groom-detail-r-orbit')).toBeTruthy();
    expect(within(detail).getByTestId('ci-policy-r-orbit')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(document.querySelector('[data-detail-for="r-orbit"]')).toBeNull();
  });

  test('总开关和接活的关系：状态在前，关系整句在悬停里，去法国页的链接在最后', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    const note = await screen.findByTestId('engine-master-relation');
    await waitFor(() => expect(note.textContent).toContain('总开关现在关着'));
    const rel = note.querySelector('[title]') as HTMLElement;
    expect(rel.getAttribute('title')).toContain('总开关关＝全停');
    expect(within(note).getByRole('link', { name: '去法国页开关' }).getAttribute('href')).toBe('/france');
  });

  test('各节是各自一张卡，标题按页内导航的顺序', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByTestId('dispatch-r-orbit');
    const titles = ['repos', 'run', 'reserve', 'notify', 'account', 'about'].map(
      (id) => document.getElementById(id)?.querySelector('h2')?.textContent,
    );
    expect(titles).toEqual(['仓库4', '运行设置', '各渠道的额度留量线', '提醒', '账密登录', '关于']);
  });
});

describe('RowDetail indent=false（#1917）', () => {
  test('默认按展开箭头加序号缩进；indent=false 只留行的左右内边距', () => {
    render(
      <>
        <RowDetail data-testid="a" />
        <RowDetail data-testid="b" indent={false} />
      </>,
    );
    expect(screen.getByTestId('a').className).toContain('--spacing-row-indent');
    expect(screen.getByTestId('b').className).toContain('px-section');
    expect(screen.getByTestId('b').className).not.toContain('--spacing-row-indent');
  });
});
