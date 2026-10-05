// Claude Code 以外的渠道插头（P3）：cursor-agent、Grok 命令行、Mirasim 中转，和它们共用的起停管道。
// 和 Claude 插头同一套接口：起会话、过程记录转进度事件、收尸、能续就续、判交付（judgeRun）、用量（xxxRunSummary）。
export {
  type AgentRunOptions,
  assertRunnable,
  CallbackGate,
  type CliRunPlan,
  type LineEffect,
  runCliAgent,
} from './cli-run.ts';
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
  type BridgeConnectorOptions,
  type BridgeMirasimEndpoint,
  bridgeMirasimConnector,
} from './mirasim/bridge-connect.ts';
export {
  type LedgerFs,
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
export { looksLikeQuotaExhausted, planFromTodos } from './stream-kit.ts';
