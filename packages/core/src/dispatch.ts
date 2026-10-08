// 引擎拉单（packages/engine/src/jobs/intake.ts）派不派一张单，这里放不用读库、不用读 GitHub 就能判的那几道：不是母单也不是子单
// （familyGate）、没贴「本机做」（localGate），加上认版本的几个纯函数（milestoneVersion、currentVersion，排序、巡检、闲置清理在用）。
// 「挂在当前版本上」和「未排期的不碰」两道（versionGate、autoDispatchGate）#1336 删了：引擎自己按依据挑单，挂不挂当前版本只影响
// 排序，不再是准入的硬闸（决定 0031 改写）。原来还有「开关、开单时间」那一道（dispatchDecision）和「人明说交给 fleet」
// （handoverDecision），随旧接活一起删了（#901 审查：只有测试在引用）。读库、读 GitHub、起工作流是外壳的事，这里只判。

// —— 认版本 ——

/** 一个里程碑：编号和标题（GitHub 上现读的）。 */
export interface MilestoneRef {
  number: number;
  title: string;
}

/**
 * 里程碑标题开头的版本号：「v1 Fusion 接活」→ 1；不是 v 加数字开头的（旧的「P1 核心闭环」、「v1.5 …」、「V2 …」）是 undefined。
 * 版本的写法是「v<N> 一句目标」（0003 第 1 条）。开单脚本、PR 必填栏认版本用的是 @fleet-dao/conventions 的 labels.ts 里
 * 同名的一份（那个包不依赖 core），两份是同一条规矩：改写法两边一起改。
 */
export function milestoneVersion(title: string): number | undefined {
  const m = /^v(\d+)(?:\s|$)/.exec(title.trim());
  return m?.[1] ? Number(m[1]) : undefined;
}

/** 当前版本：还开着的 v<N> 里程碑里 N 最小的那个。一个都没有是 null（没有当前版本）。 */
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

/** 这张单此刻挂在哪个里程碑、仓里还开着哪些里程碑（GitHub 上现读：计划以 GitHub 为准）。 */
export interface IssueMilestones {
  /** 没挂（未排期）是 null。 */
  milestone: MilestoneRef | null;
  /** 仓里还开着的全部里程碑（不只 v 开头的）。 */
  openMilestones: readonly MilestoneRef[];
}

// —— 母单、子单这一道 ——

/** 母单标签：和开单脚本、计划快照认母单用的 @fleet-dao/conventions labels.ts 的 MOTHER_LABEL 是同一个（那个包不依赖 core）。 */
const MOTHER_LABEL = '母单';

/** 这张单在母单、子单里的位置（GitHub 上现读）。 */
export interface IssueFamily {
  /** 贴着的标签名。 */
  labels: readonly string[];
  /** 挂在哪张单下面（GitHub 子议题的父单号）；不是子单是 null。 */
  parent: number | null;
  /** 下面挂着几张子单（GitHub 子议题）。 */
  subIssues: number;
}

export type FamilyGate = { ok: true } | { ok: false; reason: 'mother_ticket' | 'sub_issue'; why: string };

/**
 * 母单、子单这一道（帅位 2026-09-27 定；#252 做完就改）：引擎现在一张单只走一块，母单按块循环带子单还没做（#252）。开关一开，
 * 母单和它的子单（GitHub 子议题）会各被当成独立的单、各起一条 Fusion，抢同一批文件。所以贴「母单」标签的、下面挂着子单的
 * （结构上就是母单，标签漏贴也算）、挂在别的单下面的子单，自动派一律不派；要做就重开一张新单，不贴「本机做」、不是母单也不是子单。
 * #252 做完改成由母单的 Lead 按块带子单：母单派、子单跟着母单走，到时候改这里。
 */
export function familyGate(issue: IssueFamily): FamilyGate {
  const later = '要做就重开一张新单，不贴「本机做」、不是母单也不是子单（母单按块带子单等 #252）';
  if (issue.labels.includes(MOTHER_LABEL) || issue.subIssues > 0) {
    const kids = issue.subIssues > 0 ? `，下面挂着 ${issue.subIssues} 张子单` : '';
    return {
      ok: false,
      reason: 'mother_ticket',
      why: `是母单${kids}：和子单各起一条会抢同一批文件，自动派不派；${later}`,
    };
  }
  if (issue.parent !== null) {
    return {
      ok: false,
      reason: 'sub_issue',
      why: `是 #${issue.parent} 下面的子单：和母单、别的子单各起一条会抢同一批文件，自动派不派；${later}`,
    };
  }
  return { ok: true };
}

// —— 本机做这一道 ——

/**
 * 「本机做」标签：和开单脚本 `pnpm issue:new --local` 贴的 @fleet-dao/conventions labels.ts 的 LOCAL_LABEL 是同一个
 * （那个包不依赖 core）。
 */
const LOCAL_LABEL = '本机做';

export type LocalGate = { ok: true } | { ok: false; reason: 'reserved_local'; why: string };

/**
 * 「本机做」这一道（#299 止血，帅位 2026-09-27 定）：开关开着时，帅位要留给本机做的独立单也会被接活派走（#293、#299 都这样被接走过）。
 * 贴了「本机做」的，自动派一律不派。要交给引擎就重开一张新单，不贴「本机做」、不是母单也不是子单。标签要开单那一刻就贴上
 * （`pnpm issue:new --local`）：事后补贴时，开单那个事件已经把它派走了。
 * 认领账 #556 整个删了，webhook 接活也由引擎拉单（packages/engine/src/jobs/intake.ts）替掉：这个标签是唯一挡本机单的地方。
 */
export function localGate(issue: Pick<IssueFamily, 'labels'>): LocalGate {
  if (!issue.labels.includes(LOCAL_LABEL)) return { ok: true };
  return {
    ok: false,
    reason: 'reserved_local',
    why: `帅位留给本机做（贴着「${LOCAL_LABEL}」）；要交给引擎，重开一张新单，不贴「${LOCAL_LABEL}」、不是母单也不是子单`,
  };
}
