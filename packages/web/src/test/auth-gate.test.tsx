// @vitest-environment happy-dom
// 外壳的登录闸（routes/shell.tsx 的 AuthGate）：没确认登录就不把页面露出来（确认的那一下页面先挂上但看不见，确认失败就撤掉）。
// 401 说「要先登录」；别的失败（无权限 403、后端挂了、断网）说「没能确认登录」并给原因和重试，不冒充「没登录」也不冒充「已登录」。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { Me } from '../api/types';
import Shell from '../routes/shell';
import { renderApp } from './harness';

afterEach(cleanup);

const ME: Me = {
  user: { id: 'u-founder', displayName: '创始人', role: 'founder' },
  csrfToken: 'tok-1',
  env: { name: '测试机' },
};

/** 页面本体。 */
function Page() {
  return <p>页面内容</p>;
}

function app(me: FleetApi['me']) {
  const api = { ...createMockApi({ live: false }) } as FleetApi;
  Object.assign(api, { me });
  const subscribe = vi.spyOn(api, 'subscribe');
  const view = renderApp(
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Page />} />
      </Route>
    </Routes>,
    { api },
  );
  return { subscribe, ...view };
}

describe('登录闸：没确认登录，页面不露出来', () => {
  test('401：写「要先登录」，给去登录页的链接，没有重试按钮；页面不在 DOM 里、推送不连、外壳（导航）也不画', async () => {
    const { subscribe } = app(() => Promise.reject(new ApiError(401, 'unauthenticated', '要先登录')));
    expect(await screen.findByText('要先登录，正在跳到登录页…')).toBeTruthy();
    expect(screen.getByRole('link', { name: '去登录页' }).getAttribute('href')).toMatch(/^\/login\?next=/);
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.queryByText('页面内容')).toBeNull();
    expect(screen.queryByText('通知中心')).toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】无权限（403）：不当成「要先登录」，写「没能确认登录」和后端的原因，给重试，页面照样不露', async () => {
    app(() => Promise.reject(new ApiError(403, 'forbidden', '驾驶舱只放行创始人')));
    expect(await screen.findByText('没能确认登录')).toBeTruthy();
    expect(screen.getByText('驾驶舱只放行创始人')).toBeTruthy();
    expect(screen.queryByText(/正在跳到登录页/)).toBeNull();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '去登录页' })).toBeTruthy();
    expect(screen.queryByText('页面内容')).toBeNull();
  });

  test('【故意造出的失败】后端挂了（502）：同样写没能确认，点重试再问一次；这回好了，页面才露出来', async () => {
    const me = vi
      .fn<FleetApi['me']>()
      .mockRejectedValueOnce(new ApiError(502, 'bad_gateway', '网关没连上后端'))
      .mockResolvedValue(ME);
    const { subscribe } = app(me);
    expect(await screen.findByText('网关没连上后端')).toBeTruthy();
    expect(screen.queryByText('页面内容')).toBeNull();
    expect(subscribe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('页面内容')).toBeTruthy();
    expect(me).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('没能确认登录')).toBeNull();
    await waitFor(() => expect(subscribe).toHaveBeenCalled());
  });

  test('【故意造出的失败】重试还是失败：仍写没能确认，不冒充登录好了', async () => {
    const me = vi.fn<FleetApi['me']>(() =>
      Promise.reject(new ApiError(0, 'network', '连不上驾驶舱后端：Failed to fetch')),
    );
    app(me);
    expect(await screen.findByText(/连不上驾驶舱后端/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(me).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('没能确认登录')).toBeTruthy();
    expect(screen.queryByText('页面内容')).toBeNull();
  });

  test('已登录：页面和外壳都在，没有「确认登录」的遮罩，推送连上了', async () => {
    const { subscribe } = app(() => Promise.resolve(ME));
    expect(await screen.findByText('页面内容')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('正在确认登录…')).toBeNull());
    expect(screen.queryByText('没能确认登录')).toBeNull();
    await waitFor(() => expect(subscribe).toHaveBeenCalled());
  });
});
