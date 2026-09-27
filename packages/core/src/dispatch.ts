// 派不派一张单（0003 第 2、4、8 条；design 第九节「在哪能做与接活开关」）：接活自动派（后端 packages/api/src/issue-intake.ts，
// 引擎的对账重放用同一份）和人明说交给引擎（fleet-api handover，packages/api/src/cli.ts）都在这里判。
// 读库、读 GitHub、起工作流是外壳的事，这里只判。
// 自动派要过三道：开关开着、issue 是开关打开以后开的（dispatchDecision）、挂在当前版本上（versionGate）；
// 交给 fleet 是人替后两道放行，只看这张单此刻的样子（handoverDecision），开关、流程配置副本那两道外壳照样先查。
import type { TaskState } from '@fleet-dao/shared';

/** 结束了的任务：接活只在 GitHub 上重开时再拉起一轮。 */
export const FINISHED_TASK_STATES: readonly TaskState[] = ['done', 'stopped', 'failed'];

export function isFinishedTask(state: TaskState): boolean {
  return FINISHED_TASK_STATES.includes(state);
}

// —— 开关这一道 ——

/**
 * 拉不拉起工作流。start = 从没派过（还在排队），拉起；restart = 重开了、任务已经结束或还在排队，再拉起一次
 * （拉起时发现上一轮还在跑，就等它结束）；wait_previous_run = 重开了、上一轮正在做（刚叫停还在收尾，或者引擎
 * 做完正在收工），等它结束再拉起；其余都不拉起。start、restart 还要过版本那一道（versionGate）才真拉起。
 */
export type DispatchDecision =
  | 'start'
  | 'restart'
  | 'wait_previous_run'
  | 'dispatch_off'
  | 'opened_before_switch'
  | 'created_at_unreadable'
  | 'in_progress'
  | 'finished';

/**
 * 「让 AI 接活」开关（repos.auto_dispatch_since）：关着不派；开关打开以前就开着的 issue 不自动派（要人明说交给 fleet，
 * handoverDecision）。开关允许时：还在排队（从没派过）的拉起；已经结束的只在 GitHub 上重开时再拉起一次；重开时上一轮还没结束的，
 * 等它结束。
 */
export function dispatchDecision(
  repo: { autoDispatchSince: string | null },
  issueCreatedAt: string,
  task: { state: TaskState },
  reopened: boolean,
): DispatchDecision {
  if (repo.autoDispatchSince === null) return 'dispatch_off';
  const opened = Date.parse(issueCreatedAt);
  if (!Number.isFinite(opened)) return 'created_at_unreadable';
  if (opened < Date.parse(repo.autoDispatchSince)) return 'opened_before_switch';
  if (reopened)
    return isFinishedTask(task.state) || task.state === 'queued' ? 'restart' : 'wait_previous_run';
  if (task.state === 'queued') return 'start';
  if (isFinishedTask(task.state)) return 'finished';
  return 'in_progress';
}

// —— 版本这一道 ——

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

/** 当前版本：还开着的 v<N> 里程碑里 N 最小的那个。一个都没有是 null（没有当前版本，什么都不自动派）。 */
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

export type VersionGate =
  | { ok: true; version: number; milestone: string }
  | { ok: false; reason: 'unscheduled' | 'not_current_version' | 'version_unreadable'; why: string };

/**
 * 版本这一道（0003 第 2、8 条：引擎只做当前版本的单，未排期的不碰）：只有挂在当前版本上的单自动派。
 * - 没挂里程碑：unscheduled；
 * - 挂在别的版本上、挂的里程碑已经关了：not_current_version；
 * - 挂的里程碑认不出版本号（不是 v<N> 开头）：version_unreadable，算没查成，不当成当前版本。
 * 按里程碑编号对上还开着的那份（标题以现读的为准），再比版本号：两个还开着的里程碑版本号一样（不该有），都算当前版本。
 */
export function versionGate(plan: IssueMilestones): VersionGate {
  const current = currentVersion(plan.openMilestones);
  const now = current
    ? `当前版本是「${current.milestone.title}」`
    : '现在没有还开着的 v<N> 里程碑，没有当前版本';
  const mine = plan.milestone;
  if (mine === null) {
    return { ok: false, reason: 'unscheduled', why: `没挂里程碑（未排期），引擎不碰；${now}` };
  }
  const open = plan.openMilestones.find((m) => m.number === mine.number);
  if (!open) {
    return {
      ok: false,
      reason: 'not_current_version',
      why: `挂在已经关了的里程碑「${mine.title}」上，不是当前版本；${now}`,
    };
  }
  const version = milestoneVersion(open.title);
  if (version === undefined) {
    return {
      ok: false,
      reason: 'version_unreadable',
      why: `没查成：里程碑「${open.title}」认不出版本号（版本要写成「v<N> 一句目标」），不当成当前版本`,
    };
  }
  if (!current || version !== current.version) {
    return { ok: false, reason: 'not_current_version', why: `挂在「${open.title}」上，不是当前版本；${now}` };
  }
  return { ok: true, version, milestone: open.title };
}

// —— 交给 fleet ——

/** 交给 fleet 时要看的这张 issue 此刻的样子（GitHub 上现读）。 */
export interface IssueNow {
  state: 'open' | 'closed';
  /** 开着、而且是关了又重开的（GitHub 的 state_reason 是 reopened）。 */
  reopened: boolean;
  /** 这个号其实是 PR（GitHub 的 issue 接口也回 PR）。 */
  pullRequest: boolean;
}

export type HandoverDecision =
  | { act: 'start' }
  | { act: 'restart' }
  | { act: 'noop'; why: string }
  | { act: 'refuse'; reason: 'pull_request' | 'issue_closed' | 'finished'; why: string };

/**
 * 人明说把一张单交给引擎（fleet-api handover；驾驶舱的「交给 fleet」按钮以后也照这个判）：开关打开以前开的、别的版本的、
 * 未排期的都能交。这里只看任务和 issue 此刻的样子，照接活的老规矩：这个号其实是 PR 的、issue 关着的，拒（关着的哪怕
 * 任务还在跑也拒：关单会叫停它，说「已经在跑」是骗人）；还在排队（从没派过）的拉起；在跑的不重复起；已经结束的只有
 * GitHub 上重开过才再起一轮（和接活「结束的只在重开时再拉起」是同一条），没重开的拒。
 */
export function handoverDecision(task: { state: TaskState }, issue: IssueNow): HandoverDecision {
  if (issue.pullRequest) return { act: 'refuse', reason: 'pull_request', why: '这个号是 PR，不是 issue' };
  if (issue.state === 'closed') {
    return {
      act: 'refuse',
      reason: 'issue_closed',
      why: 'GitHub 上这张单关着：关着的单不派，要做先在 GitHub 上重开',
    };
  }
  if (task.state !== 'queued' && !isFinishedTask(task.state)) {
    return { act: 'noop', why: `已经在跑（任务现在是 ${task.state}），不重复起` };
  }
  if (task.state === 'queued') return { act: 'start' };
  if (issue.reopened) return { act: 'restart' };
  return {
    act: 'refuse',
    reason: 'finished',
    why: `任务已经结束（${task.state}），不重复起：要再做一轮，先在 GitHub 上重开这张单（关了再开），再交一次`,
  };
}
