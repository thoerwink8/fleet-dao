// 后端和引擎共用的外部能力，一律按接口写：数据库（pg-store.ts 用 @fleet-dao/db 实现）、GitHub 补收
// 由各自的实现接进来；测试和本地开发用 memory-store.ts。两个 Store 实现过同一套契约测试（test/store-contract.ts），
// 改这里的语义要两边一起改、契约测试跟着改。只给后端用的接口（Temporal 信号、飞书登录、健康检查……）在 api/src/ports.ts。
import type {
  AuditEntrySchema,
  Ban,
  Channel,
  ChannelStateRecord,
  CiPolicy,
  DecisionAnswer,
  DecisionExecution,
  DecisionOption,
  FlowAssignment,
  LocalSessionsReport,
  Model,
  NewFlowAssignment,
  NodeReport,
  NodeSnapshot,
  Pool,
  QuotaWindow,
  Repo,
  Route,
  ScheduleOutcome,
  SegmentMatch,
  SegmentRun,
  Step,
  Subtask,
  Task,
  TaskListGroup,
  WorktreeInventory,
} from '@fleet-dao/shared';
import type { z } from 'zod';
import type { CheckoutSource } from './checkout-source.ts';

/** 任务列表的一页：行、各组的数、下一页游标。 */
export interface TaskListPage {
  items: { task: Task; updatedAt: string }[];
  counts: Record<TaskListGroup, number>;
  nextCursor?: string | undefined;
}

/** 一张单的三段流水（库里的 runs 表）一笔，加上它是怎么和这张单对上的。 */
export type SegmentRunRecord = SegmentRun & {
  matchedBy: SegmentMatch;
  temporalRunId?: string | undefined;
  worktreePath?: string | undefined;
  /**
   * 对上的是哪张单。listSegmentRunsForTasks 开了 includeIssueMatch 时才写：task_id 对上的就是 taskId，
   * task_id 没记、按单号兜底的是那张单的 id。主页那条路不写。
   */
  matchedTaskId?: string;
};

/** 库里的一行额度窗：原名、单位、读法入库必填（领域类型里可选，是给还没入库的读数用的）；staleSince 由库的写入口管。 */
export type QuotaWindowRecord = QuotaWindow & Required<Pick<QuotaWindow, 'label' | 'unit' | 'source'>>;

/** 额度窗历史的一行（#2737，库里是 quota_window_samples）：算用量速度、清零时会作废多少用。 */
export interface QuotaSampleRecord {
  poolId: string;
  label: string;
  window: QuotaWindow['window'];
  unit: NonNullable<QuotaWindow['unit']>;
  reading: QuotaWindow['reading'];
  utilization?: number;
  resetsAt?: string;
  readAt: string;
}

// —— 人 ——

export type UserRole = 'founder' | 'collaborator' | 'bot';

/**
 * users 表的一行，两用：驾驶舱登录白名单（只放 role=founder）+ GitHub 作者白名单（创始人、协作者、自家机器人）。
 * 机器人只按 GitHub 数字编号认。
 */
export interface User {
  id: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  avatarUrl?: string | undefined;
  /** 飞书 open_id（应用内唯一）；登录只认它或 union_id，不认邮箱和手机号（飞书文档：那两项未经本人验证）。 */
  feishuOpenId?: string | undefined;
  feishuUnionId?: string | undefined;
  githubLogin?: string | undefined;
  /** 有数字编号就只按编号认（登录名可改、可被别人注册）。 */
  githubId?: number | undefined;
  /** 会话版本（设密码、改密码、退出时加 1）：会话 Cookie 里的版本对不上就作废。没有按 0 算。 */
  sessionVersion?: number | undefined;
}

/**
 * 账密登录要用的几列（#120）。不放进 User：密码哈希不该跟着用户信息到处传。
 * failedLogins / lockedUntil 是按用户名的防暴力计数：连续输错到上限就锁一段时间，锁期内对的密码也不放。
 */
export interface PasswordCredentials {
  userId: string;
  username?: string | undefined;
  passwordHash?: string | undefined;
  passwordChangedAt?: string | undefined;
  failedLogins: number;
  lockedUntil?: string | undefined;
}

/** 谁做的。user = 驾驶舱用户；ai = AI 帅位；engine = 引擎；agent = 会话里的 AI；ops = 服务器上的运维脚本（fleet-api 命令行）。 */
export interface Actor {
  kind: 'user' | 'ai' | 'engine' | 'agent' | 'ops';
  id: string;
}

export type AuditRecord = z.infer<typeof AuditEntrySchema>;
export type AuditVia = AuditRecord['via'];

/** 操作记录只追加。ok=false 必须带 error（库里有约束，内存版照样拦）。 */
export interface NewAuditEntry {
  actor: Actor;
  action: string;
  target: string;
  before?: unknown;
  after?: unknown;
  reason?: string | undefined;
  via: AuditVia;
  ok: boolean;
  error?: string | undefined;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string | undefined;
}

export interface PageRequest {
  /** 上一页的 nextCursor。看不懂就抛 InvalidCursorError（翻页的方法都这样）。 */
  cursor?: string | undefined;
  limit: number;
}

// —— 记录形状 ——

export interface RunPlan {
  steps: Step[];
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  name: string;
  schedule: string;
  expectEveryMinutes: number;
  /** 最近一次（按开始时刻）；一次都没跑过就没有。 */
  lastRun?:
    | {
        startedAt: string;
        endedAt?: string | undefined;
        /** 还在跑时没有。 */
        outcome?: ScheduleOutcome | undefined;
        scanned?: number | undefined;
        found?: number | undefined;
        why?: string | undefined;
      }
    | undefined;
  /** 最近一次跑成（ok 或 partial）的结束时刻。 */
  lastSuccessAt?: string | undefined;
}

export interface DeliveryRecord {
  channel: string;
  /** 送到哪（飞书推送：team = 团队群，user:<open_id> = 私聊）。同一条通知、同一去处只有一条送达记录。 */
  target?: string | undefined;
  /** 飞书返回的消息编号；没有就是没送到。 */
  messageId?: string | undefined;
  attempts: number;
  error?: string | undefined;
  lastAttemptAt?: string | undefined;
}

export interface NotificationRecord {
  id: string;
  level: 'decision' | 'alert' | 'daily';
  title: string;
  body: string;
  link?: string | undefined;
  taskId?: string | undefined;
  createdAt: string;
  /** 同 key 撤卡重开时才变化；开放期间重复报警不变，区分事故代次。 */
  raisedAt?: string | undefined;
  resolvedAt?: string | undefined;
  resolvedBy?: string | undefined;
  deliveries: DeliveryRecord[];
  /**
   * 去重键（「同一件事一条」的认法）：approvals 的是 approval:<编号>，主页据此把通知标成「待批」。
   * 老数据（镜像里没存过的）没有。
   */
  dedupeKey?: string | undefined;
  /** 「要你拍」的选项（#1915）；老的、补不出选项的没有。 */
  options?: DecisionOption[] | undefined;
  /** 拍过了：选了什么、什么时候、谁，照着做的结果（answer.execution）。 */
  answer?: DecisionAnswer | undefined;
}

/** 回答「要你拍」的结局：存下了（连同存下的那条）；这条不是要人拍的、已经处理过、没有这条、选项编号认不出。 */
export type AnswerNotificationResult =
  | { kind: 'ok'; notification: NotificationRecord }
  | { kind: 'not_decision' | 'already_resolved' | 'not_found' | 'unknown_option' | 'conflict' | 'in_flight' };

export interface SettingRecord {
  key: string;
  value: unknown;
  /** 每改一次加 1，第一次写入是 1；从没设过的键不在结果里。 */
  version: number;
  updatedAt?: string | undefined;
  updatedBy?: string | undefined;
}

/**
 * GitHub 镜像里的 PR。checks = 当前 head 上 CI 的汇总。
 * openedAt / mergedAt / issueRefs：主页「做完的」要按合并时刻排、要反查挂的单；「没读到过」还是 undefined，
 * 不拿「没有打开时刻」冒充「没合并」。
 */
export interface PullRequestRecord {
  repoId: string;
  number: number;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  headSha: string;
  checks: 'success' | 'failure' | 'pending' | 'none';
  /** GitHub 上这条 PR 的最后更新时间。 */
  updatedAt?: string | undefined;
  openedAt?: string | undefined;
  mergedAt?: string | undefined;
  issueRefs?: number[] | undefined;
  /** GitHub 上的 PR 标题；没读到过是 undefined（旧行、事件没带）。 */
  title?: string | undefined;
}

/** 历史 checkout 的 DB 候选 runs 身份；旧 Temporal 空列保留原样，精确来源另由可信 reader 核验。 */
export interface HistoricalCheckoutRun {
  id: string;
  segment: string;
  taskId?: string | undefined;
  issueNumber?: number | undefined;
  model: string;
  workflowId?: string | undefined;
  temporalRunId?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  outcome?: string | undefined;
  failureReason?: string | undefined;
  prNumber?: number | undefined;
  branch?: string | undefined;
  worktreePath?: string | undefined;
}

/** 预检和原子归档共用的精确身份。expected 字段是预检回显后执行时的 CAS 快照。 */
export interface HistoricalCheckoutArchiveInput {
  notificationId: string;
  dedupeKey: string;
  raisedAt: string;
  notificationBody: string;
  notificationLink: string | null;
  repo: string;
  repoId: string;
  taskId: string;
  issueNumber: number;
  workflowId: string;
  runId: string;
  temporalRunId: string;
  executionRunId: string;
  runSegment: string;
  runStartedAt: string;
  runEndedAt: string;
  runOutcome: string;
  runPrNumber: number;
  pr: number;
  head: string;
  operator: string;
  reason: string;
  evidence: string;
  gaps: string;
  responsibility: string;
  conclusion: 'historical_unproven';
}

/** checkout 历史归档前现读到的全部事实；它不是恢复证明。 */
export interface HistoricalCheckoutFacts {
  notification: NotificationRecord;
  repo: Repo;
  task: Task;
  run: HistoricalCheckoutRun;
  pullRequest: PullRequestRecord;
  activeRunIds: string[];
}

/** 已结束且误记 abandoned 的任务，纠正前现读到的 run（只读，不是已合并证明）。 */
export interface MergedCorrectionRunFact {
  id: string;
  segment: string;
  workflowId?: string | undefined;
  temporalRunId?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  outcome?: string | undefined;
}

/** tasks.phase / doing / last_problem / updated_at：纠正的 CAS 快照，库里读不到的列是 null。 */
export interface MergedCorrectionLedger {
  phase: string | null;
  doing: string | null;
  lastProblem: string | null;
  updatedAt: string | null;
}

/** 之前已做过的受管纠正（审计里 action=task.correct-merged、target=task:<id> 的成功行）。 */
export interface MergedCorrectionPrior {
  auditId: string;
  at: string;
  pr: number | null;
  head: string | null;
  mergeCommit: string | null;
  temporalRunId: string | null;
  evidenceKey: string | null;
}

export interface MergedCorrectionFacts {
  task: Task;
  ledger: MergedCorrectionLedger;
  runs: MergedCorrectionRunFact[];
  /** 还没结束的 run（活会话）。 */
  activeRunIds: string[];
  prior?: MergedCorrectionPrior | undefined;
}

/** 执行纠正的精确身份和预检时看到的 CAS 快照；事务内重读，任何一项变了都 conflict。 */
export interface MergedCorrectionInput {
  repoId: string;
  taskId: string;
  issueNumber: number;
  workflowId: string;
  temporalRunId: string;
  pr: number;
  head: string;
  mergeCommit: string;
  /** 预检时的任务账：state 必须是 stopped、phase 必须是 abandoned，且 doing/updatedAt/run 集合没变。 */
  expected: { phase: string; doing: string | null; updatedAt: string | null; runIds: string[] };
  /** 纠正后的 tasks.doing。 */
  doing: string;
  /** 已核事实（GitHub PR、Temporal 终态）的规范化摘要；同一请求重复必须相同。 */
  evidenceKey: string;
}

export type MergedCorrectionResult =
  | { result: 'ok' | 'already_corrected' }
  | { result: 'not_found' | 'conflict'; why: string };

/** 受管纠正的审计动作和对象；成功行只由 correctMergedAbandoned 在同一事务里写。 */
export const MERGED_CORRECTION_ACTION = 'task.correct-merged';
export const mergedCorrectionTarget = (taskId: string): string => `task:${taskId}`;

/** 内存版和 Postgres 版共用：事务内读到的事实对不对得上请求。不写任何东西。 */
export function judgeMergedCorrection(
  facts: MergedCorrectionFacts | null,
  input: MergedCorrectionInput,
): MergedCorrectionResult {
  const conflict = (why: string): MergedCorrectionResult => ({ result: 'conflict', why });
  if (!facts) return { result: 'not_found', why: '库里没有这张任务' };
  const { task, ledger, runs, activeRunIds, prior } = facts;
  if (task.id !== input.taskId || task.repoId !== input.repoId || task.issueNumber !== input.issueNumber)
    return conflict('任务、仓或单号与请求不一致');
  if (prior) {
    const same =
      prior.pr === input.pr &&
      prior.head === input.head &&
      prior.mergeCommit === input.mergeCommit &&
      prior.temporalRunId === input.temporalRunId &&
      prior.evidenceKey === input.evidenceKey;
    return same
      ? { result: 'already_corrected' }
      : conflict('这张任务已做过受管纠正，PR、head、合并提交、run 或证据与本次请求不同');
  }
  if (task.state !== 'stopped' || ledger.phase !== 'abandoned')
    return conflict(`任务现在是 ${task.state}/${ledger.phase ?? '无阶段'}，不是已结束的 stopped/abandoned`);
  if (task.executor === 'local' || task.claimedBy !== undefined || task.leaseUntil !== undefined)
    return conflict('任务被本机领着，不是已结束的引擎任务');
  if (activeRunIds.length > 0) return conflict(`仍有未结束的会话：${activeRunIds.join('、')}`);
  const e = input.expected;
  if (ledger.phase !== e.phase || ledger.doing !== e.doing || ledger.updatedAt !== e.updatedAt)
    return conflict('任务账与预检时看到的不一样（已被改动），请重新预检');
  const now = runs.map((r) => r.id).sort();
  const was = [...e.runIds].sort();
  if (now.length !== was.length || now.some((id, i) => id !== was[i]))
    return conflict('任务的 run 集合与预检时不一样（出现了新的运行），请重新预检');
  // 持久 run 必须存在，且每一条都精确绑定请求的工作流和 Temporal run；缺字段不当成「对得上」
  if (runs.length === 0) return conflict('任务没有持久的 run 记录，证明不了请求的 Temporal run 是它的原 run');
  if (runs.some((r) => r.workflowId !== undefined && r.workflowId !== input.workflowId))
    return conflict('任务有别的工作流（换代）的 run，不是同一代');
  if (runs.some((r) => r.temporalRunId !== undefined && r.temporalRunId !== input.temporalRunId))
    return conflict('任务有别的 Temporal run，请求的 run 不是它的原 run');
  if (runs.some((r) => r.workflowId === undefined || r.temporalRunId === undefined))
    return conflict('任务有 run 没记工作流编号或 Temporal run，绑定不上请求的 run');
  return { result: 'ok' };
}

/**
 * 会话里跑过的一次测试（checkDone 的输入）。passed 为 null 是结果认不出（接了管道、放了后台……，
 * 插头写明了原因），照样列出来：交活核对以最后一次为准，认不出的那一次不能被它前面一次「通过」顶掉。
 */
export interface TestRunRecord {
  at: string;
  passed: boolean | null;
  command?: string | undefined;
  /** passed 为 null 时：为什么认不出。 */
  unknownBecause?: string | undefined;
}

export interface HistoryItem {
  taskId: string;
  title: string;
  specDir?: string | undefined;
  resultSummary?: string | undefined;
  mergedAt?: string | undefined;
}

/**
 * 幂等键的状态：
 * - claimed：这次占到了，去执行。token 是这次占用的凭据，记结果、放键都要拿它（被接管后旧凭据就作废）；
 *   tookOver = 接过了一个多半已经死掉的占用。
 * - done：以前执行成功过，直接回当时的结果。
 * - in-flight：上一次还在处理。
 * - other-action：这个键已经用在别的命令上了（一条命令一个键）。
 */
export type CommandClaim =
  | { status: 'claimed'; token: string; tookOver?: true }
  | { status: 'done'; result: unknown }
  | { status: 'in-flight'; claimedAt: string }
  | { status: 'other-action'; action: string };

// —— 数据访问（按用途拆开）——
// 所有按编号查的方法：编号格式不对（例如不是 uuid）当作「没有」，不抛错——编号来自网址，不能让它变成 500。

export interface UserStore {
  getUser(id: string): Promise<User | null>;
  findUserByFeishu(ids: { openId: string; unionId?: string | undefined }): Promise<User | null>;
  listUsers(): Promise<User[]>;
  /** 按账密登录的用户名找人，大小写不敏感。 */
  findUserByUsername(username: string): Promise<User | null>;
  /** 没这个人（含编号不是 uuid）是 null。 */
  getPasswordCredentials(userId: string): Promise<PasswordCredentials | null>;
  /** 会话版本加 1：这个人别处已登的会话全部作废。没这个人返回 false。 */
  bumpSessionVersion(userId: string): Promise<boolean>;
  /**
   * 设或改用户名、密码哈希（给了哪样改哪样；给了哈希就记改密时间 at、会话版本加 1——别处已登的会话作废），
   * 同时把输错计数和锁清零。和操作记录同一事务。
   * 用户名大小写不敏感地被别人占了：username_taken，什么都不改。
   */
  setPasswordCredentials(
    input: { userId: string; username?: string | undefined; passwordHash?: string | undefined; at: Date },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'not_found' | 'username_taken'>;
  /**
   * 记一次输错（一条语句原子地做）：锁已过期的先清零再记；记到 maxFails 次就锁到 at + lockMs、计数清零；
   * 正锁着的什么都不改。返回现在锁到什么时候（没锁着 = 没有 lockedUntil）。没这个人返回 null。
   */
  recordPasswordFailure(input: {
    userId: string;
    at: Date;
    maxFails: number;
    lockMs: number;
  }): Promise<{ lockedUntil?: string | undefined } | null>;
  /** 登录成功：输错计数和锁清零。 */
  recordPasswordSuccess(userId: string): Promise<void>;
}

export interface BoardStore {
  listRepos(): Promise<Repo[]>;
  getRepo(id: string): Promise<Repo | null>;
  /** 看板上的需求：没结束的，加上进入终态不到 7 天的。按优先级、再按建单先后排。 */
  listBoardTasks(repoId: string): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  /**
   * 全程模式的分组记录（#2823，task_flow_assignments）：每张单最多一行，写一次。分组时刻用 Store 的钟。
   * 同一张单写第二次抛 FlowAssignmentExistsError，不覆盖；没有这张单抛普通错。
   */
  writeFlowAssignmentOnce(input: NewFlowAssignment): Promise<FlowAssignment>;
  /** 读一张单的分组记录；没分过组、编号不是 uuid 都是 null。 */
  getFlowAssignment(taskId: string): Promise<FlowAssignment | null>;
  /** 一次读多张单的分组记录。编号不是 uuid 的跳过；没分过组的不在结果里。 */
  listFlowAssignments(taskIds: readonly string[]): Promise<FlowAssignment[]>;
  /**
   * 任务列表页（#1639）：所有仓的需求（不限 7 天窗口，做完、失败、叫停的都在），按最近更新（开单、快照写入、状态最近一次变化三者最晚）倒序翻页，
   * 同一毫秒的按编号倒序。分组规则在 shared 的 taskListGroupOf。仓编号不是 uuid（库版）或不存在，回空页、各组都是 0。
   * q：全是数字（可带 #）= 单号精确，也找标题里带这串数字的；其余 = 标题包含，不分大小写。counts 受仓和 q 影响、不受 group 影响。
   * 游标看不懂抛 InvalidCursorError。
   */
  listTasks(
    query: {
      group?: TaskListGroup | undefined;
      repoId?: string | undefined;
      q?: string | undefined;
    } & PageRequest,
  ): Promise<TaskListPage>;
  listSubtasks(taskIds: readonly string[]): Promise<Subtask[]>;
  /**
   * 一张单的三段流水（runs 表），按起跑先后：task_id 是这张单的（matchedBy = task），加上 task_id 没记、单号对得上、
   * 工作流是这张单第一代或重做下一代（:r2、:r3）的老行（matchedBy = issueNumber）。工作流对不上、或没记的不收
   * （别的仓可能有同号的单）。没这张单（含编号不是 uuid）回空。memory-store.ts 是参照实现。
   */
  listSegmentRuns(taskId: string): Promise<SegmentRunRecord[]>;
  /**
   * 一批单的三段流水，一次读完（主页流水线图用，一张张读要几十个往返）。默认只认 task_id 对得上的行（matchedBy 一律 task）：
   * task_id 没记的老行不按单号兜底（主页这条路不收；老单在图上落进「还没分段」）。
   * includeIssueMatch：任务列表要各代的花费，再收 task_id 没记、单号和工作流（含重做 :rN）对得上的，matchedTaskId 写对上的单。
   * 按起跑先后排；不是 uuid 的编号忽略；一张单都没给回空。memory-store.ts 是参照实现。
   */
  listSegmentRunsForTasks(
    taskIds: readonly string[],
    opts?: { includeIssueMatch?: boolean },
  ): Promise<SegmentRunRecord[]>;
  /**
   * PR 镜像（新主页「做完的」、将来「在跑的」判合并段用）：state 给了只要那个状态；merged 按 mergedAt 倒序、
   * 其余按 updatedAt 倒序，最多 limit 条（默认 50）。镜像里没有的就给不出——不直接查 GitHub。
   * repoId / issueNumber 给了就在库里先按仓、按正文挂的单（issue_refs）筛，再排序截断：查某张单有没有开放 PR 要用它，
   * 不能读全局前 N 条再在内存里筛（别的仓 PR 一多，目标 PR 就被截掉了）。
   */
  listPullRequests(input?: {
    state?: PullRequestRecord['state'] | undefined;
    repoId?: string | undefined;
    issueNumber?: number | undefined;
    limit?: number | undefined;
  }): Promise<PullRequestRecord[]>;
}

/**
 * 账号池占着的名额，一次读出来（#1747，各页「在跑的会话」「池占用」唯一来源）：每个池在跑的（已开工）、已选定还没开跑的分开数，
 * 加上在跑的会话按段（用途）分的数。在跑数合计 = 各池 inFlight 之和。
 */
export interface PoolOccupancyRead {
  pools: { poolId: string; inFlight: number; reserved: number }[];
  inFlightByStage: Record<string, number>;
}

export interface RoutingStore {
  /** 池占用，见 PoolOccupancyRead。读不到抛，不当 0。 */
  poolOccupancy(): Promise<PoolOccupancyRead>;
  listChannels(): Promise<Channel[]>;
  /** 渠道近态（#1118）：只有运行中失败出过事的渠道有行；读不到抛错，不给空的顶。 */
  listChannelStates(): Promise<ChannelStateRecord[]>;
  listPools(): Promise<Pool[]>;
  listModels(): Promise<Model[]>;
  listRoutes(): Promise<Route[]>;
  /** 库里另配的禁令（两条全局硬禁令写死在 shared/bans.ts，不在这里）。 */
  listBans(): Promise<Ban[]>;
  /** 按（池, 原名 label）排。上游这次没报的窗口也在（带 staleSince），满 24 小时库里才删。 */
  listQuotaWindows(): Promise<QuotaWindowRecord[]>;
  /** since 之后（含）的额度窗历史，按（池, 原名, 读数时刻）排。读不到抛错，不给空的顶。 */
  listQuotaSamples(since: Date): Promise<QuotaSampleRecord[]>;
  setChannelEnabled(
    input: { channelId: string; enabled: boolean },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'not_found'>;
}

export interface OpsStore {
  /** 登记过的定时任务全列出来（一次都没跑过的也列）。 */
  listJobs(): Promise<JobRecord[]>;
  /** 按 (建立时刻, id) 倒序。 */
  listNotifications(query: { status: 'open' | 'all' } & PageRequest): Promise<Page<NotificationRecord>>;
  /** 各级别的真实条数（不受分页上限影响）；status 口径同 listNotifications。 */
  countNotifications(query: { status: 'open' | 'all' }): Promise<Record<NotificationRecord['level'], number>>;
  /** 只读 DB 候选事实；不是预检授权。必须另经服务端原 execution reader 验证 run/head 来源；不会写任何东西。 */
  readHistoricalCheckoutCandidate(input: {
    notificationId: string;
    dedupeKey: string;
    repo: string;
    taskId: string;
    issueNumber: number;
    workflowId: string;
    runId: string;
    temporalRunId: string;
    pr: number;
    head: string;
  }): Promise<HistoricalCheckoutFacts>;
  /**
   * checkout 专用历史归档：事务内重读所有身份和 CAS 快照，只撤旧通知并记审计。
   * 不写 cold_verify.checkout_full，不改任务、run、PR、验收责任或 Temporal 历史。
   */
  archiveHistoricalCheckout(
    input: HistoricalCheckoutArchiveInput,
    audit: NewAuditEntry,
    source?: CheckoutSource,
  ): Promise<'ok' | 'already_archived' | 'not_found' | 'conflict'>;
  /** 只读现查任务账、全部 run 和已有的受管纠正；不写任何东西。任务不存在或编号看不懂回 null。 */
  readMergedCorrection(input: {
    repoId: string;
    taskId: string;
    issueNumber: number;
  }): Promise<MergedCorrectionFacts | null>;
  /**
   * 已结束且误记 abandoned 的真实已合任务：事务内锁任务、重读 run，CAS（stopped + phase=abandoned + 预检快照 + run 集合不变 + 无活 run +
   * 非本机领单）后把任务改成 done，并和操作记录同一事务。不改旧 run、不动验收责任、不关单。
   * 同一请求（pr/head/mergeCommit/run/evidenceKey 全同）重复回 already_corrected；任一不同回 conflict。
   */
  correctMergedAbandoned(input: MergedCorrectionInput, audit: NewAuditEntry): Promise<MergedCorrectionResult>;
  resolveNotification(
    input: {
      id: string;
      by: Actor;
      expected?: import('./notification-resolution.ts').NotificationResolutionGuard;
    },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'already_resolved' | 'not_found' | 'conflict'>;
  /**
   * 回答一条还开着的「要你拍」（#1915）：点选项给 optionId，自己输入给 text（二选一，路由已核过）。只记答案和操作记录，
   * 不转已处理——独立 claim 后执行，再由 settleDecision 按答案编号和 claim CAS 结算。未接活可替换；executing/queued/unknown 拒绝不同答案；同请求复用，确定失败可重试。
   * 选项编号不在这条的选项里回 unknown_option，什么都不改。
   */
  answerNotification(
    input: {
      id: string;
      by: Actor;
      optionId?: string | undefined;
      text?: string | undefined;
      requestId?: string | undefined;
      expectedAnswerId?: string | null | undefined;
    },
    audit: NewAuditEntry,
  ): Promise<AnswerNotificationResult>;
  /** 执行前独立原子接活；在途/未知不能接管，确定失败可沿同答案重新接活。历史答案无代次拒绝。 */
  claimDecision(input: {
    id: string;
    answerId: string;
  }): Promise<
    | { kind: 'claimed'; answer: DecisionAnswer; claimId: string }
    | { kind: 'replay'; answer: DecisionAnswer }
    | { kind: 'stale' }
    | { kind: 'in_flight' }
  >;
  /**
   * 把执行结果写进还开着的通知的答案里（answer.execution）。resolve 为真才标已处理（执行成功、并且这一项不是 keepsOpen）。
   * 已经处理过的、还没有答案的不改（already_resolved），不存在回 not_found，身份/执行状态对不上回 stale。失败、queued、unknown 不能 resolve。不另记操作记录（回答那条已经记过）。
   */
  settleDecision(input: {
    id: string;
    answerId: string;
    claimId: string;
    execution: DecisionExecution;
    resolve: boolean;
    by: Actor;
  }): Promise<'ok' | 'already_resolved' | 'not_found' | 'stale'>;
  appendAudit(entry: NewAuditEntry): Promise<string>;
  /** 按 (at, id) 倒序。 */
  listAudit(query: { target?: string | undefined } & PageRequest): Promise<Page<AuditRecord>>;
  listSettings(): Promise<SettingRecord[]>;
  /** expectedVersion 对不上就不改、返回 conflict（0 = 预期还没设过）。和操作记录同一事务。 */
  putSetting(
    input: {
      key: string;
      value: unknown;
      expectedVersion: number;
      by: Actor;
      /** 修复结果结算同时锁住原通知代次，禁止旧核验写进已重开的事故。 */
      expectedNotification?: { id: string; raisedAt: string; requireOpen?: boolean };
    },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'conflict'>;
}

export interface AgentStore {
  /** 空格分开的每个词都要在标题、原话、需求目录、摘要、结果摘要或改动位置里出现；只找有需求文档索引的需求。 */
  searchHistory(input: { repoId: string; query: string; limit: number }): Promise<HistoryItem[]>;
  getPullRequest(repoId: string, number: number): Promise<PullRequestRecord | null>;
  /**
   * fleet 命令的幂等键（同一会话内）：占键。键被占着没做完、而且是 takeOverBefore 之前占的（那一次多半已经死了）：
   * 原子地接过来——两个请求同时来接，只有一个接得到，另一个看到 in-flight。键用在别的命令上：other-action，不回旧结果。
   */
  claimCommand(input: {
    runId: string;
    key: string;
    action: string;
    takeOverBefore: string;
  }): Promise<CommandClaim>;
  /** 执行成功：记下结果，以后同一个键直接回它。只认自己的凭据：占用已被接管或放掉了就不记，返回 false。 */
  completeCommand(input: { runId: string; key: string; token: string }, result: unknown): Promise<boolean>;
  /** 没执行成功：放掉自己的占用，重试会重新执行。凭据对不上（已被别的请求接管）或已完成的，都不动。 */
  releaseCommand(input: { runId: string; key: string; token: string }): Promise<void>;
}

export type GitHubDeliverySource = 'webhook' | 'poll' | 'redelivery';

/**
 * processing = 正在处理（进程死在半路也停在这）；accepted = 放进来、处理完；ignored = 按规矩不收（reason 写为什么）；
 * failed = 处理出错（reason 写错在哪），等重投、补收或重放再来；waiting = 现在做不了、要等前一件事做完（reason 写等什么，
 * 比如重开时上一轮还没结束），每轮对账都重放，不占自动重放的次数。
 */
export type GitHubDeliveryStatus = 'processing' | 'accepted' | 'ignored' | 'failed' | 'waiting';

/** 门口因为「仓不受管」挡掉的投递的原因。这种投递带着的对象版本不算见过：仓后来纳管了，补收还得照常做、照常算。 */
export const REPO_NOT_MANAGED = 'repo_not_managed';

/** 一次投递带着的一个对象（issue、评论、PR）的那一版。 */
export interface GitHubObjectVersion {
  /** `<owner/name 小写>:<issue|comment|pull>:<编号>`（写法见 github.ts 的 objectKey）。 */
  object: string;
  /** 这个对象在 GitHub 上的 updated_at（ISO 时刻）。 */
  version: string;
  /** issue、PR 这一版开着还是关着；评论没有。 */
  state?: 'open' | 'closed' | undefined;
}

/** 一次投递（webhook 收到的，或补收时拼出来的），原文照收。 */
export interface NewGitHubDelivery {
  id: string;
  event: string;
  action?: string | undefined;
  source: GitHubDeliverySource;
  /** owner/name，原样取自事件；没有仓的事件不填。 */
  repo?: string | undefined;
  /** 带着的对象版本，主对象在第一个（评论事件：评论、再是它顶新的 issue）。认不出版本的不写。 */
  versions: GitHubObjectVersion[];
  payload: unknown;
}

/** 库里的一条投递。versions 读回来是按对象排的（不再保证主对象在第一个）。 */
export interface GitHubDelivery extends NewGitHubDelivery {
  status: GitHubDeliveryStatus;
  reason?: string | undefined;
  note?: string | undefined;
  attempts: number;
  receivedAt: string;
  claimedAt: string;
  finishedAt?: string | undefined;
}

/**
 * 占到了（retry = 上次没处理成、这次重来）就去处理，记结局要拿 token；duplicate = 处理过了、正在处理，或同一版收过了。
 * seenBefore（只在带 skipIfSeen 时）：这一版别的投递带过、只是被门挡掉了（比如陌生人评论顺带的 issue 那一版）——照样处理，
 * 但不算补回。
 */
export type GitHubDeliveryClaim =
  | { status: 'claimed'; token: string; retry: boolean; seenBefore?: boolean | undefined }
  | { status: 'duplicate' };

export type GitHubDeliveryOutcome =
  | { status: 'accepted'; note?: string | undefined }
  | { status: 'ignored' | 'failed' | 'waiting'; reason: string };

export interface GitHubStore {
  /**
   * 收下一条投递：原文和它带着的对象版本落库，按投递编号去重，存 Postgres 不放本机文件。同一编号再来：上次出错、在等着，
   * 或处理中而且占用早于 staleBefore（那一次多半死了）就重新占住（retry；从等着接回来的不加次数）；处理完了、正在处理
   * 就是 duplicate。
   * skipIfSeen（轮询补收用）：别的投递已经带过这个对象的这一版、而且没被门挡掉（webhook 收过同一版），也是 duplicate、
   * 不落库。门挡掉的那一版不跳过：改了名单、新加了仓之后补收还能再过一次门；陌生人评论顺带的 issue 那一版也照样处理
   * （关单的 webhook 丢了还靠它叫停），只是除了「仓不受管」挡掉的，都回 seenBefore——不算补回。
   * 带过没有的查和这一条的插在同一个事务里、按（对象，版）加锁：同一版的几条补收同时来、编号各不相同，也只有一条占到。
   */
  claimDelivery(
    delivery: NewGitHubDelivery,
    options: {
      staleBefore: string;
      skipIfSeen?: Pick<GitHubObjectVersion, 'object' | 'version'> | undefined;
    },
  ): Promise<GitHubDeliveryClaim>;
  /** 重放库里的一条：接管的规矩同 claimDelivery；force = 处理完的也重新占住（修了代码、改了名单之后重跑）。 */
  reclaimDelivery(
    id: string,
    options: { staleBefore: string; force: boolean },
  ): Promise<
    | { status: 'claimed'; token: string; delivery: GitHubDelivery }
    | { status: 'not_found' | 'in_flight' | 'finished' }
  >;
  /** 记结局。只认这次占用的凭据：已经被别的请求接管了就不改，返回 false。 */
  finishDelivery(id: string, token: string, outcome: GitHubDeliveryOutcome): Promise<boolean>;
  getDelivery(id: string): Promise<GitHubDelivery | null>;
  /** 没处理成的（出错的、等着的，和处理中但占用早于 staleBefore 的），次数少的在前、再按收到先后，最多 limit 条。 */
  listUnfinishedDeliveries(query: { staleBefore: string; limit: number }): Promise<GitHubDelivery[]>;
  /** 这几个投递编号里，库里已经有原文的（不管处理成没成）。 */
  existingDeliveryIds(ids: readonly string[]): Promise<Set<string>>;
  /**
   * 同一个对象有没有更新的一版已经处理过（放进来、处理完）、而且开关状态和 state 不一样；有就回那一版。
   * 不算 excludeDeliveryId 这一条自己。
   */
  findSupersedingVersion(query: {
    object: string;
    version: string;
    state: 'open' | 'closed';
    excludeDeliveryId: string;
  }): Promise<{ deliveryId: string; version: string; state: 'open' | 'closed' } | null>;
  /**
   * 卡住的投递有几条：exhausted = 出错、次数到了 maxAttempts（不再自动重放）；stale = 处理中、占用早于 staleBefore。
   * 等着的不算（它每轮都重放，等的那件事做完就会过去）。
   */
  countStuckDeliveries(query: {
    staleBefore: string;
    maxAttempts: number;
  }): Promise<{ exhausted: number; stale: number }>;
}

/** 受管的仓，带「让 AI 接活」开关：autoDispatchSince = 打开的时刻，null = 关着（引擎拉单不派）。 */
export interface IntakeRepo extends Repo {
  autoDispatchSince: string | null;
  /** 合并方式。库的默认是强制；读不出来的坏值由实现抛错，不当成不强制。 */
  ciPolicy: CiPolicy;
}

/** 改 CI 模式的结果（setCiPolicy）。 */
export interface CiPolicyChange {
  /** false = 本来就是这个模式：什么都没改，也没记操作记录。 */
  changed: boolean;
  ciPolicy: CiPolicy;
  /** 改了才有：同一事务里记下的那条操作记录的编号。 */
  auditId?: string | undefined;
}

/** 改「让 AI 接活」开关的结果（setAutoDispatch）。 */
export interface AutoDispatchChange {
  /** false = 本来就是要的状态：什么都没改，也没记操作记录。 */
  changed: boolean;
  /** 现在库里的值：打开的时刻，null = 关着。 */
  autoDispatchSince: string | null;
  /** 改了才有：同一事务里记下的那条操作记录的编号。 */
  auditId?: string | undefined;
}

/** 从 issue 建的任务行。id 由调用方生成（操作记录的 target 要用）；这张 issue 已经有任务就不建、回已有的那行。 */
export interface NewIssueTask {
  id: string;
  repoId: string;
  issueNumber: number;
  title: string;
  rawRequest: string;
  /** 成员编号（users.id），和驾驶舱开的需求同一种写法。 */
  requestedBy: string;
}

/** 接活要用的：按名字找仓、按 issue 找任务、建任务行、跟着 issue 改原话。写操作和操作记录同一事务。 */
export interface IntakeStore {
  /** owner/name 不分大小写。 */
  findRepoByName(owner: string, name: string): Promise<IntakeRepo | null>;
  findTaskByIssue(repoId: string, issueNumber: number): Promise<Task | null>;
  /**
   * 按一批（仓, issue 号）一次查回对得上的任务（主页「做完的」反查 merged PR 挂的单用，免得一张一张查库）。
   * 对不上的不回、不报错，调用方自己数缺了哪几张；看不懂的仓编号当作对不上。回的顺序不保证。
   */
  findTasksByIssues(refs: readonly { repoId: string; issueNumber: number }[]): Promise<Task[]>;
  /** 按（仓, issue 号）唯一：并发来两次也只建一行，第二次回 created=false 和已有的那行，不写操作记录。新行排在这个仓最后。 */
  createTaskFromIssue(input: NewIssueTask, audit: NewAuditEntry): Promise<{ task: Task; created: boolean }>;
  /** 标题和原话都没变是 unchanged（不写操作记录）。 */
  updateTaskRequest(
    input: { taskId: string; title: string; rawRequest: string },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'unchanged' | 'not_found'>;
  /** 还在排队（从没派出去）的任务直接记成叫停；已经不在排队了就不动，返回 not_queued。 */
  stopQueuedTask(taskId: string, audit: NewAuditEntry): Promise<'ok' | 'not_queued'>;
  /**
   * 接手一条没有任务工作流的老任务行。只认还在排队或已叫停的：标题和原话改成当前这一代，已叫停的改回排队。
   * 不新建行，不动创建时刻、优先级、提出人、文档、验收、阶段这些历史列。别的状态回 not_orphan，一行不改、不记。
   * 和操作记录同一事务。编号看不懂或没有这条：not_found。
   * 拉单不走这里：要先改行、等工作流起成再记，见 prepareOrphanTask。
   */
  adoptOrphanTask(
    input: { taskId: string; title: string; rawRequest: string },
    audit: NewAuditEntry,
  ): Promise<'adopted' | 'not_orphan' | 'not_found'>;
  /**
   * 起工作流之前先改老行：标题和原话换成当前这一代，已叫停的改回排队。不写操作记录。
   * 工作流起成之后才记接手成功；没起成用 restoreOrphanTask 放回去。这样工作流第一步把状态写成 running 时，标题已经是这一代的。
   * 不是排队或已叫停：not_orphan，一行不改。没有这条、编号看不懂：not_found。
   * 不动创建时刻、优先级、提出人、文档、验收、阶段这些历史列。
   */
  prepareOrphanTask(input: {
    taskId: string;
    title: string;
    rawRequest: string;
  }): Promise<
    | { status: 'prepared'; before: { title: string; rawRequest: string; state: 'queued' | 'stopped' } }
    | { status: 'not_orphan' }
    | { status: 'not_found' }
  >;
  /**
   * 工作流没起成：把 prepareOrphanTask 改过的标题、原话、状态放回去。不写操作记录。
   * 只在还是排队时放。已经不是排队：not_queued，一行不改。没有这条、编号看不懂：not_found。
   */
  restoreOrphanTask(input: {
    taskId: string;
    title: string;
    rawRequest: string;
    state: 'queued' | 'stopped';
  }): Promise<'restored' | 'not_queued' | 'not_found'>;
  /**
   * 「让 AI 接活」开关（repos.auto_dispatch_since，design 第九节「在哪能做与接活开关」）的写入口，
   * 服务器上的 fleet-api dispatch 和以后驾驶舱的开关（#131）都走这里。on 打开、记下此刻（只有这之后开的 issue
   * 自动派，还要挂在当前版本上，见 @fleet-dao/core 的 dispatch.ts）；off 关上、设为空。已经是要的状态就不改、不记（changed=false）：
   * 开着时再开不重设时刻——重设会把已经能派的单变成「开关打开以前开的」。改了就和操作记录同一事务：先锁住这一行，
   * 操作记录的 before/after（开关原来、现在的值）由这里按库里的值填。没这个仓（含编号不是 uuid）：not_found。
   */
  setAutoDispatch(
    input: { repoId: string; on: boolean },
    audit: Omit<NewAuditEntry, 'before' | 'after'>,
  ): Promise<AutoDispatchChange | 'not_found'>;
  /**
   * 受管仓的 CI 模式（repos.ci_policy）。force 强制、off 不强制。已经是要的模式就不改、不记（changed=false）。
   * 改了和操作记录同一事务：先锁住这一行，before/after 由这里按库里的值填。没这个仓（含编号不是 uuid）：not_found。
   */
  setCiPolicy(
    input: { repoId: string; mode: CiPolicy },
    audit: Omit<NewAuditEntry, 'before' | 'after'>,
  ): Promise<CiPolicyChange | 'not_found'>;
  /**
   * 把一个仓接进驾驶舱（#1989）：驾驶舱「导入仓库」点一下就走这里。owner/name 不分大小写地唯一：
   * 已经在库里的（不管大小写怎么写）原样返回那一行、不新建、不记操作记录（created=false）。
   * 新行的「让 AI 接活」默认关着（和 #131 一致），ci_policy 走库默认（强制）。新建和操作记录同一事务。
   */
  addRepo(
    input: { owner: string; name: string; defaultBranch: string; testCommand: string },
    audit: Omit<NewAuditEntry, 'before' | 'after'>,
  ): Promise<{ repo: IntakeRepo; created: boolean; auditId?: string | undefined }>;
  /**
   * 把一个仓移出驾驶舱（#1989）：删 repos 那一行。这个仓上还有没结束的需求（queued/running）时不删、返回 has_tasks——
   * 库里 tasks 对 repos 是外键，硬删会连坐；把「还挂着活」这件事交回页面说清楚，不悄悄删掉别人在干的单。
   * 没有这个仓返回 not_found。
   */
  removeRepo(
    input: { repoId: string },
    audit: Omit<NewAuditEntry, 'before' | 'after'>,
  ): Promise<'removed' | 'has_tasks' | 'not_found'>;
}

/** 别的环境推来的快照（node_reports 表一行），不带快照本体：列环境用。 */
export interface NodeReportSummary {
  /** 收的一方按对上的通行证认定，不取载荷自报的名字。 */
  nodeId: string;
  /** 载荷里的环境名（env.name.name），只用来显示。 */
  displayName: string;
  schemaVersion: number;
  codeSha?: string | undefined;
  /** 推送方的时钟。 */
  reportedAt: string;
  /** 收到的时刻（这个 Store 的钟）：新不新鲜按它算（shared 的 nodeFreshness）。 */
  receivedAt: string;
}

export interface NodeReportRecord extends NodeReportSummary {
  snapshot: NodeSnapshot;
}

/** 看板多机（全仓审查第 1 路 4.1）：一个环境一行，覆盖写。memory-store.ts 是参照实现。 */
export interface NodeStore {
  /**
   * 覆盖写：这个环境已有的那一行整行换掉，receivedAt 记成此刻（Store 的钟），回写进去的那一行。
   * nodeId、report 先照 shared 的 NodeIdSchema / NodeReportSchema 校验（多余字段剥掉再存），认不出（坏载荷、
   * 未知版本）抛 InvalidNodeReportError、什么都不写。
   */
  putNodeReport(input: { nodeId: string; report: NodeReport }): Promise<NodeReportSummary>;
  /** 收到过快照的环境，按 nodeId 排。 */
  listNodeReports(): Promise<NodeReportSummary[]>;
  /** 没收到过是 null。库里那份认不出（版本对不上、形状坏了）抛 InvalidNodeReportError，不当成没有。 */
  getNodeReport(nodeId: string): Promise<NodeReportRecord | null>;
  /**
   * 本机会话（#1991）：覆盖写这个环境那一行，receivedAt 记成此刻（Store 的钟）。先照 shared 的 LocalSessionsReportSchema 校验，
   * 认不出抛 InvalidNodeReportError、什么都不写。
   */
  putNodeSessions(input: { nodeId: string; report: LocalSessionsReport }): Promise<{ receivedAt: string }>;
  /** 收到过本机会话的环境，按 nodeId 排。库里那份认不出抛 InvalidNodeReportError，不当成没有。 */
  listNodeSessions(): Promise<NodeSessionsRecord[]>;
  /** 法国工作树最近一份清单（#1993，引擎写）；一次都没存过是 null。认不出抛错，不当成没有树。 */
  getWorktreeInventory(): Promise<WorktreeInventory | null>;
  /** 机器通行证（#3388，node_keys 表）：所有行（含已作废的），按 nodeId 排。读不到照抛，认人的一方据此回 503，不当成没有。 */
  listNodeKeys(): Promise<NodeKeyRecord[]>;
  /**
   * 发一把：写 node_keys 一行并在同一事务记 audit。该编号已有有效的返回 'exists'、什么都不写；
   * 该编号只有作废的行就整行换成新的（createdAt 换新、revokedAt 清空）。tokenHash 必须是 64 位小写十六进制，否则抛错。
   */
  createNodeKey(
    input: { nodeId: string; tokenHash: string; displayName: string },
    audit: NewAuditEntry,
  ): Promise<'created' | 'exists'>;
  /** 作废：写 revokedAt（Store 的钟）并在同一事务记 audit；没有这个编号 'not_found'，已经作废 'already_revoked'（都不写）。 */
  revokeNodeKey(nodeId: string, audit: NewAuditEntry): Promise<'revoked' | 'not_found' | 'already_revoked'>;
}

/** 机器通行证一行（node_keys）。tokenHash 是明文的 sha256，明文不入库。 */
export interface NodeKeyRecord {
  nodeId: string;
  tokenHash: string;
  displayName: string;
  createdAt: string;
  /** 作废的时刻；有效的没有这一项。 */
  revokedAt?: string | undefined;
}

export interface NodeSessionsRecord {
  nodeId: string;
  receivedAt: string;
  report: LocalSessionsReport;
}

export type Store = import('./task-execution.ts').TaskExecutionStore &
  UserStore &
  BoardStore &
  RoutingStore &
  OpsStore &
  AgentStore &
  GitHubStore &
  IntakeStore &
  NodeStore;

/** 翻页游标看不懂：接口回 400（http.ts），不装成空页。判法在 ids.ts 的 parseCursor。 */
export class InvalidCursorError extends Error {
  constructor(message = '翻页游标看不懂（被改过，或者不是这个列表的），从第一页重新翻') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

/** 别的环境推来的快照认不出（写进来的、或库里读回来的）。接收方据此回 400，读的一方据此报「没查成」。 */
export class InvalidNodeReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNodeReportError';
  }
}

// —— GitHub 事件 ——

/** 通过签名与白名单之后的事件。wake=false 表示只同步镜像、不叫醒工作流（自家机器人的回声）。 */
export interface IngestedEvent {
  deliveryId: string;
  source: GitHubDeliverySource;
  event: string;
  action?: string | undefined;
  repo: string;
  wake: boolean;
  receivedAt: string;
  payload: unknown;
}

/**
 * 放进来的每条事件都先交给它：写 PR 镜像、CI 汇总（生产是 @fleet-dao/github 的 eventSink）。
 * issue 不在这里变成任务：引擎拉单（@fleet-dao/engine 的 jobs/intake.ts）自己去 GitHub 读。放进来的 issues.closed 这里不做事，
 * 投递账（github_events）上那一行由引擎每几秒捞一次，撤这张单停着等人的任务（jobs/closed-issue-events.ts）。
 * 抛错 = 没处理成，这条投递记成出错。
 */
export interface GitHubEventSink {
  accept(event: IngestedEvent): Promise<void>;
}

// —— 日志 ——

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
