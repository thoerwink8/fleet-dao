// 账密登录防暴力（#120）：连续输错 5 次锁 15 分钟。按两样计：
// - 用户名：库里有这个人的，计数在 users 表上（重启不丢）；没这个人的在这里计（不然「锁不锁」会泄露用户名存不存在）。
// - 来源：香港 nginx 写的 X-Real-IP（它把客户端带来的同名头覆盖掉；驾驶舱接口只听隧道地址，外面绕不过香港）。
// 这里的键都是 HMAC 过的（按会话密钥派生）：内存里、日志里都不出现来源地址和没登成的用户名的明文。
// 只在这一个进程的内存里：重启就清零——后端就一个进程，重启要 root，够用。
import { derive } from './tokens.ts';

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MS = 15 * 60_000;
/** 内存里最多记这么多个键：被人拿大量来源地址刷，也吃不光内存（先扔最久没动的）。 */
const MAX_KEYS = 10_000;

interface Entry {
  fails: number;
  lockedUntil: number | undefined;
  touched: number;
}

export interface LoginThrottle {
  /** 正锁着就返回锁到的时刻（毫秒），没锁返回 undefined。 */
  lockedUntil(key: string, now: number): number | undefined;
  /** 记一次输错，返回记完后锁到的时刻（这一下正好锁上也算）。 */
  fail(key: string, now: number): number | undefined;
  clear(key: string): void;
  size(): number;
}

export function createLoginThrottle(options: { maxKeys?: number } = {}): LoginThrottle {
  const maxKeys = options.maxKeys ?? MAX_KEYS;
  const entries = new Map<string, Entry>();

  function live(key: string, now: number): Entry | undefined {
    const e = entries.get(key);
    if (!e) return undefined;
    // 锁过期了、或者最后一次输错也过去一个锁期了：从头算
    if ((e.lockedUntil !== undefined && e.lockedUntil <= now) || e.touched + LOCK_MS <= now) {
      entries.delete(key);
      return undefined;
    }
    return e;
  }

  function evict(now: number): void {
    for (const key of [...entries.keys()]) live(key, now);
    // Map 按插入顺序：fail 里先删再插，最前面的就是最久没动的
    while (entries.size >= maxKeys) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    lockedUntil(key, now) {
      return live(key, now)?.lockedUntil;
    },
    fail(key, now) {
      const e = live(key, now) ?? { fails: 0, lockedUntil: undefined, touched: now };
      if (e.lockedUntil !== undefined) return e.lockedUntil;
      entries.delete(key);
      if (entries.size >= maxKeys) evict(now);
      e.fails += 1;
      e.touched = now;
      if (e.fails >= MAX_FAILED_LOGINS) {
        e.fails = 0;
        e.lockedUntil = now + LOCK_MS;
      }
      entries.set(key, e);
      return e.lockedUntil;
    },
    clear(key) {
      entries.delete(key);
    },
    size() {
      return entries.size;
    },
  };
}

/** 来源地址的键：只存 HMAC，不存地址本身。 */
export function sourceKey(secret: string, address: string): string {
  return `ip:${derive(secret, 'fleet-login-source/v1', address)}`;
}

/** 库里没有的用户名的键：按小写算（和登录时大小写不敏感一致），只存 HMAC。 */
export function unknownUsernameKey(secret: string, username: string): string {
  return `u:${derive(secret, 'fleet-login-username/v1', username.toLowerCase())}`;
}
