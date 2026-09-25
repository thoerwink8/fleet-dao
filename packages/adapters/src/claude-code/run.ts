// Claude Code 插头：经 reclaude 无头起一个会话，边跑边把过程记录转成进度事件，结束时交出一份报告。
import { type AgentRunOptions, assertRunnable, runCliAgent } from '../cli-run.ts';
import type { DeliveryCheck } from '../delivery.ts';
import { assertNoForbiddenEnv, buildSessionEnv, type SessionEnvInput } from '../env.ts';
import { judgeRun, type RunFacts, type RunSummary, type RunVerdict } from '../judge.ts';
import type { AgentProcessResult, ProcessLimits } from '../process.ts';
import type { CgroupScope } from '../procs.ts';
import { lastLines, optional } from '../stream-kit.ts';
import { buildClaudeArgs, type ClaudeArgsSpec, type ClaudeSession } from './args.ts';
import {
  type ClaudeResult,
  ClaudeStreamReader,
  type ClaudeStreamSummary,
  costOfThisRun,
  sameModel,
  versionAtLeast,
} from './stream.ts';

/** 没有 CLAUDE.md 时回退读 AGENTS.md 是 2.1.277 才有的；更旧的版本会漏读仓库规矩。 */
export const MIN_CLAUDE_VERSION = '2.1.277';

/**
 * Claude 的 Bash 工具默认 2 分钟就把命令杀掉：长一点的测试、等回答的 fleet ask 都会被腰斩。
 * 会话里默认放宽到 10 分钟，模型自己最多能要到 30 分钟（BASH_DEFAULT_TIMEOUT_MS 生效已在 VPS 实测）。
 */
export const DEFAULT_BASH_TIMEOUT_MS = 10 * 60_000;
const MAX_BASH_TIMEOUT_MS = 30 * 60_000;

/** reclaude 自己管上游、代理和证书：会话环境里带了这些，请求会被改道到别的网关。 */
export const UPSTREAM_ENV: readonly RegExp[] = [
  /^ANTHROPIC_/i,
  /^(HTTPS?|ALL|NO)_PROXY$/i,
  /^NODE_EXTRA_CA_CERTS$/i,
];

export interface ClaudeCodeRunSpec extends ClaudeArgsSpec {
  /** 驾驶舱里这次会话的编号：进度事件挂在它下面，也是收尸用的会话标记。 */
  runId: string;
  /** 工作树。 */
  cwd: string;
  /** 走 stdin。 */
  prompt: string;
  env: SessionEnvInput;
  limits?: Partial<ProcessLimits>;
  /** 会话里单条命令的默认超时，默认 DEFAULT_BASH_TIMEOUT_MS。 */
  bashTimeoutMs?: number;
  /** 仓库的测试命令，用来认出「跑了测试」。 */
  testCommands?: readonly string[];
  cgroup?: CgroupScope;
}

export interface ClaudeCodeRunOptions extends AgentRunOptions {
  minCliVersion?: string;
}

export interface ClaudeCodeRunReport extends AgentProcessResult {
  runId: string;
  requestedModel: string;
  session: ClaudeSession;
  stream: ClaudeStreamSummary;
}

export async function runClaudeCode(
  spec: ClaudeCodeRunSpec,
  options: ClaudeCodeRunOptions,
): Promise<ClaudeCodeRunReport> {
  await assertRunnable(options.command, spec.prompt, spec.cwd);
  const args = buildClaudeArgs(spec);
  const bashTimeout = spec.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const env = {
    ...buildSessionEnv(spec.env),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    BASH_DEFAULT_TIMEOUT_MS: String(bashTimeout),
    BASH_MAX_TIMEOUT_MS: String(Math.max(bashTimeout, MAX_BASH_TIMEOUT_MS)),
  };
  assertNoForbiddenEnv(
    env,
    UPSTREAM_ENV,
    'reclaude 自己管上游、代理和证书，外面带进去会把请求改道到别的网关',
  );
  const minVersion = options.minCliVersion ?? MIN_CLAUDE_VERSION;
  const reader = new ClaudeStreamReader({
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
      env,
      stdin: spec.prompt,
      limits: spec.limits,
      cgroup: spec.cgroup,
      read: (line) => reader.read(line),
      busy: () => reader.toolsInFlight > 0,
      inspect(effect, control) {
        if (effect.init?.sessionId && effect.init.sessionId !== spec.session.id) {
          control.kill('session_mismatch');
        }
        if (effect.init?.cliVersion && versionAtLeast(effect.init.cliVersion, minVersion) === false) {
          control.kill('cli_too_old');
        }
        // init.model 只是回显，核对要等第一条真实回复
        if (effect.observedModel && !sameModel(spec.model, effect.observedModel)) {
          control.kill('model_mismatch');
        }
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

/** 把报告整理成通用的判定事实。 */
export function claudeRunFacts(report: ClaudeCodeRunReport): RunFacts {
  const r = report.stream.result;
  const apiError = report.stream.apiError;
  return {
    ...(report.spawnError ? { spawnError: report.spawnError } : {}),
    ...(report.killed ? { killed: report.killed.reason } : {}),
    exitCode: report.exitCode,
    signal: report.signal,
    ...(r
      ? {
          terminal: {
            isError: r.isError,
            detail: [
              r.terminalReason,
              apiError?.code,
              r.apiErrorStatus === undefined ? undefined : `HTTP ${r.apiErrorStatus}`,
              r.text?.slice(0, 300),
            ]
              .filter((x) => x)
              .join(' · '),
          },
        }
      : {}),
    quotaExhausted: report.stream.rateLimits.some((reading) => reading.exhausted),
    ...optionalWords(lastLines(report.stderrTail)),
  };
}

export function judgeClaudeRun(report: ClaudeCodeRunReport, delivery?: DeliveryCheck): RunVerdict {
  return judgeRun(claudeRunFacts(report), delivery);
}

/**
 * 交给引擎的统一摘要。终帧的花费是整个会话的累计值：续会话要给上一轮的终帧才算得出本轮花费，
 * 不给就不带花费（不把累计值当本轮的记）。fork 出来的会话不知道累计值是从 0 起算还是接着旧会话算
 * （没有实测确认过），一律不给花费——宁可不知道，也不拿旧会话的累计去减出一个可能错的数。
 */
export function claudeRunSummary(report: ClaudeCodeRunReport, previous?: ClaudeResult): RunSummary {
  const r = report.stream.result;
  const cost =
    report.session.mode === 'fork'
      ? undefined
      : report.session.mode === 'resume' && previous === undefined
        ? undefined
        : costOfThisRun(r, previous);
  return {
    facts: claudeRunFacts(report),
    ...(report.stream.observedModel ? { actualModel: report.stream.observedModel } : {}),
    ...(report.stream.sessionId ? { sessionId: report.stream.sessionId } : {}),
    usage: {
      ...optional('inputTokens', r?.usage?.inputTokens),
      ...optional('outputTokens', r?.usage?.outputTokens),
      ...optional('cacheReadTokens', r?.usage?.cacheReadInputTokens),
      ...optional('cacheWriteTokens', r?.usage?.cacheCreationInputTokens),
      ...optional('contextTokens', report.stream.lastContextTokens),
      ...(cost === undefined ? {} : { costUsd: cost }),
    },
  };
}

function optionalWords(words: string | undefined): { lastWords?: string } {
  return words === undefined ? {} : { lastWords: words };
}
