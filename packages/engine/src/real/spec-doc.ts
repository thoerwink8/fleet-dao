// 需求文档（<specs 目录>/需求.md）里「对应计划：…」那一行。开 PR 的正文「对应计划」一栏照它写：#41 的 pr-fields
// 缺了就红，正文会话改不了，只能人改。写需求文档的会话交回来时就查（那一行指得到 plan.md 哪一条，用 packages/conventions
// 同一套判法；没有就退回去补），开 PR 时再从主线上现读一遍（人可能改过；不把值抄进工作流历史，抄了就和文件分家）。

import { checkPlanValue, PLAN_DOC } from '@fleet-dao/conventions';

export const REQUIREMENT_DOC = '需求.md';

/** 缺了、没填时告诉会话或人怎么写。 */
export const PLAN_LINE_HINT =
  '单独起一行写「对应计划：plan.md P<阶段>「<那一条的原话开头>」」，例如「对应计划：plan.md P1「工作流」」；仓里没有 plan.md 就写「对应计划：无」';

const PLAN_LINE = /^\s*对应计划\s*[：:]\s*(.*)$/;

/**
 * 第一行以「对应计划：」开头的那一行冒号后面的字。没有这一行、后面空着、还是骨架里没填的空引号（「」），
 * 都回 error 说清是哪一种——不回空串，免得正文里这一栏空着、看着像填了。
 */
export function planLineOf(markdown: string): { ok: string } | { error: string } {
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const m = PLAN_LINE.exec(line);
    if (!m) continue;
    const value = (m[1] ?? '').trim();
    if (!value) return { error: '「对应计划：」那一行后面是空的' };
    if (value.includes('「」')) return { error: `「对应计划：${value}」里的引号是空的（骨架没填）` };
    return { ok: value };
  }
  return { error: '没有「对应计划：」那一行' };
}

/**
 * 那一行和仓里的 plan.md 对不对得上。仓里没有 plan.md（别的仓不一定有）就不核条目，只要求写清——写「无」也算写了，
 * 但不许空着、不许瞎凑一条。plan.md 读不到的那一份（markdown 传 undefined）也算没有。
 */
export function checkPlanLine(value: string, planMarkdown: string | undefined): string | undefined {
  if (planMarkdown === undefined) {
    return value === '无' || value.startsWith('无（')
      ? undefined
      : `仓里没有 ${PLAN_DOC}：这一行写「对应计划：无」，或者先给仓里加上 ${PLAN_DOC} 再写它哪一条`;
  }
  const problems = checkPlanValue(value, planMarkdown);
  return problems.length > 0 ? problems.join('；') : undefined;
}
