// 会话令牌：随机 32 字节，库里只存 sha256 哈希；一个令牌只绑一个会话、一个角色。令牌只走请求头或 cookie，不进网址。
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SessionRole } from '@fleet-dao/harness-contract';
import { type Db, sessionTokens } from '@fleet-dao/harness-store';
import { and, eq, isNull } from 'drizzle-orm';

export interface TokenClaims {
  tokenId: string;
  sessionId: string;
  role: SessionRole;
}

export interface IssuedToken extends TokenClaims {
  /** 明文只在发出这一刻拿得到，库里没有。 */
  token: string;
}

export const TOKEN_HEADER = 'x-fleet-session-token';
export const TOKEN_COOKIE = 'fleet_session_token';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueToken(db: Db, sessionId: string, role: SessionRole): Promise<IssuedToken> {
  if (sessionId.trim() === '' || /\s/.test(sessionId)) throw new Error('会话号不能空、不能带空白');
  const token = randomBytes(32).toString('base64url');
  const tokenId = randomUUID();
  await db.insert(sessionTokens).values({ id: tokenId, tokenHash: hashToken(token), sessionId, role });
  return { token, tokenId, sessionId, role };
}

/** 核验：按哈希找行，再对哈希做定时长比较；没找到、已撤销都返回 null（不区分，不给探测的线索）。 */
export async function verifyToken(db: Db, token: string | undefined): Promise<TokenClaims | null> {
  if (token === undefined || token === '' || token.length > 256) return null;
  const hash = hashToken(token);
  const [row] = await db
    .select()
    .from(sessionTokens)
    .where(and(eq(sessionTokens.tokenHash, hash), isNull(sessionTokens.revokedAt)))
    .limit(1);
  if (!row) return null;
  const a = Buffer.from(row.tokenHash, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (row.role !== 'commander' && row.role !== 'worker') return null;
  return { tokenId: row.id, sessionId: row.sessionId, role: row.role };
}

/** 撤销一个令牌；返回是否真撤了（已撤或不存在返回 false）。 */
export async function revokeToken(db: Db, tokenId: string): Promise<boolean> {
  const rows = await db
    .update(sessionTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessionTokens.id, tokenId), isNull(sessionTokens.revokedAt)))
    .returning({ id: sessionTokens.id });
  return rows.length > 0;
}

/** 撤销一个会话的全部令牌，返回撤了几个。 */
export async function revokeSessionTokens(db: Db, sessionId: string): Promise<number> {
  const rows = await db
    .update(sessionTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessionTokens.sessionId, sessionId), isNull(sessionTokens.revokedAt)))
    .returning({ id: sessionTokens.id });
  return rows.length;
}

/** 从请求里取令牌：请求头优先，其次 cookie。不看网址。 */
export function readTokenFromRequest(headers: {
  [k: string]: string | string[] | undefined;
}): string | undefined {
  const h = headers[TOKEN_HEADER];
  const fromHeader = Array.isArray(h) ? h[0] : h;
  if (fromHeader) return fromHeader;
  const cookie = headers.cookie;
  const raw = Array.isArray(cookie) ? cookie.join(';') : cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === TOKEN_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}
