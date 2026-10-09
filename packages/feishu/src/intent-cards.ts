// 意图卡（#553 第 4 条）：从后端长轮询要发、要改的意图卡；第一次发回复在那段第一条原话下面，之后原地改同一张。
// 卡上的字后端拼好（标题一行、下面每行一段），这里只照着摆，卡上没有按钮——飞书上不建开单界面。
// 改这里之前必须知道：
// - 送达只认飞书回的 message_id，回执写回后端；飞书不让改了（超过 14 天）就新发一张、回执带新编号。
// - 发不出去的照样回执（failed 带原因），后端过一阵再给，不在这里原地重试。
// - 一轮没走通（取不到卡、回执送不上去，包括后端读不了库回 503）抛出来，run() 退避并记给看守（5 分钟没走通往团队群报警）；
//   绝不把「没取到」当成「没有要发的」。
import type { Backend, FeishuUsage, IntentCard, IntentCardAck } from './backend.ts';
import type { Logger } from './log.ts';
import { type Card, type FeishuPort, feishuErrorKind } from './port.ts';
import { sleep, uuidFor } from './util.ts';
import type { Watch } from './watch.ts';
import { clip } from './words.ts';

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** 卡上一行最多摆多少字（后端给的归纳那行最长约 2300 字）。 */
const LINE_MAX = 2_400;

/** 意图卡：标题 + 每行一段纯文字（plain_text：原话里的符号不会把版式搞乱）；已开成单的标绿，放下的标灰。 */
export function intentCard(item: IntentCard): Card {
  const template = item.title.includes('已开成')
    ? 'green'
    : item.title.includes('已放下')
      ? 'grey'
      : 'wathet';
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: clip(item.title, 60) } },
    header: { title: { tag: 'plain_text', content: clip(item.title, 120) }, template },
    body: {
      elements: item.lines.map((line) => ({
        tag: 'div',
        text: { tag: 'plain_text', content: clip(line, LINE_MAX) || '（空）' },
      })),
    },
  };
}

export interface IntentCardsDeps {
  backend: Backend;
  feishu: FeishuPort;
  log: Logger;
  now: () => number;
  /** 长轮询一次最多等几秒。 */
  waitSeconds?: number;
  /** 每一轮走没走通，记给网关自己的看守（watch.ts）。 */
  watch?: Pick<Watch, 'ok' | 'fail'> | undefined;
  /**
   * 飞书用量（#795）。长轮询带回的快照先记下，再发卡：到了八成，已有的卡不再改（回执 failed 写明），
   * 第一张照发并把降级写在卡上；读不到只在卡上写「只停收到」，改卡照旧。
   */
  usage?:
    | {
        apply(snapshot: FeishuUsage): void;
        lines(lines: readonly string[]): string[];
        /** 该停改卡时回写在回执上的那句；不该停回 null。 */
        cardUpdateError(): string | null;
      }
    | undefined;
}

export interface IntentCards {
  /** 取一批、发或改、回执，返回这批有几张。取不到、回执送不上去抛出来（调用方退避）。 */
  runOnce(signal?: AbortSignal): Promise<number>;
  /** 一直跑到 signal 叫停；一轮没走通就退避重试（1、2、5、10、30 秒）。 */
  run(signal: AbortSignal): Promise<void>;
}

export function createIntentCards(deps: IntentCardsDeps): IntentCards {
  const waitSeconds = deps.waitSeconds ?? 25;

  /** 发一张：回复这段第一条原话；uuid 按「这段 + 这一版」定，回执没送到、同一版再来时飞书一小时内不会发第二张。 */
  async function sendNew(item: IntentCard, card: Card, why: string): Promise<IntentCardAck['result']> {
    const sent = await deps.feishu.reply(
      item.replyToMessageId,
      { card },
      { uuid: uuidFor('intent-card', item.intentId, item.cardRev, why) },
    );
    return { status: 'sent', messageId: sent.messageId };
  }

  async function deliver(item: IntentCard): Promise<IntentCardAck['result']> {
    const lines = deps.usage ? deps.usage.lines(item.lines) : [...item.lines];
    const card = intentCard({ ...item, lines });
    const blocked = item.cardMessageId !== undefined ? deps.usage?.cardUpdateError() : null;
    if (blocked) {
      deps.log.info('飞书用量降级：停了改卡，只留第一张', { intentId: item.intentId, seq: item.seq });
      return { status: 'failed', error: clip(blocked, 500) || blocked };
    }
    try {
      if (item.cardMessageId === undefined) return await sendNew(item, card, 'first');
      try {
        await deps.feishu.updateCard(item.cardMessageId, card);
        return { status: 'updated', messageId: item.cardMessageId };
      } catch (err) {
        if (feishuErrorKind(err) !== 'too_old') throw err;
        // 超过 14 天飞书不让改：新发一张，回执带新编号，后端以后改新的这张
        deps.log.info('意图卡太旧改不了，新发一张', { intentId: item.intentId, seq: item.seq });
        return await sendNew(item, card, 'too-old');
      }
    } catch (err) {
      deps.log.warn('意图卡没发出去', {
        intentId: item.intentId,
        seq: item.seq,
        kind: feishuErrorKind(err),
        error: clip(String(err), 300),
      });
      return { status: 'failed', error: clip(String(err), 500) || '没发出去（飞书没说原因）' };
    }
  }

  async function runOnce(signal?: AbortSignal): Promise<number> {
    const batch = await deps.backend.intentCards(waitSeconds, signal);
    deps.usage?.apply(batch.usage);
    if (batch.items.length === 0) return 0;
    const acks: IntentCardAck[] = [];
    for (const item of batch.items) {
      acks.push({ intentId: item.intentId, cardRev: item.cardRev, result: await deliver(item) });
    }
    const report = await deps.backend.ackIntentCards(acks);
    if (report.skipped > 0) {
      deps.log.warn('意图卡回执后端有几条没认', { skipped: report.skipped, applied: report.applied });
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
          deps.watch?.ok('intents', deps.now() - started);
          // 后端要是没按长轮询等就回了空的，别原地打转。
          if (n === 0 && deps.now() - started < 1_000) await sleep(1_000, signal);
        } catch (err) {
          if (signal.aborted) break;
          failures += 1;
          deps.watch?.fail('intents', err);
          const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? 30_000;
          deps.log.warn('意图卡这一轮没走通，退避后重试', { failures, waitMs: wait, error: String(err) });
          await sleep(wait, signal);
        }
      }
    },
  };
}
