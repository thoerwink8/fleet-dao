// 会话端口各模块共用的几个小函数（错误文字、会话用户认名、资源上限换算）。从 sessions.ts 拆出来，函数体原样。

import { type CgroupScope, SESSION_USERS, type SessionUser } from '@fleet-dao/adapters';
import { type LaunchSessionInput, PortError } from '../ports.ts';

export const SHA = /^[0-9a-f]{40}$/;

export function asSessionUser(user: string | null | undefined): SessionUser | undefined {
  return (SESSION_USERS as readonly string[]).includes(user ?? '') ? (user as SessionUser) : undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 失败信息接上执行体只在 stderr 里说的原话（已经在里面的不重复）：cursor 的认证、额度、网络报错就只有它。 */
export function withRawError(message: string, raw: string | undefined): string {
  return raw && !message.includes(raw) ? `${message}（执行体原话：${raw}）` : message;
}

/**
 * 以 MB 计的上限 → 帮手脚本（fleet-agent-scope）认的写法：0 只能写「0」（它和插头的校验都不认「0M」，
 * 2026-09-26 法国第一次真起会话就卡在交换区上限「0M」上），别的写「<整数>M」。
 * 不是非负整数的明确拒：不起会话，也不悄悄取整。
 */
export function scopeSize(name: string, mb: number): string {
  if (!Number.isSafeInteger(mb) || mb < 0) {
    throw new PortError('BAD_INPUT', `会话的资源上限 ${name} 要是非负整数（MB）：${mb}`, {
      retryable: false,
    });
  }
  return mb === 0 ? '0' : `${mb}M`;
}

export function scopeLimitsOf(r: LaunchSessionInput['resources']): NonNullable<CgroupScope['limits']> {
  return {
    memoryHigh: scopeSize('memoryHighMb', r.memoryHighMb),
    memoryMax: scopeSize('memoryMaxMb', r.memoryMaxMb),
    memorySwapMax: scopeSize('swapMaxMb', r.swapMaxMb),
  };
}
