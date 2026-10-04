import { describe, expect, it } from 'vitest';
import {
  byCardDue,
  type IntentRecord,
  isCardPending,
  NO_SUCH_INTENT,
  recallConflict,
} from '../src/intents.ts';

const card = (c: Partial<IntentRecord['card']> = {}): IntentRecord['card'] => ({
  rev: 2,
  attempts: 0,
  dueAt: '2026-01-01T00:00:00.000Z',
  ...c,
});

const intent = (seq: number, dueAt: string | undefined): IntentRecord =>
  ({ seq, card: card({ dueAt }) }) as IntentRecord;

describe('意图存储共用判断', () => {
  it('isCardPending：定了到期时刻、卡不是最新一版、有东西可发才算', () => {
    expect(isCardPending(card(), true)).toBe(true);
    expect(isCardPending(card({ shownRev: 1 }), true)).toBe(true);
    expect(isCardPending(card({ shownRev: 2 }), true)).toBe(false);
    expect(isCardPending(card({ shownRev: 3 }), true)).toBe(false);
    expect(isCardPending(card({ dueAt: undefined }), true)).toBe(false);
  });

  it('isCardPending：卡发过就算有东西可发；没发过又没有可读的原话（全撤回了）不给', () => {
    expect(isCardPending(card({ messageId: 'om_1' }), false)).toBe(true);
    expect(isCardPending(card(), false)).toBe(false);
  });

  it('byCardDue：先到期的在前，同一刻按段号', () => {
    const list = [
      intent(3, '2026-01-01T00:10:00.000Z'),
      intent(2, '2026-01-01T00:05:00.000Z'),
      intent(1, '2026-01-01T00:10:00.000Z'),
    ];
    expect([...list].sort(byCardDue).map((i) => i.seq)).toEqual([2, 1, 3]);
  });

  it('byCardDue：秒和毫秒写法算同一时刻（按时刻比，不按字面比）', () => {
    const a = intent(2, '2026-01-01T00:00:00Z');
    const b = intent(1, '2026-01-01T00:00:00.000Z');
    expect(byCardDue(a, b)).toBeGreaterThan(0);
  });

  it('recallConflict：原话在另一个会话先于墓碑判；墓碑在另一个会话；同一个会话或都没有没冲突', () => {
    expect(recallConflict({ chatId: 'a' }, { chatId: 'b' }, 'c')).toBe('要撤回的这条原话记在另一个会话里');
    expect(recallConflict(undefined, { chatId: 'b' }, 'c')).toBe('这个消息编号的撤回已经记在另一个会话里');
    expect(recallConflict({ chatId: 'c' }, { chatId: 'b' }, 'c')).toBe(
      '这个消息编号的撤回已经记在另一个会话里',
    );
    expect(recallConflict({ chatId: 'c' }, { chatId: 'c' }, 'c')).toBeUndefined();
    expect(recallConflict(undefined, undefined, 'c')).toBeUndefined();
  });

  it('NO_SUCH_INTENT 的字面（接口返回给调用方看的原因）', () => {
    expect(NO_SUCH_INTENT).toBe('没有这段意图');
  });
});
