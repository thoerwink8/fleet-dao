// 后端和引擎共用的外部能力，一律按接口写：数据库（pg-store.ts 用 @fleet-dao/db 实现）、GitHub 补收
// 由各自的实现接进来；测试和本地开发用 memory-store.ts。两个 Store 实现过同一套契约测试（test/store-contract.ts），
// 改这里的语义要两边一起改、契约测试跟着改。只给后端用的接口（Temporal 信号、飞书登录、健康检查……）在 api/src/ports.ts。
import type { AskHold, AskScope } from '@fleet-dao/core';
import type {
  AuditEntrySchema,
  Ban,
  Channel,
  HistoryResponse,
  Model,
  Pool,
  ProgressKind,
  QuotaWindow,
  Repo,
  Route,
  ScheduleOutcome,
  SegmentMatch,
  SegmentRun,
  SessionRun,
  StageKind,
  Step,
  Subtask,
  Task,
  TaskState,
} from '@fleet-dao/shared';
import type { z } from 'zod';

/** 一张单的三段流水（库里的 runs 表）一笔，加上它是怎么和这张单对上的。 */
export type SegmentRunRecord = SegmentRun & { matchedBy: SegmentMatch };

/** 库里的一行额度窗：原名、单位、读法入库必填（领域类型里可选，是给还没入库的读数用的）；staleSince 由库的写入口管。 */
export type QuotaWindowRecord = QuotaWindow & Required<Pick<QuotaWindow, 'label' | 'unit' | 'source'>>;

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

/** 谁做的。user = 驾驶舱用户；ai = AI 帅位；engine = 引擎；agent = 会话里的 AI。 */
export interface Actor {
  kind: 'user' | 'ai' | 'engine' | 'agent';
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

export interface AskRecord {
  id: string;
  taskId: string;
  runId?: string | undefined;
  question: string;
  /** 带了推荐的，推荐的排第一个。 */
  options: string[];
  askedAt: string;
  answer?: string | undefined;
  answeredBy?: string | undefined;
  answeredAt?: string | undefined;
  /**
   * 问他不挡路（#259，core 的 ask.ts）：task = 这张单范围内的岔路，按推荐先做；outside = 超出范围，另开单等他拍；
   * hold = 碰了人闸，先按推荐做、合并前等批。没有 = 引擎自己等人的（只有他本人才有的东西），或这之前的老提问。
   */
  scope?: AskScope | undefined;
  recommended?: string | undefined;
  hold?: AskHold | undefined;
  /** 另开的单（超出范围的那张，或改选了别的、原单已经合了开的后续单）。 */
  followUpIssue?: number | undefined;
  /** 他改选了别的，引擎交给主导照改的时刻。 */
  appliedAt?: string | undefined;
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
  resolvedAt?: string | undefined;
  resolvedBy?: string | undefined;
  deliveries: DeliveryRecord[];
  /**
   * 去重键（「同一件事一条」的认法）：approvals 的是 approval:<编号>，主页据此把通知标成「待批」。
   * 老数据（镜像里没存过的）没有。
   */
  dedupeKey?: string | undefined;
}

export interface SettingRecord {
  key: string;
  value: unknown;
  /** 每改一次加 1，第一次写入是 1；从没设过的键不在结果里。 */
  version: number;
  updatedAt?: string | undefined;
  updatedBy?: string | undefined;
}

/**
 * 一次会话在 fleet 命令眼里的样子（由会话、需求、仓拼出来）。令牌只对它有效；endedAt 有值后令牌作废。
 * 不属于任何需求的会话（帅位、考新模型）没有这个样子，拿不到 fleet 令牌。
 */
export interface AgentSession {
  runId: string;
  taskId: string;
  subtaskId?: string | undefined;
  stage: StageKind;
  repoId: string;
  /**
   * 起会话时交代给它的测试命令（session_runs.test_command，当时的流程配置副本里的）：交活核对只认会话里跑过它，
   * 退回时写明要跑哪一条。没有 = 开工时项目没写（只有不写码的阶段起得来），或加这一列之前开的会话。
   */
  testCommand?: string | undefined;
  /** 引擎给这次会话建了分支才有。 */
  branch?: string | undefined;
  /** 做完标准（需求上的 acceptance）。 */
  acceptance: string[];
  endedAt?: string | undefined;
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
}

/**
 * 会话里跑过的一次测试：从 kind=test 的进度里读出来的。passed 为 null 是结果认不出（接了管道、放了后台……，
 * 插头写明了原因），照样列出来：交活核对以最后一次为准，认不出的那一次不能被它前面一次「通过」顶掉。
 */
export interface TestRunRecord {
  at: string;
  passed: boolean | null;
  command?: string | undefined;
  /** passed 为 null 时：为什么认不出。 */
  unknownBecause?: string | undefined;
}

export type HistoryItem = z.infer<typeof HistoryResponse>['items'][number];

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
  listSubtasks(taskIds: readonly string[]): Promise<Subtask[]>;
  /** taskIds 给了就只要这些需求的会话（不属于任何需求的会话不在其中）；active=true 只要没结束的。 */
  listRuns(filter: {
    taskIds?: readonly string[] | undefined;
    active?: boolean | undefined;
  }): Promise<SessionRun[]>;
  getRun(id: string): Promise<SessionRun | null>;
  /**
   * 一张单的三段流水（runs 表），按起跑先后：task_id 是这张单的（matchedBy = task），加上 task_id 没记、单号对得上的老行
   * （matchedBy = issueNumber，兜底；记了工作流编号却不是这张单的 taskWorkflowId 的不收——那是别的仓同号的单）。
   * 没这张单（含编号不是 uuid）回空。memory-store.ts 是参照实现。
   */
  listSegmentRuns(taskId: string): Promise<SegmentRunRecord[]>;
  /**
   * 一批单的三段流水，一次读完（主页流水线图用，一张张读要几十个往返）。只认 task_id 对得上的行（matchedBy 一律 task）：
   * task_id 没记的老行不按单号兜底（兜底要逐张单查仓，主页这条路不值得；老单在图上落进「还没分段」）。
   * 按起跑先后排；不是 uuid 的编号忽略；一张单都没给回空。memory-store.ts 是参照实现。
   */
  listSegmentRunsForTasks(taskIds: readonly string[]): Promise<SegmentRunRecord[]>;
  /** 每个会话最近一次 fleet plan 的步骤清单；没报过的会话不在结果里。 */
  getPlans(runIds: readonly string[]): Promise<Map<string, RunPlan>>;
  lastSay(runId: string): Promise<{ text: string; at: string } | null>;
  listAsks(taskId: string): Promise<AskRecord[]>;
  getAsk(id: string): Promise<AskRecord | null>;
  /** 写回答，和操作记录同一事务。已经答过就不改。 */
  answerAsk(
    input: { askId: string; answer: string; by: Actor },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'already_answered' | 'not_found'>;
  /** 全部还没答的追问（新主页「要你拍的」用），按提问先后排。 */
  listPendingAsks(): Promise<AskRecord[]>;
  /**
   * PR 镜像（新主页「做完的」、将来「在跑的」判合并段用）：state 给了只要那个状态；merged 按 mergedAt 倒序、
   * 其余按 updatedAt 倒序，最多 limit 条（默认 50）。镜像里没有的就给不出——不直接查 GitHub。
   */
  listPullRequests(input?: {
    state?: PullRequestRecord['state'] | undefined;
    limit?: number | undefined;
  }): Promise<PullRequestRecord[]>;
}

export interface RoutingStore {
  listChannels(): Promise<Channel[]>;
  listPools(): Promise<Pool[]>;
  listModels(): Promise<Model[]>;
  listRoutes(): Promise<Route[]>;
  /** 库里另配的禁令（两条全局硬禁令写死在 shared/bans.ts，不在这里）。 */
  listBans(): Promise<Ban[]>;
  /** 按（池, 原名 label）排。上游这次没报的窗口也在（带 staleSince），满 24 小时库里才删。 */
  listQuotaWindows(): Promise<QuotaWindowRecord[]>;
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
  resolveNotification(
    input: { id: string; by: Actor },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'already_resolved' | 'not_found'>;
  appendAudit(entry: NewAuditEntry): Promise<string>;
  /** 按 (at, id) 倒序。 */
  listAudit(query: { target?: string | undefined } & PageRequest): Promise<Page<AuditRecord>>;
  listSettings(): Promise<SettingRecord[]>;
  /** expectedVersion 对不上就不改、返回 conflict（0 = 预期还没设过）。和操作记录同一事务。 */
  putSetting(
    input: { key: string; value: unknown; expectedVersion: number; by: Actor },
    audit: NewAuditEntry,
  ): Promise<'ok' | 'conflict'>;
}

export interface AgentStore {
  getAgentSession(runId: string): Promise<AgentSession | null>;
  /** fleet plan：记一条 kind=plan 的进度，载荷 { steps: [{ title, state }] }（和命令的请求体同形）；最近一条就是现行清单。 */
  savePlan(runId: string, steps: Step[]): Promise<void>;
  /** 会话主动报的进度（say / ask / done / blocked）或插头读出来的（test / file / tool），进 progress_events。 */
  appendProgress(runId: string, kind: ProgressKind, payload: unknown): Promise<void>;
  /**
   * 开一条追问。同一会话问过一模一样的一句就复用那一条（created=false），命令重试不会刷屏。
   * 新开的在同一事务里记一条 kind=ask 的进度（载荷 { askId, question }）：不会有「追问开了、进度没记」，重试也补不回来的半截。
   */
  openAsk(input: {
    runId: string;
    taskId: string;
    question: string;
    /** 推荐的排第一个（core 的 checkAsk 排好了）。 */
    options: string[];
    scope: AskScope;
    recommended: string;
    hold?: AskHold | undefined;
  }): Promise<{ ask: AskRecord; created: boolean }>;
  /** 空格分开的每个词都要在标题、原话、需求目录、摘要、结果摘要或改动位置里出现；只找有需求文档索引的需求。 */
  searchHistory(input: { repoId: string; query: string; limit: number }): Promise<HistoryItem[]>;
  getPullRequest(repoId: string, number: number): Promise<PullRequestRecord | null>;
  /** 按时间正序。 */
  listTestRuns(runId: string): Promise<TestRunRecord[]>;
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
}

export type Store = UserStore & BoardStore & RoutingStore & OpsStore & AgentStore & GitHubStore & IntakeStore;

/** 翻页游标看不懂：接口回 400（http.ts），不装成空页。判法在 ids.ts 的 parseCursor。 */
export class InvalidCursorError extends Error {
  constructor(message = '翻页游标看不懂（被改过，或者不是这个列表的），从第一页重新翻') {
    super(message);
    this.name = 'InvalidCursorError';
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
 * issue 不在这里变成任务：引擎拉单（@fleet-dao/engine 的 jobs/intake.ts）自己去 GitHub 读。抛错 = 没处理成，这条投递记成出错。
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
