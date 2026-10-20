// PR 正文里的各栏怎么认（模板 .github/pull_request_template.md 的「**栏名**：值」）。PR 挂了哪张单（「需求」栏，其次
// 标题）给 PR 镜像挂单、每天的关单对账用；认法只有一处。
// 改这里之前必须知道：模板只有两栏（#654 删到四栏，#1066 再删到两栏），但读 PR 正文时旧模板的栏名（LEGACY_COLUMNS）照样认——
// 合并了的旧 PR 正文里还有它们，不认的话「修提醒」「需求」这些栏的值会把后面紧跟着的旧栏一起吞进去。
import { closingIssues } from './closing-issues.ts';

/** 正文里写对应 issue 的那一栏。 */
export const ISSUE_COLUMN = '需求';

/** PR 模板里的栏，顺序同模板；测试里对着模板查，两边对不上就红。 */
export const PR_COLUMNS = ['做了什么', ISSUE_COLUMN] as const;

/** 有这种情况才多写一行的栏（模板的注释里讲了，不在模板正文里）：按推荐先做了的岔路（#259）、这个 PR 修的提醒。 */
export const OPTIONAL_COLUMNS = ['按推荐先做了', '修提醒'] as const;

/** 旧模板（#1066 前的「怎么验证的」「还欠什么」，#654 前的其余）的栏：只为读旧 PR 的正文时认得出栏的边界，新 PR 不写。 */
export const LEGACY_COLUMNS = [
  '怎么验证的',
  '还欠什么',
  '认领',
  '这个 PR 做完就关单',
  '对应计划',
  'specs',
  '档位',
  '文档',
] as const;

const KNOWN = new Set<string>(
  [...PR_COLUMNS, ...OPTIONAL_COLUMNS, ...LEGACY_COLUMNS].map((c) => c.toLowerCase()),
);

/** 「**对应计划**：」「**对应计划：**」：加粗的，冒号在里在外都算一栏的开头。 */
const BOLD_COLUMN = /^\s*(?:[-*+]\s+)?\*\*\s*([^*：:\n]+?)\s*(?:\*\*\s*[：:]|[：:]\s*\*\*)\s*(.*)$/;
/** 「对应计划：」：不加粗的只认模板里有的栏名，免得把正文里带冒号的一句话当成新的一栏。 */
const PLAIN_COLUMN = /^\s*(?:[-*+]\s+)?([^\s*：:][^*：:\n]*?)\s*[：:]\s*(.*)$/;
/** 小标题是正文分节，上一栏到这里为止：栏写在正文开头时，不截的话后面各节里提到的路径会被当成这一栏来查。 */
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;

/** HTML 注释去掉、换行留着（和 markdown.ts 的 stripComments 同一个写法，不引它）。 */
const stripComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));

/**
 * 正文里的各栏：从一栏的开头起，到下一栏为止；栏名不分大小写。
 * HTML 注释（模板里的提示）先去掉：只留着模板提示没填，这一栏就是空的。
 */
export function prColumns(body: string): Map<string, string> {
  const cols = new Map<string, string>();
  for (const s of columnSpans(body)) if (!cols.has(s.name)) cols.set(s.name, s.value);
  return cols;
}

interface ColumnSpan {
  name: string;
  value: string;
  /** 栏名那行冒号后面的字原样留着（`**需求**：创始人原话：「同意」` 的「创始人原话：「同意」」），withIssueColumn 用。 */
  head: string;
  /** 这一栏占的行：从栏名那行起，到下一栏（或小标题、正文结尾）前一行止（行号从 0 数，end 不含）。 */
  start: number;
  end: number;
}

/** prColumns 和 withIssueColumn 共用的切法：栏的先后、同名的都照出现的顺序全列出来。 */
function columnSpans(body: string): ColumnSpan[] {
  const spans: ColumnSpan[] = [];
  let current: { name: string; start: number; head: string } | undefined;
  let buf: string[] = [];
  const flush = (end: number) => {
    if (current) spans.push({ ...current, value: buf.join('\n').trim(), end });
  };
  const lines = stripComments(body.replace(/\r\n?/g, '\n')).split('\n');
  lines.forEach((line, i) => {
    if (HEADING.test(line)) {
      flush(i);
      current = undefined;
      buf = [];
      return;
    }
    const bold = BOLD_COLUMN.exec(line);
    const plain = bold ? null : PLAIN_COLUMN.exec(line);
    const m = bold ?? (plain?.[1] && KNOWN.has(plain[1].toLowerCase()) ? plain : null);
    if (m?.[1] !== undefined) {
      flush(i);
      current = { name: m[1].trim().toLowerCase(), start: i, head: (m[2] ?? '').trim() };
      buf = [m[2] ?? ''];
    } else if (current !== undefined) {
      buf.push(line);
    }
  });
  flush(lines.length);
  return spans;
}

/**
 * `pnpm pr:open --no-issue "<理由>"` 把理由写进「需求」栏：栏名那行换成「**需求**：<value>」，栏里原有的字
 * （栏名那行冒号后面的原话、下面各行的原话段和说明、GATE_LINE「人闸：改标准」）按原顺序留在它下面——改标准的 PR
 * 靠原话证明创始人同意过，吞了就像没同意（#1890）。模板提示（HTML 注释）不算内容，丢掉；没有这一栏就整栏加在
 * 正文末尾，别的栏不动。
 */
export function withIssueColumn(body: string, value: string): string {
  const line = `**${ISSUE_COLUMN}**：${value}`;
  const text = body.replace(/\r\n?/g, '\n');
  const span = columnSpans(text).find((s) => s.name === ISSUE_COLUMN.toLowerCase());
  if (!span) return `${text.trimEnd()}\n\n${line}\n`;
  const lines = text.split('\n');
  let end = span.end;
  while (end > span.start + 1 && !lines[end - 1]?.trim()) end--; // 栏后面隔开下一栏的空行留着
  // 栏里原有的字留着：栏名那行冒号后面的字另起一行（`**需求**：创始人原话：「同意」` 里那段原话不算丢），
  // 下面各行照旧；空行也留（段与段之间靠它隔着），只有整行都是模板提示（HTML 注释）的不算内容
  const head = stripComments(span.head).trim();
  const kept = [
    ...(head ? [head] : []),
    ...lines.slice(span.start + 1, end).filter((l) => !l.trim() || stripComments(l).trim()),
  ];
  while (kept[0] !== undefined && !kept[0].trim()) kept.shift();
  while (kept.length > 0 && !kept[kept.length - 1]?.trim()) kept.pop();
  lines.splice(span.start, end - span.start, line, ...kept);
  return lines.join('\n');
}

/** 改标准的 PR 在「需求」栏下面另起一行写这个（人闸第四类）；没有程序读它，给创始人和接手的人看。 */
export const GATE_LINE = '人闸：改标准';

/** 创始人同意改标准的那一段：pnpm pr:open --founder-quote 写进正文的样子就是它（pr-compose.ts 两处都用它拼）。 */
export function founderQuoteLine(quote: string, at: string): string {
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  return `**创始人原话**：「${oneLine(quote)}」（${oneLine(at)}）`;
}

/**
 * 「创始人原话」那一行：栏名可加粗、可跟在别的栏名后面（「**需求**：创始人原话（时间）：「…」」）；时间写在原话后面
 * （founderQuoteLine 写的）或栏名后面（手写的「创始人原话（时间）：「…」」）都认。原话在「」里，一直到行尾。
 */
const FOUNDER_QUOTE =
  /创始人原话\s*(?:[（(]([^（）()\n]*)[)）])?\s*(?:\*\*)?\s*[：:]\s*(?:\*\*)?\s*「(.*)」\s*(?:[（(]([^（）()\n]*)[)）])?\s*$/;

/**
 * 正文里创始人同意改标准的记录：认 founderQuoteLine 写出来的那一行（手写的、时间放在栏名后面的也认）；
 * 原话、时间都非空才算，读不到返回 undefined。开 PR 那一步（pr-open.ts 的 --founder-approved）和合并闸（merge-gate.ts）
 * 都用它判，两边的判据只有这一处。HTML 注释（模板提示）不算。
 */
export function founderQuote(body: string): { quote: string; at: string } | undefined {
  for (const line of stripComments(body.replace(/\r\n?/g, '\n')).split('\n')) {
    const m = FOUNDER_QUOTE.exec(line);
    if (!m) continue;
    const quote = (m[2] ?? '').trim();
    const at = (m[3] ?? m[1] ?? '').trim();
    if (quote && at) return { quote, at };
  }
  return undefined;
}

/** 不是任何真仓的名字：拿它当 closingIssues 的 repo，写明是别的仓的（owner/仓#号）都被挡掉，只剩没写仓名的。 */
const THIS_REPO = '(本仓)';
/** 「Refs #12」「refs: #12」关联单号；同一行须标明分片才不自动关单。owner/仓#号 不算。 */
const REFS = /(?<![\w/])refs?(?:\s*:\s*|\s+)#(\d+)\b/gi;

/**
 * 「需求」栏里写明挂的单（同仓的，从小到大）：closes 是 GitHub 合并时会关的（认法同 closing-issues.ts，Closes/Fixes/Resolves），
 * refs 是关联的（Refs #号），是否分片由 issueColumnLinks 的同行说明决定。栏里只写「#12」、「无」、只留模板提示都读不到。
 */
export function issueColumnRefs(body: string): { closes: number[]; refs: number[] } {
  const col = prColumns(body).get(ISSUE_COLUMN.toLowerCase()) ?? '';
  const refs = new Set<number>();
  for (const m of col.matchAll(REFS)) refs.add(Number(m[1]));
  return { closes: closingIssues(col, THIS_REPO), refs: [...refs].sort((a, b) => a - b) };
}

/** 一行里写了「分片、关不了它」这类话：Refs 在这一行是有意只挂不关（母单的一片），不当成做完了。 */
const SLICE_WORDS = /分片|关不了|不关单|没做完|未做完/;

/** 新 PR 的每个 Refs 必须在同一行明确分片；跨行关联直接拒绝。旧正文读取不受此约束。 */
export function unmarkedIssueRefs(body: string): number[] {
  const col = prColumns(body).get(ISSUE_COLUMN.toLowerCase()) ?? '';
  const found = new Set<number>();
  for (const m of col.matchAll(REFS)) {
    const start = col.lastIndexOf('\n', m.index - 1) + 1;
    const end = col.indexOf('\n', m.index);
    const line = col.slice(start, end === -1 ? col.length : end);
    if (/[\r\n]/.test(m[0]) || !SLICE_WORDS.test(line)) found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/** 「需求」栏里挂的一张单：怎么挂的（Closes 或 Refs），那一行有没有写明「分片、关不了」。 */
export interface IssueColumnLink {
  number: number;
  kind: 'closes' | 'refs';
  /** 写明是分片：合并时收口、每日对账都不把它当成「做完了」（#995 拍 1）。 */
  slice: boolean;
}

/**
 * 「需求」栏里逐行读出挂的单（同仓的，从小到大，同一张单 Closes 压过 Refs）。和 issueColumnRefs 认法相同，多给一样：
 * 那一行有没有写「分片、关不了它」之类的话。合并时自动收口（close-on-merge.ts）和每日对账（github-audit.ts）靠它分开
 * 「做完了没人关」和「有意只挂不关」。
 */
export function issueColumnLinks(body: string): IssueColumnLink[] {
  const col = prColumns(body).get(ISSUE_COLUMN.toLowerCase()) ?? '';
  const found = new Map<number, IssueColumnLink>();
  for (const line of col.split('\n')) {
    const slice = SLICE_WORDS.test(line);
    for (const number of closingIssues(line, THIS_REPO)) {
      found.set(number, { number, kind: 'closes', slice });
    }
    for (const m of line.matchAll(REFS)) {
      const number = Number(m[1]);
      if (!found.has(number)) found.set(number, { number, kind: 'refs', slice });
    }
  }
  return [...found.values()].sort((a, b) => a.number - b.number);
}

/**
 * 「需求」栏里第一个 #号（不看标题）：关单对账认合并了的 PR 挂的是哪张单，都从这来（#460）；
 * linkedIssue 在这基础上加了标题兜底。
 */
export function issueColumnNumber(body: string): number | undefined {
  const col = prColumns(body).get(ISSUE_COLUMN.toLowerCase());
  const m = col && /(?<![\w/#])#(\d+)\b/.exec(col)?.[1];
  return m ? Number(m) : undefined;
}

/**
 * PR 对应的 issue 号：先看正文「需求」栏里第一个 #号，没有再看标题里第一个 (#号)（全角括号也算）。
 * 「owner/仓#号」这种别的仓的不算。都没有返回 undefined。
 */
export function linkedIssue(body: string, title: string): number | undefined {
  const fromBody = issueColumnNumber(body);
  if (fromBody !== undefined) return fromBody;
  const fromTitle = /[(（]\s*#(\d+)\s*[)）]/.exec(title)?.[1];
  return fromTitle ? Number(fromTitle) : undefined;
}
