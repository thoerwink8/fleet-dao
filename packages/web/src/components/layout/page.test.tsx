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
    const names = [...slot.querySelectorAll('button')].map((b) => b.textContent);
    expect(names).toEqual(['新建', '刷新']);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(refresh.onRefresh).toHaveBeenCalledTimes(1);
    expect(slot.textContent).toContain('最后更新');
  });

  test('没有 actions 也没有 refresh 就不画操作区；tabs 画在页头下面；width=narrow 收窄', () => {
    viewport(1366);
    render(
      <Page title="某页" tabs={<nav>页签</nav>} width="narrow">
        <p>正文</p>
      </Page>,
    );
    expect(document.querySelector('[data-page-actions]')).toBeNull();
    expect(screen.getByText('页签')).toBeTruthy();
    expect((document.querySelector('[data-page-width]') as HTMLElement).dataset.pageWidth).toBe('narrow');
  });
});
