// 库里的枚举。值表和 @fleet-dao/shared 的联合类型逐一对齐：少写或多写一个值，tsc 当场报错。
import type {
  BillingKind,
  HostId,
  ProgressKind,
  QuotaStatus,
  QuotaUnit,
  QuotaWindowKind,
  ReadingKind,
  RunOutcome,
  ScheduleOutcome,
  StageKind,
  SubtaskState,
  TaskState,
} from '@fleet-dao/shared';
import { pgEnum } from 'drizzle-orm/pg-core';

type Missing<T, V extends readonly unknown[]> = Exclude<T, V[number]>;

/** 值表必须恰好覆盖联合类型 T 的全部成员。 */
function valuesOf<T extends string>() {
  return <const V extends readonly [T, ...T[]]>(
    values: V & ([Missing<T, V>] extends [never] ? unknown : { missing: Missing<T, V> }),
  ): V => values;
}

export const STAGE_KINDS = valuesOf<StageKind>()([
  'triage',
  'spec',
  'plan',
  'execute',
  'ui',
  'review',
  'research',
  'judge',
]);
export const TASK_STATES = valuesOf<TaskState>()([
  'queued',
  'triaging',
  'asking',
  'planning',
  'running',
  'merging',
  'done',
  'stopped',
  'failed',
  'stalled',
]);
export const SUBTASK_STATES = valuesOf<SubtaskState>()([
  'pending',
  'waiting_deps',
  'waiting_slot',
  'running',
  'verifying',
  'in_merge_queue',
  'merged',
  'stopped',
  'failed',
  'stalled',
]);
export const BILLING_KINDS = valuesOf<BillingKind>()(['subscription', 'metered']);
export const READING_KINDS = valuesOf<ReadingKind>()(['measured', 'estimated']);
export const QUOTA_WINDOW_KINDS = valuesOf<QuotaWindowKind>()([
  '5h',
  '7d',
  '7d_model',
  'month_usd',
  'points',
  'period_usd',
  'other',
]);
export const QUOTA_UNITS = valuesOf<QuotaUnit>()(['percent', 'usd', 'tokens', 'points']);
export const QUOTA_STATUSES = valuesOf<QuotaStatus>()(['allowed', 'warning', 'limit_reached']);
export const HOST_IDS = valuesOf<HostId>()([
  'claude-code',
  'codex',
  'cursor-agent',
  'grok',
  'mirasim',
  'api-shell',
]);
export const RUN_OUTCOMES = valuesOf<RunOutcome>()(['ok', 'failed', 'stopped', 'stalled']);
export const SCHEDULE_OUTCOMES = valuesOf<ScheduleOutcome>()(['ok', 'partial', 'unscanned', 'failed']);
export const PROGRESS_KINDS = valuesOf<ProgressKind>()([
  'plan',
  'say',
  'tool',
  'file',
  'test',
  'ask',
  'done',
  'blocked',
]);

/** 终态：任务不会再往前走。 */
export const TERMINAL_TASK_STATES = ['done', 'stopped', 'failed'] as const satisfies readonly TaskState[];

export const stageKind = pgEnum('stage_kind', STAGE_KINDS);
export const taskState = pgEnum('task_state', TASK_STATES);
export const subtaskState = pgEnum('subtask_state', SUBTASK_STATES);
export const billingKind = pgEnum('billing_kind', BILLING_KINDS);
export const readingKind = pgEnum('reading_kind', READING_KINDS);
export const quotaWindowKind = pgEnum('quota_window_kind', QUOTA_WINDOW_KINDS);
export const quotaUnit = pgEnum('quota_unit', QUOTA_UNITS);
export const quotaStatus = pgEnum('quota_status', QUOTA_STATUSES);
export const hostId = pgEnum('host_id', HOST_IDS);
export const runOutcome = pgEnum('run_outcome', RUN_OUTCOMES);
export const progressKind = pgEnum('progress_kind', PROGRESS_KINDS);
/** 还在跑时为空。 */
export const scheduleOutcome = pgEnum('schedule_outcome', SCHEDULE_OUTCOMES);

// 下面几个不是 domain.ts 的对象；取值和驾驶舱接口（@fleet-dao/shared 的 web-api）用同一套写法。
/** 创始人、协作者、自家机器人（机器人不登录驾驶舱，只当 GitHub 作者白名单）。 */
export const userRole = pgEnum('user_role', ['founder', 'collaborator', 'bot']);
/** 通知三级：要人拍 / 卡住报警 / 日报。 */
export const notificationLevel = pgEnum('notification_level', ['decision', 'alert', 'daily']);
/** 谁做的：人 / AI 帅位 / 引擎 / 会话里的 AI。 */
export const actorKind = pgEnum('actor_kind', ['user', 'ai', 'engine', 'agent']);
/** 经哪里做的。 */
export const auditVia = pgEnum('audit_via', ['cockpit', 'feishu', 'github', 'engine', 'agent']);
export const prState = pgEnum('pr_state', ['open', 'closed', 'merged']);
/** PR 当前 head 上 CI 的汇总。 */
export const prChecks = pgEnum('pr_checks', ['success', 'failure', 'pending', 'none']);
/** Jev 题目的状态：只记不拦 / 真拦 / 停用。 */
export const jevMode = pgEnum('jev_mode', ['shadow', 'enforce', 'off']);
/** noul = 是非题（给「是」的概率），choice = 单选（带把握度）。 */
export const jevQuestionType = pgEnum('jev_question_type', ['noul', 'choice']);
/** 真值从哪来：人改判 / 结局回填 / 金丝雀考题。 */
export const jevTruthSource = pgEnum('jev_truth_source', ['human', 'outcome', 'canary']);
/** 状态变化记在谁身上。 */
export const stateEntity = pgEnum('state_entity', ['task', 'subtask']);
