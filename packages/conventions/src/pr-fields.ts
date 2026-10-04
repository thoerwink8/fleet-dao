// 只剩两样：（1）PR 正文「对应计划」那一栏的核对 checkPlanValue——引擎收需求文档（Fusion 时代的 sessions.ts）还在用，
// 随 #556-4 一起删；（2）GitHub Actions 的报错注解 annotation。
// #654 前这里还管「PR 必填栏」（类别标签、里程碑、对应计划、specs、档位、这个 PR 做完就关单）的提醒：全是只提醒不挡合并，
// 填的人 8 成写「无」或「不适用」，删了；PR 模板只剩四栏，合并闸也不再提醒。

import { milestoneVersion } from './labels.ts';
import { parseMd } from './markdown.ts';
import { findItem, itemExample, parsePlanRefs, phaseRange, planPhases } from './plan.ts';

/** plan.md 在仓里的位置：引擎收需求文档时核「对应计划」那一行，按它找。 */
export const PLAN_DOC = 'docs/plan.md';

/**
 * 只核「对应计划」这一栏的值：版本全名、#<单号>、未排期都直接算过；旧写法要阶段在 plan.md 里有、引号里是那一阶段某一条的
 * 原话。引擎收写需求文档的会话交回来的「对应计划：」那一行时先核一遍。plan.md 里一个阶段都认不出也算一条问题，不当成过了。
 */
export function checkPlanValue(value: string, planMarkdown: string): string[] {
  const phases = planPhases(parseMd(PLAN_DOC, planMarkdown));
  if (phases.size === 0) return [`${PLAN_DOC} 里一个阶段（### P0 …）也没认出来`];
  const range = phaseRange(phases);
  if (!value) return ['「对应计划」一栏是空的：写 plan.md 的阶段加那一条的原话开头，比如 P1「工作流」。'];
  const v = value.replace(/`/g, '').trim();
  if (v.startsWith('未排期') || /^#\d+/.test(v) || milestoneVersion(v) !== undefined) return [];
  const refs = parsePlanRefs(value);
  if (refs.length === 0) {
    return [
      `「对应计划」写的「${oneLine(value)}」认不出：写版本全名、#<单号>、未排期，或旧写法 P1「工作流」（阶段加那一条的原话开头）。`,
    ];
  }
  const problems: string[] = [];
  for (const ref of refs) {
    const phase = phases.get(ref.phase);
    const example = `P${ref.phase}「${itemExample(phase)}」`;
    if (!phase) {
      problems.push(
        `「对应计划」的 ${ref.raw} 在 plan.md 里没有 P${ref.phase} 这个阶段：阶段只有 ${range}。`,
      );
    } else if (ref.item === undefined) {
      problems.push(`「对应计划」的 P${ref.phase} 没写是哪一条：后面加上那一条的原话开头，比如 ${example}。`);
    } else if (!ref.item.trim()) {
      problems.push(
        `「对应计划」的 ${ref.raw} 引号里是空的：写上 P${ref.phase} 里那一条的原话开头，比如 ${example}。`,
      );
    } else if (findItem(phase, ref.item) === undefined) {
      problems.push(
        `「对应计划」的 ${ref.raw} 在 plan.md 的 P${ref.phase} 一节里找不到：照抄那一条的原话（开头几个字就行）。`,
      );
    }
  }
  return problems;
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

/** GitHub Actions 的注解（报错、提醒、说明，在检查页上直接显示）；% 和换行要转义。 */
export function annotation(text: string, level: 'error' | 'warning' | 'notice' = 'error'): string {
  return `::${level}::${text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;
}
