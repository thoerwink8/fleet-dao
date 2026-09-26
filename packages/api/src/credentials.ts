// 设置页：看、设、改自己的账密登录（#120）。挂在驾驶舱接口 /api 下，过 requireSession（写操作另过 CSRF）。
// 已设过密码的：改用户名或密码都要带当前密码（输错计入同一个锁）。
// 还没设过的：这次会话得是 10 分钟内飞书登录的——偷到一个旧会话 Cookie 的人不能顺手给这个号配上密码。
import { CredentialsResponse, UpdateCredentialsRequest, WebRoutes } from '@fleet-dao/shared';
import type { Context, Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, readJson, reply } from './http.ts';
import { LOCK_MS, MAX_FAILED_LOGINS } from './login-throttle.ts';
import {
  checkNewPassword,
  checkUsername,
  hashPassword,
  PasswordHashFormatError,
  verifyPassword,
} from './password.ts';
import type { PasswordCredentials } from './ports.ts';
import { type CockpitEnv, reissueSession, type SessionClaims } from './session.ts';
import { nowSeconds } from './tokens.ts';

/** 没设过密码时，飞书登录之后多久内能不带当前密码设第一次。 */
export const FIRST_SET_WINDOW_SECONDS = 10 * 60;
const FEISHU_METHODS = new Set(['feishu-oauth', 'feishu-in-app']);

export function recentFeishuLogin(session: SessionClaims | undefined, now: Date): boolean {
  if (!session?.m || !FEISHU_METHODS.has(session.m)) return false;
  const age = nowSeconds(now) - session.iat;
  return age >= 0 && age <= FIRST_SET_WINDOW_SECONDS;
}

export function registerCredentialRoutes(app: Hono<CockpitEnv>, deps: Deps): void {
  const { store, log } = deps;

  async function credentialsOf(userId: string): Promise<PasswordCredentials> {
    const creds = await store.getPasswordCredentials(userId);
    // 过了登录门的人库里一定有：读不到就是出事了，不当成「没设过」
    if (!creds) throw new ApiError(500, 'credentials_missing', '读不到这个账号的登录信息');
    return creds;
  }

  function browserSession(c: Context<CockpitEnv>): SessionClaims {
    const session = c.get('session');
    if (c.get('via') !== 'cockpit' || !session) {
      throw new ApiError(403, 'not_a_browser_session', '只有浏览器登录会话能看、改账密');
    }
    return session;
  }

  app.get(WebRoutes.credentials.path, async (c) => {
    const session = browserSession(c);
    const creds = await credentialsOf(c.get('user').id);
    const hasPassword = creds.passwordHash !== undefined;
    return reply(c, CredentialsResponse, {
      hasPassword,
      username: creds.username ?? null,
      passwordChangedAt: creds.passwordChangedAt ?? null,
      canSetWithoutCurrent: !hasPassword && recentFeishuLogin(session, deps.now()),
    });
  });

  app.put(WebRoutes.updateCredentials.path, async (c) => {
    const session = browserSession(c);
    const user = c.get('user');
    const body = await readJson(c, UpdateCredentialsRequest);
    const { username, newPassword, currentPassword } = body;
    const now = deps.now();

    if (username === undefined && newPassword === undefined) {
      throw new ApiError(400, 'nothing_to_change', '用户名和新密码至少给一样');
    }
    for (const problem of [
      username === undefined ? null : checkUsername(username),
      newPassword === undefined ? null : checkNewPassword(newPassword),
    ]) {
      if (problem) throw new ApiError(400, problem.code, problem.message, { field: problem.field });
    }

    const creds = await credentialsOf(user.id);
    const hasPassword = creds.passwordHash !== undefined;
    const action = hasPassword ? 'credentials.change' : 'credentials.set';
    const target = `user:${user.id}`;

    if (creds.passwordHash !== undefined) {
      if (creds.lockedUntil !== undefined && Date.parse(creds.lockedUntil) > now.getTime()) {
        throw new ApiError(429, 'locked', '输错次数太多，已临时锁住，稍后再试', { until: creds.lockedUntil });
      }
      if (!currentPassword) {
        throw new ApiError(400, 'current_password_required', '改之前要输入当前密码', {
          field: 'currentPassword',
        });
      }
      let ok: boolean;
      try {
        ok = await verifyPassword(currentPassword, creds.passwordHash);
      } catch (err) {
        if (err instanceof PasswordHashFormatError) {
          log.error('库里的密码哈希格式认不出', { userId: user.id, error: err.message });
          throw new ApiError(500, 'password_hash_unreadable', '这个账号的密码数据坏了，已记日志');
        }
        throw err;
      }
      if (!ok) {
        const r = await store.recordPasswordFailure({
          userId: user.id,
          at: now,
          maxFails: MAX_FAILED_LOGINS,
          lockMs: LOCK_MS,
        });
        try {
          await store.appendAudit({
            actor: { kind: 'user', id: user.id },
            action,
            target,
            via: 'cockpit',
            ok: false,
            error: 'bad_current_password',
          });
        } catch (err) {
          log.error('改账密失败的操作记录没写成', { error: String(err) });
        }
        if (r?.lockedUntil !== undefined) {
          throw new ApiError(429, 'locked', '输错次数太多，已临时锁住，稍后再试', { until: r.lockedUntil });
        }
        throw new ApiError(401, 'bad_current_password', '当前密码不对', { field: 'currentPassword' });
      }
    } else if (!recentFeishuLogin(session, now)) {
      throw new ApiError(
        403,
        'recent_feishu_login_required',
        '第一次设密码要在飞书登录后 10 分钟内设：请退出、用飞书重新登录一次再来',
      );
    }

    if (newPassword !== undefined && username === undefined && creds.username === undefined) {
      throw new ApiError(400, 'username_required', '第一次设密码要同时设用户名', { field: 'username' });
    }

    const passwordHash = newPassword === undefined ? undefined : await hashPassword(newPassword);
    const result = await store.setPasswordCredentials(
      { userId: user.id, username, passwordHash, at: now },
      {
        actor: { kind: 'user', id: user.id },
        action,
        target,
        before: { username: creds.username ?? null, hasPassword },
        after: { username: username ?? creds.username ?? null, passwordChanged: passwordHash !== undefined },
        via: 'cockpit',
        ok: true,
      },
    );
    if (result === 'username_taken') {
      throw new ApiError(400, 'username_taken', '这个用户名已经有人用了', { field: 'username' });
    }
    if (result === 'not_found') throw new ApiError(500, 'credentials_missing', '读不到这个账号的登录信息');
    if (passwordHash !== undefined) {
      // 设、改密码时库里的会话版本加了 1：别处已登的全作废，这一处换上新版本接着用（会话编号、CSRF 令牌不变）
      const fresh = await store.getUser(user.id);
      if (!fresh) throw new ApiError(500, 'credentials_missing', '读不到这个账号的登录信息');
      reissueSession(c, deps.config, session, fresh.sessionVersion ?? 0, now);
    }
    return c.body(null, 204);
  });
}
