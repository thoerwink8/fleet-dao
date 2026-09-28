// 单子进门自动打标挂版本（#448）的纯判断：类别（Jev + 标签时间线）、版本（创始人 vs AI）、版本交接、闲置清理。
import { describe, expect, it } from 'vitest';
import {
  categoryPlan,
  categoryRemovedByHuman,
  DEFAULT_IDLE_POLICY,
  daysBetween,
  handoffComment,
  handoffPlan,
  idlePlan,
  type LabelEvent,
  milestonePlan,
  staleSinceOf,
} from '../src/issue-groom.ts';
import { FROZEN_LABEL, MOTHER_LABEL } from '../src/labels.ts';

const IDLE = '过时';
/** 标签事件的简写：at 大多数用例不关心，给个占位时刻。 */
const le = (over: Partial<LabelEvent> & Pick<LabelEvent, 'label' | 'action' | 'bot'>): LabelEvent => ({
  at: '2026-09-01T00:00:00Z',
  ...over,
});

describe('类别：只贴不摘', () => {
  it('Jev 判出来、把握够：贴', () => {
    expect(categoryPlan({ judged: true, kind: '缺陷', confidence: 0.95 }, false)).toEqual({
      action: 'apply',
      label: '缺陷',
    });
  });

  it('Jev 连不上（没问成）：不贴、记没查成', () => {
    const got = categoryPlan({ judged: false, reason: 'unreachable', detail: '判断题起不来' }, false);
    expect(got).toMatchObject({ action: 'skip', report: 'unchecked' });
  });

  it('把握不够：不贴、进日报（不是没查成）', () => {
    const got = categoryPlan(
      { judged: false, reason: 'low_confidence', detail: '答「杂项」，把握度 0.4' },
      false,
    );
    expect(got).toMatchObject({ action: 'skip', report: 'digest' });
  });

  it('人摘掉过 Jev 贴的类别：就算这次 Jev 判得又准又有把握，也不再贴，什么都不报', () => {
    const got = categoryPlan({ judged: true, kind: '需求', confidence: 0.99 }, true);
    expect(got).toEqual({ action: 'skip', report: 'none', note: expect.any(String) });
  });

  describe('categoryRemovedByHuman：看标签时间线最后一条摘除事件是谁做的', () => {
    it('从没贴过类别标签：没有', () => {
      expect(categoryRemovedByHuman([])).toBe(false);
    });

    it('机器人贴上、还没被摘：没有', () => {
      const events: LabelEvent[] = [le({ label: '需求', action: 'labeled', bot: true })];
      expect(categoryRemovedByHuman(events)).toBe(false);
    });

    it('机器人贴上、人摘掉：算被人改过', () => {
      const events: LabelEvent[] = [
        le({ label: '需求', action: 'labeled', bot: true }),
        le({ label: '需求', action: 'unlabeled', bot: false }),
      ];
      expect(categoryRemovedByHuman(events)).toBe(true);
    });

    it('人贴上、又是人自己摘掉、机器人重新贴上：以最后一条为准，不算被人改过', () => {
      const events: LabelEvent[] = [
        le({ label: '缺陷', action: 'labeled', bot: false }),
        le({ label: '缺陷', action: 'unlabeled', bot: false }),
        le({ label: '缺陷', action: 'labeled', bot: true }),
      ];
      expect(categoryRemovedByHuman(events)).toBe(false);
    });

    it('不相干的标签（本机做）的事件不算数', () => {
      const events: LabelEvent[] = [le({ label: '本机做', action: 'unlabeled', bot: false })];
      expect(categoryRemovedByHuman(events)).toBe(false);
    });
  });
});

describe('staleSinceOf：「过时」最近一次是什么时候贴上的', () => {
  it('从没贴过：null', () => {
    expect(staleSinceOf([])).toBeNull();
  });

  it('贴过：取那一条的时刻', () => {
    const events = [le({ label: IDLE, action: 'labeled', bot: true, at: '2026-09-10T08:00:00Z' })];
    expect(staleSinceOf(events)).toEqual(new Date('2026-09-10T08:00:00Z'));
  });

  it('贴了又贴（比如重新触发）：取最后一条', () => {
    const events = [
      le({ label: IDLE, action: 'labeled', bot: true, at: '2026-08-01T00:00:00Z' }),
      le({ label: IDLE, action: 'unlabeled', bot: false, at: '2026-08-05T00:00:00Z' }),
      le({ label: IDLE, action: 'labeled', bot: true, at: '2026-09-10T08:00:00Z' }),
    ];
    expect(staleSinceOf(events)).toEqual(new Date('2026-09-10T08:00:00Z'));
  });

  it('最后一条是摘掉的（不该发生，防御）：查不出，null', () => {
    const events = [
      le({ label: IDLE, action: 'labeled', bot: true, at: '2026-09-01T00:00:00Z' }),
      le({ label: IDLE, action: 'unlabeled', bot: false, at: '2026-09-05T00:00:00Z' }),
    ];
    expect(staleSinceOf(events)).toBeNull();
  });

  it('时刻解析不出来：查不出，null', () => {
    const events = [le({ label: IDLE, action: 'labeled', bot: true, at: '不是时间' })];
    expect(staleSinceOf(events)).toBeNull();
  });

  it('不相干的标签不算数', () => {
    const events = [le({ label: '需求', action: 'labeled', bot: true, at: '2026-09-10T08:00:00Z' })];
    expect(staleSinceOf(events)).toBeNull();
  });
});

describe('handoffComment：版本交接留的言', () => {
  it('写清从哪个版本挪到哪个版本', () => {
    const text = handoffComment({ title: 'v1 Fusion 接活' }, { title: 'v2 下一步' });
    expect(text).toContain('v1 Fusion 接活');
    expect(text).toContain('v2 下一步');
  });
});

describe('版本：创始人开的进当前版本，AI 发现的进未排期', () => {
  const milestones = [
    { number: 5, title: 'v2 下一步' },
    { number: 3, title: 'v1 Fusion 接活' },
  ];

  it('机器人开的（引擎对账、提醒）：未排期，不挂', () => {
    expect(milestonePlan('bot', milestones)).toEqual({ action: 'unscheduled' });
  });

  it('人开的：挂当前版本（N 最小的那个）', () => {
    expect(milestonePlan('human', milestones)).toEqual({
      action: 'assign',
      milestone: { number: 3, title: 'v1 Fusion 接活' },
    });
  });

  it('当前版本读不到（没有还开着的 v<N> 里程碑）：不挂、报没查成', () => {
    const got = milestonePlan('human', [{ number: 9, title: '杂项收尾' }]);
    expect(got).toMatchObject({ action: 'unknown' });
    expect((got as { why: string }).why).toContain('没有当前版本');
  });

  it('一个里程碑都没有：一样是没查成，不是「没有当前版本就当未排期」', () => {
    expect(milestonePlan('human', [])).toMatchObject({ action: 'unknown' });
  });
});

describe('版本交接：里程碑关了，没做完的单挪到下一个版本', () => {
  it('还开着一个 v<N>：挪到它', () => {
    expect(handoffPlan([{ number: 5, title: 'v2 下一步' }])).toEqual({
      action: 'move',
      to: { number: 5, title: 'v2 下一步' },
    });
  });

  it('没有下一个版本：不挪、报出来', () => {
    const got = handoffPlan([]);
    expect(got).toMatchObject({ action: 'stuck' });
    expect((got as { why: string }).why).toContain('没有下一个版本');
  });
});

describe('闲置清理（照 Kubernetes）', () => {
  const NOW = new Date('2026-09-28T00:00:00Z');
  const facts = (over: Partial<Parameters<typeof idlePlan>[0]> = {}) => ({
    labels: [] as string[],
    idleDays: 0,
    staleSince: null as Date | null,
    ...over,
  });

  it('闲置不到 30 天：不动', () => {
    expect(idlePlan(facts({ idleDays: 29 }), NOW)).toEqual({ action: 'none' });
  });

  it('闲置满 30 天、还没贴过时：贴「过时」', () => {
    expect(idlePlan(facts({ idleDays: 30 }), NOW)).toEqual({ action: 'mark_stale' });
  });

  it('贴了过时不到 14 天：不关', () => {
    const staleSince = new Date(NOW.getTime() - 13 * 86_400_000);
    expect(idlePlan(facts({ labels: [IDLE], staleSince }), NOW)).toEqual({ action: 'none' });
  });

  it('贴了过时满 14 天：关成不做了', () => {
    const staleSince = new Date(NOW.getTime() - 14 * 86_400_000);
    expect(idlePlan(facts({ labels: [IDLE], staleSince }), NOW)).toEqual({ action: 'close' });
  });

  it('闲置到期但贴了「冻结」：不关（也不贴过时）', () => {
    const staleSince = new Date(NOW.getTime() - 90 * 86_400_000);
    expect(idlePlan(facts({ labels: [FROZEN_LABEL, IDLE], idleDays: 999, staleSince }), NOW)).toEqual({
      action: 'skip_frozen',
    });
  });

  it('母单：闲置到期也不动', () => {
    expect(idlePlan(facts({ labels: [MOTHER_LABEL], idleDays: 999 }), NOW)).toEqual({
      action: 'skip_mother',
    });
  });

  it('贴了过时、但查不出是什么时候贴的：不硬关，等下次查得到再说', () => {
    expect(idlePlan(facts({ labels: [IDLE], staleSince: null }), NOW)).toEqual({ action: 'none' });
  });

  it('默认天数是 30、14', () => {
    expect(DEFAULT_IDLE_POLICY).toEqual({ staleAfterDays: 30, closeAfterDays: 14 });
  });
});

describe('daysBetween', () => {
  it('整天数、向下取整', () => {
    const from = new Date('2026-09-01T12:00:00Z');
    const now = new Date('2026-09-05T11:00:00Z');
    expect(daysBetween(from, now)).toBe(3);
  });

  it('now 早于 from：算 0 天，不给负数', () => {
    expect(daysBetween(new Date('2026-09-05T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))).toBe(0);
  });
});
