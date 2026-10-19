// 助手说的话按 Markdown 排（#3277）：只认会话里常见的几样——段落、标题、无序和有序列表、引用、代码块、行内代码、加粗、链接。
// 自己写的小解析，不加依赖；认不出的照原文当段落。段落里的单个换行保留（中文回答常一行一句）。

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'link'; text: string; href: string };

export type MdBlock =
  | { kind: 'para'; lines: Inline[][] }
  | { kind: 'heading'; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { kind: 'quote'; lines: Inline[][] }
  | { kind: 'code'; lang: string; text: string };

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

/** 行内：`代码`、**加粗**、[字](http…)。代码里面不再认别的。 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ kind: 'text', text: text.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'bold', text: m[2] });
    else out.push({ kind: 'link', text: m[3] ?? '', href: m[4] ?? '' });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let i = 0;
  const isBreak = (l: string) =>
    l.trim() === '' || FENCE.test(l) || HEADING.test(l) || BULLET.test(l) || ORDERED.test(l) || QUOTE.test(l);
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i] as string)) {
        body.push(lines[i] as string);
        i++;
      }
      i++; // 收尾的围栏；没收尾就是到末尾
      out.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: 'heading', inline: parseInline(heading[1] ?? '') });
      i++;
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const start = ordered ? Number(ORDERED.exec(line)?.[1] ?? 1) : 1;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const l = lines[i] as string;
        const m = ordered ? ORDERED.exec(l) : BULLET.exec(l);
        if (m) {
          items.push(parseInline((ordered ? m[2] : m[1]) ?? ''));
          i++;
        } else if (l.trim() !== '' && /^\s{2,}/.test(l) && items.length) {
          // 缩进的续行接在上一项后面
          items[items.length - 1]?.push({ kind: 'text', text: ` ${l.trim()}` });
          i++;
        } else break;
      }
      out.push({ kind: 'list', ordered, start, items });
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: Inline[][] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        quoted.push(parseInline(QUOTE.exec(lines[i] as string)?.[1] ?? ''));
        i++;
      }
      out.push({ kind: 'quote', lines: quoted });
      continue;
    }
    const para: Inline[][] = [];
    while (i < lines.length && !(para.length && isBreak(lines[i] as string))) {
      para.push(parseInline(lines[i] as string));
      i++;
    }
    out.push({ kind: 'para', lines: para });
  }
  return out;
}
