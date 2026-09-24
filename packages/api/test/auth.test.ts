import { createHash } from 'node:crypto';
import { AuthConfigResponse, MeResponse } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { safeNext } from '../src/auth.ts';
import {
  cookieHeader,
  DEV_USER_ID,
  errorCode,
  FOUNDER_A_CODE,
  harness,
  PUBLIC_ORIGIN,
  STRANGER_CODE,
  setCookies,
  write,
} from './harness.ts';

/** 浏览器登录的前半段：拿到飞书授权页地址和暂存 Cookie。 */
async function startBrowserLogin(h: ReturnType<typeof harness>, next = '/tasks/task-12') {
  const res = await h.cockpit.request(`/auth/feishu/login?next=${encodeURIComponent(next)}`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '');
  return { location, state: location.searchParams.get('state') ?? '', cookie: cookieHeader(res), res };
}

describe('飞书浏览器登录（授权码 + PKCE）', () => {
  it('白名单里的人登录后拿到 HttpOnly 会话 Cookie，跳回原来要去的页', async () => {
    const h = harness();
    const { location, state, cookie, res } = await startBrowserLogin(h);
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC_ORIGIN}/auth/feishu/callback`);
    const oauthCookie = setCookies(res).find((c) => c.startsWith('__Host-fleet_oauth='));
    expect(oauthCookie).toMatch(/HttpOnly/);
    expect(oauthCookie).toMatch(/Secure/);
    expect(oauthCookie).toMatch(/SameSite=Lax/);

    const cb = await h.cockpit.request(`/auth/feishu/callback?code=${FOUNDER_A_CODE}&state=${state}`, {
      headers: { cookie },
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/tasks/task-12');
    const session = setCookies(cb).find((c) => c.startsWith('__Host-fleet_session='));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\//);

    // PKCE：换令牌时带的 verifier 算出来的 challenge 等于授权页上的那个。
    const call = h.feishuCalls.at(-1);
    expect(call?.redirectUri).toBe(`${PUBLIC_ORIGIN}/auth/feishu/callback`);
    const challenge = createHash('sha256')
      .update(call?.codeVerifier ?? '')
      .digest('base64url');
    expect(challenge).toBe(location.searchParams.get('code_challenge'));

    const me = await h.cockpit.request('/api/me', { headers: { cookie: cookieHeader(cb) } });
    expect(me.status).toBe(200);
    expect(MeResponse.parse(await me.json()).user.id).toBe(DEV_USER_ID);
    expect(h.store.data.audit.at(-1)).toMatchObject({ action: 'login', ok: true });
  });

  it('不在白名单的飞书账号：403，不发会话 Cookie，操作记录里留一条被拒', async () => {
    const h = harness();
    const { state, cookie } = await startBrowserLogin(h);
    const cb = await h.cockpit.request(`/auth/feishu/callback?code=${STRANGER_CODE}&state=${state}`, {
      headers: { cookie },
    });
    expect(cb.status).toBe(403);
    expect(await cb.text()).toContain('不在白名单');
    expect(setCookies(cb).some((c) => c.startsWith('__Host-fleet_session='))).toBe(false);
    expect(h.store.data.audit.at(-1)).toMatchObject({ action: 'login', ok: false, error: 'not_whitelisted' });
  });

  it('state 对不上（或没有暂存 Cookie）：拒绝，且不去飞书换令牌', async () => {
    const h = harness();
    const { cookie } = await startBrowserLogin(h);
    const wrong = await h.cockpit.request(`/auth/feishu/callback?code=${FOUNDER_A_CODE}&state=forged`, {
      headers: { cookie },
    });
    expect(wrong.status).toBe(400);
    const noCookie = await h.cockpit.request(`/auth/feishu/callback?code=${FOUNDER_A_CODE}&state=x`);
    expect(noCookie.status).toBe(400);
    expect(h.feishuCalls).toHaveLength(0);
  });

  it('暂存 Cookie 只能用一次、10 分钟过期', async () => {
    const h = harness();
    const { state, cookie } = await startBrowserLogin(h);
    h.clock.now = new Date(h.clock.now.getTime() + 11 * 60_000);
    const late = await h.cockpit.request(`/auth/feishu/callback?code=${FOUNDER_A_CODE}&state=${state}`, {
      headers: { cookie },
    });
    expect(late.status).toBe(400);
    expect(setCookies(late).some((c) => c.startsWith('__Host-fleet_oauth=;'))).toBe(true);
  });

  it('用户在飞书授权页点了拒绝：401 页面', async () => {
    const h = harness();
    const { state, cookie } = await startBrowserLogin(h);
    const cb = await h.cockpit.request(`/auth/feishu/callback?error=access_denied&state=${state}`, {
      headers: { cookie },
    });
    expect(cb.status).toBe(401);
  });

  it('飞书登录没配置时返回 503', async () => {
    const h = harness({ feishu: null, config: { feishu: null } });
    expect((await h.cockpit.request('/auth/feishu/login')).status).toBe(503);
  });

  it('登录后跳回的地址只许站内路径', () => {
    expect(safeNext('/tasks/1?x=2')).toBe('/tasks/1?x=2');
    for (const bad of [
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      'evil',
      '/a\nb',
      undefined,
    ]) {
      expect(safeNext(bad)).toBe('/');
    }
  });
});

describe('飞书客户端内免登（requestAccess）', () => {
  it('白名单里的人直接拿到登录态和 CSRF 令牌；换令牌时不带 redirect_uri 和 verifier', async () => {
    const h = harness();
    const { csrf, cookie } = await h.login();
    expect(csrf.length).toBeGreaterThan(20);
    expect(cookie).toMatch(/^__Host-fleet_session=/);
    expect(h.feishuCalls.at(-1)).toEqual({ code: FOUNDER_A_CODE });
  });

  it('不在白名单、账号停用、机器人：都进不来', async () => {
    const h = harness();
    const post = (code: string) =>
      h.cockpit.request('/auth/feishu/access', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: PUBLIC_ORIGIN },
        body: JSON.stringify({ code }),
      });
    expect(await errorCode(await post(STRANGER_CODE))).toBe('not_whitelisted');

    const founder = h.store.data.users.find((u) => u.id === DEV_USER_ID);
    if (!founder) throw new Error('样例数据里没有创始人甲');
    founder.active = false;
    expect((await post(FOUNDER_A_CODE)).status).toBe(403);

    founder.active = true;
    founder.role = 'bot';
    expect((await post(FOUNDER_A_CODE)).status).toBe(403);
  });

  it('飞书拒了授权码：401；来源不是驾驶舱：403', async () => {
    const h = harness();
    const bad = await h.cockpit.request('/auth/feishu/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ code: 'code-unknown' }),
    });
    expect(bad.status).toBe(401);
    const foreign = await h.cockpit.request('/auth/feishu/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ code: FOUNDER_A_CODE }),
    });
    expect(await errorCode(foreign)).toBe('csrf_origin');
    expect(h.feishuCalls).toHaveLength(1);
  });
});

describe('会话', () => {
  it('没登录、Cookie 被改过、过期：401；从白名单拿掉：下一个请求就 403', async () => {
    const h = harness();
    expect(await errorCode(await h.cockpit.request('/api/me'))).toBe('unauthenticated');

    const { cookie } = await h.login();
    // 改载荷（换成别人的编号也一样）：签名对不上。
    const tampered = cookie.replace('=ey', '=fy');
    expect(tampered).not.toBe(cookie);
    expect((await h.cockpit.request('/api/me', { headers: { cookie: tampered } })).status).toBe(401);
    // 只改签名最后一个字符的填充位（解码后字节不变）：也不认。
    const last = cookie.at(-1) === 'A' ? 'B' : 'A';
    const padded = cookie.slice(0, -1) + last;
    expect((await h.cockpit.request('/api/me', { headers: { cookie: padded } })).status).toBe(401);

    const founder = h.store.data.users.find((u) => u.id === DEV_USER_ID);
    if (!founder) throw new Error('样例数据里没有创始人甲');
    founder.active = false;
    expect(await errorCode(await h.cockpit.request('/api/me', { headers: { cookie } }))).toBe(
      'not_whitelisted',
    );
    founder.active = true;

    h.clock.now = new Date(h.clock.now.getTime() + 15 * 24 * 60 * 60_000);
    expect((await h.cockpit.request('/api/me', { headers: { cookie } })).status).toBe(401);
  });

  it('退出：清掉 Cookie，并留操作记录', async () => {
    const h = harness();
    const session = await h.login();
    const res = await h.cockpit.request('/auth/logout', write('POST', session));
    expect(res.status).toBe(204);
    expect(setCookies(res).some((c) => /^__Host-fleet_session=;.*Max-Age=0/.test(c))).toBe(true);
    expect(h.store.data.audit.at(-1)).toMatchObject({ action: 'logout', ok: true });
  });

  it('http 的开发地址不用 __Host- 前缀、不加 Secure（不然浏览器存不下）', async () => {
    const h = harness({ config: { cookieSecure: false, publicUrl: new URL('http://localhost:5173') } });
    const res = await h.cockpit.request('/auth/feishu/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ code: FOUNDER_A_CODE }),
    });
    const session = setCookies(res).find((c) => c.startsWith('fleet_session='));
    expect(session).toBeDefined();
    expect(session).not.toMatch(/Secure/);
  });
});

describe('CSRF', () => {
  const body = { value: 7, version: 1 };

  it('写操作缺令牌、令牌错、拿别人的令牌：都 403', async () => {
    const h = harness();
    const a = await h.login();
    const b = await h.login();
    const put = (headers: Record<string, string>) =>
      h.cockpit.request('/api/settings/sessions.maxConcurrent', {
        method: 'PUT',
        headers: { cookie: a.cookie, 'content-type': 'application/json', origin: PUBLIC_ORIGIN, ...headers },
        body: JSON.stringify(body),
      });
    expect(await errorCode(await put({}))).toBe('csrf_token');
    expect(await errorCode(await put({ 'x-csrf-token': 'guess' }))).toBe('csrf_token');
    expect(await errorCode(await put({ 'x-csrf-token': b.csrf }))).toBe('csrf_token');
    expect((await put({ 'x-csrf-token': a.csrf })).status).toBe(200);
  });

  it('令牌对但来源不对：403', async () => {
    const h = harness();
    const s = await h.login();
    const foreign = await h.cockpit.request(
      '/api/settings/sessions.maxConcurrent',
      write('PUT', s, body, { origin: 'https://evil.example' }),
    );
    expect(await errorCode(foreign)).toBe('csrf_origin');
    const init = write('PUT', s, body, { 'sec-fetch-site': 'cross-site' });
    delete (init.headers as Record<string, string>).origin;
    expect(await errorCode(await h.cockpit.request('/api/settings/sessions.maxConcurrent', init))).toBe(
      'csrf_origin',
    );
  });

  it('读操作不要令牌', async () => {
    const h = harness();
    const { cookie } = await h.login();
    expect((await h.cockpit.request('/api/settings', { headers: { cookie } })).status).toBe(200);
  });
});

describe('开发环境免登', () => {
  it('没打开时这个入口不存在', async () => {
    const h = harness();
    const res = await h.cockpit.request('/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: DEV_USER_ID }),
    });
    expect(res.status).toBe(404);
    const config = AuthConfigResponse.parse(await (await h.cockpit.request('/auth/config')).json());
    expect(config).toEqual({ feishuAppId: 'cli_test_app', devLogin: false });
  });

  it('打开时仍只放白名单里的人', async () => {
    const h = harness({ config: { devLogin: true } });
    const post = (userId: string) =>
      h.cockpit.request('/auth/dev-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
    const ok = await post(DEV_USER_ID);
    expect(ok.status).toBe(200);
    expect(MeResponse.parse(await ok.json()).user.id).toBe(DEV_USER_ID);
    expect((await post('u-bot-worker')).status).toBe(403);
    expect((await post('nobody')).status).toBe(403);
  });
});
