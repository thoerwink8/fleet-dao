// 登录：飞书账号 OAuth（浏览器）、飞书客户端内免登、用户名 + 密码（#120）、开发环境免登、退出。
// 只放行 users 表白名单里的人。
import {
  AuthConfigResponse,
  DevLoginRequest,
  FeishuAccessRequest,
  MeResponse,
  PasswordLoginRequest,
} from '@fleet-dao/shared';
import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { Config } from './config.ts';
import type { Deps } from './deps.ts';
import { FeishuRejectedError, FeishuUnavailableError } from './feishu.ts';
import { ApiError, readJson, reply } from './http.ts';
import {
  createLoginThrottle,
  LOCK_MS,
  MAX_FAILED_LOGINS,
  sourceKey,
  unknownUsernameKey,
} from './login-throttle.ts';
import { burnPasswordCheck, PasswordHashFormatError, verifyPassword } from './password.ts';
import type { FeishuIdentity, NewAuditEntry, PasswordCredentials } from './ports.ts';
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
    return startSession(c, config, user.id, deps.now(), method, user.sessionVersion ?? 0);
  }

  async function identify(input: Parameters<NonNullable<Deps['feishu']>['identify']>[0]) {
    if (!deps.feishu) throw new ApiError(503, 'feishu_not_configured', '飞书登录还没配置');
    try {
      return await deps.feishu.identify(input);
    } catch (err) {
      if (err instanceof FeishuRejectedError) {
        // 飞书的错误码必须记下来并带给用户：不带就查不出是过期、重定向地址不对还是 PKCE 对不上
        log.warn('飞书拒绝了登录', { feishuCode: err.feishuCode, error: err.message });
        throw new ApiError(
          401,
          'feishu_rejected',
          `飞书没认这个授权码（飞书错误码 ${err.feishuCode}），请重新登录`,
        );
      }
      if (err instanceof FeishuUnavailableError) {
        log.warn('飞书登录接口出错', { error: err.message });
        throw new ApiError(502, 'feishu_unavailable', '飞书那边暂时出错，稍后再试');
      }
      throw err;
    }
  }

  app.get('/config', (c) =>
    reply(c, AuthConfigResponse, {
      feishuAppId: config.feishu?.appId,
      devLogin: config.devLogin,
      passwordLogin: true,
    }),
  );

  // 来源、库里没有的用户名各一份计数：一份被刷满也挤不到另一份的锁
  const sourceThrottle = createLoginThrottle();
  const nameThrottle = createLoginThrottle();

  /** 没登成也要留记录；记录写不进只记日志，不改变给人的答复（不然库一抖就把「密码错」变成 500）。 */
  async function auditFailure(actorId: string, error: string, extra: Record<string, unknown> = {}) {
    const entry: NewAuditEntry = {
      actor: { kind: 'user', id: actorId },
      action: 'login',
      target: 'cockpit',
      after: { method: 'password', ...extra },
      via: 'cockpit',
      ok: false,
      error,
    };
    try {
      await store.appendAudit(entry);
    } catch (err) {
      log.error('账密登录失败的操作记录没写成', { error: String(err) });
    }
  }

  function locked(until: number | string): never {
    const at = typeof until === 'string' ? until : new Date(until).toISOString();
    throw new ApiError(429, 'locked', '输错次数太多，已临时锁住，稍后再试', { until: at });
  }

  function badCredentials(): never {
    throw new ApiError(401, 'bad_credentials', '用户名或密码不对');
  }

  /**
   * 用户名 + 密码登录。顺序：来源被锁 → 用户名被锁 → 验密码（没这人、没设过密码也照样算一次哈希，响应快慢看不出差别）。
   * 答复只有三种：204（登上了）、401 bad_credentials（不区分为什么）、429 locked。
   * 日志、操作记录里不写密码；没这个人时也不写输入的用户名（常有人把密码敲进用户名栏）。
   */
  app.post('/password/login', async (c) => {
    checkLoginOrigin(c);
    const { username, password } = await readJson(c, PasswordLoginRequest);
    const nowMs = deps.now().getTime();
    const source = sourceKey(config.sessionSecret, c.req.header('x-real-ip')?.trim() || 'unknown');
    const sourceTag = source.slice(3, 15);

    const sourceLock = sourceThrottle.lockedUntil(source, nowMs);
    if (sourceLock !== undefined) {
      await auditFailure('password:unknown', 'locked', { by: 'source', source: sourceTag });
      locked(sourceLock);
    }

    const found = await store.findUserByUsername(username);
    const user: CockpitUser | null = isCockpitUser(found) ? found : null;
    const creds: PasswordCredentials | null = user ? await store.getPasswordCredentials(user.id) : null;
    const nameKey = unknownUsernameKey(config.sessionSecret, username);
    if (user && !creds) {
      // 过了白名单的人却读不到登录信息：是库出事了，不当成「没设密码」答 401、也不记输错
      log.error('账密登录读不到这个人的登录信息', { userId: user.id });
      await auditFailure(user.id, 'credentials_missing');
      throw new ApiError(500, 'credentials_missing', '读不到这个账号的登录信息，已记日志，请先用飞书登录');
    }

    if (user && creds) {
      if (creds.lockedUntil !== undefined && Date.parse(creds.lockedUntil) > nowMs) {
        await auditFailure(user.id, 'locked', { by: 'username', source: sourceTag });
        locked(creds.lockedUntil);
      }
    } else {
      const nameLock = nameThrottle.lockedUntil(nameKey, nowMs);
      if (nameLock !== undefined) {
        await auditFailure('password:unknown', 'locked', { by: 'username', source: sourceTag });
        locked(nameLock);
      }
    }

    let ok = false;
    try {
      if (user && creds?.passwordHash !== undefined) ok = await verifyPassword(password, creds.passwordHash);
      else await burnPasswordCheck(password);
    } catch (err) {
      if (err instanceof PasswordHashFormatError) {
        // 库里的哈希坏了：不当「密码错」糊过去（那样人永远登不上还查不出原因），照实 500 并记下是谁的
        log.error('库里的密码哈希格式认不出', { userId: user?.id, error: err.message });
        await auditFailure(user?.id ?? 'password:unknown', 'password_hash_unreadable');
        throw new ApiError(
          500,
          'password_hash_unreadable',
          '这个账号的密码数据坏了，已记日志，请先用飞书登录',
        );
      }
      throw err;
    }

    if (ok && user) {
      await store.recordPasswordSuccess(user.id);
      sourceThrottle.clear(source);
      await startRecordedSession(c, user, 'password');
      return c.body(null, 204);
    }

    const sourceUntil = sourceThrottle.fail(source, nowMs);
    let nameUntil: number | string | undefined;
    if (user) {
      const r = await store.recordPasswordFailure({
        userId: user.id,
        at: new Date(nowMs),
        maxFails: MAX_FAILED_LOGINS,
        lockMs: LOCK_MS,
      });
      nameUntil = r?.lockedUntil;
    } else {
      nameUntil = nameThrottle.fail(nameKey, nowMs);
    }
    await auditFailure(user?.id ?? 'password:unknown', 'bad_credentials', {
      source: sourceTag,
      ...(user && !creds?.passwordHash && { reason: 'no_password' }),
      ...(found && !user && { reason: 'not_whitelisted' }),
    });
    // 这一下正好锁上的，直接告诉人锁了（第 5 次就答 429，不等第 6 次）
    const until = nameUntil ?? sourceUntil;
    if (until !== undefined) locked(until);
    badCredentials();
  });

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
    // 退出 = 这个人所有设备上的会话都作废（会话是自签 Cookie，光删这一处的 Cookie，偷走的那份照样能用）
    if (!(await deps.store.bumpSessionVersion(c.get('user').id))) {
      throw new ApiError(500, 'session_revoke_failed', '退出没做成：库里找不到这个账号，已记日志');
    }
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
