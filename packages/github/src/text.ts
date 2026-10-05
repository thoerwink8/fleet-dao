// 引擎往 GitHub 写的文字：PR 正文模板、GitHub 关单词的中和、正文长度上限。
import { GitHubError } from './errors.ts';

/** GitHub 对 issue / PR 正文、评论的上限（字符）。超了发出前就拒，报实际字数（B3）。 */
export const BODY_LIMIT = 65536;

export function assertBodySize(what: string, body: string): void {
  const n = [...body].length;
  if (n > BODY_LIMIT) {
    throw new GitHubError('BODY_TOO_LONG', `${what}有 ${n} 个字符，超过 GitHub 的上限 ${BODY_LIMIT}`, {
      details: { length: n, limit: BODY_LIMIT },
    });
  }
}

// —— 关单词：PR 正文或合并提交里写「Closes #12」，合并那一刻 GitHub 自己就把需求单关了，绕过引擎的关单（C13）。——

const KEYWORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
const REF = String.raw`(?:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+)?#\d+|GH-\d+|https?:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/issues\/\d+`;
const CLOSING = new RegExp(String.raw`\b(${KEYWORD})(\s*:\s*|\s+)(${REF})`, 'gi');

export function hasCloseKeywords(text: string): boolean {
  CLOSING.lastIndex = 0;
  return CLOSING.test(text);
}

/** 「Closes #12」→「关联 #12」：引用留着（GitHub 照样互相链接），关单的语义去掉。 */
export function neutralizeCloseKeywords(text: string): string {
  return text.replace(CLOSING, (_m, _kw, _sep, ref: string) => `关联 ${ref}`);
}

// —— PR 正文：栏目以仓根 .github/pull_request_template.md 为准。人开的 PR 由 GitHub 套那份模板，引擎开的走这里；
// 模板的栏这里都得有、顺序一样，test/text.test.ts 盯着。模板只有两栏（#1066）：做了什么、需求；引擎另外多写「怎么验证的」
// 「还欠什么」两栏（它交的验证证据，core 的 verificationLines 生成，人开的 PR 不写）；有「按推荐先做了」「修提醒」这两种情况
// 才多写一行。整篇 14 行以内（设计 §7）。——

export interface PrBodyInput {
  /** 对应的需求（issue 号）。 */
  requirement?: number | undefined;
  /** 子任务名，例如「A 登录表单」。 */
  subtask?: string | undefined;
  /** 做了什么，3–5 条。 */
  did: readonly string[];
  /** 怎么验证的（测试命令、结果链接）。 */
  verified: readonly string[];
  /** 还欠什么；空 = 无。 */
  owed?: readonly string[] | undefined;
  /** 有什么风险。模板没有这一栏：并进「还欠什么」，每条前面标「风险：」。 */
  risks?: readonly string[] | undefined;
  /** 「按推荐先做了」：问创始人的岔路里没等他回、按推荐先做了的（#259）；空 = 不写这一栏。 */
  assumed?: readonly string[] | undefined;
  /** 「修提醒」：这个 PR 修的是哪几条提醒（键），驾驶舱据此显示修到哪（design 15.3「谁在处理」）；空 = 不写这一栏。 */
  fixesAlerts?: readonly string[] | undefined;
}

export const PR_BODY_MAX_LINES = 14;

export function renderPrBody(input: PrBodyInput): string {
  const lists: [string, readonly string[]][] = [
    ['做了什么', input.did.length ? input.did : ['（没写）']],
    ['怎么验证的', input.verified.length ? input.verified : ['（没写）']],
    ['还欠什么', [...(input.owed ?? []), ...(input.risks ?? []).map((r) => `风险：${r}`)]],
  ];
  // 有才写：没有按推荐先做的岔路，就不占这一栏
  if ((input.assumed ?? []).length > 0) lists.push(['按推荐先做了', input.assumed ?? []]);
  const requirement =
    [
      input.requirement === undefined ? '' : `#${input.requirement}`,
      input.subtask ? `子任务 ${oneLine(input.subtask)}` : '',
    ]
      .filter(Boolean)
      .join(' · ') || '无';
  const alerts = (input.fixesAlerts ?? []).map(oneLine).filter(Boolean).join(' ');
  const tail = [`**需求**：${requirement}`, ...(alerts ? [`**修提醒**：${alerts}`] : [])];

  // 总行数不超过上限：每栏标题占一行，条目从最长的一栏往下砍，砍掉的用一行「另有 N 条」代替
  const budget = PR_BODY_MAX_LINES - lists.length - tail.length;
  const counts = lists.map(([, items]) => items.length);
  while (counts.reduce((a, b) => a + b, 0) > budget) {
    const i = counts.indexOf(Math.max(...counts));
    if ((counts[i] ?? 0) <= 1) break;
    counts[i] = (counts[i] ?? 1) - 1;
  }
  const lines: string[] = [];
  lists.forEach(([title, items], i) => {
    if (items.length === 0) {
      lines.push(`**${title}**：无`);
      return;
    }
    lines.push(`**${title}**：`);
    const n = counts[i] ?? items.length;
    if (items.length <= n) {
      for (const item of items) lines.push(`- ${oneLine(item)}`);
    } else {
      for (const item of items.slice(0, n - 1)) lines.push(`- ${oneLine(item)}`);
      lines.push(`- ……另有 ${items.length - n + 1} 条，见需求文档`);
    }
  });
  lines.push(...tail);
  return neutralizeCloseKeywords(lines.join('\n'));
}

/** 折叠空白（含换行）成单个空格、掐头去尾：标题、单行栏目用这个压。 */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 挡 @ 提醒（会给人发通知）、中和能截断或伪造我们标记的 `<!--`/`-->`：换成看着一样但没有那个效果的字符。
 * 不动换行——issue/评论正文要保留排版，压成一行的场合（标题、进度段的一行字）在 inert() 里再叠一层 oneLine。
 */
export function neutralizeMentions(s: string): string {
  return s
    .replace(/@(?=[A-Za-z0-9-])/g, '@​')
    .replace(/<!--/g, '<!‑‑')
    .replace(/-->/g, '‑‑>');
}

/** 进度段、评论里要放进人写的标题：压成一行，再中和 @ 提醒和能截断 HTML 注释的 `-->`。 */
export function inert(s: string): string {
  return neutralizeMentions(oneLine(s));
}
