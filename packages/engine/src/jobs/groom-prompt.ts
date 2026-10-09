// 临时指挥官整理待办的会话提示词（母单 #1335 第 3 片，#1338）。提示词是双保险的第一道（告诉会话能做什么、不能做什么），
// 第二道是引擎侧校验（groom-plan.ts）：会话不守规矩，清单里越权的条目也执行不了。
// 会话没有 GitHub 令牌：它读得到的单子全在下面的提示词里（只含作者在白名单里的开着的单），仓里的东西读主线的只读检出（工作目录）。
// 总账的下一片也写在这里（#1405）：只有点了名的才开，一次最多 1 片。合并了的 PR 没读到要写明，不能当成没有。

import { GROOM_PENDING_LABEL, GROOMED_LABEL, HUMAN_DECISION_LABEL } from '@fleet-dao/conventions';
import { GROOM_MAX_AMENDS, GROOM_MAX_NEW_ISSUES, GROOM_MAX_REVIEWS } from '@fleet-dao/shared';
import { AMEND_HEADING, isLedgerIssue, isOpenSliceOf, mentionedSlice } from './groom-plan.ts';
import type { IntakeIssue } from './intake.ts';

/** 提示词里每张单正文最多给多少字符；总共最多给多少。超了的只给标题和标签。 */
export const PROMPT_BODY_CHARS = 900;
export const PROMPT_TOTAL_CHARS = 140_000;

export interface GroomPromptInput {
  repo: string;
  /** 开着的、作者在白名单里的单。 */
  issues: readonly IntakeIssue[];
  /** 「让 AI 接活」打开的时刻（ISO）：早于它开的单是「老单」。 */
  autoDispatchSince: string;
  /** 已经贴了「整理过」「交给引擎」的不用再判（号）。 */
  alreadyGroomed: ReadonlySet<number>;
  recentClosed: readonly { number: number; title: string; body?: string }[];
  /** refs 不传当「需求栏没有 Refs」（读到了）。和 mergedPulls 为 null（没读到）不是一回事。 */
  openPulls: readonly { number: number; title: string; refs?: readonly number[] }[];
  /**
   * 这一窗口里合并了的 PR，以及需求栏 Refs 的单号。
   * null = 没读到：提示词写「没读到分片关系」，不当成一个都没有，也不点名开下一片。
   */
  mergedPulls: readonly { number: number; title: string; refs: readonly number[] }[] | null;
  mainHead: string;
  now: Date;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\r\n?/g, '\n').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…（后面省略）`;
}

function refMark(refs: readonly number[]): string {
  return refs.length === 0 ? '（需求栏没有 Refs）' : `（Refs ${refs.map((n) => `#${n}`).join('、')}）`;
}

function closedLine(c: { number: number; title: string; body?: string }): string {
  const hit = mentionedSlice(`${c.title}\n${c.body ?? ''}`);
  const mark = hit ? `（总账 #${hit.ledger} ${hit.label}）` : '';
  return `- #${c.number} ${c.title}${mark}`;
}

function openLine(p: { number: number; title: string; refs?: readonly number[] }): string {
  return `- #${p.number} ${p.title}${refMark(p.refs ?? [])}`;
}

/** 总账分片这一节：关系喂给会话；只有该开的那一张才写「开出下一片」。 */
function sliceSection(input: GroomPromptInput): string {
  const ledgers = input.issues.filter(isLedgerIssue);
  const openIds = new Set(input.issues.map((i) => i.number));
  const merged = input.mergedPulls;
  const mergedOf = (ledger: number) => (merged ?? []).filter((p) => p.refs.includes(ledger));
  const openPrOf = (ledger: number) => input.openPulls.filter((p) => (p.refs ?? []).includes(ledger));
  const openSliceOf = (ledger: number) => input.issues.filter((i) => isOpenSliceOf(i, ledger));
  const ready =
    merged === null
      ? []
      : ledgers.filter(
          (i) =>
            mergedOf(i.number).length > 0 &&
            openSliceOf(i.number).length === 0 &&
            openPrOf(i.number).length === 0,
        );
  const chosen = [...ready].sort((a, b) => a.number - b.number)[0];
  const cue: string[] = [];
  if (chosen) {
    const prs = mergedOf(chosen.number)
      .map((p) => p.number)
      .sort((a, b) => a - b);
    cue.push(
      `开出下一片：#${chosen.number}「${chosen.title}」。已有合并的分片 PR ${prs.map((n) => `#${n}`).join('、')}（Refs #${chosen.number}），没有开着的分片单。splitFrom=${chosen.number}。一片一个路径域，已知的模块不超过 50 个路径，验收条要在 diff 里看得见。一次最多这一片。`,
    );
  }
  for (const other of [...ready].sort((a, b) => a.number - b.number)) {
    if (other.number === chosen?.number) continue;
    cue.push(`#${other.number} 也有合并的分片、没有开着的分片，这次先不开（一次最多 1 片）。`);
  }
  for (const ledger of ledgers) {
    if (ready.some((r) => r.number === ledger.number)) continue;
    const slices = openSliceOf(ledger.number);
    const prs = openPrOf(ledger.number);
    if (slices.length > 0) {
      cue.push(
        `#${ledger.number} 的上一片 ${slices.map((s) => `#${s.number}`).join('、')} 还开着，不要开下一片。`,
      );
    } else if (prs.length > 0) {
      cue.push(
        `#${ledger.number} 的分片 PR ${prs.map((p) => `#${p.number}`).join('、')} 还没合，不要开下一片。`,
      );
    } else if (merged !== null && mergedOf(ledger.number).length === 0) {
      cue.push(`#${ledger.number} 还没有合并了的分片 PR（Refs 它的），不要开下一片。`);
    }
  }
  let mergedText: string;
  if (merged === null) {
    mergedText =
      '没读到分片关系（合并了的 PR 没读成。不是「没有」。这一轮不要开总账的下一片，也不要把没列出当成没有分片。）';
  } else {
    const relevant = merged.filter((p) => p.refs.some((n) => openIds.has(n)));
    if (merged.length === 0) mergedText = '（这一窗口里没有合并了的 PR）';
    else if (relevant.length === 0) mergedText = '（读到的合并 PR 里，没有需求栏 Refs 着开着的单的）';
    else {
      const shown = [...relevant].sort((a, b) => a.number - b.number).slice(0, 40);
      const lines = shown.map((p) => `- #${p.number} ${p.title}${refMark(p.refs)}`);
      if (relevant.length > shown.length) lines.push(`还有 ${relevant.length - shown.length} 条没列在这里。`);
      mergedText = lines.join('\n');
    }
  }
  const decision =
    cue.length > 0
      ? cue.join('\n')
      : merged === null && ledgers.length > 0
        ? '总账在上面，但没读到分片关系，这一轮不点名开下一片。'
        : '（没有总账要开下一片）';
  return [
    '## 总账分片',
    '开着的单里，场景写了「分片」，或标题、正文有「总账」「第一片」「下一片」的，是总账。它已经有合并了的分片 PR（需求栏 Refs 它）、并且没有开着的分片单、分片 PR 也已经合了，才许开下一片：填 splitFrom=总账单号，标题带「（#总账单号 第 N 片）」（N 是正整数）。一片一个路径域，已知的模块不超过 50 个路径，验收条写成 diff 里看得见的。一次最多 1 片。上一片的单还开着，或 PR 还没合，就不要开。下面没有点名的，不要开。',
    '',
    '开着的 PR、最近关掉的单，和它们跟总账的 Refs / 分片标题，在上面两节。合并了的 PR（需求栏 Refs）在这里：',
    mergedText,
    '',
    '这一轮：',
    decision,
  ].join('\n');
}

export function renderGroomPrompt(input: GroomPromptInput): string {
  const since = Date.parse(input.autoDispatchSince);
  const isOld = (i: IntakeIssue) => Date.parse(i.createdAt) < since;
  // 没整理过的老单排在前面（先判它们），其次新单，已经整理过的最后
  const ordered = [...input.issues].sort((a, b) => {
    const rank = (i: IntakeIssue) => (input.alreadyGroomed.has(i.number) ? 2 : isOld(i) ? 0 : 1);
    return rank(a) - rank(b) || a.number - b.number;
  });
  let used = 0;
  const blocks: string[] = [];
  for (const i of ordered) {
    const tags = [
      isOld(i) ? '老单' : '新单',
      input.alreadyGroomed.has(i.number) ? '已整理过' : '没整理过',
      ...i.labels,
      i.milestone ? `版本:${i.milestone.title}` : '未排期',
    ].join(' / ');
    const head = `### #${i.number} ${i.title}\n标签：${tags}；开单时间 ${i.createdAt}`;
    const room = PROMPT_TOTAL_CHARS - used;
    const body =
      room > PROMPT_BODY_CHARS
        ? `\n${clip(i.body, PROMPT_BODY_CHARS)}`
        : '\n（正文省略：提示词放不下，要看原文读检出里的相关文件或略过这张单）';
    const block = `${head}${body}`;
    used += block.length;
    blocks.push(block);
  }
  return [
    `你是「临时指挥官」：${input.repo} 的引擎在没有可挑的单、待办却还很多时叫起来的一个短命会话，只做一件事——整理待办，让引擎有活可挑。你不写代码、不改仓库。`,
    `现在是 ${input.now.toISOString()}。当前工作目录是主线的只读检出（提交 ${input.mainHead.slice(0, 12)}）：要判断一张单的前提还成不成立，就去读 docs/decisions/、docs/design.md、docs/goals.md、specs/ 和相关代码。只读，不要改任何文件，不要跑会改东西的命令。`,
    '',
    '## 你能做的（全部写在最后的清单里，由引擎代码执行，你自己不动手）',
    `1. reviews：对一张单下判断，每次最多 ${GROOM_MAX_REVIEWS} 条。verdict 三选一：`,
    `   - "sound"：这张单的前提今天仍成立、范围清楚、适合交给引擎做。引擎会贴「${GROOMED_LABEL}」，老单只有贴了它才会被引擎挑。**拿不准就不要判 sound**：引擎前几天就因为拉到前提已经过期的老单白烧了一轮。`,
    `   - "expired"：前提已被后来的决定取代、事情已经做完、或要等一个还没发生的条件才成立。引擎会留言建议关闭并贴「${GROOM_PENDING_LABEL}」，**不会关单**。reason 里写清是哪条决定 / 哪个 PR / 哪段代码说明它过期了。`,
    `   - "human"：涉及改标准的路径（agents/ 下的说明、packages/conventions/standard-paths.json 等）、删数据、花钱、对外发布，或 .github/workflows/。引擎会贴「${HUMAN_DECISION_LABEL}」，从此不拉。`,
    `2. amendments：给缺东西的老单补写，每次最多 ${GROOM_MAX_AMENDS} 张。只补它缺的节（scene 场景 / modules 已知的模块 / done 怎么算做完，done 每条要写成 diff 里或界面上看得见的东西，不要写「跑 grep 看结果」），note 放别的补充。引擎只在原正文末尾追加「## ${AMEND_HEADING}」一节，原文和原话一个字都不会改；老单里已经写了的节不补。补完引擎会贴「${GROOMED_LABEL}」，所以只补你认为仍成立的单。`,
    `3. newIssues：开新的独立小单，每次最多 ${GROOM_MAX_NEW_ISSUES} 张：把一张太大的单拆成几张能单独做完的小单（填 splitFrom=大单号，引擎会在大单上留言；**不要开子单**），或开你在仓里读到的、确实该做又没人记的事。总账的下一片也走这里，但只有下面「总账分片」点了名的才开。每张给 title、kind（需求 / 缺陷 / 杂项）、scene、modules（可省）、done（至少一条，写成看得见的验收条）。引擎自己拼成四节的单，「原话」一栏它写「无（AI 发现）」，你不要编创始人的原话。新单一律是未排期。开之前先看下面「开着的单」「最近关掉的」「开着的 PR」，已经有的不要再开。`,
    '',
    '## 你不能做的（写了也不会执行，还会被记成越权）',
    '关单；改里程碑或版本先后；改老单的原文、原话；推代码、开 PR；动 .github/workflows/ 和 agents/ 下的东西；对陌生人开的单做任何事（它们不在下面的列表里）。',
    '',
    '## 优先顺序',
    '先判「老单 / 没整理过」的（它们现在进不了引擎的候选，等你判）；再补缺节的；最后才是开新单。判断要有依据：读了才下结论，读不到就别判。',
    '',
    '## 回答格式',
    '最后给一段 ```json 围栏，里面是一个对象，只有这四个键（别的键会被丢掉并记成越权）：',
    '```json',
    '{',
    '  "summary": "一两句话：这次判了几张、补了几张、开了几张、有什么要人注意",',
    '  "reviews": [{ "issue": 123, "verdict": "sound", "reason": "为什么" }],',
    '  "amendments": [{ "issue": 123, "scene": "…", "modules": "…", "done": ["…"], "note": "…", "needsHuman": "涉及删数据时写原因，否则省略" }],',
    '  "newIssues": [{ "title": "…", "kind": "需求", "scene": "…", "modules": "…", "done": ["…"], "splitFrom": 123, "needsHuman": "涉及删数据 / 花钱时写原因，否则省略" }]',
    '}',
    '```',
    '没有要做的就给空列表。围栏之外的文字随便写，引擎只读围栏里的。',
    '',
    `## 开着的单（作者在白名单里的，${input.issues.length} 张）`,
    blocks.join('\n\n') || '（没有）',
    '',
    '## 最近 30 天关掉的单（开新单前对一下，别重复）',
    input.recentClosed.map(closedLine).join('\n') || '（没有）',
    '',
    '## 开着的 PR',
    input.openPulls.map(openLine).join('\n') || '（没有）',
    '',
    sliceSection(input),
  ].join('\n');
}
