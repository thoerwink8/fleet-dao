import { describe, expect, it } from 'vitest';
import { ackReasonOf, holdUntilOf, judgeOutboxAck } from '../src/outbox-logic.ts';

const sent = { status: 'sent' as const };
const updated = { status: 'updated' as const };
const failed = { status: 'failed' as const };

describe('飞书发件箱回执共用判断', () => {
  it('没有这个条目：unknown_item（先于其余判断）', () => {
    expect(judgeOutboxAck(undefined, { revision: 1, result: sent })).toEqual({
      kind: 'skip',
      why: 'unknown_item',
    });
  });

  it('回执的版本比库里最新还新：future_revision，不管是什么结果', () => {
    expect(judgeOutboxAck({ revision: 2 }, { revision: 3, result: sent })).toEqual({
      kind: 'skip',
      why: 'future_revision',
    });
    expect(judgeOutboxAck({ revision: 2 }, { revision: 3, result: failed })).toEqual({
      kind: 'skip',
      why: 'future_revision',
    });
  });

  it('正是最新一版：任何结果都算数，current=true', () => {
    for (const result of [
      sent,
      updated,
      failed,
      { status: 'dropped' as const },
      { status: 'deferred' as const },
    ]) {
      expect(judgeOutboxAck({ revision: 2 }, { revision: 2, result })).toEqual({
        kind: 'apply',
        current: true,
      });
    }
  });

  it('旧版本：只有「送到了／改了」算数（current=false），其余是 stale_revision', () => {
    expect(judgeOutboxAck({ revision: 3 }, { revision: 2, result: sent })).toEqual({
      kind: 'apply',
      current: false,
    });
    expect(judgeOutboxAck({ revision: 3 }, { revision: 2, result: updated })).toEqual({
      kind: 'apply',
      current: false,
    });
    for (const result of [failed, { status: 'dropped' as const }, { status: 'deferred' as const }]) {
      expect(judgeOutboxAck({ revision: 3 }, { revision: 2, result })).toEqual({
        kind: 'skip',
        why: 'stale_revision',
      });
    }
  });

  it('已经送到过更新一版：旧版本迟到的「送到了」也不算；送到的是同版或更旧才算', () => {
    const row = { revision: 5, deliveredMessageId: 'm', deliveredRevision: 4 };
    expect(judgeOutboxAck(row, { revision: 3, result: sent })).toEqual({
      kind: 'skip',
      why: 'stale_revision',
    });
    expect(judgeOutboxAck(row, { revision: 4, result: sent })).toEqual({ kind: 'apply', current: false });
  });

  it('送到的记录不全（只有消息编号、没记版本，或相反；null 和 undefined 一样）：不拿它挡回执', () => {
    expect(judgeOutboxAck({ revision: 5, deliveredMessageId: 'm' }, { revision: 3, result: sent })).toEqual({
      kind: 'apply',
      current: false,
    });
    expect(
      judgeOutboxAck(
        { revision: 5, deliveredMessageId: null, deliveredRevision: 4 },
        { revision: 3, result: sent },
      ),
    ).toEqual({ kind: 'apply', current: false });
  });

  it('ackReasonOf / holdUntilOf：不发了和免打扰记原因，没发成记错误；等到几点只有免打扰和没发成有', () => {
    expect(ackReasonOf({ status: 'dropped', reason: 'over_budget' })).toBe('over_budget');
    expect(ackReasonOf({ status: 'deferred', until: 'T', reason: 'quiet_hours' })).toBe('quiet_hours');
    expect(ackReasonOf({ status: 'failed', error: 'boom', retryAfter: 'T2' })).toBe('boom');
    expect(ackReasonOf({ status: 'updated', messageId: 'm' })).toBeUndefined();
    expect(ackReasonOf({ status: 'sent', messageId: 'm', chatId: 'c', sentAt: 'T' })).toBeUndefined();
    expect(holdUntilOf({ status: 'deferred', until: 'T', reason: 'quiet_hours' })).toBe('T');
    expect(holdUntilOf({ status: 'failed', error: 'boom', retryAfter: 'T2' })).toBe('T2');
    expect(holdUntilOf({ status: 'dropped', reason: 'over_budget' })).toBeUndefined();
    expect(holdUntilOf({ status: 'updated', messageId: 'm' })).toBeUndefined();
  });
});
