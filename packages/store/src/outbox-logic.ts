/**
 * 飞书发件箱（网关回执）两套 Store 共用的纯判断。
 * 改这里之前必须知道：回执先判「认不认、算不算数」（判完再写）：没有这个条目 → unknown_item；回执的版本比库里最新还新 →
 * future_revision；旧版本的回执只有「送到了／改了」才有用（其余记成 stale_revision）；已经送到过更新一版的卡，旧版本的迟到回执
 * 也不算。两边（pg-store 的 ackOutbox 事务里、memory-store）都先走这里，再各自写库。
 */
import type { FeishuOutboxAck } from './ports.ts';

type AckResult = FeishuOutboxAck['result'];

export type OutboxAckVerdict =
  | { kind: 'skip'; why: 'unknown_item' | 'future_revision' | 'stale_revision' }
  | {
      kind: 'apply';
      /** 回执说的正是库里最新一版：要记回执结果（记 ack 状态、原因、等到几点、失败次数）；旧版本只记「送到」的那几列。 */
      current: boolean;
    };

const present = <V>(v: V | null | undefined): v is V => v !== undefined && v !== null;

export function judgeOutboxAck(
  row:
    | {
        revision: number;
        deliveredMessageId?: string | null | undefined;
        deliveredRevision?: number | null | undefined;
      }
    | undefined,
  ack: { revision: number; result: Pick<AckResult, 'status'> },
): OutboxAckVerdict {
  if (!row) return { kind: 'skip', why: 'unknown_item' };
  if (ack.revision > row.revision) return { kind: 'skip', why: 'future_revision' };
  const current = ack.revision === row.revision;
  if (!current && ack.result.status !== 'sent' && ack.result.status !== 'updated') {
    return { kind: 'skip', why: 'stale_revision' };
  }
  // 已经送到过更新一版的卡：旧版本的回执后到（重试、迟到）不能把「送到的卡」退回旧卡。
  if (
    !current &&
    present(row.deliveredMessageId) &&
    present(row.deliveredRevision) &&
    ack.revision < row.deliveredRevision
  ) {
    return { kind: 'skip', why: 'stale_revision' };
  }
  return { kind: 'apply', current };
}

/** 没发出去的原因：不发了记原因，没发成记错误，其余没有。 */
export function ackReasonOf(result: AckResult): string | undefined {
  if (result.status === 'dropped' || result.status === 'deferred') return result.reason;
  return result.status === 'failed' ? result.error : undefined;
}

/** 在这个时刻之前别再给（ISO）：免打扰记到几点，没发成记什么时候重试，其余没有。 */
export function holdUntilOf(result: AckResult): string | undefined {
  if (result.status === 'deferred') return result.until;
  return result.status === 'failed' ? result.retryAfter : undefined;
}
