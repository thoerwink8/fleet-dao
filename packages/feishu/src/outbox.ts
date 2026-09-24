// 推送的唯一出口：从后端长轮询「待推送」，每件事只发一张卡，之后按 revision 原地更新，不重发。
// 这里执行四道闸：种类白名单（三类 + 关注 + AI 追问）、私聊只发创始人、免打扰、每天求人卡的预算。
// 送达只认飞书回的 message_id，回执写回后端（驾驶舱「通知」页的送达记录就是它）。
import type { Backend, OutboxAck, OutboxBatch, OutboxItem } from './backend.ts';
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

type AckResult = OutboxAck['result'];

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
}

export interface Outbox {
  /** 取一批、处理、回执。返回这批有几件。 */
  runOnce(signal?: AbortSignal): Promise<number>;
  /** 一直跑到 signal 叫停；后端连不上就退避重试。 */
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
  const pendingAcks: OutboxAck[] = [];

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

  async function flushAcks(): Promise<void> {
    while (pendingAcks.length > 0) {
      const chunk = pendingAcks.slice(0, 100);
      try {
        await deps.backend.ackOutbox(chunk);
      } catch (err) {
        deps.log.warn('推送回执没送到后端，下一轮再送', { count: pendingAcks.length, error: String(err) });
        return;
      }
      pendingAcks.splice(0, chunk.length);
    }
  }

  async function runOnce(signal?: AbortSignal): Promise<number> {
    await flushAcks();
    const batch = await deps.backend.outbox(waitSeconds, signal);
    for (const item of batch.items) {
      const result = await handle(item, batch.quietHours);
      pendingAcks.push({ itemId: item.id, revision: item.revision, result });
      const fields = { itemId: item.id, revision: item.revision, kind: item.kind, status: result.status };
      if (result.status === 'failed') deps.log.error('推送没发出去', { ...fields, error: result.error });
      else deps.log.info('推送', { ...fields, ...('reason' in result ? { reason: result.reason } : {}) });
    }
    await flushAcks();
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
          deps.log.warn('取待推送没成功，稍后重试', { failures, waitMs: wait, error: String(err) });
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
