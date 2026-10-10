// 动手会话收到的完整提示词（#632 S2-4b-2）：交代（renderBrief 渲染的需求、验收条、已知的模块）+ 一次性会话怎么干的规矩 +
// 前几轮留下的返工意见。纯函数，不碰 IO。
//
// 改这里之前必须知道：
// - 这是一次性会话：没人回答问题、没有 fleet 命令可用（不发通行证），所以不许让它「去问」「去汇报」；成败只认 stdout 的回答、
//   退出状态和工作树里的提交。规矩里的每一条都对应引擎后面做的一步：只读提交（所以没提交的改动不算）、自己推分支开 PR（所以不许推、
//   不许切分支）。需求在单子里、结果在 PR 里（#654）：不要求会话写 需求.md、结果.md。
// - 返工意见原样带进来（CI 失败日志、验收问题表、没提交）：按条编号，每条超长截断（日志动辄几万字）；一条也没有就不出这一节。
// - 上一次被切号停下的（#59）多一节：树里留着它的提交和改动，告诉新会话接着干（一次性会话没有续会话，这是唯一的交接）。

import { type ManualBrief, renderBrief } from './brief.ts';

/** 一条返工意见最多放多少字：日志的头比尾有用（先红的那条是根因）。 */
export const FEEDBACK_ITEM_MAX = 6000;

export interface SegmentPromptInput {
  brief: ManualBrief;
  /** 单子指着的需求文档目录（老单才有，已经在主线上）；需求在单子正文里的没有。 */
  specDir?: string | undefined;
  feedback: readonly string[];
  /** 这一段上一次跑到一半被停下了（切号，#59）：为什么停的那一句；没被停过的不给。 */
  interrupted?: string;
  /** 设置 engine.subagentHint（#1641）开着才为 true：多一条「可以派哪些子代理、什么时候派」。默认关。 */
  subagentHint?: boolean;
}

/** 提示词里那一句子代理的提示（短）：查代码派 Haiku 档的侦察，自审派 Haiku 档的自审，Opus 档只在疑难时派。 */
export const SUBAGENT_HINT =
  '- 可以用 Agent 工具派子代理：查代码派 `fleet-scout`，交活前自审 diff 派 `fleet-review-screen`；Opus 档的（`fleet-reviewer`、`fleet-debugger`）只在疑难时派；写代码自己写，不派写代码的子代理。';

function clip(text: string): string {
  const t = text.trim();
  return t.length <= FEEDBACK_ITEM_MAX
    ? t
    : `${t.slice(0, FEEDBACK_ITEM_MAX)}\n……（后面还有 ${t.length - FEEDBACK_ITEM_MAX} 个字，已截断）`;
}

export function renderSegmentPrompt(input: SegmentPromptInput): string {
  const { brief, specDir, feedback } = input;
  const out = [
    renderBrief(brief),
    '',
    '## 怎么干（一次性会话）',
    '没有人在旁边，也没有地方可以提问：照上面的需求和验收条自己判断，拿不准的地方取最保守的理解，把取舍写进最后一条回复。',
    `- 工作目录就是当前目录，分支 \`${brief.branch}\` 已经切好，只在这里改。`,
    '- 改完用 git add、git commit 提交（提交信息一句话说清改了什么、为什么，可以分几个提交）。没提交的改动不会进 PR，工作树里也别留没提交的文件。',
    '- 不要推送、不要开 PR、不要切换或新建分支、不要改 git 配置：引擎会读你的提交、推分支、开 PR。',
    '- 不要用 `fleet` 命令（这次没有后端可连）。',
    '- 只跑跟你改动相关的测试，加格式和类型检查，别跑全量测试。仓里有 AGENTS.md 就照它的约定写代码。',
    '- 同模块的历史单和它的 PR 在 `specs/` 与该单 `Refs` 里，先读：别人做过的就接着它做，别重做一遍（#995）。',
    ...(specDir === undefined ? [] : [`- 需求文档 \`${specDir}/需求.md\` 已经在主线上，不要改它。`]),
    '- 不要新建需求文档、结果文档：需求在单子里，做成了什么写在 PR 正文里（引擎开 PR）。',
    ...(input.subagentHint ? [SUBAGENT_HINT] : []),
    '- 最后一条回复写三句话以内：做了什么、怎么验证的、还欠什么。',
  ];
  const interrupted = input.interrupted?.trim();
  if (interrupted) {
    out.push(
      '',
      '## 这一段上一次跑到一半被停下了',
      `上一次的会话被引擎停下（${clip(interrupted)}），这一次在同一个分支、同一棵工作树上接着干：树里可能已经有它的提交和没提交的改动。先看 git status、git log，接着它往下做，别从头重来，也别把那些改动当成别人的丢掉。`,
    );
  }
  const items = feedback.map((f) => f.trim()).filter(Boolean);
  if (items.length > 0) {
    out.push('', '## 上几轮留下的返工意见（照着改，改完才算做完）');
    out.push(...items.map((f, i) => `${i + 1}. ${clip(f)}`));
  }
  return out.join('\n');
}
