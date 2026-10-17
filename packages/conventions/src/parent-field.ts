/** 正文里的关系字段只认独立的 parent 行；引用、代码和注释里的示例不算。 */
export type ParentField = { kind: 'none' } | { kind: 'parent'; number: number } | { kind: 'invalid' };

function commentAfter(text: string, open = false): boolean {
  let cursor = 0;
  while (cursor < text.length) {
    const at = text.indexOf(open ? '-->' : '<!--', cursor);
    if (at < 0) return open;
    cursor = at + (open ? 3 : 4);
    open = !open;
  }
  return open;
}

/** 活动正文行的位置保留原始换行；单行 HTML 注释本身可供机器标记读取。 */
export function activeBodyLines(
  body: string,
): { text: string; start: number; end: number; contentEnd: number }[] {
  let fence: { char: string; length: number } | undefined;
  let comment = false;
  const lines: { text: string; start: number; end: number; contentEnd: number }[] = [];
  const pattern = /([^\r\n]*)(\r?\n|\r|$)/g;
  for (const match of body.matchAll(pattern)) {
    const line = match[1] ?? '';
    if (!match[0]) continue;
    if (comment) {
      comment = commentAfter(line, true);
      continue;
    }
    if (/^ {0,3}>/.test(line) || /^(?: {4}|\t)/.test(line)) continue;
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (close?.[0] === fence.char && close.length >= fence.length) fence = undefined;
      continue;
    }
    const start = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (start) {
      fence = { char: start[0] ?? '', length: start.length };
      continue;
    }
    if (line.includes('<!--')) {
      comment = commentAfter(line);
    }
    lines.push({
      text: line,
      start: match.index,
      end: match.index + match[0].length,
      contentEnd: match.index + line.length,
    });
  }
  return lines;
}

const fieldsIn = (body: string) =>
  activeBodyLines(body).filter((line) => !line.text.includes('<!--') && /^ {0,3}parent\s*:/i.test(line.text));

export function parentField(body: string): ParentField {
  const fields = fieldsIn(body);
  if (fields.length === 0) return { kind: 'none' };
  if (fields.length !== 1) return { kind: 'invalid' };
  const digits = /^ {0,3}parent: #([1-9]\d*)[ \t]*$/.exec(fields[0]?.text ?? '')?.[1];
  const number = digits === undefined ? NaN : Number(digits);
  return Number.isSafeInteger(number) ? { kind: 'parent', number } : { kind: 'invalid' };
}

/** 替换全部活动 parent 字段，示例和正文原样保留；放在开头避免被未闭合正文吞掉。 */
export function withParentField(body: string, parent: number): string {
  if (!Number.isSafeInteger(parent) || parent <= 0) throw new Error('parent 必须是正安全整数。');
  let result = body;
  for (const line of fieldsIn(body).reverse()) result = result.slice(0, line.start) + result.slice(line.end);
  return `parent: #${parent}\n${result}`;
}
