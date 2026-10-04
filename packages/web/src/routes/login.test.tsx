// @vitest-environment happy-dom
// 登录页：登录后只回站内路径（防开放重定向）、已登录直接送回去、免登和飞书登录失败时把原因写出来并留在登录页，
// 不假装登录成功。后端给的错误（无权限 403 等）原样显示。
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, type FleetApi } from '../api/client';
import { createMockApi } from '../api/mock/server';
import type { AuthConfig, Me } from '../api/types';
import { renderApp } from '../test/harness';
import LoginPage, { safeNext } from './login';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ME: Me = {
  user: { id: 'u-founder', displayName: '创始人', role: 'founder' },
  csrfToken: 'tok-1',
};

const unauthenticated = () => Promise.reject(new ApiError(401, 'unauthenticated', '要先登录'));

/** 一个「走真后端、还没登录」的假后端：me 回 401，登录配置可调。 */
function loggedOut(config: Partial<AuthConfig> | Error, over: Partial<FleetApi> = {}): FleetApi {
  const api = { ...createMockApi({ live: false }) } as FleetApi;
  Object.assign(api, {
    source: 'http',
    me: unauthenticated,
    authConfig: () =>
      config instanceof Error ? Promise.reject(config) : Promise.resolve({ devLogin: false, ...config }),
    ...over,
  });
  return api;
}

/** 登录页，再加一个「登录后落到哪」的页面，把落点的路径显示出来。 */
function Where() {
  const loc = useLocation();
  return <p data-testid="landed">{`${loc.pathname}${loc.search}`}</p>;
}
function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="*" element={<Where />} />
    </Routes>
  );
}

describe('safeNext：登录后回哪里，只认站内路径', () => {
  test.each([
    ['/tasks/t-1', '/tasks/t-1'],
    ['/audit?target=t-9', '/audit?target=t-9'],
    ['/settings#notify', '/settings#notify'],
  ])('站内路径 %s 原样放行', (input, out) => {
    expect(safeNext(input)).toBe(out);
  });

  test.each([
    ['没给', null],
    ['空串', ''],
    ['外站完整地址', 'https://evil.example/steal'],
    ['不带协议的外站（//）', '//evil.example/steal'],
    ['反斜杠绕过（/\\）', '/\\evil.example'],
    ['不是以 / 开头', 'tasks/t-1'],
    ['javascript 伪协议', 'javascript:alert(1)'],
    ['带换行的控制字符', '/ok\r\nSet-Cookie: x=1'],
    ['带空字符', '/ok\u0000'],
    ['登录页自己（回去就循环）', '/login'],
    ['登录页自己（带查询）', '/login?next=%2F'],
    ['太长', `/${'a'.repeat(1000)}`],
  ])('【故意造出的失败】%s：一律回首页', (_name, input) => {
    expect(safeNext(input)).toBe('/');
  });
});

describe('登录页：已登录、没登录', () => {
  test('已经登录：直接送回 next，不停在登录页', async () => {
    const api = loggedOut({ feishuAppId: 'cli_x' }, { me: () => Promise.resolve(ME) });
    renderApp(<App />, { api, route: '/login?next=%2Ftasks%2Ft-15' });
    expect((await screen.findByTestId('landed')).textContent).toBe('/tasks/t-15');
  });

  test('已经登录但 next 是外站：回首页，不跟着跳出去', async () => {
    const api = loggedOut({}, { me: () => Promise.resolve(ME) });
    renderApp(<App />, { api, route: '/login?next=https%3A%2F%2Fevil.example%2F' });
    expect((await screen.findByTestId('landed')).textContent).toBe('/');
  });

  test('没登录：给飞书登录的链接，带 next 回来；页面写明登录后回哪', async () => {
    renderApp(<App />, {
      api: loggedOut({ feishuAppId: 'cli_x' }),
      route: '/login?next=%2Faudit%3Ftarget%3Dt-9',
    });
    const link = await screen.findByRole('link', { name: /用飞书登录/ });
    expect(link.getAttribute('href')).toBe(
      `/auth/feishu/login?next=${encodeURIComponent('/audit?target=t-9')}`,
    );
    expect(screen.getByText('/audit?target=t-9')).toBeTruthy();
    expect(screen.queryByTestId('landed')).toBeNull();
  });

  test('【故意造出的失败】next 是外站：飞书登录链接里的 next 也被换成 /', async () => {
    renderApp(<App />, {
      api: loggedOut({ feishuAppId: 'cli_x' }),
      route: '/login?next=%2F%2Fevil.example%2Fsteal',
    });
    const link = await screen.findByRole('link', { name: /用飞书登录/ });
    expect(link.getAttribute('href')).toBe('/auth/feishu/login?next=%2F');
  });

  test('【故意造出的失败】后端没配飞书登录：写「还没配置」，登录按钮点不了、不给链接', async () => {
    renderApp(<App />, { api: loggedOut({}), route: '/login' });
    expect(await screen.findByText('飞书登录还没配置。')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /用飞书登录/ })).toBeNull();
    expect(screen.getByRole('button', { name: /用飞书登录/ })).toHaveProperty('disabled', true);
  });

  test('【故意造出的失败】读不到登录配置：写「连不上…后端」和原因，不冒充「没配置」', async () => {
    renderApp(<App />, {
      api: loggedOut(new ApiError(502, 'bad_gateway', '网关没连上后端')),
      route: '/login',
    });
    expect((await screen.findByText(/连不上.*后端：网关没连上后端/)).textContent).toContain('网关没连上后端');
    expect(screen.queryByText('飞书登录还没配置。')).toBeNull();
  });

  test('假数据模式：不用登录，点一下进 next', async () => {
    const api = { ...createMockApi({ live: false }) } as FleetApi;
    Object.assign(api, { me: unauthenticated });
    renderApp(<App />, { api, route: '/login?next=%2Fquota' });
    fireEvent.click(await screen.findByRole('button', { name: /^进/ }));
    expect((await screen.findByTestId('landed')).textContent).toBe('/quota');
  });
});

describe('开发环境免登', () => {
  const type = (value: string) => fireEvent.change(screen.getByLabelText(/用户编号/), { target: { value } });
  const submit = () => fireEvent.click(screen.getByRole('button', { name: '免登' }));

  test('填编号点免登：devLogin 收到去掉空白的编号，成功后落到 next', async () => {
    const devLogin = vi.fn(() => Promise.resolve(ME));
    renderApp(<App />, {
      api: loggedOut({ devLogin: true }, { devLogin }),
      route: '/login?next=%2Fsettings',
    });
    await screen.findByLabelText(/用户编号/);
    type('  u-founder  ');
    submit();
    expect((await screen.findByTestId('landed')).textContent).toBe('/settings');
    expect(devLogin).toHaveBeenCalledExactlyOnceWith('u-founder');
  });

  test('没填编号：免登按钮点不了，不发请求', async () => {
    const devLogin = vi.fn(() => Promise.resolve(ME));
    renderApp(<App />, { api: loggedOut({ devLogin: true }, { devLogin }), route: '/login' });
    await screen.findByLabelText(/用户编号/);
    expect(screen.getByRole('button', { name: '免登' })).toHaveProperty('disabled', true);
    type('   ');
    expect(screen.getByRole('button', { name: '免登' })).toHaveProperty('disabled', true);
    fireEvent.submit(screen.getByLabelText(/用户编号/).closest('form') as HTMLFormElement);
    expect(devLogin).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】不在白名单（403）：留在登录页，原样写后端的话，按钮恢复，不跳走', async () => {
    const devLogin = vi.fn(() => Promise.reject(new ApiError(403, 'forbidden', '这个编号不在白名单里')));
    renderApp(<App />, { api: loggedOut({ devLogin: true }, { devLogin }), route: '/login' });
    await screen.findByLabelText(/用户编号/);
    type('u-stranger');
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe('这个编号不在白名单里');
    expect(screen.queryByTestId('landed')).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '免登' })).toHaveProperty('disabled', false),
    );
    expect(devLogin).toHaveBeenCalledTimes(1);
  });

  test('【故意造出的失败】断网：写「连不上驾驶舱后端」，不跳走', async () => {
    const devLogin = vi.fn(() =>
      Promise.reject(new ApiError(0, 'network', '连不上驾驶舱后端：Failed to fetch')),
    );
    renderApp(<App />, { api: loggedOut({ devLogin: true }, { devLogin }), route: '/login' });
    await screen.findByLabelText(/用户编号/);
    type('u-founder');
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain('连不上驾驶舱后端');
    expect(screen.queryByTestId('landed')).toBeNull();
  });
});

describe('在飞书客户端里：不用点，直接拿飞书身份换登录态', () => {
  const tt = (impl: (o: { success(r: { code: string }): void; fail(e: unknown): void }) => void) =>
    vi.stubGlobal('tt', { requestAccess: vi.fn(impl) });

  test('授权给了 code：feishuAccess 收到这个 code，成功落到 next', async () => {
    tt((o) => o.success({ code: 'code-1' }));
    const feishuAccess = vi.fn(() => Promise.resolve(ME));
    renderApp(<App />, {
      api: loggedOut({ feishuAppId: 'cli_x' }, { feishuAccess }),
      route: '/login?next=%2Fnotifications',
    });
    expect((await screen.findByTestId('landed')).textContent).toBe('/notifications');
    expect(feishuAccess).toHaveBeenCalledExactlyOnceWith('code-1');
  });

  test('【故意造出的失败】飞书没给授权：写明可以点按钮重新登录，不换登录态', async () => {
    tt((o) => o.fail({ errno: 1 }));
    const feishuAccess = vi.fn(() => Promise.resolve(ME));
    renderApp(<App />, { api: loggedOut({ feishuAppId: 'cli_x' }, { feishuAccess }), route: '/login' });
    expect((await screen.findByRole('alert')).textContent).toContain('飞书没给授权');
    expect(feishuAccess).not.toHaveBeenCalled();
    expect(screen.queryByTestId('landed')).toBeNull();
    // 回到可以手点的状态：飞书登录链接又出来了
    expect(await screen.findByRole('link', { name: /用飞书登录/ })).toBeTruthy();
  });

  test('【故意造出的失败】换登录态被拒（后端说不放行）：写后端的原因，不跳走', async () => {
    tt((o) => o.success({ code: 'code-2' }));
    const feishuAccess = vi.fn(() => Promise.reject(new ApiError(403, 'forbidden', '驾驶舱只放行创始人')));
    renderApp(<App />, { api: loggedOut({ feishuAppId: 'cli_x' }, { feishuAccess }), route: '/login' });
    expect((await screen.findByRole('alert')).textContent).toBe('驾驶舱只放行创始人');
    expect(screen.queryByTestId('landed')).toBeNull();
    expect(feishuAccess).toHaveBeenCalledTimes(1);
  });
});
