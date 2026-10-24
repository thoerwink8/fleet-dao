import { describe, expect, it } from 'vitest';
import { nextAnchor, parseOrgList, plan } from '../hooks/carpool-clock.mjs';

// 北京时间 → 毫秒。2026-10-26 是周一。
const t = (s: string) => Date.parse(`${s}+08:00`);
const H = 3600_000;
const none = { windowEnd: null, windowSource: 'api', lastProbeAt: null } as const;

describe('nextAnchor', () => {
  it('工作日 05:30，周末跳到周一', () => {
    expect(nextAnchor(t('2026-10-26T04:00:00'))).toBe(t('2026-10-26T05:30:00'));
    expect(nextAnchor(t('2026-10-26T05:30:00'))).toBe(t('2026-10-27T05:30:00'));
    expect(nextAnchor(t('2026-10-30T21:00:00'))).toBe(t('2026-11-02T05:30:00'));
  });
});

describe('plan', () => {
  it('工作日 05:30 锚点：打一枪，打完挂独享到 08:30', () => {
    const p = plan(t('2026-10-27T05:31:00'), { ...none, lastProbeAt: t('2026-10-26T20:30:00') });
    expect(p).toMatchObject({ probe: true, org: 'solo' });
  });
  it('锚点已经打过就不再打；08:30 切回拼车', () => {
    const s = {
      windowEnd: t('2026-10-27T10:30:00'),
      windowSource: 'api',
      lastProbeAt: t('2026-10-27T05:30:00'),
    } as const;
    expect(plan(t('2026-10-27T07:00:00'), s)).toMatchObject({ probe: false, org: 'solo' });
    expect(plan(t('2026-10-27T08:31:00'), s)).toMatchObject({ probe: false, org: 'carpool' });
  });
  it('白天清零后 2 分钟打下一枪', () => {
    const s = {
      windowEnd: t('2026-10-27T10:30:00'),
      windowSource: 'api',
      lastProbeAt: t('2026-10-27T05:30:00'),
    } as const;
    expect(plan(t('2026-10-27T10:31:00'), s).probe).toBe(false);
    expect(plan(t('2026-10-27T10:32:00'), s)).toMatchObject({ probe: true, org: 'carpool' });
  });
  it('工作日凌晨空档：不打，窗口快结束时切独享', () => {
    const s = {
      windowEnd: t('2026-10-28T01:40:00'),
      windowSource: 'api',
      lastProbeAt: t('2026-10-27T20:40:00'),
    } as const;
    expect(plan(t('2026-10-28T01:00:00'), s)).toMatchObject({ probe: false, org: 'carpool' });
    expect(plan(t('2026-10-28T01:36:00'), s)).toMatchObject({ probe: false, org: 'solo' });
    expect(plan(t('2026-10-28T03:00:00'), { ...none, lastProbeAt: s.lastProbeAt })).toMatchObject({
      probe: false,
      org: 'solo',
    });
  });
  it('周末一清零就打、全程拼车', () => {
    const s = { windowEnd: null, windowSource: 'api', lastProbeAt: t('2026-10-31T01:00:00') } as const;
    expect(plan(t('2026-10-31T03:00:00'), s)).toMatchObject({ probe: true, org: 'carpool' });
  });
  it('周日夜里会盖住周一 05:30 的不打', () => {
    expect(plan(t('2026-11-02T01:00:00'), none)).toMatchObject({ probe: false, org: 'solo' });
    expect(plan(t('2026-11-01T23:00:00'), none)).toMatchObject({ probe: true, org: 'carpool' });
  });
  it('刚打过 10 分钟内不再打', () => {
    expect(plan(t('2026-10-31T03:05:00'), { ...none, lastProbeAt: t('2026-10-31T03:00:00') }).probe).toBe(
      false,
    );
  });
  it('读不到清零时刻：按上一枪 + 5 小时', () => {
    const s = { windowEnd: null, windowSource: 'unknown', lastProbeAt: t('2026-10-27T10:00:00') } as const;
    expect(plan(t('2026-10-27T14:00:00'), s).probe).toBe(false);
    expect(plan(t('2026-10-27T15:03:00'), s).probe).toBe(true);
    expect(5 * H).toBe(18_000_000);
  });
});

describe('parseOrgList', () => {
  it('认带 * 的当前组织和 team / personal，跳过杂行', () => {
    const out = 'Syncing config…\n* 324\t拼车组织 #324\tteam\ta@b.c\n  12\t个人\tpersonal\ta@b.c\n';
    expect(parseOrgList(out)).toEqual([
      { id: '324', kind: 'carpool', current: true },
      { id: '12', kind: 'solo', current: false },
    ]);
  });
});
