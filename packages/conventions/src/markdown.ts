// 读本仓 Markdown 文档的几样小工具：标题与各节、围栏代码块、HTML 注释、「」引号（里面可以再套「」）、中文序数。
// 只认本仓文档在用的写法，不是通用的 Markdown 解析器。

export interface Heading {
  /** 第几行（从 1 数）。 */
  line: number;
  /** 几个 #。 */
  level: number;
  /** # 后面的整段字。 */
  text: string;
  /** 去掉编号以后的标题：「十一、备份与恢复」→「备份与恢复」，「15.4 飞书（已定）」→「飞书（已定）」。 */
  title: string;
  /** 「## 十一、…」的 11。 */
  chapter: number | undefined;
  /** 「### 15.4 …」的 "15.4"。 */
  sub: string | undefined;
  /** plan.md「### P0 …」的 0。 */
  phase: number | undefined;
}

export interface MdDoc {
  path: string;
  /** 各行；HTML 注释已经去掉（注释占的行留成空行，行号不变）。 */
  lines: string[];
  /** 这一行在围栏代码块里（围栏那两行也算）。 */
  fenced: boolean[];
  headings: Heading[];
}

/** 去掉 HTML 注释：注释里是模板提示和占位，不算正文。换行照留，行号不变。 */
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
}

export function parseMd(path: string, text: string): MdDoc {
  const lines = stripComments(text.replace(/\r\n?/g, '\n')).split('\n');
  const fenced: boolean[] = [];
  const headings: Heading[] = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced.push(true);
      inFence = !inFence;
      return;
    }
    fenced.push(inFence);
    const m = inFence ? null : /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (m?.[1] && m[2] !== undefined) headings.push(heading(i + 1, m[1].length, m[2]));
  });
  return { path, lines, fenced, headings };
}

function heading(line: number, level: number, text: string): Heading {
  const chapter = /^([一二三四五六七八九十百零两]+)、\s*(.*)$/.exec(text);
  if (chapter?.[1]) {
    return {
      line,
      level,
      text,
      title: chapter[2] ?? '',
      chapter: cnNumber(chapter[1]),
      sub: undefined,
      phase: undefined,
    };
  }
  const sub = /^(\d+\.\d+)\s+(.*)$/.exec(text);
  if (sub?.[1])
    return { line, level, text, title: sub[2] ?? '', chapter: undefined, sub: sub[1], phase: undefined };
  const phase = /^P(\d+)\s/.exec(text);
  return {
    line,
    level,
    text,
    title: text,
    chapter: undefined,
    sub: undefined,
    phase: phase?.[1] ? Number(phase[1]) : undefined,
  };
}

/** 一个标题管的那几行（0 起的下标，含标题行）：到下一个同级或更高级的标题为止。 */
export function sectionRange(doc: MdDoc, h: Heading): { start: number; end: number } {
  const next = doc.headings.find((o) => o.line > h.line && o.level <= h.level);
  return { start: h.line - 1, end: next ? next.line - 1 : doc.lines.length };
}

/** 比较用的写法：去掉加粗、反引号、链接的网址，空白压成一个。 */
export function norm(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去掉末尾的一段括号说明：「发布应用（deploy/release.sh）」→「发布应用」。 */
export function stripTrailingParen(s: string): string {
  return s.replace(/\s*(（[^（）]*）|\([^()]*\))\s*$/, '');
}

/** 一个标题能被叫出来的几种写法（带不带编号、带不带末尾括号）。 */
export function headingKeys(h: Heading): string[] {
  const keys = [h.text, h.title].map(norm);
  return [...new Set([...keys, ...keys.map(stripTrailingParen)])].filter(Boolean);
}

/**
 * 从 s[i] 的「读到配对的」为止（里面可以再套「」）。
 * 返回引号里的字和右引号后面的下标；s[i] 不是「或者没配上对，返回 undefined。
 */
export function readQuote(s: string, i: number): { text: string; end: number } | undefined {
  if (s[i] !== '「') return undefined;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '「') depth++;
    else if (s[j] === '」' && --depth === 0) return { text: s.slice(i + 1, j), end: j + 1 };
  }
  return undefined;
}

const DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 「十四」→ 14、「二十」→ 20、「3」→ 3；认不出返回 undefined。只管到九十九，文档的节没那么多。 */
export function cnNumber(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1 && s in DIGITS) return DIGITS[s];
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (!m) return undefined;
  return (m[1] ? (DIGITS[m[1]] ?? 0) : 1) * 10 + (m[2] ? (DIGITS[m[2]] ?? 0) : 0);
}
