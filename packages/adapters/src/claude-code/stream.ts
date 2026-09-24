// 读 Claude Code 无头模式（-p --output-format stream-json --verbose）的过程记录，一行一帧。
// 帧的形状以 packages/adapters/test/fixtures/claude-code 里的真跑记录为准（2.1.281，经 reclaude）；认不出的帧只计数，不报错。
// 几个看记录才知道的事：
// - init.model 只是把请求原样回显（点一个不存在的模型也照回），实际模型看助手消息的 message.model；
// - 模型不可用时 CLI 自己合成一条 model=<synthetic> 的助手消息，终帧 is_error=true 但 subtype 仍是 success；
// - 一条助手消息按内容块拆成多帧（同一个 message.id），用量以终帧为准；
// - 2.1.281 给 opus-5-5 的工具表里没有步骤清单工具（haiku 有 TaskCreate 一类），步骤只能靠 fleet plan 主动报。
import type { ProgressEvent, ProgressKind } from '@fleet-dao/shared';
import { cleanTestCommands, cut, num, numbers, optional, rec, relPath, str, testRun } from '../stream-kit.ts';
import type {
  FilePayload,
  RateLimitReading,
  RateLimitWindow,
  SayPayload,
  TestPayload,
  ToolAction,
  ToolPayload,
} from '../types.ts';

export { exitStatusUntrusted } from '../stream-kit.ts';

export interface ClaudeStreamOptions {
  runId: string;
  /** 会话的工作目录（工作树），用来把绝对路径换成相对路径。 */
  cwd: string;
  /** 仓库的测试命令（例如 `pnpm check`）；Bash 命令里含它就记一次「跑了测试」。 */
  testCommands?: readonly string[];
  now?: () => Date;
}

/** 终帧里没有的字段就不带（读不到不记成 0）。 */
export interface ClaudeUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** 长会话的周额度主要被它吃掉，单列。 */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface ClaudeResult {
  isError: boolean;
  /** 出错时也可能是 success，判成败看 isError。 */
  subtype?: string;
  /** completed / api_error …… */
  terminalReason?: string;
  apiErrorStatus?: number;
  stopReason?: string;
  /** 最后一段回复。 */
  text?: string;
  numTurns?: number;
  /** 本轮墙钟。 */
  durationMs?: number;
  /** 整个会话累计的接口耗时（续会话时含前几轮）。 */
  sessionDurationApiMs?: number;
  /**
   * 整个会话累计的花费（total_cost_usd）：续会话时含前几轮，直接相加会重复计。
   * 本轮花费用 costOfThisRun(本轮, 上一轮)。
   */
  sessionCostUsd?: number;
  /** 本轮的 token（终帧 usage 只算这一次调用）。 */
  usage?: ClaudeUsage;
  /** modelUsage 里出现的模型。 */
  models: string[];
  permissionDenials: number;
}

export interface ClaudeStreamSummary {
  sessionId?: string;
  /** init 帧里的模型（只是请求的回显）。 */
  initModel?: string;
  /** 第一条真实模型回复里的模型，判「实际用的哪个模型」只认它。 */
  observedModel?: string;
  cliVersion?: string;
  permissionMode?: string;
  tools?: string[];
  /** 出现过助手的正文或工具调用才算真开工；只有 init 或重试帧不算。 */
  startedWork: boolean;
  toolCalls: number;
  toolErrors: number;
  filesChanged: string[];
  testRuns: TestPayload[];
  permissionDenials: { tool: string; toolUseId?: string; reason?: string }[];
  apiRetries: number;
  lastApiRetry?: { attempt?: number; maxRetries?: number; errorStatus?: number; error?: string };
  /** CLI 合成的 API 错误消息（例如 model_not_found）。 */
  apiError?: { code?: string; text: string };
  rateLimits: RateLimitReading[];
  result?: ClaudeResult;
  frames: number;
  nonJsonLines: number;
  nonJsonSample?: string;
  /** 认不出的帧，按 type 计数。 */
  unknownFrames: Record<string, number>;
}

/** 读一行带来的变化，给起进程的那一层用。 */
export interface ClaudeLineEffect {
  events: ProgressEvent[];
  /** 这一行说明会话在干活（助手、工具、思考帧）；重试、额度、init 不算。 */
  activity: boolean;
  init?: { sessionId?: string; model?: string; cliVersion?: string };
  /** 第一次读到真实模型回复时给出模型名，供调用方核对。 */
  observedModel?: string;
  rateLimit?: RateLimitReading;
}

const TOOL_ACTIONS: Record<string, ToolAction> = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'run',
  BashOutput: 'run',
  PowerShell: 'run',
  Monitor: 'run',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  ToolSearch: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'agent',
  Agent: 'agent',
};

/** 这几个工具报成功就意味着改了文件。 */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const WINDOW_KINDS: Record<string, RateLimitWindow['kind']> = { five_hour: '5h', seven_day: '7d' };

const SYNTHETIC_MODEL = '<synthetic>';

interface PendingTool {
  name: string;
  input: Record<string, unknown>;
  subagent: boolean;
}

export class ClaudeStreamReader {
  readonly #runId: string;
  readonly #cwd: string;
  readonly #testCommands: string[];
  readonly #now: () => Date;
  readonly #pending = new Map<string, PendingTool>();
  readonly #files = new Set<string>();
  readonly #s: ClaudeStreamSummary = {
    startedWork: false,
    toolCalls: 0,
    toolErrors: 0,
    filesChanged: [],
    testRuns: [],
    permissionDenials: [],
    apiRetries: 0,
    rateLimits: [],
    frames: 0,
    nonJsonLines: 0,
    unknownFrames: {},
  };

  constructor(options: ClaudeStreamOptions) {
    this.#runId = options.runId;
    this.#cwd = options.cwd;
    this.#testCommands = cleanTestCommands(options.testCommands);
    this.#now = options.now ?? (() => new Date());
  }

  /** 正在跑、还没回结果的工具数。 */
  get toolsInFlight(): number {
    return this.#pending.size;
  }

  summary(): ClaudeStreamSummary {
    return { ...this.#s, filesChanged: [...this.#files] };
  }

  read(raw: string): ClaudeLineEffect {
    const effect: ClaudeLineEffect = { events: [], activity: false };
    const line = raw.trim();
    if (!line) return effect;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    const frame = rec(parsed);
    if (!frame) {
      this.#s.nonJsonLines++;
      this.#s.nonJsonSample ??= cut(line, 200);
      return effect;
    }
    this.#s.frames++;
    const type = str(frame.type) ?? '(无 type)';
    switch (type) {
      case 'system':
        this.#system(frame, effect);
        break;
      case 'assistant':
        this.#assistant(frame, effect);
        break;
      case 'user':
        this.#user(frame, effect);
        break;
      case 'result':
        this.#result(frame, effect);
        break;
      case 'rate_limit_event':
        this.#rateLimit(frame, effect);
        break;
      default:
        this.#s.unknownFrames[type] = (this.#s.unknownFrames[type] ?? 0) + 1;
    }
    return effect;
  }

  #emit(effect: ClaudeLineEffect, kind: ProgressKind, payload: unknown): void {
    effect.events.push({ runId: this.#runId, at: this.#now().toISOString(), kind, payload });
  }

  #system(frame: Record<string, unknown>, effect: ClaudeLineEffect): void {
    switch (str(frame.subtype)) {
      case 'init': {
        const init = {
          ...optional('sessionId', str(frame.session_id)),
          ...optional('model', str(frame.model)),
          ...optional('cliVersion', str(frame.claude_code_version)),
        };
        effect.init = init;
        if (init.sessionId) this.#s.sessionId = init.sessionId;
        if (init.model) this.#s.initModel = init.model;
        if (init.cliVersion) this.#s.cliVersion = init.cliVersion;
        const mode = str(frame.permissionMode);
        if (mode) this.#s.permissionMode = mode;
        if (Array.isArray(frame.tools)) this.#s.tools = frame.tools.filter((t) => typeof t === 'string');
        break;
      }
      case 'thinking_tokens':
        // 长思考时只有这种帧，它说明模型还在干活
        effect.activity = true;
        break;
      case 'api_retry':
        this.#s.apiRetries++;
        this.#s.lastApiRetry = {
          ...optional('attempt', num(frame.attempt)),
          ...optional('maxRetries', num(frame.max_retries)),
          ...optional('errorStatus', num(frame.error_status)),
          ...optional('error', str(frame.error)),
        };
        break;
      case 'permission_denied':
        this.#s.permissionDenials.push({
          tool: str(frame.tool_name) ?? '',
          ...optional('toolUseId', str(frame.tool_use_id)),
          ...optional('reason', str(frame.decision_reason)),
        });
        break;
      default:
        break;
    }
  }

  #assistant(frame: Record<string, unknown>, effect: ClaudeLineEffect): void {
    const message = rec(frame.message) ?? {};
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (frame.is_api_error_message === true || str(frame.error)) {
      const text = blocks.map((b) => str(rec(b)?.text) ?? '').join('');
      this.#s.apiError = { ...optional('code', str(frame.error)), text: cut(text, 1000) };
      return;
    }
    const model = str(message.model);
    if (model && model !== SYNTHETIC_MODEL && !this.#s.observedModel) {
      this.#s.observedModel = model;
      effect.observedModel = model;
    }
    effect.activity = true;
    const subagent = Boolean(str(frame.parent_tool_use_id));
    for (const raw of blocks) {
      const block = rec(raw);
      if (!block) continue;
      if (block.type === 'text') {
        const text = (str(block.text) ?? '').trim();
        if (!text || subagent) continue;
        this.#s.startedWork = true;
        this.#emit(effect, 'say', { text: cut(text, 2000), source: 'stream' } satisfies SayPayload);
      } else if (block.type === 'tool_use') {
        const id = str(block.id) ?? '';
        const name = str(block.name) ?? 'unknown';
        const input = rec(block.input) ?? {};
        this.#pending.set(id, { name, input, subagent });
        this.#s.startedWork = true;
        this.#s.toolCalls++;
        this.#emit(effect, 'tool', {
          phase: 'start',
          toolUseId: id,
          name,
          action: TOOL_ACTIONS[name] ?? 'other',
          summary: toolSummary(name, input, this.#cwd),
          ...optional('description', name === 'Bash' ? str(input.description) : undefined),
          ...(subagent ? { subagent: true } : {}),
        } satisfies ToolPayload);
      }
    }
  }

  #user(frame: Record<string, unknown>, effect: ClaudeLineEffect): void {
    const message = rec(frame.message) ?? {};
    const blocks = Array.isArray(message.content) ? message.content : [];
    const results = blocks.map(rec).filter((b) => b?.type === 'tool_result') as Record<string, unknown>[];
    if (results.length === 0) return;
    effect.activity = true;
    // tool_use_result 是 CLI 附带的结构化结果，一帧一个工具时才对得上号
    const structured = results.length === 1 ? rec(frame.tool_use_result) : undefined;
    for (const block of results) {
      const id = str(block.tool_use_id) ?? '';
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      const name = pending?.name ?? 'unknown';
      const input = pending?.input ?? {};
      const ok = block.is_error !== true;
      if (!ok) this.#s.toolErrors++;
      this.#emit(effect, 'tool', {
        phase: 'end',
        toolUseId: id,
        name,
        action: TOOL_ACTIONS[name] ?? 'other',
        summary: toolSummary(name, input, this.#cwd),
        ok,
        ...optional('error', ok ? undefined : cut(resultText(block.content), 500)),
        ...(pending?.subagent ? { subagent: true } : {}),
      } satisfies ToolPayload);
      if (ok) {
        const paths: string[] = [];
        if (EDIT_TOOLS.has(name)) {
          const p = str(input.file_path) ?? str(input.notebook_path) ?? str(structured?.filePath);
          if (p) paths.push(p);
        }
        // Bash 改的文件 CLI 也会算出来（bashEditDiff.changedFiles）
        const changed = rec(structured?.bashEditDiff)?.changedFiles;
        if (Array.isArray(changed)) for (const p of changed) if (typeof p === 'string') paths.push(p);
        for (const p of paths) {
          const path = relPath(p, this.#cwd);
          this.#files.add(path);
          this.#emit(effect, 'file', { path, tool: name } satisfies FilePayload);
        }
      }
      const command = name === 'Bash' ? str(input.command) : undefined;
      const run = command
        ? testRun(
            command,
            ok,
            this.#testCommands,
            input.run_in_background === true
              ? '放到后台跑，命令返回时测试还没跑完'
              : rec(structured)?.interrupted === true
                ? '命令被打断'
                : undefined,
          )
        : undefined;
      if (run) {
        this.#s.testRuns.push(run);
        this.#emit(effect, 'test', run);
      }
    }
  }

  #result(frame: Record<string, unknown>, effect: ClaudeLineEffect): void {
    effect.activity = true;
    const usage = rec(frame.usage);
    const modelUsage = rec(frame.modelUsage);
    const denials = Array.isArray(frame.permission_denials) ? frame.permission_denials.length : 0;
    this.#s.result = {
      isError: frame.is_error === true,
      ...optional('subtype', str(frame.subtype)),
      ...optional('terminalReason', str(frame.terminal_reason)),
      ...optional('apiErrorStatus', num(frame.api_error_status)),
      ...optional('stopReason', str(frame.stop_reason)),
      ...optional('text', str(frame.result)),
      ...optional('numTurns', num(frame.num_turns)),
      ...optional('durationMs', num(frame.duration_ms)),
      ...optional('sessionDurationApiMs', num(frame.duration_api_ms)),
      ...optional('sessionCostUsd', num(frame.total_cost_usd)),
      ...(usage
        ? {
            usage: numbers(usage, {
              inputTokens: 'input_tokens',
              outputTokens: 'output_tokens',
              cacheReadInputTokens: 'cache_read_input_tokens',
              cacheCreationInputTokens: 'cache_creation_input_tokens',
            }),
          }
        : {}),
      models: modelUsage ? Object.keys(modelUsage) : [],
      permissionDenials: denials,
    };
    const sessionId = str(frame.session_id);
    if (sessionId && !this.#s.sessionId) this.#s.sessionId = sessionId;
  }

  #rateLimit(frame: Record<string, unknown>, effect: ClaudeLineEffect): void {
    const info = rec(frame.rate_limit_info) ?? {};
    const status = str(info.status) ?? 'unknown';
    const windows: RateLimitWindow[] = [];
    for (const [name, raw] of Object.entries(rec(info.unifiedWindows) ?? {})) {
      const w = rec(raw) ?? {};
      windows.push({
        name,
        ...optional('kind', WINDOW_KINDS[name]),
        ...optional('utilization', num(w.utilization)),
        ...optional('resetsAt', epochSeconds(w.resetsAt)),
      });
    }
    const reading: RateLimitReading = {
      status,
      // 用满时只有 status=rejected，不带 unifiedWindows——照样判用满，不当成「没读到」
      exhausted: status === 'rejected',
      ...optional('rateLimitType', str(info.rateLimitType)),
      ...optional('resetsAt', epochSeconds(info.resetsAt)),
      windows,
      observedAt: this.#now().toISOString(),
    };
    this.#s.rateLimits.push(reading);
    effect.rateLimit = reading;
  }
}

/** 本轮花费 = 本轮终帧的累计值 − 上一轮终帧的累计值（新会话没有上一轮）。有一边没读到就是没查成。 */
export function costOfThisRun(current?: ClaudeResult, previous?: ClaudeResult): number | undefined {
  if (current?.sessionCostUsd === undefined) return undefined;
  if (previous === undefined) return current.sessionCostUsd;
  if (previous.sessionCostUsd === undefined) return undefined;
  return Math.max(0, current.sessionCostUsd - previous.sessionCostUsd);
}

/** 点名的模型和实际回话的模型是不是同一个：忽略末尾的日期（-20251001）和方括号参数。 */
export function sameModel(requested: string, observed: string): boolean {
  const norm = (m: string) =>
    m
      .trim()
      .toLowerCase()
      .replace(/\[.*\]$/, '')
      .replace(/-\d{8}$/, '');
  return norm(requested) === norm(observed);
}

/** 版本号 a.b.c 是否不低于 min；认不出就返回 undefined（不当成「够新」也不当成「太旧」）。 */
export function versionAtLeast(version: string, min: string): boolean | undefined {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number);
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function toolSummary(name: string, input: Record<string, unknown>, cwd: string): string {
  const pick = (key: string) => str(input[key]);
  let text: string | undefined;
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      text = relPath(pick('file_path') ?? '', cwd);
      break;
    case 'NotebookEdit':
      text = relPath(pick('notebook_path') ?? '', cwd);
      break;
    case 'Bash':
      text = pick('command');
      break;
    case 'Grep': {
      const where = pick('path');
      text = [pick('pattern'), where ? relPath(where, cwd) : undefined].filter((x) => x).join(' @ ');
      break;
    }
    case 'Glob':
      text = pick('pattern');
      break;
    case 'WebFetch':
      text = pick('url');
      break;
    case 'WebSearch':
      text = pick('query');
      break;
    case 'Task':
    case 'Agent':
      text = pick('description') ?? pick('subagent_type');
      break;
    default:
      text = Object.values(input).find((v): v is string => typeof v === 'string');
  }
  return cut(text ?? '', 200);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => str(rec(c)?.text) ?? '').join('');
  return '';
}

function epochSeconds(value: unknown): string | undefined {
  const n = num(value);
  return n === undefined ? undefined : new Date(n * 1000).toISOString();
}
