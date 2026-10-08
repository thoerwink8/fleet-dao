// 临时指挥官整理待办的「清单」一层（母单 #1335 第 3 片，#1338）：会话只交一份结构化清单，开单、补写、留言、贴标签全由这里的引擎代码执行，
// 执行之前逐条按限额和禁止项校验——会话绕不过：它手上没有 GitHub 令牌，清单里写什么，引擎都只认下面这几种动作，别的一律丢进 rejected。
//
// 改这里之前必须知道：
// - 动作只有四类：开独立小单（newIssues）、在老单正文末尾追加「## 引擎整理补充」（amendments）、对一张单下判断（reviews：仍成立 /
//   过期 / 要人拍，对应贴「整理过」/ 留言加「待补」/ 留言加「要人拍」）。没有关单，没有改里程碑，没有推代码，没有改老单原文：
//   GroomWrites 这个端口里压根没有这些方法（测试盯着它的键），清单里写 closeIssues 之类的项会进 rejected。
// - 限额：每次最多开 5 张新单、补写 10 张老单、下 40 条判断；超出的进 rejected，不顺延。
// - 开单的正文由引擎按四节模板自己拼（场景、原话、已知的模块、怎么算做完），会话只给各节的内容：「原话」一栏引擎写死「无（AI 发现）」，
//   会话编不了创始人的原话；会话给的文字里行首的 # 标题全剥掉，伪造不了新的一节。拼完再用开单脚本同一份判法
//   （conventions 的 requiredSectionProblems、doneSection）核一遍。新单一律不挂里程碑（未排期）、不排进版本先后：不动先后列表。
// - 开之前先查：开着的单、最近 30 天关掉的单、开着的 PR，标题和路径像的（conventions 的 rankSimilar，开单脚本提示重复用的同一份）就不开，
//   进 rejected 写明像谁。
// - 补老单只往末尾接，原文、原话一个字不动：老单里已有的节（场景、已知的模块、怎么算做完写了字的）不补，已经有整理补充的单不再补。
// - 会话只看得到、也只能点到「作者在白名单里」的开着的单：陌生人开的单正文不进提示词（防提示词注入），清单点到它们也丢进 rejected。
// - 涉及改标准路径、`.github/workflows/`（正文里认得出路径）或会话自己标了删数据 / 花钱的，贴「要人拍」，引擎不拉。
// - 单条动作失败（GitHub 写不进）进 rejected，别的条照做；全部尝试的动作都失败，调用方当整理失败。

import {
  doneSection,
  GROOM_PENDING_LABEL,
  GROOMED_LABEL,
  HUMAN_DECISION_LABEL,
  KIND_LABELS,
  matchesStandardPath,
  modulePaths,
  parseMd,
  rankSimilar,
  requiredSectionProblems,
  type SimilarCandidate,
  type StandardPath,
  sectionText,
} from '@fleet-dao/conventions';
import {
  GROOM_MAX_AMENDS,
  GROOM_MAX_NEW_ISSUES,
  GROOM_MAX_REVIEWS,
  type GroomResult,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { z } from 'zod';
import type { IntakeIssue } from './intake.ts';

/** 补老单时追加的那一节的标题。 */
export const AMEND_HEADING = '引擎整理补充';

const Num = z.number().int().positive();
const Text = (max: number) => z.string().trim().min(1).max(max);

const NewIssueItem = z.object({
  title: Text(100),
  kind: z.enum(KIND_LABELS),
  scene: Text(3000),
  modules: Text(2000).optional(),
  done: z.array(Text(500)).min(1).max(12),
  /** 从哪张大单拆出来的（拆大单 = 开若干张独立小单并在大单留言，不开子单）。 */
  splitFrom: Num.optional(),
  /** 会话判断这张单涉及删数据或花钱（引擎认不出这两样，只能会话说）：写原因。 */
  needsHuman: Text(300).optional(),
});
const AmendItem = z
  .object({
    issue: Num,
    scene: Text(3000).optional(),
    modules: Text(2000).optional(),
    done: z.array(Text(500)).min(1).max(12).optional(),
    note: Text(1500).optional(),
    needsHuman: Text(300).optional(),
  })
  .refine((a) => a.scene || a.modules || a.done || a.note, '一条补充都没有写');
const ReviewItem = z.object({
  issue: Num,
  verdict: z.enum(['sound', 'expired', 'human']),
  reason: Text(600),
});

export type NewIssueItem = z.infer<typeof NewIssueItem>;
export type AmendItem = z.infer<typeof AmendItem>;
export type ReviewItem = z.infer<typeof ReviewItem>;

export interface Rejected {
  what: string;
  why: string;
}

export interface ParsedGroomPlan {
  summary: string;
  newIssues: { index: number; item: NewIssueItem }[];
  amendments: { index: number; item: AmendItem }[];
  reviews: { index: number; item: ReviewItem }[];
  /** 格式不对的条目和清单里不认识的项。 */
  rejected: Rejected[];
}

const KNOWN_KEYS = new Set(['summary', 'newIssues', 'amendments', 'reviews']);

/** 从会话的回答里取最后一段 JSON（优先 ```json 围栏，其次整段回答）。 */
function extractJson(answer: string): unknown {
  const candidates = [...answer.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)]
    .map((m) => m[1] ?? '')
    .reverse();
  candidates.push(answer.trim());
  for (const text of candidates) {
    try {
      const v: unknown = JSON.parse(text);
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      // 换下一段
    }
  }
  return undefined;
}

/** 回答 → 清单。整份认不出回 ok:false（调用方当整理失败）；单条认不出进 rejected，别的条照做。 */
export function parseGroomPlan(
  answer: string,
): { ok: true; plan: ParsedGroomPlan } | { ok: false; why: string } {
  const raw = extractJson(answer);
  if (raw === undefined) {
    return { ok: false, why: '会话的回答里找不到清单（要有一段 ```json 围栏，里面是一个对象）' };
  }
  const obj = raw as Record<string, unknown>;
  const rejected: Rejected[] = [];
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      rejected.push({
        what: `清单里的「${key}」`,
        why: '不是允许的动作（只有 newIssues、amendments、reviews）：没有执行',
      });
    }
  }
  const list = (key: string): unknown[] => {
    const v = obj[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      rejected.push({ what: `清单里的「${key}」`, why: '不是列表：没有执行' });
      return [];
    }
    return v;
  };
  const pick = <S extends z.ZodType>(key: string, schema: S) =>
    list(key).flatMap((entry, index) => {
      const parsed = schema.safeParse(entry);
      if (parsed.success) return [{ index, item: parsed.data as z.output<S> }];
      rejected.push({
        what: `${key}[${index}]`,
        why: parsed.error.issues.map((i) => `${i.path.join('.') || '整条'}：${i.message}`).join('；'),
      });
      return [];
    });
  const summary = typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 600) : '';
  return {
    ok: true,
    plan: {
      summary,
      newIssues: pick('newIssues', NewIssueItem),
      amendments: pick('amendments', AmendItem),
      reviews: pick('reviews', ReviewItem),
      rejected,
    },
  };
}

// —— 引擎侧的纯判断 ——

/** 会话给的文字里，行首的 # 标题全剥掉：它写不出新的一节（原话、怎么算做完）。 */
export function plainText(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s{0,3}#{1,6}(\s+|$)/, ''))
    .join('\n')
    .trim();
}

/**
 * 这段文字涉及什么要人拍的事：改标准的路径（清单在 standard-paths.json）、`.github/workflows/`。认得出回一句原因，认不出回 null。
 * 删数据、花钱引擎认不出，由会话在清单里自己标（needsHuman）。
 */
export function humanDecisionReason(text: string, rules: readonly StandardPath[]): string | null {
  if (/\.github\/workflows\//.test(text))
    return '涉及 .github/workflows/（引擎的令牌推不了，改工作流要人拍）';
  for (const p of modulePaths(text)) {
    const rule = rules.find((r) => matchesStandardPath(p, r));
    if (rule) return `涉及改标准的路径 ${p}（${rule.path}）`;
  }
  return null;
}

/** 新单的正文：引擎按四节模板拼，原话一栏写死。 */
export function renderNewIssueBody(item: NewIssueItem): string {
  const split =
    item.splitFrom === undefined ? '' : `\n\n（从 #${item.splitFrom} 拆出来的独立小单，不是子单。）`;
  return [
    '## 场景',
    '',
    `${plainText(item.scene)}${split}`,
    '',
    '## 原话',
    '',
    `无（AI 发现；引擎的临时指挥官整理待办时开的）。${item.splitFrom === undefined ? '' : `大单 #${item.splitFrom} 里的原话见该单。`}`,
    '',
    '## 已知的模块',
    '',
    item.modules === undefined ? '暂无' : plainText(item.modules),
    '',
    '## 怎么算做完',
    '',
    ...item.done.map((d) => `- ${plainText(d).replace(/\n+/g, ' ')}`),
    '',
  ].join('\n');
}

/** 追加到老单末尾的一段（只含老单里缺的节）。 */
export function renderAmendment(
  item: AmendItem,
  include: { scene: boolean; modules: boolean; done: boolean },
  date: string,
): string {
  const parts = [
    `## ${AMEND_HEADING}`,
    '',
    `（引擎的临时指挥官整理待办，${date}。以上原文和原话没有改动。）`,
  ];
  if (include.scene && item.scene) parts.push('', '### 场景', '', plainText(item.scene));
  if (include.modules && item.modules) parts.push('', '### 已知的模块', '', plainText(item.modules));
  if (include.done && item.done) {
    parts.push('', '### 怎么算做完', '', ...item.done.map((d) => `- ${plainText(d).replace(/\n+/g, ' ')}`));
  }
  if (item.note) parts.push('', plainText(item.note));
  return parts.join('\n');
}

/** 老单正文里这三节哪些已经写了字（补写只补缺的）。 */
export function presentSections(body: string): {
  scene: boolean;
  modules: boolean;
  done: boolean;
  amended: boolean;
} {
  const doc = parseMd('issue.md', body);
  const has = (name: string) => (sectionText(doc, name) ?? '').trim().length > 0;
  return {
    scene: has('场景'),
    modules: has('已知的模块'),
    done: doneSection(doc) === 'ok',
    amended: doc.headings.some((h) => h.title.trim() === AMEND_HEADING),
  };
}

// —— 执行 ——

/**
 * 会话的清单能触发的全部写操作。没有关单、改里程碑、改原文、推代码：这几样在这里压根没有入口。
 */
export interface GroomWrites {
  openIssue(input: {
    key: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; url: string; created: boolean }>;
  comment(input: { issueNumber: number; key: string; body: string }): Promise<{ created: boolean }>;
  addLabel(input: { issueNumber: number; label: string }): Promise<void>;
  appendBody(input: {
    issueNumber: number;
    key: string;
    text: string;
  }): Promise<{ outcome: 'written' | 'unchanged' }>;
}

export interface PlanContext {
  requestId: string;
  now: Date;
  /** 开着的、作者在白名单里的单（会话只看得到、点得到这些）。 */
  trusted: ReadonlyMap<number, IntakeIssue>;
  /** 开着的单（含陌生人开的）、最近关掉的单、开着的 PR：查重用。 */
  similar: SimilarCandidate[];
  standardPaths: readonly StandardPath[];
}

export interface ExecutedPlan {
  result: Omit<GroomResult, 'summary' | 'model' | 'routeId' | 'usage' | 'costUsd'>;
  /** 尝试过的写动作数和失败数（全失败 = GitHub 不通，调用方当整理失败）。 */
  attempted: number;
  failed: number;
}

const has = (issue: IntakeIssue, label: string) => issue.labels.includes(label);

/** 校验并执行清单。 */
export async function executeGroomPlan(
  plan: ParsedGroomPlan,
  ctx: PlanContext,
  writes: GroomWrites,
): Promise<ExecutedPlan> {
  const rejected: Rejected[] = [...plan.rejected];
  const opened: GroomResult['opened'] = [];
  const amended: number[] = [];
  const groomed: number[] = [];
  const suggestedClose: number[] = [];
  const flagged: number[] = [];
  let attempted = 0;
  let failed = 0;
  const date = ctx.now.toISOString().slice(0, 10);
  const label = async (issueNumber: number, name: string, issue?: IntakeIssue) => {
    if (issue && has(issue, name)) return;
    await writes.addLabel({ issueNumber, label: name });
  };
  /** 一条动作：失败进 rejected、别的照做。 */
  const act = async (what: string, fn: () => Promise<void>): Promise<boolean> => {
    attempted += 1;
    try {
      await fn();
      return true;
    } catch (err) {
      failed += 1;
      rejected.push({ what, why: `GitHub 写不进：${errMessage(err)}` });
      return false;
    }
  };

  // 1. 判断（reviews）
  const judged = new Map<number, ReviewItem['verdict']>();
  for (const { index, item } of plan.reviews) {
    const what = `reviews[${index}] #${item.issue}`;
    const issue = ctx.trusted.get(item.issue);
    if (!issue) {
      rejected.push({ what, why: '不是开着的、作者在白名单里的单' });
      continue;
    }
    if (judged.has(item.issue)) {
      rejected.push({ what, why: '同一张单已经有一条判断' });
      continue;
    }
    if (judged.size >= GROOM_MAX_REVIEWS) {
      rejected.push({ what, why: `超过每次最多 ${GROOM_MAX_REVIEWS} 条判断` });
      continue;
    }
    judged.set(item.issue, item.verdict);
    const reason = plainText(item.reason);
    if (item.verdict === 'sound') {
      if (await act(what, () => label(item.issue, GROOMED_LABEL, issue))) groomed.push(item.issue);
    } else if (item.verdict === 'expired') {
      const ok = await act(what, async () => {
        await writes.comment({
          issueNumber: item.issue,
          key: `groom-expired:${ctx.requestId}`,
          body: [
            `引擎的临时指挥官整理待办时判这张单可能已经过期或前提不成立：${reason}`,
            '',
            `没有关这张单（整理会话不能关单）。已贴「${GROOM_PENDING_LABEL}」：请人看过后决定关闭，或补好前提后摘掉标签。贴着「${GROOM_PENDING_LABEL}」的单引擎不拉。`,
          ].join('\n'),
        });
        await label(item.issue, GROOM_PENDING_LABEL, issue);
      });
      if (ok) suggestedClose.push(item.issue);
    } else {
      const ok = await act(what, async () => {
        await writes.comment({
          issueNumber: item.issue,
          key: `groom-human:${ctx.requestId}`,
          body: [
            `引擎的临时指挥官整理待办时认为这张单要人先拍板：${reason}`,
            '',
            `已贴「${HUMAN_DECISION_LABEL}」，引擎不拉。人看过后摘掉标签，才会进引擎的候选。`,
          ].join('\n'),
        });
        await label(item.issue, HUMAN_DECISION_LABEL, issue);
      });
      if (ok) flagged.push(item.issue);
    }
  }

  // 2. 补老单（amendments）
  let amends = 0;
  for (const { index, item } of plan.amendments) {
    const what = `amendments[${index}] #${item.issue}`;
    const issue = ctx.trusted.get(item.issue);
    if (!issue) {
      rejected.push({ what, why: '不是开着的、作者在白名单里的单' });
      continue;
    }
    if (amends >= GROOM_MAX_AMENDS) {
      rejected.push({ what, why: `超过每次最多补写 ${GROOM_MAX_AMENDS} 张` });
      continue;
    }
    const present = presentSections(issue.body);
    if (present.amended) {
      rejected.push({ what, why: `已经有「## ${AMEND_HEADING}」，不重复补` });
      continue;
    }
    const include = { scene: !present.scene, modules: !present.modules, done: !present.done };
    const usable =
      (include.scene && item.scene) ||
      (include.modules && item.modules) ||
      (include.done && item.done) ||
      item.note;
    if (!usable) {
      rejected.push({ what, why: '要补的节老单里都已经写了：原文不改，没有可补的' });
      continue;
    }
    amends += 1;
    const text = renderAmendment(item, include, date);
    const reason = item.needsHuman ?? humanDecisionReason(text, ctx.standardPaths);
    const verdict = judged.get(item.issue);
    const ok = await act(what, async () => {
      await writes.appendBody({ issueNumber: item.issue, key: `groom-amend:${ctx.requestId}`, text });
      if (reason !== null) await label(item.issue, HUMAN_DECISION_LABEL, issue);
      else if (verdict === undefined || verdict === 'sound') await label(item.issue, GROOMED_LABEL, issue);
    });
    if (ok) {
      amended.push(item.issue);
      if (reason !== null) flagged.push(item.issue);
      else if (verdict === undefined || verdict === 'sound') groomed.push(item.issue);
    }
  }

  // 3. 开新单（newIssues）
  const candidates: SimilarCandidate[] = [...ctx.similar];
  const splits = new Map<number, number[]>();
  for (const { index, item } of plan.newIssues) {
    const what = `newIssues[${index}] 「${item.title}」`;
    if (opened.length >= GROOM_MAX_NEW_ISSUES) {
      rejected.push({ what, why: `超过每次最多开 ${GROOM_MAX_NEW_ISSUES} 张` });
      continue;
    }
    if (item.splitFrom !== undefined && !ctx.trusted.has(item.splitFrom)) {
      rejected.push({ what, why: `splitFrom #${item.splitFrom} 不是开着的、作者在白名单里的单` });
      continue;
    }
    const title = item.title.replace(/\s+/g, ' ').trim();
    const body = renderNewIssueBody(item);
    // 开单脚本同一份判法再核一遍：模板拼错了、会话塞进了「涉及面」都在这里挡
    const problems = requiredSectionProblems(parseMd('body.md', body));
    if (problems.length > 0 || doneSection(parseMd('body.md', body)) !== 'ok') {
      rejected.push({ what, why: problems[0]?.why ?? '「怎么算做完」一节是空的' });
      continue;
    }
    const similar = rankSimilar({ title, body }, candidates);
    if (similar.length > 0) {
      const top = similar[0];
      rejected.push({
        what,
        why: `和 #${top?.number}（${top?.kind === 'pull' ? '已合并的 PR' : '单'}「${top?.title}」）像：${top?.why}，不重复开`,
      });
      continue;
    }
    const reason = item.needsHuman ?? humanDecisionReason(`${title}\n${body}`, ctx.standardPaths);
    let number = 0;
    const ok = await act(what, async () => {
      const got = await writes.openIssue({
        key: `groom:${ctx.requestId}:${index}`,
        title,
        body,
        labels: [item.kind, ...(reason === null ? [] : [HUMAN_DECISION_LABEL])],
      });
      number = got.number;
    });
    if (!ok) continue;
    opened.push({ number, title, ...(item.splitFrom === undefined ? {} : { splitFrom: item.splitFrom }) });
    if (reason !== null) flagged.push(number);
    candidates.push({ number, title, body, kind: 'issue' });
    if (item.splitFrom !== undefined)
      splits.set(item.splitFrom, [...(splits.get(item.splitFrom) ?? []), number]);
  }
  // 拆大单：在大单上留言列出拆出来的小单（不开子单）
  for (const [big, children] of splits) {
    await act(`留言 #${big}（拆分）`, async () => {
      await writes.comment({
        issueNumber: big,
        key: `groom-split:${ctx.requestId}`,
        body: `引擎的临时指挥官整理待办时把这张单拆成了独立小单：${children.map((n) => `#${n}`).join('、')}（不是子单，各自独立排期）。这张大单没有动。`,
      });
    });
  }

  return {
    result: { opened, amended, groomed, suggestedClose, flagged, rejected },
    attempted,
    failed,
  };
}
