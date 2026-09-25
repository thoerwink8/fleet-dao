// Claude Code 以外的渠道插头（P3）：cursor-agent、Grok 命令行、codex、Mirasim 中转、接口外壳，和它们共用的起停管道。
// 和 Claude 插头同一套接口：起会话、过程记录转进度事件、收尸、能续就续、判交付（judgeRun）、用量（xxxRunSummary）。
export {
  type AgentRunOptions,
  assertRunnable,
  CallbackGate,
  type CliRunPlan,
  type LineEffect,
  runCliAgent,
} from './cli-run.ts';
export { buildCodexArgs, type CodexArgsSpec, type CodexSession } from './codex/args.ts';
export {
  type CodexRunReport,
  type CodexRunSpec,
  codexRunFacts,
  codexRunSummary,
  runCodex,
} from './codex/run.ts';
export {
  CodexStreamReader,
  type CodexStreamSummary,
  type CodexUsage,
  codexUsageOfThisRun,
  unwrapShell,
} from './codex/stream.ts';
export { buildCursorArgs, type CursorArgsSpec, type CursorSession } from './cursor/args.ts';
export {
  type CursorRunReport,
  type CursorRunSpec,
  cursorRunFacts,
  cursorRunSummary,
  runCursorAgent,
} from './cursor/run.ts';
export {
  type CursorResult,
  CursorStreamReader,
  type CursorStreamSummary,
  type CursorUsage,
} from './cursor/stream.ts';
export { buildGrokArgs, type GrokArgsSpec, type GrokSession, grokModelMatches } from './grok/args.ts';
export { type GrokRunReport, type GrokRunSpec, grokRunFacts, grokRunSummary, runGrok } from './grok/run.ts';
export { type GrokEnd, GrokStreamReader, type GrokStreamSummary, type GrokUsage } from './grok/stream.ts';
export {
  type LedgerReading,
  type LedgerRouting,
  type LedgerRow,
  ledgerRouting,
  readMirasimLedger,
} from './mirasim/ledger.ts';
export {
  DEFAULT_MIRASIM_LIMITS,
  type MirasimAccepted,
  type MirasimLimits,
  type MirasimRoute,
  type MirasimRunOptions,
  type MirasimRunReport,
  type MirasimRunSpec,
  type MirasimSessionRef,
  mirasimRouting,
  mirasimRunFacts,
  mirasimRunSummary,
  runMirasim,
  stopMirasimSession,
} from './mirasim/run.ts';
export { MirasimSession, type MirasimState, type MirasimToolCall } from './mirasim/session.ts';
export {
  assertNotRealMirasimInTests,
  type MirasimConnect,
  type MirasimEndpoint,
  type MirasimFrame,
  type MirasimWire,
  mirasimConnector,
  openWire,
} from './mirasim/wire.ts';
export {
  type ApiErrorKind,
  type ApiShellOptions,
  type ApiShellReport,
  type ApiShellSpec,
  apiShellFacts,
  apiShellSummary,
  classifyHttpError,
  runApiShell,
} from './shell/run.ts';
export {
  type CommandResult,
  createHost,
  type HostOptions,
  insideTree,
  SHELL_TOOLS,
  type ShellHost,
} from './shell/tools.ts';
export {
  parseReply,
  requestFor,
  type ShellApi,
  type ShellFormat,
  type ShellMessage,
  type ShellReply,
  type ShellToolCall,
  type ShellToolResult,
  type ShellToolSpec,
} from './shell/wire.ts';
export { looksLikeQuotaExhausted, planFromTodos } from './stream-kit.ts';
