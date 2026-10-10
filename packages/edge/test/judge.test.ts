// 外部看门狗的判法（#292 第 1 片）：每种一条。时间用固定的北京时间，不读墙上时钟。
import { describe, expect, it } from 'vitest';
import { judgeRound, type MachineState } from '../src/judge.ts';

const T0 = Date.parse('2026-10-10T12:00:00+08:00');
const MIN = 60_000;
const HOUR = 60 * MIN;

function up(): MachineState {
  return { status: 'up', downSince: null, consecutiveFailures: 0, lastPushedAt: null };
}

function down(since: number, failures: number, pushedAt: number | null): MachineState {
  return { status: 'down', downSince: since, consecutiveFailures: failures, lastPushedAt: pushedAt };
}

function known(hk: MachineState, fr: MachineState) {
  return { kind: 'known' as const, snapshot: { hk, fr } };
}

describe('judgeRound', () => {
  it('【故意造出的失败】香港挂：连不上只报香港，不连带报法国', () => {
    const got = judgeRound({
      now: T0,
      hk: 'unreachable',
      fr: 'unreachable',
      previous: { kind: 'none' },
    });
    expect(got.push).toBe(true);
    expect(got.text).toContain('香港挂了');
    expect(got.text).toContain('从 2026-10-10 12:00 起');
    expect(got.text).toContain('连着 1 次没通');
    expect(got.text).not.toContain('法国挂了');
    expect(got.next.hk).toEqual(down(T0, 1, T0));
    expect(got.next.fr.status).toBe('unknown');
  });

  it('【故意造出的失败】法国挂：502 报法国，香港回得来不跟着报', () => {
    const got = judgeRound({ now: T0, hk: 200, fr: 502, previous: { kind: 'none' } });
    expect(got.push).toBe(true);
    expect(got.text).toContain('法国挂了');
    expect(got.text).toContain('连着 1 次没通');
    expect(got.text).not.toContain('香港挂了');
    expect(got.next.fr).toEqual(down(T0, 1, T0));
    expect(got.next.hk).toEqual(up());
  });

  it('法国 504、连不上也算挂；回了别的状态码（不是 200 也不是 503）算挂', () => {
    for (const fr of [504, 'unreachable' as const, 500]) {
      const got = judgeRound({ now: T0, hk: 200, fr, previous: { kind: 'none' } });
      expect(got.push, String(fr)).toBe(true);
      expect(got.text, String(fr)).toContain('法国挂了');
    }
  });

  it('【故意造出的失败】法国 503 算活着：不推', () => {
    const got = judgeRound({ now: T0, hk: 200, fr: 503, previous: known(up(), up()) });
    expect(got.push).toBe(false);
    expect(got.text).toBe('');
    expect(got.next.fr).toEqual(up());
    expect(got.next.hk).toEqual(up());
  });

  it('法国 200 算活着；香港回 502 也算回得来，两台都不报', () => {
    const got = judgeRound({ now: T0, hk: 502, fr: 200, previous: known(up(), up()) });
    expect(got.push).toBe(false);
    expect(got.text).toBe('');
    expect(got.next.hk.status).toBe('up');
    expect(got.next.fr.status).toBe('up');
  });

  it('【故意造出的失败】恢复：推「恢复了，挂了多久」', () => {
    const since = T0 - 25 * MIN;
    const got = judgeRound({
      now: T0,
      hk: 200,
      fr: 200,
      previous: known(up(), down(since, 4, since)),
    });
    expect(got.push).toBe(true);
    expect(got.text).toContain('法国恢复了，挂了多久：25 分钟');
    expect(got.text).not.toContain('香港');
    expect(got.next.fr).toEqual(up());
  });

  it('挂着时法国回 503 也算恢复（后端答了，不是隧道断）', () => {
    const since = T0 - 90 * MIN;
    const got = judgeRound({
      now: T0,
      hk: 404,
      fr: 503,
      previous: known(up(), down(since, 2, since)),
    });
    expect(got.push).toBe(true);
    expect(got.text).toContain('法国恢复了，挂了多久：1 小时 30 分钟');
    expect(got.next.hk.status).toBe('up');
  });

  it('【故意造出的失败】同一次挂着不重复推', () => {
    const since = T0;
    const got = judgeRound({
      now: since + HOUR - 1,
      hk: 'unreachable',
      fr: 502,
      previous: known(down(since, 3, since), up()),
    });
    expect(got.push).toBe(false);
    expect(got.text).toBe('');
    expect(got.next.hk).toEqual(down(since, 4, since));
    expect(got.next.fr).toEqual(up());
  });

  it('同一次挂着满一小时再推一次，起点仍是原来那次', () => {
    const since = T0;
    const now = since + HOUR;
    const got = judgeRound({
      now,
      hk: 200,
      fr: 502,
      previous: known(up(), down(since, 3, since)),
    });
    expect(got.push).toBe(true);
    expect(got.text).toContain('法国仍挂着');
    expect(got.text).toContain('从 2026-10-10 12:00 起');
    expect(got.text).toContain('连着 4 次没通');
    expect(got.next.fr).toEqual(down(since, 4, now));
  });

  it('【故意造出的失败】读不到上一轮状态时照挂处理且不静默', () => {
    const downRound = judgeRound({
      now: T0,
      hk: 200,
      fr: 'unreachable',
      previous: { kind: 'unreadable' },
    });
    expect(downRound.push).toBe(true);
    expect(downRound.text).toContain('读不到上一轮状态');
    expect(downRound.text).toContain('照挂处理');
    expect(downRound.text).toContain('不静默');
    expect(downRound.text).toContain('法国挂了');
    expect(downRound.text).not.toContain('没挂');

    const upRound = judgeRound({
      now: T0,
      hk: 200,
      fr: 503,
      previous: { kind: 'unreadable' },
    });
    expect(upRound.push).toBe(true);
    expect(upRound.text).toContain('照挂处理');
    expect(upRound.text).not.toContain('没挂');
    expect(upRound.next.hk.status).toBe('up');
    expect(upRound.next.fr.status).toBe('up');
  });

  it('从来没有上一轮（存储是空的）且两台都活着：不推，和读失败不是一回事', () => {
    const got = judgeRound({ now: T0, hk: 200, fr: 200, previous: { kind: 'none' } });
    expect(got.push).toBe(false);
    expect(got.text).toBe('');
    expect(got.next.hk).toEqual(up());
    expect(got.next.fr).toEqual(up());
  });

  it('香港连不上时法国即使回了 200 也不写进这条推送', () => {
    const got = judgeRound({
      now: T0,
      hk: 'unreachable',
      fr: 200,
      previous: known(up(), down(T0 - HOUR, 2, T0 - HOUR)),
    });
    expect(got.text).toContain('香港挂了');
    expect(got.text).not.toContain('法国');
    expect(got.next.fr).toEqual(down(T0 - HOUR, 2, T0 - HOUR));
  });
});
