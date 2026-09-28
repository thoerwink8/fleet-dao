// 关单要有结果（#241、#325）：「这张单有没有结果」「这个 PR 合进去会关哪几张单」只在这里判一份——pnpm issue:close、
// 引擎每天的关单对账、PR 必填栏的提醒都调它。#444 起合并闸不再调它（缺结果的由每天的关单对账另外提醒、不再挡合并）：
// 这份不再需要在先审后合的清单里，high-risk-paths.json 已经去掉这一条。
// 不引任何别的文件：本来是怕被合并闸的先审后合清单一起拖进去，现在只是保持这份自成一体、少一层依赖，没必要改成借
// pr-fields 的 prColumns。所以「这个 PR 做完就关单」那一栏在这里单独认，只认写在同一行的值。
// 放在 conventions 不放 core：只引本包的文件，core 只许依赖 shared 和 zod；引擎第 6 步收 结果.md 用的是
// core 的 specDocs，engine 包里有测试钉住两边认的是同一个路径。

/** 结果文档的文件名（在 specs/<号>-<短名>/ 下）。 */
export const RESULT_FILE = '结果.md';

/** specs/<号>-<短名>/结果.md：短名不空、不带斜杠反斜杠和空白（和 core 认需求文档目录的写法一样）。 */
const RESULT_DOC = /^specs\/(\d+)-([^/\\\s]+)\/结果\.md$/;

/** 仓内路径是哪张单的结果文档：specs/<号>-<短名>/结果.md 回号，别的回 undefined（短名全是点的、号带前导 0 的不算）。 */
export function resultDocIssue(path: string): number | undefined {
  const m = RESULT_DOC.exec(path);
  if (!m?.[1] || /^\.+$/.test(m[2] ?? '')) return undefined;
  const n = Number(m[1]);
  return String(n) === m[1] && n > 0 ? n : undefined;
}

/** 这些文件（仓内路径）里第 n 张单的结果文档；有好几份取路径排最前的，没有回 undefined。 */
export function resultDocOf(issue: number, files: Iterable<string>): string | undefined {
  return [...files].filter((f) => resultDocIssue(f) === issue).sort()[0];
}

// —— GitHub 合并时认的关单写法：close/closes/closed、fix/fixes/fixed、resolve/resolves/resolved，后面跟单号（冒号可有可无）。
// 引擎开的 PR 在 packages/github 的 text.ts 里把它们改成「关联」（C13），这里是认出来拿去判（合并闸、每天对账）。

const CLOSE_WORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
const CLOSING = new RegExp(
  String.raw`\b${CLOSE_WORD}(?:\s*:\s*|\s+)(?:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)?#(\d+)|GH-(\d+)|https?:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/issues\/(\d+))`,
  'gi',
);

/**
 * 正文里写了、GitHub 合并时会关的单号（从小到大，不重复）：#12、owner/仓#12、GH-12、issue 的网址都认。代码块、行内代码、
 * HTML 注释里的不算（GitHub 不从那里认关单词，拿来举例的写法不该挡人；第二意见 #334）。
 * 给了 repo（owner/仓）时，写明是别的仓的不算；不给就都算（宁多不漏：合并闸拿它挡没带结果的 PR）。
 */
export function closingIssues(body: string, repo?: string): number[] {
  const out = new Set<number>();
  for (const m of proseOf(body).matchAll(CLOSING)) {
    const other = m[1] ?? m[4];
    if (other && repo && other.toLowerCase() !== repo.toLowerCase()) continue;
    const n = Number(m[2] ?? m[3] ?? m[5]);
    if (Number.isSafeInteger(n) && n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** 正文去掉 HTML 注释、围栏代码块（``` 或 ~~~，没收尾的不算块、照认）、行内代码，剩下 GitHub 会拿来认关单词的字。 */
function proseOf(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*$/gm, ' ')
    .replace(/(`+)[^`]*?\1/g, ' ');
}

// —— PR 模板里「这个 PR 做完就关单」那一栏 ——

/**
 * 是 = 合进去这张单就做完了：正文另写 Closes #号、由 GitHub 合并时关，这个 PR 要带那张单的 结果.md（合并闸查，#325）；
 * 否 = 还有后续，或结果不在这个 PR 里写（合完用 pnpm issue:close 关）。引擎开的 PR 一律写否（#241）。
 */
export const CLOSE_COLUMN = '这个 PR 做完就关单';

/** 那一栏填的什么：是、否、空的、写了认不出的；没有这一栏是 missing。 */
export type CloseColumn = { value: 'yes' | 'no' | 'empty' | 'missing' } | { value: 'other'; text: string };

/** 「**这个 PR 做完就关单**：」「这个 PR 做完就关单：」（加粗、冒号在里在外、列表里、英文冒号都认），值写在同一行。 */
const CLOSE_LINE =
  /^\s*(?:[-*+]\s+)?(?:\*\*\s*)?这个\s*PR\s*做完就关单\s*(?:\*\*\s*[：:]|[：:]\s*\*\*|[：:])(.*)$/i;

/** 正文里那一栏（HTML 注释里的模板提示先去掉，第一处为准）。 */
export function closeColumnValue(body: string): CloseColumn {
  const text = body.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  for (const line of text.split('\n')) {
    const m = CLOSE_LINE.exec(line);
    if (!m) continue;
    const v = (m[1] ?? '').replace(/[`*]/g, '').trim();
    if (!v) return { value: 'empty' };
    if (v.startsWith('是')) return { value: 'yes' };
    if (v.startsWith('否')) return { value: 'no' };
    return { value: 'other', text: v.length > 60 ? `${v.slice(0, 60)}…` : v };
  }
  return { value: 'missing' };
}

// —— 合并闸那一段（#325，创始人 2026-09-27 晚拍）——

/**
 * 这个 PR 合进去会关哪几张单（正文里 GitHub 认的关单词；PR 自己的号不算），以及「这个 PR 做完就关单」填了「是」却一个
 * 关单词都没写（GitHub 不关）的那一句。
 */
export function closingTargets(
  pr: { number: number; body: string },
  repo?: string,
): { issues: number[]; problems: string[] } {
  const issues = closingIssues(pr.body, repo).filter((n) => n !== pr.number);
  const problems =
    issues.length === 0 && closeColumnValue(pr.body).value === 'yes'
      ? [
          `「${CLOSE_COLUMN}」填了「是」，正文里却没写 Closes #<单号>：GitHub 只认关单词，不写合并了也不关；另起一行写上，还不关就改成「否」。`,
        ]
      : [];
  return { issues, problems };
}

/** 要关的单里，这个 PR 的改动（删掉的不算）没带结果文档的，一张一句。 */
export function missingResults(
  issues: readonly number[],
  files: readonly { filename: string; status: string }[],
): string[] {
  const kept = files.filter((f) => f.status !== 'removed').map((f) => f.filename);
  return issues
    .filter((n) => !resultDocOf(n, kept))
    .map(
      (n) =>
        `要关 #${n} 却没带 specs/${n}-<短名>/${RESULT_FILE}：结果写进这个 PR；结果不在这里写的，去掉 Closes #${n}、「${CLOSE_COLUMN}」改「否」，合完用 pnpm issue:close ${n} 关。`,
    );
}
