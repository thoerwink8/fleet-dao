// 指挥官会话（#2061，母单 #2047 第 C 片）引擎那头的读写：接手排着的一轮、边跑边写写到哪了、回完写回话和草稿补丁、
// 没接上写暂停原因、闲置 30 分钟收掉会话、引擎重启后收掉卡在 running 的。后端排一轮的那头在 packages/api 的 request-chat-pg.ts。
// 改这里之前必须知道：
// - 草稿补丁在写回的事务里、锁住需求那一行后再分（shared 的 splitCommanderPatch）：会话跑着时人可能改了某一栏，
//   以写回那一刻的「人改过的栏」为准；碰到人改过的栏不改，转成一条「建议改」消息。
// - 需求在会话跑着时结案、删了：回话不写进去（结案锁死），记一条操作记录，会话照样回到 idle。
// - 读不了库就抛（调用方记这一轮没跑成），不当成「没有排着的」。
import {
  pausedWhy,
  proposalCard,
  REQUEST_DRAFT_FIELD_WORDS,
  type RequestCard,
  type RequestChatJob,
  type RequestChatPhase,
  type RequestDraft,
  type RequestDraftField,
  splitCommanderPatch,
} from '@fleet-dao/shared';
import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { models } from '../schema/catalog.ts';
import { auditLog, users } from '../schema/ops.ts';
import { requestChats, requestMessages, requests } from '../schema/requests.ts';
import { repos } from '../schema/work.ts';

/** 操作记录里的身份。 */
export const REQUEST_CHAT_ACTOR = 'intake-chat';

/** 一条消息的正文上限（表上的约束）：指挥官写长了截断并标出来；人话不截。 */
const BODY_MAX = 20_000;
const clip = (s: string) => (s.length > BODY_MAX ? `${s.slice(0, BODY_MAX - 20)}…（太长，后面截掉了）` : s);

export interface ChatTranscriptMessage {
  id: number;
  kind: string;
  authorName: string | null;
  body: string;
  card: RequestCard | null;
  createdAt: Date;
}

export interface ClaimedRequestChat {
  requestId: string;
  seq: number;
  job: RequestChatJob;
  queuedBy: string | null;
  repo: { id: string; owner: string; name: string; defaultBranch: string };
  draft: RequestDraft;
  draftVersion: number;
  humanEdited: RequestDraftField[];
  /** 这条需求选的模型；没选是 null（按「提需求」用途的顺序选）。 */
  modelChoice: string | null;
  /** 活着的会话：workdir 不空才算活着。 */
  session: {
    sessionId: string | null;
    routeId: string | null;
    modelId: string | null;
    workdir: string | null;
  };
  /** 会话已经看过的最后一条消息。 */
  lastMessageId: number | null;
  turns: number;
  /** 全部消息（按先后）：重起时整份喂，续会话只喂 lastMessageId 之后的。 */
  messages: ChatTranscriptMessage[];
}

/**
 * 接手最早排着的一轮：锁住、改成 running。需求已经结案或删了的不接（撤回到 idle，写一条操作记录），接着找下一条。
 * 没有排着的返回 null。
 */
export async function claimRequestChat(db: Db, now: Date): Promise<ClaimedRequestChat | null> {
  for (let guard = 0; guard < 20; guard += 1) {
    const got = await db.transaction(async (tx) => {
      const [chat] = await tx
        .select()
        .from(requestChats)
        .where(eq(requestChats.state, 'queued'))
        .orderBy(asc(requestChats.queuedAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!chat) return { kind: 'none' } as const;
      const [r] = await tx
        .select({
          id: requests.id,
          seq: requests.seq,
          status: requests.status,
          deletedAt: requests.deletedAt,
          draft: requests.draftJson,
          draftVersion: requests.draftVersion,
          humanEdited: requests.humanEditedFields,
          modelChoice: requests.modelChoice,
          repoId: repos.id,
          owner: repos.owner,
          name: repos.name,
          defaultBranch: repos.defaultBranch,
        })
        .from(requests)
        .innerJoin(repos, eq(repos.id, requests.repoId))
        .where(eq(requests.id, chat.requestId));
      // 回话只在讨论中接；挑错在待拍板时也能接（结案锁死，结案和删了的都不接）
      const closedStatus = r?.status === 'closed_do' || r?.status === 'closed_drop';
      if (!r || r.deletedAt !== null || closedStatus || (r.status !== 'discussing' && chat.job === 'reply')) {
        await tx
          .update(requestChats)
          .set({ state: 'idle', job: null, queuedAt: null, updatedAt: now })
          .where(eq(requestChats.requestId, chat.requestId));
        return { kind: 'skipped' } as const;
      }
      await tx
        .update(requestChats)
        .set({
          state: 'running',
          startedAt: now,
          stopRequestedAt: null,
          phase: 'thinking',
          streamText: '',
          updatedAt: now,
        })
        .where(eq(requestChats.requestId, chat.requestId));
      const rows = await tx
        .select({
          id: requestMessages.id,
          kind: requestMessages.kind,
          authorName: users.displayName,
          body: requestMessages.body,
          card: requestMessages.card,
          createdAt: requestMessages.createdAt,
        })
        .from(requestMessages)
        .leftJoin(users, eq(users.id, requestMessages.authorId))
        .where(eq(requestMessages.requestId, chat.requestId))
        .orderBy(asc(requestMessages.id));
      const claimed: ClaimedRequestChat = {
        requestId: r.id,
        seq: r.seq,
        job: chat.job ?? 'reply',
        queuedBy: chat.queuedBy,
        repo: { id: r.repoId, owner: r.owner, name: r.name, defaultBranch: r.defaultBranch },
        draft: r.draft,
        draftVersion: r.draftVersion,
        humanEdited: r.humanEdited,
        modelChoice: r.modelChoice,
        session: {
          sessionId: chat.sessionId,
          routeId: chat.routeId,
          modelId: chat.modelId,
          workdir: chat.workdir,
        },
        lastMessageId: chat.lastMessageId,
        turns: chat.turns,
        messages: rows.map((m) => ({ ...m, authorName: m.authorName ?? null, card: m.card ?? null })),
      };
      return { kind: 'claimed', claimed } as const;
    });
    if (got.kind === 'none') return null;
    if (got.kind === 'claimed') return got.claimed;
  }
  return null;
}

/** 边跑边写：写到哪了。回 stop = 有人点了停下（调用方就停会话）。这一行没了（需求被硬删）也算停。 */
export async function writeRequestChatProgress(
  db: Db,
  requestId: string,
  progress: { phase: RequestChatPhase; text: string },
  now: Date,
): Promise<{ stop: boolean }> {
  const [row] = await db
    .update(requestChats)
    .set({ phase: progress.phase, streamText: progress.text, updatedAt: now })
    .where(and(eq(requestChats.requestId, requestId), eq(requestChats.state, 'running')))
    .returning({ stop: requestChats.stopRequestedAt });
  return { stop: !row || row.stop !== null };
}

/** 只看有没有人点停下（会话一阵子没出声时也要看）。 */
export async function requestChatStopRequested(db: Db, requestId: string): Promise<boolean> {
  const [row] = await db
    .select({ state: requestChats.state, stop: requestChats.stopRequestedAt })
    .from(requestChats)
    .where(eq(requestChats.requestId, requestId));
  return !row || row.state !== 'running' || row.stop !== null;
}

export interface ChatSessionAfter {
  sessionId: string | null;
  routeId: string | null;
  modelId: string | null;
  workdir: string | null;
}

const stringify = (v: unknown) => (Array.isArray(v) ? v.map(String).join('；') : String(v));

/** 一个事务里锁住需求和会话；需求不在讨论中或删了回 null（回话不写进去）。 */
async function lockForWrite(tx: Db, requestId: string) {
  const [r] = await tx.select().from(requests).where(eq(requests.id, requestId)).for('update');
  const [chat] = await tx
    .select()
    .from(requestChats)
    .where(eq(requestChats.requestId, requestId))
    .for('update');
  return { r, chat };
}

async function maxMessageId(tx: Db, requestId: string): Promise<number | null> {
  const [m] = await tx
    .select({
      id: sql<number | null>`max(${requestMessages.id})`.mapWith((v) => (v === null ? null : Number(v))),
    })
    .from(requestMessages)
    .where(eq(requestMessages.requestId, requestId));
  return m?.id ?? null;
}

export interface FinishReplyInput {
  requestId: string;
  reply: string;
  question?: { text: string; options: string[] };
  /** 方案卡的摘要。草稿版本号用这一笔补丁落库后的版本，不信模型自己写的。 */
  proposal?: { summary: string };
  patch?: Record<string, unknown>;
  session: ChatSessionAfter;
  now: Date;
}

export interface FinishReplyResult {
  /** 回话写进去了没有（需求结案、删了就没写）。 */
  written: boolean;
  applied: RequestDraftField[];
  suggested: RequestDraftField[];
  rejected: { field: string; why: string }[];
  draftVersion: number | null;
}

/**
 * 回完一句：写指挥官的话（带问题卡或方案卡、改了哪些栏）、草稿补丁能改的改进去（版本加 1）、碰到人改过的栏转「建议改」消息、
 * 白名单外的栏拒掉记进操作记录；方案卡的版本号是补丁落库后的那一版。会话回到 idle，轮数加 1，记下会话号、检出、看到哪一条。
 */
export async function finishCommanderReply(db: Db, input: FinishReplyInput): Promise<FinishReplyResult> {
  return db.transaction(async (tx) => {
    const { r, chat } = await lockForWrite(tx, input.requestId);
    const out: FinishReplyResult = {
      written: false,
      applied: [],
      suggested: [],
      rejected: [],
      draftVersion: null,
    };
    if (!chat) return out;
    const open = r && r.deletedAt === null && r.status === 'discussing';
    if (r && open) {
      const split = splitCommanderPatch(input.patch ?? {}, r.humanEditedFields);
      const applied = Object.keys(split.apply) as RequestDraftField[];
      let version = r.draftVersion;
      if (applied.length > 0) {
        const next: Record<string, unknown> = { ...r.draftJson };
        for (const f of applied) {
          const v = split.apply[f];
          const empty = (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
          if (empty) delete next[f];
          else next[f] = v;
        }
        version = r.draftVersion + 1;
        await tx
          .update(requests)
          .set({
            draftJson: next as RequestDraft,
            draftVersion: version,
            lastActivityAt: input.now,
            updatedAt: input.now,
          })
          .where(eq(requests.id, r.id));
      }
      const card: RequestCard | null = input.proposal
        ? proposalCard(version, input.proposal.summary)
        : input.question
          ? {
              type: 'question',
              question: input.question.text,
              options: input.question.options,
              allowOwn: true,
            }
          : null;
      await tx.insert(requestMessages).values({
        requestId: r.id,
        kind: 'commander',
        body: clip(input.reply),
        ...(applied.length > 0
          ? { draftPatch: Object.fromEntries(applied.map((f) => [f, split.apply[f]])) }
          : {}),
        card,
        createdAt: input.now,
      });
      for (const s of split.suggest) {
        await tx.insert(requestMessages).values({
          requestId: r.id,
          kind: 'commander',
          body: clip(
            `建议改「${REQUEST_DRAFT_FIELD_WORDS[s.field]}」：${stringify(s.value)}（这一栏人改过，指挥官不直接改；要的话点采用）`,
          ),
          card: { type: 'suggest', field: s.field, value: s.value },
          createdAt: input.now,
        });
      }
      if (split.rejected.length > 0) {
        await tx.insert(auditLog).values({
          at: input.now,
          actorKind: 'engine',
          actorId: REQUEST_CHAT_ACTOR,
          action: 'request.commander_patch_rejected',
          target: `request:${r.seq}`,
          before: null,
          after: { rejected: split.rejected },
          reason: '指挥官的草稿补丁里有它不能改的栏或不合规矩的值，服务端拒掉',
          via: 'engine',
        });
        // 对话里也写一行：指挥官的回话可能说「补上了」，没改上的要让人看得见，不只记在操作记录里
        const words = split.rejected.map((x) =>
          x.field in REQUEST_DRAFT_FIELD_WORDS
            ? `「${REQUEST_DRAFT_FIELD_WORDS[x.field as keyof typeof REQUEST_DRAFT_FIELD_WORDS]}」`
            : `「${x.field}」`,
        );
        await tx.insert(requestMessages).values({
          requestId: r.id,
          kind: 'system',
          body: clip(
            `指挥官改单子有 ${words.length} 栏没改上：${words.join('、')}（格式不合规矩，单子里还是原样）`,
          ),
          createdAt: input.now,
        });
      }
      Object.assign(out, {
        written: true,
        applied,
        suggested: split.suggest.map((s) => s.field),
        rejected: split.rejected,
        draftVersion: version,
      });
    } else if (r) {
      await tx.insert(auditLog).values({
        at: input.now,
        actorKind: 'engine',
        actorId: REQUEST_CHAT_ACTOR,
        action: 'request.commander_reply_dropped',
        target: `request:${r.seq}`,
        before: null,
        after: { status: r.status, deleted: r.deletedAt !== null },
        reason: '指挥官回话时需求已经结案或删了：结案锁死，回话不写进去',
        via: 'engine',
      });
    }
    await tx
      .update(requestChats)
      .set({
        state: 'idle',
        job: null,
        queuedAt: null,
        stopRequestedAt: null,
        turns: out.written ? chat.turns + 1 : chat.turns,
        ...input.session,
        lastMessageId: await maxMessageId(tx, input.requestId),
        lastTurnAt: input.now,
        phase: null,
        streamText: '',
        pausedWhy: null,
        updatedAt: input.now,
      })
      .where(eq(requestChats.requestId, input.requestId));
    return out;
  });
}

/** 别家挑错回来了：意见存成一张卡（每条没标），会话回到 idle（不算轮数、不动指挥官的会话）。 */
export async function finishRequestReview(
  db: Db,
  input: { requestId: string; draftVersion: number; model: string; items: string[]; now: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { r, chat } = await lockForWrite(tx, input.requestId);
    if (!chat) return false;
    const written = !!r && r.deletedAt === null;
    if (r && written) {
      await tx.insert(requestMessages).values({
        requestId: r.id,
        kind: 'review',
        body: clip(`别家（${input.model}）挑了 ${input.items.length} 条（草稿第 ${input.draftVersion} 版）`),
        card: {
          type: 'review',
          draftVersion: input.draftVersion,
          model: input.model,
          items: input.items.map((text) => ({ text, verdict: null })),
        },
        createdAt: input.now,
      });
    }
    await tx
      .update(requestChats)
      .set({
        state: 'idle',
        job: null,
        queuedAt: null,
        stopRequestedAt: null,
        phase: null,
        streamText: '',
        pausedWhy: null,
        updatedAt: input.now,
      })
      .where(eq(requestChats.requestId, input.requestId));
    return written;
  });
}

/**
 * 这一轮没接上（选不到路由、额度在等、切号或发布排空停下、会话没成、回话认不出、有人点了停下）：
 * 写一条系统消息「指挥官暂停了：原因」（人点停下的不写暂停，写「停下了」），会话回到 idle；session 给了就照它记
 * （检出删了就传全空，下次按存档重起）。
 */
export async function failRequestChat(
  db: Db,
  input: { requestId: string; why: string; stoppedByHuman?: boolean; session: ChatSessionAfter; now: Date },
): Promise<void> {
  await db.transaction(async (tx) => {
    const { r, chat } = await lockForWrite(tx, input.requestId);
    if (!chat) return;
    const why = input.stoppedByHuman ? input.why : pausedWhy(input.why);
    if (r && r.deletedAt === null && r.status !== 'closed_do' && r.status !== 'closed_drop') {
      await tx.insert(requestMessages).values({
        requestId: r.id,
        kind: 'system',
        body: clip(why),
        card: input.stoppedByHuman ? null : { type: 'paused', why: clip(why) },
        createdAt: input.now,
      });
    }
    await tx
      .update(requestChats)
      .set({
        state: 'idle',
        job: null,
        queuedAt: null,
        stopRequestedAt: null,
        ...input.session,
        phase: null,
        streamText: '',
        pausedWhy: input.stoppedByHuman ? null : why,
        updatedAt: input.now,
      })
      .where(eq(requestChats.requestId, input.requestId));
  });
}

/** 闲着、会话还活着、上一轮在 cutoff 之前的：该收掉会话、删检出了。 */
export async function idleRequestChats(
  db: Db,
  cutoff: Date,
): Promise<{ requestId: string; workdir: string }[]> {
  const rows = await db
    .select({ requestId: requestChats.requestId, workdir: requestChats.workdir })
    .from(requestChats)
    .where(
      and(
        eq(requestChats.state, 'idle'),
        isNotNull(requestChats.workdir),
        lt(requestChats.lastTurnAt, cutoff),
      ),
    );
  return rows.flatMap((r) => (r.workdir ? [{ requestId: r.requestId, workdir: r.workdir }] : []));
}

/** 检出删掉了：清掉会话（还是闲着、还是这个检出才清：中间有人说话、起了新一轮的不动）。回清没清。 */
export async function forgetRequestChatSession(
  db: Db,
  input: { requestId: string; workdir: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(requestChats)
    .set({ sessionId: null, routeId: null, modelId: null, workdir: null, updatedAt: input.now })
    .where(
      and(
        eq(requestChats.requestId, input.requestId),
        eq(requestChats.state, 'idle'),
        eq(requestChats.workdir, input.workdir),
      ),
    )
    .returning({ id: requestChats.requestId });
  return rows.length > 0;
}

/**
 * 引擎重启时（上一个进程起的会话已经没了）卡在 running 的：写「指挥官暂停了：引擎重启，这一句没回完」，回到 idle，
 * 会话清掉（检出由引擎起来时的清理收）。回收掉了几条。
 */
export async function recoverRunningRequestChats(db: Db, now: Date): Promise<number> {
  const rows = await db
    .select({ requestId: requestChats.requestId })
    .from(requestChats)
    .where(eq(requestChats.state, 'running'));
  for (const row of rows) {
    await failRequestChat(db, {
      requestId: row.requestId,
      why: '引擎重启了，这一句没回完：再说一句或点「让指挥官接着问」',
      session: { sessionId: null, routeId: null, modelId: null, workdir: null },
      now,
    });
  }
  return rows.length;
}

/** 这几个模型是哪一族（别家挑错避开指挥官那一族）。库里没有的不给。 */
export async function modelFamilies(db: Db, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ family: models.family })
    .from(models)
    .where(inArray(models.id, [...ids]));
  return [...new Set(rows.map((m) => m.family))];
}
