// fleet 令牌：引擎开会话时签发（signAgentToken），后端的 /agent/v1 验（verifyAgentToken）。
// 只对一个任务的一次会话有效、带过期时间；驾驶舱接口一律不认它。引擎经子路径 `@fleet-dao/api/agent-token` 引用，不拉进 Hono。
import { z } from 'zod';
import { nowSeconds, signPayload, verifyPayload } from './tokens.ts';

export const AGENT_TOKEN_PREFIX = 'fat1.';
const PURPOSE = 'fleet-agent-token/v1';
/** 签发时最长给多久；验的时候超过这个寿命的一律不认，防引擎写错把令牌签成永久。 */
export const AGENT_TOKEN_MAX_TTL_SECONDS = 24 * 60 * 60;
/** 两台机器时钟差的容忍。 */
const CLOCK_SKEW_SECONDS = 60;

const Claims = z.object({
  typ: z.literal('agent'),
  tid: z.string().min(1),
  sid: z.string().min(1).optional(),
  rid: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
});

export interface AgentTokenClaims {
  taskId: string;
  subtaskId?: string | undefined;
  runId: string;
  issuedAt: number;
  expiresAt: number;
}

export function signAgentToken(
  secret: string,
  input: { taskId: string; subtaskId?: string | undefined; runId: string; ttlSeconds: number; now?: Date },
): string {
  if (input.ttlSeconds <= 0 || input.ttlSeconds > AGENT_TOKEN_MAX_TTL_SECONDS) {
    throw new Error(`fleet 令牌的有效期要在 1–${AGENT_TOKEN_MAX_TTL_SECONDS} 秒之间`);
  }
  const iat = nowSeconds(input.now ?? new Date());
  return (
    AGENT_TOKEN_PREFIX +
    signPayload(secret, PURPOSE, {
      typ: 'agent',
      tid: input.taskId,
      ...(input.subtaskId ? { sid: input.subtaskId } : {}),
      rid: input.runId,
      iat,
      exp: iat + input.ttlSeconds,
    })
  );
}

export type AgentTokenCheck =
  | { ok: true; claims: AgentTokenClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' | 'ttl_too_long' };

export function verifyAgentToken(secret: string, token: string, now: Date): AgentTokenCheck {
  if (!token.startsWith(AGENT_TOKEN_PREFIX)) return { ok: false, reason: 'malformed' };
  const raw = verifyPayload(secret, PURPOSE, token.slice(AGENT_TOKEN_PREFIX.length));
  if (raw === null) return { ok: false, reason: 'bad_signature' };
  const parsed = Claims.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  const c = parsed.data;
  const t = nowSeconds(now);
  if (c.exp - c.iat > AGENT_TOKEN_MAX_TTL_SECONDS) return { ok: false, reason: 'ttl_too_long' };
  if (c.iat > t + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'not_yet_valid' };
  if (c.exp <= t) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    claims: { taskId: c.tid, subtaskId: c.sid, runId: c.rid, issuedAt: c.iat, expiresAt: c.exp },
  };
}
