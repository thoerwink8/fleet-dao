// 类别标签：每张 issue、每个 PR 恰好贴一个（design 第七节「标签与里程碑」）。颜色和说明以 GitHub 上为准，这里只有名字。
export const KIND_LABELS = ['需求', '缺陷', '杂项'] as const;
export type KindLabel = (typeof KIND_LABELS)[number];

export function isKindLabel(name: string): name is KindLabel {
  return (KIND_LABELS as readonly string[]).includes(name);
}

/** 里程碑名字开头的阶段：「P1 核心闭环」→ 1；不是 P 加数字开头的返回 undefined。 */
export function milestonePhase(title: string): number | undefined {
  const m = /^P(\d+)(?:\s|$)/.exec(title.trim());
  return m?.[1] ? Number(m[1]) : undefined;
}
