// @vitest-environment happy-dom
// 已下架的行只留状态胶囊上的「已下架」，不再另画一枚同样的小标签。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import RoutingPage from '../routes/routing';
import { renderApp } from '../test/harness';

afterEach(cleanup);

/** 行里单独成词的「已下架」（状态胶囊或小标签）。嵌在更长句子里的不算。 */
function retiredLabels(root: ParentNode): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = 0;
  while (walker.nextNode()) {
    if (walker.currentNode.textContent?.trim() === '已下架') n += 1;
  }
  return n;
}

const catalogRow = async (id: string) => {
  await screen.findByRole('list', { name: '目录里的模型' });
  return waitFor(() => {
    const el = document.querySelector(`li[data-catalog="${id}"]`);
    if (!(el instanceof HTMLElement)) throw new Error(`目录里还没有 ${id}`);
    return el;
  });
};

describe('已下架的行不把同一件事写两遍', () => {
  test('已下架的行，文字「已下架」只出现一次', async () => {
    renderApp(<RoutingPage />, { route: '/routing?tab=models' });
    const model = await catalogRow('opus-5');
    expect(retiredLabels(model)).toBe(1);
    expect(model.querySelector('[data-catalog-mark="retired"]')).toBeNull();
    expect(model.querySelector('[data-status-word]')?.textContent).toContain('已下架');

    const routeOnCatalog = document.querySelector('li[data-route="r-ca-opus5"], [data-route="r-ca-opus5"]');
    if (routeOnCatalog instanceof HTMLElement) expect(retiredLabels(routeOnCatalog)).toBe(1);

    cleanup();
    renderApp(<RoutingPage />, { route: '/routing?tab=channels' });
    await screen.findByRole('list', { name: '渠道列表' });
    fireEvent.click(await screen.findByRole('button', { name: '查看 Claude 订阅 的路由' }));
    const route = await waitFor(() => {
      const el = document.querySelector('[data-route="r-ca-opus5"]');
      if (!(el instanceof HTMLElement)) throw new Error('渠道里还没有已下架的 Opus 5 路由');
      return el;
    });
    expect(retiredLabels(route)).toBe(1);
    expect(route.querySelector('[data-catalog-mark="retired"]')).toBeNull();
  });
});
