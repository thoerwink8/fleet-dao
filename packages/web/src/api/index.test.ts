// @vitest-environment happy-dom
// 没登录时跳登录页的那一步（getApi 里的 onUnauthorized）：只有 401 才跳、已经在登录页不再跳（否则登录页自己读不到 /api/me
// 就无限刷新），其余失败（无权限 403、后端 500、断网）一律不跳、把错误原样交给页面显示，不吞。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ME = {
  user: { id: 'u-a', displayName: '甲', role: 'founder' },
  csrfToken: 'tok-1',
  env: { name: '测试机' },
};

/** 换掉全局的 location 和 fetch：fetch 对 /api/me 回指定的状态。 */
function setup(at: { pathname: string; search?: string }, reply: { status: number; body?: unknown }) {
  const assign = vi.fn();
  vi.stubGlobal('location', { pathname: at.pathname, search: at.search ?? '', assign });
  const fetchMock = vi.fn(
    async () =>
      new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { assign, fetchMock };
}

async function freshApi() {
  vi.resetModules();
  return await import('./index');
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loginPath：登录后要回到哪', () => {
  test('带上 next，路径里的 ? & # 都转义，登录后能原样回来', async () => {
    const { loginPath } = await freshApi();
    expect(loginPath('/tasks/t-1?tab=usage&x=1')).toBe(
      `/login?next=${encodeURIComponent('/tasks/t-1?tab=usage&x=1')}`,
    );
    expect(loginPath('/')).toBe('/login?next=%2F');
  });

  test('不给就取当前页面的路径和查询', async () => {
    setup({ pathname: '/audit', search: '?target=t-9' }, { status: 200, body: ME });
    const { loginPath } = await freshApi();
    expect(loginPath()).toBe(`/login?next=${encodeURIComponent('/audit?target=t-9')}`);
  });
});

describe('getApi：401 才跳登录页', () => {
  test('401（没登录或登录过期）：跳到 /login，next 是当前页，错误照样抛给调用方', async () => {
    const { assign } = setup(
      { pathname: '/tasks/t-15', search: '?a=1' },
      { status: 401, body: { error: { code: 'unauthenticated', message: '要先登录' } } },
    );
    const { getApi } = await freshApi();
    const err = await getApi()
      .me()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, code: 'unauthenticated', message: '要先登录' });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/tasks/t-15?a=1')}`);
  });

  test('已经在登录页：401 不再跳（不然登录页读不到登录态就无限刷新）', async () => {
    const { assign } = setup(
      { pathname: '/login', search: '?next=%2F' },
      { status: 401, body: { error: { code: 'unauthenticated', message: '要先登录' } } },
    );
    const { getApi } = await freshApi();
    await expect(getApi().me()).rejects.toMatchObject({ status: 401 });
    expect(assign).not.toHaveBeenCalled();
  });

  test.each([
    [403, 'forbidden', '你没有这个权限'],
    [500, 'internal', '后端出错了'],
    [502, 'bad_gateway', '网关没连上后端'],
  ])('【故意造出的失败】%i：不跳登录页，错误（%s）原样抛出，不当成没事', async (status, code, message) => {
    const { assign } = setup({ pathname: '/settings' }, { status, body: { error: { code, message } } });
    const { getApi } = await freshApi();
    await expect(getApi().me()).rejects.toMatchObject({ status, code, message });
    expect(assign).not.toHaveBeenCalled();
  });

  test('【故意造出的失败】断网：报「连不上驾驶舱后端」，不跳登录页', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/', search: '', assign });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const { getApi } = await freshApi();
    await expect(getApi().me()).rejects.toMatchObject({
      status: 0,
      code: 'network',
      message: expect.stringContaining('连不上驾驶舱后端'),
    });
    expect(assign).not.toHaveBeenCalled();
  });

  test('整个页面只有一份 api（跳登录页的回调只挂一次）', async () => {
    setup({ pathname: '/' }, { status: 200, body: ME });
    const { getApi } = await freshApi();
    expect(getApi()).toBe(getApi());
    expect(getApi().source).toBe('http');
  });
});
