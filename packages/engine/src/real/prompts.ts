// 会话的活怎么交代、交回来的东西怎么认（真会话端口用）。
// 交代：每个阶段一份提示词（中文，只写会话要知道的：干什么、在哪干、怎么汇报、怎么交）。续会话只补这一轮新的东西。
// 交回：写码类用 fleet done（后端核实、写进库），会话结束后引擎自己看工作树拿头和改动；分诊、需求文档、方案、审查
// 把结论写进检出副本里的 .fleet-out/ 下几个文件，引擎读出来按形状核对——对不上明确算「交错了」，不猜、不补默认值。
// Fusion 的 Lead（brief.lead）每一步都在这张单的工作树里跑、续同一个会话：交什么按这一步定（LEAD_KIND），结论也写进
// .fleet-out/（工作树里记进 .git/info/exclude，不会被提交）；写方案、写结果那两步另外在分支上提交，头和改动引擎从提交里读。

import { checkReport, outsideBrief, type Rebuttal, type VerifyReport } from '@fleet-dao/core';
import type { Repo, StageKind } from '@fleet-dao/shared';
import type { PlannedSubtask, Risk, SubtaskStage } from '../decisions/plan.ts';
import type { TriageVerdict } from '../decisions/triage.ts';
import type { Finding, ReviewResult } from '../decisions/verify.ts';
import type { LeadBrief, LeadStep, SessionBrief } from '../ports.ts';
import { type AnyBrief, AnyBriefSchema } from '../runner/brief.ts';
import { checkPlanLine, PLAN_LINE_HINT, planLineOf } from './spec-doc.ts';

/** 非写码阶段的结论写在检出副本的这个目录下（相对路径）。 */
export const OUT_DIR = '.fleet-out';

/** 按阶段交的几种（旧的需求工作流、子任务、开 PR 前验证、Fusion 的副手）。 */
export type StageOutputKind = 'triage' | 'doc' | 'plan' | 'review' | 'verify' | 'delivery';
/** Fusion 的 Lead 按这一步交的几种（Lead 自己写码那一步交 delivery，和副手一样）。 */
export type LeadOutputKind =
  | 'lead-plan'
  | 'lead-verdict'
  | 'lead-rebut'
  | 'lead-brief'
  | 'lead-review'
  | 'lead-text';
export type OutputKind = StageOutputKind | LeadOutputKind;

/** Lead 的每一步交什么（ports.ts 的 SessionOutput 里 lead-* 那几种）。 */
export const LEAD_KIND: Readonly<Record<LeadStep, LeadOutputKind | 'delivery'>> = {
  plan: 'lead-plan',
  accept: 'lead-verdict',
  rebut: 'lead-rebut',
  'fix-brief': 'lead-brief',
  review: 'lead-review',
  'pr-text': 'lead-text',
  takeover: 'delivery',
};

export function isLeadKind(kind: OutputKind): kind is LeadOutputKind {
  return kind.startsWith('lead-');
}

/** 这一次会话该交回什么：Lead 按简报里的这一步（brief.lead），别的按阶段。 */
export function outputKindFor(stage: StageKind, brief: Pick<SessionBrief, 'lead'>): OutputKind {
  return brief.lead ? LEAD_KIND[brief.lead.step] : outputKindOf(stage);
}

/** 这个阶段该交回什么。judge 不起会话（判断题走 Jev），问到就是用错了。 */
export function outputKindOf(stage: StageKind): StageOutputKind {
  switch (stage) {
    case 'triage':
      return 'triage';
    case 'spec':
      return 'doc';
    case 'plan':
      return 'plan';
    case 'review':
      return 'review';
    case 'verify':
      return 'verify';
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
  verify: [`${OUT_DIR}/verify.json`],
  delivery: [],
  'lead-plan': [`${OUT_DIR}/lead-plan.json`],
  'lead-verdict': [`${OUT_DIR}/lead-verdict.json`],
  'lead-rebut': [`${OUT_DIR}/lead-rebut.json`],
  'lead-brief': [`${OUT_DIR}/lead-brief.json`],
  'lead-review': [`${OUT_DIR}/lead-review.json`],
  'lead-text': [`${OUT_DIR}/lead-text.json`],
} as const satisfies Record<OutputKind, readonly string[]>;

/** 开 PR 前验证的提示词里最多列几个改到的文件（再多的让它看 git diff）。 */
export const VERIFY_FILES_SHOWN = 200;

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
  repo: Pick<Repo, 'owner' | 'name' | 'defaultBranch'> & {
    /**
     * 这次交代的测试命令（仓的流程配置副本里的，起会话时记进 session_runs、交活核对认它）。写码阶段一定有——项目没写
     * 就起不来（flow-gate.ts）；别的阶段项目没写就是 null，提示词里不提跑测试。
     */
    testCommand: string | null;
  };
  issueNumber: number;
  /** new = 新会话；resume / fork = 带着上下文接着干（只补新东西）；relay = 新会话 + 接力任务书。 */
  mode: 'new' | 'resume' | 'fork' | 'relay';
  /** 上一轮结束时的问题（续会话时告诉它上一轮哪里没过）。 */
  previousProblem?: string | undefined;
  relay?: RelayFacts | undefined;
  /**
   * 起会话时工作树里没提交的改动（git status --porcelain 的行）：多半是上一个会话没做完就断了留下的（发布停机、续会话起不来退回
   * 别的会话，2026-09-28 #276 丢过 26 个文件的改动）。{ error } = 没查成，照实告诉它自己看。
   */
  leftover?: string[] | { error: string } | undefined;
}

/** 工作树里有上一个会话没提交的改动：先读再接着做，别从头重写、别丢。没查成照实说。 */
export function leftoverBlock(leftover: PromptInput['leftover']): string {
  if (!leftover) return '';
  if (!Array.isArray(leftover)) {
    return `没查成工作树里有没有上一个会话没提交的改动（${leftover.error}）：先自己 git status、git diff 看一眼再接着做。`;
  }
  if (leftover.length === 0) return '';
  const shown = leftover.slice(0, 20).map((l) => `- ${l}`);
  if (leftover.length > 20) shown.push(`- ……还有 ${leftover.length - 20} 个`);
  return [
    `工作树里有上一个会话没提交的改动（${leftover.length} 个文件，多半是它没做完就断了）：先读 git status、git diff 看清做到了哪，在它上面接着做；别当成没做过从头重写，也别丢掉。`,
    ...shown,
  ].join('\n');
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
  ask: '要带推荐重问',
  answer: '创始人改选了',
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
- 没人盯着屏幕。报进度用 \`fleet plan\`（步骤清单，每推进一步整张重报）和 \`fleet say\`（一句白话）；卡住、缺权限用 \`fleet blocked\`。\`fleet --help\` 看用法。
- 要创始人拍板用 \`fleet ask "<问题>" -o <甲> -o <乙> -r <推荐的>\`：一定带选项和推荐。他多半不在场，命令当场返回、不等回答——按推荐接着干，交活总结里写上按推荐先做了什么；他之后改了，下一个存档点会告诉你。超出这张单范围的加 \`--outside\`（另开一张单，这里绕开它接着做）；碰对外发布、花钱、删数据、改标准的加 \`--hold release|spend|delete|standard\`（也先按推荐做，合并前等他批）。只有他本人才有的东西（账号、权限、登录）用 \`fleet blocked "<缺什么>" --needs access\`。
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
    // Fusion 的副手：简报外的由 Lead 验收时定收不收（core 的 decideAcceptance），它要知道为什么改了才判得了
    brief.task && !brief.lead
      ? '「会改的地方」以外的文件非改不可才改，交活总结里写清改了哪个、为什么（Lead 验收时看过再定收不收）。'
      : '',
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
  if (input.brief.lead) return leadBlock(input, input.brief.lead);
  const kind = outputKindOf(input.stage);
  const { brief, repo } = input;
  switch (kind) {
    case 'triage':
      return `## 你要做的：分诊
读原话，必要时翻一下仓里相关的代码（不改任何文件），判断这件事：清不清楚、多大、是不是 UI 活、会不会碰对外发布（release）、花钱（spend）、删数据（delete）。
把结论写进 \`${OUT_DIR}/triage.json\`（只写这一个文件），形如：
{"clear": true, "question": "", "options": [], "recommend": "", "summary": "三行以内：理解为……", "size": "S", "ui": false, "holds": []}
- clear：清楚 true；有说不清、会做错方向的地方 false；判不了 null。
- clear 是 false 时：question 写要问创始人的那一句（一句话、能直接回答），options 写 2–4 个做法，recommend 照抄你推荐的那一个。他多半不在场，引擎按推荐先做、不停下等；他之后改了，另开单照他选的改。
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
- stage：写码是 "execute"，界面活是 "ui"。risk：纯文档、小配置写 "low"；一般改动写 "normal"（CI 绿就合，合并前不审）；碰安全、权限、数据（迁移、删改）、往公开处写东西、系统核心的写 "high"（合并前另一个会话审一次）。拿不准写 "high"。
- holds：会对外发布、花钱、删数据的写 "release" / "spend" / "delete"（合并前要人批）。
一个子任务一个会话能做完、各自能单独合进主线。只写这两个文件，不改仓里别的文件。写完就结束，不用 fleet done。`;
    case 'review':
      return `## 你要做的：审查（第二意见）
审 PR #${brief.prNumber ?? '?'} 的头 ${brief.head ?? '（没给）'}：当前目录已经检出这个头，主线在 origin/${repo.defaultBranch}（git diff origin/${repo.defaultBranch}...HEAD 就是这个 PR 改的）。对照上面的需求和做完标准：做对了没有、有没有漏、有没有会出事的地方。${repo.testCommand ? `可以跑测试（${repo.testCommand}）。` : ''}不改任何文件。
结论写进 \`${OUT_DIR}/review.json\`，形如：
{"verdict": "pass", "findings": [{"severity": "blocking", "text": "……", "file": "src/a.ts"}]}
- verdict：能合 "pass"，要改 "changes"。blocking = 必须改才能合；minor = 小毛病，不挡合并。
- 结果文档里引的 CI 运行对不上这个头，不算 blocking：文档只能引写它之前那次运行，写完提交、并主线都会换头；能不能合由合并闸看当前头的检查。只有文档说的和事实相反（红说成绿、没跑说成跑过）才算。
- 测试和类型检查一个跑完再跑下一个，别同时开：会话的内存有上限，同时开会被压着回收、卡住不动。
写完就结束，不用 fleet done。`;
    case 'verify':
      return verifyBlock(input);
    case 'delivery':
      return codeBlock(input);
  }
}

/** 写码（副手、旧的子任务、Lead 自己接手）：改代码、补测试、提交，fleet done 交活。 */
function codeBlock(input: PromptInput): string {
  const { brief, repo } = input;
  const test = repo.testCommand;
  // 写码阶段（execute、ui）一定有测试命令（没有起不来）；只有调研这类不核对测试的活会走到「没写」
  const tests = test
    ? `跑 \`${test}\` 看过。
- 交活只认会话里原样跑的 \`${test}\`、以最后一次为准：别接管道、别放后台（结果会记成「认不出」），别的测试命令不算。`
    : `这个项目没写测试命令（仓里 .fleet/flow.json 的 testCommand），交活不核对测试。`;
  return `## 你要做的：写码
在当前目录（分支 ${brief.branch ?? '（没给）'}）上把活干完：改代码、补测试，${tests}主线在 origin/${repo.defaultBranch}。
- 改动用 git commit 提交在本地（可以多次提交）；交活前工作区里不能有没提交的已跟踪改动。
- 做完标准都满足了再交：\`fleet done "<一两句总结：做了什么>" --tests passed\`（测试没过就写 --tests failed，并在总结里说清）。后端会核实，没核实过会退回。
- 做不下去就 \`fleet blocked "<卡在哪>" --needs human|info|access|other\`，别硬交；要他在几个做法里挑一个的不算卡住，用 \`fleet ask\` 带推荐、按推荐接着做。`;
}

/** 任务简报的形状（core 的 BriefSchema）：Lead 写给副手的，提示词里照这个给例子。 */
const BRIEF_SHAPE =
  '{"goal": "这块要做成什么", "scope": "做到哪为止、不碰什么", "constraints": ["约束，没有就空数组"], "files": ["只许改的文件，以 / 结尾的是目录"], "acceptance": ["怎么算合格，逐条"], "returnFormat": "交回什么：改了哪些文件、测试结果、没做完的"}';

const BLOCK_KIND: Record<NonNullable<LeadBrief['blocking']>[number]['kind'], string> = {
  'not-done': '没做到',
  'breaks-existing': '弄坏原有功能',
  security: '安全',
  'data-loss': '丢数据',
};

/**
 * Fusion 的 Lead 这一步要做的（docs/decisions/0003-fusion-flow.md 第 5 条）。Lead 一张单一个会话、每一步续上：第一步交代
 * 身份和规矩，之后每一步只补这一步的事。只看不改的几步（验收、驳回、写修复简报、重写 PR 摘要）不许提交、不许改文件，
 * 引擎交回之前核过（头没动、没有没提交的改动）。
 */
function leadBlock(input: PromptInput, lead: LeadBrief): string {
  const { brief, repo } = input;
  const main = repo.defaultBranch;
  const out = (kind: LeadOutputKind) => `\`${OUTPUT_FILES[kind][0]}\``;
  const readOnly = '这一步只看不改：不改仓里的文件、不提交，只写下面那一个结论文件。';
  const end = '写完就结束，不用 fleet done。';
  const notes = lead.notes?.length
    ? `\n验证模型另外的备注（看不出的、建议，不挡）：\n${list(lead.notes)}\n`
    : '';
  const tests = repo.testCommand ? `可以跑测试（\`${repo.testCommand}\`）。` : '';
  switch (lead.step) {
    case 'plan': {
      // 还没有需求文档、正文写全了需求的单（#295）：引擎照正文写好了，Lead 原样提交
      const seed = lead.requirementText?.trim();
      const read = seed
        ? `1. 这张单还没有需求文档，单子正文就是需求（引擎开的单）。把下面这份原样写进 \`${lead.docs.requirement}\`（一字不改；要补充、要澄清的写进方案），里面的「怎么算做完」就是验收标准，开 PR 前别家照单子正文逐条核。再读相关代码。
\`\`\`\`markdown
${seed}
\`\`\`\``
        : `1. 读需求文档 \`${lead.docs.requirement}\`（里面的「怎么算做完」就是验收标准，开 PR 前别家会逐条核）和相关代码。`;
      const commit = seed
        ? `用 git commit 提交在当前分支上（需求文档和方案一起）；这一步只提交这两份，不改代码。`
        : '用 git commit 提交在当前分支上；这一步只提交方案，不改代码。';
      return `## 你要做的：第 2 步 规划（你是这张单的主导模型 Lead）
这张单由你领着做完：你写方案和任务简报，副手（别家的模型）照简报写码、你验收；之后每一步引擎都会续你这个会话交代下一步。${lead.mode === 'single' ? '这次是单模型模式：没有副手，写码也是你自己（引擎下一步交代）。' : ''}当前目录是这张单的工作树（分支 ${brief.branch ?? '（没给）'}），主线在 origin/${main}。
${read}
2. 把方案写进 \`${lead.docs.plan}\`：怎么做、改哪些文件、怎么验证，一两页以内。${commit}
3. 写一份任务简报（副手照它干），连同方案摘要写进 ${out('lead-plan')}（只写这一个结论文件，它不会被提交），形如：
{"summary": "方案摘要，三五句（会写进公开的 PR 正文）", "small": true, "highRisk": false, "holds": [], "brief": ${BRIEF_SHAPE}}
- brief.files：副手要改的文件，把要改的地方都圈进去；副手改到外面的，验收时由你定收不收。
- small：一个副手一次做得完、方案不用别家评的写 true。highRisk：碰安全、权限、数据（迁移里删改）、对外发布的写 true。
- holds：会对外发布、花钱、删数据的写 "release" / "spend" / "delete"（合并前要人批），都不碰就空数组。
${end}`;
    }
    case 'accept': {
      const d = lead.delivery;
      const diff = d?.base
        ? `\`git diff ${d.base}..HEAD\` 就是副手交回的全部改动（打回过的几轮连在一起看；副手并过主线的话，主线带进来的改动也在这个 diff 里，那些不是副手改的、不算它改到简报外——上面列的文件已经扣掉了并进来的主线）。`
        : '';
      const outside = brief.task && d ? outsideBrief(brief.task, d.changedFiles) : [];
      return `## 你要做的：验收副手这一轮
副手照你的任务简报干完、交回了（它现在不在跑）：提交头 ${d?.head ?? '（没给）'}，${d?.testsPassed ? '它报测试过了' : '它报测试没过'}。它的总结：${d?.summary?.trim() || '（没写）'}
改了这些文件：
${list(d?.changedFiles ?? [])}
${outside.length ? `其中改到任务简报外的：${outside.join('、')}\n` : ''}${diff}对照任务简报（上面的「做完标准」「会改的地方」）看代码：做对了没有、有没有漏、测试够不够。改到简报外的文件，看过觉得该改就可以收，why 里写清为什么要改它们（收下的会记进 PR 正文或关单评论）；不该改的打回，写清要撤掉哪些。${tests}${readOnly}
结论写进 ${out('lead-verdict')}，形如：
{"verdict": "accept", "why": "……"}
- verdict：收下 "accept"，打回 "reject"。why 都要写：打回时写清要副手改什么（原样交给副手）。打回满两次还不行，下一步由你自己接手。
${end}`;
    }
    case 'rebut': {
      const blocking = (lead.blocking ?? []).map(
        (b) => `[${BLOCK_KIND[b.kind]}] ${b.target}（它的证据：${b.evidence}）`,
      );
      return `## 你要做的：看开 PR 前验证挡住的几条
别家的验证模型挡住了下面几条（原文照抄）：
${list(blocking)}
${notes}逐条对照代码核实。你有证据证明它看错了的写进驳回；它说得对的别驳，引擎会把它交回去改。${tests}${readOnly}
结论写进 ${out('lead-rebut')}，形如：
{"rebuttals": [{"target": "<照抄上面那一条的原文，连反引号；不带方括号里的类别和后面括号里它的证据>", "evidence": "哪个文件哪一行、跑了什么命令看到什么"}]}
- 一条都不驳就写 {"rebuttals": []}。没有证据的驳回不算数。
${end}`;
    }
    case 'fix-brief':
      return `## 你要做的：写修复简报
要回去改一轮（原因在上面「这一轮要改的」：CI 没过、合并前退回、最终审查要改，或者创始人晚到的回答改选了别的——没等他回时按推荐先做的，照他选的改）。看代码找到要改的地方，给副手写一份修复简报：只许改的文件要把要改的地方都圈进去。${readOnly}
写进 ${out('lead-brief')}，形如：
{"brief": ${BRIEF_SHAPE}}
${end}`;
    case 'review':
      return `## 你要做的：最终审查、写结果
PR 的 CI 绿了。\`git diff origin/${main}...HEAD\` 是这张单的全部改动：对照需求文档 \`${lead.docs.requirement}\` 的「怎么算做完」和你的方案 \`${lead.docs.plan}\` 最后看一遍。${tests}
${notes}- 过了：把结果写进 \`${lead.docs.result}\`（做了什么、怎么验证的、还欠什么），用 git commit 提交；结论写 {"verdict": "pass", "why": "……", "did": ["做了什么，一条一句，最多 5 条"], "owed": ["还欠什么，没有就空数组"]}。
- 要改：不提交，结论写 {"verdict": "fix", "why": "……", "did": [], "owed": [], "brief": ${BRIEF_SHAPE}}（修复简报，副手照它改）。
结论写进 ${out('lead-review')}（只写这一个结论文件）。${end}`;
    case 'pr-text':
      return `## 你要做的：重写 PR 正文里的方案摘要
开 PR 时正文被卫生检查拦下了（原因在上面「这一轮要改的」）：PR 正文是公开的，不许有密钥、账号、组织编号、邮箱、IP。${readOnly}
重写方案摘要和「做了什么」，写进 ${out('lead-text')}，形如：
{"summary": "方案摘要，三五句", "did": ["做了什么，一条一句"]}
${end}`;
    case 'takeover':
      return `## 这一块你自己写
${lead.why?.trim() || '这一块由你自己写'}。照任务简报（上面的「做完标准」「会改的地方」）把活干完。

${codeBlock(input)}`;
  }
}

/**
 * 开 PR 前验证（docs/decisions/0003-fusion-flow.md 第 5 条第 5 步）：别家对照「怎么算做完」逐条答做到 / 没做到 / 看不出、带证据，
 * 只报三种能挡的发现，其余写成建议。交回的形状照 core 的 ReportSchema。只读：检出的就是送检的头，只写结论文件。
 */
function verifyBlock(input: PromptInput): string {
  const { brief, repo } = input;
  const v = brief.verify;
  const head = brief.head ?? '（没给）';
  const files = v?.changedFiles ?? [];
  const shown = files.slice(0, VERIFY_FILES_SHOWN);
  const more = files.length > shown.length ? `\n- ……另有 ${files.length - shown.length} 个，看 git diff` : '';
  const main = repo.defaultBranch;
  return `## 你要做的：开 PR 前验证（别家核一遍）
这张单的改动是别的模型写的，还没开 PR。请你对照这张单的「怎么算做完」逐条核一遍。当前目录已经检出送检的提交 ${head}，主线在 origin/${main}：\`git diff origin/${main}...HEAD\` 就是这次的改动。只读：不改仓里的文件、不提交，只写下面那一个结论文件。${repo.testCommand ? `可以跑测试（\`${repo.testCommand}\`）。` : ''}

「怎么算做完」（逐条原文，出自 ${v?.specPath ?? '需求文档'}）：
${(v?.criteria ?? []).map((c, i) => `${i + 1}. ${c}`).join('\n') || '（没给）'}

方案摘要（写这张单的主导模型写的，只作参考，以代码为准）：
${v?.planSummary.trim() || '（没写）'}

改了 ${files.length} 个文件：
${list(shown)}${more}

怎么答：
- 「怎么算做完」每一条答一次：做到（done）、没做到（not-done）、看不出（unclear），都要带证据（哪个文件哪一行、跑了什么命令看到什么）。criterion 照清单原文逐字抄，连反引号、加粗这些记号也照抄，只是不带前面的序号；不多答、不漏答、不重复答。没有把握就答看不出，别猜成做到。
- 另外只报三种能挡的发现，都要有证据：弄坏原有功能（breaks-existing）、安全（security）、丢数据（data-loss）。别的意见一律写成建议（suggestion），不挡。

结论写进 \`${OUT_DIR}/verify.json\`（只写这一个文件），形如：
{"head": "${head}", "results": [{"criterion": "<照抄上面那一条的原文，连反引号>", "answer": "done", "evidence": "……"}], "findings": [{"kind": "security", "text": "……", "evidence": "……"}]}
- head 照抄送检的提交号（上面那一整串）。没有发现就写 "findings": []。
写完就结束，不用 fleet done。`;
}

/** 起会话的提示词。 */
export function stagePrompt(input: PromptInput): string {
  const problem = input.previousProblem?.trim()
    ? `\n上一轮结束时的问题：${input.previousProblem.trim()}\n`
    : '';
  if (input.mode === 'resume' || input.mode === 'fork') {
    return [
      // Lead 一张单一个会话、每一步续上：续上来不一定是接着上一轮没干完的，多半是新的一步
      input.brief.lead && !problem ? '这张单的下一步：' : `接着干${problem ? '' : '。'}${problem}`,
      feedbackBlock(input.brief),
      answersBlock(input.brief),
      leftoverBlock(input.leftover),
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
    leftoverBlock(input.leftover),
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
  // 选项和推荐合不合格（够不够两个、推荐在不在选项里）由引擎经 decide 调 core 的 checkAsk 判，这里只挡类型
  if (v.options !== undefined) {
    if (!isStringArray(v.options)) return { error: 'triage.json 的 options 要是字符串数组' };
    const options = v.options.map((o) => o.trim()).filter(Boolean);
    if (options.length > 0) out.options = options;
  }
  if (v.recommend !== undefined) {
    if (typeof v.recommend !== 'string') return { error: 'triage.json 的 recommend 要是字符串' };
    if (v.recommend.trim()) out.recommend = v.recommend.trim();
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

/**
 * 开 PR 前验证的结论文件：先得是 JSON，再过 core 的 checkReport（形状、审的是不是送检的头、「怎么算做完」一条不漏不多不重，
 * 按 criterionKey 对、交回的 criterion 换成清单原文）。对不上回 error，会话端口按「交错了」退回会话照原因重写；过了的定论
 * 照样由工作流经 decide 判（decideVerdict 用的是同一个 checkReport）。
 */
export function parseVerify(text: string, criteria: readonly string[], head: string): Parsed<VerifyReport> {
  const json = parseJson(text, `${OUT_DIR}/verify.json`);
  if ('error' in json) return json;
  const checked = checkReport(json.ok, criteria, head);
  return checked.ok ? { ok: checked.report } : { error: `${OUT_DIR}/verify.json ${checked.why}` };
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

// ---- Fusion 的 Lead 交回的结论文件。这里只挡形状（类型对不对、该有的有没有）：内容合不合格（简报齐不齐、方案提交了没有、
// 驳回成不成立）由工作流经 decide 调 core 判（checkLeadPlan、checkBrief、checkLeadReview、decideVerdict），这里不重复判，
// 也不补默认值。写方案、写结果那两步的头和改动不在文件里，由会话端口从提交里读。

type Fields = Record<string, unknown>;

function leadFile(text: string, kind: LeadOutputKind): Parsed<Fields> {
  const file = OUTPUT_FILES[kind][0];
  const json = parseJson(text, file);
  if ('error' in json) return json;
  return isRecord(json.ok) ? { ok: json.ok } : { error: `${file} 要是一个对象` };
}

/** 读一个字段：不空的字符串、true/false、每一项都不空的字符串数组、对象。认不出回 error，写明是哪个文件的哪个字段。 */
function reader(v: Fields, kind: LeadOutputKind) {
  const file = OUTPUT_FILES[kind][0];
  return {
    text(name: string): Parsed<string> {
      const x = v[name];
      return typeof x === 'string' && x.trim()
        ? { ok: x.trim() }
        : { error: `${file} 的 ${name} 要是不空的字符串` };
    },
    bool(name: string): Parsed<boolean> {
      const x = v[name];
      return typeof x === 'boolean' ? { ok: x } : { error: `${file} 的 ${name} 要是 true 或 false` };
    },
    texts(name: string): Parsed<string[]> {
      const x = v[name];
      if (!isStringArray(x)) return { error: `${file} 的 ${name} 要是字符串数组（没有就写 []）` };
      const items = x.map((s) => s.trim());
      return items.some((s) => !s) ? { error: `${file} 的 ${name} 里有空的一条` } : { ok: items };
    },
    object(name: string): Parsed<Fields> {
      const x = v[name];
      return isRecord(x) ? { ok: x } : { error: `${file} 的 ${name} 要是一个对象` };
    },
  };
}

type PlanFile = { summary: string; brief: unknown; small: boolean; highRisk: boolean; holds: string[] };

/** 第 2 步：方案摘要、任务简报、大小、风险、会碰的人闸（简报齐不齐由 core 的 checkBrief 判）。 */
export function parseLeadPlan(text: string): Parsed<PlanFile> {
  const v = leadFile(text, 'lead-plan');
  if ('error' in v) return v;
  const r = reader(v.ok, 'lead-plan');
  const summary = r.text('summary');
  if ('error' in summary) return summary;
  const brief = r.object('brief');
  if ('error' in brief) return brief;
  const small = r.bool('small');
  if ('error' in small) return small;
  const highRisk = r.bool('highRisk');
  if ('error' in highRisk) return highRisk;
  const holds = r.texts('holds');
  if ('error' in holds) return holds;
  return {
    ok: { summary: summary.ok, brief: brief.ok, small: small.ok, highRisk: highRisk.ok, holds: holds.ok },
  };
}

/** 验收：收下还是打回，都要写理由（打回的理由原样交给副手）。 */
export function parseLeadVerdict(text: string): Parsed<{ verdict: 'accept' | 'reject'; why: string }> {
  const v = leadFile(text, 'lead-verdict');
  if ('error' in v) return v;
  const verdict = v.ok.verdict;
  if (verdict !== 'accept' && verdict !== 'reject') {
    return { error: `${OUTPUT_FILES['lead-verdict'][0]} 的 verdict 要是 accept 或 reject` };
  }
  const why = reader(v.ok, 'lead-verdict').text('why');
  if ('error' in why) return why;
  return { ok: { verdict, why: why.ok } };
}

/** 驳回验证挡住的：target 照抄原文、evidence 写证据（成不成立由 core 的 decideVerdict 判）；一条不驳是空数组。 */
export function parseLeadRebut(text: string): Parsed<{ rebuttals: Rebuttal[] }> {
  const file = OUTPUT_FILES['lead-rebut'][0];
  const v = leadFile(text, 'lead-rebut');
  if ('error' in v) return v;
  const raw = v.ok.rebuttals;
  if (!Array.isArray(raw)) return { error: `${file} 的 rebuttals 要是数组（一条不驳就写 []）` };
  const rebuttals: Rebuttal[] = [];
  for (const [i, item] of raw.entries()) {
    const at = `${file} 第 ${i + 1} 条驳回`;
    if (!isRecord(item)) return { error: `${at} 要是一个对象` };
    if (typeof item.target !== 'string' || !item.target.trim()) {
      return { error: `${at} 缺 target（照抄挡住的那一条）` };
    }
    if (typeof item.evidence !== 'string') return { error: `${at} 的 evidence 要是字符串` };
    rebuttals.push({ target: item.target.trim(), evidence: item.evidence.trim() });
  }
  return { ok: { rebuttals } };
}

/** 修复简报（齐不齐由 core 的 checkBrief 判）。 */
export function parseLeadBrief(text: string): Parsed<{ brief: unknown }> {
  const v = leadFile(text, 'lead-brief');
  if ('error' in v) return v;
  const brief = reader(v.ok, 'lead-brief').object('brief');
  return 'error' in brief ? brief : { ok: { brief: brief.ok } };
}

type ReviewFile = { verdict: 'pass' | 'fix'; why: string; did: string[]; owed: string[]; brief?: unknown };

/** 最终审查：过了写做了什么、还欠什么；要改给修复简报（结果.md 提交了没有、简报齐不齐由 core 的 checkLeadReview 判）。 */
export function parseLeadReview(text: string): Parsed<ReviewFile> {
  const file = OUTPUT_FILES['lead-review'][0];
  const v = leadFile(text, 'lead-review');
  if ('error' in v) return v;
  const verdict = v.ok.verdict;
  if (verdict !== 'pass' && verdict !== 'fix') return { error: `${file} 的 verdict 要是 pass 或 fix` };
  const r = reader(v.ok, 'lead-review');
  const why = r.text('why');
  if ('error' in why) return why;
  const did = r.texts('did');
  if ('error' in did) return did;
  const owed = r.texts('owed');
  if ('error' in owed) return owed;
  const out: ReviewFile = { verdict, why: why.ok, did: did.ok, owed: owed.ok };
  if (v.ok.brief !== undefined) {
    const brief = r.object('brief');
    if ('error' in brief) return brief;
    out.brief = brief.ok;
  }
  if (verdict === 'fix' && out.brief === undefined) {
    return { error: `${file} 说要改（fix），却没写修复简报（brief）` };
  }
  return { ok: out };
}

/** 重写的 PR 摘要和做了什么（开 PR 时正文被卫生检查拦下）。 */
export function parseLeadText(text: string): Parsed<{ summary: string; did: string[] }> {
  const v = leadFile(text, 'lead-text');
  if ('error' in v) return v;
  const r = reader(v.ok, 'lead-text');
  const summary = r.text('summary');
  if ('error' in summary) return summary;
  const did = r.texts('did');
  if ('error' in did) return did;
  return { ok: { summary: summary.ok, did: did.ok } };
}

/**
 * 三段（对题 / 动手 / 验收）走 runner 时把 SessionBrief 转成 runner/one-shot 的 AnyBrief（#554-4）。
 * 会话从工作流进来时 SessionBrief 各字段是老的形状，runner 的三份 Brief 是 #554-1 钉死的形状：本函数做转换。
 * **不成熟的字段、形状对上就当场抛**（不鲁式化，底线第三条）。
 */
export function segmentBriefFrom(session: SessionBrief): AnyBrief {
  if (!session.segment) {
    throw new Error(
      'segmentBriefFrom：brief.segment 没给——这是 runner 段的入口，老 SessionBrief 的走 stagePrompt',
    );
  }
  const base = {
    title: session.title,
    request: session.request,
    acceptance: session.acceptance,
    touches: session.touches,
    ...(session.specDir !== undefined ? { specDir: session.specDir } : {}),
  };
  const seg = session.segment;
  if (seg.kind === 'scope') return AnyBriefSchema.parse({ kind: 'scope', ...base });
  if (seg.kind === 'manual')
    return AnyBriefSchema.parse({ kind: 'manual', ...base, branch: seg.branch, baseSha: seg.baseSha });
  return AnyBriefSchema.parse({
    kind: 'verify',
    ...base,
    prNumber: seg.prNumber,
    baseSha: seg.baseSha,
    headSha: seg.headSha,
    changedFiles: seg.changedFiles,
    diffText: seg.diffText,
  });
}
