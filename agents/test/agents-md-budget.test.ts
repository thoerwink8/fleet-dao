// 规矩字数账（防膨胀）：通用段（agents/shared-rules.md，同步进每台机器各家 AI 的全局说明）和仓根 AGENTS.md 的本仓段，
// 每次会话都会整份读进上下文，越长越限制模型（创始人 2026-10-03）。不设硬上限（创始人 2026-10-10：「更合适的方式，而不是通过硬限制，
// 去约束字数；但是要防止膨胀」），改成记账：agents/rules-budget.json 记各段现字数、上次瘦身后的字数（baseline）和每次增减的明细。
// 改了规矩就要在账上记一笔（+N 字、为什么、PR/决定号），实际字数和账不一致、明细 delta 之和对不上 chars - baseline，这里就红。
// 累计增长超账里的阈值不让 CI 红：每天的定时任务（debt.yml）会开一张「规矩瘦身」单，瘦身 PR 合并时把 baseline 重置成新字数。
// 瘦身三条减法：① 别处（design、ops、技能、决定记录）已有的，只留一句指针；② 钩子、测试已经管住的，缩成一句；③ 同一件事写了两处的，并成一处。
// 改这个文件和账本不算改标准（但 agents/**/*.md 算：改通用段本身要走改标准）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkLedger,
  countGeneral,
  countRepo,
  parseLedger,
  slimDue,
} from '../../packages/conventions/src/rules-budget.ts';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
/** 通用段的原件（2026-10-05 从仓根 AGENTS.md 挪出来：留在那里，在本仓干活的会话全局说明读一遍、AGENTS.md 又读一遍） */
const SHARED = read('../shared-rules.md');
const AGENTS = read('../../AGENTS.md');
const LEDGER = parseLedger(read('../rules-budget.json'));
const actual = { general: countGeneral(SHARED), repo: countRepo(AGENTS) };

describe('规矩字数账（防膨胀）', () => {
  it('实际字数和账一字不差、明细对得上：改了规矩要在 agents/rules-budget.json 记一笔', () => {
    expect(checkLedger(LEDGER, actual), '字数账对不上').toEqual([]);
  });

  it('累计增长只是提示：超阈值不红，只是该瘦身（定时任务开单）', () => {
    expect(Array.isArray(slimDue(LEDGER))).toBe(true);
  });

  it('仓根 AGENTS.md 不再带通用段：带了就是每次多读一整份', () => {
    expect(AGENTS).not.toContain('fleet-dao:通用段 开始');
    expect(AGENTS).not.toContain('fleet-dao:通用段 结束');
  });

  it('【故意造出的失败】塞一大段进去没记账：红；认不出标记、标题时明确报错，不当成 0 字', () => {
    const fat = '- 多出来的一条规矩。'.repeat(500);
    const bloated = SHARED.replace(
      '<!-- fleet-dao:通用段 结束 -->',
      `${fat}\n<!-- fleet-dao:通用段 结束 -->`,
    );
    const problems = checkLedger(LEDGER, {
      general: countGeneral(bloated),
      repo: countRepo(`${AGENTS}${fat}`),
    });
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/在账上记一笔：\+\d+ 字、为什么/);
    expect(() => countGeneral('# 没有标记的文件')).toThrow(/认不出通用段标记/);
    expect(() => countRepo('# 没有本仓标题的文件')).toThrow(/认不出「## 本仓」标题/);
  });
});
