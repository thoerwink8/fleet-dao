// 读数入账时该记的几笔（jobs/carpool-read-notes.ts，#194 方案 4.1）：上限变了、进退避、退避结束；不该记的不记。
import { describe, expect, it } from 'vitest';
import type { CarpoolApiRead } from '../src/jobs/carpool-outage.ts';
import { readNotes } from '../src/jobs/carpool-read-notes.ts';
import { emptyLedger, type OrgLedger } from '../src/jobs/org-ledger.ts';

const T0 = new Date('2026-10-04T12:00:00.000Z');
const MIN = 60_000;
const at = (m: number) => new Date(T0.getTime() + m * MIN);
const ok = (m: number, limit: number | null = 80): CarpoolApiRead => ({
  ok: true,
  requestedAt: at(m),
  serverDate: at(m),
  ageSeconds: null,
  quota: limit === null ? null : { usedUsd: 10, limitUsd: limit, resetsAt: at(100), status: 'active' },
  org: 'ok',
});
const fail = (
  m: number,
  code: 'network' | 'http' | 'auth' | 'bad_response' | 'throttled',
): CarpoolApiRead => ({
  ok: false,
  requestedAt: at(m),
  code,
  why: 'x',
});
const led = (reads: CarpoolApiRead[]): OrgLedger => ({ ...emptyLedger(), reads });

describe('拼车上限变了记一笔', () => {
  it('80 → 100：记「拼车上限从 80 变成 100」，带前后值；上限不写死，任何数变了都记', () => {
    const [n, ...rest] = readNotes(led([ok(-5, 80)]), ok(0, 100));
    expect(rest).toEqual([]);
    expect(n).toMatchObject({
      action: 'session-org.limit',
      ok: true,
      before: { limitUsd: 80 },
      after: { limitUsd: 100 },
    });
    expect(n?.reason).toContain('拼车上限从 80 变成 100');
    expect(readNotes(led([ok(-5, 100)]), ok(0, 62.5))[0]?.reason).toContain('从 100 变成 62.5');
  });

  it('没变不记；账本里没有读数（刚起）不记，不拿 0 或 80 冒充「之前」', () => {
    expect(readNotes(led([ok(-5, 80)]), ok(0, 80))).toEqual([]);
    expect(readNotes(led([]), ok(0, 100))).toEqual([]);
  });

  it('【故意造出失败】中间有读失败、或「没设上限」的读数：跟最近一次带额度的比，不当成变了', () => {
    expect(readNotes(led([ok(-9, 80), fail(-6, 'http'), ok(-3, null)]), ok(0, 80))).toEqual([]);
    expect(readNotes(led([ok(-9, 80), ok(-3, null)]), ok(0, 100))[0]?.reason).toContain('从 80 变成 100');
  });

  it('【故意造出失败】这一次读到的是「没设上限」或读失败：不记上限变了', () => {
    expect(readNotes(led([ok(-5, 80)]), ok(0, null))).toEqual([]);
    expect(readNotes(led([ok(-5, 80)]), fail(0, 'throttled'))[0]?.action).toBe('session-org.read-backoff');
  });
});

describe('进退避、退避结束记一笔', () => {
  it('429、5xx、网断：第 1、2、3 次各记一笔（等 1、2、5 分钟）；第 4 次起封顶不再重复记', () => {
    const wait = (n: ReturnType<typeof readNotes>[number] | undefined) =>
      (n?.after as { waitMinutes: number } | undefined)?.waitMinutes;
    expect(wait(readNotes(led([]), fail(0, 'throttled'))[0])).toBe(1);
    expect(wait(readNotes(led([fail(-3, 'http')]), fail(0, 'http'))[0])).toBe(2);
    expect(wait(readNotes(led([fail(-5, 'http'), fail(-3, 'network')]), fail(0, 'network'))[0])).toBe(5);
    expect(readNotes(led([fail(-9, 'http'), fail(-7, 'http'), fail(-5, 'http')]), fail(0, 'http'))).toEqual(
      [],
    );
    const first = readNotes(led([]), fail(0, 'throttled'))[0];
    expect(first).toMatchObject({ action: 'session-org.read-backoff', ok: false, error: 'x' });
    expect(first?.reason).toContain('429');
  });

  it('【故意造出失败】Key 失效、回包认不出不记退避（它们当场推「要人看」提醒，不会自己好）', () => {
    expect(readNotes(led([]), fail(0, 'auth'))).toEqual([]);
    expect(readNotes(led([]), fail(0, 'bad_response'))).toEqual([]);
  });

  it('退避后读成了：记一笔退避结束；平时读成了不记', () => {
    const [n] = readNotes(led([fail(-3, 'http'), fail(-1, 'http')]), ok(0));
    expect(n).toMatchObject({ action: 'session-org.read-backoff', ok: true });
    expect(n?.reason).toContain('连着 2 次');
    expect(readNotes(led([ok(-3)]), ok(0))).toEqual([]);
  });
});
