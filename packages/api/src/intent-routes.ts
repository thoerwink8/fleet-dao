// 网关的五条意图接口（shared 的 IntentRoutes，#553 第 4 条），挂在 /api 下：收原话、收撤回、补漏游标、取意图卡、卡的回执。
// 和 feishu-routes.ts 同一个门：只认网关通行证（checkGatewayPass），按每条的 acting 放行；收原话代表说这句话的那位创始人
// （actingFounder，不是创始人 403）。门口验过通行证记一笔「网关来过」（/healthz 的 feishu_gateway）。
// 改这里之前必须知道：
// - 没记成要让网关看得见：存不进 5xx、认不出 4xx，网关据此在那句话上加「没记成」、之后补漏；绝不在没存成时回 200。
// - 意图卡长轮询读不了库回 503 写明原因，不回空列表（空列表网关会当成「没有要发的」）。
// - 日志不记原话正文，只记长度、编号（方案第一节规则 13）。
// - 指挥官不走这里：他经 ssh 跑 `fleet-api intent …`（intent-cli.ts），不开对公网的口子。

import {
  type FeishuRoute,
  IntentCardAckRequest,
  IntentCardAckResponse,
  IntentCardsQuery,
  IntentCardsResponse,
  IntentCursorsQuery,
  IntentCursorsResponse,
  IntentIntakeMessageRequest,
  IntentIntakeMessageResponse,
  IntentIntakeRecallRequest,
  IntentIntakeRecallResponse,
  IntentRoutes,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { wellFormed } from '@fleet-dao/store';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, readJson, readQuery, reply } from './http.ts';
import type { DueCards, IntentStore } from './intent-store.ts';
import { composeCard } from './intents.ts';
import { actingFounder, type CockpitUser, checkGatewayPass } from './session.ts';

export type IntentEnv = { Variables: { founder: CockpitUser | undefined } };

/** 一轮最多给网关几张卡。 */
const CARDS_BATCH = 50;
/** 长轮询时没被叫醒也隔这么久回库看一眼（指挥官写回在另一个进程里，叫不醒这里）。 */
export const INTENT_CARDS_POLL_MS = 3_000;
/** 两次回库之间至少隔这么久：时钟对不上时不空转。 */
const MIN_SLEEP_MS = 50;
/** 文字类消息：网关给的字是空的就是认错了，不能拿占位顶。 */
const TEXT_TYPES: ReadonlySet<string> = new Set(['text', 'post']);

export const INTENTS_NOT_WIRED =
  '意图存储没接上（这台后端没给 intents）：这句话没存，网关要在那句话上标「没记成」、之后补漏';

export function intentRoutes(deps: Deps): Hono<IntentEnv> {
  const { log } = deps;
  const app = new Hono<IntentEnv>();
  const wake = createWake();

  const gate =
    (route: FeishuRoute): MiddlewareHandler<IntentEnv> =>
    async (c, next) => {
      const authorization = c.req.header('authorization');
      if (authorization === undefined) {
        throw new ApiError(401, 'gateway_pass_missing', '飞书接口只给飞书网关用：要带网关通行证');
      }
      checkGatewayPass(deps.config, authorization);
      deps.gatewaySeen?.saw(route);
      c.set('founder', route.acting === 'required' ? await actingFounder(c, deps.store) : undefined);
      await next();
    };

  /** 按路由表挂：方法、路径、acting 都取自 IntentRoutes。 */
  const on = (route: FeishuRoute, handler: (c: Context<IntentEnv>) => Promise<Response>) =>
    app.on(route.method, route.path, gate(route), handler);

  const storeOf = (): IntentStore => {
    if (!deps.intents) throw new ApiError(503, 'intents_not_wired', INTENTS_NOT_WIRED);
    return deps.intents;
  };

  /** 半个 emoji 换成 �（不换的话写进库会被悄悄换掉，和原始内容对不上）；换了记一笔，不记原文。 */
  const cleaned = (text: string, where: Record<string, unknown>) => {
    const w = wellFormed(text);
    if (w.replaced > 0) {
      log.warn('飞书进来的原话里有残缺的字符（半个 emoji），已换成 �', { ...where, replaced: w.replaced });
    }
    return w.text;
  };

  on(IntentRoutes.intakeMessage, async (c) => {
    const founder = c.get('founder');
    if (!founder) throw new ApiError(500, 'acting_lost', '收原话要代表说这句话的创始人，却没认出是谁');
    const store = storeOf();
    const body = await readJson(c, IntentIntakeMessageRequest);
    const where = { messageId: body.messageId, chatId: body.chatId };
    let text = cleaned(body.text, where);
    if (!text.trim()) {
      if (TEXT_TYPES.has(body.msgType)) {
        throw new ApiError(
          400,
          'empty_text',
          `文字消息（${body.msgType}）却没有字：没有存，网关的规范化多半出了错`,
        );
      }
      // 非文字消息照存，明说是什么，不悄悄跳过
      text = `[${body.msgType} 消息：网关没给文字]`;
    }
    const r = await store.intakeMessage({
      messageId: body.messageId,
      chatId: body.chatId,
      chatKind: body.chatKind,
      threadId: body.threadId,
      parentId: body.parentId,
      sentAt: body.sentAt,
      editedAt: body.editedAt,
      source: body.source,
      msgType: body.msgType,
      text,
      rawContent: cleaned(body.rawContent, where),
      atBot: body.atBot,
      newSegment: body.newSegment,
      forward:
        body.forward === undefined
          ? undefined
          : {
              of: body.forward.of,
              senderName:
                body.forward.senderName === undefined ? undefined : cleaned(body.forward.senderName, where),
            },
      senderUserId: founder.id,
      senderName: founder.displayName,
    });
    if (r.status === 'reused') {
      throw new ApiError(409, 'message_reused', `${r.why}（网关出错？），这句没有存`);
    }
    log.info('收下一条原话', {
      ...where,
      status: r.status,
      intentSeq: r.intentSeq,
      rule: r.rule,
      chars: text.length,
    });
    // @机器人 的这段要马上出卡：叫醒在等的长轮询
    if (body.atBot) wake.all();
    return reply(c, IntentIntakeMessageResponse, { status: r.status, intentSeq: r.intentSeq });
  });

  on(IntentRoutes.intakeRecall, async (c) => {
    const body = await readJson(c, IntentIntakeRecallRequest);
    const r = await storeOf().intakeRecall(body);
    if (r.status === 'reused') {
      throw new ApiError(409, 'recall_mismatch', `${r.why}（网关出错？），没有标撤回`);
    }
    log.info('收下一条撤回', { messageId: body.messageId, chatId: body.chatId, status: r.status });
    return reply(c, IntentIntakeRecallResponse, r);
  });

  on(IntentRoutes.cursors, async (c) => {
    const { chatId } = readQuery(c, IntentCursorsQuery);
    const found = await storeOf().cursors(chatId);
    const chats =
      chatId !== undefined && found.length === 0
        ? [{ known: false as const, chatId }]
        : found.map((x) => ({ known: true as const, ...x }));
    return reply(c, IntentCursorsResponse, { chats, asOf: deps.now().toISOString() });
  });

  on(IntentRoutes.cards, async (c) => {
    const store = storeOf();
    const { waitSeconds } = readQuery(c, IntentCardsQuery);
    const deadline = Date.now() + waitSeconds * 1000;
    // 停机（main.ts 的 shutdown）时马上醒，直接回手上已有的这批、不再查库（库可能正在关）
    const signal = deps.shutdownSignal
      ? AbortSignal.any([c.req.raw.signal, deps.shutdownSignal])
      : c.req.raw.signal;
    let batch: DueCards | undefined;
    for (;;) {
      if (signal.aborted) break;
      try {
        batch = await store.dueCards(CARDS_BATCH);
      } catch (err) {
        const why = errMessage(err);
        log.warn('意图卡长轮询读库没成', { error: why.slice(0, 300) });
        throw new ApiError(503, 'intent_cards_unreadable', `要发的意图卡读不出来：${why.slice(0, 300)}`);
      }
      if (batch.items.length > 0) break;
      const left = deadline - Date.now();
      if (left <= 0) break;
      const untilDue =
        batch.nextDueAt === undefined
          ? Number.POSITIVE_INFINITY
          : Date.parse(batch.nextDueAt) - deps.now().getTime();
      await wake.sleep(Math.max(MIN_SLEEP_MS, Math.min(left, INTENT_CARDS_POLL_MS, untilDue)), signal);
    }
    if (batch === undefined) {
      throw new ApiError(
        503,
        'intent_cards_unreadable',
        '后端在停机，这一轮一次都没读成要发的意图卡，稍后重试',
      );
    }
    return reply(c, IntentCardsResponse, {
      items: batch.items.map(({ intent, messages }) => composeCard(intent, messages)),
      asOf: deps.now().toISOString(),
    });
  });

  on(IntentRoutes.ackCards, async (c) => {
    const { acks } = await readJson(c, IntentCardAckRequest);
    const report = await storeOf().ackCards(acks);
    if (report.skipped.length > 0) {
      log.warn('意图卡回执里有认不出的，跳过了这几条', {
        applied: report.applied,
        skipped: report.skipped.length,
        examples: report.skipped.slice(0, 5),
      });
    }
    return reply(c, IntentCardAckResponse, { applied: report.applied, skipped: report.skipped.length });
  });

  return app;
}

/** 长轮询的叫醒：同一个进程里收下 @机器人 的原话就醒，醒了自己回库算。 */
function createWake() {
  const sleepers = new Set<() => void>();
  return {
    all() {
      for (const finish of [...sleepers]) finish();
    },
    sleep(ms: number, signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          sleepers.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        sleepers.add(finish);
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
      });
    },
  };
}
