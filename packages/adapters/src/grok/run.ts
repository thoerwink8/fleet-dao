// Grok 命令行插头：无头起一个会话（提示词经 --prompt-file /dev/stdin 走 stdin，前面垫一根真管道），过程记录转成进度事件，结束时交出报告。
// 会话号和实际模型只在最后一行 end 里：跑的中途核对不了，跑完核对，不符照样判失败。
import { type AgentRunOptions, assertRunnable, runCliAgent } from '../cli-run.ts';
import { buildSessionEnv, type SessionEnvInput } from '../env.ts';
import type { RunFacts, RunSummary } from '../judge.ts';
import type { AgentProcessResult, ProcessLimits } from '../process.ts';
import type { CgroupScope } from '../procs.ts';
import { cut, lastLines, looksLikeQuotaExhausted } from '../stream-kit.ts';
import { buildGrokArgs, type GrokArgsSpec, type GrokSession, grokModelMatches } from './args.ts';
import { GrokStreamReader, type GrokStreamSummary } from './stream.ts';

export interface GrokRunSpec extends Omit<GrokArgsSpec, 'cwd' | 'promptFile'> {
  runId: string;
  /** 工作树。 */
  cwd: string;
  prompt: string;
  /** grok 的登录态在 HOME（或 GROK_HOME）下；要用 XAI_API_KEY 就放进 env.extra（只给这个会话）。 */
  env: SessionEnvInput;
  limits?: Partial<ProcessLimits>;
  testCommands?: readonly string[];
  cgroup?: CgroupScope;
  /** 不在 Linux 上跑时（开发机）换成真文件；默认 /dev/stdin。 */
  promptFile?: string;
}

export interface GrokRunReport extends AgentProcessResult {
  runId: string;
  requestedModel: string;
  session: GrokSession;
  stream: GrokStreamSummary;
}

export async function runGrok(spec: GrokRunSpec, options: AgentRunOptions): Promise<GrokRunReport> {
  await assertRunnable(options.command, spec.prompt, spec.cwd);
  const args = buildGrokArgs({
    model: spec.model,
    session: spec.session,
    cwd: spec.cwd,
    alwaysApprove: spec.alwaysApprove,
    ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
    ...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}),
    ...(spec.promptFile ? { promptFile: spec.promptFile } : {}),
  });
  const reader = new GrokStreamReader({
    runId: spec.runId,
    cwd: spec.cwd,
    ...(spec.testCommands ? { testCommands: spec.testCommands } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const result = await runCliAgent(
    {
      runId: spec.runId,
      cwd: spec.cwd,
      args,
      // 自动更新会在会话中途换二进制
      env: { ...buildSessionEnv(spec.env), GROK_DISABLE_AUTOUPDATER: '1' },
      stdin: spec.prompt,
      limits: spec.limits,
      cgroup: spec.cgroup,
      read: (line) => reader.read(line),
      busy: () => reader.toolsInFlight > 0,
      drain: () => reader.flush(),
    },
    { ...options, command: viaStdinPipe(options.command, spec.promptFile) },
  );
  return {
    ...result,
    runId: spec.runId,
    requestedModel: spec.model,
    session: spec.session,
    stream: reader.summary(),
  };
}

/**
 * Node 给子进程的 stdin 是 socketpair，不是管道：grok 打开 /dev/stdin 会报 ENXIO（「No such device or address」，
 * VPS 实跑撞到的；shell 里 `printf … | grok` 那种真管道没事）。所以前面垫一个 cat，把提示词倒进一根真管道再交给 grok。
 * 退出码是 grok 的（管道最后一段），进程组一起收。给了提示词文件就不用垫。
 */
function viaStdinPipe(command: readonly string[], promptFile: string | undefined): readonly string[] {
  if (promptFile || process.platform === 'win32') return command;
  return ['/bin/sh', '-c', 'cat | exec "$0" "$@"', ...command];
}

export function grokRunFacts(report: GrokRunReport): RunFacts {
  const s = report.stream;
  const end = s.end;
  const words = lastLines([...s.errors, report.stderrTail].join('\n'));
  const observedModel = end?.models[0];
  const mismatch =
    end?.sessionId && end.sessionId !== report.session.id
      ? { kind: 'session' as const, expected: report.session.id, observed: end.sessionId }
      : observedModel && !grokModelMatches(report.requestedModel, observedModel)
        ? { kind: 'model' as const, expected: report.requestedModel, observed: observedModel }
        : undefined;
  const isError =
    s.errors.length > 0 || s.maxTurnsReached || (end !== undefined && end.stopReason !== 'end_turn');
  return {
    ...(report.spawnError ? { spawnError: report.spawnError } : {}),
    ...(report.killed ? { killed: report.killed.reason } : {}),
    exitCode: report.exitCode,
    signal: report.signal,
    ...(mismatch ? { mismatch } : {}),
    ...(end
      ? {
          terminal: {
            isError,
            detail: cut(
              [end.stopReason, s.maxTurnsReached ? '到了轮数上限' : undefined, ...s.errors]
                .filter((x) => x)
                .join(' · '),
              300,
            ),
          },
        }
      : {}),
    quotaExhausted: looksLikeQuotaExhausted(words),
    ...(words ? { lastWords: words } : {}),
  };
}

/** 交给引擎的统一摘要。end 里的花费只算这一轮，续跑不用求差。 */
export function grokRunSummary(report: GrokRunReport): RunSummary {
  const end = report.stream.end;
  const u = end?.usage;
  return {
    facts: grokRunFacts(report),
    ...(end?.models[0] ? { actualModel: end.models[0] } : {}),
    ...(end?.sessionId ? { sessionId: end.sessionId } : {}),
    // 字段同名：终帧里有哪些带哪些
    usage: { ...u, ...(end?.costUsd === undefined ? {} : { costUsd: end.costUsd }) },
  };
}
