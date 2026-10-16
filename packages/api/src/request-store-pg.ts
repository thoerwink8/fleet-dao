// 驾驶舱「提需求」的存储（#2049，方案 specs/2047-提需求/方案.md 第一至三节）：建需求、发消息、改草稿、各种动作、列表、详情。
// 改这里之前必须知道：
// - 身份只认调用方给的 viewerId（接口从登录会话取），不认请求体里的任何身份字段。
// - 能不能做只按 @fleet-dao/shared 的 request-rules.ts 判；每个写操作先锁住那一行、在锁里读齐事实再判，判不过 409 + 中文原因。
// - 写操作和操作记录在同一个事务里：记不下就不改。
// - 没接上（开发环境的内存版没有这三张表）由接口写 unavailable（读）或回 503（写），不拿空列表冒充「没有需求」。
import { createHash } from 'node:crypto';
import {
  applyRequestIssueState,
  auditLog,
  type Db,
  repos,
  requestIssueOpenings,
  requestMessages,
  requests,
  requestUserState,
  users,
} from '@fleet-dao/db';
import { assertPublishable, isGitHubError } from '@fleet-dao/github';
import {
  DELETED_WHY,
  draftMissing,
  INTAKE_CHAT_LIMITS,
  type IntakeChatLimits,
  idleDays,
  purgeAt,
  type RequestActionRequest,
  type RequestDetailResponse,
  type RequestDraft,
  type RequestDraftField,
  type RequestDraftPatch,
  type RequestFacts,
  type RequestIssueOpeningResponse,
  type RequestListResponse,
  type RequestMessage,
  type RequestPerson,
  type RequestRow,
  type RequestViewer,
  type RequestWaiting,
  requestActions,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { ApiError } from './http.ts';
import { commanderOf, commanderRunning } from './request-chat-pg.ts';
import {
  checkOpening,
  ISSUES_NOT_HERE,
  issueKey,
  issueOfCommentRef,
  openingKey,
  type QuotedMessage,
  type RequestIssuePort,
} from './request-issue.ts';

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
  /** 「需求号 + 草稿版本号」这一键的开单开没开成；没有这条需求返回 null。 */
  openingState(seq: number, draftVersion: number): Promise<RequestIssueOpeningBody | null>;
  /** 回答引擎的一条提问，写回那条评论下面；写失败记 failed 并抛 502（同一个调用再来一次就是重试）。 */
  answerAsk(seq: number, viewerId: string, messageId: number, text: string): Promise<void>;
  /** 这些单（仓 owner/name + 单号）是哪条需求开出来的；没有的不在结果里。键是 `owner/name#号`（小写）。 */
  seqsForIssues(issues: readonly { repo: string; number: number }[]): Promise<Map<string, number>>;
}

export type RequestIssueOpeningBody = Omit<RequestIssueOpeningResponse, 'asOf'>;

/** 开发环境、内存版：没有需求表。 */
export const REQUESTS_NOT_HERE = '这台后端没接上需求表（开发环境的内存版没有），提需求用不了';

/** 占了开单的行却一直没结果（后端中途断了）超过这么久，当作断了：可以重新占。 */
export const OPENING_STALE_MS = 3 * 60_000;

/** 开单、写回评论要的外部口。issues 没给就回 503 说没接上。 */
export interface RequestsOptions {
  issues?: RequestIssuePort | undefined;
  /** 驾驶舱地址（config.publicUrl.origin）：写进单子正文的链接。 */
  cockpitUrl?: string | undefined;
  /** 卫生检查管哪个仓（默认 fleet-dao 自己）；测试夹具的仓不是它时指过去。 */
  hygieneRepo?: { owner: string; name: string } | undefined;
  /** 指挥官会话的限额（C 片 #2061）：每人同时几条在聊、每条几轮；不给用默认。 */
  limits?: IntakeChatLimits | undefined;
}

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
  reopen: '重开',
  drop: '放下',
  archive: '归档',
  unarchive: '取消归档',
  delete: '删除',
  restore: '恢复',
  pin: '置顶',
  unpin: '取消置顶',
  rename: '改名',
};

export function pgRequests(db: Db, now: () => Date, options: RequestsOptions = {}): RequestsPort {
  const limits = options.limits ?? INTAKE_CHAT_LIMITS;
  /** 事务里调要把 tx 传进来：用外面的 db 会另占一条连接，单连接的库（PGlite）上就是自己等自己。 */
  async function userMap(ids: readonly string[], q: Db = db): Promise<Map<string, UserRowDb>> {
    const unique = [...new Set(ids)].filter((id) => UUID.test(id));
    if (unique.length === 0) return new Map();
    const rows = await q.select().from(users).where(inArray(users.id, unique));
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
      commanderRunning: await commanderRunning(tx, r.id),
      closeReason: r.closeReason,
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

  const freshOpening = (o: { state: string; updatedAt: Date }) =>
    o.state === 'opening' && now().getTime() - o.updatedAt.getTime() < OPENING_STALE_MS;

  /** 这条需求正在开单（有一键占着行、还没结果、没超时）：对话、草稿、别的动作先别动，免得开出去的和库里的对不上。 */
  async function assertNotOpening(tx: Db, requestId: string) {
    const rows = await tx
      .select()
      .from(requestIssueOpenings)
      .where(and(eq(requestIssueOpenings.requestId, requestId), eq(requestIssueOpenings.state, 'opening')));
    const live = rows.find(freshOpening);
    if (live) refused(`正在开单中（草稿第 ${live.draftVersion} 版）：等结果出来再动`);
  }

  /** 开单、写回评论的外部口；没接上明说，不假装开了。 */
  function issuesPort(): RequestIssuePort {
    if (!options.issues) throw new ApiError(503, 'issues_unavailable', ISSUES_NOT_HERE);
    return options.issues;
  }

  function cockpitUrl(): string {
    if (!options.cockpitUrl) {
      throw new ApiError(
        503,
        'cockpit_url_unavailable',
        '读不到驾驶舱地址（FLEET_PUBLIC_URL）：写不出单子正文里的链接，单没开',
      );
    }
    return options.cockpitUrl.replace(/\/+$/, '');
  }

  /** GitHub 那边拒掉是内容的问题（卫生检查、标题正文不合规）的，回 409 让人改；别的回 502。 */
  function githubFailure(err: unknown, what: string): ApiError {
    const why = errMessage(err);
    if (
      isGitHubError(err) &&
      ['HYGIENE_BLOCKED', 'HYGIENE_UNSCANNED', 'INVALID_INPUT', 'BODY_TOO_LONG'].includes(err.code)
    ) {
      return new ApiError(409, 'request_refused', `${what}没成：${why}`);
    }
    return new ApiError(502, 'github_failed', `${what}没成：${why}`);
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
            // 「指挥官暂停了」是接着人刚说的那句当场回的，不算一条要回来看的新消息（列表上不挂「等我 1」）
            sql`coalesce(${requestMessages.card}->>'type', '') <> 'paused'`,
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

  /**
   * 「确定，开单」和拍板人「同意做」（方案第一节规则 6、第六节）：在 GitHub 上用「引擎」机器人开单，再把需求结案。三步：
   * 1. 事务里锁住那一行、判能不能做和版本，拼正文过四节检查和卫生检查（不过 409，一次 GitHub 请求都没发），占开单记录一行
   *    （键是需求号 + 草稿版本号，提出人此刻写进去）。占着的时候对话、草稿、别的动作都先别动（assertNotOpening）。
   * 2. 不在事务里调 GitHub 开单（幂等：同一键重来拿回同一张）；开不成记 failed + 原因，回 409（内容问题）或 502。
   * 3. 事务里把开单记录记成 opened、需求结案、记下这张单（状态「开着」）、追加一条系统消息。
   * 同一版重复请求：开过且已结案的原样回成功（不再开）；开过但没来得及结案的跳过第 2 步直接结案。
   */
  async function openAndClose(
    seq: number,
    viewerId: string,
    input: Extract<RequestActionRequest, { action: 'confirm' | 'approve' }>,
  ): Promise<void> {
    const issues = issuesPort();
    const baseUrl = cockpitUrl();
    const words = ACTION_WORDS[input.action];
    // —— 第 1 步 ——
    const plan = await db.transaction(async (tx) => {
      const r = await lockRow(tx, seq);
      const [existing] = await tx
        .select()
        .from(requestIssueOpenings)
        .where(
          and(
            eq(requestIssueOpenings.requestId, r.id),
            eq(requestIssueOpenings.draftVersion, input.draftVersion),
          ),
        );
      // 同一版重复请求：开过且已经结案，原样回成功（页面超时后重点也只开这一张）
      if (existing?.state === 'opened' && r.status === 'closed_do' && existing.openedBy === viewerId) {
        return { done: true as const };
      }
      const { facts, viewer, decider } = await factsOf(tx, r, viewerId);
      const at = now();
      const v = requestActions(facts, viewer, { now: at, deciderAvailable: decider !== null })[input.action];
      if (!v.allowed) refused(v.why ?? `不能${words}`);
      if (input.draftVersion !== r.draftVersion) {
        refused(
          `草稿已经改到第 ${r.draftVersion} 版，你看到的是第 ${input.draftVersion} 版：刷新看过最新的再${words}`,
        );
      }
      if (existing && freshOpening(existing)) {
        refused(
          `这一版（草稿第 ${input.draftVersion} 版）正在开单中：稍等，用「查开单结果」看有没有开成，不要重点`,
        );
      }
      const [repo] = await tx.select().from(repos).where(eq(repos.id, r.repoId));
      if (!repo) {
        throw new ApiError(404, 'repo_not_found', '这个项目已移出驾驶舱：只能给已导入的项目开单');
      }
      const repoRef = { owner: repo.owner, name: repo.name };
      // 开过但没来得及结案（上次第 3 步没写成）：单已经有了，直接结案
      if (existing?.state === 'opened' && existing.issueNumber !== null && existing.issueUrl !== null) {
        return {
          done: false as const,
          repoRef,
          requestId: r.id,
          opened: { number: existing.issueNumber, url: existing.issueUrl },
        };
      }
      const people = await userMap(
        [r.initiatorId, ...(input.action === 'approve' && r.deciderId ? [r.deciderId] : [viewerId])],
        tx,
      );
      const humans = await tx
        .select()
        .from(requestMessages)
        .where(and(eq(requestMessages.requestId, r.id), eq(requestMessages.kind, 'human')))
        .orderBy(asc(requestMessages.id));
      const authors = await userMap(
        humans.map((m) => m.authorId ?? ''),
        tx,
      );
      const messages: QuotedMessage[] = humans.map((m) => ({
        authorName: authors.get(m.authorId ?? '')?.displayName ?? '（已不在的用户）',
        channel: m.channel ?? 'web',
        at: m.createdAt,
        body: m.body,
      }));
      const deciderId = input.action === 'approve' ? (r.deciderId ?? viewerId) : viewerId;
      const checked = checkOpening({
        seq: r.seq,
        draft: r.draftJson,
        humanEdited: r.humanEditedFields,
        messages,
        requesterName: people.get(r.initiatorId)?.displayName ?? '（已不在的用户）',
        deciderName: people.get(deciderId)?.displayName ?? '（已不在的用户）',
        cockpitUrl: baseUrl,
      });
      if (!checked.ok) refused(checked.why);
      // 正文写进 GitHub 前过卫生检查（和引擎开单、写评论同一套）：不过就不开，回原因
      try {
        assertPublishable(
          repoRef,
          `开 ${repo.owner}/${repo.name} 的单子`,
          [
            { path: '单子标题', text: checked.title },
            { path: '单子正文', text: checked.body },
          ],
          options.hygieneRepo,
        );
      } catch (err) {
        throw githubFailure(err, '开单');
      }
      await tx
        .insert(requestIssueOpenings)
        .values({
          requestId: r.id,
          draftVersion: input.draftVersion,
          state: 'opening',
          requestedBy: r.initiatorId,
          openedBy: viewerId,
          createdAt: at,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [requestIssueOpenings.requestId, requestIssueOpenings.draftVersion],
          set: {
            state: 'opening',
            requestedBy: r.initiatorId,
            openedBy: viewerId,
            issueNumber: null,
            issueUrl: null,
            error: null,
            updatedAt: at,
          },
        });
      return {
        done: false as const,
        repoRef,
        requestId: r.id,
        title: checked.title,
        body: checked.body,
        labels: checked.labels,
        opened: null,
      };
    });
    if (plan.done) return;

    const settle = (patch: Partial<typeof requestIssueOpenings.$inferInsert>) =>
      db
        .update(requestIssueOpenings)
        .set({ ...patch, updatedAt: now() })
        .where(
          and(
            eq(requestIssueOpenings.requestId, plan.requestId),
            eq(requestIssueOpenings.draftVersion, input.draftVersion),
          ),
        );

    // —— 第 2 步 ——
    let issue: { number: number; url: string };
    if (plan.opened !== null) {
      issue = plan.opened;
    } else {
      try {
        const got = await issues.openIssue({
          repo: plan.repoRef,
          key: openingKey(seq, input.draftVersion),
          title: plan.title,
          body: plan.body,
          labels: plan.labels,
        });
        issue = { number: got.number, url: got.url };
      } catch (err) {
        const failure = githubFailure(err, '开单');
        await settle({ state: 'failed', error: failure.message });
        throw failure;
      }
      // 先单独记一笔「开成了」：第 3 步要是没写成，重来时认得出单已经有了，不会再去开
      await settle({ state: 'opened', issueNumber: issue.number, issueUrl: issue.url, error: null });
    }

    // —— 第 3 步 ——
    await db.transaction(async (tx) => {
      const r = await lockRow(tx, seq);
      const { facts, viewer, decider } = await factsOf(tx, r, viewerId);
      const at = now();
      const v = requestActions(facts, viewer, { now: at, deciderAvailable: decider !== null })[input.action];
      if (!v.allowed || r.draftVersion !== input.draftVersion) {
        refused(
          `单已经开出（${plan.repoRef.owner}/${plan.repoRef.name}#${issue.number} ${issue.url}），可需求的状态在这期间变了，没能结案：请联系管理员核对`,
        );
      }
      const [me] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, viewerId));
      const who = me?.name ?? '有人';
      await tx
        .update(requests)
        .set({
          status: 'closed_do',
          ...(input.action === 'confirm' ? { deciderId: viewerId } : {}),
          closedAt: at,
          lastActivityAt: at,
          updatedAt: at,
        })
        .where(eq(requests.id, r.id));
      await applyRequestIssueState(tx, {
        seq,
        repo: `${plan.repoRef.owner}/${plan.repoRef.name}`,
        number: issue.number,
        state: 'open',
        at,
      });
      await systemMessage(
        tx,
        r.id,
        input.action === 'confirm'
          ? `${who} 确定开单（草稿第 ${r.draftVersion} 版），已结案。开出 #${issue.number}：${issue.url}`
          : `${who} 拍板：同意做（草稿第 ${r.draftVersion} 版），已结案。开出 #${issue.number}：${issue.url}`,
      );
      await audit(
        tx,
        viewerId,
        seq,
        `request.${input.action}`,
        { status: r.status, archived: false, deleted: false },
        { status: 'closed_do', archived: false, deleted: false, issue: `#${issue.number}` },
      );
    });
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
        ...messages.map((m) => m.answeredBy ?? ''),
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
        ...(m.answerText !== null && m.answeredAt !== null
          ? {
              answer: {
                text: m.answerText,
                ...(m.answeredBy ? { by: person(people.get(m.answeredBy), m.answeredBy) } : {}),
                at: iso(m.answeredAt),
                ...(m.answerError ? { error: m.answerError } : {}),
              },
            }
          : {}),
        ...(m.card ? { card: m.card } : {}),
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
        commander: await commanderOf(db, r, limits),
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
        await assertNotOpening(tx, r.id);
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
        await assertNotOpening(tx, r.id);
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
      // 确定开单、同意做：要在 GitHub 上开单，不能整个包在一个事务里（见 openAndClose）
      if (input.action === 'confirm' || input.action === 'approve') {
        await openAndClose(seq, viewerId, input);
        return;
      }
      await db.transaction(async (tx) => {
        const r = await lockRow(tx, seq);
        const { facts, viewer, decider } = await factsOf(tx, r, viewerId);
        const at = now();
        const v = requestActions(facts, viewer, { now: at, deciderAvailable: decider !== null })[
          input.action
        ];
        if (!v.allowed) refused(v.why ?? `不能${ACTION_WORDS[input.action]}`);
        await assertNotOpening(tx, r.id);
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
          case 'reopen':
            await set({
              status: 'discussing',
              closedAt: null,
              closeReason: null,
              archivedAt: null,
              lastActivityAt: at,
            });
            await systemMessage(tx, r.id, `${who} 重开了这条需求，回到讨论中`);
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

    async openingState(seq, draftVersion) {
      const [r] = await db.select({ id: requests.id }).from(requests).where(eq(requests.seq, seq));
      if (!r) return null;
      const [o] = await db
        .select()
        .from(requestIssueOpenings)
        .where(
          and(eq(requestIssueOpenings.requestId, r.id), eq(requestIssueOpenings.draftVersion, draftVersion)),
        );
      if (!o) return { seq, draftVersion, state: 'none' };
      const people = await userMap([o.requestedBy]);
      const base = {
        seq,
        draftVersion,
        requestedBy: person(people.get(o.requestedBy), o.requestedBy),
        updatedAt: iso(o.updatedAt),
      };
      if (o.state === 'opened' && o.issueNumber !== null && o.issueUrl !== null) {
        const [repo] = await db
          .select({ owner: repos.owner, name: repos.name })
          .from(requests)
          .innerJoin(repos, eq(repos.id, requests.repoId))
          .where(eq(requests.id, r.id));
        return {
          ...base,
          state: 'opened',
          issue: {
            repo: repo ? `${repo.owner}/${repo.name}` : '（项目已移出驾驶舱）',
            number: o.issueNumber,
            url: o.issueUrl,
          },
        };
      }
      if (o.state === 'failed') return { ...base, state: 'failed', error: o.error ?? '没开成（原因没记下）' };
      // 占着行却一直没结果：后端中途断了，当作没开成，可以重来
      if (!freshOpening(o)) {
        return {
          ...base,
          state: 'failed',
          error: '上一次开单中途断了（超过 3 分钟没有结果），可以重新点一次',
        };
      }
      return { ...base, state: 'opening' };
    },

    async answerAsk(seq, viewerId, messageId, text) {
      const issues = issuesPort();
      const plan = await db.transaction(async (tx) => {
        const r = await lockRow(tx, seq);
        if (r.deletedAt !== null) refused(DELETED_WHY);
        const viewer = await viewerOf(tx, viewerId);
        if (viewerId !== r.initiatorId && viewerId !== r.deciderId && !viewer.decidesRequests) {
          throw new ApiError(403, 'not_allowed', '只有发起人或拍板人能回答引擎的提问');
        }
        const [m] = await tx
          .select()
          .from(requestMessages)
          .where(and(eq(requestMessages.requestId, r.id), eq(requestMessages.id, messageId)));
        if (!m) throw new ApiError(404, 'message_not_found', `需求 ${seq} 里没有消息 ${messageId}`);
        if (m.kind !== 'engine_ask' || !m.githubCommentRef) refused('这条不是引擎的提问，没有可回答的');
        if (m.answerState === 'written') refused('这条提问已经答过了，答复已经写回 GitHub');
        const target = issueOfCommentRef(m.githubCommentRef);
        if (!target) refused(`这条提问绑定的评论网址认不出（${m.githubCommentRef}），写不回去`);
        const [me] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, viewerId));
        const body = `> 回复 ${m.githubCommentRef}\n\n${text}\n\n— ${me?.name ?? '驾驶舱用户'}，来自驾驶舱 需求 ${seq}`;
        try {
          assertPublishable(target.repo, '写评论', [{ path: '评论正文', text: body }], options.hygieneRepo);
        } catch (err) {
          throw githubFailure(err, '回答');
        }
        // 答复文字先存下：写回失败了页面点重试不用重打
        await tx
          .update(requestMessages)
          .set({ answerText: text, answeredBy: viewerId, answeredAt: now() })
          .where(eq(requestMessages.id, m.id));
        return { target, body, commentRef: m.githubCommentRef, requestId: r.id, messageId: m.id };
      });

      const key = `request-answer:${plan.messageId}:${createHash('sha1').update(text).digest('hex').slice(0, 12)}`;
      let failure: ApiError | null = null;
      try {
        await issues.commentIssue({
          repo: plan.target.repo,
          issueNumber: plan.target.issueNumber,
          key,
          body: plan.body,
        });
      } catch (err) {
        failure = githubFailure(err, '把答复写回 GitHub');
      }
      const at = now();
      await db.transaction(async (tx) => {
        await tx
          .update(requestMessages)
          .set(
            failure
              ? { answerState: 'failed', answerError: failure.message }
              : { answerState: 'written', answerError: null, answeredAt: at },
          )
          .where(eq(requestMessages.id, plan.messageId));
        await tx
          .update(requests)
          .set({ lastActivityAt: at, updatedAt: at })
          .where(eq(requests.id, plan.requestId));
        await audit(
          tx,
          viewerId,
          seq,
          failure ? 'request.answer_failed' : 'request.answer',
          { messageId: plan.messageId },
          { commentRef: plan.commentRef },
          failure?.message,
        );
      });
      if (failure) throw failure;
    },

    async seqsForIssues(issues) {
      const out = new Map<string, number>();
      if (issues.length === 0) return out;
      const rows = await db
        .select({ seq: requests.seq, issueRefs: requests.issueRefs })
        .from(requests)
        .where(
          or(
            ...issues.map(
              (i) => sql`${requests.issueRefs} @> ${JSON.stringify([{ number: i.number }])}::jsonb`,
            ),
          ),
        );
      const want = new Set(issues.map((i) => issueKey(i.repo, i.number)));
      for (const r of rows) {
        for (const ref of r.issueRefs) {
          const k = issueKey(ref.repo, ref.number);
          if (want.has(k)) out.set(k, r.seq);
        }
      }
      return out;
    },
  };
}
