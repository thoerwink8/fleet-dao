// 新内核的契约（决定 0124，#3773）。接口层、存储层、驾驶舱只认这一份；字段改了先改这里。
// 认不出的 schemaVersion 一律拒（不猜、不降级），外部动作一律带操作键和所有权令牌。
import { z } from 'zod';

/** 现在认的事件版本。加字段不升版本；改含义、删字段才升，升了旧读者必须拒。 */
export const SCHEMA_VERSION = 1;

/** 事件流的名字：一个会话、一张单、一个工人各一条流。 */
export const StreamId = z
  .string()
  .regex(/^(session|issue|worker):[^\s]+$/, '流名形如 session:<号>、issue:<owner>/<仓>#<单号>、worker:<号>');

/** 现在认的事件类型。新加类型往这里加；读到不认识的类型照样入库，但投影只处理认识的。 */
export const EVENT_TYPES = [
  'session.turn.started',
  'session.turn.settled',
  'worker.spawned',
  'worker.settled',
  'handback.recorded',
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
