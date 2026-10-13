// 驾驶舱「提需求」的存储（#2049，方案 specs/2047-提需求/方案.md 第一至三节）：建需求、发消息、改草稿、各种动作、列表、详情。
// 改这里之前必须知道：
// - 身份只认调用方给的 viewerId（接口从登录会话取），不认请求体里的任何身份字段。
// - 能不能做只按 @fleet-dao/shared 的 request-rules.ts 判；每个写操作先锁住那一行、在锁里读齐事实再判，判不过 409 + 中文原因。
// - 写操作和操作记录在同一个事务里：记不下就不改。
// - 没接上（开发环境的内存版没有这三张表）由接口写 unavailable（读）或回 503（写），不拿空列表冒充「没有需求」。
import { auditLog, type Db, repos, requestMessages, requests, requestUserState, users } from '@fleet-dao/db';
import {
  draftMissing,
  idleDays,
  purgeAt,
  type RequestActionRequest,
  type RequestDetailResponse,
  type RequestDraft,
  type RequestDraftField,
  type RequestDraftPatch,
  type RequestFacts,
  type RequestListResponse,
  type RequestMessage,
  type RequestPerson,
  type RequestRow,
  type RequestViewer,
  type RequestWaiting,
  requestActions,
} from '@fleet-dao/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { ApiError } from './http.ts';

type RequestRowDb = typeof requests.$inferSelect;
type MessageRowDb = typeof requestMessages.$inferSelect;
type UserRowDb = typeof users.$inferSelect;

export type RequestListBody = Omit<RequestListResponse, 'asOf' | 'view' | 'filter' | 'unavailable'>;
export type RequestDetailBody = Omit<RequestDetailResponse, 'asOf'>;

export interface RequestListInput {
  view: 'active' | 'archived' | 'deleted';
  filter: 'todo' | 'all' | 'mine';
  q?: string | undefined;
}

export interface CreateRequestInput {
  repoId: string;
  body: string;
  channel: 'web' | 'mobile';
  title?: string | undefined;
  continuesSeq?: number | undefined;
}

export interface SendMessageInput {
  body: string;
  channel: 'web' | 'mobile';
  mentions: string[];
}

export interface RequestsPort {
  list(viewerId: string, input: RequestListInput): Promise<RequestListBody>;
  /** 没有这条（或已被硬删）返回 null。 */
  detail(seq: number, viewerId: string): Promise<RequestDetailBody | null>;
  /** 回新需求号。 */
  create(viewerId: string, input: CreateRequestInput): Promise<number>;
  send(seq: number, viewerId: string, input: SendMessageInput): Promise<void>;
  editDraft(
    seq: number,
    viewerId: string,
    input: { baseVersion: number; patch: RequestDraftPatch },
  ): Promise<void>;
  act(seq: number, viewerId: string, input: RequestActionRequest): Promise<void>;
  markRead(seq: number, viewerId: string, messageId: number): Promise<number | null>;
}

/** 开发环境、内存版：没有需求表。 */
export const REQUESTS_NOT_HERE = '这台后端没接上需求表（开发环境的内存版没有），提需求用不了';

const iso = (d: Date) => d.toISOString();
const isoOpt = (d: Date | null) => (d === null ? undefined : d.toISOString());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function person(u: UserRowDb | undefined, id: string): RequestPerson {
  if (!u) return { id, name: '（已不在的用户）' };
  return { id: u.id, name: u.displayName, ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}) };
}

function preview(body: string): string {
  const one = body.replace(/\s+/g, ' ').trim();
  return one.length > 120 ? `${one.slice(0, 120)}…` : one;
}

function titleFrom(body: string): string {
  const first = body.trim().split('\n')[0]?.trim() ?? '';
  const t = first.length > 30 ? `${first.slice(0, 30)}…` : first;
  return t || '新需求';
}

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function refused(why: string): never {
  throw new ApiError(409, 'request_refused', why);
}

function notFound(seq: number): never {
  throw new ApiError(404, 'request_not_found', `没有需求 ${seq}`);
}

const ACTION_WORDS: Record<RequestActionRequest['action'], string> = {
  submit: '提交拍板',
  confirm: '确定开单',
  approve: '同意做',
  reject: '不做',
  rediscuss: '再聊聊',
  withdraw: '撤回到讨论中',
  drop: '放下',
  archive: '归档',
  unarchive: '取消归档',
  delete: '删除',
  restore: '恢复',
  pin: '置顶',
  unpin: '取消置顶',
  rename: '改名',
};

export function pgRequests(db: Db, now: () => Date): RequestsPort {
  async function userMap(ids: readonly string[]): Promise<Map<string, UserRowDb>> {
    const unique = [...new Set(ids)].filter((id) => UUID.test(id));
    if (unique.length === 0) return new Map();
    const rows = await db.select().from(users).where(inArray(users.id, unique));
    return new Map(rows.map((u) => [u.id, u]));
  }

  async function viewerOf(tx: Db, viewerId: string): Promise<RequestViewer> {
    const [u] = await tx
      .select({ id: users.id, decidesRequests: users.decidesRequests })
      .from(users)
      .where(eq(users.id, viewerId));
    if (!u) throw new ApiError(403, 'not_whitelisted', '登录的这个人不在 users 表里');
    return u;
  }

  /** users 表里的拍板人（在用的创始人、decides_requests）：有几位取最早建的那位。 */
  async function deciderOf(tx: Db): Promise<string | null> {
    const [d] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.decidesRequests, true), eq(users.active, true), eq(users.role, 'founder')))
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(1);
    return d?.id ?? null;
  }

  async function factsOf(tx: Db, r: RequestRowDb, viewerId: string) {
    const [initiator] = await tx
      .select({ decidesRequests: users.decidesRequests })
      .from(users)
      .where(eq(users.id, r.initiatorId));
    const [other] = await tx
      .select({ id: requestMessages.id })
      .from(requestMessages)
      .where(
        and(
          eq(requestMessages.requestId, r.id),
          eq(requestMessages.kind, 'human'),
          ne(requestMessages.authorId, r.initiatorId),
        ),
      )
      .limit(1);
    const [state] = await tx
      .select()
      .from(requestUserState)
      .where(and(eq(requestUserState.requestId, r.id), eq(requestUserState.userId, viewerId)));
    const decider = await deciderOf(tx);
    const facts: RequestFacts = {
      status: r.status,
      initiatorId: r.initiatorId,
      deciderId: r.deciderId,
      initiatorDecides: initiator?.decidesRequests ?? false,
      archived: r.archivedAt !== null,
      deletedAt: isoOpt(r.deletedAt) ?? null,
      everSubmitted: r.firstSubmittedAt !== null,
      otherHumanSpoke: other !== undefined,
      draftMissing: draftMissing(r.draftJson),
      pinned: (state?.pinnedAt ?? null) !== null,
    };
    return { facts, viewer: await viewerOf(tx, viewerId), decider, state };
  }

  async function lockRow(tx: Db, seq: number): Promise<RequestRowDb> {
    const [r] = await tx.select().from(requests).where(eq(requests.seq, seq)).for('update');
    if (!r) notFound(seq);
    return r;
  }

  async function audit(
    tx: Db,
    viewerId: string,
    seq: number,
    action: string,
    before: unknown,
    after: unknown,
    reason?: string,
  ) {
    await tx.insert(auditLog).values({
      at: now(),
      actorKind: 'user',
      actorId: viewerId,
      action,
      target: `request:${seq}`,
      before,
      after,
      reason: reason ?? null,
      via: 'cockpit',
    });
  }

  async function systemMessage(tx: Db, requestId: string, body: string) {
    await tx.insert(requestMessages).values({ requestId, kind: 'system', body, createdAt: now() });
  }

  /** 把一批需求拼成列表行（看的这个人的置顶、未读、等不等他）。 */
  async function rowsOf(list: readonly RequestRowDb[], viewerId: string): Promise<RequestRow[]> {
    if (list.length === 0) return [];
    const ids = list.map((r) => r.id);
    const at = now();
    const [lastMessages, speakers, states, unreadRows, asks, repoRows, continues] = await Promise.all([
      db
        .selectDistinctOn([requestMessages.requestId])
        .from(requestMessages)
        .where(inArray(requestMessages.requestId, ids))
        .orderBy(requestMessages.requestId, desc(requestMessages.id)),
      db
        .select({
          requestId: requestMessages.requestId,
          authorId: requestMessages.authorId,
          first: sql<number>`min(${requestMessages.id})`.mapWith(Number),
        })
        .from(requestMessages)
        .where(and(inArray(requestMessages.requestId, ids), eq(requestMessages.kind, 'human')))
        .groupBy(requestMessages.requestId, requestMessages.authorId),
      db
        .select()
        .from(requestUserState)
        .where(and(inArray(requestUserState.requestId, ids), eq(requestUserState.userId, viewerId))),
      db
        .select({ requestId: requestMessages.requestId, n: sql<number>`count(*)::int` })
        .from(requestMessages)
        .leftJoin(
          requestUserState,
          and(
            eq(requestUserState.requestId, requestMessages.requestId),
            eq(requestUserState.userId, viewerId),
          ),
        )
        .where(
          and(
            inArray(requestMessages.requestId, ids),
            or(
              isNull(requestUserState.lastReadMessageId),
              sql`${requestMessages.id} > ${requestUserState.lastReadMessageId}`,
            ),
            or(isNull(requestMessages.authorId), ne(requestMessages.authorId, viewerId)),
          ),
        )
        .groupBy(requestMessages.requestId),
      db
        .selectDistinct({ requestId: requestMessages.requestId })
        .from(requestMessages)
        .where(
          and(
            inArray(requestMessages.requestId, ids),
            eq(requestMessages.kind, 'engine_ask'),
            eq(requestMessages.answerState, 'pending'),
          ),
        ),
      db.select().from(repos),
      db
        .select({ id: requests.id, seq: requests.seq })
        .from(requests)
        .where(
          inArray(
            requests.id,
            list.map((r) => r.continuesRequestId).filter((x): x is string => x !== null),
          ),
        ),
    ]);
    const people = await userMap([
      ...list.map((r) => r.initiatorId),
      ...speakers.map((s) => s.authorId ?? ''),
      ...lastMessages.map((m) => m.authorId ?? ''),
    ]);
    const repoById = new Map(repoRows.map((r) => [r.id, r]));
    const lastBy = new Map(lastMessages.map((m) => [m.requestId, m]));
    const stateBy = new Map(states.map((s) => [s.requestId, s]));
    const unreadBy = new Map(unreadRows.map((u) => [u.requestId, u.n]));
    const askBy = new Set(asks.map((a) => a.requestId));
    const seqById = new Map(continues.map((c) => [c.id, c.seq]));

    return list.map((r): RequestRow => {
      const repo = repoById.get(r.repoId);
      const last = lastBy.get(r.id);
      const unread = unreadBy.get(r.id) ?? 0;
      const lastAuthor = last?.authorId ? people.get(last.authorId) : undefined;
      const waiting: RequestWaiting | null =
        r.status === 'pending_decision' && r.deciderId === viewerId
          ? 'decide'
          : askBy.has(r.id) && r.initiatorId === viewerId
            ? 'engine_ask'
            : unread > 0
              ? 'unread'
              : null;
      const deletedAt = isoOpt(r.deletedAt);
      const continuesSeq = r.continuesRequestId ? seqById.get(r.continuesRequestId) : undefined;
      return {
        seq: r.seq,
        title: r.draftJson.title,
        status: r.status,
        repo: { id: r.repoId, slug: repo ? `${repo.owner}/${repo.name}` : '（项目已移出驾驶舱）' },
        initiator: person(people.get(r.initiatorId), r.initiatorId),
        participants: speakers
          .filter((s) => s.requestId === r.id && s.authorId !== null && s.authorId !== r.initiatorId)
          .sort((a, b) => a.first - b.first)
          .map((s) => person(people.get(s.authorId ?? ''), s.authorId ?? '')),
        ...(last
          ? {
              lastMessage: {
                kind: last.kind,
                ...(lastAuthor ? { authorName: lastAuthor.displayName } : {}),
                preview: preview(last.body),
                at: iso(last.createdAt),
              },
            }
          : {}),
        lastActivityAt: iso(r.lastActivityAt),
        pinned: (stateBy.get(r.id)?.pinnedAt ?? null) !== null,
        unread,
        waitingOnMe: waiting,
        idleDays: idleDays(
          { status: r.status, lastActivityAt: iso(r.lastActivityAt), deletedAt: deletedAt ?? null },
          at,
        ),
        issueRefs: r.issueRefs,
        ...(continuesSeq !== undefined ? { continuesSeq } : {}),
        ...(r.archivedAt ? { archivedAt: iso(r.archivedAt) } : {}),
        ...(deletedAt ? { deletedAt, purgeAt: purgeAt(deletedAt) } : {}),
      };
    });
  }

  function viewWhere(view: RequestListInput['view'], viewerId: string) {
    if (view === 'deleted') return and(isNotNull(requests.deletedAt), eq(requests.initiatorId, viewerId));
    if (view === 'archived') return and(isNull(requests.deletedAt), isNotNull(requests.archivedAt));
    return and(isNull(requests.deletedAt), isNull(requests.archivedAt));
  }

  /** 按标题、原话（人说的）、单号搜，回命中的需求编号。 */
  async function searchIds(q: string): Promise<Set<string>> {
    const pattern = `%${escapeLike(q)}%`;
    const conds = [
      sql`${requests.draftJson}->>'title' ilike ${pattern}`,
      sql`exists (select 1 from ${requestMessages} where ${requestMessages.requestId} = ${requests.id} and ${requestMessages.kind} = 'human' and ${requestMessages.body} ilike ${pattern})`,
    ];
    const issue = /^#?(\d{1,9})$/.exec(q.trim());
    if (issue) {
      conds.push(sql`${requests.issueRefs} @> ${JSON.stringify([{ number: Number(issue[1]) }])}::jsonb`);
    }
    const rows = await db
      .select({ id: requests.id })
      .from(requests)
      .where(or(...conds));
    return new Set(rows.map((r) => r.id));
  }

  async function countWhere(where: ReturnType<typeof viewWhere>): Promise<number> {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(requests).where(where);
    return row?.n ?? 0;
  }

  return {
    async list(viewerId, input) {
      const inView = await db.select().from(requests).where(viewWhere(input.view, viewerId));
      const rows = await rowsOf(inView, viewerId);
      const initiatorBySeq = new Map(inView.map((r) => [r.seq, r.initiatorId]));
      const mine = (r: RequestRow) => initiatorBySeq.get(r.seq) === viewerId;
      const counts = {
        todo: rows.filter((r) => r.waitingOnMe !== null).length,
        all: rows.length,
        mine: rows.filter(mine).length,
        archived: await countWhere(viewWhere('archived', viewerId)),
        deleted: await countWhere(viewWhere('deleted', viewerId)),
      };
      let items =
        input.filter === 'todo'
          ? rows.filter((r) => r.waitingOnMe !== null)
          : input.filter === 'mine'
            ? rows.filter(mine)
            : rows;
      if (input.q) {
        const hit = await searchIds(input.q);
        const idBySeq = new Map(inView.map((r) => [r.seq, r.id]));
        items = items.filter((r) => hit.has(idBySeq.get(r.seq) ?? ''));
      }
      const pinnedAt = new Map(
        (
          await db
            .select()
            .from(requestUserState)
            .where(and(eq(requestUserState.userId, viewerId), isNotNull(requestUserState.pinnedAt)))
        ).map((s) => [s.requestId, s.pinnedAt?.getTime() ?? 0]),
      );
      const idBySeq = new Map(inView.map((r) => [r.seq, r.id]));
      items = [...items].sort((a, b) => {
        const pa = pinnedAt.get(idBySeq.get(a.seq) ?? '') ?? -1;
        const pb = pinnedAt.get(idBySeq.get(b.seq) ?? '') ?? -1;
        if (pa !== pb) return pb - pa;
        return b.lastActivityAt.localeCompare(a.lastActivityAt) || b.seq - a.seq;
      });
      return { counts, items };
    },

    async detail(seq, viewerId) {
      const [r] = await db.select().from(requests).where(eq(requests.seq, seq));
      if (!r) return null;
      const [row] = await rowsOf([r], viewerId);
      if (!row) return null;
      const messages = await db
        .select()
        .from(requestMessages)
        .where(eq(requestMessages.requestId, r.id))
        .orderBy(asc(requestMessages.id));
      const people = await userMap([
        ...messages.map((m) => m.authorId ?? ''),
        ...(r.deciderId ? [r.deciderId] : []),
      ]);
      const { facts, viewer, decider, state } = await factsOf(db, r, viewerId);
      const continuedBy = await db
        .select({ seq: requests.seq })
        .from(requests)
        .where(and(eq(requests.continuesRequestId, r.id), isNull(requests.deletedAt)))
        .orderBy(asc(requests.seq));
      const toMessage = (m: MessageRowDb): RequestMessage => ({
        id: m.id,
        kind: m.kind,
        ...(m.authorId ? { author: person(people.get(m.authorId), m.authorId) } : {}),
        ...(m.channel ? { channel: m.channel } : {}),
        body: m.body,
        mentions: m.mentions,
        ...(m.draftPatch ? { draftPatch: m.draftPatch } : {}),
        ...(m.githubCommentRef ? { githubCommentRef: m.githubCommentRef } : {}),
        ...(m.answerState ? { answerState: m.answerState } : {}),
        createdAt: iso(m.createdAt),
      });
      return {
        request: {
          ...row,
          draft: r.draftJson,
          draftVersion: r.draftVersion,
          humanEdited: r.humanEditedFields,
          needsDecision: !facts.initiatorDecides,
          ...(r.deciderId ? { decider: person(people.get(r.deciderId), r.deciderId) } : {}),
          ...(r.closedAt ? { closedAt: iso(r.closedAt) } : {}),
          ...(r.closeReason ? { closeReason: r.closeReason } : {}),
          ...(r.modelChoice ? { modelChoice: r.modelChoice } : {}),
          createdAt: iso(r.createdAt),
          continuedBy: continuedBy.map((c) => c.seq),
        },
        messages: messages.map(toMessage),
        lastReadMessageId: state?.lastReadMessageId ?? null,
        actions: requestActions(facts, viewer, { now: now(), deciderAvailable: decider !== null }),
      };
    },

    async create(viewerId, input) {
      return db.transaction(async (tx) => {
        await viewerOf(tx, viewerId);
        const [repo] = UUID.test(input.repoId)
          ? await tx.select().from(repos).where(eq(repos.id, input.repoId))
          : [];
        if (!repo) {
          throw new ApiError(404, 'repo_not_found', '没有这个项目：只能给驾驶舱里已导入的项目提需求');
        }
        let continuesRequestId: string | null = null;
        if (input.continuesSeq !== undefined) {
          const [prev] = await tx.select().from(requests).where(eq(requests.seq, input.continuesSeq));
          if (!prev || prev.deletedAt !== null) notFound(input.continuesSeq);
          if (prev.status !== 'closed_do' && prev.status !== 'closed_drop') {
            refused('只有已结案的需求能「接着这条提」：没结案的请直接在原来那条里接着聊');
          }
          continuesRequestId = prev.id;
        }
        const at = now();
        const [r] = await tx
          .insert(requests)
          .values({
            repoId: repo.id,
            initiatorId: viewerId,
            draftJson: { title: input.title ?? titleFrom(input.body) },
            humanEditedFields: input.title ? ['title'] : [],
            continuesRequestId,
            lastActivityAt: at,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (!r) throw new Error('需求没写进去');
        const [m] = await tx
          .insert(requestMessages)
          .values({
            requestId: r.id,
            kind: 'human',
            authorId: viewerId,
            channel: input.channel,
            body: input.body,
            createdAt: at,
          })
          .returning({ id: requestMessages.id });
        await tx
          .insert(requestUserState)
          .values({ requestId: r.id, userId: viewerId, lastReadMessageId: m?.id ?? null });
        await audit(tx, viewerId, r.seq, 'request.create', null, {
          repo: `${repo.owner}/${repo.name}`,
          title: r.draftJson.title,
          ...(input.continuesSeq !== undefined ? { continuesSeq: input.continuesSeq } : {}),
        });
        return r.seq;
      });
    },

    async send(seq, viewerId, input) {
      await db.transaction(async (tx) => {
        const r = await lockRow(tx, seq);
        const { facts, viewer, decider } = await factsOf(tx, r, viewerId);
        const v = requestActions(facts, viewer, { now: now(), deciderAvailable: decider !== null }).send;
        if (!v.allowed) refused(v.why ?? '不能发消息');
        const mentions = [...new Set(input.mentions)];
        if (mentions.length > 0) {
          const known = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(inArray(users.id, mentions), eq(users.active, true), eq(users.role, 'founder')));
          if (known.length !== mentions.length) {
            throw new ApiError(400, 'unknown_mention', '@ 的人里有不在驾驶舱的');
          }
        }
        const at = now();
        const [m] = await tx
          .insert(requestMessages)
          .values({
            requestId: r.id,
            kind: 'human',
            authorId: viewerId,
            channel: input.channel,
            body: input.body,
            mentions,
            createdAt: at,
          })
          .returning({ id: requestMessages.id });
        await tx.update(requests).set({ lastActivityAt: at, updatedAt: at }).where(eq(requests.id, r.id));
        if (m) {
          await tx
            .insert(requestUserState)
            .values({ requestId: r.id, userId: viewerId, lastReadMessageId: m.id })
            .onConflictDoUpdate({
              target: [requestUserState.requestId, requestUserState.userId],
              set: { lastReadMessageId: m.id },
            });
        }
      });
    },

    async editDraft(seq, viewerId, input) {
      await db.transaction(async (tx) => {
        const r = await lockRow(tx, seq);
        const { facts, viewer, decider } = await factsOf(tx, r, viewerId);
        const v = requestActions(facts, viewer, { now: now(), deciderAvailable: decider !== null }).editDraft;
        if (!v.allowed) refused(v.why ?? '不能改草稿');
        if (input.baseVersion !== r.draftVersion) {
          refused(`草稿已经改到第 ${r.draftVersion} 版，你看到的是第 ${input.baseVersion} 版：刷新后再改`);
        }
        const next: Record<string, unknown> = { ...r.draftJson };
        for (const [k, val] of Object.entries(input.patch)) {
          if (val === undefined) continue;
          const empty =
            (typeof val === 'string' && val.trim() === '') || (Array.isArray(val) && val.length === 0);
          if (empty) delete next[k];
          else next[k] = val;
        }
        const fields = Object.keys(input.patch) as RequestDraftField[];
        const humanEdited = [...new Set([...r.humanEditedFields, ...fields])];
        const at = now();
        await tx
          .update(requests)
          .set({
            draftJson: next as RequestDraft,
            draftVersion: r.draftVersion + 1,
            humanEditedFields: humanEdited,
            lastActivityAt: at,
            updatedAt: at,
          })
          .where(eq(requests.id, r.id));
        await audit(
          tx,
          viewerId,
          seq,
          'request.draft',
          { version: r.draftVersion },
          { version: r.draftVersion + 1, fields },
        );
      });
    },

    async act(seq, viewerId, input) {
      await db.transaction(async (tx) => {
        const r = await lockRow(tx, seq);
        const { facts, viewer, decider } = await factsOf(tx, r, viewerId);
        const at = now();
        const v = requestActions(facts, viewer, { now: at, deciderAvailable: decider !== null })[
          input.action
        ];
        if (!v.allowed) refused(v.why ?? `不能${ACTION_WORDS[input.action]}`);
        if ('draftVersion' in input && input.draftVersion !== r.draftVersion) {
          refused(
            `草稿已经改到第 ${r.draftVersion} 版，你看到的是第 ${input.draftVersion} 版：刷新看过最新的再${ACTION_WORDS[input.action]}`,
          );
        }
        const [me] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, viewerId));
        const who = me?.name ?? '有人';
        const before = { status: r.status, archived: r.archivedAt !== null, deleted: r.deletedAt !== null };
        const set = (values: Partial<typeof requests.$inferInsert>) =>
          tx
            .update(requests)
            .set({ ...values, updatedAt: at })
            .where(eq(requests.id, r.id));
        const setPin = (pinnedAt: Date | null) =>
          tx
            .insert(requestUserState)
            .values({ requestId: r.id, userId: viewerId, pinnedAt })
            .onConflictDoUpdate({
              target: [requestUserState.requestId, requestUserState.userId],
              set: { pinnedAt },
            });
        let reason: string | undefined;
        switch (input.action) {
          case 'submit': {
            if (decider === null) refused('没有能拍板的人');
            await set({
              status: 'pending_decision',
              deciderId: decider,
              firstSubmittedAt: r.firstSubmittedAt ?? at,
              lastActivityAt: at,
            });
            const [d] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, decider));
            await systemMessage(
              tx,
              r.id,
              `${who} 提交拍板（草稿第 ${r.draftVersion} 版），等 ${d?.name ?? '拍板人'} 拍`,
            );
            break;
          }
          case 'confirm':
            await set({ status: 'closed_do', deciderId: viewerId, closedAt: at, lastActivityAt: at });
            await systemMessage(tx, r.id, `${who} 确定开单（草稿第 ${r.draftVersion} 版），已结案`);
            break;
          case 'approve':
            await set({ status: 'closed_do', closedAt: at, lastActivityAt: at });
            await systemMessage(tx, r.id, `${who} 拍板：同意做（草稿第 ${r.draftVersion} 版），已结案`);
            break;
          case 'reject':
            reason = input.reason;
            // 已结案·不做马上归档
            await set({
              status: 'closed_drop',
              closedAt: at,
              closeReason: input.reason,
              archivedAt: at,
              lastActivityAt: at,
            });
            await systemMessage(tx, r.id, `${who} 拍板：不做。理由：${input.reason}`);
            break;
          case 'rediscuss':
            reason = input.note;
            await set({ status: 'discussing', lastActivityAt: at });
            await systemMessage(tx, r.id, `${who} 点了「再聊聊」${input.note ? `：${input.note}` : ''}`);
            break;
          case 'withdraw':
            await set({ status: 'discussing', lastActivityAt: at });
            await systemMessage(tx, r.id, `${who} 撤回到讨论中`);
            break;
          case 'drop':
            reason = input.reason;
            await set({
              status: 'closed_drop',
              closedAt: at,
              closeReason: input.reason,
              archivedAt: at,
              lastActivityAt: at,
            });
            await systemMessage(tx, r.id, `${who} 放下了这条需求。理由：${input.reason}`);
            break;
          case 'archive':
            await set({ archivedAt: at });
            break;
          case 'unarchive':
            await set({ archivedAt: null });
            break;
          case 'delete':
            await set({ deletedAt: at });
            break;
          case 'restore':
            await set({ deletedAt: null });
            break;
          case 'pin':
            await setPin(at);
            break;
          case 'unpin':
            await setPin(null);
            break;
          case 'rename':
            await set({
              draftJson: { ...r.draftJson, title: input.title },
              draftVersion: r.draftVersion + 1,
              humanEditedFields: [...new Set([...r.humanEditedFields, 'title' as const])],
              lastActivityAt: at,
            });
            break;
        }
        const [after] = await tx.select().from(requests).where(eq(requests.id, r.id));
        await audit(
          tx,
          viewerId,
          seq,
          `request.${input.action}`,
          before,
          after
            ? { status: after.status, archived: after.archivedAt !== null, deleted: after.deletedAt !== null }
            : null,
          reason,
        );
      });
    },

    async markRead(seq, viewerId, messageId) {
      return db.transaction(async (tx) => {
        const [r] = await tx.select({ id: requests.id }).from(requests).where(eq(requests.seq, seq));
        if (!r) notFound(seq);
        const [m] = await tx
          .select({ id: requestMessages.id })
          .from(requestMessages)
          .where(and(eq(requestMessages.requestId, r.id), eq(requestMessages.id, messageId)));
        if (!m) throw new ApiError(404, 'message_not_found', `需求 ${seq} 里没有消息 ${messageId}`);
        // 只往前走：读到更早的一条不把指针拨回去
        await tx
          .insert(requestUserState)
          .values({ requestId: r.id, userId: viewerId, lastReadMessageId: messageId })
          .onConflictDoUpdate({
            target: [requestUserState.requestId, requestUserState.userId],
            set: {
              lastReadMessageId: sql`greatest(coalesce(${requestUserState.lastReadMessageId}, 0), ${messageId})`,
            },
          });
        const [s] = await tx
          .select({ last: requestUserState.lastReadMessageId })
          .from(requestUserState)
          .where(and(eq(requestUserState.requestId, r.id), eq(requestUserState.userId, viewerId)));
        return s?.last ?? null;
      });
    },
  };
}
