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
  /** 这一栏占的行：从栏名那行起，到下一栏（或小标题、正文结尾）前一行止（行号从 0 数，end 不含）。 */
  start: number;
  end: number;
}

/** prColumns 和 withIssueColumn 共用的切法：栏的先后、同名的都照出现的顺序全列出来。 */
function columnSpans(body: string): ColumnSpan[] {
  const spans: ColumnSpan[] = [];
  let current: { name: string; start: number } | undefined;
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
      current = { name: m[1].trim().toLowerCase(), start: i };
      buf = [m[2] ?? ''];
    } else if (current !== undefined) {
      buf.push(line);
    }
  });
  flush(lines.length);
  return spans;
}

/**
 * 把「需求」栏整栏换成「**需求**：<value>」（没有这一栏就加在正文末尾）。`pnpm pr:open --no-issue "<理由>"` 把理由
 * 原样写进需求栏用；栏里原来的字（含模板提示）都被换掉，别的栏不动——只有「需求」栏下面另起一行的 GATE_LINE（人闸：改标准）留着。
 */
export function withIssueColumn(body: string, value: string): string {
  const line = `**${ISSUE_COLUMN}**：${value}`;
  const text = body.replace(/\r\n?/g, '\n');
  const span = columnSpans(text).find((s) => s.name === ISSUE_COLUMN.toLowerCase());
  if (!span) return `${text.trimEnd()}\n\n${line}\n`;
  const lines = text.split('\n');
  let end = span.end;
  while (end > span.start + 1 && !lines[end - 1]?.trim()) end--; // 栏后面隔开下一栏的空行留着
  const gate = lines.slice(span.start + 1, end).filter((l) => l.trim() === GATE_LINE);
  lines.splice(span.start, end - span.start, line, ...gate);
  return lines.join('\n');
}

/** 改标准的 PR 在「需求」栏下面另起一行写这个（人闸第四类）；没有程序读它，给创始人和接手的人看。 */
export const GATE_LINE = '人闸：改标准';

/** 不是任何真仓的名字：拿它当 closingIssues 的 repo，写明是别的仓的（owner/仓#号）都被挡掉，只剩没写仓名的。 */
const THIS_REPO = '(本仓)';
/** 「Refs #12」「refs: #12」：只挂不关的写法（母单分片）；owner/仓#号 不算（# 前面只许空白）。 */
const REFS = /(?<![\w/])refs?(?:\s*:\s*|\s+)#(\d+)\b/gi;

/**
 * 「需求」栏里写明挂的单（同仓的，从小到大）：closes 是 GitHub 合并时会关的（认法同 closing-issues.ts，Closes/Fixes/Resolves），
 * refs 是只挂不关的（Refs #号）。栏里只写「#12」、「无」、只留着模板提示都读不到：开 PR 那一步（pr-open.ts）据此拒开。
 */
export function issueColumnRefs(body: string): { closes: number[]; refs: number[] } {
  const col = prColumns(body).get(ISSUE_COLUMN.toLowerCase()) ?? '';
  const refs = new Set<number>();
  for (const m of col.matchAll(REFS)) refs.add(Number(m[1]));
  return { closes: closingIssues(col, THIS_REPO), refs: [...refs].sort((a, b) => a - b) };
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
