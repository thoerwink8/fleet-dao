// 库里的枚举。值表和 @fleet-dao/shared 的联合类型逐一对齐：少写或多写一个值，tsc 当场报错。
import type {
  BillingKind,
  HostId,
  OrgKind,
  ProgressKind,
  QuotaStatus,
  QuotaUnit,
  QuotaWindowKind,
  ReadingKind,
  RouteProbeState,
  RunAsUser,
  RunOutcome,
  ScheduleOutcome,
  StageKind,
  SubtaskState,
  TaskState,
} from '@fleet-dao/shared';
import { pgEnum } from 'drizzle-orm/pg-core';

type Missing<T, V extends readonly unknown[]> = Exclude<T, V[number]>;

/** 值表必须恰好覆盖联合类型 T 的全部成员。 */
export function valuesOf<T extends string>() {
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
  'verify',
  'research',
  'judge',
  'groom',
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
/** 会话能跑在哪些系统用户下：pools.run_as_user 的检查约束用它（不是 pg 枚举，值表写在约束里）。法国只有一个会话用户。 */
export const RUN_AS_USERS = valuesOf<RunAsUser>()(['fleet-agent-carpool']);
/**
 * 停用的会话用户（创始人 2026-09-26：reclaude 设备上限，法国只留一个会话用户；机器上已删）。只留在 session_runs
 * 的检查约束里认历史行，新写入一律不收（引擎只按 RUN_AS_USERS 起会话，目录配置里填它装载器明确报错）。
 */
export const RETIRED_RUN_AS_USERS = ['fleet-agent-dedicated'] as const;
export type RetiredRunAsUser = (typeof RETIRED_RUN_AS_USERS)[number];
export const ORG_KINDS = valuesOf<OrgKind>()(['solo', 'carpool']);
export const RUN_OUTCOMES = valuesOf<RunOutcome>()(['ok', 'failed', 'stopped', 'stalled']);
export const SCHEDULE_OUTCOMES = valuesOf<ScheduleOutcome>()(['ok', 'partial', 'unscanned', 'failed']);
/** 路由探针的结论（domain.ts 的 RouteProbeState）：只有 ok 让路由在线。 */
export const ROUTE_PROBE_STATES = valuesOf<RouteProbeState>()(['ok', 'failed', 'not_wired', 'skipped']);
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

/**
 * 全流程巡检（#223）一轮的结论：pass 通过；broken 断在哪一步；not_run 巡检自己没跑成（没配、仓读不到、开不了单）。
 * 「没跑成」和「跑了没问题」分开写，不许混。skipped（#1050）：巡检仓的「让 AI 接活」关着，这一轮开都没开（开了也不会被拉）：
 * 不是通过、不是断了、也不是巡检自己没跑成——不开单、不推卡住报警、不扫描，原因必须写。
 */
export const CANARY_VERDICTS = ['pass', 'broken', 'not_run', 'skipped'] as const;
export type CanaryVerdict = (typeof CANARY_VERDICTS)[number];

/**
 * 巡检看的整条链，一步一步（先后就是这个顺序），跟着三段任务工作流走（#452；specs/632-三段总调度/方案.md §五）：
 * 巡检自己开单 → 收单（拉单建了任务行、起了任务工作流）→ 动手（会话写出提交、推上去、开了 PR）→ 开 PR、过 CI →
 * 验收（冷验收通过）→ 合并 → 关单 → 记账（runs 每笔都有结局、记上了用量，每步耗时进了库）→ 驾驶舱显示（驾驶舱读到
 * 任务做完了、PR 合了、挂着这张单）。库里不加检查约束：以后加一步不用改表。
 */
export const CANARY_STAGES = [
  'open',
  'intake',
  'implement',
  'pr',
  'verify',
  'merge',
  'close',
  'ledger',
  'board',
] as const;
export type CanaryStage = (typeof CANARY_STAGES)[number];

/**
 * 跟 Fusion 走时的老步骤（派活、规划、执行）：换成三段任务工作流以后不再写，库里换版本之前的几轮还记着，只为读出来给人看。
 */
export const RETIRED_CANARY_STAGES = ['dispatch', 'plan', 'execute'] as const;
export type RetiredCanaryStage = (typeof RETIRED_CANARY_STAGES)[number];
/** canary_runs 的 stage、steps 里读得到的：现在的几步，加上老的几轮记下的老步骤。 */
export type RecordedCanaryStage = CanaryStage | RetiredCanaryStage;

/** 巡检每一步给人看的名字（报警、健康页、演练命令都用这一份）；老步骤也在，库里老的几轮读出来照样是人话。 */
export const CANARY_STAGE_NAMES: Readonly<Record<RecordedCanaryStage, string>> = {
  open: '开单',
  intake: '收单',
  implement: '动手',
  pr: '开 PR、过 CI',
  verify: '验收',
  merge: '合并',
  close: '关单',
  ledger: '记账',
  board: '驾驶舱显示',
  dispatch: '派活',
  plan: '规划',
  execute: '执行',
};

/** 巡检一轮最长多久（分钟）：到了还没走完，断在当时那一步。 */
export const CANARY_MAX_MINUTES = 300;
/**
 * 一轮的工作流最长活多久（分钟，Temporal 的 workflowRunTimeout）：比一轮的上限多给 30 分钟收尾。过了这么久还没有结论的一轮，
 * 工作流一定已经没了（被终止、工人丢了、看一回连着失败）：健康页不再说它「在跑」，下一轮开始时补记成没跑成。
 */
export const CANARY_RUN_TIMEOUT_MINUTES = CANARY_MAX_MINUTES + 30;

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
/** 探针还没看过的路由为空。 */
export const routeProbeState = pgEnum('route_probe_state', ROUTE_PROBE_STATES);

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
