// PR 正文里的各栏怎么认（模板 .github/pull_request_template.md 的「**栏名**：值」）。合并闸认 PR 挂了哪张单（「需求」栏，
// 其次标题）定要不要看「认领对得上」（#348）；引擎认 PR 上写的认领号（「认领」栏）、pr-labels 照抄标签、必填栏提醒
// （pr-fields.ts）、每天的关单对账都用这一份，认法只有一处。
// 改这里之前必须知道：认没认出挂了单会改合并闸的结论（没认出就不查认领），所以这份在先审后合的清单里；它只许引用同样在
// 清单里的文件（merge-gates.test.ts 顺着导入走一遍钉着）。

import { CLOSE_COLUMN } from './close-rule.ts';
import { TIER_COLUMN } from './merge-gates.ts';

export const PLAN_COLUMN = '对应计划';
export const SPECS_COLUMN = 'specs';
/** 正文里写对应 issue 的那一栏。 */
export const ISSUE_COLUMN = '需求';
/** 正文里写认领号的那一栏（#348）：本机认领的单写 claim.mjs take 打印的认领号，引擎开的写「引擎」。 */
export const CLAIM_COLUMN = '认领';

/** PR 模板的各栏，顺序同模板；测试里对着模板查，两边对不上就红。 */
export const PR_COLUMNS = [
  '做了什么',
  '怎么验证的',
  '还欠什么',
  '按推荐先做了',
  ISSUE_COLUMN,
  CLAIM_COLUMN,
  '修提醒',
  CLOSE_COLUMN,
  PLAN_COLUMN,
  SPECS_COLUMN,
  TIER_COLUMN,
  '文档',
] as const;
const KNOWN = new Set<string>(PR_COLUMNS.map((c) => c.toLowerCase()));

/** 「**对应计划**：」「**对应计划：**」：加粗的，冒号在里在外都算一栏的开头。 */
const BOLD_COLUMN = /^\s*(?:[-*+]\s+)?\*\*\s*([^*：:\n]+?)\s*(?:\*\*\s*[：:]|[：:]\s*\*\*)\s*(.*)$/;
/** 「对应计划：」：不加粗的只认模板里有的栏名，免得把正文里带冒号的一句话当成新的一栏。 */
const PLAIN_COLUMN = /^\s*(?:[-*+]\s+)?([^\s*：:][^*：:\n]*?)\s*[：:]\s*(.*)$/;
/** 小标题是正文分节，上一栏到这里为止：栏写在正文开头时，不截的话后面各节里提到的 specs 路径会被当成这一栏来查。 */
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
 * PR 对应的 issue 号：先看正文「需求」栏里第一个 #号，没有再看标题里第一处紧挨左括号的 #号
 * （全角括号也算；#号后面可以有别的字，比如「（#345，说明） (#392)」认 345，不认末尾这个 PR 自己的号）。
 * 「（见 #12）」这种 # 号不挨着左括号的、不带括号的 #号、「owner/仓#号」这种别的仓的，都不算。都没有返回 undefined。
 */
export function linkedIssue(body: string, title: string): number | undefined {
  const col = prColumns(body).get(ISSUE_COLUMN.toLowerCase());
  const fromBody = col && /(?<![\w/#])#(\d+)\b/.exec(col)?.[1];
  if (fromBody) return Number(fromBody);
  const fromTitle = /[(（]\s*#(\d+)\b/.exec(title)?.[1];
  return fromTitle ? Number(fromTitle) : undefined;
}

const CLAIM_ID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/i;

/** PR 正文「认领」栏写的认领号（整串，小写）：没有这一栏、栏里没有整串的认领号（只写前 8 位的不算）是 undefined。 */
export function prClaimId(body: string): string | undefined {
  const col = prColumns(body).get(CLAIM_COLUMN.toLowerCase());
  const m = col === undefined ? null : CLAIM_ID.exec(col);
  return m ? m[0].toLowerCase() : undefined;
}
