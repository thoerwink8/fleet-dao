// 一个渠道这一次认哪些模型。读不成是失败，空名单也是失败，不许变成 ok 加空数组。
import type { QuotaErrorCode } from '../quota/types.ts';

export interface ChannelModelReadOk {
  ok: true;
  channelId: string;
  models: string[];
  /** 名册帧上的执行体。没有这一项时，写入方按上游串前缀判。 */
  executors?: { modelKey: string; executor: string }[];
}

export interface ChannelModelReadFailed {
  ok: false;
  channelId: string;
  error: { code: QuotaErrorCode; message: string };
}

export type ChannelModelReadResult = ChannelModelReadOk | ChannelModelReadFailed;

export function rosterFailed(
  channelId: string,
  code: QuotaErrorCode,
  message: string,
): ChannelModelReadFailed {
  return { ok: false, channelId, error: { code, message } };
}
