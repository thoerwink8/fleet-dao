// 三段会话的过程记录（#1640）：引擎把会话里的提示词、助手的话、工具调用和结果、报错、结论按条记进 run_transcript，
// 驾驶舱任务详情按段读。这里放两边（引擎写、驾驶舱读）共用的常量：条目种类、每条和每段的上限。
// 改上限前必须知道：已经记下的条目不会重截；上限只管往后写的。

/** 条目的种类。哪一家的流里没有某一种，就不记那一种，不编。 */
export const TRANSCRIPT_KINDS = [
  'prompt',
  'assistant',
  'tool_call',
  'tool_result',
  'error',
  'result',
  'truncated',
] as const;
export type TranscriptKind = (typeof TRANSCRIPT_KINDS)[number];

/** 每条的字数上限（超了截断并标出来）和每段的条数上限（超了停记，收尾补一条 truncated）。 */
export const TRANSCRIPT_LIMITS = {
  /** 助手说的话。 */
  assistantChars: 4000,
  /** 工具调用的输入摘要（命令、文件路径……）。 */
  toolInputChars: 300,
  /** 工具结果的开头一小段。 */
  toolResultChars: 500,
  /** 提示词（引擎交给会话的那份）：整份提示词很长，只留开头给人看大意。 */
  promptChars: 4000,
  /** 报错。 */
  errorChars: 1000,
  /** 最后的结论。 */
  resultChars: 4000,
  /** 每段最多记多少条。 */
  maxEntries: 3000,
} as const;

/** 被截断的条目：文本末尾接这个标记，meta 里同时带 truncated: true 和 originalChars（原来的字数）。 */
export const TRANSCRIPT_TRUNCATED_MARK = '…[已截断]';

/** 读接口一次最多回多少条、不给 limit 时回多少条。 */
export const TRANSCRIPT_PAGE_MAX = 500;
export const TRANSCRIPT_PAGE_DEFAULT = 200;
