// 接活：放进来的 issue、评论事件 → 任务行、需求工作流（design 第五节：写任务 → 几秒内收单）。
// 按事件里 issue 此刻的样子处理（开着 / 关了），不逐个对动作名：补收拼出来的事件动作是 synced、reconcile，照样处理。
// 只有「重开」「编辑」这两件边沿上的事只认 webhook 带来的动作：补收看不出是谁、什么时候改的。
// 每一步都能重放：任务行按（仓, issue 号）唯一，起工作流按工作流编号去重，叫停重发引擎回「已经在叫停」。
// 抛错 = 没处理成：这条投递记成出错，对账重放时整条再来一遍（GitHub 自己不重投）。
import { randomUUID } from 'node:crypto';
import { humanPart } from '@fleet-dao/github';
import { AnswerAskRequest, type Repo, type Task } from '@fleet-dao/shared';
import { z } from 'zod';
import type { Deps } from './deps.ts';
import {
  type Actor,
  type IngestedEvent,
  type IntakeRepo,
  type NewAuditEntry,
  type User,
  WorkflowGoneError,
} from './ports.ts';
import { actorFor, GhUser, memberFor } from './whitelist.ts';

/** issues 事件要用的几样。门口（screenGithubEvent）按它认，认不出的在门口就记成不收（payload_unreadable）。 */
export const IssuePayload = z.object({
  action: z.string().optional(),
  sender: GhUser.optional(),
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullish(),
    state: z.enum(['open', 'closed']),
    created_at: z.string(),
    user: GhUser,
    pull_request: z.unknown().optional(),
  }),
});

/** issue_comment 事件。补收拼出来的只带 issue 号（认不出号时连 issue 都没有），webhook 的带整张 issue。 */
export const CommentPayload = z.object({
  action: z.string().optional(),
  issue: z.object({ number: z.number().int().positive(), pull_request: z.unknown().optional() }).optional(),
  comment: z.object({
    id: z.number(),
    body: z.string().nullish(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    user: GhUser,
  }),
});

/**
 * 现在做不了、过一会儿再做就行（关了又马上重开，上一轮还没结束）：这条投递记成出错，对账重放时再来。
 * 不是后端出了错：webhook 回 503 retry_later，日志只记一条警告。
 */
export class RetryLaterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryLaterError';
  }
}

const TERMINAL: readonly string[] = ['done', 'stopped', 'failed'];
/** 引擎这边自己的动作（拉起工作流）记在这个名下。 */
const INTAKE: Actor = { kind: 'engine', id: 'github-intake' };

/**
 * 拉不拉起工作流。start = 从没派过（还在排队），拉起；restart = 重开了、任务已经结束或还在排队，再拉起一次
 * （拉起时发现上一轮还在跑，就等它结束）；wait_previous_run = 重开了、上一轮正在做（刚叫停还在收尾，或者引擎
 * 做完正在收工），等它结束再拉起；其余都不拉起。
 */
export type DispatchDecision =
  | 'start'
  | 'restart'
  | 'wait_previous_run'
  | 'dispatch_off'
  | 'opened_before_switch'
  | 'created_at_unreadable'
  | 'in_progress'
  | 'finished';

/**
 * 自动派活开关（design 第九节「在哪能做与仓级开关」）：关着不派；开关打开以前就开着的 issue 不自动派（要人点「交给 fleet」）。
 * 开关允许时：还在排队（从没派过）的拉起；已经结束的只在 GitHub 上重开时再拉起一次；重开时上一轮还没结束的，等它结束。
 */
export function dispatchDecision(
  repo: Pick<IntakeRepo, 'autoDispatchSince'>,
  issueCreatedAt: string,
  task: Pick<Task, 'state'>,
  reopened: boolean,
): DispatchDecision {
  if (repo.autoDispatchSince === null) return 'dispatch_off';
  const opened = Date.parse(issueCreatedAt);
  if (!Number.isFinite(opened)) return 'created_at_unreadable';
  if (opened < Date.parse(repo.autoDispatchSince)) return 'opened_before_switch';
  if (reopened)
    return TERMINAL.includes(task.state) || task.state === 'queued' ? 'restart' : 'wait_previous_run';
  if (task.state === 'queued') return 'start';
  if (TERMINAL.includes(task.state)) return 'finished';
  return 'in_progress';
}

export interface IssueIntake {
  /** 不是 issue、评论事件：undefined。是：一句做了什么（记进这条投递的 note）。 */
  handle(event: IngestedEvent): Promise<string | undefined>;
}

export function createIssueIntake(
  deps: Pick<Deps, 'store' | 'workflows' | 'requirements' | 'log'>,
): IssueIntake {
  const { store, log } = deps;

  async function repoOf(event: IngestedEvent): Promise<IntakeRepo> {
    const [owner = '', name = ''] = event.repo.split('/');
    const repo = await store.findRepoByName(owner, name);
    // 门口刚按受管的仓放进来：找不到就是这之间仓被删了，如实失败
    if (!repo) throw new Error(`仓 ${event.repo} 不在库里（门口还当它是受管的）`);
    return repo;
  }

  const entry = (actor: Actor, action: string, taskId: string, extra: Partial<NewAuditEntry> = {}) =>
    ({ actor, action, target: `task:${taskId}`, via: 'github', ok: true, ...extra }) satisfies NewAuditEntry;

  async function stop(
    task: Task,
    event: IngestedEvent,
    p: z.infer<typeof IssuePayload>,
    users: User[],
  ): Promise<string> {
    // 自家机器人关的：做完了引擎自己关单，不叫停自己
    if (!event.wake) return 'stop=skip_bot';
    if (TERMINAL.includes(task.state)) return `task=${task.state}`;
    const actor = actorFor(memberFor(users, p.sender));
    const reason =
      p.action === 'deleted'
        ? 'GitHub 上删了这张 issue'
        : p.action === 'transferred'
          ? 'issue 转到别的仓了'
          : 'GitHub 上关了这张 issue';
    try {
      await deps.workflows.signal(task.id, { name: 'stop', by: actor.id, reason });
    } catch (err) {
      if (!(err instanceof WorkflowGoneError)) throw err;
      // 工作流不在：从没派出去的（还在排队）直接记成叫停；派出去过的多半刚结束，状态由引擎写
      const r = await store.stopQueuedTask(
        task.id,
        entry(actor, 'task.stop', task.id, { reason: `${reason}（没派出去过，直接记成叫停）` }),
      );
      if (r === 'ok') return 'task=stopped';
      log.warn('关单时工作流已经不在、任务又不在排队：多半刚结束，状态等引擎写；一直对不上要人看', {
        deliveryId: event.deliveryId,
        taskId: task.id,
        state: task.state,
      });
      return 'stop=workflow_gone';
    }
    await store.appendAudit(entry(actor, 'task.stop', task.id, { reason }));
    return 'stop=sent';
  }

  async function onIssue(event: IngestedEvent): Promise<string> {
    const p = IssuePayload.parse(event.payload);
    const issue = p.issue;
    if (issue.pull_request) return 'skip=pull_request';
    const repo = await repoOf(event);
    const users = await store.listUsers();
    const title = issue.title.trim() || `#${issue.number}`;
    const rawRequest = humanPart(issue.body ?? '') || title;
    let task = await store.findTaskByIssue(repo.id, issue.number);

    if (issue.state === 'closed' || p.action === 'deleted' || p.action === 'transferred') {
      return task ? stop(task, event, p, users) : 'task=none';
    }

    const notes: string[] = [];
    if (!task) {
      const author = memberFor(users, issue.user);
      const id = randomUUID();
      const created = await store.createTaskFromIssue(
        {
          id,
          repoId: repo.id,
          issueNumber: issue.number,
          title,
          rawRequest,
          requestedBy: author?.id ?? issue.user.login,
        },
        entry(actorFor(author), 'task.create', id, {
          after: { repo: event.repo, issueNumber: issue.number, title },
        }),
      );
      task = created.task;
      notes.push(created.created ? 'task=created' : 'task=exists');
    } else if (event.wake && p.action === 'edited') {
      // 门口已经挡掉了外人的编辑（edited_by_outsider）：走到这里的是白名单的人改的
      const updated = await store.updateTaskRequest(
        { taskId: task.id, title, rawRequest },
        entry(actorFor(memberFor(users, p.sender)), 'task.edit', task.id, {
          before: { title: task.title },
          after: { title },
        }),
      );
      notes.push(`request=${updated}`);
    } else {
      notes.push('task=exists');
    }

    const decision = dispatchDecision(repo, issue.created_at, task, event.wake && p.action === 'reopened');
    if (decision === 'wait_previous_run') {
      // 关了又马上重开：叫停还在收尾（或引擎做完正在收工），这会儿拉起会撞上还没结束的上一轮，悄悄丢掉这次重开
      throw new RetryLaterError(
        `GitHub 上重开了，上一轮还没结束（任务现在是 ${task.state}）：等它结束后由对账重放再拉起`,
      );
    }
    if (decision !== 'start' && decision !== 'restart') {
      notes.push(`workflow=${decision}`);
      return notes.join(', ');
    }
    const { autoDispatchSince: _switch, ...repoOnly } = repo;
    const started = await deps.requirements.start({
      schemaVersion: 1,
      taskId: task.id,
      repo: repoOnly satisfies Repo,
      issueNumber: issue.number,
      title,
      rawRequest,
      requestedBy: issue.user.login,
    });
    if (started === 'already_running' && decision === 'restart') {
      // 任务记成结束（或还在排队），上一轮工作流却还在收尾：同上，等它真结束
      throw new RetryLaterError('GitHub 上重开了，上一轮工作流还没收完尾：等它结束后由对账重放再拉起');
    }
    if (started === 'started') {
      await store.appendAudit(
        entry(INTAKE, 'task.start', task.id, {
          reason: decision === 'restart' ? 'GitHub 上重开了这张 issue' : undefined,
        }),
      );
    }
    notes.push(`workflow=${started}`);
    return notes.join(', ');
  }

  /**
   * 评论能不能当回答，先看它是不是原样的：webhook 新写的（created）可以；补收拼出来的（synced）只有从没改过的
   * （updated_at 等于 created_at）才可以——改过的看不出是谁改的，白名单作者的评论可能被外人改过（改评论的
   * webhook 丢了，补收就只看得到改后的样子）。别的动作（改了、删了）一律不当回答。
   */
  function pristine(p: z.infer<typeof CommentPayload>, event: IngestedEvent): string | null {
    if (p.action === 'created') return null;
    if (p.action !== 'synced') return `skip=${p.action ?? 'no_action'}`;
    const created = Date.parse(p.comment.created_at ?? '');
    const updated = Date.parse(p.comment.updated_at ?? '');
    if (!Number.isFinite(created) || !Number.isFinite(updated)) {
      log.warn('补收到的评论读不出建立、修改时刻：看不出改没改过，没当回答', {
        deliveryId: event.deliveryId,
        commentId: p.comment.id,
      });
      return 'ask=comment_time_unreadable';
    }
    if (created !== updated) {
      log.warn('补收到的评论改过（看不出是谁改的），没当回答', {
        deliveryId: event.deliveryId,
        commentId: p.comment.id,
      });
      return 'skip=edited';
    }
    return null;
  }

  async function onComment(event: IngestedEvent): Promise<string> {
    const p = CommentPayload.parse(event.payload);
    // 自家机器人发的评论（关单时的说明、进度）不当回答
    if (!event.wake) return 'skip=bot';
    const notPristine = pristine(p, event);
    if (notPristine) return notPristine;
    if (!p.issue) {
      // 补收时评论的 issue_url 认不出：不知道是哪张 issue 的，可能是一句回答，丢了要让人知道
      log.warn('评论认不出是哪张 issue 的，没当回答', {
        deliveryId: event.deliveryId,
        commentId: p.comment.id,
      });
      return 'skip=issue_unknown';
    }
    if (p.issue.pull_request) return 'skip=pull_request';
    const repo = await repoOf(event);
    const task = await store.findTaskByIssue(repo.id, p.issue.number);
    if (!task) return 'task=none';
    if (TERMINAL.includes(task.state)) return `task=${task.state}`;

    const answer = p.comment.body?.trim() ?? '';
    if (!AnswerAskRequest.safeParse({ answer }).success) {
      if (!answer) return 'ask=empty_comment';
      log.warn('评论太长，没当回答（回答最长 4000 字）', {
        deliveryId: event.deliveryId,
        taskId: task.id,
        chars: answer.length,
      });
      return 'ask=comment_too_long';
    }
    const at = Date.parse(p.comment.created_at ?? '');
    if (!Number.isFinite(at)) {
      log.warn('评论读不出是什么时候写的：对不上是回答哪一条追问，没当回答', {
        deliveryId: event.deliveryId,
        taskId: task.id,
      });
      return 'ask=comment_time_unreadable';
    }
    const users = await store.listUsers();
    const actor = actorFor(memberFor(users, p.comment.user));
    // 只有评论之前就问了的才算：评论不会回答它之后才问的问题
    const asked = (await store.listAsks(task.id)).filter((a) => Date.parse(a.askedAt) <= at);
    const open = asked.filter((a) => a.answer === undefined);
    if (open.length > 1) {
      log.warn('评论对不上是回答哪一条追问（有好几条没答），没当回答', {
        deliveryId: event.deliveryId,
        taskId: task.id,
        open: open.length,
      });
      return `ask=ambiguous_${open.length}`;
    }
    let askId: string;
    if (open.length === 1 && open[0]) {
      askId = open[0].id;
      const result = await store.answerAsk(
        { askId, answer, by: actor },
        entry(actor, 'ask.answer', task.id, { after: { askId, answer } }),
      );
      if (result === 'not_found') return 'ask=gone';
      if (result === 'already_answered') return 'ask=answered_elsewhere';
    } else {
      // 上次已经把这条评论记成回答、信号没发出去（这条投递记成了出错）：这次只补发信号
      const mine = asked.find((a) => a.answer === answer && a.answeredBy === actor.id);
      if (!mine) return 'ask=none_open';
      askId = mine.id;
    }
    try {
      await deps.workflows.signal(task.id, { name: 'answer', by: actor.id, askId, answer });
    } catch (err) {
      // 回答已经写进库（fleet ask 从库里读得到）；工作流不在就不用叫醒，连不上就记成出错、重放时补发
      if (err instanceof WorkflowGoneError) return 'ask=answered, workflow=gone';
      throw err;
    }
    return 'ask=answered';
  }

  return {
    async handle(event) {
      if (event.event === 'issues') return onIssue(event);
      if (event.event === 'issue_comment') return onComment(event);
      return undefined;
    },
  };
}
