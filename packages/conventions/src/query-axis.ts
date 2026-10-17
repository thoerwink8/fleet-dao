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
  return extractQueryAxes(body).labels;
}

/** 声明可另列为元数据，不能混进「已知的模块」参与路径和规模判定。原话、示例与其它文本保留原样。 */
export function extractQueryAxes(body: string): { labels: string[]; withoutDeclarations: string } {
  const original = body;
  // 示例、引用和注释里的分类不是声明。
  // 屏蔽时保持字符偏移，才能只从原文移走真声明。
  body = body.replace(/<!--[\s\S]*?-->/g, (text) => text.replace(/[^\r\n]/g, ' '));
  let fence: string | undefined;
  body = body
    .split('\n')
    .map((line) => {
      const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (mark) {
        if (!fence) fence = mark;
        else if (mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
        return ' '.repeat(line.length);
      }
      return fence || /^\s*>/.test(line) ? ' '.repeat(line.length) : line;
    })
    .join('\n');
  const out: string[] = [];
  const spans: { start: number; end: number }[] = [];
  const declaration = /^[ \t]*(?:[-*][ \t]+)?(域|性质)[ \t]*[:：][ \t]*`?([^\s`]+)`?[ \t]*\r?$/gm;
  for (const match of body.matchAll(declaration)) {
    out.push(`${match[1]}:${match[2]}`);
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  const field = /^### (域|性质)[ \t]*\r?\n[ \t]*\r?\n([^\r\n]+)[ \t]*\r?$/gm;
  for (const match of body.matchAll(field)) {
    out.push(`${match[1]}:${match[2]?.trim()}`);
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  let withoutDeclarations = original;
  for (const { start, end } of spans.sort((a, b) => b.start - a.start))
    withoutDeclarations = withoutDeclarations.slice(0, start) + withoutDeclarations.slice(end);
  return { labels: out, withoutDeclarations };
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
