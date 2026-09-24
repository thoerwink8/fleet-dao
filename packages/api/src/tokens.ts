// 签名小工具：会话 Cookie、飞书登录暂存、fleet 令牌共用这一套 HMAC-SHA256。
// purpose 做域隔离：同一把密钥签出的不同用途的东西互相不能冒充。
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function mac(secret: string, purpose: string, body: string): Buffer {
  return createHmac('sha256', secret).update(purpose).update('\n').update(body).digest();
}

/** 结果形如 `<载荷 base64url>.<签名 base64url>`。 */
export function signPayload(secret: string, purpose: string, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${mac(secret, purpose, body).toString('base64url')}`;
}

/** 签名对才返回载荷；格式不对、签名不对一律 null。签名按字符串比，同一签名的非规范编写法（改填充位）也不认。 */
export function verifyPayload(secret: string, purpose: string, token: string): unknown {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.') || token.length > 8192) return null;
  const body = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), mac(secret, purpose, body).toString('base64url'))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** 常量时间比较两个字符串（长度不同也不提前返回）。 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** 做一个只跟 purpose 和 data 有关的派生值（例如按会话编号派生 CSRF 令牌）。 */
export function derive(secret: string, purpose: string, data: string): string {
  return mac(secret, purpose, data).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function nowSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}
