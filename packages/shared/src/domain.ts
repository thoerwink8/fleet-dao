// 领域对象：引擎、数据库、驾驶舱、fleet 命令、飞书网关共用的一份定义。
// 改这里之前：数据库表结构（packages/db）以本文件为准；字段增删要同时改表和迁移。

/** 流程里的一种活。驾驶舱「调度台」按阶段类型挂路由。 */
export type StageKind =
  | 'triage' // 分诊
  | 'spec' // 写需求文档
  | 'plan' // 写方案、拆子任务
  | 'execute' // 写码
  | 'ui' // UI 类写码（GPT 族禁入）
  | 'review' // 第二意见
  | 'research' // 调研
  | 'judge'; // Jev 判断题

export type TaskState =
  | 'queued'
  | 'triaging'
  | 'asking' // 在任务里追问创始人，等回答
  | 'planning'
  | 'running'
  | 'merging'
  | 'done'
  | 'stopped' // 人叫停
  | 'failed'
  | 'stalled'; // 按进展判定停滞，交帅位诊断

export type SubtaskState =
  | 'pending'
  | 'waiting_deps' // 等依赖的子任务
  | 'waiting_slot' // 等并发空位或额度（驾驶舱要写明在等哪个）
  | 'running'
  | 'verifying'
  | 'in_merge_queue'
  | 'merged'
  | 'stopped'
  | 'failed'
  | 'stalled';

export type StepState = 'pending' | 'in_progress' | 'done';

/** 套餐内 = 不算花钱；按量 = 要先有创始人定的月度上限。 */
export type BillingKind = 'subscription' | 'metered';

/** 驾驶舱上每个额度数字都要标明来源。 */
export type ReadingKind = 'measured' | 'estimated';

/** 窗口归类（只增不改）。other = 上游新出的、还归不了类的窗口，照样收下，原名看 QuotaWindow.label。 */
export type QuotaWindowKind = '5h' | '7d' | '7d_model' | 'month_usd' | 'points' | 'period_usd' | 'other';

/** 额度数字（used / limit）的单位（只增不改）。上游只给百分比时记 percent，上限记 100。 */
export type QuotaUnit = 'percent' | 'usd' | 'tokens' | 'points';

/** 模型组窗口具体扣哪些模型：in = 只扣这些，notIn = 除了这些都扣。模型 id 按 windowAppliesTo 的规矩比较。 */
export type ScopeMembership = { in: string[] } | { notIn: string[] };

/** 上游自己说的额度状态。以它为准：实测 99% 就可能已经 limit_reached。 */
export type QuotaStatus = 'allowed' | 'warning' | 'limit_reached';

export type HostId = 'claude-code' | 'codex' | 'cursor-agent' | 'grok' | 'mirasim' | 'api-shell';

/**
 * 定时任务一次跑的结局（只增不改；还在跑时没有结局）。四种分开，「没跑成」「没扫到」不能当「没问题」：
 * ok = 跑完了、扫了对象（发现几个问题另记）；partial = 跑完了但有一部分没查成；
 * unscanned = 跑完了但一个对象都没扫到；failed = 没跑成。
 */
export type ScheduleOutcome = 'ok' | 'partial' | 'unscanned' | 'failed';

export interface Repo {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  /** 在工作树里跑测试的命令，例如 `pnpm check`。 */
  testCommand: string;
}

export interface Task {
  id: string;
  repoId: string;
  issueNumber: number;
  title: string;
  /** 创始人的原话。 */
  rawRequest: string;
  /** 提出人（驾驶舱用户或 GitHub 用户名）。 */
  requestedBy: string;
  state: TaskState;
  /** 数字越小越先做；驾驶舱可拖动调整。 */
  priority: number;
  /** 需求文档所在目录，例如 `specs/12-登录验证码`。 */
  specDir?: string;
  /** 做完标准（从需求文档来），fleet task 给会话看。 */
  acceptance?: string[];
  createdAt: string;
}

export interface Subtask {
  id: string;
  taskId: string;
  index: number;
  title: string;
  /** 会改哪些文件或目录（方案里写明），用来做不撞车调度。 */
  touches: string[];
  dependsOn: string[];
  state: SubtaskState;
  prNumber?: number;
  /** 排队时在等什么（白话），例如「等 Claude 订阅 A 号的并发空位」。 */
  waitingOn?: string;
}

export interface Step {
  index: number;
  /** 白话，例如「正在写验证码过期的测试」。 */
  title: string;
  state: StepState;
}

export interface Channel {
  id: string;
  name: string;
  billing: BillingKind;
  enabled: boolean;
}

export interface Pool {
  id: string;
  channelId: string;
  maxConcurrency: number;
  /** 订阅到期日。读数里给了（目前只有 Cursor 给账期末）就按读数写。 */
  expiresAt?: string;
  /** 这个池里各模型组窗口扣哪些模型（组名 → 成员表），读数里给了就按读数写，例如 Cursor 的 auto / api 两个桶。没给成员表的组按组名匹配。 */
  scopeModels?: Record<string, ScopeMembership>;
  /** 最近一次读成额度的时刻，读失败不动。每小时对账按池看它是否超过 30 分钟，不逐窗口看。 */
  lastReadOkAt?: string;
}

/** 每个账号池、每个时间窗各一行——只存「最紧的那个」就做不到「快清零的先用」。 */
export interface QuotaWindow {
  poolId: string;
  window: QuotaWindowKind;
  /**
   * 只扣某一组模型的窗口写组名（中转的 7d_claude、7d_fable，Cursor 的 auto / api 桶……）；账号级窗口不填。
   * 同一池可以有好几个模型组窗口。
   */
  scope?: string;
  /** 已用比例，通常 0–1；超额是真实情况，可以大于 1（显示时再截）。 */
  utilization?: number;
  used?: number;
  limit?: number;
  resetsAt?: string;
  upstreamStatus?: QuotaStatus;
  reading: ReadingKind;
  readAt: string;
  /** 上游对这个窗口的原名（如 5h、7d_claude、auto_percent）。window 是归类，label 是原样；同一池里不重复，入库必填。 */
  label?: string;
  /** used / limit 的单位，入库必填。 */
  unit?: QuotaUnit;
  /** 读法：claude-usage、mirasim-relay、cursor-dashboard、grok-billing、estimate……（官方接口、网页接口还是估算，看读法），入库必填。 */
  source?: string;
  /** 上游的原状态字。归不进 upstreamStatus 的也留着给人看，不猜。 */
  statusRaw?: string;
  /**
   * 读成了、但上游从这个时刻起没再报这个窗口。照样显示（注明「上游这次没报」），但不挡路由、不参与排序；
   * 上游重新报了就清空，满 24 小时删掉。
   */
  staleSince?: string;
}

/** 模型厂商家族，例如 claude、gpt。禁令可以按族下。 */
export interface Family {
  id: string;
  displayName: string;
  vendor: string;
}

export interface Model {
  id: string;
  family: string;
  displayName: string;
  /** 下架时间；下架后对应路由自动离线。 */
  retiredAt?: string;
}

/** 路由 = 渠道 + 账号池 + 模型 + 执行方式，一条能跑的线。 */
export interface Route {
  id: string;
  channelId: string;
  poolId: string;
  modelId: string;
  hostId: HostId;
  /** 只由探针和熔断写，不许手填。 */
  alive: boolean;
}

/** 每个阶段类型挂一串有序路由，驾驶舱拖动排序。 */
export interface StagePolicy {
  stage: StageKind;
  routeIds: string[];
  /** 创始人手动钉住的顺序，AI 帅位不改。 */
  pinned: boolean;
}

/** 全局禁令：GPT × UI、Fable × 一切。 */
export interface Ban {
  family?: string;
  modelId?: string;
  stage?: StageKind;
  reason: string;
}

export type RunOutcome = 'ok' | 'failed' | 'stopped' | 'stalled';

/** 一次 AI 会话。排队和干活分开计时。 */
export interface SessionRun {
  id: string;
  /** 帅位会话、考新模型的会话不属于任何需求，没有 taskId，但照样记账、照样占账号池并发。 */
  taskId?: string;
  subtaskId?: string;
  stage: StageKind;
  routeId: string;
  /** 一句话「为什么派给它」。 */
  whyRoute: string;
  /** 会话干活的分支。 */
  branch?: string;
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  outcome?: RunOutcome;
  /** 上游实际用的模型。请求的模型看路由；两者不同就是被静默换了，战绩按实际的算。 */
  actualModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export type ProgressKind = 'plan' | 'say' | 'tool' | 'file' | 'test' | 'ask' | 'done' | 'blocked';

/** 会话过程中的一条进度或动作，被动读出来的和 fleet 命令主动报的都进这里。 */
export interface ProgressEvent {
  runId: string;
  at: string;
  kind: ProgressKind;
  /** 按 kind 不同而不同；fleet 命令报的就是命令的请求体：plan 是 { steps: Step[] }（库里有检查），say 是 { text }…… */
  payload: unknown;
}
