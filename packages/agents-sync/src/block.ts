// 通用段的一对标记。仓里 AGENTS.md 和各家的全局文件用的是同一对：标记之间（含标记这两行）是受管的一块，
// 标记外的内容一概不动。只认整行一模一样的标记（行首行尾的空白和 \r 不算）；改标记文字要连仓里 AGENTS.md 一起改，
// 已经写到各家文件里的旧标记，新标记认不出——会被当成「没有受管块」再接管一次（先备份）。
export const BEGIN =
  '<!-- fleet-dao:通用段 开始。同步脚本按这对标记整块替换；要改规矩，改 fleet-dao 仓的 AGENTS.md -->';
export const END = '<!-- fleet-dao:通用段 结束 -->';

export type Markers =
  | { kind: 'none' }
  | { kind: 'broken'; why: string }
  /** start：开始标记那一行的行首；end：结束标记那一行的行尾（不含换行） */
  | { kind: 'one'; start: number; end: number };

interface LineAt {
  text: string;
  start: number;
  end: number;
}

function linesOf(text: string): LineAt[] {
  const out: LineAt[] = [];
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    const lineEnd = end > start && text[end - 1] === '\r' ? end - 1 : end;
    out.push({ text: text.slice(start, lineEnd), start, end: lineEnd });
    if (nl === -1) break;
    start = nl + 1;
  }
  return out;
}

export function findMarkers(text: string): Markers {
  const lines = linesOf(text);
  const begins = lines.filter((l) => l.text.trim() === BEGIN);
  const ends = lines.filter((l) => l.text.trim() === END);
  if (begins.length === 0 && ends.length === 0) return { kind: 'none' };
  if (begins.length !== 1 || ends.length !== 1) {
    return { kind: 'broken', why: `开始标记 ${begins.length} 个、结束标记 ${ends.length} 个，应各 1 个` };
  }
  const [b] = begins as [LineAt];
  const [e] = ends as [LineAt];
  if (e.start < b.start) return { kind: 'broken', why: '结束标记在开始标记前面' };
  return { kind: 'one', start: b.start, end: e.end };
}

/** 受管的一块（含两行标记），去掉 \r */
export function blockAt(text: string, m: { start: number; end: number }): string {
  return text.slice(m.start, m.end).replaceAll('\r', '');
}

/** 把受管的一块换成 block；标记外的每个字节原样留着。换行跟着文件走（文件里有 \r\n 就用 \r\n） */
export function replaceBlock(text: string, m: { start: number; end: number }, block: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return text.slice(0, m.start) + block.replaceAll('\n', eol) + text.slice(m.end);
}

/** 仓里 AGENTS.md 的通用段（含两行标记，去掉 \r）；标记不成对就说清哪里不对 */
export function sharedBlock(agentsMd: string): { ok: true; block: string } | { ok: false; why: string } {
  const m = findMarkers(agentsMd);
  if (m.kind === 'none') return { ok: false, why: '没有通用段的标记' };
  if (m.kind === 'broken') return { ok: false, why: m.why };
  const block = blockAt(agentsMd, m);
  if (block.split('\n').length < 3) return { ok: false, why: '两行标记之间是空的' };
  return { ok: true, block };
}

export function countLines(text: string): number {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** 两段文字从第几行起不一样（1 起数）；一样返回 0 */
export function firstDiffLine(a: string, b: string): number {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) if (la[i] !== lb[i]) return i + 1;
  return 0;
}
