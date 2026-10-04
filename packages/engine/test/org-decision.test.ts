// 会话用户切号的总判法（jobs/org-decision.ts，#194 方案 v2 + 创始人 2026-10-04 约 22:30 的账号状态要求）。
// 每条「不许做」都故意造一次：账号只剩 1 个/0 个/读不到不切；没证据不切；读数旧了不算；人叫停不切；
// 独享用不了不切；读不到恢复不切回；白切、预算不接着来回；宽限里不往独享派新活。
import { describe, expect, it } from 'vitest';
import type { CarpoolApiRead, CarpoolOutage } from '../src/jobs/carpool-outage.ts';
import { type AccountStatus, judgeAccounts, type PoolAccount } from '../src/jobs/org-accounts.ts';
import { decideOrgSwitch, intentOf, type OrgDecisionFacts } from '../src/jobs/org-decision.ts';
import { emptyLedger, type OrgLedger } from '../src/jobs/org-ledger.ts';
import type { OrgPool, OrgWindow } from '../src/jobs/org-switch.ts';

const T0 = new Date('2026-10-04T12:00:00.000Z');
const MIN = 60_000;
const at = (m: number) => new Date(T0.getTime() + m * MIN);

const roomy: OrgWindow = { label: 'five_hour', state: 'ok', full: false, resetsAt: at(180) };
const pool = (windows: OrgWindow[] = [roomy], held = false): OrgPool => ({ windows, held });

const acct = (id: string, kind: 'carpool' | 'solo', status: AccountStatus = 'available'): PoolAccount => ({
  id,
  kind,
  status,
  why: `${id} ${status}`,
});
const verdict = (accounts: PoolAccount[], readOk = true) =>
  judgeAccounts({ accounts, readOk, readWhy: readOk ? '' : '接口 503' });
const both = verdict([acct('c', 'carpool'), acct('s', 'solo')]);

function facts(over: Partial<OrgDecisionFacts> = {}): OrgDecisionFacts {
  return {
    live: { ok: true, org: 'carpool' },
    pools: { carpool: pool(), solo: pool() },
    busy: 0,
    now: T0,
    accounts: both,
    ledger: emptyLedger(),
    ...over,
  };
}

const ok = (m: number, used: number, resetsInMin: number | null = null): CarpoolApiRead => ({
  ok: true,
  requestedAt: at(m),
  serverDate: at(m),
  ageSeconds: null,
  quota: {
    usedUsd: used,
    limitUsd: 80,
    resetsAt: resetsInMin === null ? null : at(resetsInMin),
    status: 'active',
  },
  org: 'ok',
});

const e1 = (since = at(-5), resetsAt: Date | null = at(60)): CarpoolOutage => ({
  kind: 'E1',
  since,
  resetsAt,
  resetsFrom: resetsAt ? 'api' : null,
  evidence: '被拒原文是拼车本人额度那句',
});

const led = (over: Partial<OrgLedger> = {}): OrgLedger => ({ ...emptyLedger(), ...over });
const onSolo = (over: Partial<OrgLedger> = {}) =>
  led({ outage: e1(at(-100), at(-30)), onSoloSince: at(-90), ...over });

describe('挂着拼车：什么时候切独享', () => {
  it('没有拼车用不了的证据：不切', () => {
    const d = decideOrgSwitch(facts());
    expect(d.plan).toEqual({ action: 'stay', why: '挂着拼车，没有拼车用不了的证据' });
  });

  it('被拒当场（会话交来的证据）：切独享，写明哪一种、凭什么、几点恢复；账本记下恢复条件', () => {
    const rejection = e1(T0, at(200));
    const d = decideOrgSwitch(facts({ rejection }));
    expect(d.plan).toMatchObject({ action: 'switch', to: 'solo' });
    const why = (d.plan as { why: string }).why;
    expect(why).toContain('拼车本人 5 小时额度用满');
    expect(why).toContain('被拒原文是拼车本人额度那句');
    expect(why).toContain('2026-10-04 15:20');
    expect(d.ledger.outage).toEqual(rejection);
  });

  it('接口说本人额度到顶（新读数）：不用等被拒就切', () => {
    const d = decideOrgSwitch(facts({ ledger: led({ reads: [ok(-2, 80, 150)] }) }));
    expect(d.plan).toMatchObject({ action: 'switch', to: 'solo' });
    expect(d.ledger.outage?.kind).toBe('E1');
    expect(d.ledger.outage?.resetsFrom).toBe('api');
  });

  it('【故意造出失败】接口说到顶，但读数是 20 分钟前的（超过 15 分钟不算现在的）：不据此切', () => {
    const d = decideOrgSwitch(facts({ ledger: led({ reads: [ok(-20, 80, 150)] }) }));
    expect(d.plan.action).toBe('stay');
  });

  it('【故意造出失败】到顶的读数是上一次切回拼车之前读的：不拿旧账切', () => {
    const d = decideOrgSwitch(
      facts({ ledger: led({ reads: [ok(-10, 80, 150)], lastBack: { at: at(-5), trial: false } }) }),
    );
    expect(d.plan.action).toBe('stay');
  });

  it('老证据：库里拼车额度窗口用满（被拒那一帧记的）：切独享', () => {
    const full: OrgWindow = { label: 'carpool_5h_usd', state: 'exhausted', full: true, resetsAt: at(90) };
    const d = decideOrgSwitch(facts({ pools: { carpool: pool([full]), solo: pool() } }));
    expect(d.plan).toMatchObject({ action: 'switch', to: 'solo' });
    expect(d.ledger.outage?.resetsAt).toEqual(at(90));
  });

  it('手上有 Claude 会话：能停就切，写明先停；停不下就等', () => {
    const rejection = e1(T0);
    expect(decideOrgSwitch(facts({ rejection, busy: 3, canStopRunning: true })).plan).toMatchObject({
      action: 'switch',
      to: 'solo',
    });
    expect(decideOrgSwitch(facts({ rejection, busy: 3 })).plan).toMatchObject({ action: 'wait', to: 'solo' });
  });

  it('【故意造出失败】人点了「引擎暂不用独享」：拼车用不了也不切，写明谁点的；记着的恢复条件还留着', () => {
    const d = decideOrgSwitch(
      facts({
        rejection: e1(T0),
        ledger: led({ soloPause: { since: at(-30), by: '创始人', reason: '我自己要用独享' } }),
      }),
    );
    expect(d.plan.action).toBe('stay');
    expect((d.plan as { why: string }).why).toContain('引擎暂不用独享');
    expect((d.plan as { why: string }).why).toContain('创始人');
    expect(d.ledger.outage).not.toBeNull();
  });

  it('【故意造出失败】独享池整池暂停 / 独享额度也用满：不切', () => {
    expect(
      decideOrgSwitch(facts({ rejection: e1(T0), pools: { carpool: pool(), solo: pool([roomy], true) } }))
        .plan.action,
    ).toBe('stay');
    const soloFull: OrgWindow = { label: 'five_hour', state: 'exhausted', full: true, resetsAt: at(60) };
    expect(
      decideOrgSwitch(facts({ rejection: e1(T0), pools: { carpool: pool(), solo: pool([soloFull]) } })).plan
        .action,
    ).toBe('stay');
  });

  it('【故意造出失败】帮手刚失败（退避中）：不切；退避过了才试', () => {
    const rejection = e1(T0);
    const soon = decideOrgSwitch(facts({ rejection, ledger: led({ helperFailures: [at(-1)] }) }));
    expect(soon.plan.action).toBe('stay');
    expect((soon.plan as { why: string }).why).toContain('退避');
    const later = decideOrgSwitch(facts({ rejection, ledger: led({ helperFailures: [at(-3)] }) }));
    expect(later.plan.action).toBe('switch');
  });

  it('切回拼车 5 分钟后又被拒：记一次白切', () => {
    const d = decideOrgSwitch(
      facts({ rejection: e1(T0), ledger: led({ lastBack: { at: at(-5), trial: false } }) }),
    );
    expect(d.ledger.whites.count).toBe(1);
  });

  it('记着的用不了（没切成），之后连着两次新读数说恢复了：撤掉，不切', () => {
    const d = decideOrgSwitch(
      facts({
        ledger: led({ outage: e1(at(-30), at(-10)), reads: [ok(-5, 10, 100), ok(-3, 10, 100)] }),
      }),
    );
    expect(d.plan.action).toBe('stay');
    expect(d.ledger.outage).toBeNull();
    expect(d.notes.join('')).toContain('已经恢复');
  });

  it('【故意造出失败】挂的是哪个认不出 / 定不下来：不切', () => {
    expect(
      decideOrgSwitch(facts({ live: { ok: false, why: '读不到' }, rejection: e1(T0) })).plan,
    ).toMatchObject({
      action: 'stay',
    });
    const pending = decideOrgSwitch(
      facts({ live: { ok: false, why: '刚变', pending: true }, rejection: e1(T0) }),
    );
    expect((pending.plan as { why: string }).why).toContain('定不下来');
  });

  it('【故意造出失败】库里两个池不全：没得切', () => {
    const d = decideOrgSwitch(facts({ pools: { carpool: pool() }, rejection: e1(T0) }));
    expect(d.plan).toMatchObject({ action: 'stay', why: '库里拼车、独享两个池不全，没得切' });
  });
});

describe('切之前逐个查账号状态（创始人 2026-10-04 约 22:30）', () => {
  const rejection = e1(T0, at(200));

  it('可用 ≥ 2：照常切', () => {
    expect(decideOrgSwitch(facts({ rejection })).plan.action).toBe('switch');
  });

  it('【故意造出失败】独享被封、只剩拼车 1 个可用：不切，写明没得切；恢复条件留着', () => {
    const d = decideOrgSwitch(
      facts({ rejection, accounts: verdict([acct('c', 'carpool'), acct('s', 'solo', 'banned')]) }),
    );
    expect(d.plan.action).toBe('stay');
    expect((d.plan as { why: string }).why).toContain('只剩 1 个可用账号');
    expect(d.channel.state).toBe('single');
    expect(d.ledger.outage).not.toBeNull();
  });

  it('【故意造出失败】拼车被封、唯一可用的独享在另一边、当前挂着拼车：不自动切，推要人看', () => {
    const d = decideOrgSwitch(
      facts({ rejection, accounts: verdict([acct('c', 'carpool', 'banned'), acct('s', 'solo')]) }),
    );
    expect(d.plan.action).toBe('stay');
    expect(d.channel.alert?.title).toContain('只剩 1 个可用账号');
  });

  it('可用 1 个、而且就是现在挂着的那个：不切，不推提醒（没有异常，只是没得选）', () => {
    const d = decideOrgSwitch(
      facts({ rejection, accounts: verdict([acct('c', 'carpool'), acct('s', 'solo', 'banned')]) }),
    );
    expect(d.channel.state).toBe('single');
    expect(d.channel.alert).toBeNull();
  });

  it('【故意造出失败】全被封（可用 0 个）：渠道不可用，不切，推提醒，状态写进账本', () => {
    const d = decideOrgSwitch(
      facts({
        rejection,
        accounts: verdict([acct('c', 'carpool', 'banned'), acct('s', 'solo', 'banned')]),
      }),
    );
    expect(d.plan.action).toBe('stay');
    expect(d.channel.state).toBe('unavailable');
    expect(d.channel.alert?.title).toContain('渠道不可用');
    expect(d.channel.changed).toBe(true);
    expect(d.ledger.channel).toMatchObject({ state: 'unavailable', since: T0 });
    expect(intentOf(d, 'carpool').channelDown).toContain('没有一个可用账号');
  });

  it('渠道不可用持续时，起点沿用（不每轮重置）；恢复后状态变回 ok、不再提醒', () => {
    const down = decideOrgSwitch(
      facts({ accounts: verdict([acct('c', 'carpool', 'banned'), acct('s', 'solo', 'banned')]) }),
    );
    const later = decideOrgSwitch(
      facts({
        now: at(40),
        accounts: verdict([acct('c', 'carpool', 'banned'), acct('s', 'solo', 'banned')]),
        ledger: down.ledger,
      }),
    );
    expect(later.channel.since).toEqual(T0);
    expect(later.channel.changed).toBe(false);
    const back = decideOrgSwitch(facts({ now: at(60), ledger: later.ledger }));
    expect(back.channel.state).toBe('ok');
    expect(back.channel.changed).toBe(true);
    expect(back.channel.alert).toBeNull();
  });

  it('【故意造出失败】读不到账号状态：不切；刚读不到不报警，读不到满 15 分钟才报', () => {
    const unreadable = verdict([], false);
    const first = decideOrgSwitch(facts({ rejection, accounts: unreadable }));
    expect(first.plan.action).toBe('stay');
    expect(first.channel.state).toBe('unknown');
    expect(first.channel.alert).toBeNull();
    const later = decideOrgSwitch(
      facts({ rejection, now: at(16), accounts: unreadable, ledger: first.ledger }),
    );
    expect(later.plan.action).toBe('stay');
    expect(later.channel.alert?.title).toContain('读不到 Claude 账号的状态');
  });

  it('【故意造出失败】切去的独享账号读不到状态（拼车有 2 个可用）：不切', () => {
    const d = decideOrgSwitch(
      facts({
        rejection,
        accounts: verdict([acct('c1', 'carpool'), acct('c2', 'carpool'), acct('s', 'solo', 'unknown')]),
      }),
    );
    expect(d.plan.action).toBe('stay');
    expect((d.plan as { why: string }).why).toContain('独享那边没有明确可用的账号');
  });

  it('账号数不固定：两个拼车 + 两个独享，其中一个独享被封，还剩 3 个可用：照常切', () => {
    const d = decideOrgSwitch(
      facts({
        rejection,
        accounts: verdict([
          acct('c1', 'carpool'),
          acct('c2', 'carpool'),
          acct('s1', 'solo'),
          acct('s2', 'solo', 'banned'),
        ]),
      }),
    );
    expect(d.plan.action).toBe('switch');
  });

  it('挂着独享时切回也过账号关：拼车那边账号没分到（被封）→ 不切回', () => {
    const d = decideOrgSwitch(
      facts({
        live: { ok: true, org: 'solo' },
        accounts: verdict([acct('c1', 'carpool', 'banned'), acct('c2', 'carpool'), acct('s', 'solo')]),
        ledger: onSolo({ reads: [ok(-3, 5, 100), ok(-1, 5, 100)] }),
      }),
    );
    expect(d.plan.action).toBe('switch'); // c2 可用，拼车那边有明确可用的
    const none = decideOrgSwitch(
      facts({
        live: { ok: true, org: 'solo' },
        accounts: verdict([acct('c1', 'carpool', 'banned'), acct('s1', 'solo'), acct('s2', 'solo')]),
        ledger: onSolo({ reads: [ok(-3, 5, 100), ok(-1, 5, 100)] }),
      }),
    );
    expect(none.plan.action).toBe('stay');
    expect((none.plan as { why: string }).why).toContain('拼车那边没有明确可用的账号');
  });
});

describe('挂着独享：什么时候切回、怎么切回', () => {
  const live = { ok: true, org: 'solo' } as const;

  it('还没有恢复的新读数：不切回，写明几点恢复，记下「到点再看」', () => {
    const d = decideOrgSwitch(
      facts({
        live,
        ledger: led({ outage: e1(at(-50), at(60)), onSoloSince: at(-45), reads: [ok(-1, 80, 60)] }),
        now: T0,
      }),
    );
    expect(d.plan.action).toBe('stay');
    expect(d.plan).toMatchObject({ later: { to: 'carpool', at: at(60) } });
  });

  it('连着两次被拒之后的新读数都说剩余 ≥ 50%：切回（确认过的），手上空着就切；账本记着恢复时刻随读数更新', () => {
    const d = decideOrgSwitch(facts({ live, ledger: onSolo({ reads: [ok(-3, 5, 100), ok(-1, 5, 100)] }) }));
    expect(d.plan).toMatchObject({ action: 'switch', to: 'carpool', mode: 'confirmed' });
  });

  it('【故意造出失败】只有一次新读数过线：不切回，等隔一分钟的第二次', () => {
    const d = decideOrgSwitch(facts({ live, ledger: onSolo({ reads: [ok(-1, 5, 100)] }) }));
    expect(d.plan.action).toBe('stay');
  });

  it('【故意造出失败】旧读数（被拒之前的）说剩余很多：不算恢复', () => {
    const d = decideOrgSwitch(
      facts({
        live,
        ledger: onSolo({ outage: e1(at(-20), at(30)), reads: [ok(-60, 5, 100), ok(-50, 5, 100)] }),
      }),
    );
    expect(d.plan.action).toBe('stay');
  });

  it('【故意造出失败】接口读不到、恢复时刻过了不到 15 分钟：不试探；过了 15 分钟才试探切回', () => {
    const fail = (m: number): CarpoolApiRead => ({ ok: false, requestedAt: at(m), code: 'http', why: '503' });
    const outage = e1(at(-100), at(-10));
    const early = decideOrgSwitch(
      facts({ live, ledger: led({ outage, onSoloSince: at(-90), reads: [fail(-2)] }) }),
    );
    expect(early.plan.action).toBe('stay');
    const late = decideOrgSwitch(
      facts({ live, now: at(10), ledger: led({ outage, onSoloSince: at(-90), reads: [fail(5), fail(8)] }) }),
    );
    expect(late.plan).toMatchObject({ action: 'switch', to: 'carpool', mode: 'trial' });
  });

  it('手上有会话：先进宽限（新活不往独享派、开跑不到 5 分钟的当场停），记账本；宽限里继续等；到点还有的才停了切', () => {
    const base = onSolo({ reads: [ok(-3, 5, 100), ok(-1, 5, 100)] });
    const first = decideOrgSwitch(facts({ live, busy: 4, canStopRunning: true, ledger: base }));
    expect(first.plan).toMatchObject({ action: 'drain', to: 'carpool', stopYoungerThanMs: 5 * MIN });
    expect(first.ledger.backPending?.since).toEqual(T0);
    expect(intentOf(first, 'solo')).toMatchObject({ to: 'carpool', drain: 'solo' });

    const mid = decideOrgSwitch(
      facts({ live, busy: 2, canStopRunning: true, now: at(4), ledger: { ...base, ...first.ledger } }),
    );
    expect(mid.plan).toMatchObject({ action: 'drain', stopYoungerThanMs: null });
    expect((mid.plan as { until: Date }).until).toEqual(at(10));

    const done = decideOrgSwitch(
      facts({ live, busy: 1, canStopRunning: true, now: at(10), ledger: { ...base, ...first.ledger } }),
    );
    expect(done.plan).toMatchObject({ action: 'switch', to: 'carpool', mode: 'confirmed' });

    const empty = decideOrgSwitch(
      facts({ live, busy: 0, canStopRunning: true, now: at(3), ledger: { ...base, ...first.ledger } }),
    );
    expect(empty.plan).toMatchObject({ action: 'switch', to: 'carpool' });
  });

  it('手上有停不下的会话：等，不进宽限', () => {
    const d = decideOrgSwitch(
      facts({ live, busy: 2, ledger: onSolo({ reads: [ok(-3, 5, 100), ok(-1, 5, 100)] }) }),
    );
    expect(d.plan).toMatchObject({ action: 'wait', to: 'carpool' });
  });

  it('宽限中防抖或证据变了（读数又说到顶）：撤掉宽限，不切', () => {
    const base = onSolo({
      reads: [ok(-3, 5, 100), ok(-1, 5, 100), ok(0, 80, 180)],
      backPending: { since: at(-2), mode: 'confirmed', why: 'x' },
    });
    const d = decideOrgSwitch(facts({ live, busy: 2, canStopRunning: true, ledger: base }));
    expect(d.plan.action).toBe('stay');
    expect(d.ledger.backPending).toBeNull();
  });

  it('【故意造出失败】连着 3 次白切：不再自己切回，要人看；5 小时里切回满 3 次：预算用完，要人看', () => {
    const recovered = [ok(-3, 5, 100), ok(-1, 5, 100)];
    const whites = decideOrgSwitch(
      facts({
        live,
        ledger: onSolo({ reads: recovered, whites: { count: 3, lastAt: at(-200), lastTrial: false } }),
      }),
    );
    expect(whites.plan.action).toBe('stuck');
    const budget = decideOrgSwitch(
      facts({
        live,
        ledger: onSolo({
          reads: recovered,
          backs: [
            { at: at(-200), trial: false },
            { at: at(-150), trial: false },
            { at: at(-100), trial: false },
          ],
        }),
      }),
    );
    expect(budget.plan.action).toBe('stuck');
  });

  it('【故意造出失败】白切退避中：恢复了也先不切回', () => {
    const d = decideOrgSwitch(
      facts({
        live,
        ledger: onSolo({
          reads: [ok(-3, 5, 100), ok(-1, 5, 100)],
          whites: { count: 1, lastAt: at(-5), lastTrial: false },
        }),
      }),
    );
    expect(d.plan.action).toBe('stay');
  });

  it('【故意造出失败】拼车池整池暂停：该切回也不切', () => {
    const d = decideOrgSwitch(
      facts({
        live,
        pools: { carpool: pool([roomy], true), solo: pool() },
        ledger: onSolo({ reads: [ok(-3, 5, 100), ok(-1, 5, 100)] }),
      }),
    );
    expect(d.plan.action).toBe('stay');
  });

  it('过了预计恢复时刻 30 分钟还挂在独享：另给一句「待太久」', () => {
    const d = decideOrgSwitch(
      facts({
        live,
        now: at(0),
        ledger: led({ outage: e1(at(-200), at(-40)), onSoloSince: at(-190), reads: [ok(-1, 70, 100)] }),
      }),
    );
    expect(d.overdue).toContain('还挂在独享上');
  });

  it('没有恢复条件（人手动切到独享的）：照老判法，拼车没有用满的读数就切回；账号关照过', () => {
    const d = decideOrgSwitch(facts({ live }));
    expect(d.plan).toMatchObject({ action: 'switch', to: 'carpool', mode: 'confirmed' });
    const single = decideOrgSwitch(
      facts({ live, accounts: verdict([acct('c', 'carpool'), acct('s', 'solo', 'banned')]) }),
    );
    expect(single.plan.action).toBe('stay');
  });

  it('没有恢复条件、拼车用满却读不到几点恢复：stuck，要人看（老规矩保留）', () => {
    const full: OrgWindow = { label: 'five_hour', state: 'exhausted', full: true, resetsAt: null };
    const d = decideOrgSwitch(facts({ live, pools: { carpool: pool([full]), solo: pool() } }));
    expect(d.plan.action).toBe('stuck');
  });
});

describe('intentOf：选路按它判「等切号」', () => {
  it('切、等：就切；带 later 的 stay：到点再切；不切：to 为空', () => {
    const sw = decideOrgSwitch(facts({ rejection: e1(T0) }));
    expect(intentOf(sw, 'carpool')).toMatchObject({ to: 'solo', at: null, drain: null, channelDown: null });
    const waitFor = decideOrgSwitch(
      facts({
        live: { ok: true, org: 'solo' },
        ledger: led({ outage: e1(at(-50), at(60)), onSoloSince: at(-45), reads: [ok(-1, 80, 60)] }),
      }),
    );
    expect(intentOf(waitFor, 'solo')).toMatchObject({ to: 'carpool', at: at(60) });
    const none = decideOrgSwitch(facts());
    expect(intentOf(none, 'carpool')).toMatchObject({ to: null });
  });
});
