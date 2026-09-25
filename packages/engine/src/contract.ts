// 工作流的对外约定：编号、输入输出、信号、查询。驾驶舱后端（发信号、起工作流）和引擎共用这一份。
// 输入带 schemaVersion；以后加字段只许可选、读时给默认值，不许改老字段的含义（在途任务的输入是老样子）。
// 编号的拼法（requirementWorkflowId、subtaskWorkflowId）进了在途任务的历史：改格式要用 patched()。

import type { Repo, StageKind, SubtaskState, TaskState } from '@fleet-dao/shared';
import { AGENT_EVENT_WAKE_KINDS as SHARED_WAKE_KINDS } from '@fleet-dao/shared/workflow-ids';
import { defineQuery, defineSignal } from '@temporalio/workflow';
import type { SubtaskSpec } from './decisions/plan.ts';
import type { Limits } from './limits.ts';
import type { WaitKind } from './ports.ts';

export const WORKFLOW_TYPES = {
  requirement: 'requirementWorkflow',
  subtask: 'subtaskWorkflow',
  mergeQueue: 'mergeQueueWorkflow',
  /** P0 验收（deploy/hello.sh）：跑一次就知道引擎工人在接活。 */
  hello: 'helloWorkflow',
} as const;

// 编号的拼法和驾驶舱后端共用一份（@fleet-dao/shared/workflow-ids）：后端按它给会话所属的工作流发叫醒。
export {
  mergeQueueWorkflowId,
  requirementWorkflowId,
  subtaskWorkflowId,
} from '@fleet-dao/shared/workflow-ids';

export function subtaskBranch(issueNumber: number, key: string): string {
  return `fleet/${issueNumber}-${key}`;
}

/** 需求文档目录的默认值，例如 `specs/12-登录验证码`。 */
export function defaultSpecDir(issueNumber: number, title: string): string {
  const slug = title
    .trim()
    .replace(/[\\/:*?"<>|#%{}^~[\]`'!$&()+,;=@]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug ? `specs/${issueNumber}-${slug}` : `specs/${issueNumber}`;
}

export type RouteOverrides = Partial<Record<StageKind, string>>;

export interface RequirementInput {
  schemaVersion: 1;
  /** 库里的 tasks.id。 */
  taskId: string;
  repo: Repo;
  issueNumber: number;
  title: string;
  /** 创始人原话。 */
  rawRequest: string;
  requestedBy: string;
  specDir?: string;
  limits?: Partial<Limits>;
  routeOverrides?: RouteOverrides;
}

export interface SubtaskInput {
  schemaVersion: 1;
  taskId: string;
  /** 库里的 subtasks.id（需求工作流拆方案时经 decide 生成、记在历史里的 UUID）。 */
  subtaskId: string;
  repo: Repo;
  issueNumber: number;
  specDir: string;
  subtask: SubtaskSpec;
  limits?: Partial<Limits>;
  routeOverrides?: RouteOverrides;
}

export interface MergeItem {
  itemId: string;
  subtaskWorkflowId: string;
  taskId: string;
  subtaskId: string;
  subtaskKey: string;
  repo: Repo;
  prNumber: number;
  branch: string;
  head: string;
  enqueuedAt: string;
}

export type MergeResult =
  | { itemId: string; outcome: 'merged'; mergeCommit: string }
  | {
      itemId: string;
      outcome: 'returned';
      reason: 'conflict' | 'tests-red' | 'tests-stale' | 'merge-failed' | 'infra';
      detail: string;
      files: string[];
    }
  /** 撤出（暂停、要等批准、叫停）确认了：这一条不会再合。撤出前已经合上的回 merged，不回这个。 */
  | { itemId: string; outcome: 'withdrawn' };

export interface MergeResultDelivery {
  subtaskWorkflowId: string;
  result: MergeResult;
}

export interface MergeQueueCarry {
  queue: MergeItem[];
  processed: number;
  /** 最近的结果：子任务等太久重新入队时直接补发，不重合。 */
  recent: MergeResultDelivery[];
}

export interface MergeQueueInput {
  schemaVersion: 1;
  repo: Repo;
  limits?: Partial<Limits>;
  carried?: MergeQueueCarry;
}

export type SubtaskOutcome = 'merged' | 'failed' | 'stopped';

export interface SubtaskResult {
  key: string;
  subtaskId: string;
  state: SubtaskOutcome;
  prNumber: number | null;
  mergeCommit: string | null;
  summary: string;
  problem: string | null;
  rounds: { review: number; ciFix: number; conflict: number; mergeReturn: number };
}

export interface RequirementResult {
  taskId: string;
  state: 'done' | 'failed' | 'stopped';
  subtasks: SubtaskResult[];
  docs: { requirement?: string; plan?: string; result?: string };
  problem: string | null;
}

export interface MergeQueueResult {
  processed: number;
}

// ---- 查询

export interface Waiting {
  kind: WaitKind;
  /** 白话，例如「等「a」合并」「等 Claude 订阅 A 号的空位」。 */
  detail: string;
  since: string;
  on?: string[];
  askId?: string;
  approvalId?: string;
}

/** 人闸的批准：一次只等一张，绑在送进合并队列的那个头上（头变了要重新批）。 */
export interface ApprovalView {
  approvalId: string;
  holds: string[];
  head: string;
  state: 'pending' | 'approved' | 'rejected';
  by?: string;
  reason?: string;
  at?: string;
}

/** 每条命令的受理结果：信号没有回执，受理与否写在这里，不静默丢弃。 */
export interface CommandReceipt {
  command: string;
  at: string;
  accepted: boolean;
  note: string;
  by?: string;
}

/** fleet 命令写库后叫醒工作流的那一下（最近一次）。 */
export interface AgentEventSeen {
  runId: string;
  kind: AgentEventCommand['kind'];
  askId?: string;
  at: string;
}

export type SubtaskStep = 'worktree' | 'execute' | 'verify' | 'merge' | 'cleanup' | 'finished';

export interface SubtaskStatus {
  kind: 'subtask';
  taskId: string;
  subtaskId: string;
  key: string;
  title: string;
  state: SubtaskState;
  step: SubtaskStep;
  /** 白话「正在：……」。 */
  doing: string;
  paused: boolean;
  parked: boolean;
  waiting: Waiting | null;
  route: { routeId: string; modelId: string; why: string } | null;
  /** 正在跑的会话（库里 session_runs.id）。 */
  runId: string | null;
  sessionId: string | null;
  prNumber: number | null;
  head: string | null;
  rounds: { review: number; ciFix: number; conflict: number; mergeReturn: number };
  /** 人闸标记（方案、分诊判出的，加上人工加的）；空 = 不用等人批。 */
  holds: string[];
  approval: ApprovalView | null;
  lastProblem: string | null;
  lastAgentEvent: AgentEventSeen | null;
  commands: CommandReceipt[];
}

export type RequirementPhase = 'triage' | 'asking' | 'spec' | 'plan' | 'running' | 'result' | 'finished';

export interface SubtaskView {
  id: string;
  key: string;
  title: string;
  state: SubtaskState;
  workflowId: string | null;
  prNumber: number | null;
  paused: boolean;
  waiting: Waiting | null;
  touches: string[];
  dependsOn: string[];
  holds: string[];
}

export interface RequirementStatus {
  kind: 'requirement';
  taskId: string;
  issueNumber: number;
  state: TaskState;
  phase: RequirementPhase;
  doing: string;
  paused: boolean;
  parked: boolean;
  waiting: Waiting | null;
  /** 分诊、需求文档、方案这几步的会话。 */
  route: { routeId: string; modelId: string; why: string } | null;
  runId: string | null;
  sessionId: string | null;
  subtasks: SubtaskView[];
  progress: { done: number; total: number };
  docs: { requirement?: string; plan?: string; result?: string };
  lastProblem: string | null;
  lastAgentEvent: AgentEventSeen | null;
  commands: CommandReceipt[];
}

export interface MergeQueueStatus {
  kind: 'merge-queue';
  repo: string;
  current: { itemId: string; prNumber: number; subtaskKey: string; step: string } | null;
  queue: { itemId: string; prNumber: number; subtaskKey: string }[];
  processed: number;
}

/** 查询只给人调试和驾驶舱兜底用；驾驶舱平时读 Postgres（查询要重放历史，结束太久的执行可能查不了）。 */
export const requirementStatusQuery = defineQuery<RequirementStatus>('status');
export const subtaskStatusQuery = defineQuery<SubtaskStatus>('status');
export const mergeQueueStatusQuery = defineQuery<MergeQueueStatus>('status');

// ---- 信号：名字和参数跟驾驶舱后端的 TaskSignal 一一对应（信号名 = TaskSignal.name，参数 = 去掉 name 的其余字段）。
// 人发的命令（暂停、继续、叫停、换路由、回答、批准……）按任务发给需求工作流，需求转给在跑的子任务；
// 带 subtaskId 的也可以直接发给 subtaskWorkflowId(subtaskId)，子任务自己认。
// fleet 命令的叫醒（agentEvent）不经需求转：只发会改变走向的几类（AGENT_EVENT_WAKE_KINDS），直接发给会话所属的工作流——
// 子任务的会话发 subtaskWorkflowId(session_runs.subtask_id)，需求自己的会话（分诊、需求文档、方案）发需求工作流。
// 其余几类（say、plan）只进库，驾驶舱从库里读：每条都发信号的话，一个需求二十来个子任务就能把需求的历史撑到上万条事件，
// 撞上 Temporal 每条执行 1 万个信号的上限后，连叫停都发不进去。

/** 可选字段都收 undefined：后端的 TaskSignal 就是这么写的。 */
export interface CommandMeta {
  by?: string | undefined;
  reason?: string | undefined;
}

export interface RerouteCommand extends CommandMeta {
  routeId: string;
  /** 只换这个子任务（库里的 subtasks.id）；不给就是整个需求。 */
  subtaskId?: string | undefined;
  /** 只换这个阶段；不给就是主线那几步（需求的分诊/需求文档/方案、子任务的写码）。 */
  stage?: StageKind | undefined;
}

export interface AnswerCommand {
  by?: string | undefined;
  askId: string;
  answer: string;
}

export interface AgentEventCommand {
  /** 哪一次会话（session_runs.id）。 */
  runId: string;
  kind: 'plan' | 'say' | 'ask' | 'done' | 'blocked';
  askId?: string | undefined;
}

/** 会改变走向、才值得叫醒工作流的几类 fleet 命令；其余（say、plan）只进库，发来了引擎也不理。和后端共用一份。 */
export const AGENT_EVENT_WAKE_KINDS: readonly AgentEventCommand['kind'][] = SHARED_WAKE_KINDS;

/** 批准或拒绝人闸。点名批准编号（卡片上带的）或子任务；都不点名的不受理（一次批一张，不一把全批）。 */
export interface ApprovalCommand {
  by?: string | undefined;
  approvalId?: string | undefined;
  subtaskId?: string | undefined;
  reason?: string | undefined;
}

/** 人工给子任务加人闸（release 对外发布、spend 花钱、delete 删数据）。不点名子任务就是整个需求。 */
export interface RequireApprovalCommand {
  by?: string | undefined;
  subtaskId?: string | undefined;
  holds: string[];
  reason?: string | undefined;
}

/** 暂停：会话停在干净的点（做完的先提交），不再开新步骤；排在合并队列里还没合的撤出来。 */
export const pauseSignal = defineSignal<[CommandMeta?]>('pause');
/** 继续：解除暂停，或解除「挂起并报警」。 */
export const resumeSignal = defineSignal<[CommandMeta?]>('resume');
/** 叫停：停会话、撤出合并队列、收工作树，任务以 stopped 结束。 */
export const stopSignal = defineSignal<[CommandMeta?]>('stop');
/** 换路由：接下来用这条路由；正在跑的会话停在干净的点后换上。 */
export const rerouteSignal = defineSignal<[RerouteCommand]>('reroute');
/** 回答追问。 */
export const answerSignal = defineSignal<[AnswerCommand]>('answer');
/** fleet 命令写库之后叫醒工作流：只有 AGENT_EVENT_WAKE_KINDS 这几类，直接发给会话所属的工作流。 */
export const agentEventSignal = defineSignal<[AgentEventCommand]>('agentEvent');
/** 批准人闸：这个子任务可以进合并队列了。 */
export const approveSignal = defineSignal<[ApprovalCommand]>('approve');
/** 拒绝人闸：不合，理由作为返工意见回主会话。 */
export const rejectSignal = defineSignal<[ApprovalCommand]>('reject');
/** 人工加人闸。 */
export const requireApprovalSignal = defineSignal<[RequireApprovalCommand]>('requireApproval');

/** 驾驶舱后端现在会发的信号名全集（和 TaskSignal['name'] 对得上，contract.test.ts 编译期对拍）。 */
export const TASK_SIGNAL_NAMES = ['pause', 'resume', 'stop', 'reroute', 'answer', 'agentEvent'] as const;
/** 引擎已经收、后端还没发的信号（人闸）。后端加进 TaskSignal 后挪进上面那张表——contract.test.ts 编译期会提醒。 */
export const NEW_TASK_SIGNAL_NAMES = ['approve', 'reject', 'requireApproval'] as const;

// ---- 引擎内部信号

export interface SubtaskProgress {
  key: string;
  state: SubtaskState;
  prNumber: number | null;
  paused: boolean;
  waiting: Waiting | null;
  holds: string[];
}

/** 子任务 → 需求：状态变了。 */
export const subtaskProgressSignal = defineSignal<[SubtaskProgress]>('subtaskProgress');
/** 子任务（经活动）→ 合并队列：排进来。 */
export const enqueueSignal = defineSignal<[MergeItem]>('enqueue');
/** 子任务 → 合并队列：撤出。队列一定回一条结果（withdrawn；撤出前已经合上的回 merged）。 */
export const withdrawSignal = defineSignal<[{ itemId: string; subtaskWorkflowId: string }]>('withdraw');
/** 合并队列 → 子任务：合并结果。 */
export const mergeResultSignal = defineSignal<[MergeResult]>('mergeResult');
