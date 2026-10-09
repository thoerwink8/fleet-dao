// @vitest-environment happy-dom
// 占位页（账单、战绩、判断题记录）和别的页用同一套标题区：标题在左上，计划要点和返回入口在标题下面。
// 根节点不再整页垂直居中（#1534）。
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { brand } from '#brand';
import { Page } from '../components/page';
import Soon from './soon';

afterEach(cleanup);

const PAGES = [
  {
    path: '/billing',
    title: '账单',
    what: '花了多少、值不值：每个会话记模型、路由、token、耗时和所属任务。',
    bullet: '订阅月费按月摊到任务，算出每完成一个任务花多少',
    link: '现在先看额度',
    href: '/quota',
  },
  {
    path: '/record',
    title: '战绩',
    what: '每条路由在每类活上干得怎么样。',
    bullet: '成功率、平均耗时、返工轮数，按阶段类型分开算',
    link: '现在先看渠道状态',
    href: '/routing/status',
  },
  {
    path: '/judge',
    title: brand.terms.judgeNav,
    what: `${brand.terms.judgeQuiz}的记录：每道题的答案、把握度和准确率。`,
    bullet: '先只记不拦，攒满 50 条且准确率过线才真拦',
    link: '现在先看定时任务',
    href: '/schedules',
  },
] as const;

function renderSoon(path: string): HTMLElement {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={<Soon />} />
      </Routes>
    </MemoryRouter>,
  );
  const root = view.container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error('占位页没有根节点');
  return root;
}

/** 别的页用的那套标题区外框，占位页的根节点要和它对上。 */
function pageRootClass(): string {
  const view = render(<Page title="对照">正文</Page>);
  const root = view.container.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error('Page 没有根节点');
  const cls = root.className;
  view.unmount();
  return cls;
}

describe('占位页标题区（#1534）', () => {
  test.each(PAGES)('$path 用和其他页一样的标题区，标题在左上，根节点不垂直居中', (page) => {
    const root = renderSoon(page.path);
    expect(root.className).toBe(pageRootClass());
    expect(root.className).not.toMatch(/min-h-full|place-items-center|justify-center/);
    const header = root.firstElementChild;
    expect(header?.tagName).toBe('HEADER');
    const h1 = screen.getByRole('heading', { level: 1, name: page.title });
    expect(h1.closest('header')).toBe(header);
    expect(header?.textContent).toContain(page.what);
  });

  test.each(PAGES)('$path 的计划要点和返回入口留在标题区下面，不再是整页居中的窄栏', (page) => {
    const root = renderSoon(page.path);
    expect(root.querySelector('.max-w-xl')).toBeNull();
    const header = root.querySelector('header');
    if (!(header instanceof HTMLElement)) throw new Error(`${page.path} 没有标题区`);
    const bullet = screen.getByText(page.bullet);
    const back = screen.getByRole('link', { name: '回主页' });
    const related = screen.getByRole('link', { name: page.link });
    expect(related.getAttribute('href')).toBe(page.href);
    expect(back.getAttribute('href')).toBe('/');
    const after = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(header.compareDocumentPosition(bullet) & after).toBe(after);
    expect(header.compareDocumentPosition(related) & after).toBe(after);
    expect(header.compareDocumentPosition(back) & after).toBe(after);
    expect(screen.getByText('这一页还没做')).toBeTruthy();
    expect(screen.getByText('做好以后会有：')).toBeTruthy();
  });
});
