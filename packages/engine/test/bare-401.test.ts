// 只凭 HTTP 401 的共享记号：同一个池短时间里，别的一次（另一个 claim）才算第二次；
// 活动重试带同一个 claim，仍算同一次。
import { describe, expect, it } from 'vitest';
import { BARE_401_WINDOW_MS, nextBare401Stamp } from '../src/workflows/task-support.ts';

const T0 = '2026-10-16T08:00:00.000Z';
const SOON = new Date(Date.parse(T0) + 60_000).toISOString();
const LATER = new Date(Date.parse(T0) + BARE_401_WINDOW_MS + 1_000).toISOString();

describe('只凭 401 的共享记号', () => {
  it('窗口里另一个 claim 算第二次；同一个 claim 再来仍是原来那一次', () => {
    const first = nextBare401Stamp(undefined, { now: T0, claim: 'task-a:p1:0' });
    expect(first.repeated).toBe(false);
    const retry = nextBare401Stamp(first.stamp, { now: SOON, claim: 'task-a:p1:0' });
    expect(retry.repeated).toBe(false);
    expect(retry.stamp).toEqual(first.stamp);
    const second = nextBare401Stamp(first.stamp, { now: SOON, claim: 'task-b:p1:0' });
    expect(second.repeated).toBe(true);
    expect(second.stamp.at).toBe(T0);
    expect(second.stamp.claim).toBe('task-b:p1:0');
  });

  it('过了窗口再来算第一次', () => {
    const first = nextBare401Stamp(undefined, { now: T0, claim: 'task-a:p1:0' });
    const again = nextBare401Stamp(first.stamp, { now: LATER, claim: 'task-b:p1:0' });
    expect(again.repeated).toBe(false);
    expect(again.stamp.at).toBe(LATER);
    expect(again.stamp.repeated).toBe(false);
  });
});
