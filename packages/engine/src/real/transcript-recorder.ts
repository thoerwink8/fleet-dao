// 三段会话的过程记录员（#1640）：把插头一条条交来的过程（助手的话、工具调用和结果、报错、结论）加上引擎自己记的提示词，
// 打码、截断、编号，小批量攒着写进 run_transcript。
//
// 改这里之前必须知道：
// - 写不进只记日志，绝不让会话失败：record / prompt 永不抛；写库失败的那批留在缓冲里下一次再写（最多 3000 条，不会无限涨），
//   收场还写不进就丢掉并记一笔。会话的结局、用量、花费照旧由 runOneShot 记，不看这里。
// - 先打码再截断：先截断的话，一把密钥被拦腰截成半截就认不出来了。打码用 hygiene 的规则（redactSecrets），不另抄一份正则；
//   命中的整段换成「[已打码：<规则名>]」，meta.redacted 记打了几处。
// - 上限在 shared 的 TRANSCRIPT_LIMITS：每条按种类截断（截了文本末尾加标记，meta.truncated 为 true、meta.originalChars 是原来的字数）；
//   每段最多 maxEntries 条，超了停记，收尾补一条 truncated 写「后面还有 N 条没记」（所以一段最多 maxEntries + 1 行）。
// - 序号从 0 起，按到达的先后分。同一个 (run_id, seq) 在库里 on conflict do nothing：引擎重启后接回、重读输出的路径要
//   重复交来同样的条目也只会写一次（前提是顺序一样，输出文件是同一份就一样）。
// - 攒批：够 batchSize 条立刻写，不够隔 flushEveryMs 写一次，收场（close）再写一次；同一时刻只有一次写在飞，写的顺序就是编号顺序。

import type { TranscriptEntry } from '@fleet-dao/adapters';
import type { TranscriptRow } from '@fleet-dao/db';
import { redactSecrets } from '@fleet-dao/hygiene';
import { TRANSCRIPT_LIMITS, TRANSCRIPT_TRUNCATED_MARK, type TranscriptKind } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';

/** 各项上限（测试里调小）：形状同 shared 的 TRANSCRIPT_LIMITS，数换成 number。 */
export type TranscriptLimits = { [K in keyof typeof TRANSCRIPT_LIMITS]: number };

export const TRANSCRIPT_FLUSH_MS = 1_500;
export const TRANSCRIPT_BATCH = 25;

export interface TranscriptRecorderDeps {
  runId: string;
  /** 写一批；冲突的 seq 由库跳过。写不进抛。 */
  write: (runId: string, rows: TranscriptRow[]) => Promise<void>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
  flushEveryMs?: number;
  batchSize?: number;
  limits?: TranscriptLimits;
}

/** 每种条目的字数上限。 */
function limitOf(kind: TranscriptKind, limits: TranscriptLimits): number {
  switch (kind) {
    case 'assistant':
      return limits.assistantChars;
    case 'tool_call':
      return limits.toolInputChars;
    case 'tool_result':
      return limits.toolResultChars;
    case 'prompt':
      return limits.promptChars;
    case 'error':
      return limits.errorChars;
    case 'result':
      return limits.resultChars;
    case 'truncated':
      return limits.errorChars;
  }
}

/** 打码再截断。截断标出来（文本末尾的标记加 meta）。原文不动。 */
export function sanitizeTranscriptText(
  kind: TranscriptKind,
  raw: string,
  limits: TranscriptLimits = TRANSCRIPT_LIMITS,
): { text: string; meta?: Record<string, unknown> } {
  const redacted = redactSecrets(raw);
  const max = limitOf(kind, limits);
  const meta: Record<string, unknown> = {};
  let text = redacted.text;
  if (redacted.count > 0) meta.redacted = redacted.count;
  if (text.length > max) {
    meta.truncated = true;
    meta.originalChars = text.length;
    text = `${text.slice(0, max)}${TRANSCRIPT_TRUNCATED_MARK}`;
  }
  return Object.keys(meta).length > 0 ? { text, meta } : { text };
}

export class TranscriptRecorder {
  readonly #deps: TranscriptRecorderDeps;
  readonly #log: NonNullable<TranscriptRecorderDeps['log']>;
  readonly #now: () => Date;
  readonly #limits: TranscriptLimits;
  readonly #flushEveryMs: number;
  readonly #batchSize: number;
  #seq = 0;
  #pending: TranscriptRow[] = [];
  #dropped = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> = Promise.resolve();
  #failedOnce = false;
  #closed = false;

  constructor(deps: TranscriptRecorderDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? (() => undefined);
    this.#now = deps.now ?? (() => new Date());
    this.#limits = deps.limits ?? TRANSCRIPT_LIMITS;
    this.#flushEveryMs = deps.flushEveryMs ?? TRANSCRIPT_FLUSH_MS;
    this.#batchSize = deps.batchSize ?? TRANSCRIPT_BATCH;
  }

  /** 交给会话的那份提示词（第一条）。 */
  prompt(text: string): void {
    this.#add('prompt', this.#now(), text);
  }

  /** 插头交来的一条。接到 adapters 的 onTranscript 上；永不抛。 */
  record = (entry: TranscriptEntry): void => {
    const at = new Date(entry.at);
    this.#add(entry.kind, Number.isNaN(at.getTime()) ? this.#now() : at, entry.text, entry);
  };

  #add(
    kind: TranscriptKind,
    at: Date,
    raw: string,
    extra: Pick<TranscriptEntry, 'tool' | 'ok' | 'meta'> = {},
  ): void {
    try {
      if (this.#closed) return;
      if (this.#seq >= this.#limits.maxEntries) {
        this.#dropped++;
        return;
      }
      const clean = sanitizeTranscriptText(kind, raw, this.#limits);
      const meta = { ...extra.meta, ...clean.meta };
      this.#pending.push({
        seq: this.#seq++,
        at,
        kind,
        text: clean.text,
        ...(extra.tool === undefined ? {} : { tool: extra.tool }),
        ...(extra.ok === undefined ? {} : { ok: extra.ok }),
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
      });
      this.#schedule();
    } catch (err) {
      // 打码、截断出了意外：这一条不记，会话照跑
      this.#log('会话过程记录有一条没记上（会话照常）', { runId: this.#deps.runId, error: errMessage(err) });
    }
  }

  #schedule(): void {
    if (this.#pending.length >= this.#batchSize) {
      this.#flushNow();
      return;
    }
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => this.#flushNow(), this.#flushEveryMs);
    this.#timer.unref?.();
  }

  #flushNow(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    // 写的顺序就是编号顺序：上一次还在飞就排在它后面
    this.#inFlight = this.#inFlight.then(() => this.#writePending());
  }

  async #writePending(): Promise<void> {
    if (this.#pending.length === 0) return;
    const batch = this.#pending;
    this.#pending = [];
    try {
      await this.#deps.write(this.#deps.runId, batch);
    } catch (err) {
      // 留着，下一次一起再写（最多 maxEntries 条，不会无限涨）；只在第一次失败时记日志，免得每个节拍刷一行
      this.#pending = [...batch, ...this.#pending];
      if (!this.#failedOnce) {
        this.#failedOnce = true;
        this.#log('会话过程记录写不进库（会话照常跑，下个节拍再试）', {
          runId: this.#deps.runId,
          error: errMessage(err),
        });
      }
    }
  }

  /**
   * 会话收场：超了上限的补一条「后面还有 N 条没记」，把没写的写完。写不进的丢掉并记一笔。不抛。
   * 调用方（segment-spawner）在会话结局交回之前等它：这样一段收场时它的过程已经全在库里。
   */
  async close(): Promise<void> {
    try {
      if (this.#dropped > 0) {
        const n = this.#dropped;
        this.#dropped = 0;
        this.#pending.push({
          seq: this.#seq++,
          at: this.#now(),
          kind: 'truncated',
          text: `后面还有 ${n} 条没记（一段最多记 ${this.#limits.maxEntries} 条）`,
          meta: { dropped: n },
        });
      }
      this.#closed = true;
      this.#flushNow();
      await this.#inFlight;
      if (this.#pending.length > 0) {
        // 收场前还是写不进：再试最后一次
        this.#flushNow();
        await this.#inFlight;
      }
      if (this.#pending.length > 0) {
        this.#log('会话过程记录收场时仍没写进库，丢弃', {
          runId: this.#deps.runId,
          lost: this.#pending.length,
        });
        this.#pending = [];
      }
    } catch (err) {
      this.#log('会话过程记录收场出了意外（会话照常）', { runId: this.#deps.runId, error: errMessage(err) });
    }
  }
}
