// 名额按错误预算分（jobs/self-share.ts）：档位怎么算（健康、耗预算、冻结、读不到）、每档的名额份额；GitHub 数据怎么折成两项现值。
import { parseSelfShare, type SelfShareDay, type SelfShareItemKey } from '@fleet-dao/db';
import { describe, expect, it } from 'vitest';
import {
  computeSelfShare,
  othersMayPull,
  SELF_SHARE_LINES,
  type SelfShareReading,
  type SelfShareReadings,
  selfShareCap,
  selfShareLineText,
  selfShareValueText,
} from '../src/jobs/self-share.ts';
import { ciRedMinutes, countMachineDefects } from '../src/real/self-share-facts.ts';

const AT = new Date('2026-10-22T00:30:00Z');
const DAY = '2026-10-22';
const PASS: SelfShareReadings = {
  oneRoundRate: { value: 0.45 },
  verifyReject: { value: 0.1 },
  ciRedMinutes: { value: 30 },
  selfDefects: { value: 12 },
  offReasonDecisions: { value: 0 },
};
const two = (ago: number): string =>
  new Date(Date.parse(`${DAY}T00:00:00Z`) - ago * 86_400_000).toISOString().slice(0, 10);
const PASSED_BEFORE: SelfShareDay[] = [
  { day: two(2), allPass: true },
  { day: two(1), allPass: true },
];
const readings = (over: Partial<Record<SelfShareItemKey, SelfShareReading>>): SelfShareReadings => ({
  ...PASS,
  ...over,
});
const tierOf = (r: SelfShareReadings, previous: SelfShareDay[] = PASSED_BEFORE) =>
  computeSelfShare({ readings: r, day: DAY, previous, at: AT });

describe('computeSelfShare · 分档', () => {
  it('健康：5 项都过，且连续 3 天（含今天）都全过', () => {
    const row = tierOf(PASS);
    expect(row.tier).toBe('healthy');
    expect(row.streak).toBe(3);
    expect(row.items.every((i) => i.passed)).toBe(true);
  });

  it('边界上的值算过：做成率正好 40%、拒绝正好 15%、CI 红正好 60 分钟、缺陷单正好 30 张、拍板卡 0 张', () => {
    const row = tierOf(
      readings({
        oneRoundRate: { value: 0.4 },
        verifyReject: { value: 0.15 },
        ciRedMinutes: { value: 60 },
        selfDefects: { value: 30 },
      }),
    );
    expect(row.tier).toBe('healthy');
  });

  it('5 项都过，但今天是第一天（前几天没全过）→ 还不是健康，按「其余」冻结', () => {
    const row = tierOf(PASS, [{ day: two(1), allPass: false }]);
    expect(row.streak).toBe(1);
    expect(row.tier).toBe('frozen');
  });

  it('连续天数只数日期相邻的：中间缺一天（那天简报没算成）就断', () => {
    const row = tierOf(PASS, [
      { day: two(3), allPass: true },
      { day: two(1), allPass: true },
    ]);
    expect(row.streak).toBe(2);
    expect(row.tier).toBe('frozen');
  });

  it('同一天重算会换掉今天那一条，不重复数', () => {
    const row = tierOf(PASS, [...PASSED_BEFORE, { day: DAY, allPass: false }]);
    expect(row.history.filter((d) => d.day === DAY)).toEqual([{ day: DAY, allPass: true }]);
    expect(row.tier).toBe('healthy');
  });

  it.each([
    ['oneRoundRate', { value: 0.39 }],
    ['verifyReject', { value: 0.16 }],
    ['selfDefects', { value: 31 }],
    ['offReasonDecisions', { value: 1 }],
  ] as const)('耗预算：只有「%s」一项没过', (key, reading) => {
    const row = tierOf(readings({ [key]: reading }));
    expect(row.tier).toBe('spending');
    expect(row.items.filter((i) => !i.passed).map((i) => i.key)).toEqual([key]);
    expect(row.streak).toBe(0);
  });

  it('冻结：只有 CI 红那一项没过也冻结（那一项除外于「耗预算」）', () => {
    expect(tierOf(readings({ ciRedMinutes: { value: 61 } })).tier).toBe('frozen');
  });

  it('冻结：2 项以上没过', () => {
    expect(tierOf(readings({ oneRoundRate: { value: 0.2 }, verifyReject: { value: 0.3 } })).tier).toBe(
      'frozen',
    );
  });

  it('读不到按没过算：一项读不到＝只有 1 项没过（耗预算），原因留在那一项上', () => {
    const row = tierOf(readings({ selfDefects: { value: null, unread: '读机器开的自身缺陷单：HTTP 502' } }));
    expect(row.tier).toBe('spending');
    const item = row.items.find((i) => i.key === 'selfDefects');
    expect(item).toMatchObject({ value: null, passed: false, unread: '读机器开的自身缺陷单：HTTP 502' });
  });

  it('读不到按没过算：读不到的是 CI 红那一项 → 冻结；两项读不到 → 冻结；全读不到 → 冻结', () => {
    expect(tierOf(readings({ ciRedMinutes: { value: null, unread: 'x' } })).tier).toBe('frozen');
    expect(tierOf(readings({ oneRoundRate: { value: null }, verifyReject: { value: null } })).tier).toBe(
      'frozen',
    );
    const none = Object.fromEntries(
      Object.keys(SELF_SHARE_LINES).map((k) => [k, { value: null }]),
    ) as SelfShareReadings;
    const row = tierOf(none);
    expect(row.tier).toBe('frozen');
    expect(row.items.every((i) => !i.passed && i.unread !== undefined)).toBe(true);
  });

  it('NaN 也算读不到', () => {
    expect(tierOf(readings({ verifyReject: { value: Number.NaN } })).items[1]).toMatchObject({
      value: null,
      passed: false,
    });
  });
});

describe('名额份额', () => {
  it('健康 30%、耗预算 50% 按在跑上限取整（至少 1 条）；冻结不按成数限', () => {
    expect(selfShareCap('healthy', 6)).toBe(1);
    expect(selfShareCap('spending', 6)).toBe(3);
    expect(selfShareCap('healthy', 10)).toBe(3);
    // 在跑上限太小时向下取整到 0，不凑出 1 条超过成数
    expect(selfShareCap('healthy', 1)).toBe(0);
    expect(selfShareCap('healthy', 3)).toBe(0);
    expect(selfShareCap('healthy', 4)).toBe(1);
    expect(selfShareCap('spending', 1)).toBe(0);
    expect(selfShareCap('spending', 2)).toBe(1);
    expect(selfShareCap('frozen', 6)).toBeNull();
  });

  it('只有冻结时别的仓不能拉新单', () => {
    expect(othersMayPull('healthy')).toBe(true);
    expect(othersMayPull('spending')).toBe(true);
    expect(othersMayPull('frozen')).toBe(false);
  });

  it('现值和线写成人话', () => {
    expect(selfShareValueText({ key: 'oneRoundRate', value: 0.357 })).toBe('35.7%');
    expect(selfShareValueText({ key: 'ciRedMinutes', value: 254 })).toBe('254 分钟');
    expect(selfShareValueText({ key: 'selfDefects', value: null })).toBe('读不到');
    expect(selfShareLineText('oneRoundRate')).toBe('≥ 40%');
    expect(selfShareLineText('offReasonDecisions')).toBe('= 0 张');
  });
});

describe('设置里的值认法', () => {
  it('写出去的能原样读回；形状不对照抛', () => {
    const row = tierOf(PASS);
    const stored = JSON.parse(JSON.stringify({ ...row, at: row.at.toISOString() }));
    expect(parseSelfShare(stored)).toEqual(row);
    expect(() => parseSelfShare({ ...stored, tier: 'great' })).toThrow('认不出');
    expect(() => parseSelfShare({ ...stored, at: 'not-a-date' })).toThrow('认不出');
    expect(() => parseSelfShare(null)).toThrow('认不出');
  });
});

describe('ciRedMinutes · failure 完成到下一个 success 完成', () => {
  const from = new Date('2026-10-15T00:00:00Z');
  const to = new Date('2026-10-22T00:00:00Z');
  const run = (conclusion: string, iso: string) => ({ conclusion, endedAt: new Date(iso) });

  it('一段红：失败到下一次成功的分钟数；多段相加', () => {
    expect(
      ciRedMinutes(
        [
          run('failure', '2026-10-16T10:00:00Z'),
          run('success', '2026-10-16T10:40:00Z'),
          run('failure', '2026-10-18T01:00:00Z'),
          run('success', '2026-10-18T01:20:00Z'),
        ],
        from,
        to,
      ),
    ).toBe(60);
  });

  it('连着失败只从第一次算起；取消、跳过不改红绿', () => {
    expect(
      ciRedMinutes(
        [
          run('failure', '2026-10-16T10:00:00Z'),
          run('cancelled', '2026-10-16T10:10:00Z'),
          run('failure', '2026-10-16T10:20:00Z'),
          run('success', '2026-10-16T10:30:00Z'),
        ],
        from,
        to,
      ),
    ).toBe(30);
  });

  it('到窗口末还红着：红到 to；没有失败是 0；顺序乱的也按时间排', () => {
    expect(ciRedMinutes([run('failure', '2026-10-21T22:00:00Z')], from, to)).toBe(120);
    expect(ciRedMinutes([run('success', '2026-10-16T10:00:00Z')], from, to)).toBe(0);
    expect(ciRedMinutes([], from, to)).toBe(0);
    expect(
      ciRedMinutes(
        [run('success', '2026-10-16T10:30:00Z'), run('failure', '2026-10-16T10:00:00Z')],
        from,
        to,
      ),
    ).toBe(30);
  });
});

describe('countMachineDefects · 机器开的缺陷单', () => {
  const from = new Date('2026-10-15T00:00:00Z');
  const to = new Date('2026-10-22T00:00:00Z');
  const issue = (over: Record<string, unknown> = {}) => ({
    number: 1,
    title: '某个缺陷',
    created_at: '2026-10-18T00:00:00Z',
    user: { type: 'Bot' },
    ...over,
  });

  it('只数窗口里开的、机器人开的、不是 PR、不是 e2e 汇总单的', () => {
    expect(
      countMachineDefects(
        [
          issue(),
          issue({ number: 2, user: { type: 'User' } }),
          issue({ number: 3, pull_request: {} }),
          issue({ number: 4, title: 'e2e 偶发：多条用例达阈值（汇总）' }),
          issue({ number: 5, created_at: '2026-10-10T00:00:00Z' }),
          issue({ number: 6, created_at: '2026-10-22T00:00:00Z' }),
          issue({ number: 7, user: null }),
          issue({ number: 8 }),
        ],
        from,
        to,
      ),
    ).toBe(2);
  });

  it('认不出的行照抛，不当成没有', () => {
    expect(() => countMachineDefects([issue({ created_at: 'x' })], from, to)).toThrow('认不出');
    expect(() => countMachineDefects([null], from, to)).toThrow('认不出');
  });
});
