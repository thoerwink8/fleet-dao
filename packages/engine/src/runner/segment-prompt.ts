// 动手会话收到的完整提示词（#632 S2-4b-2）：交代（renderBrief 渲染的需求、验收条、已知的模块）+ 一次性会话怎么干的规矩 +
// 前几轮留下的返工意见。纯函数，不碰 IO。
//
// 改这里之前必须知道：
// - 这是一次性会话：没人回答问题、没有 fleet 命令可用（不发通行证），所以不许让它「去问」「去汇报」；成败只认 stdout 的回答、
//   退出状态和工作树里的提交。规矩里的每一条都对应引擎后面做的一步：只读提交（所以没提交的改动不算）、自己推分支开 PR（所以不许推、
//   不许切分支）。需求在单子里、结果在 PR 里（#654）：不要求会话写 需求.md、结果.md。会话改不了 PR 正文：
//   最后一条回复由引擎写进 PR 说明的「做了什么」（ANSWER_TO_PR，#2723），提示词照这个说，不叫它「写在 PR 正文里」。
// - 返工意见原样带进来（CI 失败日志、验收问题表、没提交）：按条编号，每条超长截断（日志动辄几万字）；一条也没有就不出这一节。
//   派前探测探通且没换路（「派前探测：某模型 通」）是状态，不是要改的，不进这一节（在途单的意见里可能还留着这句）。换路、探不通的仍带上。
// - 上一次被切号、暂停停下的（#59、#820）多一节：树里留着它的提交和改动，告诉新会话接着干。
// - 续上一段的会话（resumed，决定 0088）：会话里已经有整张单和前面的过程，提示词只补被打断的原因和返工意见，不重述交代
//   （重述等于让它把整张单再读一遍，返工轮的缓存读和首轮一样多）。
// - 新开的会话（不是续的）带「已给你的文件」一节（preload.ts，决定 0093）：单子「已知的模块」列的文件原文，引擎起会话前读好放进来，
//   省掉会话自己熟悉仓库那一大段；续的会话里早有了，不再给。
// - 不许把命令丢到后台再结束回答（NO_BACKGROUND_RULE，#2722）：一次性会话收不到后台回调，丢后台就收场的改动留在树里没提交。

import { isDispatchProbePassOnly } from '../workflows/task-support.ts';
import { type ManualBrief, renderBrief } from './brief.ts';
import { type PreloadRead, renderPreload } from './preload.ts';

/** 一条返工意见最多放多少字：日志的头比尾有用（先红的那条是根因）。 */
export const FEEDBACK_ITEM_MAX = 6000;

export interface SegmentPromptInput {
  brief: ManualBrief;
  /** 单子指着的需求文档目录（老单才有，已经在主线上）；需求在单子正文里的没有。 */
  specDir?: string | undefined;
  feedback: readonly string[];
  /** 这一段上一次跑到一半被停下了（切号，#59）：为什么停的那一句；没被停过的不给。 */
  interrupted?: string;
  /** 续的是上一段的会话：只出被打断的原因和返工意见（renderResumePrompt）。 */
  resumed?: boolean;
  /** 引擎起会话前读好的「已知的模块」里的文件（preload.ts）；续会话不出这一节。 */
  preload?: readonly PreloadRead[];
  /** 已废（子代理提示整条链路已删）：只为 task-segment.ts 还在传它而留，不读；等 #1972 合并后随那处一起删。 */
  subagentHint?: boolean;
  /** 重活先出方案的那一段（#2755）：规矩照给，另说这一段只读、最后一条回复只回方案 JSON（planSection）。 */
  plan?: boolean;
}

/** 方案 JSON 的样子（#2755）：引擎按 workflows/task-support.ts 的 parsePlan 认，认不出让会话重出一次。 */
export const PLAN_JSON_EXAMPLE =
  '{"files": ["packages/x/src/a.ts", "packages/x/test/a.test.ts"], "addedLines": 120, "acceptance": [1, 2]}';

/**
 * 重活先出方案（#2755：重活一轮做成 18%、PR 新增行 p90 7117）：这一段只读，最后一条回复只回方案 JSON；
 * 下一条消息才让它照方案动手（续同一个会话）。
 */
export function planSection(): string[] {
  return [
    '',
    '## 这一段先只出方案（只读）',
    '这张单是重活：先别动手。这一段只读代码，不改任何文件、不提交。想清楚最小的改法，最后一条回复只回一个 JSON 代码块，别的什么都不写：',
    '```json',
    PLAN_JSON_EXAMPLE,
    '```',
    '- files：要改或新建的文件（仓内路径），只列做到验收条必须动的；单子范围外的不列。',
    '- addedLines：预计新增多少行（整数，含测试）。',
    '- acceptance：这些改动对应「怎么算做完」里的第几条（从 1 数），每条验收都要对得上。',
    '下一条消息会让你照这个方案动手；动手时超出方案太多、超出体量预算，引擎会打回让你收窄。',
  ];
}

/**
 * 一次性会话回答一结束就收场，收不到后台任务跑完的通知（#2722：丢后台就收场的那一轮改动没提交）。新会话、续会话都写。
 */
export const NO_BACKGROUND_RULE =
  '不许把命令放到后台再结束回答：这是一次性会话，回答一结束就收场，收不到后台任务跑完的通知。测试、检查都在前台跑完看到结果，提交了再结束。';

/** 会话自己改不了 PR 正文：引擎把它最后一条回复写进 PR 说明的「做了什么」（#2723，workflows/task-support.ts 的 sessionDidLines）。 */
export const ANSWER_TO_PR = '最后一条回复会写进 PR 的说明';

function clip(text: string): string {
  const t = text.trim();
  return t.length <= FEEDBACK_ITEM_MAX
    ? t
    : `${t.slice(0, FEEDBACK_ITEM_MAX)}\n……（后面还有 ${t.length - FEEDBACK_ITEM_MAX} 个字，已截断）`;
}

function feedbackSection(feedback: readonly string[], title: string): string[] {
  const items = feedback.map((f) => f.trim()).filter((f) => f && !isDispatchProbePassOnly(f));
  if (items.length === 0) return [];
  return ['', title, ...items.map((f, i) => `${i + 1}. ${clip(f)}`)];
}

/**
 * 续上一段会话时的提示词：会话里已经有整张单、怎么干的规矩和前面的过程，这里只补这一次为什么接着干、要改什么。
 * 被打断的说一句原因；返工意见按条给。两样都没有也给一句「接着做」，不交空提示词。
 */
export function renderResumePrompt(input: {
  interrupted?: string;
  feedback: readonly string[];
  plan?: boolean;
}): string {
  const interrupted = input.interrupted?.trim();
  const out = [
    interrupted
      ? `刚才这个会话被引擎打断了（${clip(interrupted)}）。分支和工作树都没变，先看 git status、git log，接着刚才的进度往下做，别从头重来。`
      : '接着这个会话往下做：分支和工作树都没变，单子和规矩照前面的。',
    ...feedbackSection(input.feedback, '## 这一轮要改的（照着改，改完才算做完）'),
    '',
    ...(input.plan
      ? [
          `这一段还是只出方案：不改文件、不提交，最后一条回复只回一个 JSON 代码块（${PLAN_JSON_EXAMPLE} 这个样子）。`,
        ]
      : [
          NO_BACKGROUND_RULE,
          `改完照旧 git add、git commit 提交，不推送、不开 PR；${ANSWER_TO_PR}：逐条一行回验收条，再加一行欠什么。`,
        ]),
  ];
  return out.join('\n');
}

export function renderSegmentPrompt(input: SegmentPromptInput): string {
  if (input.resumed) {
    return renderResumePrompt({
      ...(input.interrupted ? { interrupted: input.interrupted } : {}),
      feedback: input.feedback,
      ...(input.plan ? { plan: true } : {}),
    });
  }
  const { brief, specDir, feedback } = input;
  const out = [
    renderBrief(brief),
    ...renderPreload(input.preload ?? []),
    '',
    '## 怎么干（一次性会话）',
    '没有人在旁边，也没有地方可以提问：照上面的需求和验收条自己判断，拿不准的地方取最保守的理解，把取舍写进最后一条回复。',
    `- 工作目录就是当前目录，分支 \`${brief.branch}\` 已经切好，只在这里改。`,
    '- 改完用 git add、git commit 提交（提交信息一句话说清改了什么、为什么，可以分几个提交）。没提交的改动不会进 PR，工作树里也别留没提交的文件。',
    '- 不要推送、不要开 PR、不要切换或新建分支、不要改 git 配置：引擎会读你的提交、推分支、开 PR。',
    '- 不要用 `fleet` 命令（这次没有后端可连）。',
    '- AGENTS.md 里开 PR、进度单、开单的约定这次不适用，引擎替你做。',
    ...(specDir === undefined ? [] : [`- 需求文档 \`${specDir}/需求.md\` 已经在主线上，不要改它。`]),
    `- 不要新建需求文档、结果文档：需求在单子里；${ANSWER_TO_PR}（引擎开 PR，你改不了 PR 正文），做成了什么、怎么验的写在那里。`,
    '- 家目录里装的通用技能（~/.agents/skills、~/.claude/skills 下的 SKILL.md）这次用不上，别去读：要做的、怎么算做完都在上面。',
    `- ${NO_BACKGROUND_RULE}`,
    '- 最后一条回复逐条一行回验收条，再加一行欠什么。',
  ];
  const interrupted = input.interrupted?.trim();
  if (interrupted) {
    out.push(
      '',
      '## 这一段上一次跑到一半被停下了',
      `上一次的会话被引擎停下（${clip(interrupted)}），这一次在同一个分支、同一棵工作树上接着干：树里可能已经有它的提交和没提交的改动。先看 git status、git log，接着它往下做，别从头重来，也别把那些改动当成别人的丢掉。`,
    );
  }
  out.push(...feedbackSection(feedback, '## 上几轮留下的返工意见（照着改，改完才算做完）'));
  // 先出方案的那一段：规矩照给（续着动手时会话手里要有），最后另起一节说这一段只读、只回方案 JSON
  if (input.plan) out.push(...planSection());
  return out.join('\n');
}
