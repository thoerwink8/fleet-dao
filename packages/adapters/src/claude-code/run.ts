// Claude Code 插头：经 reclaude 无头起一个会话，边跑边把过程记录转成进度事件，结束时交出一份报告。
import { stat } from 'node:fs/promises';
import type { ProgressEvent } from '@fleet-dao/shared';
import type { DeliveryCheck } from '../delivery.ts';
import { assertNoForbiddenEnv, buildSessionEnv, type SessionEnvInput } from '../env.ts';
import { judgeRun, type RunFacts, type RunVerdict } from '../judge.ts';
import {
  type AgentProcessResult,
  assertNotRealAgentInTests,
  DEFAULT_PROCESS_LIMITS,
  guardCallback,
  type ProcessLimits,
  runAgentProcess,
  type SpawnInfo,
} from '../process.ts';
import type { CgroupScope } from '../procs.ts';
import type { RateLimitReading } from '../types.ts';
import { buildClaudeArgs, type ClaudeArgsSpec, type ClaudeSession } from './args.ts';
import { ClaudeStreamReader, type ClaudeStreamSummary, sameModel, versionAtLeast } from './stream.ts';

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

export interface ClaudeCodeRunOptions {
  /** 起 reclaude 的命令，给绝对路径。没有默认值：谁要起真执行体谁显式给，测试里换成假执行体。 */
  command: readonly string[];
  /** 可以是 async 的：被拒不会炸进程，记进 hookError；交报告之前会等它们落定。 */
  onEvent?: (event: ProgressEvent) => unknown;
  onRateLimit?: (reading: RateLimitReading) => unknown;
  /** 进程起来了：引擎记下进程号和 scope，重启后用 reapSession 收旧会话。 */
  onSpawn?: (info: SpawnInfo) => unknown;
  signal?: AbortSignal;
  now?: () => Date;
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
  assertNotRealAgentInTests(options.command);
  if (!spec.prompt.trim()) throw new Error('提示词是空的');
  const dir = await stat(spec.cwd).catch(() => undefined);
  if (!dir?.isDirectory()) throw new Error(`工作目录不存在：${spec.cwd}`);

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
  const now = options.now ?? (() => new Date());
  const minVersion = options.minCliVersion ?? MIN_CLAUDE_VERSION;
  const reader = new ClaudeStreamReader({
    runId: spec.runId,
    cwd: spec.cwd,
    ...(spec.testCommands ? { testCommands: spec.testCommands } : {}),
    now,
  });
  let callbackError: string | undefined;
  const pending = new Set<Promise<unknown>>();
  const call = (fn: () => unknown) => {
    const settling = guardCallback(fn, (err) => {
      callbackError ??= err instanceof Error ? err.message : String(err);
    });
    if (settling) {
      pending.add(settling);
      void settling.finally(() => pending.delete(settling));
    }
  };

  const result = await runAgentProcess(
    {
      command: [...options.command, ...args],
      cwd: spec.cwd,
      env,
      stdin: spec.prompt,
      limits: { ...DEFAULT_PROCESS_LIMITS, ...spec.limits },
      runId: spec.runId,
      ...(spec.cgroup ? { scope: spec.cgroup } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    {
      onLine(line, control) {
        const effect = reader.read(line);
        if (effect.activity) control.touch();
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
        for (const event of effect.events) call(() => options.onEvent?.(event));
        const reading = effect.rateLimit;
        if (reading) call(() => options.onRateLimit?.(reading));
      },
      busy: () => reader.toolsInFlight > 0,
      onSpawn: (info) => call(() => options.onSpawn?.(info)),
    },
    now,
  );
  await Promise.allSettled([...pending]);
  const hookError = result.hookError ?? callbackError;
  return {
    ...result,
    ...(hookError === undefined ? {} : { hookError }),
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
  };
}

export function judgeClaudeRun(report: ClaudeCodeRunReport, delivery?: DeliveryCheck): RunVerdict {
  return judgeRun(claudeRunFacts(report), delivery);
}
