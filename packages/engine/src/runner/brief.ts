// 「喂什么」：三个段各自的交代（brief）类型 + 把 brief 渲染成一段喂给会话的文字。
//
// 借用 ports.ts 的 SessionBrief 里那几样（title / request / acceptance / touches / branch / prNumber / head / specDir），
// **不带** Fusion 专词：没有 stepName、没有 fusionStage、没有 lead.step（plan / accept / rebut / takeover 这些
// 是 Fusion 的状态机概念；三段一条龙里每段是独立一次调用，不分步）。
//
// Verify Brief 必须能表达三样：**diff + 要什么 + 怎么算做完**（specs/509-需求梳理/流程重做方案.md 第五节、第六节
// 「验收那一遍现读，不存副本」——diff 由调用方在起会话前从 PR 现算出来交进来）。**不允许跨进程去读「上一段的
// PR#」**：prNumber 是这个文件的必备参数，调用方必须显式交出来。

import { z } from 'zod';

const Acceptance = z.array(z.string().min(1)).min(1);
const Touches = z.array(z.string().min(1));

/** 三个段共用的底。 */
const BriefBaseFields = {
  /** 一句话说这单是什么（issue 标题改写；进提示词头部）。 */
  title: z.string().min(1),
  /** 需求原文：创始人原话 + 场景描述。 */
  request: z.string().min(1),
  /** 「怎么算做完」逐条原文。 */
  acceptance: Acceptance,
  /** 已知会碰到的模块 / 路径（仓内相对路径或包名）。 */
  touches: Touches,
  /** 需求文档目录（`specs/<号>-<短名>/`），进提示词出处。 */
  specDir: z.string().min(1).optional(),
};

/** scope（对题）段：只有需求，还没干活；产出是一段「建单用的整理稿」。 */
export const ScopeBriefSchema = z.object({
  kind: z.literal('scope'),
  ...BriefBaseFields,
});
export type ScopeBrief = z.infer<typeof ScopeBriefSchema>;

/** manual（动手）段：拿单写代码、交 PR。 */
export const ManualBriefSchema = z.object({
  kind: z.literal('manual'),
  ...BriefBaseFields,
  /** 干活用的分支名。 */
  branch: z.string().min(1),
  /** 起会话前分支的头（base sha）：判「这之后有没有真提交」用。 */
  baseSha: z.string().min(1),
});
export type ManualBrief = z.infer<typeof ManualBriefSchema>;

/**
 * verify（验收）段：合之前一次冷调用。**PR 是参数、不是从库里翻出来的**——调用方把 diff 算出来交进来，
 * 不让验收自己去翻上一段的产物。
 */
export const VerifyBriefSchema = z.object({
  kind: z.literal('verify'),
  ...BriefBaseFields,
  /** 验哪张 PR：调用方必给。 */
  prNumber: z.number().int().positive(),
  /** PR 的 base、head（完整 40 位 sha），diff 按 base..head 现算。 */
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  /** PR 改了哪些文件（相对主线，调用方现算的）。 */
  changedFiles: z.array(z.string().min(1)).min(1),
  /** diff **内容**（`git diff base..head` 的 unified patch，可能很长）——调用方现算后贴进来。 */
  diffText: z.string().min(1),
});
export type VerifyBrief = z.infer<typeof VerifyBriefSchema>;

export const AnyBriefSchema = z.discriminatedUnion('kind', [
  ScopeBriefSchema,
  ManualBriefSchema,
  VerifyBriefSchema,
]);
export type AnyBrief = z.infer<typeof AnyBriefSchema>;

/** 把 brief 渲染成喂给会话的那段文字。结构固定，三份差在哪几节一看就知道。 */
export function renderBrief(brief: AnyBrief): string {
  const head = [
    `# 任务：${brief.title}`,
    '',
    '## 需求',
    brief.request.trim(),
    '',
    '## 怎么算做完（逐条都要回）',
    ...brief.acceptance.map((a, i) => `${i + 1}. ${a}`),
    '',
    '## 已知的模块 / 路径',
    ...(brief.touches.length > 0 ? brief.touches.map((t) => `- ${t}`) : ['（没写）']),
  ];
  if (brief.specDir !== undefined) {
    head.push('', `## 需求文档出处`, `\`${brief.specDir}\`（对照这份，不要凭印象）。`);
  }
  if (brief.kind === 'scope') return head.join('\n');
  if (brief.kind === 'manual') {
    return [
      ...head,
      '',
      `## 分支与头`,
      `分支：\`${brief.branch}\`，起会话前的头（base sha）：\`${brief.baseSha}\`。`,
      '干完要在它之上有真提交，不能什么都没改就交差。',
    ].join('\n');
  }
  // verify
  return [
    ...head,
    '',
    '## 验什么',
    `PR：#${brief.prNumber}`,
    `base：\`${brief.baseSha}\`  head：\`${brief.headSha}\``,
    '',
    '## 改了哪些文件',
    ...brief.changedFiles.map((f) => `- ${f}`),
    '',
    '## diff（unified patch）',
    '```diff',
    brief.diffText,
    '```',
    '',
    '## 判法',
    '对照「怎么算做完」逐条回 pass / fail；**只有三种能挡**：没做到验收条、有证据弄坏原有功能、安全或丢数据。',
    '风格、命名、设计好不好**不许判**。',
  ].join('\n');
}
