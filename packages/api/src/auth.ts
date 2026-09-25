// 登录：飞书账号 OAuth（浏览器）、飞书客户端内免登、开发环境免登、退出。只放行 users 表白名单里的人。
import { AuthConfigResponse, DevLoginRequest, FeishuAccessRequest, MeResponse } from '@fleet-dao/shared';
import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { Config } from './config.ts';
import type { Deps } from './deps.ts';
import { FeishuRejectedError, FeishuUnavailableError } from './feishu.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { FeishuIdentity } from './ports.ts';
import {
  type CockpitEnv,
  type CockpitUser,
  csrfTokenFor,
  endSession,
  isCockpitUser,
  requireSession,
  type SessionClaims,
  saveOAuthState,
  startSession,
  takeOAuthState,
} from './session.ts';
import { pkceChallenge, randomToken, safeEqual } from './tokens.ts';

/** 飞书网关的请求没有登录会话，也用不着 CSRF 令牌，给空串。 */
export function meBody(
  config: Config,
  user: CockpitUser,
  session: SessionClaims | undefined,
): z.input<typeof MeResponse> {
  return {
    user: { id: user.id, displayName: user.displayName, role: user.role, avatarUrl: user.avatarUrl },
    csrfToken: session ? csrfTokenFor(config, session.sid) : '',
  };
}

/** 登录后跳回的地址只许是站内路径，防被拿来当跳板（开放重定向）。 */
export function safeNext(next: string | undefined): string {
  if (!next || next.length > 1000) return '/';
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要拦控制字符
  if (/[\u0000-\u001f\u007f]/.test(next)) return '/';
  return next;
}

export function authRoutes(deps: Deps): Hono<CockpitEnv> {
  const { config, store, log } = deps;
  const app = new Hono<CockpitEnv>();
  const redirectUri = new URL('/auth/feishu/callback', config.publicUrl).toString();

  /** 还没登录时的写操作（免登）只看来源：带了 Origin 就必须是驾驶舱自己的地址，防「登录 CSRF」。 */
  function checkLoginOrigin(c: Context): void {
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== config.publicUrl.origin) {
      throw new ApiError(403, 'csrf_origin', '请求来源不是驾驶舱，已拒绝');
    }
  }

  async function loginAs(c: Context, identity: FeishuIdentity, method: string) {
    const user = await store.findUserByFeishu({ openId: identity.openId, unionId: identity.unionId });
    if (!isCockpitUser(user)) {
      try {
        await store.appendAudit({
          actor: { kind: 'user', id: `feishu:${identity.openId}` },
          action: 'login',
          target: 'cockpit',
          after: { method },
          via: 'cockpit',
          ok: false,
          error: 'not_whitelisted',
        });
      } catch (err) {
        log.error('登录被拒的操作记录没写成', { error: String(err) });
      }
      throw new ApiError(
        403,
        'not_whitelisted',
        `飞书账号「${identity.name}」不在白名单里，请找创始人把你加进来`,
      );
    }
    return { user, session: await startRecordedSession(c, user, method) };
  }

  /** 先记后做：登录记录写不进就抛错，不种 Cookie。 */
  async function startRecordedSession(c: Context, user: CockpitUser, method: string) {
    await store.appendAudit({
      actor: { kind: 'user', id: user.id },
      action: 'login',
      target: 'cockpit',
      after: { method },
      via: 'cockpit',
      ok: true,
    });
    return startSession(c, config, user.id, deps.now());
  }

  async function identify(input: Parameters<NonNullable<Deps['feishu']>['identify']>[0]) {
    if (!deps.feishu) throw new ApiError(503, 'feishu_not_configured', '飞书登录还没配置');
    try {
      return await deps.feishu.identify(input);
    } catch (err) {
      if (err instanceof FeishuRejectedError) {
        throw new ApiError(401, 'feishu_rejected', '飞书没认这个授权码（可能过期或用过了），请重新登录');
      }
      if (err instanceof FeishuUnavailableError) {
        log.warn('飞书登录接口出错', { error: err.message });
        throw new ApiError(502, 'feishu_unavailable', '飞书那边暂时出错，稍后再试');
      }
      throw err;
    }
  }

  app.get('/config', (c) =>
    reply(c, AuthConfigResponse, { feishuAppId: config.feishu?.appId, devLogin: config.devLogin }),
  );

  app.get('/feishu/login', (c) => {
    if (!deps.feishu) throw new ApiError(503, 'feishu_not_configured', '飞书登录还没配置');
    const state = randomToken(16);
    const verifier = randomToken(32);
    saveOAuthState(c, config, { state, verifier, next: safeNext(c.req.query('next')) }, deps.now());
    return c.redirect(
      deps.feishu.authorizeUrl({ redirectUri, state, codeChallenge: pkceChallenge(verifier) }),
      302,
    );
  });

  app.get('/feishu/callback', async (c) => {
    const saved = takeOAuthState(c, config, deps.now());
    const state = c.req.query('state');
    if (!saved || !state || !safeEqual(state, saved.state)) {
      return loginFailedPage(c, 400, '登录状态对不上或已过期（10 分钟内要完成授权），请重新登录');
    }
    if (c.req.query('error')) return loginFailedPage(c, 401, '你在飞书授权页取消了授权');
    const code = c.req.query('code');
    if (!code) return loginFailedPage(c, 400, '飞书没有带回授权码，请重新登录');
    try {
      const identity = await identify({ code, redirectUri, codeVerifier: saved.verifier });
      await loginAs(c, identity, 'feishu-oauth');
    } catch (err) {
      // 这是浏览器直接打开的页面，出错给一页白话，不给 JSON。
      if (err instanceof ApiError) return loginFailedPage(c, err.status, err.message);
      log.error('飞书登录回调出错', { error: String(err) });
      return loginFailedPage(c, 500, '后端出错了，已记日志，请稍后再登录');
    }
    return c.redirect(saved.next, 302);
  });

  app.post('/feishu/access', async (c) => {
    checkLoginOrigin(c);
    const { code } = await readJson(c, FeishuAccessRequest);
    const identity = await identify({ code });
    const { user, session } = await loginAs(c, identity, 'feishu-in-app');
    return reply(c, MeResponse, meBody(config, user, session));
  });

  app.post('/logout', requireSession(config, store, deps.now), async (c) => {
    if (c.get('via') !== 'cockpit')
      throw new ApiError(400, 'not_a_browser_session', '只有浏览器登录会话能退出');
    await store.appendAudit({
      actor: { kind: 'user', id: c.get('user').id },
      action: 'logout',
      target: 'cockpit',
      via: 'cockpit',
      ok: true,
    });
    endSession(c, config);
    return c.body(null, 204);
  });

  if (config.devLogin) {
    app.post('/dev-login', async (c) => {
      checkLoginOrigin(c);
      const { userId } = await readJson(c, DevLoginRequest);
      const user = await store.getUser(userId);
      if (!isCockpitUser(user)) throw new ApiError(403, 'not_whitelisted', '这个账号不在白名单里');
      const session = await startRecordedSession(c, user, 'dev-login');
      log.warn('开发环境免登', { userId: user.id });
      return reply(c, MeResponse, meBody(config, user, session));
    });
  }

  return app;
}

function loginFailedPage(c: Context, status: ContentfulStatusCode, message: string): Response {
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>登录没成功</title><body><p>${escapeHtml(message)}</p><p><a href="/auth/feishu/login">重新用飞书登录</a></p></body></html>`;
  return c.html(html, status);
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}
