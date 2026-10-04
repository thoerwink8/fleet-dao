// 假飞书（FeishuPort）：记下每个动作和时刻；同一个 uuid 只发一条（和飞书一样），能注入失败和延迟。
// 翻历史（补漏用）按测试摆好的页回：摆几页回几页，翻到头就 has_more=false。
import {
  type Card,
  FeishuError,
  type FeishuPort,
  type HistoryPage,
  type HistoryRequest,
  type InboundMessage,
  type OutMessage,
  type Sent,
  type Target,
} from '../src/port.ts';

export type Op = 'react' | 'send' | 'reply' | 'update' | 'pin' | 'unreact' | 'history';

export interface Call {
  op: Op;
  /** 距离 FakeFeishu 创建的毫秒数。 */
  at: number;
  messageId?: string;
  to?: Target;
  message?: OutMessage;
  card?: Card;
  uuid?: string;
  emoji?: string;
  /** react 成功时飞书回的 reaction_id。 */
  reactionId?: string;
  /** send / reply 成功时飞书回的消息编号。 */
  sentId?: string;
  /** unreact 撤的是哪个表情。 */
  unreactedId?: string;
  /** history 翻的是哪个容器、从什么时刻起。 */
  history?: HistoryRequest;
}

interface Stored {
  messageId: string;
  chatId: string;
  /** 当前内容：卡片或文字。 */
  message: OutMessage;
  /** 回复的是哪条。 */
  replyTo?: string;
}

export class FakeFeishu implements FeishuPort {
  readonly calls: Call[] = [];
  readonly messages = new Map<string, Stored>();
  /** 每个动作的下一次（或几次）失败。 */
  readonly failures: Partial<Record<Op, FeishuError[]>> = {};
  readonly delays: Partial<Record<Op, number>> = {};
  private readonly started = Date.now();
  private readonly byUuid = new Map<string, Sent>();
  private seq = 0;
  private reactionSeq = 0;
  /** 翻历史：按调用顺序一页页回（摆了几页给几页）；翻光了回一页空的（has_more=false）。 */
  private historyPages: HistoryPage[] = [];
  /** 已经撤掉的 reaction_id：reactionsOn 看的是还没撤的。 */
  private readonly unreacted = new Set<string>();

  /** 摆好补漏翻历史要回的页：一次 history() 消耗一页。 */
  scriptHistory(...pages: HistoryPage[]): void {
    this.historyPages = [...pages];
  }

  fail(op: Op, ...errors: FeishuError[]): void {
    this.failures[op] = [...(this.failures[op] ?? []), ...errors];
  }

  /** 和 Call.at 同一把尺子：距离创建的毫秒数。 */
  elapsed(): number {
    return Date.now() - this.started;
  }

  private async step(op: Op, fields: Omit<Call, 'op' | 'at'>): Promise<Call> {
    const call: Call = { op, at: Date.now() - this.started, ...fields };
    this.calls.push(call);
    const delay = this.delays[op];
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const err = this.failures[op]?.shift();
    if (err) throw err;
    return call;
  }

  private store(message: OutMessage, chatId: string, uuid: string, replyTo?: string): Sent {
    const known = this.byUuid.get(uuid);
    if (known) return known;
    this.seq += 1;
    const sent = { messageId: `om_fake_${this.seq}`, chatId };
    this.byUuid.set(uuid, sent);
    this.messages.set(sent.messageId, {
      messageId: sent.messageId,
      chatId,
      message,
      ...(replyTo ? { replyTo } : {}),
    });
    return sent;
  }

  async react(messageId: string, emojiType: string): Promise<string | undefined> {
    const call = await this.step('react', { messageId, emoji: emojiType });
    this.reactionSeq += 1;
    call.reactionId = `rx_fake_${this.reactionSeq}`;
    return call.reactionId;
  }

  /** 撤掉一个表情回应。撤掉了就从「这条消息上的表情」里摘掉（reactionsOn 看的是剩下的）。 */
  async unreact(messageId: string, reactionId: string): Promise<void> {
    await this.step('unreact', { messageId, unreactedId: reactionId });
    this.unreacted.add(reactionId);
  }

  /** 翻历史：按摆好的页一页页回（没摆就回空的）；记下这次翻的是哪个容器、从什么时刻起。 */
  async history(req: HistoryRequest): Promise<HistoryPage> {
    await this.step('history', { history: req });
    const page = this.historyPages.shift();
    return page ?? { messages: [], unrecognized: 0 };
  }

  /** 某条消息上现在加过的表情（按加的先后；撤掉的不算）。 */
  reactionsOn(messageId: string): string[] {
    return this.of('react')
      .filter((c) => c.messageId === messageId && c.reactionId !== undefined)
      .filter((c) => !this.unreacted.has(c.reactionId ?? ''))
      .map((c) => c.emoji ?? '');
  }

  /** 造一条历史里的消息（补漏测试用）。 */
  static historyMessage(o: {
    messageId: string;
    chatId: string;
    chatType?: InboundMessage['chatType'];
    senderId: string;
    text?: string;
    createTime: number;
    threadId?: string;
    rootId?: string;
    replyToMessageId?: string;
    fromBot?: boolean;
    msgType?: string;
    rawContent?: string;
  }): InboundMessage {
    return {
      messageId: o.messageId,
      chatId: o.chatId,
      chatType: o.chatType ?? 'p2p',
      senderId: o.senderId,
      text: o.text ?? '补漏补回来的话',
      msgType: o.msgType ?? 'text',
      rawContent: o.rawContent ?? JSON.stringify({ text: o.text ?? '补漏补回来的话' }),
      mentionedBot: false,
      mentions: [],
      ...(o.threadId ? { threadId: o.threadId } : {}),
      ...(o.rootId ? { rootId: o.rootId } : {}),
      ...(o.replyToMessageId ? { replyToMessageId: o.replyToMessageId } : {}),
      createTime: o.createTime,
      fromBot: o.fromBot ?? false,
    };
  }

  async send(to: Target, message: OutMessage, opts: { uuid: string }): Promise<Sent> {
    const call = await this.step('send', { to, message, uuid: opts.uuid });
    const chatId = 'chatId' in to ? to.chatId : `oc_p2p_${to.openId}`;
    const sent = this.store(message, chatId, opts.uuid);
    call.sentId = sent.messageId;
    return sent;
  }

  async reply(messageId: string, message: OutMessage, opts: { uuid: string }): Promise<Sent> {
    const call = await this.step('reply', { messageId, message, uuid: opts.uuid });
    const chatId = this.messages.get(messageId)?.chatId ?? 'oc_where_the_user_spoke';
    const sent = this.store(message, chatId, opts.uuid, messageId);
    call.sentId = sent.messageId;
    return sent;
  }

  async updateCard(messageId: string, card: Card): Promise<void> {
    await this.step('update', { messageId, card });
    const m = this.messages.get(messageId);
    // 不是这次测试里发的（例如重启前发的盘面卡）也记下现在的样子。
    if (m) m.message = { card };
    else this.messages.set(messageId, { messageId, chatId: 'oc_sent_before', message: { card } });
  }

  async pin(chatId: string, messageId: string): Promise<void> {
    await this.step('pin', { messageId, to: { chatId } });
  }

  // —— 看结果用 ——

  of(op: Op): Call[] {
    return this.calls.filter((c) => c.op === op);
  }

  /** 发出去的新消息（send + reply，按 uuid 去重后，和飞书群里实际多出来的条数一致）。 */
  newMessages(): Stored[] {
    return [...this.messages.values()];
  }

  /** 某条消息现在的卡片。 */
  cardOf(messageId: string): Card {
    const m = this.messages.get(messageId);
    if (!m || !('card' in m.message)) throw new Error(`${messageId} 不是卡片`);
    return m.message.card;
  }

  textOf(messageId: string): string {
    const m = this.messages.get(messageId);
    if (!m || !('text' in m.message)) throw new Error(`${messageId} 不是文字`);
    return m.message.text;
  }
}

export const tooOld = () => new FeishuError('too_old', '更新卡片：飞书返回 230031', { code: 230031 });
export const unavailable = () => new FeishuError('unavailable', '连不上飞书');

/** 卡片标题。 */
export function titleOf(card: Card): string {
  return String((card.header as { title: { content: string } }).title.content);
}

/** 卡片里所有给人看的文字，拼成一段（找字用）。 */
export function textIn(card: Card): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (o.tag === 'plain_text' && typeof o.content === 'string') out.push(o.content);
    for (const [k, v] of Object.entries(o)) if (k !== 'value') walk(v);
  };
  walk(card);
  return out.join('\n');
}

/** 卡片上的按钮：文字、是不是主按钮、回传值、链接。 */
export function buttonsOf(
  card: Card,
): Array<{ label: string; primary: boolean; value?: unknown; url?: string }> {
  const out: Array<{ label: string; primary: boolean; value?: unknown; url?: string }> = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (o.tag === 'button') {
      const behaviors = (o.behaviors as Array<Record<string, unknown>>) ?? [];
      const cb = behaviors.find((b) => b.type === 'callback');
      const url = behaviors.find((b) => b.type === 'open_url');
      out.push({
        label: String((o.text as { content: string }).content),
        primary: String(o.type).startsWith('primary'),
        ...(cb ? { value: cb.value } : {}),
        ...(url ? { url: String(url.default_url) } : {}),
      });
      return;
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(card);
  return out;
}
