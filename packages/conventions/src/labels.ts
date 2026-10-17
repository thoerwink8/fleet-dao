// 类别标签：每张 issue、每个 PR 恰好贴一个（design 第七节「标签与里程碑」）。颜色和说明以 GitHub 上为准，这里只有名字。
export const KIND_LABELS = ['需求', '缺陷', '杂项'] as const;
export type KindLabel = (typeof KIND_LABELS)[number];

export function isKindLabel(name: string): name is KindLabel {
  return (KIND_LABELS as readonly string[]).includes(name);
}

/**
 * 查询轴（仓库级词汇）：只用来筛，不参与派工、合并、里程碑。
 * 名字带轴前缀，筛的时候能看出是哪一轴。每条轴开单、人开 PR 时恰好贴一个。
 * 域：engine 法国引擎 / api 驾驶舱后端 / mirasim。性质：bug 出错 / perf 性能 / process 流程。
 * 性质不代替类别「需求 / 缺陷 / 杂项」。
 */
export const DOMAIN_VALUES = ['engine', 'api', 'mirasim'] as const;
export type DomainValue = (typeof DOMAIN_VALUES)[number];
export const NATURE_VALUES = ['bug', 'perf', 'process'] as const;
export type NatureValue = (typeof NATURE_VALUES)[number];

const DOMAIN_PREFIX = '域:';
const NATURE_PREFIX = '性质:';

export function isDomainValue(name: string): name is DomainValue {
  return (DOMAIN_VALUES as readonly string[]).includes(name);
}
export function isNatureValue(name: string): name is NatureValue {
  return (NATURE_VALUES as readonly string[]).includes(name);
}

/** 标签名。值是词汇里的那一个，前缀标出轴。 */
export function domainLabel(value: DomainValue): string {
  return `${DOMAIN_PREFIX}${value}`;
}
export function natureLabel(value: NatureValue): string {
  return `${NATURE_PREFIX}${value}`;
}

export const DOMAIN_LABELS = DOMAIN_VALUES.map(domainLabel);
export const NATURE_LABELS = NATURE_VALUES.map(natureLabel);

export function parseDomain(name: string): DomainValue | undefined {
  if (!name.startsWith(DOMAIN_PREFIX)) return undefined;
  const value = name.slice(DOMAIN_PREFIX.length);
  return isDomainValue(value) ? value : undefined;
}
export function parseNature(name: string): NatureValue | undefined {
  if (!name.startsWith(NATURE_PREFIX)) return undefined;
  const value = name.slice(NATURE_PREFIX.length);
  return isNatureValue(value) ? value : undefined;
}

/**
 * 从一组标签里抽出查询轴。某一轴恰好一个才收；没有、或多个，这一轴不收（多个说不清该按哪个筛）。
 * 顺序固定：先域、后性质。
 */
export function queryAxisLabels(names: readonly string[] | undefined): string[] {
  const list = names ?? [];
  const domain = list.filter((n) => parseDomain(n) !== undefined);
  const nature = list.filter((n) => parseNature(n) !== undefined);
  const out: string[] = [];
  if (domain.length === 1 && domain[0]) out.push(domain[0]);
  if (nature.length === 1 && nature[0]) out.push(nature[0]);
  return out;
}

/** 开单、开 PR 的 --domain / --nature。缺了或不是词汇里的值，回一句人话；过了回两个值。 */
export function requireAxis(
  domain: string | undefined,
  nature: string | undefined,
): { domain: DomainValue; nature: NatureValue } | { error: string } {
  const d = domain?.trim() ?? '';
  const n = nature?.trim() ?? '';
  if (!d) return { error: `缺 --domain：从 ${DOMAIN_VALUES.join('、')} 里挑一个。` };
  if (!isDomainValue(d)) return { error: `--domain 只能是 ${DOMAIN_VALUES.join('、')}，没有「${d}」。` };
  if (!n) return { error: `缺 --nature：从 ${NATURE_VALUES.join('、')} 里挑一个。` };
  if (!isNatureValue(n)) return { error: `--nature 只能是 ${NATURE_VALUES.join('、')}，没有「${n}」。` };
  return { domain: d, nature: n };
}

/**
 * 母单标签：一组能一起验收的子单，用 GitHub 自带子议题挂在母单下面，母单另加这个标签
 * 方便在列表里筛选；标题不加前缀（靠手打容易漏、身份一变还得改名）。
 */
export const MOTHER_LABEL = '母单';

/**
 * 「本机做」标签（#299 止血，帅位）：留给本机做的单，拉单不拉（判法在 @fleet-dao/core 的 dispatch.ts
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
 * 「全程」「三段」（#2826，决定 0105；docs/workflow.md 照字面写的就是这两个名字）：引擎这张单走哪种流程，照标签走，不看开关 engine.flowMode。
 * 「全程」也要过决定 0105 的边界：仓档案开了 flowEligible（第一期只 fleet-dao）、选中的路由是 Claude Sonnet 5.5、已知的模块不碰
 * 迁移、合并闸、凭据、权限、任务工作流、发布脚本、改标准路径、跨仓，不过就退回三段并写明原因
 * （`packages/engine/src/flow-mode.ts` 的 chooseFlowMode）。两个都贴按三段。
 */
export const FULL_FLOW_LABEL = '全程';
export const THREE_FLOW_LABEL = '三段';

/**
 * 「整理过」（母单 #1335 第 3 片，#1338；指挥官补：#1342 发到法国后引擎拉了两张前提已过期的老单）：临时指挥官整理待办时，
 * 判为「仍成立、适合引擎」的单贴它。开单时间早于「让 AI 接活」打开那一刻的老单，只有贴了它（或「交给引擎」）才进拉单候选
 * （`packages/engine/src/jobs/intake.ts` 的 `not_groomed`）；开关之后新开的单不需要。
 */
export const GROOMED_LABEL = '整理过';

/**
 * 「要人拍」（同上，决定 0097 收窄）：临时指挥官整理待办时，只有要掏新钱、或删了找不回又没备份，才贴它。
 * 改标准路径、`.github/workflows/`、对外发布改贴「本机做」并留一句原因，不问创始人。
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
 * 里程碑＝版本（替代 P 阶段）：标题形如 `v1 Fusion 接活`，没挂里程碑＝未排期。
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
 * 「过时」标签（照 Kubernetes 的 stale/rotten 两段式，#448）：未排期的单闲置够久先贴这个，人不理再关成「不做了」。
 * 「冻结」标签：贴了这个的单，闲置清理绕开不动（照 Kubernetes 的 frozen）。
 */
export const IDLE_LABEL = '过时';
export const FROZEN_LABEL = '冻结';
