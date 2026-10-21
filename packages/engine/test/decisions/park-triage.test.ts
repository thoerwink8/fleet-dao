// 指挥官裁决的白名单和默认动作（#3294 第 2 片、#3423）：每类停法的放行、拒绝、默认动作；运行环境类按失败码认；
// 留给人只认三种理由类别；白名单外的裁决不放行；额度超预算按空转判，不按钱；老历史的停法从提醒正文认。
import { describe, expect, it } from 'vitest';
import {
  allowedActions,
  COMMANDER_ACTIONS,
  type CommanderAction,
  checkAcceptanceVerdict,
  checkVerdict,
  defaultAction,
  LEAVE_REASONS,
  legacyParkKind,
  type ParkFacts,
  RUNTIME_RULES,
  type TriageKind,
  triageKindOf,
} from '../../src/decisions/park-triage.ts';
import { judgeSpin, type SpinRound } from '../../src/decisions/spin.ts';
import { PARK_CODE_NO_ROUTE, PARK_CODE_ROUTE_SWITCH } from '../../src/task-contract.ts';

const park = (kind: TriageKind, handoff = false, legacy = false): ParkFacts => ({
  kind,
  handoff,
  ...(legacy ? { legacy: true } : {}),
});
const round = (over: Partial<SpinRound> = {}): SpinRound => ({
  outcome: 'ci_red',
  head: null,
  addedLines: 10,
  reworkSummary: null,
  ...over,
});

/** 有进展：每回合有新提交、失败原因在变。 */
const PROGRESSING = judgeSpin([
  round({ outcome: 'verify_rejected', head: 'a'.repeat(40), addedLines: 10, reworkSummary: '验收缺测试' }),
  round({ outcome: 'ci_red', head: 'b'.repeat(40), addedLines: 40, reworkSummary: '类型检查报错' }),
  round({
    outcome: 'leftover',
    head: 'c'.repeat(40),
    addedLines: 90,
    reworkSummary: '工作树留了没提交的文件',
  }),
]);
/** 空转：同一原因连续失败、没有新提交。 */
const SPINNING = judgeSpin([
  round({ outcome: 'ci_red', head: 'a'.repeat(40) }),
  round({ outcome: 'ci_red', head: 'a'.repeat(40) }),
  round({ outcome: 'ci_red', head: 'a'.repeat(40) }),
]);

const ALL_KINDS: TriageKind[] = [
  'runtime',
  'transient',
  'unarmed',
  'rounds',
  'quota',
  'size',
  'standard',
  'other',
];

const allowedOf = (facts: ParkFacts, spin = null as ReturnType<typeof judgeSpin> | null) =>
  COMMANDER_ACTIONS.filter((a) => allowedActions(facts, spin)[a] === true);

describe('运行环境类停法按失败码和规则编号认，不看标题', () => {
  it('换路由续不上、没有可用路由、会话总时长到顶、进程被信号杀掉、连不上执行机：算运行环境', () => {
    expect(triageKindOf({ kind: 'other', code: PARK_CODE_ROUTE_SWITCH })).toBe('runtime');
    expect(triageKindOf({ kind: 'other', code: PARK_CODE_NO_ROUTE })).toBe('runtime');
    expect(triageKindOf({ kind: 'other', code: 'wall_clock_timeout', rule: 'WT1' })).toBe('runtime');
    expect(triageKindOf({ kind: 'other', code: 'exit_143', rule: 'KL4' })).toBe('runtime');
    expect(triageKindOf({ kind: 'other', code: 'ECONNREFUSED' })).toBe('runtime');
    expect(triageKindOf({ kind: 'transient', rule: 'MB1' })).toBe('runtime');
    for (const rule of RUNTIME_RULES) expect(triageKindOf({ kind: 'other', rule }), rule).toBe('runtime');
  });

  it('没有失败码、或失败码要人修（登录失效、没权限）：照工作流记的停法', () => {
    expect(triageKindOf({ kind: 'other' })).toBe('other');
    expect(triageKindOf({ kind: 'other', code: 'workflows_permission', rule: 'PM1' })).toBe('other');
    expect(triageKindOf({ kind: 'other', code: 'auth_failed', rule: 'AU2' })).toBe('other');
    expect(triageKindOf({ kind: 'transient', rule: 'FB' })).toBe('transient');
  });

  it('工作流记成别的停法（轮数、额度、体量、改标准、没挂上）的，失败码不改它', () => {
    for (const kind of ['rounds', 'quota', 'size', 'standard', 'unarmed'] as const)
      expect(triageKindOf({ kind, code: 'wall_clock_timeout', rule: 'WT1' }), kind).toBe(kind);
  });
});

describe('老历史的停法从提醒正文和任务行认', () => {
  it('体量超预算、额度超预算、轮数用尽认得出', () => {
    expect(legacyParkKind(['改动超出体量预算：新增 9550 行，预算 3000 行，收窄过一次仍超'])).toBe('size');
    expect(legacyParkKind([null, '这张单花掉的 token 超了预算（12.0M / 10.0M）'])).toBe('quota');
    expect(legacyParkKind(['这张单花掉的额度超了预算（输入当量 12.0M / 10.0M）'])).toBe('quota');
    expect(legacyParkKind(['动手 3 轮都没过'])).toBe('rounds');
    expect(legacyParkKind([undefined, '', '检查红了，返工 3 轮用完'])).toBe('rounds');
  });

  it('认不出回 null', () => {
    expect(legacyParkKind(['CI 的结果没查成', null])).toBeNull();
    expect(legacyParkKind([])).toBeNull();
  });
});

describe('白名单：每类停法放行哪些（leave 指带了理由类别的留给人）', () => {
  it('运行环境：继续、重做放行；拆单、停掉不放行', () => {
    expect(allowedOf(park('runtime'))).toEqual(['continue', 'redo', 'leave']);
  });

  it('轮数用尽：继续、重做；已继续满三次交指挥官的只许重做', () => {
    expect(allowedOf(park('rounds'))).toEqual(['continue', 'redo', 'leave']);
    expect(allowedOf(park('rounds', true))).toEqual(['redo', 'leave']);
  });

  it('体量超预算：继续（照这一版推）和拆单', () => {
    expect(allowedOf(park('size'))).toEqual(['continue', 'split', 'leave']);
  });

  it('认不出按临时的办、自动合并没挂上：继续、重做', () => {
    expect(allowedOf(park('transient'))).toEqual(['continue', 'redo', 'leave']);
    expect(allowedOf(park('unarmed'))).toEqual(['continue', 'redo', 'leave']);
  });

  it('改标准、没权限这类人闸：什么动手的都不放行', () => {
    expect(allowedOf(park('standard'))).toEqual(['leave']);
    expect(allowedOf(park('other'))).toEqual(['leave']);
  });

  it('额度超预算·没空转：继续（放宽预算）、重做、拆单；不许停掉', () => {
    expect(allowedOf(park('quota'), PROGRESSING)).toEqual(['continue', 'redo', 'split', 'leave']);
  });

  it('额度超预算·判成空转：不许原样继续，只许重做、拆单、停掉', () => {
    expect(allowedOf(park('quota'), SPINNING)).toEqual(['redo', 'split', 'stop', 'leave']);
  });

  it('额度超预算·回合没读到：不拿没读到当没空转，不许继续，只许重做', () => {
    expect(allowedOf(park('quota'), null)).toEqual(['redo', 'leave']);
  });

  it('停掉只有额度超预算判成空转才放行', () => {
    for (const kind of ALL_KINDS) expect(allowedOf(park(kind), PROGRESSING)).not.toContain('stop');
  });
});

describe('checkVerdict：核一条裁决', () => {
  it('运行环境每一种停法放行继续和重做', () => {
    for (const p of [
      { kind: 'other' as const, code: PARK_CODE_ROUTE_SWITCH },
      { kind: 'other' as const, code: 'wall_clock_timeout', rule: 'WT1' },
      { kind: 'other' as const, rule: 'KL4' },
      { kind: 'other' as const, code: 'econnrefused', rule: 'NT1' },
    ]) {
      const facts = park(triageKindOf(p));
      expect(checkVerdict(facts, null, { action: 'continue' }), JSON.stringify(p)).toEqual({
        ok: true,
        action: 'continue',
        widenBudget: false,
      });
      expect(checkVerdict(facts, null, { action: 'redo' }), JSON.stringify(p)).toMatchObject({ ok: true });
      expect(checkVerdict(facts, null, { action: 'split', subtaskCount: 3 }).ok).toBe(false);
    }
  });

  it('有进展的超预算单放行继续，并要求把额度预算放宽一档；老历史放宽不了', () => {
    expect(checkVerdict(park('quota'), PROGRESSING, { action: 'continue' })).toEqual({
      ok: true,
      action: 'continue',
      widenBudget: true,
    });
    expect(checkVerdict(park('quota', false, true), PROGRESSING, { action: 'continue' })).toEqual({
      ok: true,
      action: 'continue',
      widenBudget: false,
    });
  });

  it('空转的超预算单拒绝原样继续，理由里带空转判断', () => {
    const got = checkVerdict(park('quota'), SPINNING, { action: 'continue' });
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.why).toContain('不许原样继续');
      expect(got.why).toContain('判成空转');
    }
  });

  it('空转的超预算单放行重做、拆单（2~5 张）、停掉', () => {
    expect(checkVerdict(park('quota'), SPINNING, { action: 'redo' })).toMatchObject({ ok: true });
    expect(checkVerdict(park('quota'), SPINNING, { action: 'stop' })).toMatchObject({ ok: true });
    expect(checkVerdict(park('quota'), SPINNING, { action: 'split', subtaskCount: 3 })).toMatchObject({
      ok: true,
    });
  });

  it('体量超预算的拆单：子单数不在 2~5 拒绝；继续放行', () => {
    expect(checkVerdict(park('size'), null, { action: 'split', subtaskCount: 3 })).toMatchObject({
      ok: true,
    });
    expect(checkVerdict(park('size'), null, { action: 'continue' })).toMatchObject({ ok: true });
    for (const n of [undefined, 0, 1, 6]) {
      const got = checkVerdict(park('size'), null, { action: 'split', subtaskCount: n });
      expect(got.ok, String(n)).toBe(false);
    }
  });

  it('每类停法不放行的动作都拒绝，并写明是哪类停法', () => {
    const rejected: [TriageKind, CommanderAction][] = [
      ['size', 'redo'],
      ['size', 'stop'],
      ['rounds', 'split'],
      ['rounds', 'stop'],
      ['runtime', 'split'],
      ['runtime', 'stop'],
      ['standard', 'continue'],
      ['standard', 'redo'],
      ['other', 'continue'],
      ['other', 'split'],
      ['other', 'stop'],
      ['transient', 'split'],
      ['unarmed', 'stop'],
    ];
    for (const [kind, action] of rejected) {
      const got = checkVerdict(park(kind), null, { action, subtaskCount: 3 });
      expect(got.ok, `${kind}/${action}`).toBe(false);
      if (!got.ok) expect(got.why).toContain('不放行');
    }
  });

  it('留给人只认三种理由类别（掏新钱、删了找不回、改标准），哪种停法都放行', () => {
    for (const kind of ALL_KINDS)
      for (const leaveReason of LEAVE_REASONS)
        expect(
          checkVerdict(park(kind), null, { action: 'leave', leaveReason }),
          `${kind}/${leaveReason}`,
        ).toEqual({
          ok: true,
          action: 'leave',
          widenBudget: false,
          leaveReason,
        });
  });

  it('留给人不带类别、带了认不出的类别（拿不准）：不放行', () => {
    for (const leaveReason of [undefined, '', 'unsure', '拿不准', 'human-only']) {
      const got = checkVerdict(park('runtime'), null, { action: 'leave', leaveReason });
      expect(got.ok, String(leaveReason)).toBe(false);
      if (!got.ok) expect(got.why).toContain('要带理由类别');
    }
  });

  it('白名单外的动作名（会话编的）不放行', () => {
    for (const action of ['merge', 'close', 'delete', 'force-push', '', 'Continue']) {
      const got = checkVerdict(park('rounds'), null, { action });
      expect(got.ok, action).toBe(false);
      if (!got.ok) expect(got.why).toContain('不在白名单里');
    }
  });
});

describe('默认动作：没给裁决、留给人没带类别、交了表外动作时引擎执行', () => {
  const def = (
    kind: TriageKind,
    spin = null as ReturnType<typeof judgeSpin> | null,
    continuedBefore = false,
  ) => defaultAction({ ...park(kind), continuedBefore }, spin);

  it('运行环境和按临时的办、没挂上：继续；同一种停下继续过一次还停 → 重做', () => {
    for (const kind of ['runtime', 'transient', 'unarmed'] as const) {
      expect(def(kind)).toMatchObject({ action: 'continue', widenBudget: false });
      expect(def(kind, null, true)).toMatchObject({ action: 'redo' });
    }
  });

  it('轮数用尽 → 重做', () => {
    expect(def('rounds')).toMatchObject({ action: 'redo' });
    expect(defaultAction({ kind: 'rounds', handoff: true, continuedBefore: false }, null)).toMatchObject({
      action: 'redo',
    });
  });

  it('体量超预算 → 照这一版继续推', () => {
    expect(def('size')).toMatchObject({ action: 'continue', widenBudget: false });
    expect(def('size').why).toContain('照这一版');
  });

  it('额度超预算：没空转继续并放宽一档；空转重做；回合没读到重做；老历史继续不放宽', () => {
    expect(def('quota', PROGRESSING)).toMatchObject({ action: 'continue', widenBudget: true });
    expect(def('quota', SPINNING)).toMatchObject({ action: 'redo' });
    expect(def('quota', null)).toMatchObject({ action: 'redo' });
    expect(
      defaultAction({ kind: 'quota', handoff: false, legacy: true, continuedBefore: false }, PROGRESSING),
    ).toMatchObject({ action: 'continue', widenBudget: false });
  });

  it('改标准 → 贴「本机做」；没权限 → 留给人并写卡（只有人能做）', () => {
    expect(def('standard')).toMatchObject({ action: 'leave', leaveReason: 'standard' });
    expect(def('other')).toMatchObject({ action: 'leave', leaveReason: 'human-only' });
  });

  it('默认的动手动作都在这种停法的白名单里', () => {
    for (const kind of ALL_KINDS)
      for (const spin of [null, PROGRESSING, SPINNING])
        for (const continuedBefore of [false, true]) {
          const d = defaultAction({ ...park(kind), continuedBefore }, spin);
          if (d.action === 'leave') continue;
          expect(allowedActions(park(kind), spin)[d.action], `${kind}/${d.action}`).toBe(true);
        }
  });
});

describe('验收责任裁决白名单', () => {
  const source = (over: Partial<Parameters<typeof checkAcceptanceVerdict>[0]> = {}) => ({
    id: 7,
    generation: 2,
    repo: 'acme/app',
    issueNumber: 42,
    prNumber: 99,
    head: 'a'.repeat(40),
    items: ['线上审计记录'],
    mergeCommit: 'b'.repeat(40),
    ...over,
  });
  const target = (over: Partial<Parameters<typeof checkAcceptanceVerdict>[1]> = {}) => ({
    id: 8,
    generation: 1,
    repo: 'acme/app',
    issueNumber: 42,
    prNumber: 99,
    head: 'c'.repeat(40),
    items: ['线上审计记录'],
    mergeCommit: 'd'.repeat(40),
    ...over,
  });
  const base = {
    dutyId: 7,
    generation: 2,
    prNumber: 99,
    head: 'a'.repeat(40),
    reason: '证据与责任逐条对应',
  };

  it('结清、supersede、留给人三种裁决都各自满足自己的证据要求', () => {
    expect(
      checkAcceptanceVerdict(source(), undefined, {
        ...base,
        action: 'settle',
        evidence: 'GitHub 合并回执与主机审计记录相符',
      }),
    ).toEqual({ ok: true, action: 'settle' });
    expect(
      checkAcceptanceVerdict(source(), target(), {
        ...base,
        action: 'supersede',
        evidence: '最终头已覆盖旧头责任',
        target: {
          id: 8,
          generation: 1,
          prNumber: 99,
          head: 'c'.repeat(40),
        },
        coverage: [{ source: '线上审计记录', target: '线上审计记录', basis: '同一验收项' }],
      }),
    ).toMatchObject({ ok: true, action: 'supersede' });
    expect(
      checkAcceptanceVerdict(source(), undefined, {
        ...base,
        action: 'leave',
        humanOnly: '只有 Contabo 控制台审计能提供这条证据',
      }),
    ).toEqual({ ok: true, action: 'leave' });
  });

  it('证据为空、身份头不符、PR 没有合并回执都拒绝', () => {
    expect(checkAcceptanceVerdict(source(), undefined, { ...base, action: 'settle', evidence: ' ' })).toEqual(
      { ok: false, why: '验收收口必须写非空证据' },
    );
    expect(
      checkAcceptanceVerdict(source(), undefined, {
        ...base,
        action: 'settle',
        head: 'z'.repeat(40),
        evidence: '有证据',
      }),
    ).toEqual({ ok: false, why: '验收责任的 id、代次、PR 或 head 与现读不符' });
    expect(
      checkAcceptanceVerdict(source({ mergeCommit: null }), undefined, {
        ...base,
        action: 'settle',
        evidence: '只有未合并的 PR 记录',
      }),
    ).toEqual({ ok: false, why: 'PR 没有合并回执，不能结清验收责任' });
  });
});
