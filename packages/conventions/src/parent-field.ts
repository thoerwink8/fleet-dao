/** 正文里的关系字段只认独立的 parent 行；引用、代码和注释里的示例不算。 */
export type ParentField = { kind: 'none' } | { kind: 'parent'; number: number } | { kind: 'invalid' };

export function parentField(body: string): ParentField {
  let fence: { char: string; length: number } | undefined;
  let comment = false;
  const fields: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^ {0,3}>/.test(line) || /^(?: {4}|\t)/.test(line)) continue;
    if (comment) {
      if (line.includes('-->')) comment = false;
      continue;
    }
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
      comment = !line.slice(line.indexOf('<!--') + 4).includes('-->');
      continue;
    }
    if (/^ {0,3}parent\s*:/i.test(line)) fields.push(line);
  }
  if (fields.length === 0) return { kind: 'none' };
  if (fields.length !== 1) return { kind: 'invalid' };
  const digits = /^ {0,3}parent: #([1-9]\d*)[ \t]*$/.exec(fields[0] ?? '')?.[1];
  const number = digits === undefined ? NaN : Number(digits);
  return Number.isSafeInteger(number) ? { kind: 'parent', number } : { kind: 'invalid' };
}
