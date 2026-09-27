// 开 PR 前验证照哪几条问（docs/decisions/0003-fusion-flow.md 第 5 条第 5 步）：这张单的需求文档在哪、「怎么算做完」逐条原文。
// 需求文档是开单时 pnpm issue:new 写的 specs/<号>-<短名>/需求.md，单子正文里留一行「文档：`specs/<本单号>-<短名>/需求.md`」指着它。
// 引擎自己开的单（对账开的后续单、巡检单）没有这一行，正文写全了需求：收单时照正文写需求文档，随 PR 进主线（specOf，#295）。
// 读不到、认不出一律明确报错（error），不拿空清单冒充「没有要验的」。读文件是外壳的事，这里只认文字。

/** 需求文档的文件名（在 specs/<号>-<短名>/ 下）。 */
export const REQUIREMENT_FILE = '需求.md';

/** 单子正文里指需求文档的那一行：「文档：`specs/<本单号>-短名/需求.md`」；号可能是占位的 <本单号>，也可能已经写成真号。 */
const POINTER = /文档\s*[：:]\s*`?\s*(specs\/[^`\s]+?)\/需求\.md\s*`?/;
const PLACEHOLDER = '<本单号>';
/** 目录名：specs/<号>-<短名>，短名不许带斜杠、反斜杠、空白。 */
const SPEC_DIR = /^specs\/(\d+)-([^/\\\s]+)$/;

/** 单子正文指的需求文档目录（例如 specs/213-开PR前验证）。没写、写的不是这张单的、目录名认不出，都回 error。 */
export function specDirOf(issueBody: string, issueNumber: number): { ok: string } | { error: string } {
  const m = POINTER.exec(issueBody);
  if (!m?.[1]) {
    return { error: '单子正文里没有指需求文档的那一行（「文档：`specs/<号>-<短名>/需求.md`」）' };
  }
  const dir = m[1].replace(PLACEHOLDER, String(issueNumber));
  const parts = SPEC_DIR.exec(dir);
  if (!parts || /^\.+$/.test(parts[2] ?? '')) return { error: `需求文档的目录认不出：${m[1]}` };
  if (Number(parts[1]) !== issueNumber) {
    return { error: `正文指的是 #${parts[1]} 的需求文档（${dir}），不是这张单 #${issueNumber} 的` };
  }
  return { ok: dir };
}

/** 需求文档目录的短名最多几个字。 */
const SHORT_NAME_MAX = 20;

/** 照单子标题取需求文档目录的短名：只留字母、数字、汉字，最多 20 个字；一个都不剩写「需求」。同一个标题总是同一个短名。 */
export function specShortName(title: string): string {
  const kept = [...title.normalize('NFKC')].filter((ch) => /[\p{L}\p{N}]/u.test(ch));
  return kept.slice(0, SHORT_NAME_MAX).join('') || '需求';
}

/** 单子正文当需求文档用之前：去掉 HTML 注释（引擎开单留的标记、模板里的提示）、统一换行、掐头去尾。 */
function cleanBody(body: string): string {
  return body
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 这张单的需求文档从哪来（Fusion 第 1 步收单）：
 * - 正文里有指需求文档的那一行：照它（specDirOf；写错了、指的是别的单照样报错，不改用正文）。
 * - 没有那一行、正文写全了需求（有写了字的「## 怎么算做完」，#295：引擎对账开的后续单、巡检单都是这样）：照收，目录是
 *   specs/<号>-<照标题取的短名>，requirement 是照正文写的需求文档，由 Lead 原样提交进这个目录、随 PR 进主线；开 PR 前验证的
 *   「怎么算做完」读单子正文（bodyCriteria），不读分支上的。
 * - 两样都没有：报错，停下等人补。
 */
export function specOf(input: {
  body: string;
  issueNumber: number;
  title: string;
}): { ok: string; requirement?: string } | { error: string } {
  if (POINTER.test(input.body)) return specDirOf(input.body, input.issueNumber);
  const text = cleanBody(input.body);
  const got = criteriaOf(text);
  if ('error' in got) {
    return {
      error: `单子正文里没有指需求文档的那一行（「文档：\`specs/<号>-<短名>/需求.md\`」），正文里也没写全需求（${got.error.replace(/^需求文档里/, '')}）`,
    };
  }
  const title = input.title.replace(/\s+/g, ' ').trim() || `#${input.issueNumber}`;
  return {
    ok: `specs/${input.issueNumber}-${specShortName(title)}`,
    requirement: `# ${title}（#${input.issueNumber}）\n\n${text}\n`,
  };
}

/** 单子正文里「怎么算做完」逐条原文（正文写全了需求、没有需求文档的单，开 PR 前验证照它核，#295）。 */
export function bodyCriteria(body: string): { ok: string[] } | { error: string } {
  const got = criteriaOf(cleanBody(body));
  return 'error' in got ? { error: got.error.replace(/^需求文档里/, '单子正文里') } : got;
}

const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^\s*(```|~~~)/;
/** 一级列表项：顶格（最多一个空格）写 - * + 或「1.」「1)」。缩进两格以上的算上一条的续行（下一级的小项并进上一条）。 */
const ITEM = /^ ?(?:[-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;

/** 认标题用的写法：去掉加粗、反引号，空白压成一个（和开单脚本、欠账检查认「怎么算做完」同一个办法）。 */
const titleKey = (s: string) =>
  s
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();

interface Block {
  kind: 'item' | 'para';
  lines: string[];
  /** 这一块后面已经空过一行：再来不缩进的字就是新的一块。 */
  gap: boolean;
}

/**
 * 需求文档里「怎么算做完」那一节的逐条原文。一条 = 一个一级列表项连同它的续行（换行变一个空格，照 Markdown 显示出来的样子），
 * 没写成列表的一段话也算一条；一模一样的两条只留一条（验证模型逐条答，重复的会被判成「一条答了两遍」）。HTML 注释、
 * 节里的小标题不算一条。找标题的办法：去掉加粗、反引号后以「怎么算做完」开头的第一个标题，到下一个同级或更高的标题为止。
 */
export function criteriaOf(markdown: string): { ok: string[] } | { error: string } {
  const text = markdown
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split('\n');
  let start = -1;
  let level = 0;
  let inFence = false;
  for (const [i, line] of lines.entries()) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    const h = inFence ? null : HEADING.exec(line);
    if (h?.[1] && titleKey(h[2] ?? '').startsWith('怎么算做完')) {
      start = i + 1;
      level = h[1].length;
      break;
    }
  }
  if (start < 0) return { error: '需求文档里没有「## 怎么算做完」一节' };

  const blocks: Block[] = [];
  let current: Block | undefined;
  inFence = false;
  for (const line of lines.slice(start)) {
    if (FENCE.test(line)) {
      // 围栏本身不算字；围栏里的内容照原样并进当前这一条
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      const h = HEADING.exec(line);
      if (h?.[1]) {
        if (h[1].length <= level) break;
        current = undefined;
        continue;
      }
      if (!line.trim()) {
        if (current) current.gap = true;
        continue;
      }
      const item = ITEM.exec(line);
      if (item) {
        current = { kind: 'item', lines: [item[1] ?? ''], gap: false };
        blocks.push(current);
        continue;
      }
    }
    const indented = /^\s/.test(line);
    if (current && (inFence || !current.gap || (current.kind === 'item' && indented))) {
      current.lines.push(line);
      current.gap = false;
      continue;
    }
    current = { kind: 'para', lines: [line], gap: false };
    blocks.push(current);
  }

  const seen = new Set<string>();
  const criteria: string[] = [];
  for (const block of blocks) {
    const one = block.lines.join(' ').replace(/\s+/g, ' ').trim();
    if (!one || seen.has(one)) continue;
    seen.add(one);
    criteria.push(one);
  }
  if (criteria.length === 0) return { error: '需求文档里「怎么算做完」一节是空的' };
  return { ok: criteria };
}
