// 读 cursor-agent 无头模式（-p --output-format stream-json）的过程记录，一行一帧。
// 形状以 packages/adapters/test/fixtures/cursor-agent 里的真跑记录为准（2026.09.23，法国 VPS）；认不出的帧只计数。
// 几个看记录才知道的事：
// - init.model 是界面名（Auto、Grok 4.6 High Fast），不是模型 id：流里没有「实际用的哪个模型」；
// - 工具调用是 tool_call 帧，started / completed 各一帧，工具种类是 tool_call 里唯一的 xxxToolCall 键；
// - 命令的退出码在 shellToolCall.result.success.exitCode；改文件是 editToolCall，成功后给 path 和增删行数；
// - 待办清单是 updateTodosToolCall：增量更新（merge），completed 帧的 result.success.todos 才是整张单子；
// - 终帧 result 的 usage 只算这一轮（续会话的那轮 input 只有几百），没有花费。
import type { ProgressEvent, ProgressKind } from '@fleet-dao/shared';
import type { LineEffect } from '../cli-run.ts';
import {
  cleanTestCommands,
  cut,
  num,
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

export interface CursorStreamOptions {
  runId: string;
  cwd: string;
  testCommands?: readonly string[];
  now?: () => Date;
}

/** 终帧里没有的字段就不带（读不到不记成 0）。 */
export interface CursorUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CursorResult {
  isError: boolean;
  subtype?: string;
  text?: string;
  durationMs?: number;
  requestId?: string;
  /** 这一轮的 token。 */
  usage?: CursorUsage;
}

export interface CursorStreamSummary {
  sessionId?: string;
  /** init 帧里的模型界面名。 */
  initModel?: string;
  startedWork: boolean;
  toolCalls: number;
  toolErrors: number;
  filesChanged: string[];
  testRuns: TestPayload[];
  /** 最近一次读到的待办清单。 */
  plan?: PlanStep[];
  result?: CursorResult;
  frames: number;
  nonJsonLines: number;
  nonJsonSample?: string;
  unknownFrames: Record<string, number>;
  /** 认不出的工具种类（xxxToolCall 键），按键计数：cursor 加了新工具时一眼能看到。 */
  unknownTools: Record<string, number>;
}

export interface CursorLineEffect extends LineEffect {
  init?: { sessionId?: string; model?: string };
}

interface ToolKind {
  action: ToolAction;
  /** 成功就意味着改了 path 指的文件。 */
  edits?: boolean;
}

const TOOL_KINDS: Record<string, ToolKind> = {
  readToolCall: { action: 'read' },
  editToolCall: { action: 'edit', edits: true },
  deleteToolCall: { action: 'edit', edits: true },
  shellToolCall: { action: 'run' },
  grepToolCall: { action: 'search' },
  globToolCall: { action: 'search' },
  lsToolCall: { action: 'search' },
  semSearchToolCall: { action: 'search' },
  codebaseSearchToolCall: { action: 'search' },
  fileSearchToolCall: { action: 'search' },
  webSearchToolCall: { action: 'web' },
  webFetchToolCall: { action: 'web' },
  fetchToolCall: { action: 'web' },
  updateTodosToolCall: { action: 'other' },
  readTodosToolCall: { action: 'other' },
  getMcpToolsToolCall: { action: 'other' },
  mcpToolCall: { action: 'other' },
  taskToolCall: { action: 'agent' },
};

interface PendingTool {
  key: string;
  args: Record<string, unknown>;
}

export class CursorStreamReader {
  readonly #runId: string;
  readonly #cwd: string;
  readonly #testCommands: string[];
  readonly #now: () => Date;
  readonly #pending = new Map<string, PendingTool>();
  readonly #files = new Set<string>();
  readonly #s: CursorStreamSummary = {
    startedWork: false,
    toolCalls: 0,
    toolErrors: 0,
    filesChanged: [],
    testRuns: [],
    frames: 0,
    nonJsonLines: 0,
    unknownFrames: {},
    unknownTools: {},
  };

  constructor(options: CursorStreamOptions) {
    this.#runId = options.runId;
    this.#cwd = options.cwd;
    this.#testCommands = cleanTestCommands(options.testCommands);
    this.#now = options.now ?? (() => new Date());
  }

  get toolsInFlight(): number {
    return this.#pending.size;
  }

  summary(): CursorStreamSummary {
    return { ...this.#s, filesChanged: [...this.#files] };
  }

  read(raw: string): CursorLineEffect {
    const effect: CursorLineEffect = { events: [], activity: false };
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
      case 'system':
        if (frame.subtype === 'init') {
          const init = {
            ...optional('sessionId', str(frame.session_id)),
            ...optional('model', str(frame.model)),
          };
          effect.init = init;
          if (init.sessionId) this.#s.sessionId = init.sessionId;
          if (init.model) this.#s.initModel = init.model;
        }
        break;
      case 'user':
        // 我们发的提示词原样回显
        break;
      case 'thinking':
        effect.activity = true;
        break;
      case 'assistant':
        this.#assistant(frame, effect);
        break;
      case 'tool_call':
        this.#toolCall(frame, effect);
        break;
      case 'result':
        this.#result(frame, effect);
        break;
      default:
        this.#s.unknownFrames[type] = (this.#s.unknownFrames[type] ?? 0) + 1;
    }
    return effect;
  }

  #emit(effect: CursorLineEffect, kind: ProgressKind, payload: unknown): void {
    effect.events.push(progressEvent(this.#runId, this.#now(), kind, payload) satisfies ProgressEvent);
  }

  #assistant(frame: Record<string, unknown>, effect: CursorLineEffect): void {
    effect.activity = true;
    const blocks = rec(frame.message)?.content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      const text = str(rec(block)?.text)?.trim();
      if (rec(block)?.type !== 'text' || !text) continue;
      this.#s.startedWork = true;
      this.#emit(effect, 'say', { text: cut(text, 2000), source: 'stream' } satisfies SayPayload);
    }
  }

  #toolCall(frame: Record<string, unknown>, effect: CursorLineEffect): void {
    effect.activity = true;
    const call = rec(frame.tool_call) ?? {};
    const key = Object.keys(call).find((k) => k.endsWith('ToolCall')) ?? 'unknownToolCall';
    const body = rec(call[key]) ?? {};
    const args = rec(body.args) ?? {};
    const id = str(frame.call_id) ?? str(call.toolCallId) ?? '';
    const kind = TOOL_KINDS[key];
    if (!kind) this.#s.unknownTools[key] = (this.#s.unknownTools[key] ?? 0) + 1;
    const name = key.replace(/ToolCall$/, '');
    const action = kind?.action ?? 'other';
    const summary = toolSummary(key, args, this.#cwd);
    if (frame.subtype === 'started') {
      this.#pending.set(id, { key, args });
      this.#s.startedWork = true;
      this.#s.toolCalls++;
      this.#emit(effect, 'tool', {
        phase: 'start',
        toolUseId: id,
        name,
        action,
        summary,
        ...optional('description', key === 'shellToolCall' ? str(args.description) : undefined),
      } satisfies ToolPayload);
      return;
    }
    if (frame.subtype !== 'completed') return;
    this.#pending.delete(id);
    const result = rec(body.result) ?? {};
    const success = rec(result.success);
    const exitCode = num(success?.exitCode);
    const ok = success !== undefined && (key !== 'shellToolCall' || exitCode === 0);
    if (!ok) this.#s.toolErrors++;
    this.#emit(effect, 'tool', {
      phase: 'end',
      toolUseId: id,
      name,
      action,
      summary,
      ok,
      ...optional('error', ok ? undefined : failureText(result, success)),
    } satisfies ToolPayload);
    if (ok && kind?.edits) {
      const path = str(success?.path) ?? str(args.path);
      if (path) {
        const rel = relPath(path, this.#cwd);
        this.#files.add(rel);
        this.#emit(effect, 'file', { path: rel, tool: name } satisfies FilePayload);
      }
    }
    if (key === 'updateTodosToolCall' && success) {
      const todos = Array.isArray(success.todos) ? success.todos : [];
      const plan = planFromTodos(
        todos.map((t) => ({
          ...optional('title', str(rec(t)?.content)),
          ...optional('status', str(rec(t)?.status)),
        })),
      );
      if (plan) {
        this.#s.plan = plan.steps;
        this.#emit(effect, 'plan', plan);
      }
    }
    const command = key === 'shellToolCall' ? str(args.command) : undefined;
    const run = command
      ? testRun(
          command,
          ok,
          this.#testCommands,
          args.isBackground === true ? '放到后台跑，命令返回时测试还没跑完' : undefined,
        )
      : undefined;
    if (run) {
      this.#s.testRuns.push(run);
      this.#emit(effect, 'test', run);
    }
  }

  #result(frame: Record<string, unknown>, effect: CursorLineEffect): void {
    effect.activity = true;
    const usage = rec(frame.usage);
    this.#s.result = {
      isError: frame.is_error === true,
      ...optional('subtype', str(frame.subtype)),
      ...optional('text', str(frame.result)),
      ...optional('durationMs', num(frame.duration_ms)),
      ...optional('requestId', str(frame.request_id)),
      ...(usage
        ? {
            usage: numbers(usage, {
              inputTokens: 'inputTokens',
              outputTokens: 'outputTokens',
              cacheReadTokens: 'cacheReadTokens',
              cacheWriteTokens: 'cacheWriteTokens',
            }),
          }
        : {}),
    };
    const sessionId = str(frame.session_id);
    if (sessionId && !this.#s.sessionId) this.#s.sessionId = sessionId;
  }
}

function toolSummary(key: string, args: Record<string, unknown>, cwd: string): string {
  const pick = (k: string) => str(args[k]);
  let text: string | undefined;
  switch (key) {
    case 'readToolCall':
    case 'editToolCall':
    case 'deleteToolCall':
      text = relPath(pick('path') ?? '', cwd);
      break;
    case 'shellToolCall':
      text = pick('command');
      break;
    case 'grepToolCall': {
      const where = pick('path');
      text = [pick('pattern'), where ? relPath(where, cwd) : undefined].filter((x) => x).join(' @ ');
      break;
    }
    case 'updateTodosToolCall':
      text = `待办 ${Array.isArray(args.todos) ? args.todos.length : 0} 条`;
      break;
    default:
      text =
        pick('pattern') ??
        pick('globPattern') ??
        pick('query') ??
        pick('url') ??
        pick('toolName') ??
        Object.values(args).find((v): v is string => typeof v === 'string');
  }
  return cut(text ?? '', 200);
}

function failureText(result: Record<string, unknown>, success: Record<string, unknown> | undefined): string {
  if (success) {
    // 命令跑了但退出码不是 0：给退出码和 stderr
    const stderr = str(success.stderr)?.trim();
    return cut(`退出码 ${num(success.exitCode) ?? '?'}${stderr ? `：${stderr}` : ''}`, 500);
  }
  const [kind, detail] = Object.entries(result)[0] ?? ['没有结果', undefined];
  const message = str(rec(detail)?.message) ?? str(rec(detail)?.error) ?? str(detail);
  return cut(message ? `${kind}：${message}` : kind, 500);
}
