// 飞书网关要的 9 条接口（shared/feishu-api.ts 的 FeishuRoutes），挂在 /api 下。只认网关通行证；每条按路由表的 acting 放行：
// required 的认出代表哪位创始人（操作记录 via=feishu），none 的只验通行证、带了代表人也不认。数据一律从库里读写。
// 还没接模型理解：一句话按原话记成草稿、标「拿不准」；回复别的卡时答不了的明说，不编；回复的卡对应的东西读不到也明说，
// 不悄悄当成别的事（另起草稿、吞掉回答）。进来的话先规范化（wellFormed）。
import {
  FEISHU_NOTE_MAX,
  type FeishuActing,
  FeishuBoardSnapshotSchema,
  FeishuConfirmDraftRequest,
  FeishuConfirmDraftResponse,
  FeishuDraftConflictDetails,
  FeishuFollowRequest,
  FeishuFollowResponse,
  FeishuMessageRequest,
  FeishuMessageResponse,
  FeishuOkResponse,
  FeishuOutboxAckRequest,
  FeishuOutboxQuery,
  FeishuOutboxResponse,
  FeishuPutCardRequest,
  FeishuReviseDraftRequest,
  FeishuReviseDraftResponse,
  type FeishuRoute,
  FeishuRoutes,
  FeishuTaskLookupQuery,
  FeishuTaskLookupResponse,
  SETTING_SCHEMAS,
} from '@fleet-dao/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { answerAsk } from './answer-ask.ts';
import type { AskWaiters } from './changes.ts';
import type { Deps } from './deps.ts';
import type { DraftOpenRunner } from './draft-opening.ts';
import { textHash, wellFormed } from './feishu-records.ts';
import {
  ANSWER_TEXTS,
  beijingDayStart,
  buildFeishuBoard,
  cardReplyText,
  composeOutbox,
  draftView,
  firstUnderstanding,
  fullName,
  guessRepo,
  pendingOutbox,
} from './feishu-views.ts';
import { ApiError, readJson, readQuery, reply } from './http.ts';
import type {
  Actor,
  ChangeFeed,
  DraftRecord,
  FeishuMessageKey,
  FeishuMessageRecord,
  FeishuMessageResult,
  NewAuditEntry,
} from './ports.ts';
import { actingFounder, type CockpitUser, checkGatewayPass } from './session.ts';
import { routeLookup } from './views.ts';

export type FeishuEnv = { Variables: { founder: CockpitUser | undefined } };

/** 已经了结的推送再看多久（卡发出 14 天后飞书就不让改了，多留一天）。 */
const OUTBOX_LOOKBACK_MS = 15 * 24 * 60 * 60_000;
/** 长轮询时没被叫醒也隔这么久回库看一眼（别的进程——引擎——写的变化不一定叫得醒这里）。 */
export const OUTBOX_POLL_MS = 3_000;
const OUTBOX_BATCH = 100;
const MessageIdParam = z.string().min(1).max(100);
const TERMINAL = new Set(['done', 'stopped', 'failed']);

export function feishuRoutes(deps: Deps, waiters: AskWaiters, opening: DraftOpenRunner): Hono<FeishuEnv> {
  const { store, log } = deps;
  const app = new Hono<FeishuEnv>();
  const outboxWake = createOutboxWake(deps.changes);

  const gate =
    (acting: FeishuActing): MiddlewareHandler<FeishuEnv> =>
    async (c, next) => {
      const authorization = c.req.header('authorization');
      if (authorization === undefined) {
        throw new ApiError(401, 'gateway_pass_missing', '飞书接口只给飞书网关用：要带网关通行证');
      }
      checkGatewayPass(deps.config, authorization);
      c.set('founder', acting === 'required' ? await actingFounder(c, store) : undefined);
      await next();
    };

  /** 按路由表挂：方法、路径、acting 都取自 FeishuRoutes，挂错了当场就对不上。 */
  const on = (route: FeishuRoute, handler: (c: Context<FeishuEnv>) => Promise<Response>) =>
    app.on(route.method, route.path, gate(route.acting), handler);

  const founderOf = (c: Context<FeishuEnv>): CockpitUser => {
    const founder = c.get('founder');
    if (!founder) throw new ApiError(500, 'acting_lost', '这条接口要代表某位创始人，却没认出是谁');
    return founder;
  };
  const actorOf = (founder: CockpitUser): Actor => ({ kind: 'user', id: founder.id });
  const auditOf = (founder: CockpitUser, action: string, target: string, after?: unknown): NewAuditEntry => ({
    actor: actorOf(founder),
    action,
    target,
    ...(after === undefined ? {} : { after }),
    via: 'feishu',
    ok: true,
  });

  // —— 草稿的样子（仓名、人名、任务号现查）——

  async function view(d: DraftRecord) {
    const [repos, users, task] = await Promise.all([
      store.listRepos(),
      store.listUsers(),
      d.taskId === undefined ? null : store.getTask(d.taskId),
    ]);
    const taskRepo = task ? repos.find((r) => r.id === task.repoId) : undefined;
    try {
      return draftView(d, { repos, users, task: task && taskRepo ? { task, repo: taskRepo } : undefined });
    } catch (err) {
      throw new ApiError(
        500,
        'draft_unreadable',
        `草稿读不全：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function conflictDetails(d: DraftRecord) {
    const parsed = FeishuDraftConflictDetails.safeParse({ draft: await view(d) });
    if (!parsed.success) {
      throw new ApiError(500, 'bad_response_shape', '后端返回的数据不符合约定', parsed.error.issues);
    }
    return parsed.data;
  }

  // —— 一句话（POST /feishu/messages）——

  /** 同一个消息编号换了人、换了话、换了回复对象再来：网关出了错，拒收，不回别人的结果。 */
  function sameMessage(rec: FeishuMessageRecord, message: FeishuMessageKey): FeishuMessageRecord {
    if (
      rec.userId !== message.userId ||
      rec.textHash !== message.textHash ||
      rec.replyToMessageId !== message.replyToMessageId
    ) {
      throw new ApiError(
        409,
        'message_reused',
        '这个飞书消息编号已经用在另一句话上了（网关出错？），没有处理',
      );
    }
    return rec;
  }

  async function replyMessage(c: Context<FeishuEnv>, rec: FeishuMessageRecord): Promise<Response> {
    if (rec.result.kind === 'answer') {
      return reply(c, FeishuMessageResponse, {
        kind: 'answer',
        text: rec.result.text,
        ...(rec.result.taskId === undefined ? {} : { taskId: rec.result.taskId }),
      });
    }
    const draft = await store.getDraft(rec.result.draftId);
    if (!draft)
      throw new ApiError(500, 'draft_missing', `这句话记成的草稿 ${rec.result.draftId} 在库里找不到`);
    return reply(c, FeishuMessageResponse, { kind: 'draft', draft: await view(draft) });
  }

  async function answerWith(
    c: Context<FeishuEnv>,
    message: FeishuMessageKey,
    result: Extract<FeishuMessageResult, { kind: 'answer' }>,
  ): Promise<Response> {
    const rec = await store.recordFeishuMessage({ message, result });
    return replyMessage(c, sameMessage(rec, message));
  }

  async function newDraft(
    c: Context<FeishuEnv>,
    founder: CockpitUser,
    chatType: z.output<typeof FeishuMessageRequest>['chatType'],
    text: string,
    message: FeishuMessageKey,
  ): Promise<Response> {
    const repo = guessRepo(text, await store.listRepos());
    const draftId = crypto.randomUUID();
    const r = await store.createDraft(
      {
        message,
        draft: {
          id: draftId,
          rawText: text,
          understanding: firstUnderstanding(text),
          unsure: true,
          repoId: repo?.id,
          chatType,
        },
      },
      auditOf(founder, 'draft.create', `draft:${draftId}`, { repoId: repo?.id, chatType }),
    );
    if (r.status === 'replayed') return replyMessage(c, sameMessage(r.message, message));
    return reply(c, FeishuMessageResponse, { kind: 'draft', draft: await view(r.draft) });
  }

  /** 这句话回复的是草稿卡：没确认的按它改理解；确认过的说清楚现在在哪；草稿读不到如实说没记成（不另起一张）。 */
  async function replyToDraftCard(
    c: Context<FeishuEnv>,
    founder: CockpitUser,
    draftId: string,
    text: string,
    message: FeishuMessageKey,
  ): Promise<Response> {
    const confirmed = async (d: DraftRecord) =>
      answerWith(c, message, {
        kind: 'answer',
        text: ANSWER_TEXTS.draftConfirmed(d.taskId ? await taskRef(d.taskId) : undefined),
        taskId: d.taskId,
      });
    const draft = await store.getDraft(draftId);
    if (draft?.status === 'confirmed') return confirmed(draft);
    if (draft) {
      if (text.trim().length > FEISHU_NOTE_MAX) {
        return answerWith(c, message, { kind: 'answer', text: ANSWER_TEXTS.noteTooLong });
      }
      const r = await store.reviseDraft(
        { draftId, note: text, key: { type: 'message', message } },
        auditOf(founder, 'draft.revise', `draft:${draftId}`, { note: text, via: 'reply' }),
      );
      switch (r.status) {
        case 'revised':
          return reply(c, FeishuMessageResponse, { kind: 'draft', draft: await view(r.draft) });
        case 'replayed_message':
          return replyMessage(c, sameMessage(r.message, message));
        case 'confirmed':
          return confirmed(r.draft);
        case 'replayed':
        case 'request_reused':
          throw new ApiError(500, 'unexpected', '按消息改草稿，却回了「请求编号用过」');
        case 'not_found':
          break;
      }
    }
    // 卡片登记记着这张草稿，库里却没有（草稿从不删除，登记也没有外键）：说实话，不当成新的一句话另起草稿。
    log.warn('回复的草稿卡对应的草稿读不到，这句没有记下', {
      cardMessageId: message.replyToMessageId,
      draftId,
    });
    return answerWith(c, message, { kind: 'answer', text: ANSWER_TEXTS.draftMissing });
  }

  /** 回复 AI 追问卡：这句话就是回答（和驾驶舱里回答同一条路，见 answer-ask.ts）。 */
  async function replyToAskCard(
    c: Context<FeishuEnv>,
    founder: CockpitUser,
    askId: string,
    fallbackTaskId: string | undefined,
    text: string,
    message: FeishuMessageKey,
  ): Promise<Response> {
    const ask = await store.getAsk(askId);
    const result = ask
      ? await answerAsk(deps, waiters, {
          askId,
          taskId: ask.taskId,
          answer: text,
          by: actorOf(founder),
          via: 'feishu',
        })
      : 'not_found';
    let said: string = ANSWER_TEXTS.askRecorded;
    if (result === 'already_answered') {
      const now = await store.getAsk(askId);
      // 自己上一次已经答上了（上次的回应丢了、网关重试）：照样说「记下了」。
      if (!(now?.answeredBy === founder.id && now.answer === text)) {
        const by = now?.answeredBy ? (await store.getUser(now.answeredBy))?.displayName : undefined;
        said = ANSWER_TEXTS.askTaken(now?.answer ?? '', by);
      }
    } else if (result === 'not_found') {
      // 卡片登记记着这条追问，库里却没有：说实话，不回「我还答不了」把人的回答吞掉。
      log.warn('回复的追问卡对应的追问读不到，这句没有记成回答', {
        cardMessageId: message.replyToMessageId,
        askId,
      });
      said = ANSWER_TEXTS.askMissing;
    }
    return answerWith(c, message, { kind: 'answer', text: said, taskId: ask?.taskId ?? fallbackTaskId });
  }

  /** 飞书进来的话：半个 emoji 换成 �（见 wellFormed），换了就记一笔。 */
  function cleaned(text: string, where: Record<string, unknown>): string {
    const w = wellFormed(text);
    if (w.replaced > 0) {
      log.warn('飞书进来的话里有残缺的字符（半个 emoji），已换成 �', { ...where, replaced: w.replaced });
    }
    return w.text;
  }

  on(FeishuRoutes.message, async (c) => {
    const founder = founderOf(c);
    const body = await readJson(c, FeishuMessageRequest);
    const text = cleaned(body.text, { sourceMessageId: body.sourceMessageId });
    if (!text.trim()) throw new ApiError(400, 'invalid_request', '这句话是空的');
    const message: FeishuMessageKey = {
      sourceMessageId: body.sourceMessageId,
      userId: founder.id,
      textHash: textHash(text),
      replyToMessageId: body.replyToMessageId,
    };
    const prior = await store.getFeishuMessage(body.sourceMessageId);
    if (prior) return replyMessage(c, sameMessage(prior, message));

    const card = body.replyToMessageId === undefined ? null : await store.getCard(body.replyToMessageId);
    if (card?.kind === 'draft' && card.ref.draftId !== undefined) {
      return replyToDraftCard(c, founder, card.ref.draftId, text, message);
    }
    if (card?.kind === 'ask' && card.ref.askId !== undefined) {
      return replyToAskCard(c, founder, card.ref.askId, card.ref.taskId, text, message);
    }
    if (card) {
      return answerWith(c, message, { kind: 'answer', text: cardReplyText(card), taskId: card.ref.taskId });
    }
    return newDraft(c, founder, body.chatType, text, message);
  });

  async function taskRef(taskId: string) {
    const task = await store.getTask(taskId);
    const repo = task ? await store.getRepo(task.repoId) : null;
    return task && repo ? { issueNumber: task.issueNumber, repo: fullName(repo) } : undefined;
  }

  // —— 改草稿、确认 ——

  /** 已确认的草稿现在在哪一步（待开单，还是已开成 #n），给「这张卡改不了」用。 */
  async function confirmedWords(d: DraftRecord): Promise<string> {
    const task = d.taskId === undefined ? undefined : await taskRef(d.taskId);
    return task
      ? `已经确认了（已开成 #${task.issueNumber}），这张卡改不了；要改需求请在驾驶舱里改`
      : '已经确认了（待开单），这张卡改不了；开好后驾驶舱里就有这个任务';
  }

  on(FeishuRoutes.reviseDraft, async (c) => {
    const founder = founderOf(c);
    const draftId = c.req.param('draftId') ?? '';
    const body = await readJson(c, FeishuReviseDraftRequest);
    if (body.repoId !== undefined && !(await store.getRepo(body.repoId))) {
      throw new ApiError(422, 'repo_not_found', '没有这个仓');
    }
    // 长度约定里已经卡在 FEISHU_NOTE_MAX（读请求时就 400），这里只规范化。
    const note =
      body.note === undefined
        ? undefined
        : cleaned(body.note, { draftId, requestId: body.requestId }).trim() || undefined;
    const r = await store.reviseDraft(
      { draftId, note, repoId: body.repoId, key: { type: 'request', requestId: body.requestId } },
      auditOf(founder, 'draft.revise', `draft:${draftId}`, { note, repoId: body.repoId }),
    );
    switch (r.status) {
      case 'not_found':
        throw new ApiError(404, 'draft_not_found', '没有这张草稿');
      case 'confirmed':
        throw new ApiError(
          409,
          'draft_confirmed',
          await confirmedWords(r.draft),
          await conflictDetails(r.draft),
        );
      case 'replayed_message':
        throw new ApiError(500, 'unexpected', '按请求编号改草稿，却回了「消息已处理」');
      case 'request_reused':
        throw new ApiError(
          409,
          'request_reused',
          '这个请求编号已经用在这张草稿另一次不同的改动上了（网关出错？），没有改',
        );
      default:
        return reply(c, FeishuReviseDraftResponse, { draft: await view(r.draft) });
    }
  });

  /**
   * 开单试一次，最多等几秒（draft-opening.ts 的 DRAFT_OPEN_CONFIRM_WAIT_MS，网关等确认 15 秒）；没等到、没成都回
   * 「已确认、待开单」，后台接着补。库出错也只记日志：确认本身已经记下了。
   */
  async function afterConfirm(draft: DraftRecord): Promise<DraftRecord> {
    if (draft.taskId !== undefined) return draft;
    try {
      await opening.openOne(draft.id);
      return (await store.getDraft(draft.id)) ?? draft;
    } catch (err) {
      log.error('确认后开单那一步出错，草稿留在待开单', { draftId: draft.id, error: String(err) });
      return draft;
    }
  }

  on(FeishuRoutes.confirmDraft, async (c) => {
    const founder = founderOf(c);
    const draftId = c.req.param('draftId') ?? '';
    const body = await readJson(c, FeishuConfirmDraftRequest);
    const draft = await store.getDraft(draftId);
    if (!draft) throw new ApiError(404, 'draft_not_found', '没有这张草稿');
    if (draft.status === 'confirmed') {
      return reply(c, FeishuConfirmDraftResponse, {
        draft: await view(await afterConfirm(draft)),
        alreadyConfirmed: true,
      });
    }
    const repoId = body.repoId ?? draft.repoId;
    if (repoId === undefined) {
      throw new ApiError(
        422,
        'repo_required',
        '还没定放在哪个仓：在卡上选一个仓再确认',
        await conflictDetails(draft),
      );
    }
    if (!(await store.getRepo(repoId))) throw new ApiError(422, 'repo_not_found', '没有这个仓');
    const r = await store.confirmDraft(
      { draftId, revision: body.revision, repoId, by: founder.id },
      auditOf(founder, 'draft.confirm', `draft:${draftId}`, { revision: body.revision, repoId }),
    );
    switch (r.status) {
      case 'not_found':
        throw new ApiError(404, 'draft_not_found', '没有这张草稿');
      case 'changed':
        throw new ApiError(
          409,
          'draft_changed',
          '草稿刚被改过：看一眼新的理解再确认',
          await conflictDetails(r.draft),
        );
      case 'already':
      case 'confirmed':
        return reply(c, FeishuConfirmDraftResponse, {
          draft: await view(await afterConfirm(r.draft)),
          alreadyConfirmed: r.status === 'already',
        });
    }
  });

  // —— 查任务、关注 ——

  on(FeishuRoutes.findTasks, async (c) => {
    founderOf(c);
    const { issue } = readQuery(c, FeishuTaskLookupQuery);
    const [found, repos] = await Promise.all([store.findTasksByIssue(issue), store.listRepos()]);
    const repoName = new Map(repos.map((r) => [r.id, fullName(r)]));
    return reply(c, FeishuTaskLookupResponse, {
      matches: found.slice(0, 20).map((t) => {
        const repo = repoName.get(t.repoId);
        if (!repo) throw new ApiError(500, 'repo_missing', `任务 ${t.id} 所在的仓不在库里`);
        return { taskId: t.id, repo, issueNumber: t.issueNumber, title: t.title, state: t.state };
      }),
    });
  });

  on(FeishuRoutes.follow, async (c) => {
    const founder = founderOf(c);
    const { taskId, follow } = await readJson(c, FeishuFollowRequest);
    const r = await store.setFollow(
      { taskId, userId: founder.id, follow },
      auditOf(founder, follow ? 'task.follow' : 'task.unfollow', `task:${taskId}`, { following: follow }),
    );
    if (r === 'task_not_found') throw new ApiError(404, 'task_not_found', '没有这个任务');
    return reply(c, FeishuFollowResponse, { taskId, following: follow });
  });

  // —— 盘面快照 ——

  on(FeishuRoutes.board, async (c) => {
    const now = deps.now();
    const repos = await store.listRepos();
    const openTasks = (await Promise.all(repos.map((r) => store.listBoardTasks(r.id))))
      .flat()
      .filter((t) => !TERMINAL.has(t.state));
    const taskIds = openTasks.map((t) => t.id);
    const [
      subtasks,
      activeRuns,
      routes,
      models,
      sources,
      mergedToday,
      windows,
      pools,
      channels,
      teamBoardCard,
    ] = await Promise.all([
      store.listSubtasks(taskIds),
      store.listRuns({ taskIds, active: true }),
      store.listRoutes(),
      store.listModels(),
      store.listOutboxSources(new Date(now.getTime() - OUTBOX_LOOKBACK_MS).toISOString()),
      store.countMergedSubtasksSince(beijingDayStart(now).toISOString()),
      store.listQuotaWindows(),
      store.listPools(),
      store.listChannels(),
      store.latestBoardCard(),
    ]);
    const [plans, stateSince] = await Promise.all([
      store.getPlans(activeRuns.map((r) => r.id)),
      store.stateSince([...taskIds, ...subtasks.filter((s) => s.state === 'stalled').map((s) => s.id)]),
    ]);
    const snapshot = buildFeishuBoard(
      {
        repos,
        openTasks,
        subtasks,
        activeRuns,
        plans,
        route: routeLookup(routes, models),
        sources,
        stateSince,
        mergedToday,
        windows,
        pools,
        channels,
        teamBoardCard,
      },
      now,
      deps.config.quotaStaleAfterMs,
    );
    return reply(c, FeishuBoardSnapshotSchema, snapshot);
  });

  // —— 待推送与回执 ——

  async function pendingBatch() {
    const now = deps.now();
    const sources = await store.listOutboxSources(new Date(now.getTime() - OUTBOX_LOOKBACK_MS).toISOString());
    const computed = composeOutbox(sources);
    const states = await store.syncOutbox(
      computed.map(({ content, fingerprint }) => ({
        id: content.id,
        fingerprint,
        create: content.status === 'open',
      })),
    );
    return pendingOutbox(computed, states, now, OUTBOX_BATCH);
  }

  /** 免打扰时段（驾驶舱设置 notify.quietHours）。设过却读不懂就报错：当成「不设」会半夜推卡。 */
  async function quietHours() {
    const saved = (await store.listSettings()).find((s) => s.key === 'notify.quietHours');
    if (!saved) return null;
    const parsed = SETTING_SCHEMAS['notify.quietHours'].safeParse(saved.value);
    if (!parsed.success) {
      throw new ApiError(
        500,
        'setting_invalid',
        '免打扰时段的设置读不懂（库里的值不合约定），先在驾驶舱里重设',
      );
    }
    return parsed.data;
  }

  on(FeishuRoutes.outbox, async (c) => {
    const { waitSeconds } = readQuery(c, FeishuOutboxQuery);
    const quiet = await quietHours();
    const deadline = Date.now() + waitSeconds * 1000;
    const signal = c.req.raw.signal;
    let batch = await pendingBatch();
    while (batch.items.length === 0 && !signal.aborted) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const untilHold =
        batch.nextHoldAt === undefined ? Number.POSITIVE_INFINITY : batch.nextHoldAt - deps.now().getTime();
      await outboxWake.sleep(Math.max(0, Math.min(left, OUTBOX_POLL_MS, untilHold)), signal);
      batch = await pendingBatch();
    }
    return reply(c, FeishuOutboxResponse, {
      items: batch.items,
      quietHours: quiet,
      asOf: deps.now().toISOString(),
    });
  });

  on(FeishuRoutes.ackOutbox, async (c) => {
    const { acks } = await readJson(c, FeishuOutboxAckRequest);
    const report = await store.ackOutbox(acks, deps.now().toISOString());
    if (report.skipped.length > 0) {
      // 按约定按条处理：认不出的跳过，不让整批 4xx（整批被拒网关只能丢掉这批）；这里记下来。
      log.warn('推送回执里有认不出的，跳过了这几条', {
        skipped: report.skipped.length,
        applied: report.applied,
        examples: report.skipped.slice(0, 5),
      });
    }
    return reply(c, FeishuOkResponse, { ok: true });
  });

  // —— 卡片登记 ——

  on(FeishuRoutes.putCard, async (c) => {
    const messageId = MessageIdParam.safeParse(c.req.param('messageId'));
    if (!messageId.success) {
      throw new ApiError(400, 'invalid_request', '消息编号不符合约定', messageId.error.issues);
    }
    const body = await readJson(c, FeishuPutCardRequest);
    await store.putCard({ messageId: messageId.data, ...body });
    return reply(c, FeishuOkResponse, { ok: true });
  });

  return app;
}

/** 长轮询待推送时的叫醒：追问、通知、需求有变化（或推送断过要全量重看）就醒，醒了自己回库算。 */
function createOutboxWake(changes: ChangeFeed) {
  const sleepers = new Set<() => void>();
  changes.subscribe((event) => {
    if (
      event.type === 'resync' ||
      event.table === 'asks' ||
      event.table === 'notifications' ||
      event.table === 'tasks'
    ) {
      for (const wake of [...sleepers]) wake();
    }
  });
  return {
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
