// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { Breadcrumb } from './breadcrumb';
import { TabPanel } from './tab-panel';
import { TextLink } from './text-link';

afterEach(cleanup);

describe('Breadcrumb', () => {
  test('前面的层级是站内链接，最后一项是当前页（不是链接），分隔斜杠不读给读屏', () => {
    render(
      <MemoryRouter>
        <Breadcrumb
          items={[{ label: '任务列表', href: '/tasks?state=done', ariaLabel: '回任务列表' }, { label: '#9' }]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: '回任务列表' }).getAttribute('href')).toBe('/tasks?state=done');
    const now = document.querySelector('[aria-current="page"]');
    expect(now?.textContent).toBe('#9');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(document.querySelector('[aria-hidden]')?.textContent).toBe('/');
  });

  test('最后一项即使给了 href 也不是链接', () => {
    render(
      <MemoryRouter>
        <Breadcrumb
          items={[
            { label: '主页', href: '/' },
            { label: '任务', href: '/tasks' },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});

describe('TextLink', () => {
  test('站内走路由；external 开新窗口', () => {
    render(
      <MemoryRouter>
        <TextLink href="/tasks/t-1">内部</TextLink>
        <TextLink href="https://example.com/pull/1" external>
          外部
        </TextLink>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: '内部' }).getAttribute('href')).toBe('/tasks/t-1');
    const ext = screen.getByRole('link', { name: '外部' });
    expect(ext.getAttribute('target')).toBe('_blank');
    expect(ext.getAttribute('rel')).toBe('noreferrer');
  });
});

describe('TabPanel', () => {
  test('role=tabpanel，指向选中的页签', () => {
    render(
      <TabPanel idPrefix="task-tab" id="usage">
        内容
      </TabPanel>,
    );
    const p = screen.getByRole('tabpanel');
    expect(p.getAttribute('aria-labelledby')).toBe('task-tab-usage');
    expect(p.textContent).toBe('内容');
  });
});
