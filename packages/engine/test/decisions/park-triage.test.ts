// 指挥官裁决的白名单（#3294 第 2 片）：每类停法的放行和拒绝；白名单外的裁决不放行；额度超预算按空转判，不按钱。
import { describe, expect, it } from 'vitest';
import {
  allowedActions,
  COMMANDER_ACTIONS,
  type CommanderAction,
  checkVerdict,
  type ParkFacts,
} from '../../src/decisions/park-triage.ts';
import { judgeSpin, type SpinRound } from '../../src/decisions/spin.ts';
import type { ParkKind } from '../../src/task-contract.ts';

const park = (kind: ParkKind, handoff = false): ParkFacts => ({ kind, handoff });
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

const allowedOf = (facts: ParkFacts, spin = null as ReturnType<typeof judgeSpin> | null) =>
  COMMANDER_ACTIONS.filter((a) => allowedActions(facts, spin)[a] === true);

describe('白名单：每类停法放行哪些', () => {
  it('轮数用尽：继续、重做、留给人；拆单、停掉不放行', () => {
    expect(allowedOf(park('rounds'))).toEqual(['continue', 'redo', 'leave']);
  });

  it('已继续满三次交指挥官的：继续没用（工作流会原样再停），只许重做和留给人', () => {
    expect(allowedOf(park('rounds', true))).toEqual(['redo', 'leave']);
  });

  it('体量超预算：拆单、停掉（成果已在主线，checkVerdict 再核 mergedIn）、留给人', () => {
    expect(allowedOf(park('size'))).toEqual(['split', 'stop', 'leave']);
  });

  it('认不出按临时的办、自动合并没挂上：继续、重做、留给人', () => {
    expect(allowedOf(park('transient'))).toEqual(['continue', 'redo', 'leave']);
    expect(allowedOf(park('unarmed'))).toEqual(['continue', 'redo', 'leave']);
  });

  it('改标准、没权限这类人闸：只写诊断建议（留给人），什么动手的都不放行', () => {
    expect(allowedOf(park('standard'))).toEqual(['leave']);
    expect(allowedOf(park('other'))).toEqual(['leave']);
  });

  it('额度超预算·没空转：继续（放宽预算）、重做、拆单、留给人；不许停掉', () => {
    expect(allowedOf(park('quota'), PROGRESSING)).toEqual(['continue', 'redo', 'split', 'leave']);
  });

  it('额度超预算·判成空转：不许原样继续，只许重做、拆单、停掉、留给人', () => {
    expect(allowedOf(park('quota'), SPINNING)).toEqual(['redo', 'split', 'stop', 'leave']);
  });

  it('额度超预算·回合没读到：不拿没读到当没空转，只许留给人', () => {
    expect(allowedOf(park('quota'), null)).toEqual(['leave']);
  });

  it('停掉只有额度超预算判成空转、体量超预算才放行', () => {
    for (const kind of ['rounds', 'transient', 'unarmed', 'standard', 'other'] as ParkKind[])
      expect(allowedOf(park(kind), PROGRESSING)).not.toContain('stop');
    expect(allowedOf(park('quota'), PROGRESSING)).not.toContain('stop');
  });
});

describe('checkVerdict：核一条裁决', () => {
  it('有进展的超预算单放行继续，并要求把额度预算放宽一档', () => {
    expect(checkVerdict(park('quota'), PROGRESSING, { action: 'continue' })).toEqual({
      ok: true,
      action: 'continue',
      widenBudget: true,
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

  it('继续不放宽预算：不是额度停法的继续 widenBudget=false', () => {
    expect(checkVerdict(park('rounds'), null, { action: 'continue' })).toEqual({
      ok: true,
      action: 'continue',
      widenBudget: false,
    });
  });

  it('体量超预算的拆单：子单数不在 2~5 拒绝', () => {
    expect(checkVerdict(park('size'), null, { action: 'split', subtaskCount: 3 })).toMatchObject({
      ok: true,
    });
    for (const n of [undefined, 0, 1, 6]) {
      const got = checkVerdict(park('size'), null, { action: 'split', subtaskCount: n });
      expect(got.ok, String(n)).toBe(false);
    }
  });

  it('体量超预算的停掉（#3207 成果已分片合进主线）：带主线提交号才放行，没带、样子不对拒绝', () => {
    expect(
      checkVerdict(park('size'), null, {
        action: 'stop',
        mergedIn: '378af18f04b6e82c8a99ad8cb1f850edb0c34269',
      }),
    ).toEqual({ ok: true, action: 'stop', widenBudget: false });
    expect(checkVerdict(park('size'), null, { action: 'stop', mergedIn: '378af18' })).toMatchObject({
      ok: true,
    });
    for (const mergedIn of [undefined, '', '#3358', '378af1', 'main', '378AF18F']) {
      const got = checkVerdict(park('size'), null, { action: 'stop', mergedIn });
      expect(got.ok, String(mergedIn)).toBe(false);
      if (!got.ok) expect(got.why).toContain('mergedIn');
    }
  });

  it('每类停法不放行的动作都拒绝，并写明是哪类停法', () => {
    const rejected: [ParkKind, CommanderAction][] = [
      ['size', 'continue'],
      ['size', 'redo'],
      ['rounds', 'split'],
      ['rounds', 'stop'],
      ['standard', 'continue'],
      ['standard', 'redo'],
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

  it('留给人永远放行', () => {
    for (const kind of ['transient', 'unarmed', 'rounds', 'quota', 'size', 'standard', 'other'] as ParkKind[])
      expect(checkVerdict(park(kind), null, { action: 'leave' })).toMatchObject({
        ok: true,
        action: 'leave',
      });
  });

  it('白名单外的动作名（会话编的）不放行', () => {
    for (const action of ['merge', 'close', 'delete', 'force-push', '', 'Continue']) {
      const got = checkVerdict(park('rounds'), null, { action });
      expect(got.ok, action).toBe(false);
      if (!got.ok) expect(got.why).toContain('不在白名单里');
    }
  });
});
