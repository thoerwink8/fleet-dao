import { activeBodyLines } from './parent-field.ts';

const OPEN = '<!-- fleet:mother-manifest -->';
const CLOSE = '<!-- /fleet:mother-manifest -->';
export type Manifest =
  | { kind: 'absent' }
  | { kind: 'valid'; children: number[]; start: number; end: number }
  | { kind: 'invalid'; why: string };

/** 只读唯一的完整三行清单；坏段不能当成没写，避免对账覆盖掉权威清单。 */
export function readManifest(body: string): Manifest {
  const lines = activeBodyLines(body);
  const markers = lines.filter((line) => /^ {0,3}<!--\s*\/?fleet:mother-manifest\b/.test(line.text));
  if (markers.length === 0) return { kind: 'absent' };
  if (markers.length !== 2 || markers[0]?.text !== OPEN || markers[1]?.text !== CLOSE)
    return { kind: 'invalid', why: 'manifest 必须恰好有一对完整独立行标记。' };
  const opening = markers[0];
  const closing = markers[1];
  const middle = body.slice(opening.end, closing.start);
  // 标记之间恰好一行 JSON，不能藏注释、围栏或额外空行。
  if (!/^[^\r\n]*(?:\r?\n|\r)$/.test(middle))
    return { kind: 'invalid', why: 'manifest 标记之间必须恰好一行 JSON 数组。' };
  let children: unknown;
  try {
    children = JSON.parse(middle);
  } catch {
    return { kind: 'invalid', why: 'manifest 不是合法 JSON。' };
  }
  if (!Array.isArray(children) || children.some((n) => !Number.isSafeInteger(n) || n <= 0))
    return { kind: 'invalid', why: 'manifest 必须是正安全整数数组。' };
  if (new Set(children).size !== children.length)
    return { kind: 'invalid', why: 'manifest 子单号不能重复。' };
  return { kind: 'valid', children, start: opening.start, end: closing.contentEnd };
}

/** 新建清单放最前；已有清单只原位替换那一段，保留需求正文。 */
export function withManifest(body: string, children: readonly number[]): string {
  if (!Array.isArray(children) || children.some((n) => !Number.isSafeInteger(n) || n <= 0))
    throw new Error('manifest 子单号必须是正安全整数。');
  const before = readManifest(body);
  if (before.kind === 'invalid') throw new Error(before.why);
  const block = `${OPEN}\n${JSON.stringify([...new Set(children)].sort((a, b) => a - b))}\n${CLOSE}`;
  return before.kind === 'absent'
    ? `${block}\n\n${body}`
    : body.slice(0, before.start) + block + body.slice(before.end);
}
