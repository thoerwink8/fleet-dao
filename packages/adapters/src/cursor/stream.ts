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
  toolSummary as clipToolSummary,
  cut,
  EMPTY_TOOL_RESULT,
  exitCodeText,
  failureText,
  firstStringField,
  num,
  numbers,
  optional,
  parseFrame,
  planFromTodos,
  progressEvent,
  rec,
  relPath,
  resultText,
  searchSummary,
  str,
  TRANSCRIPT_SUMMARY_MAX,
  testRun,
  todoSummary,
  transcriptEntry,
} from '../stream-kit.ts';
import type {
  FilePayload,
  PlanStep,
  SayPayload,
  TestPayload,
  ToolAction,
  ToolPayload,
  TranscriptEntry,
} from '../types.ts';

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
  /** 输出里没报真会话号时的原因。 */
  sessionIdWhy?: string;
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
  /** 这一行第一次读到真会话号（init 或后面任一帧的 session_id / sessionId）。 */
  sessionId?: string;
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
    const summary = { ...this.#s, filesChanged: [...this.#files] };
    if (!summary.sessionId) {
      summary.sessionIdWhy =
        summary.frames === 0
          ? summary.nonJsonLines > 0
            ? 'Cursor 输出没有可解析的 JSON 帧，没读到 session_id'
            : 'Cursor 没有输出帧，没读到 session_id'
          : 'Cursor 输出帧没有 session_id';
    }
    return summary;
  }

  read(raw: string): CursorLineEffect {
    const effect: CursorLineEffect = { events: [], transcript: [], activity: false };
    const line = raw.trim();
    if (!line) return effect;
    const frame = parseFrame(line);
    if (!frame) {
      this.#s.nonJsonLines++;
      this.#s.nonJsonSample ??= cut(line, 200);
      return effect;
    }
    this.#s.frames++;
    this.#noteSession(frame, effect);
    const type = str(frame.type) ?? '(无 type)';
    switch (type) {
      case 'system':
        if (frame.subtype === 'init') {
          const init = {
            ...optional('sessionId', str(frame.session_id) ?? str(frame.sessionId)),
            ...optional('model', str(frame.model)),
          };
          effect.init = init;
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

  #tx(
    effect: CursorLineEffect,
    kind: TranscriptEntry['kind'],
    text: string,
    extra?: Parameters<typeof transcriptEntry>[3],
  ): void {
    effect.transcript?.push(transcriptEntry(this.#now(), kind, text, extra));
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
      this.#tx(effect, 'assistant', text);
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
      const description = key === 'shellToolCall' ? str(args.description) : undefined;
      const callMeta = {
        ...(id ? { callId: id } : {}),
        ...(description ? { description: cut(description, 200) } : {}),
      };
      this.#tx(effect, 'tool_call', toolSummary(key, args, this.#cwd, TRANSCRIPT_SUMMARY_MAX), {
        tool: name,
        ...(Object.keys(callMeta).length > 0 ? { meta: callMeta } : {}),
      });
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
      ...optional('error', ok ? undefined : failureDetail(result, success)),
    } satisfies ToolPayload);
    // 改文件的结果直接带 linesAdded / linesRemoved
    const added = ok && kind?.edits ? num(success?.linesAdded) : undefined;
    const removed = ok && kind?.edits ? num(success?.linesRemoved) : undefined;
    const resultMeta = {
      ...(id ? { callId: id } : {}),
      ...(added !== undefined && removed !== undefined ? { added, removed } : {}),
    };
    this.#tx(effect, 'tool_result', resultTextOf(result, success, ok), {
      tool: name,
      ok,
      ...(Object.keys(resultMeta).length > 0 ? { meta: resultMeta } : {}),
    });
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
    const done = this.#s.result;
    this.#tx(
      effect,
      'result',
      done.text ?? [done.subtype, done.isError ? '报错' : ''].filter((x) => x).join(' · '),
      { ok: !done.isError },
    );
  }

  /** 真会话号在 init、终帧，或中间任一帧（session_id，也认 sessionId）。空串不算。先到的那个为准。 */
  #noteSession(frame: Record<string, unknown>, effect: CursorLineEffect): void {
    if (this.#s.sessionId) return;
    const id = str(frame.session_id) ?? str(frame.sessionId);
    if (!id) return;
    this.#s.sessionId = id;
    effect.sessionId = id;
  }
}

/** 这一家的字段映射；截断走 stream-kit 的 toolSummary。 */
function toolSummary(key: string, args: Record<string, unknown>, cwd: string, max?: number): string {
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
    case 'grepToolCall':
      text = searchSummary(pick('pattern'), pick('path'), cwd);
      break;
    case 'updateTodosToolCall':
      text = todoSummary(args.todos);
      break;
    default:
      text =
        pick('pattern') ??
        pick('globPattern') ??
        pick('query') ??
        pick('url') ??
        pick('toolName') ??
        firstStringField(args);
  }
  return clipToolSummary(text, max);
}

/** 读到的内容是字符串就走公共 resultText；空串当没有，接着看下一个字段（和 str 一样）。 */
function resultContent(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  return resultText(content) || undefined;
}

/** 工具结果给人看的正文：失败照 failureDetail；成功取命令输出、读到的内容或工具自己的话，都没有就写（无输出）。 */
function resultTextOf(
  result: Record<string, unknown>,
  success: Record<string, unknown> | undefined,
  ok: boolean,
): string {
  if (!ok) return failureDetail(result, success);
  const out =
    str(success?.stdout)?.trim() ??
    resultContent(success?.content) ??
    str(success?.message) ??
    str(success?.diffString) ??
    str(success?.interleavedOutput)?.trim();
  return out ?? EMPTY_TOOL_RESULT;
}

/** 失败原因按这一家的字段拼好，截断交给 failureText。 */
function failureDetail(
  result: Record<string, unknown>,
  success: Record<string, unknown> | undefined,
): string {
  if (success) {
    // 命令跑了但退出码不是 0：给退出码和 stderr
    const stderr = str(success.stderr)?.trim();
    const code = exitCodeText(num(success.exitCode));
    return failureText(stderr ? `${code}：${stderr}` : code);
  }
  const [kind, detail] = Object.entries(result)[0] ?? ['没有结果', undefined];
  const message = str(rec(detail)?.message) ?? str(rec(detail)?.error) ?? str(detail);
  return failureText(message ? `${kind}：${message}` : kind);
}
