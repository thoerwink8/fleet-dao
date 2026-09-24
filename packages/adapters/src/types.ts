// 插头交给引擎的东西：进度事件的载荷、强杀的原因、额度读数。
// ProgressEvent 本身在 @fleet-dao/shared；这里定 payload 的形状。驾驶舱后端的时间线按字段名读
// （say.text、tool.name、file.path、test.passed / command），改字段名先对 packages/api 的 describeTimeline。
import type { QuotaWindowKind } from '@fleet-dao/shared';

/** kind='say'：助手说的一段话。stream = 从过程记录被动读到的；fleet say 主动报的由后端另记。 */
export interface SayPayload {
  text: string;
  source: 'stream';
}

/** 驾驶舱按这个给工具调用归类：读、改、跑命令…… */
export type ToolAction = 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'other';

/** kind='tool'：一次工具调用开始（start）或结束（end）。 */
export interface ToolPayload {
  phase: 'start' | 'end';
  toolUseId: string;
  /** 执行体里的工具原名，例如 Read、Edit、Bash。 */
  name: string;
  action: ToolAction;
  /** 文件路径（工作树内给相对路径）、命令原文、搜索词……最多 200 字。 */
  summary: string;
  /** 助手自己写的说明（Bash 的 description），有才带。 */
  description?: string;
  /** 只在 end 上有。 */
  ok?: boolean;
  /** 失败时的原文，最多 500 字。 */
  error?: string;
  /** 子代理里发起的调用。 */
  subagent?: boolean;
}

/** kind='file'：改动了一个文件。工具报成功之后才发。 */
export interface FilePayload {
  path: string;
  tool: string;
}

/**
 * kind='test'：跑了一次测试命令（命令里含仓库配置的测试命令）。
 * 没有 passed = 结果未知：整条命令的退出码不一定是测试的（带管道没开 pipefail、`;`、`||`、放后台跑……），
 * 不许当成通过——交活核实只认会话自己跑的测试。
 */
export interface TestPayload {
  command: string;
  passed?: boolean;
  /** 结果未知的原因。 */
  unknownBecause?: string;
}

/** fleet plan 的一步（同形：库里查 plan 的 payload 必须带 steps 数组）。 */
export interface PlanStep {
  title: string;
  state: 'pending' | 'in_progress' | 'done';
}

/** kind='plan'：从执行体自己的待办清单被动读到的步骤清单（fleet plan 主动报的由后端另记）。 */
export interface PlanPayload {
  steps: PlanStep[];
  source: 'stream';
}

/** 插头自己把进程杀掉的原因。 */
export type KillReason =
  | 'startup_timeout' // 起了但迟迟没有第一帧
  | 'wall_clock_timeout' // 总时长到顶
  | 'idle_timeout' // 没有工具在跑，却长时间没动静
  | 'model_mismatch' // 实际回话的模型不是点名的那个
  | 'session_mismatch' // 续会话没续上原来那个会话
  | 'cli_too_old' // 命令行版本低于要求
  | 'aborted'; // 引擎叫停（换模型、暂停、叫停）

export interface RateLimitWindow {
  /** 执行体原名，例如 five_hour、seven_day。 */
  name: string;
  /** 能对上领域里的时间窗就给。 */
  kind?: QuotaWindowKind;
  /** 0–1。 */
  utilization?: number;
  resetsAt?: string;
}

/** 这一轮的用量。各家口径不同，没给的就不带——不拿 0 冒充读到了。 */
export interface RunUsage {
  /** 没命中缓存的输入。 */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /**
   * 执行体自报的本轮花费（美元）。订阅内的用量也会报一个数：它说明这一轮值多少，不说明账单多了这一笔；
   * 算不出本轮的（只有累计值、又没有上一轮）就不带。
   */
  costUsd?: number;
}

/** 过程记录里顺带的额度读数。exhausted = 这个账号池已经用满（要换池或等清零）。 */
export interface RateLimitReading {
  status: string;
  exhausted: boolean;
  rateLimitType?: string;
  resetsAt?: string;
  windows: RateLimitWindow[];
  observedAt: string;
}
