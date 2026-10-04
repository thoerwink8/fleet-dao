/**
 * fleet 命令幂等键两套 Store 共用的纯判断。
 * 改这里之前必须知道：键的写法（commandKey）和「看到一行已有的占用怎么判」以这里为准；pg 版另外靠条件更新保证原子（两个请求
 * 同时来接只有一个接得到），这里只管判，不管抢。
 */
import type { CommandClaim } from './ports.ts';

/** 库里幂等键的写法：同一会话内的键。 */
export const commandKey = (runId: string, key: string): string => `fleet:${runId}:${key}`;

/** 幂等键记的目标（谁的命令）。 */
export const commandTarget = (runId: string): string => `run:${runId}`;

/** 已经占着的那一行（库里读回来的、内存里存着的，时刻都先转成 ISO 字符串）。 */
export interface HeldCommand {
  action: string;
  claimedAt: string;
  /** 做完了才有。 */
  completed: boolean;
  result?: unknown;
}

/** 看到键已经被占：别的命令 → other-action；做完了 → done；占用早于 takeOverBefore → 可以接管（take-over）；否则 in-flight。 */
export type ExistingCommandVerdict =
  | Extract<CommandClaim, { status: 'other-action' | 'done' | 'in-flight' }>
  | { status: 'take-over' };

export function judgeExistingCommand(
  existing: HeldCommand,
  action: string,
  takeOverBefore: string,
): ExistingCommandVerdict {
  if (existing.action !== action) return { status: 'other-action', action: existing.action };
  if (existing.completed) return { status: 'done', result: existing.result };
  if (Date.parse(existing.claimedAt) < Date.parse(takeOverBefore)) return { status: 'take-over' };
  return { status: 'in-flight', claimedAt: existing.claimedAt };
}

/** 接管成功回什么。 */
export const tookOverResult = (token: string): Extract<CommandClaim, { status: 'claimed' }> => ({
  status: 'claimed',
  token,
  tookOver: true,
});

/** 占到了（新占）回什么。 */
export const claimedCommandResult = (token: string): Extract<CommandClaim, { status: 'claimed' }> => ({
  status: 'claimed',
  token,
});
