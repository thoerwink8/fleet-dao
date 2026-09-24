// 读 codex exec --json 的过程记录（JSONL），一行一帧。
// 形状以 packages/adapters/test/fixtures/codex 为准：codex-cli 0.156.1 在法国 VPS 上真起、对着本机假上游跑出来的
// （零花费；按量计费的真上游这一轮不跑）。几个看记录才知道的事：
// - thread.started 可能连打两遍，thread_id 就是续跑用的会话号；
// - 命令是 item.started / item.completed 的 command_execution，command 被包成 `/bin/bash -lc '…'`，
//   失败时 status=failed、exit_code 是真退出码；改文件是 file_change（changes 里有路径和 add / update / delete）；
// - 0.156 的「代码模式」下没有 update_plan 工具，步骤清单（todo_list）这一轮没见到，按源码的形状认；
// - turn.completed 的 usage 是整个会话（thread）的累计值：续跑那轮 input 包含前几轮，本轮用量要按上一轮求差；
//   input_tokens 含命中缓存的部分（OpenAI 的口径），没命中的 = input_tokens − cached_input_tokens；
// - 上游出错时先打 error「Reconnecting... n/5」重试，重试完再 error + turn.failed，进程退出 1；
//   上游不通时可能一直重连不退（CX-04）：error 帧不算干活，靠停滞判定收。
import type { ProgressEvent, ProgressKind } from '@fleet-dao/shared';
import type { LineEffect } from '../cli-run.ts';
import {
  cleanTestCommands,
  cut,
  numbers,
  optional,
  parseFrame,
  planFromTodos,
  progressEvent,
  rec,
  relPath,
  str,
  testRun,
} from '../stream-kit.ts';
import type { FilePayload, PlanStep, SayPayload, TestPayload, ToolAction, ToolPayload } from '../types.ts';

export interface CodexStreamOptions {
  runId: string;
  cwd: string;
  testCommands?: readonly string[];
  now?: () => Date;
}

/** turn.completed 的 usage：整个会话的累计值。没有的字段不带。 */
export interface CodexUsage {
  /** 含命中缓存的部分。 */
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface CodexStreamSummary {
  /** thread_id：续跑用。 */
  sessionId?: string;
  startedWork: boolean;
  toolCalls: number;
  toolErrors: number;
  filesChanged: string[];
  testRuns: TestPayload[];
  plan?: PlanStep[];
  /** turn.completed / turn.failed。 */
  turn?: { ok: boolean; error?: string; sessionUsage?: CodexUsage };
  /** error 帧的原文（含 Reconnecting…）。 */
  errors: string[];
  reconnects: number;
  frames: number;
  nonJsonLines: number;
  nonJsonSample?: string;
  unknownFrames: Record<string, number>;
  unknownItems: Record<string, number>;
}

const ITEM_TOOLS: Record<string, { name: string; action: ToolAction }> = {
  command_execution: { name: 'exec_command', action: 'run' },
  file_change: { name: 'apply_patch', action: 'edit' },
  mcp_tool_call: { name: 'mcp', action: 'other' },
  web_search: { name: 'web_search', action: 'web' },
};

export class CodexStreamReader {
  readonly #runId: string;
  readonly #cwd: string;
  readonly #testCommands: string[];
  readonly #now: () => Date;
  readonly #pending = new Set<string>();
  readonly #files = new Set<string>();
  readonly #s: CodexStreamSummary = {
    startedWork: false,
    toolCalls: 0,
    toolErrors: 0,
    filesChanged: [],
    testRuns: [],
    errors: [],
    reconnects: 0,
    frames: 0,
    nonJsonLines: 0,
    unknownFrames: {},
    unknownItems: {},
  };

  constructor(options: CodexStreamOptions) {
    this.#runId = options.runId;
    this.#cwd = options.cwd;
    this.#testCommands = cleanTestCommands(options.testCommands);
    this.#now = options.now ?? (() => new Date());
  }

  get toolsInFlight(): number {
    return this.#pending.size;
  }

  summary(): CodexStreamSummary {
    return { ...this.#s, filesChanged: [...this.#files], errors: [...this.#s.errors] };
  }

  read(raw: string): LineEffect & { sessionId?: string } {
    const effect: LineEffect & { sessionId?: string } = { events: [], activity: false };
    const line = raw.trim();
    if (!line) return effect;
    const frame = parseFrame(line);
    if (!frame) {
      this.#s.nonJsonLines++;
      this.#s.nonJsonSample ??= cut(line, 200);
      return effect;
    }
    this.#s.frames++;
    const type = str(frame.type) ?? '(无 type)';
    switch (type) {
      case 'thread.started': {
        const id = str(frame.thread_id);
        if (id) {
          this.#s.sessionId ??= id;
          effect.sessionId = id;
        }
        break;
      }
      case 'turn.started':
        effect.activity = true;
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        effect.activity = true;
        this.#item(type, rec(frame.item) ?? {}, effect);
        break;
      case 'turn.completed':
        effect.activity = true;
        this.#s.turn = { ok: true, ...optional('sessionUsage', usageOf(rec(frame.usage))) };
        break;
      case 'turn.failed':
        this.#s.turn = {
          ok: false,
          error: cut(str(rec(frame.error)?.message) ?? JSON.stringify(frame.error ?? {}), 1000),
        };
        break;
      case 'error': {
        const message = cut(str(frame.message) ?? JSON.stringify(frame), 1000);
        this.#s.errors.push(message);
        if (/^Reconnecting\.\.\./.test(message)) this.#s.reconnects++;
        break;
      }
      default:
        this.#s.unknownFrames[type] = (this.#s.unknownFrames[type] ?? 0) + 1;
    }
    return effect;
  }

  #emit(effect: LineEffect, kind: ProgressKind, payload: unknown): void {
    effect.events.push(progressEvent(this.#runId, this.#now(), kind, payload) satisfies ProgressEvent);
  }

  #item(phase: string, item: Record<string, unknown>, effect: LineEffect): void {
    const kind = str(item.type) ?? '(无 type)';
    const id = str(item.id) ?? '';
    if (kind === 'agent_message') {
      const text = str(item.text)?.trim();
      if (phase === 'item.completed' && text) {
        this.#s.startedWork = true;
        this.#emit(effect, 'say', { text: cut(text, 2000), source: 'stream' } satisfies SayPayload);
      }
      return;
    }
    if (kind === 'reasoning') return;
    if (kind === 'todo_list') {
      const items = Array.isArray(item.items) ? item.items : [];
      const plan = planFromTodos(
        items.map((t) => ({
          ...optional('title', str(rec(t)?.text)),
          status: rec(t)?.completed === true ? 'completed' : 'pending',
        })),
      );
      if (plan) {
        this.#s.plan = plan.steps;
        this.#emit(effect, 'plan', plan);
      }
      return;
    }
    if (kind === 'error') {
      this.#s.errors.push(cut(str(item.message) ?? '', 1000));
      return;
    }
    const tool = ITEM_TOOLS[kind];
    if (!tool) {
      this.#s.unknownItems[kind] = (this.#s.unknownItems[kind] ?? 0) + 1;
      return;
    }
    const name =
      kind === 'mcp_tool_call' ? `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? '?'}` : tool.name;
    const summary = itemSummary(kind, item, this.#cwd);
    if (phase === 'item.started') {
      this.#pending.add(id);
      this.#s.startedWork = true;
      this.#s.toolCalls++;
      this.#emit(effect, 'tool', {
        phase: 'start',
        toolUseId: id,
        name,
        action: tool.action,
        summary,
      } satisfies ToolPayload);
      return;
    }
    if (phase !== 'item.completed') return;
    if (!this.#pending.delete(id)) {
      // 没见过 started 的（例如 web_search 只报一次 completed）也算一次调用
      this.#s.startedWork = true;
      this.#s.toolCalls++;
    }
    const status = str(item.status);
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
    const ok =
      (status === undefined || status === 'completed') &&
      (kind !== 'command_execution' || exitCode === 0) &&
      !(kind === 'mcp_tool_call' && item.error);
    if (!ok) this.#s.toolErrors++;
    this.#emit(effect, 'tool', {
      phase: 'end',
      toolUseId: id,
      name,
      action: tool.action,
      summary,
      ok,
      ...optional('error', ok ? undefined : failureText(kind, item)),
    } satisfies ToolPayload);
    if (ok && kind === 'file_change') {
      for (const change of Array.isArray(item.changes) ? item.changes : []) {
        const path = str(rec(change)?.path);
        if (!path) continue;
        const rel = relPath(path, this.#cwd);
        this.#files.add(rel);
        this.#emit(effect, 'file', { path: rel, tool: name } satisfies FilePayload);
      }
    }
    if (kind === 'command_execution') {
      const run = testRun(unwrapShell(str(item.command) ?? ''), ok, this.#testCommands);
      if (run) {
        this.#s.testRuns.push(run);
        this.#emit(effect, 'test', run);
      }
    }
  }
}

function usageOf(usage: Record<string, unknown> | undefined): CodexUsage | undefined {
  if (!usage) return undefined;
  return numbers(usage, {
    inputTokens: 'input_tokens',
    cachedInputTokens: 'cached_input_tokens',
    cacheWriteInputTokens: 'cache_write_input_tokens',
    outputTokens: 'output_tokens',
    reasoningOutputTokens: 'reasoning_output_tokens',
  });
}

/** `/bin/bash -lc 'git commit -m "x"'` → `git commit -m "x"`：认测试、给驾驶舱看的都是模型写的那条命令。 */
export function unwrapShell(command: string): string {
  const m = /^(?:\/usr)?\/bin\/(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command.trim());
  return m?.[1] !== undefined ? m[1].replace(/'\\''/g, "'") : command;
}

function itemSummary(kind: string, item: Record<string, unknown>, cwd: string): string {
  switch (kind) {
    case 'command_execution':
      return cut(unwrapShell(str(item.command) ?? ''), 200);
    case 'file_change': {
      const paths = (Array.isArray(item.changes) ? item.changes : [])
        .map((c) => {
          const path = str(rec(c)?.path);
          return path ? `${relPath(path, cwd)}（${str(rec(c)?.kind) ?? '?'}）` : undefined;
        })
        .filter((p) => p);
      return cut(paths.join('、'), 200);
    }
    case 'web_search':
      return cut(str(item.query) ?? '', 200);
    default:
      return cut(str(item.tool) ?? '', 200);
  }
}

function failureText(kind: string, item: Record<string, unknown>): string {
  if (kind === 'command_execution') {
    const output = str(item.aggregated_output)?.trim();
    const exit =
      typeof item.exit_code === 'number' ? `退出码 ${item.exit_code}` : (str(item.status) ?? '失败');
    return cut(output ? `${exit}：${output}` : exit, 500);
  }
  const error = rec(item.error);
  return cut(str(error?.message) ?? str(item.status) ?? '失败', 500);
}

/**
 * 本轮用量 = 本轮 turn.completed 的累计值 − 上一轮的（新会话没有上一轮）。有一边没读到就是没查成，返回 undefined。
 * 没命中缓存的输入 = input − cached。
 */
export function codexUsageOfThisRun(
  current: CodexUsage | undefined,
  previous?: CodexUsage,
):
  | { inputTokens?: number; cacheReadTokens?: number; outputTokens?: number; reasoningTokens?: number }
  | undefined {
  if (!current) return undefined;
  const minus = (a: number | undefined, b: number | undefined, isResume: boolean) =>
    a === undefined ? undefined : isResume ? (b === undefined ? undefined : Math.max(0, a - b)) : a;
  const resume = previous !== undefined;
  const input = minus(current.inputTokens, previous?.inputTokens, resume);
  const cached = minus(current.cachedInputTokens, previous?.cachedInputTokens, resume);
  const output = minus(current.outputTokens, previous?.outputTokens, resume);
  const reasoning = minus(current.reasoningOutputTokens, previous?.reasoningOutputTokens, resume);
  return {
    ...optional(
      'inputTokens',
      input !== undefined && cached !== undefined ? Math.max(0, input - cached) : undefined,
    ),
    ...optional('cacheReadTokens', cached),
    ...optional('outputTokens', output),
    ...optional('reasoningTokens', reasoning),
  };
}
