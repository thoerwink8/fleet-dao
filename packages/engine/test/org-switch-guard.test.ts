// 切号防来回抖（jobs/org-switch-guard.ts，#194 方案 v2 4.4、4.6、第六节第 1、5、10、15 条）。
// 每条「不许做」都故意造一次：读不到不当恢复、白切不马上再切、预算用完不接着切、帮手失败不每分钟砸。
import { describe, expect, it } from 'vitest';
import type { CarpoolOutage, RecoveryVerdict } from '../src/jobs/carpool-outage.ts';
import {
  backoffUntil,
  decideSwitchBack,
  helperRetryAt,
  NO_WHITES,
  recordRejectAfterSwitchBack,
  type SwitchBackFacts,
  settleWhiteStreak,
} from '../src/jobs/org-switch-guard.ts';

const T0 = new Date('2026-10-04T02:00:00.000Z');
const MIN = 60_000;
const at = (m: number) => new Date(T0.getTime() + m * MIN);

const e1: CarpoolOutage = { kind: 'E1', since: T0, resetsAt: at(200), resetsFrom: 'api', evidence: 'x' };
const e2: CarpoolOutage = { kind: 'E2', since: T0, resetsAt: at(30), resetsFrom: 'text', evidence: 'x' };
const recovered: RecoveryVerdict = { state: 'recovered', why: '读数说恢复了' };
const unknown: RecoveryVerdict = { state: 'unknown', why: '接口没读成过（503）' };

function facts(over: Partial<SwitchBackFacts> = {}): SwitchBackFacts {
  return {
    outage: e1,
    recovery: recovered,
    onSoloSince: T0,
    recentBacks: [],
    whites: NO_WHITES,
    lastApiOkAt: at(1),
    now: at(201),
    ...over,
  };
}

describe('能不能切回', () => {
  it('E1 读数确认恢复 → 切回，不受最小停留限制', () => {
    const d = decideSwitchBack(facts({ now: at(5) }));
    expect(d).toMatchObject({ action: 'go', mode: 'confirmed' });
  });

  it('E2 证据说恢复了，可切到独享不到 20 分钟 → 等最小停留', () => {
    const d = decideSwitchBack(facts({ outage: e2, now: at(10) }));
    expect(d).toMatchObject({ action: 'hold', until: at(20) });
  });

  it('证据说还没（not-yet）→ 不切，等到预计时刻', () => {
    const d = decideSwitchBack(facts({ recovery: { state: 'not-yet', why: '剩 30%', at: at(260) } }));
    expect(d).toMatchObject({ action: 'hold', until: at(260) });
  });

  it('第六节第 15 条：5 小时里第 4 次自动切回 → 不切、要人看', () => {
    // 现在是 at(201)：这三次都在 5 小时以内
    const backs = [at(-90), at(0), at(100)].map((d) => ({ at: d, trial: false }));
    const d = decideSwitchBack(facts({ recentBacks: backs }));
    expect(d.action).toBe('stuck');
    expect(d.why).toMatch(/预算用完/);
  });

  it('5 小时以外的切回不算进预算', () => {
    const backs = [at(-400), at(-350), at(100)].map((d) => ({ at: d, trial: false }));
    expect(decideSwitchBack(facts({ recentBacks: backs })).action).toBe('go');
  });

  it('连着 3 次白切 → 要人看，不再自己切回', () => {
    const d = decideSwitchBack(facts({ whites: { count: 3, lastAt: at(100), lastTrial: false } }));
    expect(d.action).toBe('stuck');
  });

  it('白切 1 次（确认过的切回撞的）→ 退避 15 分钟内不切回', () => {
    const whites = { count: 1, lastAt: at(195), lastTrial: false };
    expect(decideSwitchBack(facts({ whites, now: at(205) }))).toMatchObject({
      action: 'hold',
      until: at(210),
    });
    expect(decideSwitchBack(facts({ whites, now: at(211) })).action).toBe('go');
  });
});

describe('第六节第 1 条：接口一直读不到', () => {
  const down = { recovery: unknown, lastApiOkAt: null, outage: { ...e2, resetsAt: at(30) } };

  it('上次读到的恢复时刻已过、头 15 分钟 → 不切回', () => {
    expect(decideSwitchBack(facts({ ...down, now: at(40) }))).toMatchObject({
      action: 'hold',
      until: at(45),
    });
  });

  it('过了 15 分钟 → 试探切回，写明是试探', () => {
    const d = decideSwitchBack(facts({ ...down, now: at(46) }));
    expect(d).toMatchObject({ action: 'go', mode: 'trial' });
    expect(d.why).toMatch(/试探/);
  });

  it('试探又被拒 → 记白切，下一次试探至少等 30 分钟', () => {
    const whites = recordRejectAfterSwitchBack(NO_WHITES, { at: at(46), trial: true }, at(48));
    expect(whites).toEqual({ count: 1, lastAt: at(48), lastTrial: true });
    expect(backoffUntil(whites)).toEqual(at(78));
    expect(decideSwitchBack(facts({ ...down, whites, now: at(70) })).action).toBe('hold');
    expect(decideSwitchBack(facts({ ...down, whites, now: at(79) })).action).toBe('go');
  });

  it('读不到不当恢复：没过恢复时刻、也没过最小停留时不试探', () => {
    expect(decideSwitchBack(facts({ ...down, now: at(10) })).action).toBe('hold');
  });
});

describe('第六节第 5 条：恢复时刻拿不到（E2 原文没写几点）', () => {
  const noTime = { outage: { ...e2, resetsAt: null, resetsFrom: null }, recovery: unknown };

  it('20 分钟内不切回', () => {
    expect(decideSwitchBack(facts({ ...noTime, now: at(15) }))).toMatchObject({
      action: 'hold',
      until: at(20),
    });
  });

  it('过了最小停留 → 试探', () => {
    expect(decideSwitchBack(facts({ ...noTime, now: at(21) }))).toMatchObject({
      action: 'go',
      mode: 'trial',
    });
  });

  it('第 3 次白切 → 要人看', () => {
    let w = NO_WHITES;
    for (const m of [21, 60, 130]) w = recordRejectAfterSwitchBack(w, { at: at(m), trial: true }, at(m + 2));
    expect(decideSwitchBack(facts({ ...noTime, whites: w, now: at(400) })).action).toBe('stuck');
  });
});

describe('白切记账', () => {
  it('切回 15 分钟以后才被拒不算白切，记账清零', () => {
    const w = { count: 2, lastAt: at(0), lastTrial: false };
    expect(recordRejectAfterSwitchBack(w, { at: at(10), trial: false }, at(40))).toEqual(NO_WHITES);
  });

  it('切回后稳定跑满 1 小时 → 清零；不满 → 照留', () => {
    const w = { count: 2, lastAt: at(0), lastTrial: false };
    const back = { at: at(10), trial: false };
    expect(settleWhiteStreak(w, back, at(69))).toBe(w);
    expect(settleWhiteStreak(w, back, at(71))).toEqual(NO_WHITES);
  });

  it('退避翻倍、封顶 4 小时', () => {
    expect(backoffUntil({ count: 2, lastAt: T0, lastTrial: false })).toEqual(at(30));
    expect(backoffUntil({ count: 9, lastAt: T0, lastTrial: false })).toEqual(at(240));
  });
});

describe('在独享上待太久', () => {
  it('过了预计恢复时刻 30 分钟还没切回 → 另带一条要人看', () => {
    const d = decideSwitchBack(
      facts({ recovery: { state: 'not-yet', why: '剩 30%', at: null }, now: at(231) }),
    );
    expect(d.action).toBe('hold');
    expect(d.overdue).toMatch(/还挂在独享上/);
  });

  it('没过 30 分钟不报', () => {
    const d = decideSwitchBack(
      facts({ recovery: { state: 'not-yet', why: '剩 30%', at: null }, now: at(220) }),
    );
    expect(d.overdue).toBeUndefined();
  });
});

describe('第六节第 10 条：帮手切号失败的退避', () => {
  it('第一次失败后 2 分钟内不再试，第二次失败后 10 分钟，再往后 30 分钟', () => {
    expect(helperRetryAt([])).toBeNull();
    expect(helperRetryAt([at(0)])).toEqual(at(2));
    expect(helperRetryAt([at(0), at(3)])).toEqual(at(13));
    expect(helperRetryAt([at(0), at(3), at(14), at(50)])).toEqual(at(80));
  });
});
