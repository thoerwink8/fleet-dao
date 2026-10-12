// @vitest-environment happy-dom
// 设置页照路由页样板重做（#1917）：仓库一行一个主信息、一个状态，两个按钮同一行；说明一行不折。
// 整池暂停不在这页，开关在额度页。
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { RowDetail } from '../components/layout/list';
import SettingsPage from '../routes/settings';
import { renderApp } from './harness';

afterEach(cleanup);

describe('设置页仓库行（#1917）', () => {
  test('一行：仓名加一行小字（主线、整理到哪、今日剩余）、一个状态（StatusBadge）；开的时刻在悬停和读屏里', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    const panel = await screen.findByTestId('groom-r-orbit');
    await waitFor(() => expect(within(panel).getByTestId('groom-quota-r-orbit')).toBeTruthy());
    const meta = panel.querySelector('[data-row-meta]') as HTMLElement;
    expect(meta.className).toContain('truncate');
    expect(meta.className).toContain('whitespace-nowrap');
    expect(meta.getAttribute('title')).toContain('主线 main');
    expect(meta.getAttribute('title')).toContain('今日剩余');
    const state = screen.getByTestId('dispatch-state-r-orbit');
    expect(state.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('done');
    expect(state.textContent).toBe('接活中');
    expect(screen.getByTestId('dispatch-note-r-orbit').textContent).toContain('开的');
    // 一行只有一个状态：不再另写一个整理的状态点
    expect(panel.querySelectorAll('[data-row-frame] [data-tone][data-variant]')).toHaveLength(1);
  });

  test('点仓名展开整理记录（RowDetail，和名字对齐），再点收起', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    const panel = await screen.findByTestId('groom-r-orbit');
    const name = within(panel).getByRole('button', { name: 'acme/orbit 的整理详情' });
    expect(name.textContent).toContain('acme/orbit');
    expect(panel.querySelector('[data-row-detail]')).toBeNull();
    fireEvent.click(name);
    const detail = panel.querySelector('[data-row-detail]') as HTMLElement;
    expect(detail).toBeTruthy();
    expect(detail.className).toContain('px-section');
    expect(name.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(name);
    expect(panel.querySelector('[data-row-detail]')).toBeNull();
  });

  test('总开关和接活的关系一行不折：状态在前不让位，关系截断整句在悬停里，去法国页的链接在最后', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    const note = await screen.findByTestId('engine-master-relation');
    await waitFor(() => expect(note.textContent).toContain('总开关现在关着'));
    expect(note.className).toContain('whitespace-nowrap');
    const rel = note.querySelector('[title]') as HTMLElement;
    expect(rel.className).toContain('truncate');
    expect(rel.getAttribute('title')).toContain('总开关关＝全停');
    expect(within(note).getByRole('link', { name: '去法国页开关' }).getAttribute('href')).toBe('/france');
  });

  test('各节说明一行不折：截断，整句在悬停里；页头长说明在 ⓘ', async () => {
    renderApp(<SettingsPage />, { api: createMockApi({ live: false }), route: '/settings' });
    await screen.findByTestId('dispatch-r-orbit');
    const notes = document.querySelectorAll('[data-section-note]');
    expect(notes.length).toBe(6);
    for (const n of notes) {
      expect(n.className).toContain('truncate');
      expect(n.className).toContain('whitespace-nowrap');
      expect(n.getAttribute('title')).toBe(n.textContent);
    }
    expect(screen.getByRole('button', { name: '这页是做什么的' })).toBeTruthy();
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
