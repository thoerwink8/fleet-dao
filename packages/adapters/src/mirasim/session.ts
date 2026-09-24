// 读 Mirasim 一个会话的状态：订阅回的 snapshot 整份替换，推送的 session 帧按 seq 打补丁（set 浅合并、appendText /
// appendReasoning 追加），再把前后两份状态的差转成进度事件。形状以 packages/adapters/test/fixtures/mirasim
// 里的真跑记录为准（0.0.355，kimi 与 pi）。几个看记录才知道的事：
// - 同一条连接反复 subscribe 会回同一个 seq 的快照：按 seq 去重，旧的丢掉，一样的重放不出新事件；
// - toolCalls 每次都整个数组给（set 里），状态 running → done；kimi 的 input 是 null，命令先写在 running 时的 result 里；
// - 快照里没有命令的退出码：done 不代表命令成功，认出的测试只能记「结果未知」；
// - text 是这一轮助手说的全部话，边长边推：遇到工具开始、会话结束时把新长出来的那段作为一条 say 发出去；
// - 用量：kimi 只给上下文占用，pi 给最近一次模型调用的 input / output 和本轮累计输出（turnOutputTokens）。
import type { ProgressEvent, ProgressKind } from '@fleet-dao/shared';
import {
  cleanTestCommands,
  cut,
  num,
  optional,
  progressEvent,
  rec,
  relPath,
  str,
  testRun,
} from '../stream-kit.ts';
import type { FilePayload, SayPayload, TestPayload, ToolAction, ToolPayload } from '../types.ts';

export interface MirasimToolCall {
  id: string;
  name: string;
  summary?: string;
  input?: unknown;
  status?: string;
  result?: unknown;
}

/** 补丁会把字段清成 null：这里的可选字段都可能被清回 undefined。 */
export interface MirasimState {
  phase?: string | undefined;
  taskId?: string | undefined;
  /** 执行体自己的会话号（kimi 的 session_…、pi 的 UUID）。 */
  nativeSessionId?: string | undefined;
  /** 快照里的模型：只认观测值。 */
  model?: string | undefined;
  text: string;
  reasoning: string;
  activity?: string | undefined;
  toolCalls: MirasimToolCall[];
  /** 等人回答的交互（问题、权限请求）有几条：无头会话没人答（GEN-16）。 */
  interactions: number;
  error?: string | undefined;
  incomplete?: boolean | undefined;
  usage?: Record<string, unknown> | undefined;
  updatedAt?: number | undefined;
}

export interface MirasimSessionOptions {
  runId: string;
  cwd: string;
  testCommands?: readonly string[];
  now?: () => Date;
}

/** 这几种 phase 算会话结束（MS-11：incomplete 也是终态）。 */
const DONE_PHASES = new Set(['done', 'complete', 'completed']);
const FAILED_PHASES = new Set([
  'error',
  'failed',
  'stopped',
  'cancelled',
  'canceled',
  'aborted',
  'interrupted',
]);

const OK_STATUS = new Set(['done', 'completed', 'complete', 'success', 'succeeded', 'ok']);
const FAIL_STATUS = new Set(['error', 'failed', 'failure', 'cancelled', 'canceled', 'rejected', 'denied']);

function toolAction(name: string): ToolAction {
  const n = name.toLowerCase();
  if (/^(read|view|cat|readfile|read_file)$/.test(n)) return 'read';
  if (/edit|write|patch|replace|create/.test(n)) return 'edit';
  if (/bash|shell|exec|command|terminal|run/.test(n)) return 'run';
  if (/grep|glob|search|find|^ls$|list/.test(n)) return 'search';
  if (/web|fetch|url/.test(n)) return 'web';
  if (/task|agent/.test(n)) return 'agent';
  return 'other';
}

function parseInput(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return rec(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return rec(value);
}

export class MirasimSession {
  readonly #runId: string;
  readonly #cwd: string;
  readonly #testCommands: string[];
  readonly #now: () => Date;
  #seq = -1;
  #state: MirasimState = { text: '', reasoning: '', toolCalls: [], interactions: 0 };
  /** 已经发过 start / end 的工具。 */
  readonly #started = new Set<string>();
  readonly #ended = new Set<string>();
  /** 工具的命令（kimi 只在 running 时的 result 里给一次）。 */
  readonly #commands = new Map<string, string>();
  readonly #files = new Set<string>();
  readonly #testRuns: TestPayload[] = [];
  #said = 0;
  #toolErrors = 0;
  #snapshots = 0;
  #patches = 0;
  /** 只认这一轮：accepted 回的 taskId；续跑时服务端先回上一轮收尾的快照（phase=done、旧 taskId）。 */
  #turnTaskId: string | undefined;
  #guarded = false;
  /** 这一轮见没见过非终态（queued / streaming）：taskId 对不上号时拿它兜底。 */
  #freshSeen = false;
  #ours = true;
  /** 上一轮留下的正文：这一轮若是另起一份（不以它开头），说过的位置要从头算。 */
  #baselineText = '';

  constructor(options: MirasimSessionOptions) {
    this.#runId = options.runId;
    this.#cwd = options.cwd;
    this.#testCommands = cleanTestCommands(options.testCommands);
    this.#now = options.now ?? (() => new Date());
  }

  get state(): Readonly<MirasimState> {
    return this.#state;
  }

  /**
   * 起了新的一轮（accepted 之后调）。续跑同一个 sessionKey 时，订阅先回的是上一轮收尾的快照：
   * 那份只当底子——不发事件、不算终态；taskId 换成这一轮的（或见到这一轮的非终态）才开始认。
   * VPS 实跑撞到过：不这么做，续跑那一轮一订阅就读到上一轮的 done，当场判完、把上一轮的工具又报一遍。
   */
  expectTurn(taskId: string | undefined, resume: boolean): void {
    this.#turnTaskId = taskId;
    this.#guarded = resume || taskId !== undefined;
    this.#freshSeen = false;
    this.#ours = !this.#guarded;
  }

  /** 眼下的状态是不是这一轮的。 */
  get current(): boolean {
    return this.#ours;
  }

  get seq(): number {
    return this.#seq;
  }

  /** 有工具在跑（这段时间不算停滞）。 */
  get toolsInFlight(): number {
    return this.#state.toolCalls.filter((t) => !this.#ended.has(t.id) && !isFinal(t.status)).length;
  }

  /** 进度指纹（GEN-05）：正文、推理长度、工具数与状态、activity、更新时间、seq。 */
  fingerprint(): string {
    const s = this.#state;
    return JSON.stringify([
      this.#seq,
      s.phase,
      s.text.length,
      s.reasoning.length,
      s.toolCalls.map((t) => `${t.id}:${t.status}`),
      s.activity,
      s.updatedAt,
    ]);
  }

  /** 会话结束了没有；结束了给判定用的终态。上一轮的收尾不算。 */
  terminal(): { isError: boolean; detail: string } | undefined {
    const { phase, error, incomplete } = this.#state;
    if (!phase || !this.#ours) return undefined;
    if (DONE_PHASES.has(phase)) {
      // MS-10：done 带死因就是失败；incomplete 是上游断流打死的常态
      const isError = Boolean(error) || incomplete === true;
      return {
        isError,
        detail: [phase, error, incomplete ? 'incomplete' : undefined].filter((x) => x).join(' · '),
      };
    }
    if (FAILED_PHASES.has(phase))
      return { isError: true, detail: [phase, error].filter((x) => x).join(' · ') };
    return undefined;
  }

  summary() {
    return {
      state: { ...this.#state, toolCalls: [...this.#state.toolCalls] },
      seq: this.#seq,
      snapshots: this.#snapshots,
      patches: this.#patches,
      toolCalls: this.#started.size,
      toolErrors: this.#toolErrors,
      filesChanged: [...this.#files],
      testRuns: [...this.#testRuns],
    };
  }

  /** 订阅回的整份快照。seq 比手上的旧就丢掉。 */
  applySnapshot(seq: number, snapshot: Record<string, unknown>): ProgressEvent[] {
    if (seq < this.#seq) return [];
    this.#seq = seq;
    this.#snapshots++;
    this.#state = {
      text: '',
      reasoning: '',
      toolCalls: [],
      interactions: 0,
    };
    this.#merge(snapshot);
    const text = str(snapshot.text);
    if (text !== undefined) this.#state.text = text;
    const reasoning = str(snapshot.reasoning);
    if (reasoning !== undefined) this.#state.reasoning = reasoning;
    return this.#settle();
  }

  /** 判这份状态是不是这一轮的：不是就当底子（记成都见过了）；刚换到这一轮时把上一轮的账清掉。 */
  #settle(): ProgressEvent[] {
    const { phase, taskId } = this.#state;
    if (this.#guarded && !this.#ours) {
      if (phase && !DONE_PHASES.has(phase) && !FAILED_PHASES.has(phase)) this.#freshSeen = true;
      const ours = this.#turnTaskId && taskId ? taskId === this.#turnTaskId : this.#freshSeen;
      if (!ours) {
        for (const tool of this.#state.toolCalls) {
          this.#started.add(tool.id);
          this.#ended.add(tool.id);
        }
        this.#said = this.#state.text.length;
        this.#baselineText = this.#state.text;
        return [];
      }
      this.#ours = true;
      // 这一轮的正文是另起的（VPS 实跑：上一轮留的「好了」被换成这一轮的回话）：从头算，不然开头几个字会被吃掉
      if (!this.#state.text.startsWith(this.#baselineText)) this.#said = 0;
      // 上一轮的工具号会被这一轮重用（0:Bash:0）：换轮时清掉，不然这一轮的工具一个都报不出来
      this.#started.clear();
      this.#ended.clear();
      this.#commands.clear();
    }
    return this.#diff();
  }

  /** 推送的补丁。重复的（seq 不比手上的新）丢掉；跳号返回 'gap'，调用方重订阅拿整份快照。 */
  applyPatch(seq: number, patch: Record<string, unknown>): ProgressEvent[] | 'gap' {
    if (seq <= this.#seq) return [];
    if (this.#seq >= 0 && seq > this.#seq + 1) return 'gap';
    this.#seq = seq;
    this.#patches++;
    const set = rec(patch.set);
    if (set) this.#merge(set);
    const appendText = typeof patch.appendText === 'string' ? patch.appendText : '';
    const appendReasoning = typeof patch.appendReasoning === 'string' ? patch.appendReasoning : '';
    this.#state.text += appendText;
    this.#state.reasoning += appendReasoning;
    return this.#settle();
  }

  /** 会话结束时把还没发的话发出去。 */
  flush(): ProgressEvent[] {
    const events: ProgressEvent[] = [];
    this.#flushText(events);
    return events;
  }

  #merge(src: Record<string, unknown>): void {
    const s = this.#state;
    if ('phase' in src || 'runState' in src) s.phase = str(src.phase) ?? str(src.runState);
    if ('taskId' in src) s.taskId = str(src.taskId);
    if ('sessionId' in src) s.nativeSessionId = str(src.sessionId);
    if ('model' in src) s.model = str(src.model);
    if ('activity' in src) s.activity = str(src.activity);
    if ('error' in src) s.error = str(src.error) ?? (src.error ? JSON.stringify(src.error) : undefined);
    if ('incomplete' in src) s.incomplete = src.incomplete === true;
    if ('usage' in src) s.usage = rec(src.usage);
    if ('updatedAt' in src) s.updatedAt = num(src.updatedAt);
    // 补丁里整段换掉正文（包括清空）也要认
    if (typeof src.text === 'string') s.text = src.text;
    if (typeof src.reasoning === 'string') s.reasoning = src.reasoning;
    if ('interactions' in src) s.interactions = Array.isArray(src.interactions) ? src.interactions.length : 0;
    if ('toolCalls' in src && Array.isArray(src.toolCalls)) {
      s.toolCalls = src.toolCalls
        .map((t) => rec(t))
        .filter((t): t is Record<string, unknown> => Boolean(t && str(t.id)))
        .map((t) => ({
          id: str(t.id) as string,
          name: str(t.name) ?? 'unknown',
          ...optional('summary', str(t.summary)),
          ...optional('input', t.input ?? undefined),
          ...optional('status', str(t.status)),
          ...optional('result', t.result ?? undefined),
        }));
    }
  }

  #emit(events: ProgressEvent[], kind: ProgressKind, payload: unknown): void {
    events.push(progressEvent(this.#runId, this.#now(), kind, payload));
  }

  #flushText(events: ProgressEvent[]): void {
    const text = this.#state.text;
    if (text.length < this.#said) this.#said = 0; // 服务端换了一份更短的正文：从头算
    const fresh = text.slice(this.#said).trim();
    this.#said = text.length;
    if (fresh) this.#emit(events, 'say', { text: cut(fresh, 2000), source: 'stream' } satisfies SayPayload);
  }

  #diff(): ProgressEvent[] {
    const events: ProgressEvent[] = [];
    for (const tool of this.#state.toolCalls) {
      const command = this.#commandOf(tool);
      if (command) this.#commands.set(tool.id, command);
      const action = toolAction(tool.name);
      const summary = cut(this.#commands.get(tool.id) ?? this.#pathOf(tool) ?? tool.summary ?? '', 200);
      if (!this.#started.has(tool.id)) {
        this.#flushText(events);
        this.#started.add(tool.id);
        this.#emit(events, 'tool', {
          phase: 'start',
          toolUseId: tool.id,
          name: tool.name,
          action,
          summary,
        } satisfies ToolPayload);
      }
      if (!isFinal(tool.status) || this.#ended.has(tool.id)) continue;
      this.#ended.add(tool.id);
      const ok = OK_STATUS.has((tool.status ?? '').toLowerCase());
      if (!ok) this.#toolErrors++;
      this.#emit(events, 'tool', {
        phase: 'end',
        toolUseId: tool.id,
        name: tool.name,
        action,
        summary,
        ok,
        ...(ok
          ? {}
          : {
              error: cut(`${tool.status}${typeof tool.result === 'string' ? `：${tool.result}` : ''}`, 500),
            }),
      } satisfies ToolPayload);
      const path = this.#pathOf(tool);
      if (ok && action === 'edit' && path) {
        const rel = relPath(path, this.#cwd);
        if (!this.#files.has(rel)) {
          this.#files.add(rel);
          this.#emit(events, 'file', { path: rel, tool: tool.name } satisfies FilePayload);
        }
      }
      const cmd = this.#commands.get(tool.id);
      const run =
        cmd && action === 'run'
          ? testRun(
              cmd,
              ok,
              this.#testCommands,
              ok ? 'Mirasim 快照里没有命令的退出码，done 不代表命令成功' : undefined,
            )
          : undefined;
      if (run) {
        this.#testRuns.push(run);
        this.#emit(events, 'test', run);
      }
    }
    if (this.terminal()) this.#flushText(events);
    return events;
  }

  #commandOf(tool: MirasimToolCall): string | undefined {
    const fromInput = str(parseInput(tool.input)?.command) ?? str(parseInput(tool.input)?.cmd);
    if (fromInput) return fromInput;
    // kimi：input 是 null，命令在 running 时的 result 里（{"command": …}），done 之后 result 换成了输出
    if (tool.status && !isFinal(tool.status)) return str(parseInput(tool.result)?.command);
    return undefined;
  }

  #pathOf(tool: MirasimToolCall): string | undefined {
    const input = parseInput(tool.input);
    return str(input?.path) ?? str(input?.file_path) ?? str(input?.filePath) ?? str(input?.target_file);
  }
}

function isFinal(status: string | undefined): boolean {
  const s = (status ?? '').toLowerCase();
  return OK_STATUS.has(s) || FAIL_STATUS.has(s);
}
