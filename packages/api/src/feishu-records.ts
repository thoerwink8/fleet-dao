// 两个 Store 共用的飞书记录写法：收到的话的幂等记录（存在 idempotency_keys 的 result 里）、改草稿时怎么追加补充、
// 进来的话怎么规范化。
import { createHash } from 'node:crypto';
import { FEISHU_NOTE_MAX } from '@fleet-dao/shared';
import { z } from 'zod';
import type { FeishuMessageKey, FeishuMessageRecord, FeishuMessageResult } from './ports.ts';

/** 「我理解为」最长多少字（shared/feishu-api.ts 的 FeishuDraftSchema.understanding）。 */
export const UNDERSTANDING_MAX = 1000;

/** 「改一下」的补充接在原话和「我理解为」后面的样子。 */
export const NOTE_MARKER = '\n补充：';

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

/**
 * 截到 max 个字（按 UTF-16 数，和约定里 zod 的 max 同一个数法），截了就以「…」结尾。
 * 不截在代理对中间（emoji 这类）：半个代理对写进 jsonb 会被库整条拒收。
 */
export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  let end = max - 1;
  const last = t.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${t.slice(0, end)}…`;
}

/**
 * 按补充改草稿（还没接模型理解）：补充整句接在原话后面（原话没有长度上限，开单时整段交出去，一个字不丢）；
 * 「我理解为」也整句接上，放不下时截旧的理解（截掉的原话里都有），不截新补的这句。
 * 新补的超过 FEISHU_NOTE_MAX（约定里的上限）放不下：接口层先拒，走到这里算写错了代码，抛错。
 */
export function withNote(
  draft: { rawText: string; understanding: string },
  note: string,
): { rawText: string; understanding: string } {
  const fresh = note.trim();
  if (fresh.length === 0 || fresh.length > FEISHU_NOTE_MAX) {
    throw new Error(`补充要 1–${FEISHU_NOTE_MAX} 字，接口层应当先拒（这次 ${fresh.length} 字）`);
  }
  const added = `${NOTE_MARKER}${fresh}`;
  return {
    rawText: `${draft.rawText}${added}`,
    understanding: `${clip(draft.understanding, UNDERSTANDING_MAX - added.length)}${added}`,
  };
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * 把孤立的半个代理对（emoji 被截成两半）换成 U+FFFD，报出换了几处。飞书这边进来的话在入口统一过一遍：
 * 不换的话，写进 text 列时驱动会悄悄换掉（和原话、幂等摘要对不上），写进 jsonb（操作记录）时整条被库拒收。
 */
export function wellFormed(text: string): { text: string; replaced: number } {
  let replaced = 0;
  const out = text.replace(LONE_SURROGATE, () => {
    replaced += 1;
    return '�';
  });
  return { text: out, replaced };
}
