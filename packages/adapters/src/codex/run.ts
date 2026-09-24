// codex 插头（直起 codex exec --json）。法国 VPS 上 codex 的登录是按量计费的 API key，而且已拍板「codex 只走 Mirasim 中转」，
// 所以这条直起的路这一轮只写好、用假上游验过事件格式，不对真上游跑；要不要启用等创始人定（见 PR）。
// 走中转的 codex 用 Mirasim 插头（agent=codex、route=cloud）。
import { type AgentRunOptions, assertRunnable, runCliAgent } from '../cli-run.ts';
import { buildSessionEnv, type SessionEnvInput } from '../env.ts';
import type { RunFacts, RunSummary } from '../judge.ts';
import type { AgentProcessResult, ProcessLimits } from '../process.ts';
import type { CgroupScope } from '../procs.ts';
import { cut, lastLines, looksLikeQuotaExhausted } from '../stream-kit.ts';
import { buildCodexArgs, type CodexArgsSpec, type CodexSession } from './args.ts';
import {
  CodexStreamReader,
  type CodexStreamSummary,
  type CodexUsage,
  codexUsageOfThisRun,
} from './stream.ts';

export interface CodexRunSpec extends Omit<CodexArgsSpec, 'cwd'> {
  runId: string;
  cwd: string;
  prompt: string;
  /** 账号池的 CODEX_HOME 放进 env.extra（登录态在它下面的 auth.json 里，不走环境变量）。 */
  env: SessionEnvInput;
  limits?: Partial<ProcessLimits>;
  testCommands?: readonly string[];
  cgroup?: CgroupScope;
}

export interface CodexRunReport extends AgentProcessResult {
  runId: string;
  requestedModel: string;
  session: CodexSession;
  stream: CodexStreamSummary;
}

export async function runCodex(spec: CodexRunSpec, options: AgentRunOptions): Promise<CodexRunReport> {
  await assertRunnable(options.command, spec.prompt, spec.cwd);
  const args = buildCodexArgs({
    model: spec.model,
    session: spec.session,
    cwd: spec.cwd,
    bypassSandbox: spec.bypassSandbox,
    ...(spec.config ? { config: spec.config } : {}),
  });
  const reader = new CodexStreamReader({
    runId: spec.runId,
    cwd: spec.cwd,
    ...(spec.testCommands ? { testCommands: spec.testCommands } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const resumeId = spec.session.mode === 'resume' ? spec.session.id : undefined;
  const result = await runCliAgent(
    {
      runId: spec.runId,
      cwd: spec.cwd,
      args,
      env: buildSessionEnv(spec.env),
      stdin: spec.prompt,
      limits: spec.limits,
      cgroup: spec.cgroup,
      read: (line) => reader.read(line),
      busy: () => reader.toolsInFlight > 0,
      inspect(effect, control) {
        if (resumeId && effect.sessionId && effect.sessionId !== resumeId) control.kill('session_mismatch');
      },
    },
    options,
  );
  return {
    ...result,
    runId: spec.runId,
    requestedModel: spec.model,
    session: spec.session,
    stream: reader.summary(),
  };
}

export function codexRunFacts(report: CodexRunReport): RunFacts {
  const s = report.stream;
  const words = lastLines([...s.errors.slice(-3), report.stderrTail].join('\n'));
  return {
    ...(report.spawnError ? { spawnError: report.spawnError } : {}),
    ...(report.killed ? { killed: report.killed.reason } : {}),
    exitCode: report.exitCode,
    signal: report.signal,
    ...(s.turn
      ? { terminal: { isError: !s.turn.ok, detail: cut(s.turn.error ?? 'turn.completed', 300) } }
      : {}),
    quotaExhausted: looksLikeQuotaExhausted(s.turn?.error) || looksLikeQuotaExhausted(words),
    ...(words ? { lastWords: words } : {}),
  };
}

/**
 * 交给引擎的统一摘要。usage 是整个会话的累计值：续跑要给上一轮的 usage 才算得出本轮用量，不给就不带用量。
 * 事件流里没有实际模型，不带 actualModel。
 */
export function codexRunSummary(report: CodexRunReport, previous?: CodexUsage): RunSummary {
  const current = report.stream.turn?.sessionUsage;
  const usage =
    report.session.mode === 'resume' && previous === undefined
      ? undefined
      : codexUsageOfThisRun(current, previous);
  return {
    facts: codexRunFacts(report),
    ...(report.stream.sessionId ? { sessionId: report.stream.sessionId } : {}),
    usage: { ...usage },
  };
}
