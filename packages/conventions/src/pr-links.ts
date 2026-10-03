// PR 正文挂的单和修的提醒（design 15.3「谁在处理」）：PR 镜像记下来（@fleet-dao/github 的 events.ts，PR 事件和对账补收
// 走同一处），驾驶舱、看板、`alert show` 据此现算「PR 开着 / 合进主线 / 法国已发布」（提醒派单已经删掉，#445）。
// 挂的单 = 「需求」栏（没有再看标题）的 #号（认法只有一处，pr-columns.ts 的 linkedIssue）——
// 加上 GitHub 合并时会关的关单词（closing-issues.ts 的 closingIssues），只算同仓的。
// 修的提醒 = 「修提醒」栏（模板注释里讲的、有这个情况才多写一行的栏），写提醒的键或编号。
import { closingIssues } from './closing-issues.ts';
import { linkedIssue, prColumns } from './pr-columns.ts';

/** PR 模板里写这个 PR 修哪几条提醒的那一栏。 */
export const FIX_ALERT_COLUMN = '修提醒';

/** 提醒的键不带空白、300 字以内（和静默对得上的键同一个写法）。 */
const MAX_KEY = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * 像提醒的：键都是「种类:…」（watchdog:job:…、pool-hold:…、req:…#293:park:1），或者是提醒的编号。栏里顺手写的话、
 * 紧跟在后面的 Closes #号（这一栏到下一栏为止都算它的字）都不像，不当成提醒。
 */
const looksLikeAlert = (token: string) =>
  token.length <= MAX_KEY && (UUID.test(token) || /^[A-Za-z][\w.-]*:\S+$/.test(token));

/** 「修提醒」栏写的提醒（键或编号，去重、保持写的顺序）。空白、逗号、顿号、分号隔开都认；反引号、引号、句末标点去掉。 */
export function fixAlertRefs(body: string): string[] {
  const col = prColumns(body).get(FIX_ALERT_COLUMN);
  if (!col) return [];
  const out = new Set<string>();
  for (const raw of col.split(/[\s,，、;；]+/)) {
    const token = raw.replace(/^[`'"“「『（(]+/, '').replace(/[`'"”」』）)。．.！!？?]+$/, '');
    if (token && looksLikeAlert(token)) out.add(token);
  }
  return [...out];
}

/**
 * PR 正文、标题挂的单（同仓的，从小到大）和修的提醒。repo 是这个 PR 所在的仓（owner/仓名）：写明是别的仓的关单词不算。
 */
export function prLinks(
  pr: { body: string | null; title: string },
  repo: string,
): {
  issues: number[];
  alerts: string[];
} {
  const body = pr.body ?? '';
  const issues = new Set(closingIssues(body, repo));
  const linked = linkedIssue(body, pr.title);
  if (linked !== undefined) issues.add(linked);
  return { issues: [...issues].sort((a, b) => a - b), alerts: fixAlertRefs(body) };
}
