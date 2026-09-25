// 飞书接口要的样子（shared/feishu-api.ts）：草稿卡、盘面快照、推送条目。纯函数，不碰数据库，测试直接喂数据。
import { createHash } from 'node:crypto';
import type {
  Channel,
  FeishuBoardSnapshotSchema,
  FeishuDraftSchema,
  FeishuOutboxItemSchema,
  Pool,
  Repo,
  SessionRun,
  Subtask,
  Task,
  TaskState,
} from '@fleet-dao/shared';
import type { z } from 'zod';
import { clip, UNDERSTANDING_MAX, UNDERSTANDING_NOTE_MAX } from './feishu-records.ts';
import type {
  DraftRecord,
  FeishuCardRecord,
  FeishuOutboxSources,
  FeishuOutboxState,
  FeishuTaskInfo,
  QuotaWindowRecord,
  RunPlan,
  User,
} from './ports.ts';
import { activityOf, type RouteInfo } from './views.ts';

type Draft = z.input<typeof FeishuDraftSchema>;
type Board = z.input<typeof FeishuBoardSnapshotSchema>;
type OutboxItem = z.input<typeof FeishuOutboxItemSchema>;
export type OutboxContent = Omit<OutboxItem, 'revision' | 'delivered'>;

const TERMINAL: ReadonlySet<TaskState> = new Set(['done', 'stopped', 'failed']);
const DAY_MS = 24 * 60 * 60_000;
const BEIJING_OFFSET_MS = 8 * 60 * 60_000;
const OPTIONS_MAX = 4;
const LINES_MAX = 10;

export const fullName = (repo: Pick<Repo, 'owner' | 'name'>) => `${repo.owner}/${repo.name}`;

// —— 时间（北京时间，不过夏令时）——

/** 北京时间今天 0 点（UTC 的时刻）。 */
export function beijingDayStart(now: Date): Date {
  const shifted = now.getTime() + BEIJING_OFFSET_MS;
  return new Date(shifted - (shifted % DAY_MS) - BEIJING_OFFSET_MS);
}

const stampFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 「09-25 14:02」（北京时间）。 */
export function beijingStamp(iso: string): string {
  const parts = Object.fromEntries(stampFmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// —— 随手记的草稿 ——

/** 按原话猜仓：只有一个仓就是它；原话里恰好提到一个仓的名字也算。猜不出就是空（确认时必须选）。 */
export function guessRepo(text: string, repos: readonly Repo[]): Repo | undefined {
  if (repos.length === 1) return repos[0];
  const lower = text.toLowerCase();
  const named = repos.filter((r) => lower.includes(r.name.toLowerCase()));
  return named.length === 1 ? named[0] : undefined;
}

/** 还没接模型理解：「我理解为」先用原话（超长截断），卡上标「拿不准」。 */
export function firstUnderstanding(text: string): string {
  return clip(text, UNDERSTANDING_MAX);
}

/** issue 标题：「我理解为」的第一行，截到 80 字。 */
export function issueTitle(understanding: string): string {
  return clip(understanding.split('\n')[0] ?? understanding, 80);
}

export interface DraftViewContext {
  repos: readonly Repo[];
  users: readonly User[];
  /** 草稿开成的任务（有 taskId 时必给）。 */
  task?: { task: Task; repo: Repo } | undefined;
}

/** 库里的草稿 → 约定里的草稿（仓名、人名、任务号查好）。查不到本该有的（外键保证在）就抛错，不编一个。 */
export function draftView(d: DraftRecord, ctx: DraftViewContext): Draft {
  const repoById = new Map(ctx.repos.map((r) => [r.id, r]));
  const nameOf = (id: string) => {
    const user = ctx.users.find((u) => u.id === id);
    if (!user) throw new Error(`草稿 ${d.id} 的提出人或确认人 ${id} 不在库里`);
    return user.displayName;
  };
  const repo = d.repoId === undefined ? undefined : repoById.get(d.repoId);
  if (d.repoId !== undefined && !repo) throw new Error(`草稿 ${d.id} 放的仓 ${d.repoId} 不在库里`);
  if (d.taskId !== undefined && ctx.task?.task.id !== d.taskId) {
    throw new Error(`草稿 ${d.id} 开成的任务 ${d.taskId} 没查到`);
  }
  return {
    id: d.id,
    revision: d.revision,
    status: d.status,
    rawText: d.rawText,
    understanding: d.understanding,
    unsure: d.unsure,
    repo: repo ? { id: repo.id, fullName: fullName(repo) } : null,
    repoOptions: [...ctx.repos]
      .sort((a, b) => fullName(a).localeCompare(fullName(b)))
      .slice(0, 20)
      .map((r) => ({ id: r.id, fullName: fullName(r) })),
    proposedBy: nameOf(d.proposedBy),
    cardMessageId: d.cardMessageId,
    task: ctx.task
      ? { taskId: ctx.task.task.id, repo: fullName(ctx.task.repo), issueNumber: ctx.task.task.issueNumber }
      : undefined,
    confirmedBy: d.confirmedBy === undefined ? undefined : nameOf(d.confirmedBy),
    updatedAt: d.updatedAt,
  };
}

// —— 回复一张卡时回的话（还没接模型理解，答不了的明说）——

export const ANSWER_TEXTS = {
  askRecorded: '已记下你的回答，AI 会接着干。',
  askTaken: (answer: string, by: string | undefined) =>
    `这个问题已经回答过了（${by ?? '另一位'}：${clip(answer, 60)}），这句没有记成新的回答。`,
  askMissing:
    '这张卡对应的追问在库里读不到，这句没有记成回答（已记日志）。打开驾驶舱看这个需求现在有没有要回答的追问。',
  draftConfirmed: (task: { issueNumber: number; repo: string } | undefined) =>
    task
      ? `这张卡已经开成任务 #${task.issueNumber}（${task.repo}），要补充或改需求请在驾驶舱里改。`
      : '这张卡已经确认了，待开单：开 issue 那一步还没做成，后台会自动补开，不会丢；开好后驾驶舱里就有这个任务。',
  draftMissing:
    '这张卡对应的草稿在库里读不到，这句没有记下（已记日志）。要记新任务请直接发这句话，不要回复这张卡。',
  noteTooLong: `补充太长（超过 ${UNDERSTANDING_NOTE_MAX} 字），这句没有改进草稿：请分几句回复这张卡。`,
  decision:
    '拍板请点卡上的按钮，回复不算拍板。我现在还答不了追问（理解问题的模型还没接上），详情打开驾驶舱看。',
  cannotAnswer: (hasTask: boolean) =>
    `我现在还答不了追问（理解问题的模型还没接上）。${hasTask ? '这件事的详情打开驾驶舱看；' : ''}发「进度 12」可以查某个需求的进度。`,
} as const;

/** 回复的是登记过的别的卡（进度、盘面、清单、回答、报警、日报、关注、要人拍）。 */
export function cardReplyText(card: FeishuCardRecord): string {
  if (card.kind === 'decision') return ANSWER_TEXTS.decision;
  return ANSWER_TEXTS.cannotAnswer(card.ref.taskId !== undefined);
}

// —— 待推送：从源头现算内容，指纹决定版本 ——

export interface ComputedOutboxItem {
  content: OutboxContent;
  fingerprint: string;
}

function lines(text: string, max = LINES_MAX): string[] {
  const all = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => clip(l, 500));
  return all.length <= max ? all : [...all.slice(0, max - 1), '……其余见驾驶舱'];
}

const TASK_END_WORDS: Partial<Record<TaskState, string>> = { done: '做完', stopped: '叫停', failed: '结束' };
const LEVEL_WORDS = { decision: '有事要你们拍', alert: '有任务卡住了', daily: '日报' } as const;

function taskFields(task: FeishuTaskInfo | undefined) {
  return task ? { taskId: task.id, repo: task.repo, issueNumber: task.issueNumber } : {};
}

function fingerprintOf(content: OutboxContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * 源头 → 推送条目：追问一件一条（ask:<编号>），通知一件一条（notification:<编号>），都发团队群。
 * 答了、处理了、需求结束了就是 done（卡片变灰、收起按钮）。字段按约定的上限截好：一条超长整批就回不出去。
 */
export function composeOutbox(sources: FeishuOutboxSources): ComputedOutboxItem[] {
  const out: OutboxContent[] = [];
  for (const { ask, task, answeredByName } of sources.asks) {
    const ended = TASK_END_WORDS[task.state];
    const done = ask.answer !== undefined || ended !== undefined;
    const question = ask.question.trim() || '（AI 没写问题原文）';
    const [first = question, ...rest] = question.split('\n');
    const title = clip(first, 100);
    // 第一行放得进标题，正文只放后面几行；放不下（截断了）正文就放全文。
    const body =
      title === first.trim() ? lines(rest.join('\n'), LINES_MAX - 1) : lines(question, LINES_MAX - 1);
    const options = ask.options
      .map((o) => clip(o, 40))
      .filter((o) => o.length > 0)
      .slice(0, OPTIONS_MAX);
    out.push({
      id: `ask:${ask.id}`,
      kind: 'ask',
      to: { type: 'team' },
      title,
      lines: [...body, clip(`需求：${task.title}`, 500)],
      status: done ? 'done' : 'open',
      ...(ask.answer !== undefined
        ? {
            doneText: clip(
              `已回答：${clip(ask.answer, 60)}${answeredByName ? ` · ${answeredByName}` : ''}${ask.answeredAt ? ` · ${beijingStamp(ask.answeredAt)}` : ''}`,
              200,
            ),
          }
        : ended !== undefined
          ? { doneText: `需求已${ended}，不用再答了` }
          : {}),
      ...taskFields(task),
      askId: ask.id,
      ...(options.length > 0 ? { options } : {}),
      createdAt: ask.askedAt,
    });
  }
  for (const { notification: n, task, resolvedByName } of sources.notifications) {
    const link = n.link?.startsWith('/') && n.link.length <= 500 ? n.link : undefined;
    out.push({
      id: `notification:${n.id}`,
      kind: n.level,
      to: { type: 'team' },
      title: clip(n.title.trim() || LEVEL_WORDS[n.level], 100),
      lines: lines(n.body),
      status: n.resolvedAt === undefined ? 'open' : 'done',
      ...(n.resolvedAt === undefined
        ? {}
        : {
            doneText: clip(
              `已处理${resolvedByName ? ` · ${resolvedByName}` : ''} · ${beijingStamp(n.resolvedAt)}`,
              200,
            ),
          }),
      ...taskFields(task),
      notificationId: n.id,
      ...(link ? { link } : {}),
      createdAt: n.createdAt,
    });
  }
  return out.map((content) => ({ content, fingerprint: fingerprintOf(content) }));
}

/** 推迟、没发成的：到了时刻再多等这么一会儿才给，免得两台机器的钟差一点，网关当成「没到点又给回来」。 */
export const HOLD_MARGIN_MS = 2_000;

/**
 * 待推送 = 当前这一版还没收到「发了 / 改了 / 不发了」的回执、也不在推迟或没发成的等待期内。
 * 已经了结、又从没送到过卡的不再给（网关也只会回「不发了」）。按建立先后排，最多 limit 条。
 */
export function pendingOutbox(
  computed: readonly ComputedOutboxItem[],
  states: ReadonlyMap<string, FeishuOutboxState>,
  now: Date,
  limit: number,
): { items: OutboxItem[]; nextHoldAt?: number } {
  let nextHoldAt: number | undefined;
  const items: OutboxItem[] = [];
  for (const { content } of computed) {
    const state = states.get(content.id);
    if (!state) continue;
    if (content.status === 'done' && !state.delivered) continue;
    const ack = state.ack;
    if (ack && ack.revision === state.revision) {
      if (ack.status !== 'deferred' && ack.status !== 'failed') continue;
      const until = (ack.holdUntil ? Date.parse(ack.holdUntil) : 0) + HOLD_MARGIN_MS;
      if (until > now.getTime()) {
        nextHoldAt = Math.min(nextHoldAt ?? Number.POSITIVE_INFINITY, until);
        continue;
      }
    }
    items.push({
      ...content,
      revision: state.revision,
      ...(state.delivered ? { delivered: state.delivered } : {}),
    });
  }
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { items: items.slice(0, limit), ...(nextHoldAt === undefined ? {} : { nextHoldAt }) };
}

// —— 盘面快照 ——

export interface FeishuBoardInput {
  repos: readonly Repo[];
  /** 没结束的需求（所有仓）。 */
  openTasks: readonly Task[];
  subtasks: readonly Subtask[];
  /** 这些需求没结束的会话。 */
  activeRuns: readonly SessionRun[];
  plans: ReadonlyMap<string, RunPlan>;
  route: (routeId: string) => RouteInfo;
  /** 还没答的追问、没处理的通知（和算待推送读的是同一份）。 */
  sources: FeishuOutboxSources;
  /** 需求、子任务进入当前状态的时刻。 */
  stateSince: ReadonlyMap<string, string>;
  mergedToday: number;
  windows: readonly QuotaWindowRecord[];
  pools: readonly Pool[];
  channels: readonly Channel[];
  teamBoardCard: { messageId: string; sentAt: string } | null;
}

/** 「卡住」的需求：自己卡住了，或有子任务卡住了（算卡住，不再算在干）。 */
export function stalledTaskIds(openTasks: readonly Task[], subtasks: readonly Subtask[]): Set<string> {
  const ids = new Set(openTasks.filter((t) => t.state === 'stalled').map((t) => t.id));
  for (const s of subtasks) if (s.state === 'stalled') ids.add(s.taskId);
  return ids;
}

export function buildFeishuBoard(input: FeishuBoardInput, now: Date, staleAfterMs: number): Board {
  const repoName = new Map(input.repos.map((r) => [r.id, fullName(r)]));
  const repoOf = (t: Task) => {
    const name = repoName.get(t.repoId);
    if (!name) throw new Error(`任务 ${t.id} 所在的仓 ${t.repoId} 不在库里`);
    return name;
  };
  const open = input.openTasks.filter((t) => !TERMINAL.has(t.state));
  const stalledIds = stalledTaskIds(open, input.subtasks);
  const subtasksOf = (taskId: string) => input.subtasks.filter((s) => s.taskId === taskId);

  const openAlerts = input.sources.notifications
    .filter((x) => x.notification.level === 'alert' && x.notification.resolvedAt === undefined)
    .map((x) => x.notification);
  const stalled = open
    .filter((t) => stalledIds.has(t.id))
    .map((t) => {
      const stuckSubs = subtasksOf(t.id).filter((s) => s.state === 'stalled');
      const since =
        t.state === 'stalled'
          ? input.stateSince.get(t.id)
          : stuckSubs
              .map((s) => input.stateSince.get(s.id))
              .filter((x): x is string => x !== undefined)
              .sort()[0];
      const alert = openAlerts
        .filter((n) => n.taskId === t.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const why = alert
        ? clip(alert.title, 200)
        : stuckSubs.length > 0
          ? clip(`子任务「${stuckSubs.map((s) => s.title).join('」「')}」卡住了`, 200)
          : undefined;
      return {
        taskId: t.id,
        repo: repoOf(t),
        issueNumber: t.issueNumber,
        title: t.title,
        ...(since ? { since } : {}),
        ...(why ? { why } : {}),
      };
    })
    .sort((a, b) => (a.since ?? '￿').localeCompare(b.since ?? '￿') || a.issueNumber - b.issueNumber);

  const openTaskIds = new Set(open.map((t) => t.id));
  const waiting = [
    ...input.sources.asks
      .filter((x) => x.ask.answer === undefined && openTaskIds.has(x.task.id))
      .map((x) => ({
        kind: 'ask' as const,
        askId: x.ask.id,
        taskId: x.task.id,
        repo: x.task.repo,
        issueNumber: x.task.issueNumber,
        title: clip(x.ask.question, 100) || '（AI 没写问题原文）',
        since: x.ask.askedAt,
      })),
    ...input.sources.notifications
      .filter((x) => x.notification.level === 'decision' && x.notification.resolvedAt === undefined)
      .map((x) => ({
        kind: 'decision' as const,
        notificationId: x.notification.id,
        ...taskFields(x.task),
        title: clip(x.notification.title, 100) || LEVEL_WORDS.decision,
        since: x.notification.createdAt,
      })),
  ].sort((a, b) => a.since.localeCompare(b.since));

  const active = open
    .filter((t) => !stalledIds.has(t.id))
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  const activeRows = active.slice(0, 30).map((t) => {
    const subs = subtasksOf(t.id);
    const run = latestRun(input.activeRuns.filter((r) => r.taskId === t.id));
    return {
      taskId: t.id,
      repo: repoOf(t),
      issueNumber: t.issueNumber,
      title: t.title,
      state: t.state,
      progress: { done: subs.filter((s) => s.state === 'merged').length, total: subs.length },
      ...(run ? { activity: activityOf(run, input.plans.get(run.id), input.route(run.routeId)).text } : {}),
    };
  });

  return {
    asOf: now.toISOString(),
    counts: {
      running: active.length,
      stalled: stalled.length,
      waitingForYou: waiting.length,
      mergedToday: input.mergedToday,
    },
    stalled: stalled.slice(0, 20),
    waiting: waiting.slice(0, 20),
    active: activeRows,
    quota: quotaRows(input, now, staleAfterMs),
    teamBoardCard: input.teamBoardCard,
  };
}

function latestRun(runs: readonly SessionRun[]): SessionRun | undefined {
  return [...runs].sort((a, b) => (b.startedAt ?? b.queuedAt).localeCompare(a.startedAt ?? a.queuedAt))[0];
}

/** 快用完的、快清零还剩不少的，最该看的在前（快用完的先，按剩余从少到多；再是快清零的，按清零先后）。 */
const NEARLY_OUT = 0.2;
const PLENTY_LEFT = 0.3;
const RESET_SOON_MS = DAY_MS;

function quotaRows(input: FeishuBoardInput, now: Date, staleAfterMs: number): Board['quota'] {
  const channelById = new Map(input.channels.map((c) => [c.id, c]));
  const poolById = new Map(input.pools.map((p) => [p.id, p]));
  const poolsPerChannel = new Map<string, number>();
  for (const p of input.pools) poolsPerChannel.set(p.channelId, (poolsPerChannel.get(p.channelId) ?? 0) + 1);
  const poolName = (poolId: string) => {
    const pool = poolById.get(poolId);
    const channel = pool ? channelById.get(pool.channelId) : undefined;
    if (!pool || !channel) return poolId;
    return (poolsPerChannel.get(channel.id) ?? 0) > 1 ? `${channel.name}（${pool.id}）` : channel.name;
  };
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const rows = input.windows
    // 上游这次没报的、读数太旧的不上盘面：拿旧数当现值会误导人。
    .filter((w) => w.staleSince === undefined && now.getTime() - Date.parse(w.readAt) <= staleAfterMs)
    .map((w) => {
      const remaining =
        w.utilization !== undefined
          ? clamp(1 - w.utilization)
          : w.used !== undefined && w.limit !== undefined && w.limit > 0
            ? clamp(1 - w.used / w.limit)
            : undefined;
      const resetsIn = w.resetsAt ? Date.parse(w.resetsAt) - now.getTime() : undefined;
      const nearlyOut =
        w.upstreamStatus === 'limit_reached' || (remaining !== undefined && remaining <= NEARLY_OUT);
      const resetSoon =
        !nearlyOut &&
        resetsIn !== undefined &&
        resetsIn >= 0 &&
        resetsIn <= RESET_SOON_MS &&
        remaining !== undefined &&
        remaining >= PLENTY_LEFT;
      return { w, remaining, resetsIn, nearlyOut, resetSoon };
    })
    .filter((x) => x.nearlyOut || x.resetSoon)
    .sort((a, b) => {
      if (a.nearlyOut !== b.nearlyOut) return a.nearlyOut ? -1 : 1;
      if (a.nearlyOut) return (a.remaining ?? 0) - (b.remaining ?? 0);
      return (a.resetsIn ?? 0) - (b.resetsIn ?? 0);
    });
  return rows.slice(0, 10).map(({ w, remaining }) => ({
    poolName: poolName(w.poolId),
    window: w.window,
    label: w.label,
    ...(remaining === undefined ? {} : { remaining }),
    ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
    reading: w.reading,
  }));
}
