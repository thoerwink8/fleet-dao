// 驾驶舱登录态：HttpOnly Cookie（自签，带过期时间）+ 按会话派生的 CSRF 令牌。
// 每个请求都回库查一次用户：从白名单里拿掉的人，下一个请求就进不来。
import { CSRF_HEADER } from '@fleet-dao/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Config } from './config.ts';
import { ApiError } from './http.ts';
import type { Store, User } from './ports.ts';
import { derive, nowSeconds, randomToken, safeEqual, signPayload, verifyPayload } from './tokens.ts';

const SESSION_PURPOSE = 'fleet-session/v1';
const CSRF_PURPOSE = 'fleet-csrf/v1';
const OAUTH_PURPOSE = 'fleet-oauth/v1';
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;
/** 飞书授权码 5 分钟有效，暂存给 10 分钟足够。 */
const OAUTH_TTL_SECONDS = 10 * 60;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const SessionClaims = z.object({
  uid: z.string().min(1),
  sid: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type SessionClaims = z.infer<typeof SessionClaims>;

const OAuthState = z.object({
  state: z.string().min(1),
  verifier: z.string().min(43),
  next: z.string(),
  exp: z.number().int(),
});
export type OAuthState = z.infer<typeof OAuthState>;

/**
 * 能登录驾驶舱的人：users 表里在用的创始人。协作者和机器人只算 GitHub 作者白名单，进不了驾驶舱；
 * 以后要放别人进来，给 users 加显式字段（比如 cockpitAccess），不按角色推断。
 */
export type CockpitUser = User & { role: 'founder' };

export type CockpitEnv = { Variables: { user: CockpitUser; session: SessionClaims } };

export interface CookieNames {
  session: string;
  oauth: string;
}

/** https 下用 __Host- 前缀：浏览器保证它只能由本域、Secure、Path=/ 设置，子域和明文页面改不动。 */
export function cookieNames(config: Config): CookieNames {
  return config.cookieSecure
    ? { session: '__Host-fleet_session', oauth: '__Host-fleet_oauth' }
    : { session: 'fleet_session', oauth: 'fleet_oauth' };
}

export function isCockpitUser(user: User | null): user is CockpitUser {
  return !!user && user.active && user.role === 'founder';
}

export function csrfTokenFor(config: Config, sid: string): string {
  return derive(config.sessionSecret, CSRF_PURPOSE, sid);
}

/** 登录成功：发新的会话 Cookie，返回会话（其中 sid 用来派生 CSRF 令牌）。 */
export function startSession(c: Context, config: Config, userId: string, now: Date): SessionClaims {
  const iat = nowSeconds(now);
  const claims: SessionClaims = { uid: userId, sid: randomToken(16), iat, exp: iat + SESSION_TTL_SECONDS };
  setCookie(c, cookieNames(config).session, signPayload(config.sessionSecret, SESSION_PURPOSE, claims), {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return claims;
}

export function endSession(c: Context, config: Config): void {
  deleteCookie(c, cookieNames(config).session, { path: '/', secure: config.cookieSecure });
}

export function readSession(c: Context, config: Config, now: Date): SessionClaims | null {
  const raw = getCookie(c, cookieNames(config).session);
  if (!raw) return null;
  const parsed = SessionClaims.safeParse(verifyPayload(config.sessionSecret, SESSION_PURPOSE, raw));
  if (!parsed.success || parsed.data.exp <= nowSeconds(now)) return null;
  return parsed.data;
}

export function saveOAuthState(c: Context, config: Config, state: Omit<OAuthState, 'exp'>, now: Date): void {
  const value = signPayload(config.sessionSecret, OAUTH_PURPOSE, {
    ...state,
    exp: nowSeconds(now) + OAUTH_TTL_SECONDS,
  });
  setCookie(c, cookieNames(config).oauth, value, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: OAUTH_TTL_SECONDS,
  });
}

/** 读出并当场删掉登录暂存（一次性）。 */
export function takeOAuthState(c: Context, config: Config, now: Date): OAuthState | null {
  const name = cookieNames(config).oauth;
  const raw = getCookie(c, name);
  if (!raw) return null;
  deleteCookie(c, name, { path: '/', secure: config.cookieSecure });
  const parsed = OAuthState.safeParse(verifyPayload(config.sessionSecret, OAUTH_PURPOSE, raw));
  if (!parsed.success || parsed.data.exp <= nowSeconds(now)) return null;
  return parsed.data;
}

/**
 * 写操作防 CSRF，两道都要过：
 * 1. 来源：带了 Origin 就必须是驾驶舱自己的地址；没带 Origin 但带了 Sec-Fetch-Site，就必须是 same-origin。
 * 2. 令牌：请求头 X-CSRF-Token 必须等于按本会话派生的值（别的站读不到它）。
 */
export function checkCsrf(c: Context, config: Config, sid: string): void {
  const origin = c.req.header('origin');
  if (origin !== undefined && origin !== config.publicUrl.origin) {
    throw new ApiError(403, 'csrf_origin', '请求来源不是驾驶舱，已拒绝');
  }
  const site = c.req.header('sec-fetch-site');
  if (origin === undefined && site !== undefined && site !== 'same-origin') {
    throw new ApiError(403, 'csrf_origin', '请求来源不是驾驶舱，已拒绝');
  }
  const token = c.req.header(CSRF_HEADER);
  if (!token || !safeEqual(token, csrfTokenFor(config, sid))) {
    throw new ApiError(403, 'csrf_token', `缺少或错误的 ${CSRF_HEADER}（先 GET /api/me 取）`);
  }
}

/** 驾驶舱接口的门：只认登录 Cookie；带 Authorization 头的一律拒（fleet 令牌不能拿来调驾驶舱）。 */
export function requireSession(config: Config, store: Store, now: () => Date): MiddlewareHandler<CockpitEnv> {
  return async (c, next) => {
    if (c.req.header('authorization') !== undefined) {
      throw new ApiError(401, 'bearer_not_allowed', '驾驶舱接口只认登录 Cookie，fleet 令牌不能用在这里');
    }
    const session = readSession(c, config, now());
    if (!session) throw new ApiError(401, 'unauthenticated', '没登录或登录已过期');
    const user = await store.getUser(session.uid);
    if (!isCockpitUser(user)) throw new ApiError(403, 'not_whitelisted', '这个账号不在白名单里');
    if (!SAFE_METHODS.has(c.req.method)) checkCsrf(c, config, session.sid);
    c.set('user', user);
    c.set('session', session);
    await next();
  };
}
