// @vitest-environment happy-dom
// 主页抽屉在手机上的点击区（#2017）：每个按钮不小于 44px（h-11 / size-11 / min-h-11），桌面才缩回 32。
// happy-dom 没有版式，量不了像素，这里钉类名；真实像素在 PR 的 390 宽截图和点验里量过。
import { cleanup } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { createMockApi } from '../../api/mock/server';
import HomePage from '../../routes/home';
import { renderApp } from '../../test/harness';

afterEach(cleanup);

test('抽屉按钮的类名：手机 h-11（44px），md 起 h-8', async () => {
  renderApp(<HomePage />, { api: createMockApi({ live: false }), route: '/' });
  const btn = await (async () => {
    for (let i = 0; i < 50; i++) {
      const el = document.querySelector('[data-drawer-button]');
      if (el) return el;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('没找到抽屉按钮');
  })();
  for (const b of btn.querySelectorAll('button')) {
    const cls = b.className.split(/\s+/);
    expect(cls, b.textContent ?? '').toContain('h-11');
    expect(cls, b.textContent ?? '').toContain('md:h-8');
  }
});
