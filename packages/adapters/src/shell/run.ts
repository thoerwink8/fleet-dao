// 接口外壳：命令行够不到的模型，用一个最小的「读写文件 + 跑命令」循环直连它的接口（OpenAI 兼容或 Anthropic 格式）。
// 循环在引擎进程里：发对话 → 模型要调工具就在工作树里做（放进 scope 时以会话用户的身份做）→ 把结果接回去 → 直到它说完。
// 接口密钥只在这里发请求用，不进报告、不进子进程环境。没有服务端会话：续跑就是把上一轮的对话记录带回来。
// 生产配置下必须给 cgroup（工具以会话用户的身份做），不给就拒起（见 tools.ts）。
// 花钱红线：按量计费的接口不许真跑；这一轮没有已确认在套餐内的接口，所以只有假接口的测试（见 PR）。

import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ProgressEvent } from '@fleet-dao/shared';
import { CallbackGate } from '../cli-run.ts';
import { buildSessionEnv, type SessionEnvInput } from '../env.ts';
import type { RunFacts, RunSummary } from '../judge.ts';
import type { CgroupScope } from '../procs.ts';
import { cleanTestCommands, cut, progressEvent, str, testRun } from '../stream-kit.ts';
import type { FilePayload, KillReason, SayPayload, TestPayload, ToolAction, ToolPayload } from '../types.ts';
import { createHost, SHELL_TOOLS, type ShellHost } from './tools.ts';
import {
  finished,
  parseReply,
  requestFor,
  type ShellApi,
  type ShellMessage,
  type ShellReply,
  type ShellToolResult,
  truncated,
} from './wire.ts';

export interface ApiShellSpec {
  runId: string;
  /** 工作树（绝对路径）。 */
  cwd: string;
  prompt: string;
  api: ShellApi;
  /** 给模型的开场说明；不给用默认的（交代工具、工作树、做完怎么收尾）。 */
  system?: string;
  /** 续跑：上一轮报告里的 messages。 */
  history?: readonly ShellMessage[];
  /** 最多来回几轮（一次请求算一轮），默认 60。 */
  maxTurns?: number;
  wallClockMs?: number;
  /** 单次请求的超时，默认 5 分钟。 */
  requestTimeoutMs?: number;
  /** 单条命令的超时，默认 10 分钟。 */
  commandTimeoutMs?: number;
  /** 工具结果最多回给模型多少字，默认 2 万。 */
  maxOutputChars?: number;
  /** 命令的环境（和命令行插头同一套：白名单 + FLEET_*，不许有 GitHub 凭据）。 */
  env: SessionEnvInput;
  cgroup?: CgroupScope;
  testCommands?: readonly string[];
}

export interface ApiShellOptions {
  /** 默认全局 fetch；测试给假的。 */
  fetch?: typeof fetch;
  /** 默认按 spec 建；测试可以整个换掉。 */
  host?: ShellHost;
  onEvent?: (event: ProgressEvent) => unknown;
  signal?: AbortSignal;
  now?: () => Date;
  /** 重试退避的基数，默认 1 秒（测试调小）。 */
  retryBaseMs?: number;
}

export type ApiErrorKind = 'auth' | 'quota' | 'rate_limit' | 'upstream' | 'bad_response' | 'network';

export interface ApiShellReport {
  runId: string;
  model: string;
  format: ShellApi['format'];
  turns: number;
  /** 整份对话记录（含续跑带进来的）：下一轮续跑原样带回来。 */
  messages: ShellMessage[];
  /** 模型最后一次回话。 */
  final?: { text: string; stopReason: string };
  error?: { kind: ApiErrorKind; status?: number; message: string };
  killed?: { reason: KillReason; at: string };
  maxTurnsReached: boolean;
  /** 回包里报的模型（观测值，最后一次的）；接口不报就没有。 */
  observedModel?: string;
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
  toolCalls: number;
  toolErrors: number;
  filesChanged: string[];
  testRuns: TestPayload[];
  startedAt: string;
  endedAt: string;
  wallMs: number;
  hookError?: string;
}

const DEFAULT_SYSTEM = [
  'You are a coding agent working inside a git working tree. Use the tools to read files, write files and run commands.',
  'Paths are relative to the tree root. Make the requested change, run the relevant tests, and commit your work locally with git',
  '(never push). When you are done, reply with a short summary and no tool calls.',
].join(' ');

const ACTIONS: Record<string, ToolAction> = { read_file: 'read', write_file: 'edit', run_command: 'run' };

class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** HTTP 错误按下一步动作分：认证、额度用完（换池）、限流（等）、上游（重试）。 */
export function classifyHttpError(status: number, body: string): ApiErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (
    status === 402 ||
    /insufficient_quota|exceeded your current quota|out of credits|usage limit/i.test(body)
  )
    return 'quota';
  if (status === 429) return 'rate_limit';
  return 'upstream';
}

export async function runApiShell(
  spec: ApiShellSpec,
  options: ApiShellOptions = {},
): Promise<ApiShellReport> {
  if (!spec.prompt.trim()) throw new Error('提示词是空的');
  if (!/^https?:\/\//.test(spec.api.baseUrl)) throw new Error(`接口地址不合法：${spec.api.baseUrl}`);
  if (!spec.api.apiKey) throw new Error('没给接口密钥');
  const dir = await stat(spec.cwd).catch(() => undefined);
  if (!dir?.isDirectory()) throw new Error(`工作目录不存在：${spec.cwd}`);
  if (process.env.VITEST && !options.fetch) throw new Error('测试里不许连真的模型接口：给假的 fetch');

  const now = options.now ?? (() => new Date());
  const doFetch = options.fetch ?? fetch;
  const base = options.retryBaseMs ?? 1_000;
  const t0 = Date.now();
  const gate = new CallbackGate();
  const testCommands = cleanTestCommands(spec.testCommands);
  const host =
    options.host ??
    createHost({
      cwd: spec.cwd,
      runId: spec.runId,
      env: buildSessionEnv(spec.env),
      commandTimeoutMs: spec.commandTimeoutMs ?? 10 * 60_000,
      maxOutputChars: spec.maxOutputChars ?? 20_000,
      ...(spec.cgroup ? { scope: spec.cgroup } : {}),
    });
  const messages: ShellMessage[] = [...(spec.history ?? []), { role: 'user', text: spec.prompt }];
  const files = new Set<string>();
  const report: Omit<ApiShellReport, 'endedAt' | 'wallMs' | 'filesChanged'> = {
    runId: spec.runId,
    model: spec.api.model,
    format: spec.api.format,
    turns: 0,
    messages,
    maxTurnsReached: false,
    usage: {},
    toolCalls: 0,
    toolErrors: 0,
    testRuns: [],
    startedAt: now().toISOString(),
  };
  const emit = (kind: ProgressEvent['kind'], payload: unknown) => {
    const event = progressEvent(spec.runId, now(), kind, payload);
    gate.call(() => options.onEvent?.(event));
  };
  const addUsage = (usage: ShellReply['usage']) => {
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens'] as const) {
      const v = usage[key];
      if (v !== undefined) report.usage[key] = (report.usage[key] ?? 0) + v;
    }
  };
  const wallClock = spec.wallClockMs ?? 2 * 60 * 60_000;
  const maxTurns = spec.maxTurns ?? 60;
  const stopped = (): KillReason | undefined =>
    options.signal?.aborted ? 'aborted' : Date.now() - t0 > wallClock ? 'wall_clock_timeout' : undefined;

  const ask = async (): Promise<ShellReply> => {
    const req = requestFor(spec.api, spec.system ?? DEFAULT_SYSTEM, messages, SHELL_TOOLS);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body),
          signal: AbortSignal.any([
            AbortSignal.timeout(spec.requestTimeoutMs ?? 5 * 60_000),
            ...(options.signal ? [options.signal] : []),
          ]),
        });
      } catch (err) {
        if (options.signal?.aborted) throw err;
        if (attempt < 2) {
          await sleep(base * 2 ** attempt);
          continue;
        }
        throw new ApiError('network', `请求没发出去：${(err as Error).message}`);
      }
      const text = await res.text();
      if (!res.ok) {
        const kind = classifyHttpError(res.status, text);
        const retryable = kind === 'rate_limit' || (kind === 'upstream' && res.status >= 500);
        if (retryable && attempt < 3) {
          const after = Number(res.headers.get('retry-after'));
          await sleep(
            Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1_000 : 2 * base * 2 ** attempt,
          );
          continue;
        }
        // 回包原文可能带请求里的东西：只留前 300 字，密钥不在回包里
        throw new ApiError(kind, `HTTP ${res.status}：${cut(text.trim(), 300)}`, res.status);
      }
      try {
        return parseReply(spec.api.format, JSON.parse(text));
      } catch (err) {
        throw new ApiError('bad_response', `回包认不出：${(err as Error).message}`);
      }
    }
  };

  const useTool = async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ output: string; ok: boolean }> => {
    const path = str(input.path);
    try {
      if (name === 'read_file') {
        if (!path) return { output: 'path is required', ok: false };
        return { output: await host.readFile(path), ok: true };
      }
      if (name === 'write_file') {
        if (!path || typeof input.content !== 'string')
          return { output: 'path and content are required', ok: false };
        await host.writeFile(path, input.content);
        return { output: `wrote ${input.content.length} characters to ${path}`, ok: true };
      }
      if (name === 'run_command') {
        const command = str(input.command);
        if (!command) return { output: 'command is required', ok: false };
        // 叫停要收掉正在跑的命令，不等它跑完（一轮测试可能跑十几分钟）
        const r = await host.run(command, options.signal);
        const head = r.aborted
          ? 'stopped by the engine'
          : r.timedOut
            ? 'timed out and was killed'
            : `exit code ${r.exitCode}`;
        return { output: `${head}\n${r.output}`, ok: !r.aborted && !r.timedOut && r.exitCode === 0 };
      }
      return { output: `unknown tool: ${name}`, ok: false };
    } catch (err) {
      return { output: `error: ${(err as Error).message}`, ok: false };
    }
  };

  try {
    for (;;) {
      const why = stopped();
      if (why) {
        report.killed = { reason: why, at: now().toISOString() };
        break;
      }
      if (report.turns >= maxTurns) {
        report.maxTurnsReached = true;
        break;
      }
      report.turns++;
      const reply = await ask();
      addUsage(reply.usage);
      if (reply.model) report.observedModel = reply.model;
      messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
      if (reply.text.trim())
        emit('say', { text: cut(reply.text.trim(), 2000), source: 'stream' } satisfies SayPayload);
      if (reply.toolCalls.length === 0) {
        report.final = { text: reply.text, stopReason: reply.stopReason };
        break;
      }
      const results: ShellToolResult[] = [];
      for (const call of reply.toolCalls) {
        const action = ACTIONS[call.name] ?? 'other';
        const summary = cut(str(call.input.path) ?? str(call.input.command) ?? '', 200);
        report.toolCalls++;
        emit('tool', {
          phase: 'start',
          toolUseId: call.id,
          name: call.name,
          action,
          summary,
        } satisfies ToolPayload);
        const { output, ok } = await useTool(call.name, call.input);
        if (!ok) report.toolErrors++;
        emit('tool', {
          phase: 'end',
          toolUseId: call.id,
          name: call.name,
          action,
          summary,
          ok,
          ...(ok ? {} : { error: cut(output, 500) }),
        } satisfies ToolPayload);
        const path = str(call.input.path);
        if (ok && call.name === 'write_file' && path) {
          files.add(path);
          emit('file', { path, tool: call.name } satisfies FilePayload);
        }
        const command = call.name === 'run_command' ? str(call.input.command) : undefined;
        const run = command ? testRun(command, ok, testCommands) : undefined;
        if (run) {
          report.testRuns.push(run);
          emit('test', run);
        }
        results.push({ id: call.id, name: call.name, output, isError: !ok });
      }
      messages.push({ role: 'tool', results });
    }
  } catch (err) {
    if (err instanceof ApiError) {
      report.error = {
        kind: err.kind,
        message: err.message,
        ...(err.status === undefined ? {} : { status: err.status }),
      };
    } else if (options.signal?.aborted) {
      report.killed = { reason: 'aborted', at: now().toISOString() };
    } else {
      report.error = { kind: 'network', message: (err as Error).message };
    }
  }
  const hookError = await gate.settle();
  return {
    ...report,
    filesChanged: [...files],
    endedAt: now().toISOString(),
    wallMs: Date.now() - t0,
    ...(hookError === undefined ? {} : { hookError }),
  };
}

export function apiShellFacts(report: ApiShellReport): RunFacts {
  const final = report.final;
  return {
    ...(report.killed ? { killed: report.killed.reason } : {}),
    ...(final
      ? {
          terminal: {
            isError: !finished({ text: final.text, toolCalls: [], stopReason: final.stopReason, usage: {} }),
            detail: truncated({ text: '', toolCalls: [], stopReason: final.stopReason, usage: {} })
              ? `回话被截断（${final.stopReason}）`
              : final.stopReason,
          },
        }
      : report.maxTurnsReached
        ? { terminal: { isError: true, detail: `到了轮数上限（${report.turns} 轮）还没说完` } }
        : {}),
    quotaExhausted: report.error?.kind === 'quota',
    ...(report.error ? { lastWords: `${report.error.kind}：${report.error.message}` } : {}),
  };
}

/** 交给引擎的统一摘要。接口按 token 计费的单价不在这里，花费留给引擎按路由算；没有服务端会话号。 */
export function apiShellSummary(report: ApiShellReport): RunSummary {
  return {
    facts: apiShellFacts(report),
    ...(report.observedModel ? { actualModel: report.observedModel } : {}),
    usage: { ...report.usage },
  };
}
