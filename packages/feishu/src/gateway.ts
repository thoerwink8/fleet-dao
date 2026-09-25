// 网关的四件事：随手记任务、推送（outbox.ts）、看盘面（board.ts）、回复即追问。
// 收事件的回调一律立刻返回（SDK 按会话排队，回调慢了会挡住后面的人），活放到后台跑；
// 每条消息先加表情回应（2 秒内），不等后端；确认卡 10 秒内必到——后端慢就先回「正在理解」卡，之后原地更新。
// 回复某张卡：网关不自己判它是改草稿、回答还是追问，把回复的消息编号交给后端一次问完（后端按卡片登记处理，
// 规矩见 shared/feishu-api.ts 的 FeishuMessageRequest）；尤其不在回复里替人拍板——拍板只认卡上的按钮。

import { FEISHU_NOTE_MAX, FeishuDraftConflictDetails } from '@fleet-dao/shared';
import {
  type Acting,
  type Backend,
  BackendError,
  type CardKind,
  type CardRecord,
  type Draft,
  describe,
  isTransient,
  UNDERSTAND_WAIT_MS,
  type Understood,
} from './backend.ts';
import { type Board, createBoard } from './board.ts';
import {
  type ActionValue,
  ActionValueSchema,
  answerCard,
  draftCard,
  draftWaitCard,
  FORM,
  pickTaskCard,
  progressCard,
  type RenderContext,
} from './cards.ts';
import type { Founder } from './config.ts';
import type { Logger } from './log.ts';
import { createOutbox, type Outbox } from './outbox.ts';
import {
  type Card,
  type FeishuPort,
  feishuErrorKind,
  type InboundCardAction,
  type InboundMenu,
  type InboundMessage,
  type OutMessage,
  type Sent,
  type Target,
} from './port.ts';
import { createRegistry, type Registry } from './registry.ts';
import { Inflight, Lru, nextNonce, sleep, uuidFor } from './util.ts';
import { beijingDay, clip, when } from './words.ts';

/** 开发者后台「机器人自定义菜单」里配的 event_key（菜单只在私聊里出现）。 */
export const MENU_KEYS = { board: 'board', todo: 'todo', newTask: 'new_task', progress: 'progress' } as const;

/** 设计目标：先回应 ≤2 秒、确认卡 ≤10 秒。超了记日志并计数（端到端巡检按这两个数判黄）。 */
export const TARGET_ACK_MS = 2_000;
export const TARGET_CARD_MS = 10_000;

export interface Timing {
  /** 理解一句话最多等多久；过了先回「正在理解」卡。 */
  understandWaitMs: number;
  /** 回了「正在理解」卡之后，隔多久再问一次后端（同一条消息，后端按消息编号返回同一个结果）。 */
  understandRetryMs: number;
  /** 最多再问多久，之后把卡改成「没记成」。 */
  understandGiveUpMs: number;
  /** 开任务（确认）最多等多久。 */
  confirmWaitMs: number;
  /** 查进度、回答、叫停、关注这些调用。 */
  callMs: number;
  /** 长轮询待推送一次最多等几秒。 */
  outboxWaitSeconds: number;
}

export const DEFAULT_TIMING: Timing = {
  understandWaitMs: UNDERSTAND_WAIT_MS,
  understandRetryMs: 5_000,
  understandGiveUpMs: 120_000,
  confirmWaitMs: 15_000,
  callMs: 5_000,
  outboxWaitSeconds: 25,
};

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
}

export interface Gateway {
  onMessage(msg: InboundMessage): void;
  onCardAction(evt: InboundCardAction): void;
  onMenu(evt: InboundMenu): void;
  /** SDK 的策略层拦下的消息（群里没 @我、不在允许的群）：只计数，不回话。 */
  onReject(evt: { messageId: string; chatId: string; senderId: string; reason: string }): void;
  /** 开始定时取盘面、长轮询待推送。 */
  start(): void;
  /** 停止定时活，最多等 drainMs 让在途的活做完。 */
  stop(drainMs?: number): Promise<void>;
  /** 测试用：等手上的活都做完。 */
  idle(): Promise<void>;
  readonly stats: Readonly<Record<string, number>>;
  readonly board: Board;
  readonly outbox: Outbox;
  readonly registry: Registry;
}

const HINT_EMPTY = '在呢。直接说要做的事，比如「给登录页加手机验证码」；发「进度 12」查进度。';
const HINT_NEW_TASK =
  '直接发一句话给我就行，比如「给登录页加手机验证码」。我会先回一张「我理解为」的卡，你点确认才开成任务。群里记任务要 @我。';
const DECLINE = '你好，我是 fleet-dao 的机器人，只替两位创始人办事。这条我没有记下，有事请直接找他们。';

/** 「进度 12」「查进度12」「进度 #12」。 */
export function parseProgress(text: string): number | null {
  const m = /^(?:查)?进度[\s:：]*[#＃]?(\d{1,7})$/.exec(text.trim());
  return m ? Number(m[1]) : null;
}

export function createGateway(o: GatewayOptions): Gateway {
  const now = o.now ?? Date.now;
  const timing: Timing = { ...DEFAULT_TIMING, ...o.timing };
  const log = o.log;
  const founders = new Map(o.founders.map((f) => [f.openId, f]));
  const allowedGroups = new Set([o.teamChatId, ...(o.testChatId ? [o.testChatId] : [])]);
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
  const board = createBoard({
    backend: o.backend,
    feishu: o.feishu,
    registry,
    log,
    now,
    teamChatId: o.teamChatId,
    publicUrl: o.publicUrl,
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
  });
  /** 最近见过的草稿（按钮一点就能先把卡改成「正在…」，不用等后端）。 */
  const drafts = new Lru<string, Draft>(500);
  const seenMenuEvents = new Lru<string, true>(500);
  /** 陌生人每人每天只回一次，免得和别的机器人来回刷。 */
  const declined = new Lru<string, string>(1000);

  const ctx = (): RenderContext => ({ publicUrl: o.publicUrl, now: now(), nonce: nextNonce(now()) });
  const as = (f: Founder): Acting => ({ openId: f.openId });
  const iso = (ms: number) => new Date(ms).toISOString();

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

  /** 改卡；改不了（超 14 天）就在那张卡下面回一句 fallback。 */
  async function patch(messageId: string, card: Card, why: string, fallback?: string): Promise<boolean> {
    try {
      await o.feishu.updateCard(messageId, card);
      return true;
    } catch (err) {
      count('feishu_failed');
      log.warn('卡片没改成', { messageId, why, error: String(err) });
      if (fallback && feishuErrorKind(err) === 'too_old') {
        await reply(
          messageId,
          { text: `${fallback}（这张卡发出超过 14 天，飞书不让改了）` },
          `too-old:${why}`,
        );
      }
      return false;
    }
  }

  function remember(sent: Sent | null, kind: CardKind, ref: CardRecord['ref']): void {
    if (sent)
      registry.remember({ messageId: sent.messageId, chatId: sent.chatId, kind, ref, sentAt: iso(now()) });
  }

  /** 已登记过的卡换种类或补来历（例如草稿确认后补 taskId）：后端保留第一次登记的发出时刻。 */
  function reRemember(messageId: string, chatId: string, kind: CardKind, ref: CardRecord['ref']): void {
    registry.remember({ messageId, chatId, kind, ref, sentAt: iso(now()) });
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

  async function ack(msg: InboundMessage, receivedAt: number): Promise<void> {
    try {
      await o.feishu.react(msg.messageId, o.ackEmoji);
      const ms = now() - receivedAt;
      if (ms > TARGET_ACK_MS) {
        count('ack_slow');
        log.warn('「收到」超过 2 秒', { messageId: msg.messageId, ms });
      }
    } catch (err) {
      count('ack_failed');
      log.error('表情回应没加上，改回一句「收到」', { messageId: msg.messageId, error: String(err) });
      await reply(msg.messageId, { text: '收到。' }, 'ack');
    }
  }

  async function handleMessage(msg: InboundMessage, founder: Founder, receivedAt: number): Promise<void> {
    const acked = ack(msg, receivedAt);
    const text = msg.text.trim();
    let path = 'understand';
    try {
      if (!text) {
        path = 'empty';
        await reply(msg.messageId, { text: HINT_EMPTY }, 'hint');
        return;
      }
      const issue = parseProgress(text);
      if (issue !== null) {
        path = 'progress';
        await showProgress(msg, founder, issue);
        return;
      }
      if (msg.replyToMessageId) path = 'reply';
      await understand(msg, founder, text, receivedAt);
    } finally {
      await acked;
      log.info('消息处理完', {
        messageId: msg.messageId,
        chatType: msg.chatType,
        path,
        textLength: text.length,
        totalMs: now() - receivedAt,
      });
    }
  }

  async function understand(
    msg: InboundMessage,
    founder: Founder,
    text: string,
    receivedAt: number,
  ): Promise<void> {
    const body = {
      sourceMessageId: msg.messageId,
      text: clip(text, 4000),
      chatType: msg.chatType,
      ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}),
    };
    let first: Understood;
    try {
      // 不挂停机信号：停机时手上的调用照样等它回来（各自有超时），做完再退。
      first = await o.backend.understand(as(founder), body, { timeoutMs: timing.understandWaitMs });
    } catch (err) {
      if (!isTransient(err)) {
        count('backend_refused');
        log.warn('后端没收下这句话', { messageId: msg.messageId, error: String(err) });
        await reply(msg.messageId, { text: refusedText(err, '这句话') }, 'refused');
        return;
      }
      // 后端慢或连不上：先回一张「正在理解」卡守住 10 秒，之后原地更新。
      count('understand_slow');
      const placeholder = await reply(
        msg.messageId,
        { card: draftWaitCard(ctx(), { title: '收到，正在理解…', rawText: text }) },
        'placeholder',
      );
      remember(placeholder, 'draft', {});
      checkCardTime(msg.messageId, receivedAt, 'placeholder');
      log.warn('理解得慢，先回了「正在理解」卡', { messageId: msg.messageId, error: String(err) });
      const later = await retryUnderstand(founder, body);
      if (typeof later === 'object') {
        await deliver(msg, later, receivedAt, placeholder);
      } else if (placeholder) {
        count('understand_gave_up');
        await patch(
          placeholder.messageId,
          draftWaitCard(ctx(), {
            title: '这句话没记成',
            failed: true,
            rawText: text,
            lines: [
              later === 'stopping'
                ? '网关正在重启，这句话没来得及记下。稍后重发这句话，或者在驾驶舱里新建。'
                : '后端一直没回应（已记日志）。稍后重发这句话，或者在驾驶舱里新建。',
            ],
          }),
          'understand-gave-up',
        );
      }
      return;
    }
    await deliver(msg, first, receivedAt, null);
  }

  /** 「正在理解」卡发出去之后接着问；'stopping' = 网关在停机，'gave_up' = 问到时限还没结果。 */
  async function retryUnderstand(
    founder: Founder,
    body: Parameters<Backend['understand']>[1],
  ): Promise<Understood | 'stopping' | 'gave_up'> {
    const deadline = now() + timing.understandGiveUpMs;
    while (now() < deadline) {
      await sleep(timing.understandRetryMs, life.signal);
      if (life.signal.aborted) return 'stopping';
      try {
        return await o.backend.understand(as(founder), body, { timeoutMs: timing.understandWaitMs });
      } catch (err) {
        if (!isTransient(err)) {
          log.warn('重试理解时后端拒收', { error: String(err) });
          return 'gave_up';
        }
      }
    }
    return 'gave_up';
  }

  function checkCardTime(messageId: string, receivedAt: number, what: string): void {
    const ms = now() - receivedAt;
    if (ms > TARGET_CARD_MS) {
      count('card_slow');
      log.warn('确认卡超过 10 秒', { messageId, what, ms });
    }
  }

  async function deliver(msg: InboundMessage, res: Understood, receivedAt: number, placeholder: Sent | null) {
    if (res.kind === 'answer') {
      const ref = res.taskId ? { taskId: res.taskId } : {};
      if (placeholder) {
        await patch(placeholder.messageId, answerCard(res.text, ctx(), res.taskId), 'answer');
        reRemember(placeholder.messageId, placeholder.chatId, 'answer', ref);
      } else {
        remember(await reply(msg.messageId, { text: res.text }, 'answer'), 'answer', ref);
      }
      return;
    }
    const draft = res.draft;
    drafts.set(draft.id, draft);
    const ref = { draftId: draft.id, ...(draft.task ? { taskId: draft.task.taskId } : {}) };
    if (draft.cardMessageId) {
      // 这个草稿已经有卡了（回复那张卡改理解，或者同一条消息被重投）：原地更新那张，不发第二张。
      const note = msg.replyToMessageId ? '已按你说的改好，看一眼再确认。' : undefined;
      await patch(draft.cardMessageId, draftCard(draft, ctx(), { note }), 'draft', note);
      if (placeholder) {
        await patch(
          placeholder.messageId,
          answerCard('已按你说的改好了那张「我理解为」卡。', ctx()),
          'draft-moved',
        );
        reRemember(placeholder.messageId, placeholder.chatId, 'answer', ref);
      }
    } else if (placeholder) {
      await patch(placeholder.messageId, draftCard(draft, ctx()), 'draft');
      reRemember(placeholder.messageId, placeholder.chatId, 'draft', ref);
    } else {
      remember(
        await reply(msg.messageId, { card: draftCard(draft, ctx()) }, `draft:${draft.id}`),
        'draft',
        ref,
      );
      checkCardTime(msg.messageId, receivedAt, 'draft');
    }
    log.info('确认卡已回', { messageId: msg.messageId, draftId: draft.id, cardMs: now() - receivedAt });
  }

  function refusedText(err: unknown, what: string): string {
    if (err instanceof BackendError && err.status === 403) {
      return '后端没认你这个飞书账号（不在创始人白名单里），请在驾驶舱里核对成员。';
    }
    return `${what}后端没收下：${describe(err)}。`;
  }

  // —— 草稿：卡上的「改一下」「确认」——

  async function reviseDraft(
    founder: Founder,
    draftId: string,
    cardMessageId: string,
    change: { note?: string; repoId?: string },
    requestId: string,
  ): Promise<void> {
    const cached = drafts.get(draftId);
    if (change.note !== undefined && change.note.length > FEISHU_NOTE_MAX) {
      // 输入框本来就限了这么长；万一绕过来（旧卡、客户端没拦住），照实说，不发给后端（约定里就收不下）。
      const note = `补充最长 ${FEISHU_NOTE_MAX} 字，这次 ${change.note.length} 字，没有改：删短一点再点「改一下」，或者分几句回复这张卡片说。`;
      await patch(
        cardMessageId,
        cached
          ? draftCard(cached, ctx(), { note })
          : draftWaitCard(ctx(), { title: '没改成', failed: true, lines: [note] }),
        'revise-too-long',
      );
      return;
    }
    await patch(
      cardMessageId,
      cached
        ? draftCard(cached, ctx(), { state: 'revising' })
        : draftWaitCard(ctx(), { title: '正在按你的补充重新理解…' }),
      'revising',
    );
    try {
      const draft = await o.backend.reviseDraft(
        as(founder),
        draftId,
        { requestId, ...change },
        { timeoutMs: timing.understandWaitMs },
      );
      drafts.set(draft.id, draft);
      await patch(
        cardMessageId,
        draftCard(draft, ctx(), { note: '已按你说的改好，看一眼再确认。' }),
        'revised',
      );
    } catch (err) {
      const latest = draftIn(err);
      if (latest) drafts.set(latest.id, latest);
      // 已确认的：后端写明了现在在哪一步（待开单 / 已开成 #n），照它说，不自己猜「已经开成任务了」。
      // 别的：只有多半是暂时的（连不上、超时、后端出错）才叫人再试，被拒收的再试一次还是一样。
      const note =
        err instanceof BackendError && err.code === 'draft_confirmed'
          ? `${err.said ?? '已经确认了，这张卡改不了'}。`
          : `没改成：${describe(err)}${isTransient(err) ? '，再试一次' : ''}。`;
      const base = latest ?? cached;
      await patch(
        cardMessageId,
        base
          ? draftCard(base, ctx(), { note })
          : draftWaitCard(ctx(), { title: '没改成', failed: true, lines: [note] }),
        'revise-failed',
      );
    }
  }

  async function confirmDraft(
    v: Extract<ActionValue, { a: 'draft.confirm' }>,
    evt: InboundCardAction,
    founder: Founder,
  ): Promise<void> {
    const note = formText(evt.formValue, FORM.note);
    const repoId = formText(evt.formValue, FORM.repo);
    const cached = drafts.get(v.d);
    const repoChanged = repoId !== undefined && repoId !== cached?.repo?.id;
    if (note) {
      // 写了补充却点了「确认」：先按补充改，改完请他再看一眼。
      await reviseDraft(
        founder,
        v.d,
        evt.messageId,
        { note, ...(repoChanged && repoId ? { repoId } : {}) },
        uuidFor('revise', evt.messageId, v._n, founder.openId, note, repoId ?? ''),
      );
      return;
    }
    await patch(
      evt.messageId,
      cached
        ? draftCard(cached, ctx(), { state: 'confirming' })
        : draftWaitCard(ctx(), { title: '正在开成任务…' }),
      'confirming',
    );
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await o.backend.confirmDraft(
          as(founder),
          v.d,
          { revision: v.r, ...(repoId ? { repoId } : {}) },
          { timeoutMs: timing.confirmWaitMs },
        );
        drafts.set(r.draft.id, r.draft);
        const task = r.draft.task;
        const done = r.alreadyConfirmed
          ? `已确认（${r.draft.confirmedBy ?? '另一位创始人'}），没有重复开任务。`
          : undefined;
        await patch(
          evt.messageId,
          draftCard(r.draft, ctx(), { note: done }),
          'confirmed',
          task ? `已开成任务 #${task.issueNumber}` : '已确认',
        );
        if (task) reRemember(evt.messageId, evt.chatId, 'draft', { draftId: v.d, taskId: task.taskId });
        log.info('草稿已确认', { draftId: v.d, taskId: task?.taskId, again: r.alreadyConfirmed });
        return;
      } catch (err) {
        lastErr = err;
        if (!isTransient(err) || attempt === 1) break;
        await sleep(1_000);
      }
    }
    const latest = draftIn(lastErr);
    if (latest) drafts.set(latest.id, latest);
    if (lastErr instanceof BackendError && lastErr.code === 'draft_changed' && latest) {
      await patch(
        evt.messageId,
        draftCard(latest, ctx(), { note: '刚被改过，看一眼新的理解再确认。' }),
        'changed',
      );
      return;
    }
    const why = `没开成：${describe(lastErr)}，再点一次「确认」试试。`;
    log.warn('草稿没确认成', { draftId: v.d, error: String(lastErr) });
    const base = latest ?? cached;
    await patch(
      evt.messageId,
      base
        ? draftCard(base, ctx(), { note: why })
        : draftWaitCard(ctx(), { title: '没开成', failed: true, lines: [why] }),
      'confirm-failed',
    );
  }

  // —— 卡上的按钮：回答追问（要人拍的事也在这里拍板）、叫停、关注 ——

  async function answerAsk(
    founder: Founder,
    askId: string,
    answer: string,
    cardMessageId: string,
  ): Promise<void> {
    try {
      await o.backend.answerAsk(as(founder), askId, answer);
      const doneText = `已回答：${clip(answer, 60)} · ${founder.name} · ${when(now(), now())}`;
      if (!(await outbox.overlay(cardMessageId, { doneText }).catch(() => false))) {
        // 卡不在本地缓存（例如网关刚重启）：在卡下面说一声，卡等后端下一版推过来再改。
        log.info('问题卡不在本地缓存，等后端下一版推过来再改卡', { askId });
        await reply(cardMessageId, { text: doneText }, `answered:${askId}`);
      }
    } catch (err) {
      const note =
        err instanceof BackendError && err.status === 409
          ? '这个问题已经有人回答过了。'
          : err instanceof BackendError && err.status === 404
            ? '这条追问已经不在了。'
            : `没提交上：${describe(err)}，再点一次试试。`;
      log.warn('回答没提交上', { askId, error: String(err) });
      const shown = await outbox.overlay(cardMessageId, { note }).catch(() => false);
      if (!shown) await reply(cardMessageId, { text: note }, `answer-failed:${askId}:${now()}`);
    }
  }

  async function refreshProgress(
    founder: Founder,
    taskId: string,
    messageId: string,
    note: string,
  ): Promise<void> {
    try {
      const detail = await o.backend.task(as(founder), taskId, { timeoutMs: timing.callMs });
      await patch(messageId, progressCard(detail, ctx(), { note }), 'progress-note');
    } catch (err) {
      log.warn('进度卡没刷新成', { taskId, error: String(err) });
      await reply(messageId, { text: note }, `progress-note:${now()}`);
    }
  }

  async function stopTask(founder: Founder, taskId: string, messageId: string): Promise<void> {
    let note: string;
    let done = false;
    try {
      await o.backend.stopTask(as(founder), taskId, `飞书上叫停（${founder.name}）`);
      note = `已叫停 · ${founder.name} · ${when(now(), now())}`;
      done = true;
    } catch (err) {
      note =
        err instanceof BackendError && err.code === 'task_finished'
          ? '任务已经结束了，不用叫停。'
          : `没叫停成：${describe(err)}，再点一次试试。`;
      log.warn('叫停没成', { taskId, error: String(err) });
    }
    const onPush = await outbox.overlay(messageId, done ? { doneText: note } : { note }).catch(() => false);
    if (!onPush) await refreshProgress(founder, taskId, messageId, note);
  }

  async function follow(
    founder: Founder,
    v: Extract<ActionValue, { a: 'task.follow' }>,
    messageId: string,
  ): Promise<void> {
    let note: string;
    try {
      const following = await o.backend.follow(as(founder), v.t, v.f);
      note = following
        ? `${founder.name} 已关注：方案好了、PR 开了、合并了、卡住了会私聊告诉你。`
        : `${founder.name} 已取消关注，之后不再私聊推这个需求。`;
    } catch (err) {
      note = `关注没设上：${describe(err)}，再点一次试试。`;
      log.warn('关注没设上', { taskId: v.t, error: String(err) });
    }
    if (v.c === 'progress') return refreshProgress(founder, v.t, messageId, note);
    if (
      v.c === 'follow' &&
      (await outbox.overlay(messageId, v.f ? { note } : { doneText: note }).catch(() => false))
    ) {
      return;
    }
    const draft = v.d ? drafts.get(v.d) : undefined;
    if (draft && (await patch(messageId, draftCard(draft, ctx(), { note }), 'follow'))) return;
    await reply(messageId, { text: note }, `follow:${now()}`);
  }

  // —— 查进度 ——

  async function showProgress(msg: InboundMessage, founder: Founder, issue: number): Promise<void> {
    let matches: Awaited<ReturnType<Backend['findTasks']>>['matches'];
    try {
      matches = (await o.backend.findTasks(as(founder), issue, { timeoutMs: timing.callMs })).matches;
    } catch (err) {
      log.warn('进度没查成', { issue, error: String(err) });
      await reply(
        msg.messageId,
        { text: `#${issue} 的进度没查成：${describe(err)}，稍后再试。` },
        'progress-miss',
      );
      return;
    }
    if (matches.length === 0) {
      await reply(
        msg.messageId,
        { text: `没找到 #${issue}。全部任务在驾驶舱里：${o.publicUrl}/overview` },
        'progress-none',
      );
      return;
    }
    if (matches.length > 1) {
      remember(await reply(msg.messageId, { card: pickTaskCard(issue, matches, ctx()) }, 'pick'), 'list', {});
      return;
    }
    const only = matches[0];
    if (!only) return;
    try {
      const detail = await o.backend.task(as(founder), only.taskId, { timeoutMs: timing.callMs });
      const sent = await reply(
        msg.messageId,
        { card: progressCard(detail, ctx()) },
        `progress:${only.taskId}`,
      );
      remember(sent, 'progress', { taskId: only.taskId });
    } catch (err) {
      log.warn('进度详情没查成', { taskId: only.taskId, error: String(err) });
      await reply(
        msg.messageId,
        { text: `#${issue} 的进度没查成：${describe(err)}，稍后再试。` },
        'progress-miss',
      );
    }
  }

  async function showProgressById(founder: Founder, taskId: string, messageId: string, chatId: string) {
    try {
      const detail = await o.backend.task(as(founder), taskId, { timeoutMs: timing.callMs });
      if (await patch(messageId, progressCard(detail, ctx()), 'progress-pick')) {
        reRemember(messageId, chatId, 'progress', { taskId });
      }
    } catch (err) {
      log.warn('进度详情没查成', { taskId, error: String(err) });
      await reply(messageId, { text: `进度没查成：${describe(err)}，稍后再点。` }, `progress-miss:${now()}`);
    }
  }

  // —— 按钮 ——

  async function handleAction(v: ActionValue, evt: InboundCardAction, founder: Founder): Promise<void> {
    const at = {
      messageId: evt.messageId,
      chatId: evt.chatId,
      operatorId: founder.openId,
      operatorName: founder.name,
    };
    switch (v.a) {
      case 'draft.confirm':
        return confirmDraft(v, evt, founder);
      case 'draft.revise': {
        const note = formText(evt.formValue, FORM.note);
        const repoId = formText(evt.formValue, FORM.repo);
        const cached = drafts.get(v.d);
        const repoChanged = repoId !== undefined && repoId !== cached?.repo?.id;
        if (!note && !repoChanged) {
          const hint = '在输入框里写上要改哪里再点「改一下」，或者直接回复这张卡片说。';
          if (cached) await patch(evt.messageId, draftCard(cached, ctx(), { note: hint }), 'revise-empty');
          else await reply(evt.messageId, { text: hint }, `revise-empty:${v._n}`);
          return;
        }
        await reviseDraft(
          founder,
          v.d,
          evt.messageId,
          { ...(note ? { note } : {}), ...(repoChanged && repoId ? { repoId } : {}) },
          uuidFor('revise', evt.messageId, v._n, founder.openId, note ?? '', repoId ?? ''),
        );
        return;
      }
      case 'ask.answer':
        return answerAsk(founder, v.k, v.o, evt.messageId);
      case 'task.stop':
        return stopTask(founder, v.t, evt.messageId);
      case 'task.follow':
        return follow(founder, v, evt.messageId);
      case 'board.refresh':
        return board.onButton('refresh', at);
      case 'board.stalled':
        return board.onButton('stalled', at);
      case 'board.waiting':
        return board.onButton('waiting', at);
      case 'progress.show':
        return showProgressById(founder, v.t, evt.messageId, evt.chatId);
    }
  }

  // —— 菜单（只在私聊里出现；事件不带会话编号，回应一律发到点菜单的人的私聊）——

  async function handleMenu(key: string, founder: Founder): Promise<void> {
    const started = now();
    try {
      switch (key) {
        case MENU_KEYS.board:
          await board.sendTo(founder.openId, 'board');
          break;
        case MENU_KEYS.todo:
          await board.sendTo(founder.openId, 'todo');
          break;
        case MENU_KEYS.progress:
          await board.sendTo(founder.openId, 'active');
          break;
        case MENU_KEYS.newTask:
          await send({ openId: founder.openId }, { text: HINT_NEW_TASK }, `menu-new:${started}`);
          break;
        default:
          count('unknown_menu');
          log.warn('认不出的菜单 event_key', { key });
          await send(
            { openId: founder.openId },
            { text: `这个菜单还没接上（${clip(key, 40)}），已记日志。` },
            `menu-unknown:${started}`,
          );
      }
    } catch (err) {
      count('feishu_failed');
      log.error('菜单的回应没发出去', { key, error: String(err) });
    }
    log.info('菜单', { key, ms: now() - started });
  }

  let boardTimer: NodeJS.Timeout | undefined;
  let ticking: Promise<void> | null = null;
  let outboxRun: Promise<void> | null = null;

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
      if (msg.chatType === 'group' && !msg.mentionedBot) {
        count('ignored_no_mention');
        return;
      }
      const founder = founders.get(msg.senderId);
      if (!founder) {
        count('stranger');
        inflight.track(decline(msg.senderId, msg.messageId));
        return;
      }
      inflight.track(handleMessage(msg, founder, receivedAt));
    },

    onCardAction(evt) {
      const founder = founders.get(evt.operatorId);
      if (!founder) {
        count('stranger');
        inflight.track(decline(evt.operatorId));
        return;
      }
      const parsed = ActionValueSchema.safeParse(evt.value);
      if (!parsed.success) {
        count('unknown_action');
        log.warn('认不出的按钮回传值', {
          messageId: evt.messageId,
          value: clip(JSON.stringify(evt.value) ?? '', 200),
        });
        return;
      }
      inflight.track(handleAction(parsed.data, evt, founder));
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
      inflight.track(handleMenu(evt.key, founder));
    },

    onReject(evt) {
      count(`rejected_${evt.reason}`);
      log.info('SDK 策略拦下的消息', { reason: evt.reason, chatId: evt.chatId });
    },

    start() {
      tick();
      boardTimer = setInterval(tick, o.boardRefreshMs);
      outboxRun = outbox.run(life.signal).catch((err) => log.error('推送循环停了', { error: String(err) }));
    },

    async stop(drainMs = 20_000) {
      clearInterval(boardTimer);
      life.abort();
      await outboxRun;
      await ticking;
      const left = await inflight.drain(drainMs);
      if (left > 0) log.warn('停机时还有活没做完', { left });
    },

    idle: () => inflight.idle(),
    stats,
    board,
    outbox,
    registry,
  };
}

function formText(form: Record<string, unknown> | undefined, name: string): string | undefined {
  const v = form?.[name];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function draftIn(err: unknown): Draft | undefined {
  if (!(err instanceof BackendError)) return undefined;
  const parsed = FeishuDraftConflictDetails.safeParse(err.details);
  return parsed.success ? parsed.data.draft : undefined;
}
