// 题库：引擎真在问的三个接入点都有题，每道题写得对；不接「选哪条路由」。
import { describe, expect, it } from 'vitest';
import { BANK, ISSUE_KIND } from '../src/bank.ts';
import {
  checkBatch,
  checkQuestion,
  defineQuestion,
  questionRev,
  renderPrompt,
  SITES,
} from '../src/questions.ts';

describe('题库', () => {
  it('接入点就是引擎真在问的三个，每个都有题', () => {
    expect(Object.keys(SITES)).toEqual(['error-route', 'stall-check', 'issue-kind']);
    expect(BANK.map((q) => q.site).sort()).toEqual(Object.keys(SITES).sort());
  });

  it('每道题都写得对：题面、选项（带效果和真拦时怎么走）、证据字段、拿不准时的默认走向', () => {
    expect(BANK.flatMap(checkQuestion)).toEqual([]);
    expect(new Set(BANK.map((q) => q.id)).size).toBe(BANK.length);
  });

  it('不接「选哪条路由」：没有哪道题是在一串路由里挑一条', () => {
    for (const q of BANK) {
      expect(q.id).not.toMatch(/route-pick|leg|pool/);
      expect(q.instructions).not.toMatch(/哪条路由|哪条腿|哪个账号池/);
    }
  });

  it('写坏的题查得出来', () => {
    const bad = defineQuestion({
      ...ISSUE_KIND,
      id: 'Bad Id',
      options: [
        { id: 'a', label: 'A', criteria: '甲', effect: 'stop', does: '停' },
        { id: 'a', label: 'A', criteria: '乙', effect: 'stop', does: '停' },
      ],
      evidence: [{ key: 'x', label: 'x', required: false }],
      whenUnsure: ' ',
      confidenceLine: 1.2,
    });
    const problems = checkQuestion(bad);
    for (const needle of ['题号', '重复', 'none', '必填', '默认走向', '把握线']) {
      expect(problems.join('\n')).toContain(needle);
    }
  });

  it('同一次问的几道题，同一个证据字段名字不一样：查得出来', () => {
    const other = defineQuestion({
      ...ISSUE_KIND,
      id: 'other',
      evidence: [{ key: 'issue', label: '别的名字', required: true }],
    });
    expect(checkBatch([ISSUE_KIND, other]).join('')).toContain('名字不一样');
  });

  it('题目版本：判据或证据字段改一个字 rev 就变；库里存的题面带着每个选项的判据和证据字段', () => {
    const changed = defineQuestion({
      ...ISSUE_KIND,
      options: [
        { ...ISSUE_KIND.options[0], criteria: '改过的判据' },
        ISSUE_KIND.options[1],
        ISSUE_KIND.options[2],
      ],
    });
    expect(questionRev(changed)).not.toBe(questionRev(ISSUE_KIND));
    expect(renderPrompt(ISSUE_KIND)).toContain('- feature：');
    // 真拦资格比题面、准确率按 rev 分版本：两边必须一起变，否则只改证据字段时准确率清零、题却照旧真拦。
    const relabeled = defineQuestion({
      ...ISSUE_KIND,
      evidence: [{ ...ISSUE_KIND.evidence[0], label: '改过名字' }],
    });
    expect(renderPrompt(relabeled)).not.toBe(renderPrompt(ISSUE_KIND));
    expect(questionRev(relabeled)).not.toBe(questionRev(ISSUE_KIND));
    const optional = defineQuestion({
      ...ISSUE_KIND,
      evidence: [{ ...ISSUE_KIND.evidence[0], required: false }],
    });
    expect(renderPrompt(optional)).not.toBe(renderPrompt(ISSUE_KIND));
  });
});
