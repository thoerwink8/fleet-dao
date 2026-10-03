// PR 正文里的各栏怎么认（模板 .github/pull_request_template.md 的「**栏名**：值」）。PR 挂了哪张单（「需求」栏，其次
// 标题）给 PR 镜像挂单、每天的关单对账用；认法只有一处。
// 改这里之前必须知道：模板只有四栏（#654），但读 PR 正文时旧模板的栏名（LEGACY_COLUMNS）照样认——合并了的旧 PR 正文里还有
// 它们，不认的话「修提醒」「需求」这些栏的值会把后面紧跟着的旧栏一起吞进去。

/** 正文里写对应 issue 的那一栏。 */
export const ISSUE_COLUMN = '需求';

/** PR 模板里的栏，顺序同模板；测试里对着模板查，两边对不上就红。 */
export const PR_COLUMNS = ['做了什么', '怎么验证的', '还欠什么', ISSUE_COLUMN] as const;

/** 有这种情况才多写一行的栏（模板的注释里讲了，不在模板正文里）：按推荐先做了的岔路（#259）、这个 PR 修的提醒。 */
export const OPTIONAL_COLUMNS = ['按推荐先做了', '修提醒'] as const;

/** 旧模板（#654 前）的栏：只为读旧 PR 的正文时认得出栏的边界，新 PR 不写。 */
export const LEGACY_COLUMNS = ['认领', '这个 PR 做完就关单', '对应计划', 'specs', '档位', '文档'] as const;

const KNOWN = new Set<string>(
  [...PR_COLUMNS, ...OPTIONAL_COLUMNS, ...LEGACY_COLUMNS].map((c) => c.toLowerCase()),
);

/** 「**对应计划**：」「**对应计划：**」：加粗的，冒号在里在外都算一栏的开头。 */
const BOLD_COLUMN = /^\s*(?:[-*+]\s+)?\*\*\s*([^*：:\n]+?)\s*(?:\*\*\s*[：:]|[：:]\s*\*\*)\s*(.*)$/;
/** 「对应计划：」：不加粗的只认模板里有的栏名，免得把正文里带冒号的一句话当成新的一栏。 */
const PLAIN_COLUMN = /^\s*(?:[-*+]\s+)?([^\s*：:][^*：:\n]*?)\s*[：:]\s*(.*)$/;
/** 小标题是正文分节，上一栏到这里为止：栏写在正文开头时，不截的话后面各节里提到的路径会被当成这一栏来查。 */
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;

/** HTML 注释去掉、换行留着（和 markdown.ts 的 stripComments 同一个写法；不引它：它不在先审后合的清单里）。 */
const stripComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));

/**
 * 正文里的各栏：从一栏的开头起，到下一栏为止；栏名不分大小写。
 * HTML 注释（模板里的提示）先去掉：只留着模板提示没填，这一栏就是空的。
 */
export function prColumns(body: string): Map<string, string> {
  const cols = new Map<string, string>();
  let current: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (current !== undefined && !cols.has(current)) cols.set(current, buf.join('\n').trim());
  };
  for (const line of stripComments(body.replace(/\r\n?/g, '\n')).split('\n')) {
    if (HEADING.test(line)) {
      flush();
      current = undefined;
      buf = [];
      continue;
    }
    const bold = BOLD_COLUMN.exec(line);
    const plain = bold ? null : PLAIN_COLUMN.exec(line);
    const m = bold ?? (plain?.[1] && KNOWN.has(plain[1].toLowerCase()) ? plain : null);
    if (m?.[1] !== undefined) {
      flush();
      current = m[1].trim().toLowerCase();
      buf = [m[2] ?? ''];
    } else if (current !== undefined) {
      buf.push(line);
    }
  }
  flush();
  return cols;
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
