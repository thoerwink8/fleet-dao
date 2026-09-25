// 推送的唯一出口：从后端长轮询「待推送」，每件事只发一张卡，之后按 revision 原地更新，不重发。
// 这里执行四道闸：种类白名单（三类 + 关注 + AI 追问）、私聊只发创始人、免打扰、每天求人卡的预算。
// 送达只认飞书回的 message_id，回执写回后端（驾驶舱「通知」页的送达记录就是它）。
// 回执送不上去时不许原地打转：一轮没走通就抛错，run() 退避；积压的回执按「条目 + 版本」去重、有上限。
// 后端收下回执后又把同一版给回来（了结了的，或推迟 / 没发成、还没到约定时刻的）：不再处理、不碰飞书，报错并退避。
import { FeishuOutboxAckSchema } from '@fleet-dao/shared';
import { type Backend, BackendError, type OutboxAck, type OutboxBatch, type OutboxItem } from './backend.ts';
import { budgetAlertCard, outboxCard, type RenderContext } from './cards.ts';
import { DailyBudget, quietUntil } from './gate.ts';
import type { Logger } from './log.ts';
import { CARD_EDITABLE_MS, type FeishuPort, feishuErrorKind, type Target } from './port.ts';
import type { Registry } from './registry.ts';
import { Lru, nextNonce, sleep, uuidFor } from './util.ts';
import { beijingDay, clip } from './words.ts';

const KINDS = new Set<OutboxItem['kind']>(['decision', 'alert', 'daily', 'follow', 'ask']);
/** 占「求人」预算的种类。 */
const ASKING = new Set<OutboxItem['kind']>(['decision', 'ask']);
const RETRY_AFTER_MS = 60_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** 积压回执的上限：后端长时间不收，超了丢最早的并记错误（丢了的那几件，网关重启后可能重发卡）。 */
const MAX_PENDING_ACKS = 500;

type AckResult = OutboxAck['result'];

/** 这一轮没走通（回执送不上去、后端重复给已经回执过的），run() 据此退避。 */
export class OutboxStall extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'OutboxStall';
  }
}

export interface OutboxDeps {
  backend: Backend;
  feishu: FeishuPort;
  registry: Registry;
  log: Logger;
  now: () => number;
  teamChatId: string;
  founders: ReadonlySet<string>;
  publicUrl: string;
  askBudgetPerDay: number;
  /** 长轮询一次最多等几秒。 */
  waitSeconds?: number;
  maxPendingAcks?: number;
}

export interface Outbox {
  /** 取一批、处理、回执，返回这批有几件。回执没送成、或后端重复给已回执过的，抛 OutboxStall（调用方退避）。 */
  runOnce(signal?: AbortSignal): Promise<number>;
  /** 一直跑到 signal 叫停；一轮没走通就退避重试（1、2、5、10、30 秒）。 */
  run(signal: AbortSignal): Promise<void>;
  /** 按钮一点先在本地把卡改掉（已回答、已叫停……）。不是推送卡或重启后缓存没了返回 false，等后端下一版推过来。 */
  overlay(messageId: string, o: { doneText?: string; note?: string }): Promise<boolean>;
}

export function createOutbox(deps: OutboxDeps): Outbox {
  const waitSeconds = deps.waitSeconds ?? 25;
  const budget = new DailyBudget(deps.askBudgetPerDay);
  /** 每件事最近一次发到哪、回的什么：回执没送到后端时，同一版再来直接复用，不再动飞书。 */
  const sent = new Lru<
    string,
    { messageId: string; chatId: string; sentAt: number; revision: number; ack: AckResult }
  >(2000);
  const byMessage = new Lru<string, OutboxItem>(2000);
  const maxPendingAcks = deps.maxPendingAcks ?? MAX_PENDING_ACKS;
  /** 待送的回执：同一件事的同一版只留一条（新结果盖旧的）。 */
  const pendingAcks = new Map<string, OutboxAck>();
  /**
   * 后端已经收下回执的「条目 + 版本」，和它在什么时刻之前不该再给回来：了结的（发了、改了、不发了）永远不该，
   * 免打扰推迟的到 until，没发成的到 retryAfter。这之前又给回来，说明回执没记上或后端没按约定等，要退避而不是接着转。
   */
  const settled = new Lru<string, { holdUntil: number; result: AckResult }>(5000);
  const ackKey = (a: { itemId: string; revision: number }) => `${a.revision}\u0000${a.itemId}`;

  const ctx = (): RenderContext => ({
    publicUrl: deps.publicUrl,
    now: deps.now(),
    nonce: nextNonce(deps.now()),
  });
  const iso = (ms: number) => new Date(ms).toISOString();

  function failed(err: unknown): AckResult {
    return { status: 'failed', error: clip(String(err), 500), retryAfter: iso(deps.now() + RETRY_AFTER_MS) };
  }

  async function alertOverBudget(): Promise<void> {
    const now = deps.now();
    if (!budget.firstOverrun(now)) return;
    deps.log.error('今天求人的卡超预算了：后面的只进驾驶舱', { budget: deps.askBudgetPerDay });
    try {
      await deps.feishu.send(
        { chatId: deps.teamChatId },
        { card: budgetAlertCard(budget.usedToday(now), deps.askBudgetPerDay, ctx()) },
        { uuid: uuidFor('budget', beijingDay(now)) },
      );
    } catch (err) {
      deps.log.error('超预算提醒没发出去', { error: String(err) });
    }
  }

  async function handle(item: OutboxItem, quiet: OutboxBatch['quietHours']): Promise<AckResult> {
    if (!KINDS.has(item.kind)) return { status: 'dropped', reason: 'kind_not_allowed' };
    let to: Target;
    if (item.to.type === 'team') to = { chatId: deps.teamChatId };
    else if (deps.founders.has(item.to.openId)) to = { openId: item.to.openId };
    else return { status: 'dropped', reason: 'not_founder' };

    const mine = sent.get(item.id);
    if (mine && mine.revision === item.revision) return mine.ack;

    const known =
      item.delivered ??
      (mine
        ? {
            messageId: mine.messageId,
            chatId: mine.chatId,
            sentAt: iso(mine.sentAt),
            revision: mine.revision,
          }
        : undefined);
    if (known && deps.now() - Date.parse(known.sentAt) < CARD_EDITABLE_MS) {
      try {
        await deps.feishu.updateCard(known.messageId, outboxCard(item, ctx()));
        byMessage.set(known.messageId, item);
        const ack: AckResult = { status: 'updated', messageId: known.messageId };
        sent.set(item.id, {
          messageId: known.messageId,
          chatId: known.chatId,
          sentAt: Date.parse(known.sentAt),
          revision: item.revision,
          ack,
        });
        return ack;
      } catch (err) {
        if (feishuErrorKind(err) !== 'too_old') return failed(err);
        deps.log.info('推送卡过了 14 天改不了，发新卡', { itemId: item.id });
      }
    }

    // 还没发过卡（或旧卡改不了了）就已经处理完的，不再发新卡：只进日报和驾驶舱。
    if (item.status === 'done') return { status: 'dropped', reason: 'already_done' };
    const until = quietUntil(quiet, deps.now());
    if (until !== null) return { status: 'deferred', until: iso(until), reason: 'quiet_hours' };
    if (ASKING.has(item.kind) && !budget.take(deps.now())) {
      await alertOverBudget();
      return { status: 'dropped', reason: 'over_budget' };
    }

    try {
      const now = deps.now();
      const s = await deps.feishu.send(
        to,
        { card: outboxCard(item, ctx()) },
        { uuid: uuidFor('outbox', item.id, item.revision) },
      );
      byMessage.set(s.messageId, item);
      deps.registry.remember({
        messageId: s.messageId,
        chatId: s.chatId,
        kind: item.kind,
        ref: {
          outboxId: item.id,
          ...(item.taskId ? { taskId: item.taskId } : {}),
          ...(item.askId ? { askId: item.askId } : {}),
          ...(item.notificationId ? { notificationId: item.notificationId } : {}),
        },
        sentAt: iso(now),
      });
      const ack: AckResult = { status: 'sent', messageId: s.messageId, chatId: s.chatId, sentAt: iso(now) };
      sent.set(item.id, {
        messageId: s.messageId,
        chatId: s.chatId,
        sentAt: now,
        revision: item.revision,
        ack,
      });
      return ack;
    } catch (err) {
      if (ASKING.has(item.kind)) budget.giveBack(deps.now());
      return failed(err);
    }
  }

  function queueAck(ack: OutboxAck): void {
    const key = ackKey(ack);
    pendingAcks.delete(key);
    pendingAcks.set(key, ack);
    let dropped = 0;
    while (pendingAcks.size > maxPendingAcks) {
      const oldest = pendingAcks.keys().next().value;
      if (oldest === undefined) break;
      pendingAcks.delete(oldest);
      dropped += 1;
    }
    if (dropped > 0) {
      deps.log.error(
        '积压的推送回执超过上限，丢了最早的几条：后端没记下这些送达，网关重启后可能重发这几张卡',
        {
          dropped,
          max: maxPendingAcks,
        },
      );
    }
  }

  /**
   * 把积压的回执送给后端。送不到（连不上、超时、5xx）留着下次再送；被拒收（4xx）或出了别的错（例如本地校验不过）
   * 记错误、丢掉这批——留着只会每轮都一样失败，后面的推送全被堵住。这几种都抛 OutboxStall。
   */
  async function flushAcks(): Promise<void> {
    // 不合约定的回执（例如飞书没带回私聊的 chat_id）一条条先挑出来丢掉，免得连累同一批里好的。
    for (const [key, a] of pendingAcks) {
      const checked = FeishuOutboxAckSchema.safeParse(a);
      if (checked.success) continue;
      pendingAcks.delete(key);
      deps.log.error('推送回执不合约定，丢掉这条：后端没记下这次送达，网关重启后可能重发这张卡', {
        itemId: a.itemId,
        revision: a.revision,
        status: a.result.status,
        error: clip(checked.error.message, 500),
      });
    }
    while (pendingAcks.size > 0) {
      const chunk = [...pendingAcks.values()].slice(0, 100);
      try {
        await deps.backend.ackOutbox(chunk);
      } catch (err) {
        if (!(err instanceof BackendError)) {
          for (const a of chunk) pendingAcks.delete(ackKey(a));
          deps.log.error(
            '送推送回执时出错（不是后端的回应），这批丢掉：后端没记下这些送达，网关重启后可能重发这几张卡',
            {
              count: chunk.length,
              error: clip(String(err), 500),
            },
          );
          throw new OutboxStall('推送回执没送成（本地出错），这批已丢掉', err);
        }
        if (err instanceof BackendError && err.kind === 'rejected') {
          for (const a of chunk) pendingAcks.delete(ackKey(a));
          deps.log.error(
            '推送回执被后端拒收（4xx），这批丢掉：后端没记下这些送达，网关重启后可能重发这几张卡',
            {
              count: chunk.length,
              status: err.status,
              code: err.code,
              error: err.message,
            },
          );
          throw new OutboxStall(`推送回执被后端拒收（HTTP ${err.status}）`, err);
        }
        throw new OutboxStall(`推送回执没送到后端，还积压 ${pendingAcks.size} 条`, err);
      }
      for (const a of chunk) {
        pendingAcks.delete(ackKey(a));
        settled.set(ackKey(a), { holdUntil: holdUntil(a.result), result: a.result });
      }
    }
  }

  /** 回执收下后，同一版到什么时刻才可以再给回来。 */
  function holdUntil(r: AckResult): number {
    if (r.status === 'deferred') return Date.parse(r.until);
    if (r.status === 'failed') return Date.parse(r.retryAfter);
    return Number.POSITIVE_INFINITY;
  }

  async function runOnce(signal?: AbortSignal): Promise<number> {
    await flushAcks();
    const batch = await deps.backend.outbox(waitSeconds, signal);
    const repeated: Array<{ itemId: string; revision: number; status: AckResult['status'] }> = [];
    for (const item of batch.items) {
      const prior = settled.get(ackKey({ itemId: item.id, revision: item.revision }));
      if (prior && deps.now() < prior.holdUntil) {
        // 不再处理、不碰飞书；把上次的回执再送一遍，后端要是弄丢了还能补上。
        repeated.push({ itemId: item.id, revision: item.revision, status: prior.result.status });
        queueAck({ itemId: item.id, revision: item.revision, result: prior.result });
        continue;
      }
      const result = await handle(item, batch.quietHours);
      queueAck({ itemId: item.id, revision: item.revision, result });
      const fields = { itemId: item.id, revision: item.revision, kind: item.kind, status: result.status };
      if (result.status === 'failed') deps.log.error('推送没发出去', { ...fields, error: result.error });
      else deps.log.info('推送', { ...fields, ...('reason' in result ? { reason: result.reason } : {}) });
    }
    await flushAcks();
    if (repeated.length > 0) {
      deps.log.error(
        '后端又把已经回执过的推送当待推送给了过来（了结了的，或没到 until / retryAfter 的）：回执可能没记上，或后端没按约定等',
        { repeated: repeated.length, examples: repeated.slice(0, 5) },
      );
      throw new OutboxStall(`后端重复给了 ${repeated.length} 件已回执过的推送`);
    }
    return batch.items.length;
  }

  return {
    runOnce,

    async run(signal) {
      let failures = 0;
      while (!signal.aborted) {
        const started = deps.now();
        try {
          const n = await runOnce(signal);
          failures = 0;
          // 后端要是没按长轮询等就回了空的，别原地打转。
          if (n === 0 && deps.now() - started < 1_000) await sleep(1_000, signal);
        } catch (err) {
          if (signal.aborted) break;
          failures += 1;
          const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? 30_000;
          deps.log.warn('推送这一轮没走通，退避后重试', { failures, waitMs: wait, error: String(err) });
          await sleep(wait, signal);
        }
      }
    },

    async overlay(messageId, o) {
      const item = byMessage.get(messageId);
      if (!item) return false;
      await deps.feishu.updateCard(messageId, outboxCard(item, ctx(), o));
      return true;
    },
  };
}
