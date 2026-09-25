// 两个 Store 共用的飞书记录写法：收到的话的幂等记录（存在 idempotency_keys 的 result 里）、改草稿时怎么追加补充。
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FeishuMessageKey, FeishuMessageRecord, FeishuMessageResult } from './ports.ts';

/** 「我理解为」最长多少字（shared/feishu-api.ts 的 FeishuDraftSchema.understanding）。 */
export const UNDERSTANDING_MAX = 1000;

export const feishuMessageKey = (sourceMessageId: string) => `feishu-message:${sourceMessageId}`;
export const feishuReviseKey = (draftId: string, requestId: string) =>
  `feishu-revise:${draftId}:${requestId}`;

export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const MessagePayload = z.object({
  userId: z.string().min(1),
  textHash: z.string().min(1),
  replyToMessageId: z.string().min(1).optional(),
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('draft'), draftId: z.string().min(1) }),
    z.object({ kind: z.literal('answer'), text: z.string().min(1), taskId: z.string().min(1).optional() }),
  ]),
});

/** 写进幂等记录的样子。 */
export function messagePayload(message: FeishuMessageKey, result: FeishuMessageResult): unknown {
  return {
    userId: message.userId,
    textHash: message.textHash,
    ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
    result:
      result.kind === 'draft'
        ? { kind: 'draft', draftId: result.draftId }
        : {
            kind: 'answer',
            text: result.text,
            ...(result.taskId === undefined ? {} : { taskId: result.taskId }),
          },
  };
}

/** 读回幂等记录。认不出（被改坏、别的写法）就抛错：不能当成「没处理过」再处理一遍。 */
export function parseMessageRecord(sourceMessageId: string, raw: unknown, at: string): FeishuMessageRecord {
  const parsed = MessagePayload.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `飞书消息 ${sourceMessageId} 的幂等记录格式认不出：${parsed.error.message.slice(0, 200)}`,
    );
  }
  const p = parsed.data;
  return {
    sourceMessageId,
    userId: p.userId,
    textHash: p.textHash,
    replyToMessageId: p.replyToMessageId,
    result:
      p.result.kind === 'draft'
        ? { kind: 'draft', draftId: p.result.draftId }
        : { kind: 'answer', text: p.result.text, taskId: p.result.taskId },
    at,
  };
}

/** 截到 max 个字，截了就以「…」结尾。 */
export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** 按补充改「我理解为」：还没接模型理解，先把补充原样接在后面（超长截断）。 */
export function appendNote(understanding: string, note: string): string {
  return clip(`${understanding}\n补充：${note.trim()}`, UNDERSTANDING_MAX);
}
