// 新内核的契约（决定 0124，#3773）。接口层、存储层、驾驶舱只认这一份；字段改了先改这里。
// 认不出的 schemaVersion 一律拒（不猜、不降级），外部动作一律带操作键和所有权令牌。
import { z } from 'zod';

/** 现在认的事件版本。加字段不升版本；改含义、删字段才升，升了旧读者必须拒。 */
export const SCHEMA_VERSION = 1;

/** 事件流的名字：一个会话、一张单、一个工人各一条流；工人每一步的过程另有 transcript:<runId>（#3781）。 */
export const StreamId = z
  .string()
  .regex(
    /^(session|issue|worker|transcript):[^\s]+$/,
    '流名形如 session:<号>、issue:<owner>/<仓>#<单号>、worker:<号>、transcript:<号>',
  );

/** 现在认的事件类型。新加类型往这里加；读到不认识的类型照样入库，但投影只处理认识的。 */
export const EVENT_TYPES = [
  'session.turn.started',
  'session.turn.settled',
  'worker.spawned',
  'worker.settled',
  // 工人以会话用户跑时（#3814）：收 scope、删交出去的目录的结局，收不干净也照实记
  'worker.cleaned',
  'handback.recorded',
  // 接口层（#3775）：MCP 工具调用落成的事件，这一片只记账，外部动作由后面的片接。
  'worker.spawn.requested',
  'worker.stop.requested',
  'worker.progress.reported',
  'worker.result.submitted',
  // 工人运行时 stream-json 的每一步（#3781），写在 transcript:<runId> 流上。载荷形状见文件末尾的 Transcript*。
  'transcript.assistant',
  'transcript.tool_use',
  'transcript.tool_result',
  'transcript.result',
  'transcript.dropped',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** 写入时的一条事件（seq 由存储层定）。 */
export const NewEvent = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  type: z.enum(EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
});
export type NewEvent = z.infer<typeof NewEvent>;

/** 读出来的一条事件。 */
export const StoredEvent = NewEvent.extend({
  id: z.number().int().positive(),
  streamId: StreamId,
  seq: z.number().int().positive(),
  createdAt: z.string(),
});
export type StoredEvent = z.infer<typeof StoredEvent>;

/** 认一条外来的事件：版本不对、类型不认识都拒，原因写明。 */
export function parseEvent(raw: unknown): { ok: true; event: NewEvent } | { ok: false; why: string } {
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== SCHEMA_VERSION) {
    return { ok: false, why: `事件版本 ${String(version)} 认不出（只认 ${SCHEMA_VERSION}）` };
  }
  const parsed = NewEvent.safeParse(raw);
  return parsed.success ? { ok: true, event: parsed.data } : { ok: false, why: parsed.error.message };
}

/** 会话令牌的角色：指挥官（只读加派工）和工人（只报进度、交结果）。令牌只绑一个会话、一个角色。 */
export const SESSION_ROLES = ['commander', 'worker'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

/** 派工单：六项全必填且不能空，缺一项在 schema 层就拒。 */
export const SpawnWorkerInput = {
  task: z.string().min(1),
  expected: z.string().min(1),
  must_do: z.string().min(1),
  must_not: z.string().min(1),
  context: z.string().min(1),
  stop_when: z.string().min(1),
};

/** 外部动作的种类：所有对外副作用只经 outbox，按种类分发。 */
export const OUTBOX_KINDS = ['git.push', 'github.pr.open', 'github.comment', 'github.merge'] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/** 外部动作挂在哪张单上：所有权令牌按这张单核。 */
export const TaskRef = z.object({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  issue: z.number().int().positive(),
});
export type TaskRef = z.infer<typeof TaskRef>;

/**
 * 操作键：同一件外部动作重试多少次都是同一个键，崩了重来先按它查结果（预留、执行、查证、补偿）。
 * 由单、种类、令牌和调用方给的区分词组成；令牌在里面，换了所有者就是另一件事。
 */
export function opKey(kind: OutboxKind, ref: TaskRef, fencing: number, discriminator: string): string {
  if (!Number.isSafeInteger(fencing) || fencing < 0) throw new Error(`令牌 ${fencing} 不是非负整数`);
  if (discriminator.trim() === '') throw new Error('操作键的区分词不能空');
  return `${kind}:${ref.repo}#${ref.issue}@${fencing}:${discriminator}`;
}

/**
 * 工人过程（transcript:<runId> 流，#3781）每条事件的载荷形状。信封里的 schemaVersion 就是 SCHEMA_VERSION，
 * 改含义才升；读者只认这里的字段，认不出的字段忽略。
 * 文字写入前先过脱敏器、再按字节截断：助手的话和工具结果各 TRANSCRIPT_TEXT_MAX_BYTES，工具参数 TRANSCRIPT_INPUT_MAX_BYTES。
 */
export const TRANSCRIPT_TEXT_MAX_BYTES = 4096;
export const TRANSCRIPT_INPUT_MAX_BYTES = 1024;
export const TRANSCRIPT_SUMMARY_MAX_CHARS = 160;
/** 一次运行最多落多少条、多少字节；超了的丢掉，末尾记一条 transcript.dropped（数字照实）。 */
export const TRANSCRIPT_MAX_ROWS = 2000;
export const TRANSCRIPT_MAX_BYTES = 6 * 1024 * 1024;

export const transcriptStream = (runId: string): string => `transcript:${runId}`;

/** 被截了没有；chars 是截之前的字符数。 */
const Clip = { truncated: z.boolean(), chars: z.number().int().nonnegative() };

export const TranscriptAssistant = z.object({ runId: z.string(), text: z.string(), ...Clip });
export const TranscriptToolUse = z.object({
  runId: z.string(),
  toolUseId: z.string(),
  name: z.string(),
  /** 参数的一句话摘要（命令第一行、文件路径、搜索词……）。 */
  summary: z.string(),
  /** 参数的 JSON 文本，截断后的。 */
  input: z.string(),
  inputTruncated: z.boolean(),
});
export const TranscriptToolResult = z.object({
  runId: z.string(),
  toolUseId: z.string(),
  isError: z.boolean(),
  text: z.string(),
  ...Clip,
});
export const TranscriptResult = z.object({
  runId: z.string(),
  subtype: z.string(),
  isError: z.boolean(),
  text: z.string(),
  ...Clip,
  durationMs: z.number().nullable(),
  numTurns: z.number().nullable(),
});
export const TranscriptDropped = z.object({ runId: z.string(), count: z.number().int().positive() });
