// 看门狗提醒的受控修复（#3033 后端，#3034 卡上）：卡上那一格的判法，纯函数，页面和测试共用。
// 依据 Temporal 消息与结果：发出去只代表收到，修好要另外查——所以「受理」「核验中」「已修复」三段分开，只有后端核验过的 verified 才写已修复。
// 依据 AWS Automation 批准步骤：要人批的动作由人本人点准或拒，没批、拒了都不往下走——带 choice 的动作才写「要你本人拍」。
import type { Notification } from '../api/types';
import type { Tone } from './status';

export type RepairView = NonNullable<Notification['repair']>;
export type RepairAction = RepairView['actions'][number];
export type RepairRecord = NonNullable<RepairView['last']>;
export type RepairLink = NonNullable<RepairView['linked']>;

/**
 * 这次事故操作者明确关联的单（#3100 的 repair.linked）落在哪一段：只绑定待处理 / 已有任务在做 / 已有开放 PR / 绑定失效。
 * 关联不是一次修复动作：不等于受理、更不等于修好，卡照样开着。
 */
export function linkPhase(link: RepairLink): { label: string; tone: Tone } {
  if (link.invalid) return { label: '关联已失效', tone: 'fail' };
  if (link.stage === 'pr-open')
    return { label: link.prNumber ? `PR #${link.prNumber} 开着` : 'PR 开着', tone: 'run' };
  if (link.stage === 'worker-active') return { label: '已有任务在做', tone: 'run' };
  return { label: '已关联，待处理', tone: 'wait' };
}

/** 关联有效、且已有任务或 PR 在处理：交给修复后端会回 409 link_already_handled，不再摆它。 */
export function linkHandled(link: RepairLink | undefined): boolean {
  return Boolean(link && !link.invalid && link.stage !== 'linked');
}

/**
 * 「谁在处理」一行和当前事故的有效关联冲突：那一行说「没人在修」，关联却说这张单已绑定、在做或开着 PR。
 * 冲突时不能拿已知不对的「没人在修」顶在卡上（#3034 评审 5565720994）。
 */
export function handlingContradicted(n: Pick<Notification, 'handling' | 'repair'>): boolean {
  const link = n.repair?.linked;
  return Boolean(
    link && link.incident === n.repair?.incident && !link.invalid && n.handling?.stage === 'unclaimed',
  );
}

/** 卡上那一格现在是哪一段：queued 是这一页刚发出去还没回话；no-receipt 是发了没收到回执（超时、断网）。 */
export type RepairPhase =
  | 'queued'
  | 'no-receipt'
  | 'executing'
  | 'verifying'
  | 'verified'
  | 'failed'
  | 'unknown'
  | 'declined'
  | 'handed';

export const PHASE_META: Record<RepairPhase, { label: string; tone: Tone }> = {
  queued: { label: '已排队', tone: 'wait' },
  'no-receipt': { label: '没收到回执', tone: 'stall' },
  executing: { label: '执行中', tone: 'run' },
  verifying: { label: '核验中', tone: 'run' },
  verified: { label: '已修复', tone: 'done' },
  failed: { label: '没修成', tone: 'fail' },
  unknown: { label: '结果未知', tone: 'stall' },
  declined: { label: '没执行', tone: 'stop' },
  handed: { label: '已交给修复', tone: 'run' },
};

/** 后端记的那一条落在哪一段：accepted 只是收到了，算核验中；verified 才是已修复。 */
export function recordPhase(rec: RepairRecord): RepairPhase {
  if (rec.state === 'accepted') return 'verifying';
  return rec.state;
}

export const KIND_LABEL: Record<RepairAction['kind'], string> = {
  'task-recover': '叫醒任务继续',
  'release-retry': '重试发版',
  'release-restore': '恢复引擎开关',
  'release-abort': '撤掉暂停',
  'hand-to-repair': '交给修复',
};

/** 看门狗报的卡住报警（后端只给这类算修复动作）。 */
export function isWatchdogAlert(n: Pick<Notification, 'level' | 'dedupeKey'>): boolean {
  return n.level === 'alert' && (n.dedupeKey?.startsWith('watchdog:') ?? false);
}

/**
 * 有两个以上动作时推荐哪个、为什么：现有入口能直接恢复的（不带 choice 的先）排在交给修复前面；
 * 只有一个动作不写推荐（没得选）。
 */
export function recommendation(actions: readonly RepairAction[]): { id: string; why: string } | undefined {
  if (actions.length < 2) return undefined;
  const direct = actions.filter((a) => a.kind !== 'hand-to-repair');
  const pick = direct.find((a) => !a.choice) ?? direct[0];
  if (!pick) return undefined;
  return {
    id: pick.id,
    why: pick.choice
      ? '现有的恢复入口，能直接把现场拉回来；要你本人点了才动'
      : '现有的恢复入口，能直接把现场拉回来，先试它；不灵再交给修复',
  };
}

/** 要本人拍的动作写为什么要你拍：只有带 choice 的才有。 */
export function whyYouDecide(a: RepairAction): string | undefined {
  if (!a.choice) return undefined;
  if (a.kind === 'release-restore' || a.kind === 'release-abort')
    return '这一步会动引擎总开关，按规矩要你本人点准；选「先不动」或自己写一句都不会执行';
  return '后端标了这一步要你本人点准；选「先不动」或自己写一句都不会执行';
}

/**
 * 409 里哪些是「页面上的按钮已经不是现在的了」：刷新后按新的重选，不沿旧编号再点。
 * 其余 409（在执行、待核验、结果未知）也刷新，但卡上写后端那一句原话。
 */
export const STALE_CODES = new Set([
  'action_expired',
  'incident_mismatch',
  'alert_resolved',
  'repair_conflict',
  'alert_not_repairable',
]);

/** 卡上显示哪一条结果：这一页刚拿到的和列表里的，取更晚的那条；同一请求以列表（后端会再核验）为准。 */
export function shownRecord(
  listed: RepairRecord | undefined,
  local: RepairRecord | undefined,
): RepairRecord | undefined {
  if (!local) return listed;
  if (!listed) return local;
  if (listed.requestId === local.requestId) return listed;
  return Date.parse(local.at) > Date.parse(listed.at) ? local : listed;
}

/** 具体操作：动作对准的目标，一项一句（任务、仓、工作流 run、提交、发版那一趟）。 */
export function targetLines(target: RepairRecord['target']): string[] {
  if (!target) return ['这条记录没存目标（旧记录），不能当作核验过'];
  const out: string[] = [];
  if (target.issueNumber !== undefined)
    out.push(
      `任务 #${target.issueNumber}${target.repo ? `（${target.repo.owner}/${target.repo.name}）` : ''}`,
    );
  else if (target.repo) out.push(`仓 ${target.repo.owner}/${target.repo.name}`);
  if (target.workflowId) out.push(`工作流 ${target.workflowId}`);
  if (target.workflowRunId) out.push(`run ${target.workflowRunId}`);
  if (target.sha) out.push(`提交 ${target.sha.slice(0, 12)}`);
  if (target.releaseStartedAt) out.push(`发版这一趟起于 ${target.releaseStartedAt}`);
  return out;
}
