// PR 正文里的各栏怎么认（模板 .github/pull_request_template.md 的「**栏名**：值」）。PR 挂了哪张单（「需求」栏，其次
// 标题）给 PR 镜像挂单用；引擎认 PR 上写的认领号（「认领」栏）、必填栏
// 提醒（pr-fields.ts）、每天的关单对账都用这一份，认法只有一处。
// 改这里之前必须知道：#444 起合并闸不再靠这份判「挂没挂单」（认领对得上不再是判红的输入），这份文件已经不在先审后合的
// 清单里；ENGINE_BOT_LOGIN、CLAIM_MATCH_CONTEXT 两个常量从 merge-gates.ts 搬过来放这——认领这套东西（引擎照样贴状态、
// 帅位照样认领）还在用它们，和 linkedIssue、prClaimId 放一处更合适。

import { CLOSE_COLUMN } from './close-rule.ts';
import { TIER_COLUMN } from './merge-gates.ts';

export const PLAN_COLUMN = '对应计划';
export const SPECS_COLUMN = 'specs';
/** 正文里写对应 issue 的那一栏。 */
export const ISSUE_COLUMN = '需求';
/** 正文里写认领号的那一栏（#348）：引擎开的单写「引擎」；本机认领脚本 2026-10-02 删了（#446），本机开的写「无」。 */
export const CLAIM_COLUMN = '认领';
/**
 * 引擎机器人按库里的认领贴在 PR 当前头上的提交状态（#299、#348；#444 起合并闸不再等它，只是还在贴）；和 @fleet-dao/core
 * seat.ts 的 CLAIM_STATUS_CONTEXT 是同一个（这个包不依赖 core，后端的测试对着两边）。
 */
export const CLAIM_MATCH_CONTEXT = '认领对得上';
/**
 * 只认这个机器人贴的「认领对得上」：「引擎」GitHub App（fleet-dao-engine）的机器人账号。带 [bot] 的名字只有 App 自己有，
 * 别人注册不了；有推送权限的人（本机的 gh 登的是创始人账号）也贴得出同名的状态，所以要看是谁贴的。
 */
export const ENGINE_BOT_LOGIN = 'fleet-dao-engine[bot]';

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
 * 「需求」栏里第一个 #号（不看标题）：pr-fields.ts 提醒「这个 PR 做完就关单」该补哪个 Closes、
 * 关单对账认合并了的 PR 挂的是哪张单，都从这来（#460）；linkedIssue 在这基础上加了标题兜底。
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

const CLAIM_ID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/i;

/** PR 正文「认领」栏写的认领号（整串，小写）：没有这一栏、栏里没有整串的认领号（只写前 8 位的不算）是 undefined。 */
export function prClaimId(body: string): string | undefined {
  const col = prColumns(body).get(CLAIM_COLUMN.toLowerCase());
  const m = col === undefined ? null : CLAIM_ID.exec(col);
  return m ? m[0].toLowerCase() : undefined;
}
