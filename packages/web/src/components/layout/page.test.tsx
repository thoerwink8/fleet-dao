// @vitest-environment happy-dom
// Page：标题左、操作右；refresh 渲染在固定槽位；说明手机上收成 ⓘ。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Page } from './page';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function viewport(width: number) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, kind, px]) =>
          kind === 'min' ? width >= Number(px) : width <= Number(px),
        ),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

const refresh = { onRefresh: vi.fn(), isFetching: false, dataUpdatedAt: Date.now(), staleAfterMs: 60_000 };

describe('Page', () => {
  test('手机：说明收起成「ⓘ」，点开才看到', async () => {
    viewport(390);
    render(
      <Page title="某页" description="这页是做什么的一句说明。">
        <p>正文</p>
      </Page>,
    );
    expect(screen.queryByText('这页是做什么的一句说明。')).toBeNull();
    fireEvent.click(document.querySelector('[data-description-hint]') as HTMLElement);
    expect(await screen.findByText('这页是做什么的一句说明。')).toBeTruthy();
  });

  test('电脑：说明直接写在标题下，没有「ⓘ」', () => {
    viewport(1366);
    render(
      <Page title="某页" description="这页是做什么的一句说明。">
        <p>正文</p>
      </Page>,
    );
    expect(screen.getByText('这页是做什么的一句说明。')).toBeTruthy();
    expect(document.querySelector('[data-description-hint]')).toBeNull();
  });

  test('keepDescription：手机上说明也直接写出来', () => {
    viewport(390);
    render(
      <Page title="某页" description="关键信息" keepDescription>
        <p>正文</p>
      </Page>,
    );
    expect(screen.getByText('关键信息')).toBeTruthy();
    expect(document.querySelector('[data-description-hint]')).toBeNull();
  });

  test('refresh 属性：刷新控件渲染在页头操作区，排在 actions 后面；点它调 onRefresh', () => {
    viewport(1366);
    render(
      <Page title="某页" actions={<button type="button">新建</button>} refresh={refresh}>
        <p>正文</p>
      </Page>,
    );
    const slot = document.querySelector('[data-page-actions]') as HTMLElement;
    const names = [...slot.querySelectorAll('button')].map(
      (b) => b.textContent || b.getAttribute('aria-label'),
    );
    expect(names).toEqual(['新建', '刷新']);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(refresh.onRefresh).toHaveBeenCalledTimes(1);
    expect(slot.textContent).toContain('最后更新');
  });

  test('没有 actions 也没有 refresh 就不画操作区；tabs 画在页头下面；页宽只有一种', () => {
    viewport(1366);
    render(
      <Page title="某页" tabs={<nav>页签</nav>}>
        <p>正文</p>
      </Page>,
    );
    expect(document.querySelector('[data-page-actions]')).toBeNull();
    expect(screen.getByText('页签')).toBeTruthy();
    const page = document.querySelector('[data-page-width]') as HTMLElement;
    expect(page.dataset.pageWidth).toBe('full');
    expect(page.className).toContain('max-w-cockpit');
  });

  test('刷新槽位和标题在同一行容器里，说明在这一行的下面', () => {
    viewport(1366);
    render(
      <Page title="某页" description="一句说明。" refresh={refresh}>
        <p>正文</p>
      </Page>,
    );
    const header = document.querySelector('header') as HTMLElement;
    const actions = header.querySelector('[data-page-actions]') as HTMLElement;
    // 刷新槽位和标题块是页头里并排的两个子项，都从顶对齐；槽位至少一个控件高并居中
    expect(actions.parentElement).toBe(header);
    expect(header.className).toContain('items-start');
    expect(actions.className).toContain('items-center');
    expect(actions.className).toContain('min-h-8');
    const titlebar = header.querySelector('[data-page-titlebar]') as HTMLElement;
    expect(titlebar.querySelector('h1')?.textContent).toBe('某页');
    expect(titlebar.contains(actions)).toBe(false);
  });

  test('电脑：字符串说明超过一行的字数，收进 ⓘ，标题下不摊开', async () => {
    viewport(1366);
    const long = '很长的说明'.repeat(12);
    render(
      <Page title="某页" description={long}>
        <p>正文</p>
      </Page>,
    );
    expect(screen.queryByText(long)).toBeNull();
    fireEvent.click(document.querySelector('[data-description-hint]') as HTMLElement);
    expect(await screen.findByText(long)).toBeTruthy();
  });

  test('detail：一行说明照常摊开，长说明在 ⓘ 里', async () => {
    viewport(1366);
    render(
      <Page title="某页" description="一句说明。" detail="细则在这里。">
        <p>正文</p>
      </Page>,
    );
    expect(screen.getByText('一句说明。')).toBeTruthy();
    expect(screen.queryByText('细则在这里。')).toBeNull();
    fireEvent.click(document.querySelector('[data-description-hint]') as HTMLElement);
    expect(await screen.findByText('细则在这里。')).toBeTruthy();
  });
});
