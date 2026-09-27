// 会话用户切号的判法（jobs/org-switch.ts，#157）：平时挂拼车，拼车用满切独享、拼车恢复了切回；手上有 Claude 会话在跑就等。
// 明确失败的每一条都故意造一次：挂的是哪个认不出不切；拼车用满却读不到几点恢复（读数旧了也算）是 stuck，要人看，不当成到点了。
import { describe, expect, it } from 'vitest';
import { type OrgPool, type OrgSwitchFacts, type OrgWindow, planOrgSwitch } from '../src/jobs/org-switch.ts';

const NOW = new Date('2026-09-27T10:00:00.000Z');
const H = 60 * 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const roomy: OrgWindow = { label: 'five_hour', state: 'ok', full: false, resetsAt: at(3 * H) };
/** 被拒记成的读数：到顶、带清零时刻。 */
const full = (resetsAt: Date | null, label = 'five_hour'): OrgWindow => ({
  label,
  state: resetsAt !== null && resetsAt <= NOW ? 'reset' : 'exhausted',
  full: true,
  resetsAt,
});
const pool = (windows: OrgWindow[] = [roomy], held = false): OrgPool => ({ windows, held });

function facts(over: Partial<OrgSwitchFacts> = {}): OrgSwitchFacts {
  return {
    live: { ok: true, org: 'carpool' },
    pools: { carpool: pool(), solo: pool() },
    busy: 0,
    now: NOW,
    ...over,
  };
}

describe('挂着拼车', () => {
  it('拼车额度没用满：不切', () => {
    expect(planOrgSwitch(facts())).toEqual({ action: 'stay', why: '挂着拼车，拼车额度没用满' });
  });

  it('拼车用满了（被拒、带清零时刻）、手上空着：切独享，写明哪个窗口、几点清零', () => {
    const plan = planOrgSwitch(facts({ pools: { carpool: pool([full(at(2 * H))]), solo: pool() } }));
    expect(plan).toEqual({
      action: 'switch',
      to: 'solo',
      why: '拼车额度用满了（five_hour，2026-09-27 12:00（UTC） 清零），切到独享接着干',
    });
  });

  it('拼车用满了、清零时刻不知道（刚被拒、读数还新）：照样切独享，写明不知道几点清零', () => {
    const plan = planOrgSwitch(facts({ pools: { carpool: pool([full(null)]), solo: pool() } }));
    expect(plan).toMatchObject({ action: 'switch', to: 'solo' });
    expect(plan.why).toContain('清零时刻不知道');
  });

  it('手上还有 Claude 会话没结束：等，写明几个', () => {
    const plan = planOrgSwitch(facts({ pools: { carpool: pool([full(at(H))]), solo: pool() }, busy: 2 }));
    expect(plan).toMatchObject({ action: 'wait', to: 'solo' });
    expect(plan.why).toContain('手上还有 2 个 Claude 会话没结束，等跑完再切到独享');
  });

  it('读数旧了、清零时刻不知道（选路算「不知道」照派）：不切，等真被拒了再说', () => {
    const stale: OrgWindow = { label: 'five_hour', state: 'stale', full: true, resetsAt: null };
    expect(planOrgSwitch(facts({ pools: { carpool: pool([stale]), solo: pool() } }))).toMatchObject({
      action: 'stay',
    });
  });

  it('独享也用满了：切过去也派不了，不切', () => {
    const plan = planOrgSwitch(
      facts({ pools: { carpool: pool([full(at(H))]), solo: pool([full(at(2 * H), 'seven_day')]) } }),
    );
    expect(plan).toMatchObject({ action: 'stay' });
    expect(plan.why).toContain('拼车（five_hour）、独享的额度都用满了');
  });

  it('独享池整池暂停着（登录失效、封号，等人处理）：切过去也派不了，不切', () => {
    const plan = planOrgSwitch(facts({ pools: { carpool: pool([full(at(H))]), solo: pool([roomy], true) } }));
    expect(plan).toMatchObject({ action: 'stay' });
    expect(plan.why).toContain('独享池整池暂停着');
  });
});

describe('挂着独享', () => {
  const onSolo = (carpool: OrgPool, over: Partial<OrgSwitchFacts> = {}) =>
    planOrgSwitch(facts({ live: { ok: true, org: 'solo' }, pools: { carpool, solo: pool() }, ...over }));

  it('拼车还没到恢复时刻：不切，写明几点恢复', () => {
    expect(onSolo(pool([full(at(90 * 60_000))]))).toEqual({
      action: 'stay',
      why: '挂着独享；拼车 2026-09-27 11:30（UTC） 才恢复，到点再切回',
    });
  });

  it('几个窗口用满：等最晚清零的那个', () => {
    const plan = onSolo(pool([full(at(H)), full(at(30 * H), 'seven_day')]));
    expect(plan.why).toContain('2026-09-28 16:00（UTC） 才恢复');
  });

  it('拼车恢复时刻过了、手上空着：切回拼车', () => {
    expect(onSolo(pool([full(at(-60_000))]))).toMatchObject({ action: 'switch', to: 'carpool' });
  });

  it('拼车没有用满的读数（人手动切到独享的）：切回拼车（平时挂拼车）', () => {
    const plan = onSolo(pool());
    expect(plan).toMatchObject({ action: 'switch', to: 'carpool' });
    expect(plan.why).toContain('平时挂拼车');
  });

  it('恢复了、手上还有会话：等', () => {
    expect(onSolo(pool([full(at(-60_000))]), { busy: 1 })).toMatchObject({ action: 'wait', to: 'carpool' });
  });

  it('【故意造出的失败】拼车用满了却读不到几点恢复：stuck，要人看，不当成到点了', () => {
    const plan = onSolo(pool([full(null)]));
    expect(plan).toEqual({
      action: 'stuck',
      why: '挂着独享；拼车额度用满了（five_hour），却读不到几点恢复：不知道什么时候切回拼车，要人看',
    });
  });

  it('【故意造出的失败】读数旧了也不算恢复（选路那边算「不知道」，这里当成恢复就会切回去、被拒、再切走）', () => {
    const stale: OrgWindow = { label: 'five_hour', state: 'stale', full: true, resetsAt: null };
    expect(onSolo(pool([stale]))).toMatchObject({ action: 'stuck' });
  });

  it('拼车池整池暂停着：先不切回', () => {
    const plan = onSolo(pool([roomy], true));
    expect(plan).toMatchObject({ action: 'stay' });
    expect(plan.why).toContain('拼车池整池暂停着');
  });
});

describe('【故意造出的失败】判不了的不切', () => {
  it('挂的是哪个认不出：不切，写明原因', () => {
    const plan = planOrgSwitch(
      facts({
        live: { ok: false, why: '没有带 * 的行' },
        pools: { carpool: pool([full(at(H))]), solo: pool() },
      }),
    );
    expect(plan).toEqual({ action: 'stay', why: '会话用户挂的组织认不出（没有带 * 的行），不切' });
  });

  it('库里两个池不全：没得切', () => {
    expect(planOrgSwitch(facts({ pools: { carpool: pool([full(at(H))]) } }))).toEqual({
      action: 'stay',
      why: '库里拼车、独享两个池不全，没得切',
    });
  });
});
