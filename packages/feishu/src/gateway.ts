// 网关：收创始人在飞书里说的每一句、原样转给后端存成意图（#553 第 4 条，收原话），发意图卡（intent-cards.ts）；
// 外加自己看着自己（watch.ts：心跳、调不通后端报警）。旧的推送（outbox.ts）、盘面（board.ts）定时活还在跑。
// 收事件的回调一律立刻返回（SDK 按会话排队，回调慢了会挡住后面的人），活放到后台跑。
// 改这里之前必须知道：
// - 收谁的：允许的群里只收创始人的，别人说的在入口就丢（不转、不存、不记原文和长度）；私聊里的陌生人一天礼貌拒一次；
//   机器人的不收。谁是创始人只看 FEISHU_FOUNDERS，后端再按 users.feishu_open_id 认一遍（不是创始人回 403）。
// - 网关不判这句话是什么意思、归哪段：原样转，切段由后端定（packages/api/src/intents.ts）。
// - 「收到」表情只给私聊和 @机器人 的那句（2 秒内，不等后端）；群里对聊不逐句打扰。
// - 没存成要看得见：在那句上加「没记成」表情。连不上、超时、后端 5xx、事件残缺的，记下这个会话要补漏；
//   被拒（4xx）、后端回的认不出、请求过不了约定的，再送也一样，只记原因。
// - 飞书上不再有按钮和菜单能办的事：旧卡上的按钮、私聊菜单一律回一句「已停用」，不悄悄不理。
// - 日志不记原话正文，只记长度；「消息处理完」这几个字香港的 fleet-gateway-deploy status 在数，别改。

import { type Acting, type Backend, BackendError, type IntakeRecall, isTransient } from './backend.ts';
import { type Board, createBoard } from './board.ts';
import { ActionValueSchema } from './cards.ts';
import type { Founder } from './config.ts';
import { IntakeShapeError, toIntake } from './intake.ts';
import { createIntentCards } from './intent-cards.ts';
import type { Logger } from './log.ts';
import { createOutbox, type Outbox } from './outbox.ts';
import {
  type FeishuPort,
  type InboundCardAction,
  type InboundMenu,
  type InboundMessage,
  type InboundRecall,
  LATE_DELIVERY_MS,
  type OutMessage,
  type Sent,
  type Target,
} from './port.ts';
import { createRegistry, type Registry } from './registry.ts';
import { Inflight, Lru, uuidFor } from './util.ts';
import { createWatch, type Watch, type WatchLimits } from './watch.ts';
import { beijingDay, clip } from './words.ts';

/** 设计目标：先回应 ≤2 秒。超了记日志并计数，网关心跳里带上（watch.ts；端到端巡检按它判黄）。 */
export const TARGET_ACK_MS = 2_000;

/** 没存成的那句话上加的表情（飞书 emoji_type：❌）。 */
export const NOT_STORED_EMOJI = 'CrossMark';

export interface Timing {
  /** 收原话一次最多等后端多久（方案 5.4：5 秒）。 */
  intakeMs: number;
  /** 长轮询待推送、意图卡一次最多等几秒。 */
  outboxWaitSeconds: number;
  /** 补漏：一轮里一个会话最多翻几页历史（一页 HISTORY_PAGE_SIZE 条）；翻不完下一轮接着翻。 */
  backfillPages: number;
  /** 补漏没走通（后端连不上、飞书翻不动）之后隔多久再试。 */
  backfillRetryMs: number;
}

export const DEFAULT_TIMING: Timing = {
  intakeMs: 5_000,
  outboxWaitSeconds: 25,
  backfillPages: 5,
  backfillRetryMs: 60_000,
};

/** 补漏时给后端游标留的余量：游标那一刻上的那条可能正好是边界，往前多翻一点不会重（同一条再来后端认重放）。 */
const CURSOR_SLACK_MS = 5 * 60_000;

/** 一个会话最多补多久以前的话：网关重启、长期断线时，翻一小时前的老账没有意义。 */
export const BACKFILL_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** 没存成、等补漏的会话。 */
export interface MissedChat {
  chatId: string;
  chatKind: 'p2p' | 'group';
  /** 最早一句没存成的发出时刻（毫秒）：补漏从它和后端游标里更早的那个起翻。 */
  sinceMs: number;
  /** 没存成的话在哪几个话题里：按会话翻历史只给话题的根消息，这几个要另外按话题翻。 */
  threadIds: Set<string>;
}

/** 加在没存成的那句上的「没记成」表情：补上了要撤掉（换成正常）。 */
export interface NotStoredMark {
  messageId: string;
  chatId: string;
  /** 飞书给的 reaction_id；没给就撤不掉。 */
  reactionId: string | undefined;
}

export interface GatewayOptions {
  feishu: FeishuPort;
  backend: Backend;
  log: Logger;
  now?: () => number;
  founders: Founder[];
  teamChatId: string;
  testChatId?: string | null;
  publicUrl: string;
  ackEmoji: string;
  askBudgetPerDay: number;
  boardRefreshMs: number;
  timing?: Partial<Timing>;
  /** 网关自己看守的时限（watch.ts 的 WATCH_LIMITS）；测试调小。 */
  watch?: Partial<WatchLimits>;
}

export interface Gateway {
  onMessage(msg: InboundMessage): void;
  onRecall(evt: InboundRecall): void;
  onCardAction(evt: InboundCardAction): void;
  onMenu(evt: InboundMenu): void;
  /** SDK 的策略层拦下的消息（不在允许的群）：只计数，不回话。 */
  onReject(evt: { messageId: string; chatId: string; senderId: string; reason: string }): void;
  /** 开始定时取盘面、长轮询待推送和意图卡，和网关自己的看守（心跳、调不通后端报警）。 */
  start(): void;
  /** 停止定时活，最多等 drainMs 让在途的活做完。 */
  stop(drainMs?: number): Promise<void>;
  /** 测试用：等手上的活都做完。 */
  idle(): Promise<void>;
  /** 没存成、等补漏的会话，和加在那几句上的「没记成」表情、没转成的撤回。 */
  readonly missed: {
    chats(): MissedChat[];
    marks(): NotStoredMark[];
    recalls(): IntakeRecall[];
  };
  /** 补漏一轮（起来时、后端从连不上变连得上时、定时；测试直接调）。同时刻只跑一轮。 */
  backfill(reason: string): Promise<void>;
  readonly stats: Readonly<Record<string, number>>;
  readonly board: Board;
  readonly outbox: Outbox;
  readonly registry: Registry;
  readonly watch: Watch;
}

const DECLINE = '你好，我是 fleet-dao 的机器人，只替两位创始人办事。这条我没有记下，有事请直接找他们。';
const ONLY_WORDS = '飞书现在只收原话：直接说话就行，私聊、群里都收（群里不用 @我），对题时指挥官一条条读';

export function createGateway(o: GatewayOptions): Gateway {
  const now = o.now ?? Date.now;
  const timing: Timing = { ...DEFAULT_TIMING, ...o.timing };
  const log = o.log;
  const founders = new Map(o.founders.map((f) => [f.openId, f]));
  const allowedGroups = new Set([o.teamChatId, ...(o.testChatId ? [o.testChatId] : [])]);
  /** 见过的创始人私聊会话：撤回事件不带会话种类，只转这些和允许的群里的。 */
  const founderChats = new Set<string>();
  const missedChats = new Map<string, MissedChat>();
  const notStoredMarks = new Map<string, NotStoredMark>();
  const missedRecalls = new Map<string, IntakeRecall>();
  const stats: Record<string, number> = {};
  const count = (key: string) => {
    stats[key] = (stats[key] ?? 0) + 1;
  };
  const inflight = new Inflight((err) => {
    count('unhandled');
    log.error('后台活出了没接住的错', {
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  });
  const life = new AbortController();
  const registry = createRegistry({ backend: o.backend, log, inflight });
  const watch = createWatch({
    feishu: o.feishu,
    log,
    now,
    teamChatId: o.teamChatId,
    publicUrl: o.publicUrl,
    // 免打扰时段只有推送那条从后端带回来：连不上后端时用最近一次拿到的
    quietHours: () => outbox.quietHours(),
    boardRefreshMs: o.boardRefreshMs,
    ackTargetMs: TARGET_ACK_MS,
    limits: o.watch,
  });
  const board = createBoard({
    backend: o.backend,
    feishu: o.feishu,
    registry,
    log,
    now,
    teamChatId: o.teamChatId,
    publicUrl: o.publicUrl,
    watch,
  });
  const outbox = createOutbox({
    backend: o.backend,
    feishu: o.feishu,
    registry,
    log,
    now,
    teamChatId: o.teamChatId,
    founders: new Set(founders.keys()),
    publicUrl: o.publicUrl,
    askBudgetPerDay: o.askBudgetPerDay,
    waitSeconds: timing.outboxWaitSeconds,
    watch,
  });
  /** 意图卡（#553 第 4 条）：长轮询后端要发、要改的意图卡，回复在那段第一条原话下面、之后原地改。 */
  const intentCards = createIntentCards({
    backend: o.backend,
    feishu: o.feishu,
    log,
    now,
    waitSeconds: timing.outboxWaitSeconds,
    watch,
  });
  const seenMenuEvents = new Lru<string, true>(500);
  /** 陌生人每人每天只回一次，免得和别的机器人来回刷。 */
  const declined = new Lru<string, string>(1000);
  /** 「已停用」每张旧卡、每个点菜单的人每天只说一次。 */
  const toldDisabled = new Lru<string, string>(1000);
  /** 上一句原话是不是没存下（后端连不上、超时、5xx）：连着没存下就不每句都触发一次补漏。 */
  let wasDown = false;

  const as = (f: Founder): Acting => ({ openId: f.openId });

  // —— 往飞书发东西：出错记日志、计数，不往上抛（回调里没人接）——

  async function reply(messageId: string, message: OutMessage, key: string): Promise<Sent | null> {
    try {
      return await o.feishu.reply(messageId, message, { uuid: uuidFor('reply', messageId, key) });
    } catch (err) {
      count('feishu_failed');
      log.error('回复没发出去', { messageId, key, error: String(err) });
      return null;
    }
  }

  async function send(to: Target, message: OutMessage, key: string): Promise<Sent | null> {
    try {
      return await o.feishu.send(to, message, { uuid: uuidFor('send', JSON.stringify(to), key) });
    } catch (err) {
      count('feishu_failed');
      log.error('消息没发出去', { key, error: String(err) });
      return null;
    }
  }

  async function decline(openId: string, replyTo?: string): Promise<void> {
    const day = beijingDay(now());
    if (declined.get(openId) === day) return;
    declined.set(openId, day);
    log.info('不在白名单，礼貌拒绝', { openId });
    if (replyTo) await reply(replyTo, { text: DECLINE }, 'decline');
    else await send({ openId }, { text: DECLINE }, `decline:${day}`);
  }

  // —— 消息 ——

  /**
   * 先回「收到」：加表情，加不上改回一句「收到」。返回从收到这条到回上花了多久（改回的那句也算）；都没回上是 null。
   * 超过 2 秒计一次（ack_slow），每条都记给看守，心跳里带上。
   */
  async function ack(msg: InboundMessage, receivedAt: number): Promise<number | null> {
    let ms: number | null;
    try {
      await o.feishu.react(msg.messageId, o.ackEmoji);
      ms = now() - receivedAt;
    } catch (err) {
      count('ack_failed');
      log.error('表情回应没加上，改回一句「收到」', { messageId: msg.messageId, error: String(err) });
      ms = (await reply(msg.messageId, { text: '收到。' }, 'ack')) ? now() - receivedAt : null;
    }
    watch.acked(ms);
    if (ms !== null && ms > TARGET_ACK_MS) {
      count('ack_slow');
      log.warn('「收到」超过 2 秒', { messageId: msg.messageId, ms });
    }
    return ms;
  }

  /** 记下这个会话要补漏：从最早一句没存成的起翻；在话题里的，那个话题另外翻。 */
  function wantBackfill(
    chatId: string,
    chatKind: MissedChat['chatKind'],
    sinceMs: number,
    threadId?: string,
  ) {
    const known = missedChats.get(chatId);
    const chat = known ?? { chatId, chatKind, sinceMs, threadIds: new Set<string>() };
    chat.sinceMs = Math.min(chat.sinceMs, sinceMs);
    if (threadId) chat.threadIds.add(threadId);
    if (!known) missedChats.set(chatId, chat);
  }

  /** 在那句上加「没记成」表情；加不上记错误（没有别的地方能让人看见了）。keep：补上了要撤掉的，记下表情编号。 */
  async function markNotStored(msg: InboundMessage, keep: boolean): Promise<void> {
    try {
      const reactionId = await o.feishu.react(msg.messageId, NOT_STORED_EMOJI);
      if (keep)
        notStoredMarks.set(msg.messageId, { messageId: msg.messageId, chatId: msg.chatId, reactionId });
    } catch (err) {
      count('not_stored_mark_failed');
      log.error('「没记成」表情没加上', { messageId: msg.messageId, error: clip(String(err), 300) });
    }
  }

  /** 收原话：原样转后端（代表说这句话的那位创始人）。没存成在那句上加「没记成」，暂时的毛病记下要补漏。 */
  async function intake(msg: InboundMessage, founder: Founder, receivedAt: number): Promise<void> {
    // 「收到」只给私聊和 @机器人 的：群里两个人对聊，不逐句打扰
    const acked = msg.chatType === 'p2p' || msg.mentionedBot ? ack(msg, receivedAt) : Promise.resolve(null);
    let outcome = 'failed';
    let intentSeq: number | undefined;
    let textLength: number | undefined;
    try {
      // 不挂停机信号：停机时手上的调用照样等它回来（有超时），做完再退。
      const body = toIntake(msg, 'event');
      textLength = body.text.length;
      const r = await o.backend.intake(as(founder), body, { timeoutMs: timing.intakeMs });
      outcome = r.status;
      intentSeq = r.intentSeq;
      watch.intake(true);
      // 后端从连不上变连得上：手上这句子存下了，把之前没存成的也补上
      if (wasDown && missedChats.size > 0) void backfill('recovered');
      wasDown = false;
    } catch (err) {
      watch.intake(false);
      // 连不上、超时、后端出错、事件残缺：飞书那边原话还在，补漏能补上；
      // 被拒（4xx）、后端回的认不出、请求过不了约定的，再送也一样，只记原因
      const later = isTransient(err) || err instanceof IntakeShapeError;
      if (isTransient(err)) wasDown = true;
      count(later ? 'intake_failed' : 'intake_refused');
      log.error(later ? '原话没存成：记下这个会话要补漏' : '原话后端没收下（再送也一样，不补漏）', {
        messageId: msg.messageId,
        chatId: msg.chatId,
        chatType: msg.chatType,
        ...(err instanceof BackendError ? { kind: err.kind, status: err.status, code: err.code } : {}),
        error: clip(String(err), 300),
      });
      if (later) {
        // 没有发出时刻的（事件残缺）按飞书最晚会推迟多久往前翻，不拿收到时刻顶
        const since = msg.createTime > 0 ? msg.createTime : receivedAt - LATE_DELIVERY_MS;
        wantBackfill(msg.chatId, msg.chatType, since, msg.threadId);
      }
      await markNotStored(msg, later);
    } finally {
      const ackMs = await acked;
      // 「消息处理完」这几个字香港的 fleet-gateway-deploy status 在数（deploy/hk/fleet-gateway-deploy.sh 的 MESSAGE_MARK），别改
      log.info('消息处理完', {
        messageId: msg.messageId,
        chatType: msg.chatType,
        path: 'intake',
        outcome,
        ...(intentSeq === undefined ? {} : { intentSeq }),
        ...(textLength === undefined ? {} : { textLength }),
        ackMs,
        totalMs: now() - receivedAt,
        // 飞书从用户发出到推给网关花了多久（网关重启、长连接断过时会很长）
        deliveryMs: msg.createTime > 0 ? receivedAt - msg.createTime : null,
      });
    }
  }

  /** 撤回：转给后端标上（行不删，不再进单子的原话栏）。没转成的记下，补漏时再转。 */
  async function recall(evt: InboundRecall): Promise<void> {
    const body: IntakeRecall = {
      messageId: evt.messageId,
      chatId: evt.chatId,
      recalledAt: new Date(evt.recalledAt).toISOString(),
      source: 'event',
    };
    try {
      const r = await o.backend.intakeRecall(body, { timeoutMs: timing.intakeMs });
      count(`recall_${r.status}`);
      log.info('撤回已转后端', {
        messageId: evt.messageId,
        chatId: evt.chatId,
        status: r.status,
        ...(r.intentSeq === undefined ? {} : { intentSeq: r.intentSeq }),
      });
    } catch (err) {
      const later = isTransient(err);
      count(later ? 'recall_failed' : 'recall_refused');
      log.error(later ? '撤回没转成：补漏时再转' : '撤回后端没收下（再送也一样）', {
        messageId: evt.messageId,
        chatId: evt.chatId,
        ...(err instanceof BackendError ? { kind: err.kind, status: err.status, code: err.code } : {}),
        error: clip(String(err), 300),
      });
      if (later) missedRecalls.set(evt.messageId, body);
    }
  }

  // —— 补漏（#553 第 4 条）：没存成的会话，从后端给的游标往后翻飞书历史，按原顺序补送 ——

  /**
   * 翻一个会话（和它里面没存成的那几个话题）的历史，把认得出的一条条补送给后端。
   * 返回补上了几条、没补成几条（没补成的不动它的「没记成」标记，下一轮再来）。
   */
  async function backfillChat(
    cursor: { chatId: string; chatKind: MissedChat['chatKind']; sinceMs: number; threadIds: string[] },
  ): Promise<{ filled: number; failed: number }> {
    let filled = 0;
    let failed = 0;
    // 一个会话翻一遍，里面的话题再各翻一遍（飞书按会话翻只给话题的根消息，话题里的回复要按话题翻）
    const containers: Array<{ id: string; container: 'chat' | 'thread' }> = [
      { id: cursor.chatId, container: 'chat' },
      ...cursor.threadIds.map((id) => ({ id, container: 'thread' as const })),
    ];
    for (const c of containers) {
      let pageToken: string | undefined;
      for (let page = 0; page < timing.backfillPages; page++) {
        const got = await o.feishu.history({
          containerId: c.id,
          container: c.container,
          chatKind: cursor.chatKind,
          sinceMs: cursor.sinceMs,
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        if (got.unrecognized > 0) {
          count('backfill_unrecognized');
          log.error('补漏翻到的历史里有认不出的行：跳过这些', {
            chatId: c.id,
            container: c.container,
            count: got.unrecognized,
          });
        }
        // 按发出时刻从早到晚补送，后端按编号认重放
        for (const msg of [...got.messages].sort((a, b) => a.createTime - b.createTime)) {
          const one = await backfillOne(msg, cursor.chatKind);
          if (one === 'filled') filled += 1;
          else if (one === 'failed') failed += 1;
        }
        if (got.nextPageToken === undefined) break;
        pageToken = got.nextPageToken;
        if (page + 1 === timing.backfillPages) {
          // 这一轮翻不完：下一轮接着翻（until 之后，游标由「现在到哪儿」重新算）
          count('backfill_page_limit');
          log.warn('补漏一轮翻不完，下一轮接着翻', {
            chatId: c.id,
            container: c.container,
            since: new Date(cursor.sinceMs).toISOString(),
          });
        }
      }
    }
    return { filled, failed };
  }

  /** 补一条：认得出、是创始人的、还没存下的，就送；送成了撤掉那句上的「没记成」，返回结果。 */
  async function backfillOne(
    msg: InboundMessage,
    chatKind: MissedChat['chatKind'],
  ): Promise<'filled' | 'failed' | 'skipped'> {
    if (msg.fromBot) return 'skipped';
    if (!allowedGroups.has(msg.chatId) && chatKind === 'group') return 'skipped';
    const founder = founders.get(msg.senderId);
    if (!founder) return 'skipped';
    let body: ReturnType<typeof toIntake>;
    try {
      body = toIntake(msg, 'backfill', { editedAt: msg.editedAt });
    } catch (err) {
      // 历史里这一行缺东西：不拿空顶，记下来（下一次翻到还是这样，就还是补不上）
      count('backfill_shape');
      log.error('补漏翻到的这条转不成原话（缺发出时刻、类型或原始内容）', {
        messageId: msg.messageId,
        chatId: msg.chatId,
        error: clip(String(err), 300),
      });
      return 'skipped';
    }
    try {
      const r = await o.backend.intake(as(founder), body, { timeoutMs: timing.intakeMs });
      count(`backfill_${r.status}`);
      const mark = notStoredMarks.get(msg.messageId);
      if (mark) {
        // 补上了：把「没记成」撤掉（撤不掉只记一笔，下一轮来这条是重放，不会再撤）
        await clearNotStored(mark);
        notStoredMarks.delete(msg.messageId);
      }
      return 'filled';
    } catch (err) {
      count('backfill_failed');
      log.error('补漏这一条没补上', {
        messageId: msg.messageId,
        chatId: msg.chatId,
        ...(err instanceof BackendError ? { kind: err.kind, status: err.status, code: err.code } : {}),
        error: clip(String(err), 300),
      });
      return 'failed';
    }
  }

  /** 撤掉那双「没记成」的表情。撤不掉（飞书没回 reaction_id、消息撤回了、接口出错）只记一笔。 */
  async function clearNotStored(mark: NotStoredMark): Promise<void> {
    if (!mark.reactionId) {
      count('not_stored_clear_impossible');
      log.warn('「没记成」撤不掉：飞书当时没回 reaction_id', { messageId: mark.messageId });
      return;
    }
    try {
      await o.feishu.unreact(mark.messageId, mark.reactionId);
      count('not_stored_cleared');
    } catch (err) {
      count('not_stored_clear_failed');
      log.warn('「没记成」没撤掉（那条消息可能撤回了）', {
        messageId: mark.messageId,
        error: clip(String(err), 300),
      });
    }
  }

  let backfillRun: Promise<void> | null = null;
  let backfillFailedAt: number | null = null;

  /**
   * 补漏一轮：问后端每个会话存到哪了、把没存成的那几句翻回来补上、顺带再补一次没转成的撤回。
   * 同时刻只跑一轮；上一轮没走通的话，退避一段时间再跑。后端连不上就自己记一笔，下一轮再来。
   */
  function backfill(reason: string): Promise<void> {
    if (backfillRun) return backfillRun;
    if (backfillFailedAt !== null && now() - backfillFailedAt < timing.backfillRetryMs) return Promise.resolve();
    backfillRun = (async () => {
      try {
        await runBackfill(reason);
        backfillFailedAt = null;
      } catch (err) {
        backfillFailedAt = now();
        count('backfill_failed_round');
        log.error('补漏这一轮没走通，过一阵再试', {
          reason,
          error: clip(String(err), 300),
        });
      } finally {
        backfillRun = null;
      }
    })();
    return backfillRun;
  }

  async function runBackfill(reason: string): Promise<void> {
    const startedAt = now();
    const cursors = await o.backend.intakeCursors(undefined, { timeoutMs: timing.intakeMs });
    const byChat = new Map(cursors.chats.filter((c) => c.known).map((c) => [c.chatId, c]));

    // 要补的会话：没存成过的（missedChats），全部按后端游标往后翻（后端知道最晚存到哪）
    const wanted = [...missedChats.values()].map((chat) => ({ chat, cursor: byChat.get(chat.chatId) }));
    // 没存成过、后端也没游标的（第一句就没存下）：从最早那句往前翻，最多翻 BACKFILL_MAX_AGE_MS
    const floor = startedAt - BACKFILL_MAX_AGE_MS;

    let filled = 0;
    let failed = 0;
    for (const { chat, cursor } of wanted) {
      const sinceMs = Math.max(
        floor,
        Math.min(chat.sinceMs, (cursor?.known ? Date.parse(cursor.lastSentAt) - CURSOR_SLACK_MS : chat.sinceMs)),
      );
      try {
        const one = await backfillChat({
          chatId: chat.chatId,
          chatKind: chat.chatKind,
          sinceMs,
          threadIds: [...chat.threadIds],
        });
        filled += one.filled;
        failed += one.failed;
        // 补完了这个会话的账：清掉要补漏的标记（没补上的留下，下一轮再来）
        missedChats.delete(chat.chatId);
      } catch (err) {
        failed += 1;
        count('backfill_chat_failed');
        log.error('补漏翻这个会话的历史没翻成，下一轮再来', {
          chatId: chat.chatId,
          error: clip(String(err), 300),
        });
        // 翻不动就留着，下一轮再来；但整轮按没走通算（退避）
        throw err;
      }
    }

    // 没转成的撤回也再转一次
    let recalls = 0;
    for (const [messageId, body] of missedRecalls) {
      try {
        await o.backend.intakeRecall(body, { timeoutMs: timing.intakeMs });
        missedRecalls.delete(messageId);
        recalls += 1;
      } catch (err) {
        log.warn('补转撤回没成，下一轮再来', { messageId, error: clip(String(err), 300) });
      }
    }

    watch.backfill(filled, failed);
    if (filled > 0 || failed > 0 || recalls > 0) {
      log.info('补漏走完一轮', {
        reason,
        chats: wanted.length,
        filled,
        failed,
        recalls,
        ms: now() - startedAt,
      });
    }
  }

  // —— 旧卡上的按钮、私聊菜单：都停用了，回一句说清楚 ——

  async function buttonDisabled(evt: InboundCardAction): Promise<void> {
    const parsed = ActionValueSchema.safeParse(evt.value);
    // 记下点的是哪种旧按钮（不记回传值里的别的东西）：看得出还有谁在点什么
    const action = parsed.success ? parsed.data.a : 'unknown';
    count('disabled_button');
    log.info('有人点了旧卡上的按钮：已停用', { messageId: evt.messageId, action });
    const day = beijingDay(now());
    if (toldDisabled.get(`card:${evt.messageId}`) === day) return;
    toldDisabled.set(`card:${evt.messageId}`, day);
    await reply(
      evt.messageId,
      { text: `这张卡上的按钮已经停用：${ONLY_WORDS}。要拍板、要回答的在驾驶舱：${o.publicUrl}` },
      `disabled:${day}`,
    );
  }

  async function menuDisabled(evt: InboundMenu, founder: Founder): Promise<void> {
    count('disabled_menu');
    log.info('有人点了旧菜单：已停用', { key: clip(evt.key, 40) });
    const day = beijingDay(now());
    if (toldDisabled.get(`menu:${founder.openId}`) === day) return;
    toldDisabled.set(`menu:${founder.openId}`, day);
    await send(
      { openId: founder.openId },
      { text: `这个菜单已经停用：${ONLY_WORDS}。盘面、待办在驾驶舱：${o.publicUrl}` },
      `menu-disabled:${day}`,
    );
  }

  let boardTimer: NodeJS.Timeout | undefined;
  let watchTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let backfillTimer: NodeJS.Timeout | undefined;
  let ticking: Promise<void> | null = null;
  let outboxRun: Promise<void> | null = null;
  let intentCardsRun: Promise<void> | null = null;

  function tick(): void {
    if (ticking) return;
    ticking = board
      .tick()
      .catch((err) => log.error('盘面定时活出错', { error: String(err) }))
      .finally(() => {
        ticking = null;
      });
  }

  return {
    onMessage(msg) {
      const receivedAt = now();
      if (msg.fromBot) {
        count('ignored_bot');
        return;
      }
      if (msg.chatType === 'group' && !allowedGroups.has(msg.chatId)) {
        count('ignored_group');
        log.warn('不在允许的群里，不理', { chatId: msg.chatId });
        return;
      }
      const founder = founders.get(msg.senderId);
      if (!founder) {
        if (msg.chatType === 'group') {
          // 允许的群里别人说的：入口就丢，不转、不存、不回话，日志里也不记原文和长度（方案 5.6）
          count('dropped_not_founder');
          log.info('群里有不是创始人的人说话：没转、没存', {
            chatId: msg.chatId,
            sender: `…${msg.senderId.slice(-4)}`,
          });
          return;
        }
        count('stranger');
        inflight.track(decline(msg.senderId, msg.messageId));
        return;
      }
      if (msg.chatType === 'p2p') founderChats.add(msg.chatId);
      inflight.track(intake(msg, founder, receivedAt));
    },

    onRecall(evt) {
      // 撤回事件不带会话种类：只转允许的群和见过的创始人私聊里的，别处的不碰
      if (!allowedGroups.has(evt.chatId) && !founderChats.has(evt.chatId)) {
        count('recall_ignored');
        return;
      }
      inflight.track(recall(evt));
    },

    onCardAction(evt) {
      if (!founders.has(evt.operatorId)) {
        count('stranger');
        inflight.track(decline(evt.operatorId));
        return;
      }
      inflight.track(buttonDisabled(evt));
    },

    onMenu(evt) {
      if (evt.eventId) {
        if (seenMenuEvents.has(evt.eventId)) {
          count('menu_duplicate');
          return;
        }
        seenMenuEvents.set(evt.eventId, true);
      }
      const founder = founders.get(evt.operatorId);
      if (!founder) {
        count('stranger');
        inflight.track(decline(evt.operatorId));
        return;
      }
      inflight.track(menuDisabled(evt, founder));
    },

    onReject(evt) {
      count(`rejected_${evt.reason}`);
      log.info('SDK 策略拦下的消息', { reason: evt.reason, chatId: evt.chatId });
    },

    start() {
      tick();
      boardTimer = setInterval(tick, o.boardRefreshMs);
      outboxRun = outbox.run(life.signal).catch((err) => log.error('推送循环停了', { error: String(err) }));
      intentCardsRun = intentCards
        .run(life.signal)
        .catch((err) => log.error('意图卡循环停了', { error: String(err) }));
      watchTimer = setInterval(() => void watch.check(), watch.limits.checkEveryMs);
      heartbeatTimer = setInterval(() => watch.heartbeat(), watch.limits.heartbeatMs);
      // 补漏：起来就翻一遍（重启、长连接断过时丢的话补上），之后每隔 backfillRetryMs 看一眼有没有要补的
      void backfill('start');
      backfillTimer = setInterval(() => void backfill('tick'), timing.backfillRetryMs);
    },

    async stop(drainMs = 20_000) {
      clearInterval(boardTimer);
      clearInterval(watchTimer);
      clearInterval(heartbeatTimer);
      clearInterval(backfillTimer);
      life.abort();
      await outboxRun;
      await intentCardsRun;
      await ticking;
      await watch.idle();
      await backfillRun;
      const left = await inflight.drain(drainMs);
      if (left > 0) log.warn('停机时还有活没做完', { left });
      // 停机前把这一段的心跳也写上：重启时不丢最后几分钟的读数
      if (watchTimer) watch.heartbeat();
    },

    idle: () => inflight.idle(),
    missed: {
      chats: () => [...missedChats.values()].map((c) => ({ ...c, threadIds: new Set(c.threadIds) })),
      marks: () => [...notStoredMarks.values()],
      recalls: () => [...missedRecalls.values()],
    },
    backfill: (reason) => backfill(reason),
    stats,
    board,
    outbox,
    registry,
    watch,
  };
}
