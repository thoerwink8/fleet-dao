// 读 Grok 命令行无头模式（--output-format streaming-json）的过程记录，一行一帧。
// 形状以 packages/adapters/test/fixtures/grok 里的真跑记录为准（1.0.41，法国 VPS，grok.com 订阅）；认不出的帧只计数。
// 几个看记录才知道的事：
// - text / thought 是一字一帧的增量，拼起来才是一句话：遇到别的帧再把攒下的正文作为一条 say 发出去；
// - 工具是 tool_call（pending）+ 若干 tool_call_update（status 为 null / in_progress 的是中间态），completed / failed 才是结束；
// - 命令的退出码在 rawOutput.exit_code（type=Bash）；grep 没匹配时 exit_code=1，那不是失败；
// - 待办清单有专门的 plan 帧，entries 是整张单子；
// - end 永远是最后一行：sessionId、这一轮的 usage、total_cost_usd（只算这一轮，续跑那轮只有几分钱）、modelUsage 的键就是实际模型。
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

export interface GrokStreamOptions {
  runId: string;
  cwd: string;
  testCommands?: readonly string[];
  now?: () => Date;
}

/** 终帧里没有的字段就不带（读不到不记成 0）。 */
export interface GrokUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface GrokEnd {
  stopReason?: string;
  sessionId?: string;
  numTurns?: number;
  /** 这一轮的花费（grok.com 订阅下照样报一个数，不代表账单多了这一笔）。 */
  costUsd?: number;
  usage?: GrokUsage;
  /** modelUsage 的键：实际用的模型。 */
  models: string[];
}

export interface GrokStreamSummary {
  startedWork: boolean;
  toolCalls: number;
  toolErrors: number;
  filesChanged: string[];
  testRuns: TestPayload[];
  plan?: PlanStep[];
  /** error 帧的原文。 */
  errors: string[];
  maxTurnsReached: boolean;
  modelCalls: number;
  end?: GrokEnd;
  frames: number;
  nonJsonLines: number;
  nonJsonSample?: string;
  unknownFrames: Record<string, number>;
}

const KIND_ACTIONS: Record<string, ToolAction> = {
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  execute: 'run',
  search: 'search',
  list: 'search',
  fetch: 'web',
  plan: 'other',
  think: 'other',
  other: 'other',
};

const EDIT_KINDS = new Set(['edit', 'delete', 'move']);

interface PendingTool {
  name: string;
  kind: string;
  input: Record<string, unknown>;
}

export class GrokStreamReader {
  readonly #runId: string;
  readonly #cwd: string;
  readonly #testCommands: string[];
  readonly #now: () => Date;
  readonly #pending = new Map<string, PendingTool>();
  readonly #files = new Set<string>();
  #text = '';
  readonly #s: GrokStreamSummary = {
    startedWork: false,
    toolCalls: 0,
    toolErrors: 0,
    filesChanged: [],
    testRuns: [],
    errors: [],
    maxTurnsReached: false,
    modelCalls: 0,
    frames: 0,
    nonJsonLines: 0,
    unknownFrames: {},
  };

  constructor(options: GrokStreamOptions) {
    this.#runId = options.runId;
    this.#cwd = options.cwd;
    this.#testCommands = cleanTestCommands(options.testCommands);
    this.#now = options.now ?? (() => new Date());
  }

  get toolsInFlight(): number {
    return this.#pending.size;
  }

  summary(): GrokStreamSummary {
    return { ...this.#s, filesChanged: [...this.#files], errors: [...this.#s.errors] };
  }

  /** 进程结束时调用：没遇到下一帧的正文也要发出去。 */
  flush(): ProgressEvent[] {
    const effect: LineEffect = { events: [], activity: false };
    this.#flushText(effect);
    return effect.events;
  }

  read(raw: string): LineEffect {
    const effect: LineEffect = { events: [], activity: false };
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
    if (type === 'text') {
      effect.activity = true;
      this.#text += typeof frame.data === 'string' ? frame.data : '';
      return effect;
    }
    if (type === 'thought') {
      effect.activity = true;
      return effect;
    }
    this.#flushText(effect);
    switch (type) {
      case 'tool_call':
        this.#toolCall(frame, effect);
        break;
      case 'tool_call_update':
        this.#toolUpdate(frame, effect);
        break;
      case 'plan':
        this.#plan(frame, effect);
        break;
      case 'usage':
        effect.activity = true;
        this.#s.modelCalls++;
        break;
      case 'end':
        this.#end(frame, effect);
        break;
      case 'error':
        this.#s.errors.push(cut(str(frame.message) ?? JSON.stringify(frame), 1000));
        break;
      case 'max_turns_reached':
        this.#s.maxTurnsReached = true;
        break;
      case 'available_commands':
        break;
      default:
        this.#s.unknownFrames[type] = (this.#s.unknownFrames[type] ?? 0) + 1;
    }
    return effect;
  }

  #emit(effect: LineEffect, kind: ProgressKind, payload: unknown): void {
    effect.events.push(progressEvent(this.#runId, this.#now(), kind, payload));
  }

  #flushText(effect: LineEffect): void {
    const text = this.#text.trim();
    this.#text = '';
    if (!text) return;
    this.#s.startedWork = true;
    this.#emit(effect, 'say', { text: cut(text, 2000), source: 'stream' } satisfies SayPayload);
  }

  #toolCall(frame: Record<string, unknown>, effect: LineEffect): void {
    effect.activity = true;
    const id = str(frame.toolCallId) ?? '';
    const tool: PendingTool = {
      name: str(frame.toolName) ?? str(frame.title) ?? 'unknown',
      kind: str(frame.kind) ?? 'other',
      input: rec(frame.rawInput) ?? {},
    };
    this.#pending.set(id, tool);
    this.#s.startedWork = true;
    this.#s.toolCalls++;
    this.#emit(effect, 'tool', {
      phase: 'start',
      toolUseId: id,
      name: tool.name,
      action: KIND_ACTIONS[tool.kind] ?? 'other',
      summary: toolSummary(tool, this.#cwd),
      ...optional('description', tool.kind === 'execute' ? str(tool.input.description) : undefined),
    } satisfies ToolPayload);
  }

  #toolUpdate(frame: Record<string, unknown>, effect: LineEffect): void {
    effect.activity = true;
    const status = str(frame.status);
    if (!status || status === 'pending' || status === 'in_progress') return;
    const id = str(frame.toolCallId) ?? '';
    const tool = this.#pending.get(id);
    if (!tool) return;
    this.#pending.delete(id);
    const output = rec(frame.rawOutput) ?? {};
    const isShell = str(output.type) === 'Bash';
    const exitCode = num(output.exit_code);
    const ok =
      status === 'completed' &&
      !(isShell && (exitCode !== 0 || output.timed_out === true || Boolean(output.signal)));
    if (!ok) this.#s.toolErrors++;
    this.#emit(effect, 'tool', {
      phase: 'end',
      toolUseId: id,
      name: tool.name,
      action: KIND_ACTIONS[tool.kind] ?? 'other',
      summary: toolSummary(tool, this.#cwd),
      ok,
      ...optional('error', ok ? undefined : failureText(status, output, frame.content)),
    } satisfies ToolPayload);
    if (ok && EDIT_KINDS.has(tool.kind)) {
      for (const path of editedPaths(tool, output, frame.content)) {
        const rel = relPath(path, this.#cwd);
        if (this.#files.has(rel)) continue;
        this.#files.add(rel);
        this.#emit(effect, 'file', { path: rel, tool: tool.name } satisfies FilePayload);
      }
    }
    const command = tool.kind === 'execute' ? str(tool.input.command) : undefined;
    const run = command ? testRun(command, ok, this.#testCommands) : undefined;
    if (run) {
      this.#s.testRuns.push(run);
      this.#emit(effect, 'test', run);
    }
  }

  #plan(frame: Record<string, unknown>, effect: LineEffect): void {
    effect.activity = true;
    const entries = Array.isArray(frame.entries) ? frame.entries : [];
    const plan = planFromTodos(
      entries.map((e) => ({
        ...optional('title', str(rec(e)?.content)),
        ...optional('status', str(rec(e)?.status)),
      })),
    );
    if (!plan) return;
    this.#s.plan = plan.steps;
    this.#emit(effect, 'plan', plan);
  }

  #end(frame: Record<string, unknown>, effect: LineEffect): void {
    effect.activity = true;
    const usage = rec(frame.usage);
    this.#s.end = {
      ...optional('stopReason', str(frame.stopReason)),
      ...optional('sessionId', str(frame.sessionId)),
      ...optional('numTurns', num(frame.num_turns)),
      ...optional('costUsd', num(frame.total_cost_usd)),
      ...(usage
        ? {
            usage: numbers(usage, {
              inputTokens: 'input_tokens',
              outputTokens: 'output_tokens',
              cacheReadTokens: 'cache_read_input_tokens',
              cacheWriteTokens: 'cache_creation_input_tokens',
              reasoningTokens: 'reasoning_tokens',
            }),
          }
        : {}),
      models: Object.keys(rec(frame.modelUsage) ?? {}),
    };
  }
}

function toolSummary(tool: PendingTool, cwd: string): string {
  const pick = (k: string) => str(tool.input[k]);
  const path = pick('file_path') ?? pick('target_file') ?? pick('target_directory') ?? pick('path');
  let text: string | undefined;
  if (tool.kind === 'execute') text = pick('command');
  else if (tool.kind === 'plan')
    text = `待办 ${Array.isArray(tool.input.todos) ? tool.input.todos.length : 0} 条`;
  else if (tool.kind === 'search')
    text = [pick('pattern') ?? pick('query'), path ? relPath(path, cwd) : undefined]
      .filter((x) => x)
      .join(' @ ');
  else if (path) text = relPath(path, cwd);
  else text = Object.values(tool.input).find((v): v is string => typeof v === 'string');
  return cut(text ?? '', 200);
}

function editedPaths(tool: PendingTool, output: Record<string, unknown>, content: unknown): string[] {
  const paths = new Set<string>();
  for (const value of Object.values(output)) {
    const p = str(rec(value)?.absolute_path);
    if (p) paths.add(p);
  }
  if (Array.isArray(content)) {
    for (const c of content) {
      const p = rec(c)?.type === 'diff' ? str(rec(c)?.path) : undefined;
      if (p) paths.add(p);
    }
  }
  if (paths.size === 0) {
    const p = str(tool.input.file_path) ?? str(tool.input.target_file) ?? str(tool.input.path);
    if (p) paths.add(p);
  }
  return [...paths];
}

function failureText(status: string, output: Record<string, unknown>, content: unknown): string {
  if (str(output.type) === 'Bash') {
    const why =
      output.timed_out === true
        ? '超时'
        : output.signal
          ? `信号 ${String(output.signal)}`
          : `退出码 ${num(output.exit_code) ?? '?'}`;
    const said = str(output.output_for_prompt)?.trim();
    return cut(said ? `${why}：${said}` : why, 500);
  }
  const texts = Array.isArray(content)
    ? content.map((c) => str(rec(rec(c)?.content)?.text)).filter((t): t is string => Boolean(t))
    : [];
  return cut([status, ...texts].join('：'), 500);
}
