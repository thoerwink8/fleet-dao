// 工人过程落库（#3781）：把 Claude Code `--output-format stream-json` 的每一行拆成事件，写在 transcript:<runId> 流上。
//
// 为什么另起一条流、不写进 worker:<runId>：
// - worker:<runId> 的 seq 是槽位自己数的（spawned=0→1、settled=1→2、cleaned=written→…），掺进几百条步骤会把这套对账弄乱；
// - 驾驶舱的会话页和列表的 `tail`（最近 24 条判状态）读的是 session:<号>，过程是它们的几十倍，混进去会把判状态用的事件挤出窗口；
// - 过程有自己的上限、自己的分页，丢了也只丢过程，不影响起止记账。
//
// 三条规矩：
// 1. 文字一律先过脱敏器、再按字节截断（顺序不能反：先截会把一个令牌截成认不出的半截，漏出前缀）。
// 2. 批量写：攒到 maxBatch 条或 flushMs 到点才写一个事务，不是一行一个事务。
// 3. 进程被杀也尽量写掉：runProcess 在子进程退出、收尸后才 resolve，槽位在 finally 里 close()，把攒着的最后一批写掉再记 worker.settled。
import {
  type NewEvent,
  SCHEMA_VERSION,
  TRANSCRIPT_INPUT_MAX_BYTES,
  TRANSCRIPT_MAX_BYTES,
  TRANSCRIPT_MAX_ROWS,
  TRANSCRIPT_SUMMARY_MAX_CHARS,
  TRANSCRIPT_TEXT_MAX_BYTES,
  transcriptStream,
} from '@fleet-dao/harness-contract';
import type { Redactor } from '@fleet-dao/harness-runner';
import { appendEvents, type Db, readStream, StreamConflictError } from '@fleet-dao/harness-store';

type TranscriptType = Extract<NewEvent['type'], `transcript.${string}`>;

export interface TranscriptItem {
  type: TranscriptType;
  payload: Record<string, unknown>;
}

/** 按字节截断（UTF-8），不会把一个字切成两半。 */
export function clipBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // 往回退到字符边界：UTF-8 的续字节是 10xxxxxx
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

function oneLine(s: string): string {
  const first = s.split('\n').find((l) => l.trim() !== '') ?? '';
  return first.trim();
}

function clipChars(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** 工具参数的一句话摘要：命令取第一行、文件类取路径、搜索类取模式；其余取第一个字符串值。 */
export function summarizeToolInput(name: string, input: unknown): string {
  const obj =
    input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const str = (k: string): string | undefined =>
    typeof obj[k] === 'string' && obj[k] !== '' ? (obj[k] as string) : undefined;
  let pick: string | undefined;
  if (name === 'Bash' || name === 'PowerShell') pick = str('command');
  else if (PATH_TOOLS.has(name)) pick = str('file_path') ?? str('notebook_path');
  else if (name === 'Grep' || name === 'Glob') {
    const p = str('pattern');
    const where = str('path');
    pick = p ? (where ? `${p}  ${where}` : p) : undefined;
  } else if (name === 'WebFetch') pick = str('url');
  else if (name === 'WebSearch') pick = str('query');
  else if (name === 'Agent' || name === 'Task') pick = str('description') ?? str('prompt');
  pick ??= Object.values(obj).find((v): v is string => typeof v === 'string' && v !== '');
  return clipChars(oneLine(pick ?? ''), TRANSCRIPT_SUMMARY_MAX_CHARS);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        const o = c as { type?: unknown; text?: unknown } | null;
        if (o && typeof o.text === 'string') return o.text;
        return o?.type === 'image' ? '[图片]' : '';
      })
      .filter((s) => s !== '')
      .join('\n');
  }
  return '';
}

/**
 * 拆一行 stream-json。认不出的行（非 JSON、system、thinking 块……）返回空数组，不抛。
 * redact 是槽位那一把（含 MCP 令牌和宿主环境里的密钥）。
 */
export function parseStreamLine(line: string, runId: string, redact: Redactor): TranscriptItem[] {
  let msg: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(line);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
    msg = v as Record<string, unknown>;
  } catch {
    return [];
  }
  const clip = (raw: string, max = TRANSCRIPT_TEXT_MAX_BYTES) => {
    const safe = redact(raw);
    const c = clipBytes(safe, max);
    return { text: c.text, truncated: c.truncated, chars: safe.length };
  };
  const content = (msg.message as { content?: unknown } | undefined)?.content;
  const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  const out: TranscriptItem[] = [];

  if (msg.type === 'assistant') {
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
        out.push({ type: 'transcript.assistant', payload: { runId, ...clip(b.text) } });
      } else if (b.type === 'tool_use') {
        const name = redact(String(b.name ?? '?'));
        const rawInput = JSON.stringify(b.input ?? {});
        const input = clip(rawInput, TRANSCRIPT_INPUT_MAX_BYTES);
        out.push({
          type: 'transcript.tool_use',
          payload: {
            runId,
            toolUseId: redact(String(b.id ?? '')),
            name,
            summary: redact(summarizeToolInput(String(b.name ?? ''), b.input)),
            input: input.text,
            inputTruncated: input.truncated,
          },
        });
      }
    }
    return out;
  }
  if (msg.type === 'user') {
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue;
      out.push({
        type: 'transcript.tool_result',
        payload: {
          runId,
          toolUseId: redact(String(b.tool_use_id ?? '')),
          isError: b.is_error === true,
          ...clip(textOf(b.content)),
        },
      });
    }
    return out;
  }
  if (msg.type === 'result') {
    const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return [
      {
        type: 'transcript.result',
        payload: {
          runId,
          subtype: redact(String(msg.subtype ?? '')),
          isError: msg.is_error === true,
          ...clip(typeof msg.result === 'string' ? msg.result : ''),
          durationMs: n(msg.duration_ms),
          numTurns: n(msg.num_turns),
        },
      },
    ];
  }
  return [];
}

/** 一个壳的输出怎么拆成过程事件。Claude 一行自成一条；Grok 的话一字一帧，要攒，进程结束时 end() 把攒着的吐出来。 */
export interface TranscriptParser {
  parse(line: string): TranscriptItem[];
  end?(): TranscriptItem[];
}

export function claudeTranscriptParser(runId: string, redact: Redactor): TranscriptParser {
  return { parse: (line) => parseStreamLine(line, runId, redact) };
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** tool_call_update 的结果文字：先取 content 里的文本块，没有再取 rawOutput 里给模型看的那份。 */
function grokResultText(frame: Record<string, unknown>): string {
  const parts = (Array.isArray(frame.content) ? frame.content : [])
    .map((c) => rec(rec(c).content).text)
    .filter((t): t is string => typeof t === 'string' && t !== '');
  if (parts.length > 0) return parts.join('\n');
  const out = rec(frame.rawOutput);
  for (const v of [out.output_for_prompt, rec(out.Content).content, rec(out.FileContent).content]) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

/**
 * Grok `--output-format streaming-json`（#3842）拆成同一套 transcript.* 事件，驾驶舱工人会话页不用分壳：
 * text 是一字一帧的增量，攒到下一个非 text 帧再成一条助手的话；thought 不落（同 Claude 不落 thinking）；
 * tool_call → tool_use，tool_call_update 到 completed / failed → tool_result（命令退出码非 0 算出错）；end → result。
 */
export class GrokTranscriptParser implements TranscriptParser {
  readonly #runId: string;
  readonly #redact: Redactor;
  #text = '';

  constructor(runId: string, redact: Redactor) {
    this.#runId = runId;
    this.#redact = redact;
  }

  #clip(raw: string, max = TRANSCRIPT_TEXT_MAX_BYTES) {
    const safe = this.#redact(raw);
    const c = clipBytes(safe, max);
    return { text: c.text, truncated: c.truncated, chars: safe.length };
  }

  #flushText(): TranscriptItem[] {
    const text = this.#text;
    this.#text = '';
    if (text.trim() === '') return [];
    return [{ type: 'transcript.assistant', payload: { runId: this.#runId, ...this.#clip(text) } }];
  }

  parse(line: string): TranscriptItem[] {
    let f: Record<string, unknown>;
    try {
      f = rec(JSON.parse(line));
    } catch {
      return [];
    }
    if (f.type === 'text') {
      if (typeof f.data === 'string') this.#text += f.data;
      return [];
    }
    if (f.type === 'thought') return [];
    const out = this.#flushText();
    const runId = this.#runId;
    if (f.type === 'tool_call') {
      const rawName = String(f.toolName ?? f.title ?? '?');
      const input = this.#clip(JSON.stringify(f.rawInput ?? {}), TRANSCRIPT_INPUT_MAX_BYTES);
      out.push({
        type: 'transcript.tool_use',
        payload: {
          runId,
          toolUseId: this.#redact(String(f.toolCallId ?? '')),
          name: this.#redact(rawName),
          summary: this.#redact(summarizeToolInput(rawName, f.rawInput)),
          input: input.text,
          inputTruncated: input.truncated,
        },
      });
    } else if (f.type === 'tool_call_update' && (f.status === 'completed' || f.status === 'failed')) {
      const raw = rec(f.rawOutput);
      const exit = typeof raw.exit_code === 'number' ? raw.exit_code : undefined;
      out.push({
        type: 'transcript.tool_result',
        payload: {
          runId,
          toolUseId: this.#redact(String(f.toolCallId ?? '')),
          isError: f.status === 'failed' || (raw.type === 'Bash' && exit !== undefined && exit !== 0),
          ...this.#clip(grokResultText(f)),
        },
      });
    } else if (f.type === 'error') {
      out.push({
        type: 'transcript.assistant',
        payload: { runId, ...this.#clip(`报错：${String(f.message ?? '')}`) },
      });
    } else if (f.type === 'end') {
      const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const stop = String(f.stopReason ?? '');
      out.push({
        type: 'transcript.result',
        payload: {
          runId,
          subtype: this.#redact(stop),
          isError: stop !== 'end_turn',
          ...this.#clip(''),
          durationMs: null,
          numTurns: n(f.num_turns),
        },
      });
    }
    return out;
  }

  end(): TranscriptItem[] {
    return this.#flushText();
  }
}

export interface TranscriptOptions {
  db: Db;
  runId: string;
  redact: Redactor;
  /** 拆输出的规则；不给是 Claude Code 的 stream-json。 */
  parser?: TranscriptParser;
  /** 攒多久必写一次。默认 1500ms。 */
  flushMs?: number;
  /** 攒到多少条立刻写。默认 50。 */
  maxBatch?: number;
  maxRows?: number;
  maxBytes?: number;
}

export interface TranscriptSummary {
  /** 落库的条数、字节（载荷 JSON 的字节，不含行开销）。 */
  rows: number;
  bytes: number;
  /** 超过上限丢掉的条数。 */
  dropped: number;
  /** 写库失败、最后也没写进去的条数（库挂了）。 */
  lost: number;
  /** 一共写了几个事务。 */
  batches: number;
}

export class TranscriptWriter {
  readonly #o: Required<Omit<TranscriptOptions, 'db' | 'runId' | 'redact' | 'parser'>> &
    Pick<TranscriptOptions, 'db' | 'runId' | 'redact'>;
  readonly #parser: TranscriptParser;
  readonly #stream: string;
  #pending: TranscriptItem[] = [];
  #timer: NodeJS.Timeout | undefined;
  #chain: Promise<void> = Promise.resolve();
  #seq: number | undefined;
  #closed = false;
  #sum: TranscriptSummary = { rows: 0, bytes: 0, dropped: 0, lost: 0, batches: 0 };
  #queued = 0;
  #queuedBytes = 0;

  constructor(o: TranscriptOptions) {
    const { parser, ...rest } = o;
    this.#o = {
      flushMs: 1500,
      maxBatch: 50,
      maxRows: TRANSCRIPT_MAX_ROWS,
      maxBytes: TRANSCRIPT_MAX_BYTES,
      ...rest,
    };
    this.#parser = parser ?? claudeTranscriptParser(o.runId, o.redact);
    this.#stream = transcriptStream(o.runId);
  }

  /** runProcess 的 onFrame 里调：同步，不等库。解析出错不抛。 */
  pushLine(line: string): void {
    if (this.#closed) return;
    let items: TranscriptItem[];
    try {
      items = this.#parser.parse(line);
    } catch {
      return;
    }
    this.#enqueue(items);
  }

  #enqueue(items: TranscriptItem[]): void {
    for (const it of items) {
      const size = Buffer.byteLength(JSON.stringify(it.payload), 'utf8');
      if (this.#queued >= this.#o.maxRows || this.#queuedBytes + size > this.#o.maxBytes) {
        this.#sum.dropped++;
        continue;
      }
      this.#queued++;
      this.#queuedBytes += size;
      this.#pending.push(it);
    }
    if (this.#pending.length >= this.#o.maxBatch) this.#kick();
    else if (this.#pending.length > 0 && !this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#kick();
      }, this.#o.flushMs);
    }
  }

  #kick(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#chain = this.#chain.then(() => this.#flushOnce());
  }

  async #headSeq(): Promise<number> {
    const last = (await readStream(this.#o.db, this.#stream, 0, 1)).length;
    if (last === 0) return 0;
    // 同一个 runId 重来过（流里已经有东西）：从现有的最后一条往后接
    let seq = 0;
    for (;;) {
      const page = await readStream(this.#o.db, this.#stream, seq, 500);
      const tail = page.at(-1);
      if (!tail) return seq;
      seq = tail.seq;
      if (page.length < 500) return seq;
    }
  }

  /** 把攒着的写完：每个事务最多 maxBatch 条。 */
  async #flushOnce(): Promise<void> {
    while (this.#pending.length > 0) await this.#writeBatch(this.#pending.splice(0, this.#o.maxBatch));
  }

  async #writeBatch(batch: TranscriptItem[]): Promise<void> {
    const events: NewEvent[] = batch.map((it) => ({
      schemaVersion: SCHEMA_VERSION,
      type: it.type,
      payload: it.payload,
    }));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.#seq ??= await this.#headSeq();
        const stored = await appendEvents(this.#o.db, this.#stream, this.#seq, events);
        this.#seq += stored.length;
        this.#sum.rows += stored.length;
        this.#sum.batches++;
        for (const it of batch) this.#sum.bytes += Buffer.byteLength(JSON.stringify(it.payload), 'utf8');
        return;
      } catch (err) {
        if (err instanceof StreamConflictError) this.#seq = undefined;
        // 库暂时不可用：等一下再试，三次后放弃这一批并照实记 lost（不抛：过程丢了不该拖垮工人的起止记账）
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
    this.#sum.lost += batch.length;
  }

  /** 把攒着的写完；超限丢掉的补一条 transcript.dropped。之后不再收。返回这一轮的数字，进 worker.settled。 */
  async close(): Promise<TranscriptSummary> {
    if (!this.#closed) {
      let tail: TranscriptItem[] = [];
      try {
        tail = this.#parser.end?.() ?? [];
      } catch {
        // 攒着的拆不出来就算了，不拖垮收尾
      }
      this.#enqueue(tail);
      this.#closed = true;
      if (this.#sum.dropped > 0) {
        this.#pending.push({
          type: 'transcript.dropped',
          payload: { runId: this.#o.runId, count: this.#sum.dropped },
        });
      }
      this.#kick();
    }
    await this.#chain;
    return { ...this.#sum };
  }
}
