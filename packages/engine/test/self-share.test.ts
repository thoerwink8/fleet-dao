// 名额按错误预算分（#3618）：判档的纯函数、档位对应的名额、读到的档位还能不能信、简报「名额」一节用的几行。
import { parseSelfShare, redMinutes, type SelfShareRecord } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  healthyStreak,
  judgeSelfShare,
  SELF_SHARE_STALE_MS,
  type SelfShareMetrics,
  selfShareLimits,
  selfShareLines,
  selfShareUnusable,
} from '../src/jobs/self-share.ts';

const AT = new Date('2026-10-22T00:30:00Z');
const DAY = '2026-10-22';
const PASS: SelfShareMetrics = {
  oneRoundRate: 0.5,
  verifyRejectShare: 0.1,
  mainRedMinutes: 30,
  selfDefectIssues: 12,
  offReasonDecisions: 0,
};
/** 前两天五项都过。 */
const TWO_GOOD_DAYS = [
  { day: '2026-10-20', allPass: true },
  { day: '2026-10-21', allPass: true },
];
const failed = (r: SelfShareRecord) => r.checks.filter((c) => !c.pass).map((c) => c.key);

describe('judgeSelfShare：五项都过且连续 3 天＝健康', () => {
  it('今天加前两天都全过：健康，五项都过', () => {
    const r = judgeSelfShare(PASS, TWO_GOOD_DAYS, DAY, AT);
    expect(r.tier).toBe('healthy');
    expect(failed(r)).toEqual([]);
    expect(r.day).toBe(DAY);
    expect(r.at).toBe(AT);
    expect(r.days.at(-1)).toEqual({ day: DAY, allPass: true });
  });

  it('门槛边上都算过：做成率 40%、拒绝 15%、CI 红 60 分钟、缺陷单 30 张、拍板卡 0', () => {
    const edge = judgeSelfShare(
      {
        oneRoundRate: 0.4,
        verifyRejectShare: 0.15,
        mainRedMinutes: 60,
        selfDefectIssues: 30,
        offReasonDecisions: 0,
      },
      TWO_GOOD_DAYS,
      DAY,
      AT,
    );
    expect(failed(edge)).toEqual([]);
    expect(edge.tier).toBe('healthy');
  });

  it('全过但不满 3 天（中间断过、或没有历史）：其余情况，冻结', () => {
    const gap = judgeSelfShare(
      PASS,
      [
        { day: '2026-10-20', allPass: false },
        { day: '2026-10-21', allPass: true },
      ],
      DAY,
      AT,
    );
    expect(gap.tier).toBe('frozen');
    expect(judgeSelfShare(PASS, [], DAY, AT).tier).toBe('frozen');
    // 日期不连着（缺了 10-21）也不算连续
    expect(judgeSelfShare(PASS, [{ day: '2026-10-20', allPass: true }], DAY, AT).tier).toBe('frozen');
  });

  it('同一天再跑一次（手动触发）换掉那一天的结论，不重复记；只留最近 7 天', () => {
    const history = [{ day: DAY, allPass: false }, ...TWO_GOOD_DAYS];
    const r = judgeSelfShare(PASS, history, DAY, AT);
    expect(r.days.filter((d) => d.day === DAY)).toEqual([{ day: DAY, allPass: true }]);
    expect(r.tier).toBe('healthy');
    const long = Array.from({ length: 10 }, (_, i) => ({
      day: `2026-10-${String(10 + i).padStart(2, '0')}`,
      allPass: true,
    }));
    expect(judgeSelfShare(PASS, long, DAY, AT).days).toHaveLength(7);
  });
});

describe('judgeSelfShare：只 1 项没过（CI 红除外）＝耗预算', () => {
  it.each([
    ['oneRoundRate', { oneRoundRate: 0.39 }],
    ['verifyRejectShare', { verifyRejectShare: 0.16 }],
    ['selfDefectIssues', { selfDefectIssues: 31 }],
    ['offReasonDecisions', { offReasonDecisions: 1 }],
  ] as const)('只有 %s 没过：耗预算，哪怕前两天全过', (key, over) => {
    const r = judgeSelfShare({ ...PASS, ...over }, TWO_GOOD_DAYS, DAY, AT);
    expect(failed(r)).toEqual([key]);
    expect(r.tier).toBe('budget');
    expect(r.days.at(-1)?.allPass).toBe(false);
  });
});

describe('judgeSelfShare：其余＝冻结', () => {
  it('2 项没过：冻结', () => {
    const r = judgeSelfShare({ ...PASS, oneRoundRate: 0.2, verifyRejectShare: 0.3 }, TWO_GOOD_DAYS, DAY, AT);
    expect(failed(r)).toEqual(['oneRoundRate', 'verifyRejectShare']);
    expect(r.tier).toBe('frozen');
  });

  it('只有主线 CI 红没过也冻结（CI 红那项不能按「只 1 项没过」算耗预算）', () => {
    const r = judgeSelfShare({ ...PASS, mainRedMinutes: 61 }, TWO_GOOD_DAYS, DAY, AT);
    expect(failed(r)).toEqual(['mainRedMinutes']);
    expect(r.tier).toBe('frozen');
  });

  it('诊断实况（做成率低、拒绝高、缺陷单多、拍板卡有）：冻结', () => {
    const r = judgeSelfShare(
      {
        oneRoundRate: 0.35,
        verifyRejectShare: 0.25,
        mainRedMinutes: 0,
        selfDefectIssues: 129,
        offReasonDecisions: 35,
      },
      [],
      DAY,
      AT,
    );
    expect(r.tier).toBe('frozen');
  });
});

describe('judgeSelfShare：读不到按「没过」算', () => {
  it('一项读不到、其余都过：那一项没过，值是 null，耗预算（不是健康）', () => {
    const r = judgeSelfShare({ ...PASS, selfDefectIssues: null }, TWO_GOOD_DAYS, DAY, AT);
    expect(r.checks.find((c) => c.key === 'selfDefectIssues')).toEqual({
      key: 'selfDefectIssues',
      value: null,
      pass: false,
    });
    expect(r.tier).toBe('budget');
  });

  it('读不到的是主线 CI 红：冻结；两项读不到：冻结；全读不到：冻结', () => {
    expect(judgeSelfShare({ ...PASS, mainRedMinutes: null }, TWO_GOOD_DAYS, DAY, AT).tier).toBe('frozen');
    expect(
      judgeSelfShare({ ...PASS, oneRoundRate: null, offReasonDecisions: null }, TWO_GOOD_DAYS, DAY, AT).tier,
    ).toBe('frozen');
    const none = judgeSelfShare(
      {
        oneRoundRate: null,
        verifyRejectShare: null,
        mainRedMinutes: null,
        selfDefectIssues: null,
        offReasonDecisions: null,
      },
      TWO_GOOD_DAYS,
      DAY,
      AT,
    );
    expect(none.tier).toBe('frozen');
    expect(failed(none)).toHaveLength(5);
  });

  it('NaN 不当成过：按读不到算', () => {
    const r = judgeSelfShare({ ...PASS, oneRoundRate: Number.NaN }, TWO_GOOD_DAYS, DAY, AT);
    expect(r.checks[0]).toEqual({ key: 'oneRoundRate', value: null, pass: false });
  });
});

describe('连续天数、名额、档位可不可信', () => {
  it('healthyStreak：从今天往前数连着的全过天，断了或缺日就停', () => {
    const days = [...TWO_GOOD_DAYS, { day: DAY, allPass: true }];
    expect(healthyStreak(days, DAY)).toBe(3);
    expect(healthyStreak([...days, { day: '2026-10-23', allPass: false }], '2026-10-23')).toBe(0);
    expect(healthyStreak([], DAY)).toBe(0);
  });

  it('selfShareLimits：健康 30%、耗预算 50%（至少 1 条），冻结不拉别的仓', () => {
    expect(selfShareLimits('healthy', 6)).toEqual({ selfCap: 1, othersAllowed: true });
    expect(selfShareLimits('budget', 6)).toEqual({ selfCap: 3, othersAllowed: true });
    expect(selfShareLimits('healthy', 10)).toEqual({ selfCap: 3, othersAllowed: true });
    expect(selfShareLimits('healthy', 2).selfCap).toBe(1);
    expect(selfShareLimits('frozen', 6)).toEqual({ selfCap: null, othersAllowed: false });
  });

  it('selfShareUnusable：没有这一行、太久没更新不能用，新的能用', () => {
    expect(selfShareUnusable(null, AT)).toContain('还没算过');
    expect(selfShareUnusable({ at: new Date(AT.getTime() - SELF_SHARE_STALE_MS - 1) }, AT)).toContain(
      '没更新',
    );
    expect(selfShareUnusable({ at: new Date(AT.getTime() - 86_400_000) }, AT)).toBeNull();
    expect(selfShareUnusable({ at: new Date('nope') }, AT)).toContain('认不出');
  });

  it('设置里的值来回一遍认得出；形状不对照抛', () => {
    const rec = judgeSelfShare({ ...PASS, oneRoundRate: null }, TWO_GOOD_DAYS, DAY, AT);
    const stored = JSON.parse(JSON.stringify({ ...rec, at: rec.at.toISOString() }));
    expect(parseSelfShare(stored)).toEqual(rec);
    expect(() => parseSelfShare({ tier: 'weird' })).toThrow('engine.selfShare');
    expect(() => parseSelfShare(null)).toThrow('engine.selfShare');
  });

  it('简报「名额」几行：档位、每项现值（读不到写「读不到」）、连续天数', () => {
    const rec = judgeSelfShare({ ...PASS, oneRoundRate: null, mainRedMinutes: 90 }, TWO_GOOD_DAYS, DAY, AT);
    const lines = selfShareLines(rec).join('\n');
    expect(lines).toContain('档位：冻结；只拉 fleet-dao 自身单，其他仓不拉新单（在跑的照跑）');
    expect(lines).toContain('一轮做成率：读不到（要求 ≥ 40%）没过');
    expect(lines).toContain('主线 CI 红：90 分钟（要求 ≤ 60 分钟）没过');
    expect(lines).toContain('冷验收拒绝占比：10%（要求 ≤ 15%）过');
    expect(lines).toContain('五项都过已连续 0 天');
    const ok = selfShareLines(judgeSelfShare(PASS, TWO_GOOD_DAYS, DAY, AT)).join('\n');
    expect(ok).toContain('档位：健康；fleet-dao 自身单最多占在跑名额的 30%');
    expect(ok).toContain('五项都过已连续 3 天');
  });
});

describe('redMinutes：主线红了多少分钟', () => {
  const from = new Date('2026-10-15T00:00:00Z');
  const to = new Date('2026-10-22T00:00:00Z');
  const t = (s: string) => new Date(`2026-10-${s}:00Z`);

  it('截到窗口里、还开着的算到窗口尾、重叠的并起来只算一次', () => {
    expect(redMinutes([{ start: t('16T10:00'), end: t('16T10:45') }], from, to)).toBe(45);
    // 窗口前开始、窗口里撤：只算窗口里那段
    expect(redMinutes([{ start: t('14T23:00'), end: t('15T00:20') }], from, to)).toBe(20);
    // 还开着：算到 to
    expect(redMinutes([{ start: t('21T23:00'), end: null }], from, to)).toBe(60);
    // 两张重叠（10:00–10:40 和 10:20–11:00）合成 60 分钟
    expect(
      redMinutes(
        [
          { start: t('16T10:00'), end: t('16T10:40') },
          { start: t('16T10:20'), end: t('16T11:00') },
        ],
        from,
        to,
      ),
    ).toBe(60);
    expect(redMinutes([], from, to)).toBe(0);
  });
});
