// GitHub 合并时认的关单写法：close/closes/closed、fix/fixes/fixed、resolve/resolves/resolved，后面跟单号（冒号可有可无）。
// 引擎开的 PR 在 packages/github 的 text.ts 里把它们改成「关联」（C13），pr-links.ts 用这里认出来的号把 PR 链到单子上。
// 不引任何别的文件。（#654 以前这里还判「这张单有没有结果.md」「PR 合进去会关哪几张」，供合并闸、每天的关单对账、
// pnpm issue:close 共用；结果.md、关单对账、PR 的「这个 PR 做完就关单」栏都删了，只剩认关单词这一件。）

const CLOSE_WORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
const CLOSING = new RegExp(
  String.raw`\b${CLOSE_WORD}(?:\s*:\s*|\s+)(?:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)?#(\d+)|GH-(\d+)|https?:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/issues\/(\d+))`,
  'gi',
);

/**
 * 正文里写了、GitHub 合并时会关的单号（从小到大，不重复）：#12、owner/仓#12、GH-12、issue 的网址都认。代码块、行内代码、
 * HTML 注释里的不算（GitHub 不从那里认关单词，拿来举例的写法不该算数；第二意见 #334）。
 * 给了 repo（owner/仓）时，写明是别的仓的不算；不给就都算（宁多不漏）。
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
