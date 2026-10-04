// 收原话（#553 第 4 条）：把一条飞书消息变成后端「收原话」那条口的请求（shared 的 IntentIntakeMessageRequest）。
// 事件推来的和补漏翻历史翻出来的走同一份，两条路存下的原话一个样。
// 改这里之前必须知道：
// - 原话原样：文字用 SDK 归一化后的（@机器人 去掉、@别人 写成 @名字、富文本取文字），不截断；飞书给的原始 content
//   一个字不动地带上（后端靠它判同一条消息内容变没变）。
// - 非文字消息不丢、不悄悄跳过：写一句明说是什么的占位，原始 content 照带；SDK 也认不出的类型写「[认不出的消息类型 xxx]」。
// - 读不到发出时刻、原始内容的不拿别的顶（收到时刻、空串）：抛 IntakeShapeError，由调用方标「没记成」、等补漏从历史里取。
import type { IntentIntakeMessageRequest } from '@fleet-dao/shared';
import type { z } from 'zod';
import type { InboundMessage } from './port.ts';

export type IntakeBody = z.input<typeof IntentIntakeMessageRequest>;

/** 这条消息转不成「收原话」的请求（事件形状不对）：不是后端的错，补漏从飞书历史里能取到完整的再送。 */
export class IntakeShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntakeShapeError';
  }
}

/**
 * SDK（1.74.0）认得的消息类型：它的归一化给的字有意义（富文本取文字、合并转发展开、投票、日程……），照用。
 * 不在这里的，SDK 也只能回一句英文的 [unsupported message]，改写成「认不出」。升级 SDK 时对一下它的 converters 表。
 */
const SDK_KNOWN = new Set([
  'text',
  'post',
  'image',
  'file',
  'audio',
  'video',
  'media',
  'sticker',
  'interactive',
  'merge_forward',
  'share_chat',
  'share_user',
  'location',
  'system',
  'vote',
  'todo',
  'calendar',
  'general_calendar',
  'share_calendar_event',
  'folder',
  'hongbao',
  'video_chat',
]);

/** 媒体类：SDK 给的是 <file key=…/> 这类标签，换成一句给人看的占位；file_key 这些在原始 content 里。 */
function placeholder(msgType: string, raw: Record<string, unknown> | undefined): string | undefined {
  const name = typeof raw?.file_name === 'string' && raw.file_name.trim() ? ` ${raw.file_name.trim()}` : '';
  switch (msgType) {
    case 'image':
      return '[图片]';
    case 'file':
      return `[文件${name}]`;
    case 'folder':
      return `[文件夹${name}]`;
    case 'audio':
      return '[语音：飞书接口拿不到文字]';
    case 'video':
    case 'media':
      return `[视频${name}]`;
    case 'sticker':
      return '[表情包]';
    case 'share_chat':
      return '[分享的群名片]';
    case 'share_user':
      return '[分享的个人名片]';
    case 'hongbao':
      return '[红包]';
    default:
      return undefined;
  }
}

function parseRaw(rawContent: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(rawContent);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 存进「原话」的那段字。 */
export function intakeText(
  msg: Pick<InboundMessage, 'msgType' | 'text' | 'rawContent' | 'mentions'>,
): string {
  if (!SDK_KNOWN.has(msg.msgType)) return `[认不出的消息类型 ${msg.msgType}]`;
  const media = placeholder(msg.msgType, parseRaw(msg.rawContent));
  if (media !== undefined) return media;
  if (msg.msgType === 'merge_forward' && /^<forwarded_messages\/>$/.test(msg.text.trim())) {
    // SDK 读子消息失败时也只给这个空标签（它把错误吞了）：照实说没读出来，不装作转发了一段空的
    return '[合并转发：里面的消息没读出来（飞书接口失败或是空的），原话要去飞书里看]';
  }
  if (msg.text.trim() === '') {
    // 只 @了机器人、别的什么都没说：SDK 把 @机器人 去掉后是空的，存成原样的那个 @
    const bot = msg.mentions.find((m) => m.isBot);
    if (bot) return `@${bot.name?.trim() || '机器人'}`;
  }
  return msg.text;
}

/** 「@机器人 另起」：@了机器人、去掉那个 @ 后整句就是「另起」（语音输入常带一个句号，也算）。 */
export function isNewSegment(msg: Pick<InboundMessage, 'mentionedBot' | 'text'>): boolean {
  return msg.mentionedBot && /^另起[。.!！]?$/.test(msg.text.trim());
}

/** 一条飞书消息 → 收原话的请求。source：事件推来的、还是补漏翻出来的；editedAt：补漏时历史接口说改过（毫秒）。 */
export function toIntake(
  msg: InboundMessage,
  source: IntakeBody['source'],
  opts: { editedAt?: number | undefined } = {},
): IntakeBody {
  if (!Number.isFinite(msg.createTime) || msg.createTime <= 0) {
    throw new IntakeShapeError('飞书没给这条消息的发出时刻（create_time）');
  }
  if (!msg.msgType) throw new IntakeShapeError('飞书没给这条消息的类型（message_type）');
  if (!msg.rawContent) throw new IntakeShapeError('飞书没给这条消息的原始内容（content）');
  const parentId = msg.replyToMessageId || msg.rootId;
  const edited = opts.editedAt !== undefined && opts.editedAt > msg.createTime ? opts.editedAt : undefined;
  return {
    messageId: msg.messageId,
    chatId: msg.chatId,
    chatKind: msg.chatType,
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
    ...(parentId ? { parentId } : {}),
    sentAt: new Date(msg.createTime).toISOString(),
    ...(edited === undefined ? {} : { editedAt: new Date(edited).toISOString() }),
    source,
    msgType: msg.msgType,
    text: intakeText(msg),
    rawContent: msg.rawContent,
    atBot: msg.mentionedBot,
    newSegment: isNewSegment(msg),
  };
}
