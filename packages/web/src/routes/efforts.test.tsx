// @vitest-environment happy-dom
// 旧地址 /efforts 转到路由页的「思考档位」页签（#1914 第 5 轮，思考档位并进路由页），查询串里别的参数和 hash 留着；
// 侧栏不再单列「思考档位」，但路由的说明里写着档位在这里改。
import { cleanup, screen } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import { NAV_ITEMS } from '../components/shell/nav';
import EffortsRedirect from '../routes/efforts';
import { renderApp } from '../test/harness';

afterEach(cleanup);

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{`${loc.pathname}${loc.search}${loc.hash}`}</p>;
}

describe('/efforts', () => {
  test('转到 /routing?tab=efforts，别的查询参数和 hash 留着（不留死链）', async () => {
    renderApp(
      <>
        <Where />
        <Routes>
          <Route path="efforts" element={<EffortsRedirect />} />
          <Route path="routing" element={<p>到了路由页</p>} />
        </Routes>
      </>,
      { route: '/efforts?node=wsl#x' },
    );
    expect(await screen.findByText('到了路由页')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/routing?node=wsl&tab=efforts#x');
  });

  test('没带参数也转到「思考档位」页签', async () => {
    renderApp(
      <>
        <Where />
        <Routes>
          <Route path="efforts" element={<EffortsRedirect />} />
          <Route path="routing" element={<p>到了路由页</p>} />
        </Routes>
      </>,
      { route: '/efforts' },
    );
    expect(await screen.findByText('到了路由页')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/routing?tab=efforts');
  });

  test('侧栏不再单列「思考档位」；路由那一项的说明写着档位也在这里改', () => {
    expect(NAV_ITEMS.some((n) => n.to === '/efforts' || n.label === '思考档位')).toBe(false);
    expect(NAV_ITEMS.find((n) => n.to === '/routing')?.hint).toContain('思考档位');
  });
});
