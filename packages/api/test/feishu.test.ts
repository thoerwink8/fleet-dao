import { describe, expect, it } from 'vitest';
import {
  createFeishuAuth,
  FEISHU_TOKEN_URL,
  FEISHU_TOKEN_URL_PKCE,
  FEISHU_USER_INFO_URL,
  FeishuRejectedError,
  FeishuUnavailableError,
} from '../src/feishu.ts';

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(responses: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const make = responses[url];
    if (!make) throw new TypeError('fetch failed');
    return make();
  };
  return { fetch, calls };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const okToken = json({ code: 0, access_token: 'u-token', expires_in: 7200, token_type: 'Bearer' });
const okUser = json({
  code: 0,
  msg: 'success',
  data: { open_id: 'ou_1', union_id: 'on_1', name: '甲', avatar_url: 'https://a', email: 'x@y' },
});

describe('飞书登录客户端', () => {
  it('授权页地址带 client_id、回调地址、state 和 S256 的 PKCE', () => {
    const auth = createFeishuAuth({ appId: 'cli_x', appSecret: 's' });
    const url = new URL(
      auth.authorizeUrl({
        redirectUri: 'https://c.test/auth/feishu/callback',
        state: 'st',
        codeChallenge: 'ch',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cli_x',
      response_type: 'code',
      redirect_uri: 'https://c.test/auth/feishu/callback',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('浏览器登录（PKCE）：走 v2 令牌端点、JSON 请求体（v3 会报 20049），再用令牌取身份；邮箱不往外带', async () => {
    const { fetch, calls } = fakeFetch({ [FEISHU_TOKEN_URL_PKCE]: okToken, [FEISHU_USER_INFO_URL]: okUser });
    const auth = createFeishuAuth({ appId: 'cli_x', appSecret: 'sec', fetch });
    const identity = await auth.identify({
      code: 'c1',
      redirectUri: 'https://c.test/cb',
      codeVerifier: 'v'.repeat(43),
    });
    expect(identity).toEqual({ openId: 'ou_1', unionId: 'on_1', name: '甲', avatarUrl: 'https://a' });
    expect(String(calls[0]?.url)).toBe(FEISHU_TOKEN_URL_PKCE);
    expect(new Headers(calls[0]?.init?.headers).get('content-type')).toMatch(/application\/json/);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'cli_x',
      client_secret: 'sec',
      code: 'c1',
      redirect_uri: 'https://c.test/cb',
      code_verifier: 'v'.repeat(43),
    });
    expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe('Bearer u-token');
  });

  it('客户端内免登：不带回调地址和 verifier', async () => {
    const { fetch, calls } = fakeFetch({ [FEISHU_TOKEN_URL]: okToken, [FEISHU_USER_INFO_URL]: okUser });
    await createFeishuAuth({ appId: 'cli_x', appSecret: 'sec', fetch }).identify({ code: 'c2' });
    const form = new URLSearchParams(String(calls[0]?.init?.body));
    expect(form.has('redirect_uri')).toBe(false);
    expect(form.has('code_verifier')).toBe(false);
  });

  it('飞书拒了授权码（400 + 错误码）：FeishuRejectedError；用户信息拿不到也是', async () => {
    const rejectedToken = fakeFetch({
      [FEISHU_TOKEN_URL]: json(
        { code: 20003, error: 'invalid_grant', error_description: 'code not found' },
        400,
      ),
    });
    await expect(
      createFeishuAuth({ appId: 'a', appSecret: 'b', fetch: rejectedToken.fetch }).identify({ code: 'x' }),
    ).rejects.toBeInstanceOf(FeishuRejectedError);
    const resigned = fakeFetch({
      [FEISHU_TOKEN_URL]: okToken,
      [FEISHU_USER_INFO_URL]: json({ code: 20021, msg: 'User resigned' }),
    });
    await expect(
      createFeishuAuth({ appId: 'a', appSecret: 'b', fetch: resigned.fetch }).identify({ code: 'x' }),
    ).rejects.toBeInstanceOf(FeishuRejectedError);
  });

  it('连不上、5xx、返回的不是 JSON：FeishuUnavailableError（不是用户的错）', async () => {
    const down = fakeFetch({});
    await expect(
      createFeishuAuth({ appId: 'a', appSecret: 'b', fetch: down.fetch }).identify({ code: 'x' }),
    ).rejects.toBeInstanceOf(FeishuUnavailableError);
    const busy = fakeFetch({
      [FEISHU_TOKEN_URL]: json({ code: 20072, error: 'temporarily_unavailable' }, 503),
    });
    await expect(
      createFeishuAuth({ appId: 'a', appSecret: 'b', fetch: busy.fetch }).identify({ code: 'x' }),
    ).rejects.toBeInstanceOf(FeishuUnavailableError);
    const html = fakeFetch({ [FEISHU_TOKEN_URL]: () => new Response('<html>', { status: 502 }) });
    await expect(
      createFeishuAuth({ appId: 'a', appSecret: 'b', fetch: html.fetch }).identify({ code: 'x' }),
    ).rejects.toBeInstanceOf(FeishuUnavailableError);
  });
});
