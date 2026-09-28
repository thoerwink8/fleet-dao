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
// 两边栏目对不上，test/text.test.ts 会红。整篇 16 行以内（设计 §7；#348 加「认领」栏时从 15 放到 16：固定的栏占 8 行，再少列表就放不下）。——

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
  /** 「按推荐先做了」：问创始人的岔路里没等他回、按推荐先做了的（#259）；空 = 无。 */
  assumed?: readonly string[] | undefined;
  /** 「修提醒」：这个 PR 修的是哪几条提醒（键），驾驶舱据此显示修到哪（design 15.3「谁在处理」）；空 = 无。 */
  fixesAlerts?: readonly string[] | undefined;
  /**
   * 「对应计划」：plan.md 的阶段加那一条的原话开头，例如「P1「工作流」」。必填；给空的写「（没写）」，
   * CI 的 pr-fields（packages/conventions）照样判红，不会当成填了。
   */
  plan: string;
  /** 「specs」：需求文档的目录，例如 specs/12-登录验证码/；null = 杂活，写「不适用」。必填，免得分不清是杂活还是忘了给。 */
  specs: string | null;
  /**
   * 「档位」：design 第五节的三档之一加理由，例如「先审后合——方案标了高风险」。不给或给空的写「（没写）」，
   * 合并闸（packages/conventions 的 merge-gate）照样判红，不冒充填了。
   */
  tier?: string | undefined;
  /** 这个 PR 改到的文件（仓内相对路径）。「文档」一栏按它写；必填，不给就说不清是「不适用」还是没查。 */
  changedFiles: readonly string[];
}

/** 「文档」一栏认的几份文档：仓内路径和栏里写的名字，顺序同模板。 */
const PR_DOC_FILES: readonly (readonly [path: string, name: string])[] = [
  ['README.md', 'README'],
  ['docs/design.md', 'design'],
  ['docs/ops.md', 'ops'],
  ['docs/plan.md', 'plan'],
];

export const PR_BODY_MAX_LINES = 16;

/**
 * 「这个 PR 做完就关单」一栏：引擎开的 PR 一律写「否」（#241）。GitHub 合并时替它关了单，接活会当成叫停，第 7 步的
 * 关单评论和记账就做不完；所以正文里的关单词也一律改成「关联」（neutralizeCloseKeywords）。
 */
export const ENGINE_CLOSE_COLUMN = '否（引擎合并后第 7 步自己关单）';

/**
 * 「认领」一栏：引擎开的 PR 不写认领号，写「引擎」——纯记录，#446 起没有谁核对这一栏对不对得上了（「认领对得上」
 * 那套机制、core 的 judgeClaimMatch 都已经删掉）。
 */
export const ENGINE_CLAIM_COLUMN = '引擎';

export function renderPrBody(input: PrBodyInput): string {
  const lists: [string, readonly string[]][] = [
    ['做了什么', input.did.length ? input.did : ['（没写）']],
    ['怎么验证的', input.verified.length ? input.verified : ['（没写）']],
    ['还欠什么', [...(input.owed ?? []), ...(input.risks ?? []).map((r) => `风险：${r}`)]],
    ['按推荐先做了', input.assumed ?? []],
  ];
  const requirement =
    [
      input.requirement === undefined ? '' : `#${input.requirement}`,
      input.subtask ? `子任务 ${oneLine(input.subtask)}` : '',
    ]
      .filter(Boolean)
      .join(' · ') || '无';
  const changed = new Set(input.changedFiles);
  const docs = PR_DOC_FILES.filter(([path]) => changed.has(path)).map(([, name]) => name);
  const tail = [
    `**需求**：${requirement}`,
    `**认领**：${ENGINE_CLAIM_COLUMN}`,
    `**修提醒**：${(input.fixesAlerts ?? []).map(oneLine).filter(Boolean).join(' ') || '无'}`,
    `**这个 PR 做完就关单**：${ENGINE_CLOSE_COLUMN}`,
    `**对应计划**：${oneLine(input.plan) || '（没写）'}`,
    `**specs**：${input.specs === null ? '不适用' : oneLine(input.specs) || '（没写）'}`,
    `**档位**：${oneLine(input.tier ?? '') || '（没写）'}`,
    `**文档**：${docs.length ? docs.join('、') : '不适用'}`,
  ];

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
