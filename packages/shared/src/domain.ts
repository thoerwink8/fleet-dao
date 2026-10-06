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
  | 'verify' // 开 PR 前别家验证（Fusion 第 5 步）：只派别家、只读
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
  /** 给人看的测试命令（repos.test_command）。起会话、交活核对不认它：认每次会话自己带的（SessionRun.testCommand）。 */
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

/**
 * 渠道近态（channel_states，#1118）：运行中失败被标成 disabled 的渠道、原因、顺到谁。没有这一行的渠道没出过事。
 * 和 routes.probe_state（一条路由最近一次探针的结论）分开：这是渠道整体现在能不能用。
 */
export interface ChannelStateRecord {
  channelId: string;
  status: 'ok' | 'disabled';
  /** disabled 的原因（失败分流的原因，带上游原文摘要）；ok 时可带一句恢复的依据。 */
  reason?: string;
  /** 引发 disabled 的那条路由：探针探通它才改回 ok；路由被删了没有。 */
  failedRouteId?: string;
  /** 顺到谁：选路派到的下一个渠道和模型；还没派出去（或没有渠道可派）没有。 */
  fallbackChannelId?: string;
  fallbackModelId?: string;
  /** 探针最近一次探过这个渠道下某条路由的时刻；没探过没有。 */
  lastProbedAt?: string;
  /** 这一次 disabled 是几点标上的；ok 没有。 */
  flaggedAt?: string;
  updatedAt: string;
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
  /** 这个池的会话跑在哪个系统用户下。法国只有一个会话用户，两个 Claude 池都填它（design 第十节）。没填 = 还没定。 */
  runAsUser?: RunAsUser;
  /**
   * Claude 订阅池对应 reclaude 的哪一类组织：拼车（team）、独享（personal）。会话用户同一时刻只挂一个组织，
   * 只有挂着的那个池能派（design 第九节）。不是 Claude 订阅池就不填。
   */
  orgKind?: OrgKind;
}

/**
 * 会话只许跑在这个系统用户下（装机脚本建的，docs/ops.md）；库里有同样的检查约束（db 的 RUN_AS_USERS）。
 * 法国只留一个会话用户：reclaude 一个账户最多挂 4 台设备、一个家目录算一台（创始人 2026-09-26）。名字是历史沿用，
 * 不改名免得重新登录；原先的 fleet-agent-dedicated 已停用、已删。
 */
export type RunAsUser = 'fleet-agent-carpool';

/** reclaude 组织的类型：org list 里 team = 拼车、personal = 独享。 */
export type OrgKind = 'solo' | 'carpool';

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
  /** 只由探针和熔断写，不许手填；库里约束 alive 为真时探针的结论必须是 ok。 */
  alive: boolean;
  /** 路由探针最近一次的结论（#129，design 第九节「路由探针」）；没有 = 探针还没看过这条路由。 */
  probe?: RouteProbe;
  /**
   * 插头实际发给上游的模型串（目录原文，例如 claude-opus-5-5、grok-4.7[context=256k,…]）。
   * 额度的模型组成员表只和它、和 upstreamAliases 比；两样都没填，这条路由扣哪个桶判不了，额度按未知算。
   */
  upstreamModel?: string;
  /** 上游在别处对这条路由的叫法，和上面的模型串不同名时填，例如 Cursor 额度接口里 Auto 叫 default。 */
  upstreamAliases?: string[];
}

/**
 * 路由探针对一条路由的结论（design 第九节「路由探针」）：
 * ok = 真起了一次最小会话、答上了（额度用满被拒也算：登录、组织、上游都通，额度另有额度那一套挡）；
 * failed = 探了、没探通（原因写在 detail）；not_wired = 这种执行方式引擎还没接，探不了、也派不了；
 * skipped = 这一轮没探（按量计费、渠道下架、会话用户挂着别的组织……原因写在 detail），不算探过。
 * 只有 ok 让 alive 为真，其余一律不在线。
 */
export type RouteProbeState = 'ok' | 'failed' | 'not_wired' | 'skipped';

export interface RouteProbe {
  state: RouteProbeState;
  /** 探针下这个结论的时刻（没探的也记：这一轮看过、没探）。 */
  at: string;
  /** 不是 ok 必须写原因；ok 也带一句（回答原文、用时）。 */
  detail?: string;
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
  /** 这一轮没命中缓存的输入。token、花费读不到就不给，不当成 0。 */
  inputTokens?: number;
  outputTokens?: number;
  /** 这一轮的缓存读、缓存写（Claude、cursor 的终帧都报）：折额度当量要用（usage.ts）。 */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  /** 起会话时交代给它的测试命令（当时的流程配置副本里的），交活核对认它；没有 = 开工时项目没写，或这一项加上之前开的会话。 */
  testCommand?: string;
}

/** v3 的三段：对题、动手、验收（库里 runs.segment，引擎 RunRecord.segment）。 */
export type SegmentKind = 'scope' | 'manual' | 'verify';
/** 派工档（引擎 runner/tier.ts 的 TierEnum）：快档、中档、主力档。只有动手段分档。 */
export type SegmentTier = 'fast' | 'medium' | 'heavyweight';
/** 一段跑完的结局（库里 runs.outcome）；还在跑的没有。org_switch = 切号先停下这一段，切完在原分支上重跑（#59）。 */
export type SegmentOutcome =
  | 'done'
  | 'timeout'
  | 'killed'
  | 'spawn_failed'
  | 'admission_blocked'
  | 'failed'
  | 'org_switch';

/**
 * v3 三段里一段跑一次（库里 runs 表的一行）。读不到的字段不给，不当成 0。段名、派工档、结局库里有约束，
 * 读的一方照样再认一遍（segment-runs.ts 的 readSegmentRun），认不出的明说。
 */
export interface SegmentRun {
  id: string;
  segment: SegmentKind;
  /** 需求。写入那一端还没填它的老行按单号兜底对单（任务详情标明是兜底）。 */
  taskId?: string;
  issueNumber?: number;
  /** 路由挑的模型（模型目录的 id）。 */
  model: string;
  /** 渠道（channels.id）：花费按它的计费方式分按量、套餐内。 */
  channel?: string;
  tier?: SegmentTier;
  startedAt: string;
  /** 还在跑的没有（和 outcome 一起空）。 */
  endedAt?: string;
  outcome?: SegmentOutcome;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  /** 内存峰值（MiB）：只有挂在 cgroup 里的会话读得到，本机不给。 */
  memoryPeakMb?: number;
  failureReason?: string;
  prNumber?: number;
  branch?: string;
  /** 三段那条线的工作流编号（taskWorkflowId）。 */
  workflowId?: string;
  /** 重跑的是哪一笔。 */
  retryOf?: string;
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
