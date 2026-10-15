// @vitest-environment happy-dom
// 看板按顶栏当前项目收：画布只画这一仓的单，两个抽屉只列这一仓；没在跑的仓出空状态；刷新后还是上次选的。
// 排版用固定坐标（happy-dom 量不出，ELK 的 Worker 在这里也不稳），要看的是筛完还画不画。
import { cleanup, configure, fireEvent, screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createMockApi } from '../api/mock/server';
import { RepoSwitcher } from '../components/shell/repo-switcher';
import BoardPage from '../routes/board';
import { renderApp } from './harness';

configure({ asyncUtilTimeout: 10_000 });

vi.mock('../components/home/board/layout', () => ({
  layoutGraph: async (graph: { nodes: { id: string }[] }) =>
    new Map(graph.nodes.map((n, i) => [n.id, { x: i * 20, y: 0 }])),
}));

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, kind, px]) =>
          kind === 'min' ? 1280 >= Number(px) : 1280 <= Number(px),
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
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function Page() {
  return (
    <Routes>
      <Route path="/board" element={<BoardPage />} />
      <Route path="/" element={<p>主页三块</p>} />
    </Routes>
  );
}

const switcher = () => screen.getByRole('button', { name: '切换项目' });

async function openSwitcher() {
  fireEvent.keyDown(switcher(), { key: 'Enter' });
  return screen.findByRole('menu');
}

async function pick(name: string) {
  const menu = await openSwitcher();
  fireEvent.click(within(menu).getByText(name));
}

describe('看板按当前项目', () => {
  test('来回切项目：画布和两个抽屉跟着变，空仓出空状态，整机读数还在', async () => {
    renderApp(
      <>
        <RepoSwitcher />
        <Page />
      </>,
      { api: createMockApi({ live: false }), route: '/board' },
    );

    expect((await screen.findAllByText('登录页加手机验证码')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('首页加定价区块')).toEqual([]);
    expect(screen.queryAllByText('主页三块')).toEqual([]);
    expect(screen.getByRole('button', { name: '要你拍的 2 条，打开抽屉' })).toBeTruthy();
    expect(screen.getByText('内存')).toBeTruthy();
    expect(screen.getByRole('button', { name: /引擎进程/ }).getAttribute('aria-label')).toContain('引擎进程');

    fireEvent.click(screen.getByRole('button', { name: '要你拍的 2 条，打开抽屉' }));
    expect((await screen.findAllByText('等你点头：发布 v2.3')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: /做完的/ }));
    expect((await screen.findAllByText('主页改成三块：要你拍的、在跑的、上线了的')).length).toBeGreaterThan(
      0,
    );

    await pick('website');
    expect((await screen.findAllByText('首页加定价区块')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('登录页加手机验证码')).toEqual([]);
    expect(screen.queryAllByText('主页三块')).toEqual([]);
    expect(screen.queryAllByText('等你点头：发布 v2.3')).toEqual([]);
    expect(screen.queryAllByText('主页改成三块：要你拍的、在跑的、上线了的')).toEqual([]);
    expect(screen.getByRole('button', { name: '要你拍的 0 条，打开抽屉' })).toBeTruthy();
    expect((await screen.findAllByText('移动端导航遮住了标题')).length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: /做完的/ }).textContent).toContain('1');
    expect(switcher().textContent).toContain('website');

    await pick('orbit-canary');
    expect((await screen.findAllByText('现在没有在跑的单')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('首页加定价区块')).toEqual([]);
    expect(screen.queryAllByText('登录页加手机验证码')).toEqual([]);
    expect(screen.queryAllByText('移动端导航遮住了标题')).toEqual([]);
    expect(screen.getByText('内存')).toBeTruthy();
    expect(screen.getByRole('button', { name: /引擎进程/ })).toBeTruthy();
    expect(screen.queryAllByText('主页三块')).toEqual([]);

    await pick('orbit');
    expect((await screen.findAllByText('登录页加手机验证码')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('现在没有在跑的单')).toEqual([]);
    expect(screen.queryAllByText('首页加定价区块')).toEqual([]);
    expect(screen.getByRole('button', { name: '要你拍的 2 条，打开抽屉' })).toBeTruthy();
  }, 20_000);

  test('刷新后仍是上次选的项目', async () => {
    localStorage.setItem('fleet-dao.repo', JSON.stringify('r-site'));
    renderApp(<Page />, { api: createMockApi({ live: false }), route: '/board' });
    expect((await screen.findAllByText('首页加定价区块')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('登录页加手机验证码')).toEqual([]);
    const open = screen.getByRole('button', { name: '要你拍的 0 条，打开抽屉' });
    fireEvent.click(open);
    expect(screen.queryAllByText('等你点头：发布 v2.3')).toEqual([]);
    expect(screen.getByText('没有要你拍的')).toBeTruthy();
  });
});
