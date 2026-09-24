// App 身份与安装令牌。做法照搬旧系统验证过的（docs/reference/github.md §1.1）：
// JWT 用内建 crypto 签 RS256，iat 往前拨 60 秒抗时钟漂移，exp 取 9 分钟（GitHub 硬限 10 分钟）；
// 安装令牌 1 小时过期，剩不到 10 分钟就重换（长任务跑到一半 401 就是这么来的）。
// 令牌只在内存里：不落盘、不进日志、不进命令行参数。
import { sign } from 'node:crypto';
import type { AppCredentials } from './credentials.ts';
import { forgetSecret, registerSecret } from './errors.ts';

const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** App 自己的 JWT：只能调 /app/… 这类接口（换安装令牌、查安装、投递日志）。 */
export function signAppJwt(
  app: Pick<AppCredentials, 'appId' | 'clientId' | 'privateKey'>,
  now: Date,
): string {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iat: nowSeconds - JWT_BACKDATE_SECONDS,
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
      iss: app.clientId ?? String(app.appId),
    }),
  );
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), app.privateKey);
  // 不登记进 redact 的原值表（每个请求签一枚，会越攒越多）：JWT 的形状由 redact 按模式打码。
  return `${header}.${payload}.${b64url(signature)}`;
}

export interface MintedToken {
  token: string;
  expiresAt: Date;
  /** GitHub 回写的这枚令牌实际拿到的权限，自检用。 */
  permissions?: Record<string, string> | undefined;
}

export interface TokenCacheOptions {
  now: () => Date;
  /** 剩余不足这么久就重换，默认 10 分钟。 */
  refreshBeforeMs?: number;
}

/**
 * 安装令牌缓存：同一把钥匙（身份 + 仓）同时来多个请求只换一次；快过期了提前换；401 了作废重换。
 * 键由调用方拼（见 client.ts），这里不关心它的含义。
 */
export class TokenCache {
  private readonly cached = new Map<string, MintedToken>();
  private readonly inflight = new Map<string, Promise<MintedToken>>();
  private readonly now: () => Date;
  private readonly refreshBeforeMs: number;

  constructor(options: TokenCacheOptions) {
    this.now = options.now;
    this.refreshBeforeMs = options.refreshBeforeMs ?? 10 * 60 * 1000;
  }

  async get(key: string, mint: () => Promise<MintedToken>): Promise<MintedToken> {
    const hit = this.cached.get(key);
    if (hit && hit.expiresAt.getTime() - this.now().getTime() > this.refreshBeforeMs) return hit;
    const running = this.inflight.get(key);
    if (running) return running;
    const next = mint()
      .then((minted) => {
        if (hit) forgetSecret(hit.token);
        registerSecret(minted.token);
        this.cached.set(key, minted);
        return minted;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, next);
    return next;
  }

  /** 这枚令牌被 GitHub 拒了（401）：作废，下次重换。只作废同一枚，别把别人刚换的新令牌也扔掉。 */
  invalidate(key: string, token: string): void {
    const hit = this.cached.get(key);
    if (hit && hit.token === token) this.cached.delete(key);
  }
}
