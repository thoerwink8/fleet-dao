// 任务简报（Brief）：Lead 派给副手的一块活的形状（docs/decisions/0003-fusion-flow.md 第 5 条，已被替代）。
// 原来这里还判「简报齐不齐」「几份能不能同时派」，随 Fusion 删了（#901 审查：只有测试在引用）；这里只剩引擎端口还在用的形状
// 和「改了简报外的哪些文件」。
import { z } from 'zod';

const text = z.string().trim().min(1);

export const BriefSchema = z.object({
  /** 这块要做成什么。 */
  goal: text,
  /** 做到哪为止、不碰什么。 */
  scope: text,
  /** 约束：禁令、接口、不许用的写法……没有就给空数组。 */
  constraints: z.array(text),
  /** 只许改的文件；以 / 结尾的是目录，下面的都算。 */
  files: z.array(text).min(1),
  /** 怎么算合格，逐条。 */
  acceptance: z.array(text).min(1),
  /** 交回什么：改了哪些文件、测试结果、没做完的。 */
  returnFormat: text,
});

export type Brief = z.infer<typeof BriefSchema>;

/** 改了简报外的哪些文件（碰到别的块的硬挡，别的由 Lead 验收时定收不收：acceptance.ts）。 */
export function outsideBrief(brief: Brief, changed: readonly string[]): string[] {
  const allowedBy = (allowed: string, file: string) =>
    allowed === file || (allowed.endsWith('/') && file.startsWith(allowed));
  return changed.filter((file) => !brief.files.some((allowed) => allowedBy(allowed, file)));
}
