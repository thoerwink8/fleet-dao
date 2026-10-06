// 删 Fusion 之后仍然要留的类型：会话端口（ports.ts）、契约（contract.ts）、假实现（fakes.ts）、
// 真端口（real/）、跑流程用的零件（workflows/kit.ts）都还要用，从被删的 decisions/{triage,plan,verify,merge}.ts 搬过来。
// 只有类型，没有判断逻辑——判断那半边随 Fusion 工作流一起删了。

// ---- 返工意见（原 decisions/verify.ts 的 Feedback）

/** 回主会话的一条返工意见。 */
export interface Feedback {
  /**
   * hygiene = 卫生检查拦下了会话交的内容（密钥、账号编号……），要拿掉；delivery = 交的东西没过引擎的核对
   * （没提交的改动、空交付……）；ask = 会话 fleet blocked 说要人，退回让它带选项和推荐用 fleet ask 重问（#259）；
   * answer = 创始人晚到的回答改选了别的，照他选的改（#259，存档点交给 Lead）。
   */
  kind: 'ci' | 'review' | 'conflict' | 'merge-return' | 'plan' | 'hygiene' | 'delivery' | 'ask' | 'answer';
  summary: string;
  items: string[];
}

// ---- 同步主线 / CI（原 decisions/verify.ts）

/** 把最新主线并进分支、推上去之后的结果。clean 也包括「本来就是最新」。 */
export interface SyncResult {
  state: 'clean' | 'conflict';
  head: string;
  conflictFiles: string[];
}

/**
 * CI 结果，证据绑定 head。unknown = 没查成（没有检查、超时读不到……），不是没过也不是过了；conflict = GitHub 不给
 * 冲突的 PR 起 CI（和 unknown 分开：这个有确定的解法，并主线，不是读不到）；diverged = PR 的头变了、新头不含老头
 * （像是被强推改写了），不是自动并主线能接的，要人看；merged = 查到 PR 已经在外面合并了（GitHub 自己的自动合并，
 * 合并闸绿就合，不是引擎自己合的）：不是没查成，直接当合上了（mergeCommit 带着合并提交）。
 */
export interface CiResult {
  state: 'green' | 'red' | 'unknown' | 'conflict' | 'diverged' | 'merged';
  head: string;
  failedChecks: string[];
  /** 失败摘要（首个失败的测试名、报错首行）；有它才判「同一假设」。 */
  digest?: string;
  detail?: string;
  /** state 是 'merged' 时才有：合并提交。 */
  mergeCommit?: string;
}

export interface Finding {
  /** blocking = 必须改才能合；minor = 小毛病，攒起来批量修，不挡合并。 */
  severity: 'blocking' | 'minor';
  text: string;
  file?: string;
}

export interface ReviewResult {
  verdict: 'pass' | 'changes';
  /** 审的是哪个头；和送审的头对不上就作废。 */
  head: string;
  findings: Finding[];
}

// ---- 分诊（原 decisions/triage.ts 的类型）

export interface TriageVerdict {
  /** true 清楚；false 有说不清的地方；null 没判出来。 */
  clear: boolean | null;
  /** 该问创始人的那一句。 */
  question?: string;
  /** 说不清时给他挑的几个做法（2–4 个，#259）。 */
  options?: string[];
  /** 推荐哪个：照抄其中一个选项。 */
  recommend?: string;
  /** 三行以内的「AI 理解为」。 */
  summary?: string;
  size?: 'S' | 'M' | 'L';
  /** 是不是 UI 活（GPT 族禁入靠这个）。 */
  ui?: boolean;
  /** 会不会碰对外发布（release）、花钱（spend）、删数据（delete）：碰了的，每个子任务合并前都要人批。 */
  holds?: string[];
}

// ---- 方案（原 decisions/plan.ts 的类型）

export type SubtaskStage = 'execute' | 'ui';

/** 写方案的会话交出来的一条子任务（未经校验）。 */
export interface PlannedSubtask {
  key: string;
  title: string;
  /** 会改哪些文件或目录；前缀相同即算同一块地方。没写 = 整个仓，跟谁都撞。 */
  touches?: string[];
  dependsOn?: string[];
  stage?: SubtaskStage;
  acceptance?: string[];
  /** 人闸：会对外发布（release）、花钱（spend）、删数据（delete）的，合并前要人批。 */
  holds?: string[];
}

// ---- 合并（原 decisions/merge.ts 的类型）

export interface TestResult {
  passed: boolean;
  /** 测的是哪个头；和要合的头对不上不算数。 */
  head: string;
  summary: string;
}

export interface MergeOutcome {
  merged: boolean;
  mergeCommit?: string;
  reason?: string;
}
