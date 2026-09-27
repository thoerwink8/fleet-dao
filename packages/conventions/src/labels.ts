// 类别标签：每张 issue、每个 PR 恰好贴一个（design 第七节「标签与里程碑」）。颜色和说明以 GitHub 上为准，这里只有名字。
export const KIND_LABELS = ['需求', '缺陷', '杂项'] as const;
export type KindLabel = (typeof KIND_LABELS)[number];

export function isKindLabel(name: string): name is KindLabel {
  return (KIND_LABELS as readonly string[]).includes(name);
}

/**
 * 母单标签（创始人 2026-09-26 拍）：一组能一起验收的子单，用 GitHub 自带子议题挂在母单下面，母单另加这个标签
 * 方便在列表里筛选；标题不加前缀（靠手打容易漏、身份一变还得改名）。
 */
export const MOTHER_LABEL = '母单';

/**
 * 「本机做」标签（#299 止血，帅位 2026-09-27 定）：帅位留给本机做的单，接活不自动派（判法在 @fleet-dao/core 的 dispatch.ts
 * localGate，那边有同名的一份，两份是同一条规矩）；人明说交给引擎（fleet-api handover）照交。要开单那一刻就贴上
 * （`pnpm issue:new --local`）：事后补贴时，开单那个事件已经把它派走了。认领进库（#299）之后改成库里认领的镜子，或者删掉。
 */
export const LOCAL_LABEL = '本机做';

/** 里程碑名字开头的阶段：「P1 核心闭环」→ 1；不是 P 加数字开头的返回 undefined。旧写法，迁到版本前用。 */
export function milestonePhase(title: string): number | undefined {
  const m = /^P(\d+)(?:\s|$)/.exec(title.trim());
  return m?.[1] ? Number(m[1]) : undefined;
}

/**
 * 里程碑名字开头的版本号：「v1 Fusion 接活」→ 1；不是 v 加数字开头的返回 undefined。
 * 里程碑＝版本（创始人 2026-09-26 拍，替代 P 阶段）：标题形如 `v1 Fusion 接活`，没挂里程碑＝未排期。
 */
export function milestoneVersion(title: string): number | undefined {
  const m = /^v(\d+)(?:\s|$)/.exec(title.trim());
  return m?.[1] ? Number(m[1]) : undefined;
}
