// 会话的活怎么交代、交回来的东西怎么认（真会话端口用）。
// 交代：每个阶段一份提示词（中文，只写会话要知道的：干什么、在哪干、怎么汇报、怎么交）。续会话只补这一轮新的东西。
// 交回：写码类用 fleet done（后端核实、写进库），会话结束后引擎自己看工作树拿头和改动；分诊、需求文档、方案、审查
// 把结论写进检出副本里的 .fleet-out/ 下几个文件，引擎读出来按形状核对——对不上明确算「交错了」，不猜、不补默认值。

import type { Repo, StageKind } from '@fleet-dao/shared';
import type { PlannedSubtask, Risk, SubtaskStage } from '../decisions/plan.ts';
import type { TriageVerdict } from '../decisions/triage.ts';
import type { Finding, ReviewResult } from '../decisions/verify.ts';
import type { SessionBrief } from '../ports.ts';
import { checkPlanLine, PLAN_LINE_HINT, planLineOf } from './spec-doc.ts';

/** 非写码阶段的结论写在检出副本的这个目录下（相对路径）。 */
export const OUT_DIR = '.fleet-out';

export type OutputKind = 'triage' | 'doc' | 'plan' | 'review' | 'delivery';

/** 这个阶段该交回什么。judge 不起会话（判断题走 Jev），问到就是用错了。 */
export function outputKindOf(stage: StageKind): OutputKind {
  switch (stage) {
    case 'triage':
      return 'triage';
    case 'spec':
      return 'doc';
    case 'plan':
      return 'plan';
    case 'review':
      return 'review';
    case 'execute':
    case 'ui':
    case 'research':
      return 'delivery';
    case 'judge':
      throw new Error('judge 阶段不起会话（判断题走 Jev）');
  }
}

/** 各阶段要读的输出文件（相对检出副本）。 */
export const OUTPUT_FILES = {
  triage: [`${OUT_DIR}/triage.json`],
  doc: [`${OUT_DIR}/doc.md`],
  plan: [`${OUT_DIR}/plan.md`, `${OUT_DIR}/plan.json`],
  review: [`${OUT_DIR}/review.json`],
  delivery: [],
} as const satisfies Record<OutputKind, readonly string[]>;

/** 接力任务书：换了会话用户、又不能 fork 续时，从库和工作树拼出来的「做到哪了」。 */
export interface RelayFacts {
  /** 上一个会话最后一次报的步骤清单。 */
  steps: { title: string; state: string }[];
  /** 最近几句白话进度（老的在前）。 */
  says: string[];
  /** 工作树里起会话前的头之后已经提交的（git log --oneline，老的在前）。 */
  commits: string[];
  /** 已提交改动的文件统计（git diff --stat 的最后几行）。 */
  diffstat: string[];
  /** 上一个会话为什么断了。 */
  why: string;
}

export interface PromptInput {
  stage: StageKind;
  brief: SessionBrief;
  repo: Pick<Repo, 'owner' | 'name' | 'defaultBranch' | 'testCommand'>;
  issueNumber: number;
  /** new = 新会话；resume / fork = 带着上下文接着干（只补新东西）；relay = 新会话 + 接力任务书。 */
  mode: 'new' | 'resume' | 'fork' | 'relay';
  /** 上一轮结束时的问题（续会话时告诉它上一轮哪里没过）。 */
  previousProblem?: string | undefined;
  relay?: RelayFacts | undefined;
}

const list = (items: readonly string[], empty = '（无）') =>
  items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : empty;

const FEEDBACK_KIND: Record<SessionBrief['feedback'][number]['kind'], string> = {
  ci: 'CI 没过',
  review: '审查意见',
  conflict: '和主线冲突',
  'merge-return': '合并队列退回',
  plan: '和方案对不上',
  hygiene: '卫生检查拦下',
  delivery: '交付没过核对',
};

function feedbackBlock(brief: SessionBrief): string {
  if (brief.feedback.length === 0) return '';
  const parts = brief.feedback.map(
    (f) => `### ${FEEDBACK_KIND[f.kind]}：${f.summary}\n${list(f.items, '（没有细节）')}`,
  );
  return `\n## 这一轮要改的（返工意见）\n${parts.join('\n\n')}\n`;
}

function answersBlock(brief: SessionBrief): string {
  if (brief.answers.length === 0) return '';
  return `\n## 问过创始人的\n${brief.answers.map((a) => `- 问：${a.question}\n  答：${a.answer}`).join('\n')}\n`;
}

const RULES = `## 规矩
- 当前目录是这个仓的一份副本。只在本地干活：不 push、不开 PR、不改 git 远端——推分支、开 PR 由引擎在外面做，这里也没有任何 GitHub 凭据。
- 没人盯着屏幕。报进度用 \`fleet plan\`（步骤清单，每推进一步整张重报）和 \`fleet say\`（一句白话）；要创始人拍板用 \`fleet ask\`；卡住、缺权限、缺信息用 \`fleet blocked\`。\`fleet --help\` 看用法。
- 不编造：没查成就写没查成。公开仓：密钥、账号、组织编号、邮箱、IP 一律不写进仓。`;

function taskBlock(input: PromptInput): string {
  const { brief, repo } = input;
  return [
    `## 任务`,
    `仓：${repo.owner}/${repo.name}（主线 ${repo.defaultBranch}），需求 #${input.issueNumber}：${brief.title}`,
    `原话 / 说明：\n${brief.request}`,
    brief.specDir ? `需求文档目录：${brief.specDir}` : '',
    brief.acceptance.length > 0 ? `做完标准：\n${list(brief.acceptance)}` : '',
    brief.touches.length > 0 ? `会改的地方：\n${list(brief.touches)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function relayBlock(relay: RelayFacts): string {
  return `
## 接力：前一个会话断了（${relay.why}），你接着干
已提交的不重做：先看一眼下面的提交和当前目录里的代码，再从没做完的地方接着干。
前一个会话的步骤清单：
${list(relay.steps.map((s) => `[${s.state}] ${s.title}`))}
最近的进度：
${list(relay.says)}
已经提交的（起会话前的头之后）：
${list(relay.commits)}
${relay.diffstat.length > 0 ? `改动统计：\n${relay.diffstat.join('\n')}\n` : ''}`;
}

function deliverBlock(input: PromptInput): string {
  const kind = outputKindOf(input.stage);
  const { brief, repo } = input;
  switch (kind) {
    case 'triage':
      return `## 你要做的：分诊
读原话，必要时翻一下仓里相关的代码（不改任何文件），判断这件事：清不清楚、多大、是不是 UI 活、会不会碰对外发布（release）、花钱（spend）、删数据（delete）。
把结论写进 \`${OUT_DIR}/triage.json\`（只写这一个文件），形如：
{"clear": true, "question": "", "summary": "三行以内：理解为……", "size": "S", "ui": false, "holds": []}
- clear：清楚 true；有说不清、会做错方向的地方 false（这时 question 写要问创始人的那一句，一句话、能直接回答）；判不了 null。
- size：S / M / L。holds：会碰到的写 "release" / "spend" / "delete"，都不碰就空数组。
写完就结束，不用 fleet done。`;
    case 'doc':
      return `## 你要做的：写需求文档
按原话写这份需求的「需求.md」：要什么、怎么算做完（一页以内，写给人和以后的 AI 看，不写套话）。先翻一下仓里以前改过同一块地方的需求（specs/ 下），再写。
标题下面${PLAN_LINE_HINT}（照 plan.md 里那一条抄原话；引擎开 PR 时照这一行填「对应计划」，缺了会退回来补）。
写进 \`${OUT_DIR}/doc.md\`（只写这一个文件，不改仓里别的文件）。写完就结束，不用 fleet done。`;
    case 'plan':
      return `## 你要做的：写方案、拆子任务
读需求文档${brief.specDir ? `（${brief.specDir}/需求.md）` : ''}和相关代码，写「方案.md」：怎么做、拆成哪几块、各改哪里、先后依赖（一两页以内）。写进 \`${OUT_DIR}/plan.md\`。
子任务清单写进 \`${OUT_DIR}/plan.json\`，是一个数组，每条形如：
{"key": "login-form", "title": "登录表单加验证码输入", "touches": ["src/login/"], "dependsOn": [], "stage": "execute", "risk": "normal", "acceptance": ["……"], "holds": []}
- key：小写字母、数字、连字符，子任务之间不重复；dependsOn 写别的子任务的 key。
- touches：会改的文件或目录（前缀相同算同一块地方，引擎据此排先后，别漏写——没写就当整个仓，跟谁都撞）。
- stage：写码是 "execute"，界面活是 "ui"。risk：纯文档这类写 "low"（不要第二意见），一般 "normal"，碰钱、数据、发布的 "high"。
- holds：会对外发布、花钱、删数据的写 "release" / "spend" / "delete"（合并前要人批）。
一个子任务一个会话能做完、各自能单独合进主线。只写这两个文件，不改仓里别的文件。写完就结束，不用 fleet done。`;
    case 'review':
      return `## 你要做的：审查（第二意见）
审 PR #${brief.prNumber ?? '?'} 的头 ${brief.head ?? '（没给）'}：当前目录已经检出这个头（和主线比：git diff ${repo.defaultBranch}...HEAD 看不了就用 git log 找起点）。对照上面的需求和做完标准：做对了没有、有没有漏、有没有会出事的地方。可以跑测试（${repo.testCommand}）。不改任何文件。
结论写进 \`${OUT_DIR}/review.json\`，形如：
{"verdict": "pass", "findings": [{"severity": "blocking", "text": "……", "file": "src/a.ts"}]}
- verdict：能合 "pass"，要改 "changes"。blocking = 必须改才能合；minor = 小毛病，不挡合并。
写完就结束，不用 fleet done。`;
    case 'delivery':
      return `## 你要做的：写码
在当前目录（分支 ${brief.branch ?? '（没给）'}）上把活干完：改代码、补测试，跑 \`${repo.testCommand}\` 看过。
- 改动用 git commit 提交在本地（可以多次提交）；交活前工作区里不能有没提交的已跟踪改动。
- 做完标准都满足了再交：\`fleet done "<一两句总结：做了什么>" --tests passed\`（测试没过就写 --tests failed，并在总结里说清）。后端会核实，没核实过会退回。
- 做不下去就 \`fleet blocked "<卡在哪>" --needs human|info|access|other\`，别硬交。`;
  }
}

/** 起会话的提示词。 */
export function stagePrompt(input: PromptInput): string {
  const problem = input.previousProblem?.trim()
    ? `\n上一轮结束时的问题：${input.previousProblem.trim()}\n`
    : '';
  if (input.mode === 'resume' || input.mode === 'fork') {
    return [
      `接着干${problem ? '' : '。'}${problem}`,
      feedbackBlock(input.brief),
      answersBlock(input.brief),
      deliverBlock(input),
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `你是 fleet 派的无头会话，在仓 ${input.repo.owner}/${input.repo.name} 上干需求 #${input.issueNumber} 的一部分。`,
    taskBlock(input),
    feedbackBlock(input.brief),
    answersBlock(input.brief),
    input.mode === 'relay' && input.relay ? relayBlock(input.relay) : '',
    problem,
    deliverBlock(input),
    RULES,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---- 认交回来的东西。形状不对就返回 { error }，调用方按「交错了」处理（失败分流 DL1：告诉它缺什么再交）。

export type Parsed<T> = { ok: T } | { error: string };

function parseJson(text: string, what: string): Parsed<unknown> {
  try {
    return { ok: JSON.parse(text) as unknown };
  } catch (error) {
    return { error: `${what} 不是合法的 JSON（${error instanceof Error ? error.message : String(error)}）` };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

export function parseTriage(text: string): Parsed<TriageVerdict> {
  const json = parseJson(text, `${OUT_DIR}/triage.json`);
  if ('error' in json) return json;
  const v = json.ok;
  if (!isRecord(v)) return { error: 'triage.json 要是一个对象' };
  if (!(v.clear === true || v.clear === false || v.clear === null)) {
    return { error: 'triage.json 的 clear 要是 true、false 或 null' };
  }
  const out: TriageVerdict = { clear: v.clear };
  if (v.question !== undefined) {
    if (typeof v.question !== 'string') return { error: 'triage.json 的 question 要是字符串' };
    if (v.question.trim()) out.question = v.question.trim();
  }
  if (v.summary !== undefined) {
    if (typeof v.summary !== 'string') return { error: 'triage.json 的 summary 要是字符串' };
    if (v.summary.trim()) out.summary = v.summary.trim();
  }
  if (v.size !== undefined) {
    if (v.size !== 'S' && v.size !== 'M' && v.size !== 'L')
      return { error: 'triage.json 的 size 要是 S、M、L' };
    out.size = v.size;
  }
  if (v.ui !== undefined) {
    if (typeof v.ui !== 'boolean') return { error: 'triage.json 的 ui 要是 true 或 false' };
    out.ui = v.ui;
  }
  if (v.holds !== undefined) {
    if (!isStringArray(v.holds)) return { error: 'triage.json 的 holds 要是字符串数组' };
    out.holds = v.holds;
  }
  if (out.clear === false && !out.question) {
    return { error: 'triage.json 说不清楚（clear=false），却没写要问创始人的那一句（question）' };
  }
  return { ok: out };
}

/** 需求文档、方案的正文上限：写进 GitHub 的文件不过 1 MB，一页纸远到不了；超了多半是把别的东西写进来了。 */
export const DOC_MAX_CHARS = 200_000;

export function parseDoc(text: string, what = `${OUT_DIR}/doc.md`): Parsed<string> {
  const markdown = text.replace(/^﻿/, '');
  if (!markdown.trim()) return { error: `${what} 是空的` };
  if (markdown.length > DOC_MAX_CHARS)
    return { error: `${what} 太长（${markdown.length} 字，上限 ${DOC_MAX_CHARS}）` };
  return { ok: markdown };
}

/**
 * 需求文档：除了不空、不过长，还要有「对应计划：」那一行，而且指得到仓里 plan.md 的哪一条（和 #41 的 pr-fields
 * 判同一套；仓里没有 plan.md 就写「无」）。planMarkdown 是检出副本里 plan.md 的内容，没有传 undefined。
 */
export function parseRequirementDoc(text: string, planMarkdown?: string | undefined): Parsed<string> {
  const doc = parseDoc(text);
  if ('error' in doc) return doc;
  const plan = planLineOf(doc.ok);
  if ('error' in plan) return { error: `${OUT_DIR}/doc.md ${plan.error}：${PLAN_LINE_HINT}` };
  const problem = checkPlanLine(plan.ok, planMarkdown);
  if (problem)
    return { error: `${OUT_DIR}/doc.md 的「对应计划：${plan.ok}」对不上：${problem}。${PLAN_LINE_HINT}` };
  return doc;
}

const STAGES: readonly SubtaskStage[] = ['execute', 'ui'];
const RISKS: readonly Risk[] = ['low', 'normal', 'high'];

export function parsePlan(
  markdownText: string,
  jsonText: string,
): Parsed<{ markdown: string; subtasks: PlannedSubtask[] }> {
  const markdown = parseDoc(markdownText, `${OUT_DIR}/plan.md`);
  if ('error' in markdown) return markdown;
  const json = parseJson(jsonText, `${OUT_DIR}/plan.json`);
  if ('error' in json) return json;
  if (!Array.isArray(json.ok)) return { error: 'plan.json 要是一个数组（子任务清单）' };
  if (json.ok.length === 0) return { error: 'plan.json 一个子任务都没有' };
  const subtasks: PlannedSubtask[] = [];
  for (const [i, raw] of json.ok.entries()) {
    const at = `plan.json 第 ${i + 1} 条`;
    if (!isRecord(raw)) return { error: `${at} 要是一个对象` };
    if (typeof raw.key !== 'string' || !raw.key.trim()) return { error: `${at} 缺 key` };
    if (typeof raw.title !== 'string' || !raw.title.trim()) return { error: `${at} 缺 title` };
    const item: PlannedSubtask = { key: raw.key.trim(), title: raw.title.trim() };
    for (const field of ['touches', 'dependsOn', 'acceptance', 'holds'] as const) {
      const value = raw[field];
      if (value === undefined) continue;
      if (!isStringArray(value)) return { error: `${at} 的 ${field} 要是字符串数组` };
      item[field] = value;
    }
    if (raw.stage !== undefined) {
      if (!STAGES.includes(raw.stage as SubtaskStage)) return { error: `${at} 的 stage 要是 execute 或 ui` };
      item.stage = raw.stage as SubtaskStage;
    }
    if (raw.risk !== undefined) {
      if (!RISKS.includes(raw.risk as Risk)) return { error: `${at} 的 risk 要是 low、normal 或 high` };
      item.risk = raw.risk as Risk;
    }
    subtasks.push(item);
  }
  return { ok: { markdown: markdown.ok, subtasks } };
}

export function parseReview(text: string, head: string): Parsed<ReviewResult> {
  const json = parseJson(text, `${OUT_DIR}/review.json`);
  if ('error' in json) return json;
  const v = json.ok;
  if (!isRecord(v)) return { error: 'review.json 要是一个对象' };
  if (v.verdict !== 'pass' && v.verdict !== 'changes') {
    return { error: 'review.json 的 verdict 要是 pass 或 changes' };
  }
  const rawFindings = v.findings ?? [];
  if (!Array.isArray(rawFindings)) return { error: 'review.json 的 findings 要是数组' };
  const findings: Finding[] = [];
  for (const [i, raw] of rawFindings.entries()) {
    const at = `review.json 第 ${i + 1} 条意见`;
    if (!isRecord(raw)) return { error: `${at} 要是一个对象` };
    if (raw.severity !== 'blocking' && raw.severity !== 'minor') {
      return { error: `${at} 的 severity 要是 blocking 或 minor` };
    }
    if (typeof raw.text !== 'string' || !raw.text.trim()) return { error: `${at} 缺 text` };
    const finding: Finding = { severity: raw.severity, text: raw.text.trim() };
    if (raw.file !== undefined) {
      if (typeof raw.file !== 'string') return { error: `${at} 的 file 要是字符串` };
      if (raw.file.trim()) finding.file = raw.file.trim();
    }
    findings.push(finding);
  }
  if (v.verdict === 'changes' && !findings.some((f) => f.severity === 'blocking')) {
    return { error: 'review.json 说要改（changes），却一条必须改的（blocking）意见都没写' };
  }
  return { ok: { verdict: v.verdict, head, findings } };
}
