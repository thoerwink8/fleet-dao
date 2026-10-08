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
 * 「本机做」标签（#299 止血，帅位 2026-09-27 定）：留给本机做的单，拉单不拉（判法在 @fleet-dao/core 的 dispatch.ts
 * localGate，那边有同名的一份，两份是同一条规矩）。再贴 ENGINE_LABEL 也不拉，以这个标签为准。
 * 开单那一刻就贴上（`pnpm issue:new --local`）。
 */
export const LOCAL_LABEL = '本机做';

/**
 * 「交给引擎」（#1321）：从 #1336 起不再是开门的钥匙（拉单不再看开单时间和版本，老单、未排期的单本来就进候选），
 * 只是排序加分：同一规模档里贴了它的靠前（`packages/engine/src/jobs/intake-pick.ts` 的 `comparePick`）。任何一道闸它都绕不过。
 * 和「本机做」一起贴时以「本机做」为准。名字只写在这里，别的地方引这个常量。开单脚本不贴。
 */
export const ENGINE_LABEL = '交给引擎';

/**
 * 「整理过」（母单 #1335 第 3 片，#1338；指挥官 2026-10-08 补：#1342 发到法国后引擎拉了两张前提已过期的老单）：临时指挥官整理待办时，
 * 判为「仍成立、适合引擎」的单贴它。开单时间早于「让 AI 接活」打开那一刻的老单，只有贴了它（或「交给引擎」）才进拉单候选
 * （`packages/engine/src/jobs/intake.ts` 的 `not_groomed`）；开关之后新开的单不需要。
 */
export const GROOMED_LABEL = '整理过';

/**
 * 「要人拍」（同上）：临时指挥官整理待办时见到涉及改标准路径、删数据、花钱、`.github/workflows/` 的单，贴它。
 * 贴着它的单引擎一律不拉（`intake.ts` 的 `needs_human`）；要交给引擎做，先让人看过、摘掉这个标签。
 */
export const HUMAN_DECISION_LABEL = '要人拍';

/**
 * 「待补」（同上）：临时指挥官判为过期的单只留言建议关闭、贴它，不关；人看过决定关不关、补不补。
 * 贴着它的单引擎一律不拉（`intake.ts` 的 `groom_pending`）；补好后摘掉。
 */
export const GROOM_PENDING_LABEL = '待补';

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

/** 一个里程碑：编号和标题（GitHub 上现读的）。 */
export interface MilestoneRef {
  number: number;
  title: string;
}

/**
 * 当前版本：还开着的 v<N> 里程碑里 N 最小的那个。一个都没有是 null（没有当前版本，单子打标、闲置清理都不猜）。
 * 和 @fleet-dao/core 的 dispatch.ts 同名的一份是同一条规矩（那边判「派不派」，这边判「打标、挪版本挂哪」）：
 * conventions 不依赖 core（改写法两边一起改，和 milestoneVersion、MOTHER_LABEL 是同一个理由）。
 */
export function currentVersion(
  openMilestones: readonly MilestoneRef[],
): { version: number; milestone: MilestoneRef } | null {
  let best: { version: number; milestone: MilestoneRef } | null = null;
  for (const m of openMilestones) {
    const version = milestoneVersion(m.title);
    if (version !== undefined && (best === null || version < best.version)) best = { version, milestone: m };
  }
  return best;
}

/**
 * 下一个版本：还开着的 v<N> 里程碑里 N 比 from 大的最小的那个（版本号紧挨着的那一版）。
 * 一个都没有是 null——调用方照「未排期」办（创始人 2026-10-05 拍：#995 第 2 条，关版本里程碑之前把里面还开着的单搬走，
 * 没有下一个版本就搬未排期）。和 currentVersion 同一份认法（milestoneVersion），不另写正则。
 */
export function nextVersion(
  openMilestones: readonly MilestoneRef[],
  from: number,
): { version: number; milestone: MilestoneRef } | null {
  let best: { version: number; milestone: MilestoneRef } | null = null;
  for (const m of openMilestones) {
    const version = milestoneVersion(m.title);
    if (version === undefined || version <= from) continue;
    if (best === null || version < best.version) best = { version, milestone: m };
  }
  return best;
}

/**
 * 「过时」标签（照 Kubernetes 的 stale/rotten 两段式，#448）：未排期的单闲置够久先贴这个，人不理再关成「不做了」。
 * 「冻结」标签：贴了这个的单，闲置清理绕开不动（照 Kubernetes 的 frozen）。
 */
export const IDLE_LABEL = '过时';
export const FROZEN_LABEL = '冻结';
