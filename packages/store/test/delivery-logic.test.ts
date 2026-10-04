import { describe, expect, it } from 'vitest';
import {
  assertOutcomeHasReason,
  claimedResult,
  duplicateVersionObject,
  isForceReclaimable,
  isReclaimable,
  judgeCarriers,
  newestSuperseding,
  outcomeFields,
  reclaimedAttempts,
  reclaimMissStatus,
  sameInstant,
  supersedes,
} from '../src/delivery-logic.ts';
import { type GitHubDeliveryOutcome, REPO_NOT_MANAGED } from '../src/ports.ts';

const STALE = '2026-01-01T00:10:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const FRESH = '2026-01-01T00:20:00.000Z';

describe('投递共用判断', () => {
  it('sameInstant：秒和毫秒写法算同一时刻，差一毫秒不算', () => {
    expect(sameInstant('2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(sameInstant('2026-01-01T00:00:00.001Z', '2026-01-01T00:00:00.000Z')).toBe(false);
  });

  it('isReclaimable：出错、等着随时可接；处理中只有占用早于 staleBefore 才可接；处理完的不可接', () => {
    expect(isReclaimable({ status: 'failed', claimedAt: FRESH }, STALE)).toBe(true);
    expect(isReclaimable({ status: 'waiting', claimedAt: FRESH }, STALE)).toBe(true);
    expect(isReclaimable({ status: 'processing', claimedAt: OLD }, STALE)).toBe(true);
    expect(isReclaimable({ status: 'processing', claimedAt: STALE }, STALE)).toBe(false);
    expect(isReclaimable({ status: 'processing', claimedAt: FRESH }, STALE)).toBe(false);
    expect(isReclaimable({ status: 'accepted', claimedAt: OLD }, STALE)).toBe(false);
    expect(isReclaimable({ status: 'ignored', claimedAt: OLD }, STALE)).toBe(false);
  });

  it('isForceReclaimable：处理完的也能抢；处理中占用没过期的不抢', () => {
    expect(isForceReclaimable({ status: 'accepted', claimedAt: FRESH }, STALE)).toBe(true);
    expect(isForceReclaimable({ status: 'ignored', claimedAt: FRESH }, STALE)).toBe(true);
    expect(isForceReclaimable({ status: 'processing', claimedAt: OLD }, STALE)).toBe(true);
    expect(isForceReclaimable({ status: 'processing', claimedAt: FRESH }, STALE)).toBe(false);
  });

  it('force 能抢到的一定包含不 force 能抢到的（故意造：任何状态组合都不许反过来）', () => {
    for (const status of ['processing', 'accepted', 'ignored', 'failed', 'waiting'] as const) {
      for (const claimedAt of [OLD, STALE, FRESH]) {
        const row = { status, claimedAt };
        if (isReclaimable(row, STALE)) expect(isForceReclaimable(row, STALE)).toBe(true);
      }
    }
  });

  it('reclaimedAttempts：从等着接回来不加次数，其余加一', () => {
    expect(reclaimedAttempts({ status: 'waiting', attempts: 3 })).toBe(3);
    expect(reclaimedAttempts({ status: 'failed', attempts: 3 })).toBe(4);
    expect(reclaimedAttempts({ status: 'processing', attempts: 1 })).toBe(2);
  });

  it('reclaimMissStatus：没有 = not_found，处理中 = in_flight，其余 = finished', () => {
    expect(reclaimMissStatus(undefined)).toBe('not_found');
    expect(reclaimMissStatus('processing')).toBe('in_flight');
    expect(reclaimMissStatus('accepted')).toBe('finished');
    expect(reclaimMissStatus('ignored')).toBe('finished');
  });

  it('judgeCarriers：有没被门挡掉的 = duplicate；全被门挡掉的看原因；没人带过 = 不算 seenBefore', () => {
    expect(judgeCarriers([])).toEqual({ duplicate: false, seenBefore: false });
    expect(judgeCarriers([{ status: 'accepted' }])).toEqual({ duplicate: true });
    expect(judgeCarriers([{ status: 'processing' }, { status: 'ignored', reason: 'x' }])).toEqual({
      duplicate: true,
    });
    expect(judgeCarriers([{ status: 'ignored', reason: REPO_NOT_MANAGED }])).toEqual({
      duplicate: false,
      seenBefore: false,
    });
    expect(judgeCarriers([{ status: 'ignored', reason: 'stranger_comment' }])).toEqual({
      duplicate: false,
      seenBefore: true,
    });
    // 库里读回来没原因是 null、内存版是 undefined：都不是「仓不受管」，所以算见过
    expect(judgeCarriers([{ status: 'ignored', reason: null }])).toEqual({
      duplicate: false,
      seenBefore: true,
    });
    expect(judgeCarriers([{ status: 'ignored' }])).toEqual({ duplicate: false, seenBefore: true });
  });

  it('claimedResult：seenBefore 只在为 true 时才出现（字段不能是 false 或 undefined）', () => {
    expect(claimedResult('t', false, false)).toEqual({ status: 'claimed', token: 't', retry: false });
    expect('seenBefore' in claimedResult('t', true, false)).toBe(false);
    expect(claimedResult('t', true, true)).toEqual({
      status: 'claimed',
      token: 't',
      retry: true,
      seenBefore: true,
    });
  });

  it('duplicateVersionObject：同一对象两版回那个对象，没重复回 undefined', () => {
    expect(duplicateVersionObject([])).toBeUndefined();
    expect(duplicateVersionObject([{ object: 'a' }, { object: 'b' }])).toBeUndefined();
    expect(duplicateVersionObject([{ object: 'a' }, { object: 'b' }, { object: 'a' }])).toBe('a');
  });

  it('assertOutcomeHasReason：不收、出错、等着不写原因要抛；收下的不要原因', () => {
    expect(() => assertOutcomeHasReason({ status: 'accepted' })).not.toThrow();
    expect(() => assertOutcomeHasReason({ status: 'ignored', reason: 'r' })).not.toThrow();
    for (const status of ['ignored', 'failed', 'waiting'] as const) {
      expect(() => assertOutcomeHasReason({ status, reason: '' })).toThrow(
        /github_events_reason_when_not_taken/,
      );
    }
    // 类型上 reason 必填；运行时有人传了没有 reason 的也得挡（故意造出失败的输入）
    const bad = { status: 'failed' } as unknown as GitHubDeliveryOutcome;
    expect(() => assertOutcomeHasReason(bad)).toThrow(/github_events_reason_when_not_taken/);
  });

  it('outcomeFields：收下的只留 note、不收的只留 reason', () => {
    expect(outcomeFields({ status: 'accepted', note: 'n' })).toEqual({
      status: 'accepted',
      reason: undefined,
      note: 'n',
    });
    expect(outcomeFields({ status: 'accepted' })).toEqual({
      status: 'accepted',
      reason: undefined,
      note: undefined,
    });
    expect(outcomeFields({ status: 'waiting', reason: 'w' })).toEqual({
      status: 'waiting',
      reason: 'w',
      note: undefined,
    });
  });

  it('supersedes：同对象、有 state、state 不同、时刻更晚才算；时刻相同、同 state、没 state、别的对象都不算', () => {
    const q = { object: 'o/r:issue:1', version: '2026-01-01T00:00:00.000Z', state: 'open' as const };
    const v = (over: Partial<{ object: string; version: string; state: 'open' | 'closed' | undefined }>) => ({
      object: q.object,
      version: '2026-01-01T00:00:01.000Z',
      state: 'closed' as 'open' | 'closed' | undefined,
      ...over,
    });
    expect(supersedes(v({}), q)).toBe(true);
    expect(supersedes(v({ version: q.version }), q)).toBe(false);
    expect(supersedes(v({ version: '2025-12-31T23:59:59Z' }), q)).toBe(false);
    expect(supersedes(v({ state: 'open' }), q)).toBe(false);
    expect(supersedes(v({ state: undefined }), q)).toBe(false);
    expect(supersedes(v({ object: 'o/r:issue:2' }), q)).toBe(false);
  });

  it('newestSuperseding：挑时刻最新的；同时刻取先遇到的；空的回 null', () => {
    expect(newestSuperseding([])).toBeNull();
    const a = { id: 'a', version: '2026-01-01T00:00:01Z' };
    const b = { id: 'b', version: '2026-01-01T00:00:03.000Z' };
    const c = { id: 'c', version: '2026-01-01T00:00:03Z' };
    expect(newestSuperseding([a, b, c])).toBe(b);
    expect(newestSuperseding([a])).toBe(a);
  });
});
