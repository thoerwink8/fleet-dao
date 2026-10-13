// 驾驶舱「提需求」的指挥官会话（#2061，母单 #2047 第 C 片；方案第四、五节）后端这头：判该不该排一轮、能不能排，排进
// request_chats（引擎每两秒看一眼接手，见 packages/engine 的 jobs/intake-chat.ts）；换模型、停下、让别家挑错、标意见；
// 详情里的会话状态、SSE 读的写到哪了。
// 改这里之前必须知道：
// - 身份只认登录会话：谁说的、谁点的都取 viewerId；@指挥官 由请求里的 mentionCommander 或正文「@指挥官」认。
// - 该不该接、能不能排的判法只在 shared 的 request-chat.ts（commanderShouldReply、judgeCommanderTurn）。
// - 人发的消息先存（request-store-pg.ts 的 send），再判要不要排：排不上（限额、引擎关着、额度熔断、用途没配模型）写一条
//   系统消息「指挥官暂停了：原因」并记在会话上，人话照样在；点按钮（接着问、挑错）排不上回 409 + 同一句原因。
// - 换模型只能换成「提需求」用途（intake-chat）里配了的：Fable 只有创始人本人配进这个用途才会在可选里（决定 0033）。
// - 草稿带「要人拍」时，「确定」前要有这一版草稿的别家意见：没有就当场排一次挑错、回 409 让人看完意见再确定。
import {
  type Db,
  models,
  readEngineMasterRow,
  requestChats,
  requestMessages,
  requests,
  routingPurposeModels,
  users,
} from '@fleet-dao/db';
import {
  commanderShouldReply,
  describeEngineMaster,
  engineMasterOf,
  INTAKE_CHAT_LIMITS,
  INTAKE_CHAT_PURPOSE,
  type IntakeChatLimits,
  isClosed,
  judgeCommanderTurn,
  mentionsCommander,
  pausedWhy,
  REQUEST_CHAT_PHASE_WORDS,
  type RequestCard,
  type RequestChatJob,
  type RequestChatStreamEvent,
  type RequestCommander,
  type RequestModelOption,
  type RequestReviewVerdict,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { and, asc, eq, isNotNull, ne, or, sql } from 'drizzle-orm';
import { ApiError } from './http.ts';

type ChatRow = typeof requestChats.$inferSelect;
type RequestRowDb = typeof requests.$inferSelect;

/** 「提需求」用途里配了的模型（按先后）：没配、没读成写原因，不拿空列表冒充「没有可选的」。 */
export async function intakeChatModels(
  db: Db,
): Promise<{ models: RequestModelOption[]; unavailable?: string }> {
  try {
    const rows = await db
      .select({ id: models.id, name: models.displayName })
      .from(routingPurposeModels)
      .innerJoin(models, eq(models.id, routingPurposeModels.modelId))
      .where(eq(routingPurposeModels.purpose, INTAKE_CHAT_PURPOSE))
      .orderBy(asc(routingPurposeModels.position));
    if (rows.length === 0) {
      return { models: [], unavailable: '「提需求」用途（intake-chat）没配模型：请创始人在路由页给它配上' };
    }
    return { models: rows };
  } catch (err) {
    return { models: [], unavailable: `「提需求」用途的模型没读成：${errMessage(err)}` };
  }
}

const isRunning = (chat: ChatRow | undefined) => chat !== undefined && chat.state !== 'idle';

/** 详情里的会话状态（request-store-pg.ts 的 detail 调）。 */
export async function commanderOf(
  db: Db,
  r: Pick<RequestRowDb, 'id' | 'modelChoice'>,
  limits: IntakeChatLimits,
): Promise<RequestCommander> {
  const [chat] = await db.select().from(requestChats).where(eq(requestChats.requestId, r.id));
  const configured = await intakeChatModels(db);
  const name = (id: string) => configured.models.find((m) => m.id === id)?.name ?? id;
  return {
    state: chat?.state ?? 'idle',
    running: isRunning(chat),
    ...(chat?.job ? { job: chat.job } : {}),
    ...(chat?.phase ? { phase: chat.phase } : {}),
    model: r.modelChoice ? { id: r.modelChoice, name: name(r.modelChoice) } : null,
    defaultModel: configured.models[0] ?? null,
    models: configured.models,
    ...(configured.unavailable ? { modelsUnavailable: configured.unavailable } : {}),
    turns: chat?.turns ?? 0,
    maxTurns: limits.maxTurns,
    ...(chat?.pausedWhy ? { pausedWhy: chat.pausedWhy } : {}),
  };
}

/** 会话在不在跑（删除判定用）：排着或正在回话。 */
export async function commanderRunning(db: Db, requestId: string): Promise<boolean> {
  const [chat] = await db
    .select({ state: requestChats.state })
    .from(requestChats)
    .where(eq(requestChats.requestId, requestId));
  return chat !== undefined && chat.state !== 'idle';
}

export interface RequestChatPort {
  /**
   * 人刚说了一句（建需求的第一句也算）：该接就排一轮；排不上写暂停消息。回排没排、为什么。
   * 两个人都说过话又没 @指挥官：不排、不写消息（这不是暂停）。
   */
  afterHumanMessage(
    seq: number,
    viewerId: string,
    input: { body: string; mentionCommander: boolean },
  ): Promise<{ queued: boolean; why: string }>;
  /** 「让指挥官接着问」：排不上 409。 */
  nudge(seq: number, viewerId: string): Promise<void>;
  /** 停下：排着的直接撤，跑着的叫引擎停。没在跑 409。 */
  stop(seq: number, viewerId: string): Promise<void>;
  /** 换模型（null = 回到用途默认）：只能是用途里配了的；在跑时 409；出一条分隔线，下一句按存档重起。 */
  setModel(seq: number, viewerId: string, modelId: string | null): Promise<void>;
  /** 让别家挑错：排不上 409。 */
  review(seq: number, viewerId: string): Promise<void>;
  /** 意见卡的一条标采用或不用。 */
  markReview(
    seq: number,
    viewerId: string,
    input: { messageId: number; index: number; verdict: RequestReviewVerdict },
  ): Promise<void>;
  /** 「确定」前：草稿带「要人拍」又没有这一版的别家意见，就排一次挑错并 409。 */
  confirmGate(seq: number, viewerId: string): Promise<void>;
  /** SSE 读的：会话现在怎样。没有这条需求回 null。 */
  stream(seq: number): Promise<RequestChatStreamEvent | null>;
}

function refused(why: string): never {
  throw new ApiError(409, 'commander_refused', why);
}

export function pgRequestChat(
  db: Db,
  now: () => Date,
  options: { limits?: IntakeChatLimits } = {},
): RequestChatPort {
  const limits = options.limits ?? INTAKE_CHAT_LIMITS;

  async function loadRequest(tx: Db, seq: number, lock: boolean): Promise<RequestRowDb> {
    const q = tx.select().from(requests).where(eq(requests.seq, seq));
    const [r] = lock ? await q.for('update') : await q;
    if (!r) throw new ApiError(404, 'request_not_found', `没有需求 ${seq}`);
    return r;
  }

  async function ensureViewer(tx: Db, viewerId: string) {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, viewerId));
    if (!u) throw new ApiError(403, 'not_whitelisted', '登录的这个人不在 users 表里');
  }

  async function chatOf(tx: Db, requestId: string, lock: boolean): Promise<ChatRow | undefined> {
    const q = tx.select().from(requestChats).where(eq(requestChats.requestId, requestId));
    const [c] = lock ? await q.for('update') : await q;
    return c;
  }

  async function engineState(tx: Db): Promise<{ on: true } | { on: false; why: string }> {
    try {
      const state = engineMasterOf(await readEngineMasterRow(tx));
      return state.on ? { on: true } : { on: false, why: describeEngineMaster(state) };
    } catch (err) {
      return { on: false, why: `引擎总开关没查成：${errMessage(err)}` };
    }
  }

  /** 发起人另外几条需求里活着的会话（排着、在跑、或会话没收掉）。 */
  async function otherActive(tx: Db, r: RequestRowDb): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(requestChats)
      .innerJoin(requests, eq(requests.id, requestChats.requestId))
      .where(
        and(
          eq(requests.initiatorId, r.initiatorId),
          ne(requests.id, r.id),
          or(ne(requestChats.state, 'idle'), isNotNull(requestChats.workdir)),
        ),
      );
    return row?.n ?? 0;
  }

  /** 判能不能排；能就排进去（锁着需求那一行做）。 */
  async function tryQueue(
    tx: Db,
    r: RequestRowDb,
    viewerId: string,
    job: RequestChatJob,
  ): Promise<{ ok: true } | { ok: false; why: string }> {
    if (r.deletedAt !== null || isClosed(r.status)) {
      return { ok: false, why: pausedWhy('需求已经结案或删了，内容不再改') };
    }
    if (job === 'reply' && r.status !== 'discussing') {
      return {
        ok: false,
        why: pausedWhy('待拍板时草稿锁着，指挥官不接话：拍板人点「再聊聊」或发起人撤回后再聊'),
      };
    }
    const chat = await chatOf(tx, r.id, true);
    const configured = await intakeChatModels(tx);
    const verdict = judgeCommanderTurn({
      busy: isRunning(chat),
      turns: job === 'reply' ? (chat?.turns ?? 0) : 0,
      otherActive: await otherActive(tx, r),
      thisActive: chat !== undefined && (chat.state !== 'idle' || chat.workdir !== null),
      engine: await engineState(tx),
      modelsConfigured: configured.models.length > 0,
      limits,
    });
    if (!verdict.ok) {
      if (chat) {
        await tx
          .update(requestChats)
          .set({ pausedWhy: verdict.code === 'busy' ? chat.pausedWhy : verdict.why, updatedAt: now() })
          .where(eq(requestChats.requestId, r.id));
      } else {
        await tx.insert(requestChats).values({ requestId: r.id, pausedWhy: verdict.why, updatedAt: now() });
      }
      return { ok: false, why: verdict.why };
    }
    const at = now();
    const values = {
      state: 'queued' as const,
      job,
      queuedBy: viewerId,
      queuedAt: at,
      stopRequestedAt: null,
      pausedWhy: null,
      phase: null,
      streamText: '',
      updatedAt: at,
    };
    if (chat) await tx.update(requestChats).set(values).where(eq(requestChats.requestId, r.id));
    else await tx.insert(requestChats).values({ requestId: r.id, ...values });
    return { ok: true };
  }

  async function pauseMessage(tx: Db, requestId: string, why: string) {
    const card: RequestCard = { type: 'paused', why };
    await tx.insert(requestMessages).values({ requestId, kind: 'system', body: why, card, createdAt: now() });
  }

  return {
    async afterHumanMessage(seq, viewerId, input) {
      return db.transaction(async (tx) => {
        const r = await loadRequest(tx, seq, true);
        const speakers = await tx
          .selectDistinct({ id: requestMessages.authorId })
          .from(requestMessages)
          .where(and(eq(requestMessages.requestId, r.id), eq(requestMessages.kind, 'human')));
        const should = commanderShouldReply({
          humanSpeakerIds: speakers.map((s) => s.id ?? '').filter(Boolean),
          mentioned: input.mentionCommander || mentionsCommander(input.body),
          nudge: false,
        });
        if (!should.reply) return { queued: false, why: should.why };
        const got = await tryQueue(tx, r, viewerId, 'reply');
        if (!got.ok) {
          await pauseMessage(tx, r.id, got.why);
          return { queued: false, why: got.why };
        }
        return { queued: true, why: should.why };
      });
    },

    async nudge(seq, viewerId) {
      await db.transaction(async (tx) => {
        await ensureViewer(tx, viewerId);
        const r = await loadRequest(tx, seq, true);
        const got = await tryQueue(tx, r, viewerId, 'reply');
        if (!got.ok) refused(got.why);
      });
    },

    async stop(seq, viewerId) {
      await db.transaction(async (tx) => {
        await ensureViewer(tx, viewerId);
        const r = await loadRequest(tx, seq, true);
        const chat = await chatOf(tx, r.id, true);
        if (!chat || chat.state === 'idle') refused('指挥官没在回话，不用停');
        const at = now();
        if (chat.state === 'queued') {
          await tx
            .update(requestChats)
            .set({ state: 'idle', job: null, queuedAt: null, updatedAt: at })
            .where(eq(requestChats.requestId, r.id));
        } else {
          // 跑着的：引擎看到 stop_requested_at 就停，停完回到 idle
          await tx
            .update(requestChats)
            .set({ stopRequestedAt: at, updatedAt: at })
            .where(eq(requestChats.requestId, r.id));
        }
      });
    },

    async setModel(seq, viewerId, modelId) {
      await db.transaction(async (tx) => {
        await ensureViewer(tx, viewerId);
        const r = await loadRequest(tx, seq, true);
        if (r.deletedAt !== null || isClosed(r.status)) refused('已结案或删了的需求不能换模型');
        const chat = await chatOf(tx, r.id, true);
        if (isRunning(chat)) refused('指挥官正在回话，停下或等它说完再换模型');
        const configured = await intakeChatModels(tx);
        if (modelId !== null && !configured.models.some((m) => m.id === modelId)) {
          refused(
            configured.unavailable ??
              `模型 ${modelId} 不在「提需求」用途里：只能选 ${configured.models.map((m) => m.name).join('、')}`,
          );
        }
        if ((r.modelChoice ?? null) === modelId) return;
        const at = now();
        await tx.update(requests).set({ modelChoice: modelId, updatedAt: at }).where(eq(requests.id, r.id));
        // 按存档重起：会话清掉（检出由引擎闲置收掉时删，或下一轮换路由时删）
        if (chat) {
          await tx
            .update(requestChats)
            .set({ sessionId: null, routeId: null, modelId: null, updatedAt: at })
            .where(eq(requestChats.requestId, r.id));
        }
        const word = (id: string | null) =>
          id === null
            ? `默认（${configured.models[0]?.name ?? '用途没配'}）`
            : (configured.models.find((m) => m.id === id)?.name ?? id);
        const card: RequestCard = { type: 'model_switch', from: r.modelChoice ?? null, to: modelId };
        await tx.insert(requestMessages).values({
          requestId: r.id,
          kind: 'system',
          body: `换模型：${word(r.modelChoice ?? null)} → ${word(modelId)}，下一句按存下来的对话和草稿重起`,
          card,
          createdAt: at,
        });
      });
    },

    async review(seq, viewerId) {
      await db.transaction(async (tx) => {
        await ensureViewer(tx, viewerId);
        const r = await loadRequest(tx, seq, true);
        const got = await tryQueue(tx, r, viewerId, 'review');
        if (!got.ok) refused(got.why);
      });
    },

    async markReview(seq, viewerId, input) {
      await db.transaction(async (tx) => {
        await ensureViewer(tx, viewerId);
        const r = await loadRequest(tx, seq, true);
        if (r.deletedAt !== null || isClosed(r.status)) refused('已结案，内容不再改');
        const [m] = await tx
          .select()
          .from(requestMessages)
          .where(and(eq(requestMessages.requestId, r.id), eq(requestMessages.id, input.messageId)))
          .for('update');
        if (!m || m.card?.type !== 'review') {
          throw new ApiError(404, 'review_not_found', `需求 ${seq} 里没有意见卡 ${input.messageId}`);
        }
        const card = m.card;
        if (input.index >= card.items.length) {
          throw new ApiError(400, 'review_item_not_found', `意见卡只有 ${card.items.length} 条`);
        }
        const items = card.items.map((it, i) => (i === input.index ? { ...it, verdict: input.verdict } : it));
        await tx
          .update(requestMessages)
          .set({ card: { ...card, items } })
          .where(eq(requestMessages.id, m.id));
      });
    },

    async confirmGate(seq, viewerId) {
      const outcome = await db.transaction(async (tx) => {
        const r = await loadRequest(tx, seq, true);
        if (!r.draftJson.needsHuman?.trim()) return { kind: 'pass' } as const;
        const reviews = await tx
          .select({ card: requestMessages.card })
          .from(requestMessages)
          .where(and(eq(requestMessages.requestId, r.id), eq(requestMessages.kind, 'review')));
        const done = reviews.some((m) => m.card?.type === 'review' && m.card.draftVersion === r.draftVersion);
        if (done) return { kind: 'pass' } as const;
        const chat = await chatOf(tx, r.id, false);
        if (chat?.state !== 'idle' && chat?.job === 'review') {
          return { kind: 'wait', why: '草稿带「要人拍」：别家正在挑这一版的错，看完意见再确定' } as const;
        }
        const got = await tryQueue(tx, r, viewerId, 'review');
        return got.ok
          ? ({
              kind: 'wait',
              why: '草稿带「要人拍」：确定前先让别家挑一遍错，已经替你排上了，看完意见再确定',
            } as const)
          : ({
              kind: 'wait',
              why: `草稿带「要人拍」，确定前要让别家挑一遍错，但没排上：${got.why}`,
            } as const);
      });
      if (outcome.kind === 'wait') refused(outcome.why);
    },

    async stream(seq) {
      const [row] = await db
        .select({ id: requests.id, chat: requestChats })
        .from(requests)
        .leftJoin(requestChats, eq(requestChats.requestId, requests.id))
        .where(eq(requests.seq, seq));
      if (!row) return null;
      const [last] = await db
        .select({ id: sql<number | null>`max(${requestMessages.id})` })
        .from(requestMessages)
        .where(eq(requestMessages.requestId, row.id));
      const chat = row.chat;
      return {
        state: chat?.state ?? 'idle',
        ...(chat?.job ? { job: chat.job } : {}),
        ...(chat?.phase ? { phase: chat.phase, phaseText: REQUEST_CHAT_PHASE_WORDS[chat.phase] } : {}),
        text: chat?.streamText ?? '',
        lastMessageId: Number(last?.id ?? 0),
      };
    },
  };
}
