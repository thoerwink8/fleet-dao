// 动手会话收到的完整提示词（#632 S2-4b-2）：交代（renderBrief 渲染的需求、验收条、已知的模块）+ 一次性会话怎么干的规矩 +
// 前几轮留下的返工意见。纯函数，不碰 IO。
//
// 改这里之前必须知道：
// - 这是一次性会话：没人回答问题、没有 fleet 命令可用（不发通行证），所以不许让它「去问」「去汇报」；成败只认 stdout 的回答、
//   退出状态和工作树里的提交。规矩里的每一条都对应引擎后面做的一步：只读提交（所以没提交的改动不算）、自己推分支开 PR（所以不许推、
//   不许切分支）、读 结果.md（所以要写）。
// - 返工意见原样带进来（CI 失败日志、验收问题表、没提交）：按条编号，每条超长截断（日志动辄几万字）；一条也没有就不出这一节。

import { type ManualBrief, renderBrief } from './brief.ts';

/** 一条返工意见最多放多少字：日志的头比尾有用（先红的那条是根因）。 */
export const FEEDBACK_ITEM_MAX = 6000;

export interface SegmentPromptInput {
  brief: ManualBrief;
  /** 需求文档目录（specs/<号>-<短名>）。 */
  specDir: string;
  /** 需求文档已经在主线上（true）；false＝需求在单子正文里，文档要随这个 PR 进主线。 */
  specDocOnMain: boolean;
  feedback: readonly string[];
}

function clip(text: string): string {
  const t = text.trim();
  return t.length <= FEEDBACK_ITEM_MAX
    ? t
    : `${t.slice(0, FEEDBACK_ITEM_MAX)}\n……（后面还有 ${t.length - FEEDBACK_ITEM_MAX} 个字，已截断）`;
}

export function renderSegmentPrompt(input: SegmentPromptInput): string {
  const { brief, specDir, specDocOnMain, feedback } = input;
  const out = [
    renderBrief(brief),
    '',
    '## 怎么干（一次性会话）',
    '没有人在旁边，也没有地方可以提问：照上面的需求和验收条自己判断，拿不准的地方取最保守的理解，把取舍写进结果文档。',
    `- 工作目录就是当前目录，分支 \`${brief.branch}\` 已经切好，只在这里改。`,
    '- 改完用 git add、git commit 提交（提交信息一句话说清改了什么、为什么，可以分几个提交）。没提交的改动不会进 PR，工作树里也别留没提交的文件。',
    '- 不要推送、不要开 PR、不要切换或新建分支、不要改 git 配置：引擎会读你的提交、推分支、开 PR。',
    '- 不要用 `fleet` 命令（这次没有后端可连）。',
    '- 只跑跟你改动相关的测试，加格式和类型检查，别跑全量测试。仓里有 AGENTS.md 就照它的约定写代码。',
    specDocOnMain
      ? `- 需求文档 \`${specDir}/需求.md\` 已经在主线上，不要改它。`
      : `- 需求原文还没进主线：把上面「需求」一节整理成 \`${specDir}/需求.md\`（保留「场景」「原话」「已知的模块」「怎么算做完」这几栏，不改意思），和代码一起提交。`,
    `- 把怎么验证的、还欠什么写进 \`${specDir}/结果.md\`，和代码一起提交。`,
    '- 最后一条回复写三句话以内：做了什么、怎么验证的、还欠什么。',
  ];
  const items = feedback.map((f) => f.trim()).filter(Boolean);
  if (items.length > 0) {
    out.push('', '## 上几轮留下的返工意见（照着改，改完才算做完）');
    out.push(...items.map((f, i) => `${i + 1}. ${clip(f)}`));
  }
  return out.join('\n');
}
