// @vitest-environment happy-dom
// 旧地址 /models 转到路由页的模型目录标签，查询串里别的参数和 hash 留着。
import { cleanup, screen } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, test } from 'vitest';
import ModelsRedirect from '../routes/models';
import { renderApp } from '../test/harness';

afterEach(cleanup);

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{`${loc.pathname}${loc.search}${loc.hash}`}</p>;
}

describe('/models', () => {
  test('转到 /routing?tab=models，别的查询参数和 hash 留着', async () => {
    renderApp(
      <>
        <Where />
        <Routes>
          <Route path="models" element={<ModelsRedirect />} />
          <Route path="routing" element={<p>到了路由页</p>} />
        </Routes>
      </>,
      { route: '/models?node=wsl#catalog' },
    );
    expect(await screen.findByText('到了路由页')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/routing?node=wsl&tab=models#catalog');
  });
});
