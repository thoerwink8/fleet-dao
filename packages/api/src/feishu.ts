// 飞书账号登录（企业自建应用的网页应用能力）。按开放平台文档：
// - 授权页：https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code
// - 换 user_access_token（v3 令牌端点）：https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3
// - 取用户信息：https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get
// - 客户端内免登：前端 tt.requestAccess 拿 code（3 分钟有效、一次性），后端用同一个令牌端点换，不带 redirect_uri 和 code_verifier。
// user_access_token 只用来取一次身份，不存。
import { z } from 'zod';
import type { FeishuAuth, FeishuIdentity } from './ports.ts';

export const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
export const FEISHU_TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token';
// 带 PKCE 的浏览器登录只能用 v2 令牌端点换：飞书授权页文档写明「使用 PKCE 时暂时搭配 v2 换取 Token，后续支持最新端点」，
// 拿 v3 换会报 20049「PKCE code challenge failed」（2026-09-26 线上实测）。v2 只收 JSON 请求体。
export const FEISHU_TOKEN_URL_PKCE = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
export const FEISHU_USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';

/** 飞书那边拒了（授权码无效、过期、用户没权限等）：让用户重新登录。 */
export class FeishuRejectedError extends Error {
  readonly feishuCode: number | string;
  constructor(feishuCode: number | string, message: string) {
    super(message);
    this.name = 'FeishuRejectedError';
    this.feishuCode = feishuCode;
  }
}

/** 飞书那边出错或连不上：不是用户的问题，稍后重试。 */
export class FeishuUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'FeishuUnavailableError';
  }
}

const TokenResponse = z.object({
  code: z.number(),
  access_token: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const UserInfoResponse = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      open_id: z.string().min(1),
      union_id: z.string().optional(),
      name: z.string(),
      avatar_url: z.string().optional(),
    })
    .optional(),
});

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;

export function createFeishuAuth(options: { appId: string; appSecret: string; fetch?: Fetch }): FeishuAuth {
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function call(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new FeishuUnavailableError('连不上飞书', err);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new FeishuUnavailableError(`飞书返回的不是 JSON（HTTP ${res.status}）`, err);
    }
    if (res.status >= 500) throw new FeishuUnavailableError(`飞书服务出错（HTTP ${res.status}）`);
    return body;
  }

  return {
    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL(FEISHU_AUTHORIZE_URL);
      url.searchParams.set('client_id', options.appId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },

    async identify({ code, redirectUri, codeVerifier }): Promise<FeishuIdentity> {
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: options.appId,
        client_secret: options.appSecret,
        code,
      });
      if (redirectUri) form.set('redirect_uri', redirectUri);
      if (codeVerifier) form.set('code_verifier', codeVerifier);
      const token = TokenResponse.safeParse(
        await call(
          codeVerifier ? FEISHU_TOKEN_URL_PKCE : FEISHU_TOKEN_URL,
          codeVerifier
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json; charset=utf-8' },
                body: JSON.stringify(Object.fromEntries(form)),
              }
            : {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: form.toString(),
              },
        ),
      );
      if (!token.success) throw new FeishuUnavailableError('飞书令牌接口返回的格式看不懂');
      if (token.data.code !== 0 || !token.data.access_token) {
        throw new FeishuRejectedError(
          token.data.code,
          `飞书拒绝了授权码：${token.data.error_description ?? token.data.error ?? token.data.code}`,
        );
      }

      const info = UserInfoResponse.safeParse(
        await call(FEISHU_USER_INFO_URL, {
          method: 'GET',
          headers: { authorization: `Bearer ${token.data.access_token}` },
        }),
      );
      if (!info.success) throw new FeishuUnavailableError('飞书用户信息接口返回的格式看不懂');
      if (info.data.code !== 0 || !info.data.data) {
        throw new FeishuRejectedError(info.data.code, `飞书不给用户信息：${info.data.msg ?? info.data.code}`);
      }
      const d = info.data.data;
      return { openId: d.open_id, unionId: d.union_id, name: d.name, avatarUrl: d.avatar_url };
    },
  };
}
