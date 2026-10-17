import { DOMAIN_LABELS, NATURE_LABELS, parseDomain, parseNature } from './labels.ts';

/** 每条查询轴恰好一个已知值；未知、重复和冲突都不能当成齐全。 */
export function queryAxisProblems(labels: readonly string[]): string[] {
  return (
    [
      ['域', DOMAIN_LABELS, parseDomain],
      ['性质', NATURE_LABELS, parseNature],
    ] as const
  ).flatMap(([axis, known, parse]) => {
    const values = labels.filter((label) => label.startsWith(`${axis}:`));
    if (values.length === 1 && parse(values[0] ?? '') !== undefined) return [];
    return [
      `查询轴「${axis}」需要恰好一个有效标签（${known.join('、')}），现在是 ${values.join('、') || '缺失'}`,
    ];
  });
}

/** 只认独立声明行或 GitHub issue form 的字段；正文提到某标签不等于选择了它。 */
export function declaredQueryAxes(body: string): string[] {
  // 示例、引用和注释里的分类不是声明。
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  let fence: string | undefined;
  body = body
    .split('\n')
    .map((line) => {
      const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (mark) {
        if (!fence) fence = mark;
        else if (mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
        return '';
      }
      return fence || /^\s*>/.test(line) ? '' : line;
    })
    .join('\n');
  const out: string[] = [];
  const declaration = /^\s*(?:[-*]\s+)?(域|性质)\s*[:：]\s*`?([^\s`]+)`?\s*$/gm;
  for (const match of body.matchAll(declaration)) out.push(`${match[1]}:${match[2]}`);
  const field = /^### (域|性质)\s*\r?\n\s*\r?\n([^\r\n]+)\s*$/gm;
  for (const match of body.matchAll(field)) out.push(`${match[1]}:${match[2]?.trim()}`);
  return out;
}

/** 缺轴可从明确来源继承；已有冲突、未知值不覆盖，也不按标题/类别猜性质。 */
export function resolveQueryAxes(
  labels: readonly string[],
  body = '',
  inherited: readonly string[] = [],
): { labels: string[]; problems: string[] } {
  const declarations = declaredQueryAxes(body);
  const result: string[] = [];
  for (const prefix of ['域:', '性质:']) {
    const present = labels.filter((label) => label.startsWith(prefix));
    const declared = declarations.filter((label) => label.startsWith(prefix));
    const source = inherited.filter((label) => label.startsWith(prefix));
    result.push(...(present.length > 0 ? present : declared.length > 0 ? declared : source));
  }
  return { labels: result, problems: queryAxisProblems(result) };
}
