// 接活：放进来的 issue、评论事件 → 任务行、这张单的工作流（Fusion，design 第五节：写任务 → 几秒内收单）。
// 按事件里 issue 此刻的样子处理（开着 / 关了），不逐个对动作名：补收拼出来的事件动作是 synced、reconcile，照样处理。
// 只有「重开」「编辑」这两件边沿上的事只认 webhook 带来的动作：补收看不出是谁、什么时候改的。
// 每一步都能重放：任务行按（仓, issue 号）唯一，起工作流按工作流编号去重，叫停重发引擎回「已经在叫停」。
// 抛错 = 没处理成：这条投递记成出错，对账重放时整条再来一遍（GitHub 自己不重投）。
// 派不派（判法都在 @fleet-dao/core 的 dispatch.ts）：开关开着、issue 是开关打开以后开的，还要挂在当前版本上（0003 第 2、8 条：
// 引擎只做当前版本的单，未排期、别的版本的不碰），还不能是母单或子单（#252 之前：母单和子单各起一条会抢同一批文件），也不能贴着
// 「本机做」（#299 认领进库之前的止血：帅位留给本机做的）——挂在哪、当前版本是哪个、是不是母单子单、贴了哪些标签，拉起前在
// GitHub 上现读（deps.plans），读不到就当这条没处理成（记成出错、对账重放时再判），不当成挂在当前版本上的独立单。开关打开以前开的、
// 别的版本的、未排期的、母单和子单、贴了「本机做」的，由人明说交给 fleet（fleet-api handover，cli.ts）。
// 过了这几道再抢这张单的认领（#299，specs/299-帅位只一个/方案.md 第四节）：和本机（帅位、工人）抢库里同一行，本机拿着就不派；
// 抢到的先记待起，工作流起成了改在做；起没成留着待起，投递重放、GitHub 对账（restartPending）再起。
// 拉起之前看这个仓的流程配置副本（docs/decisions/0003-fusion-flow.md 第 9 条）：认不出、太旧就停派，这条记成等着，
// 副本好了由对账重放再拉起（判法在 @fleet-dao/core 的 replica.ts）。
import { randomUUID } from 'node:crypto';
import {
  type AutoDispatchGate,
  autoDispatchGate,
  dispatchDecision,
  ENGINE_PENDING_RESTART_MINUTES,
  heldByOtherText,
  type IssueClaim,
  isFinishedTask,
  replicaVerdict,
} from '@fleet-dao/core';
import { type GitHub, humanPart } from '@fleet-dao/github';
import { AnswerAskRequest, type Repo, requirementWorkflowId, type Task } from '@fleet-dao/shared';
import { z } from 'zod';
import type { Deps } from './deps.ts';
import {
  type Actor,
  type IngestedEvent,
  type IntakeRepo,
  type IssuePlan,
  type IssuePlanReader,
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
 * 现在做不了、过一会儿再做就行（关了又马上重开，上一轮还没结束）：这条投递记成等着（waiting），每轮对账都重放，
 * 不占自动重放的次数——上一轮跑多久都等得住。不是后端出了错：webhook 回 503 retry_later，日志只记一条警告。
 */
export class RetryLaterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryLaterError';
  }
}

/** 引擎这边自己的动作（拉起工作流）记在这个名下。 */
const INTAKE: Actor = { kind: 'engine', id: 'github-intake' };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 读 issue 此刻挂在哪个版本、是不是母单子单、开没开着：经 @fleet-dao/github 的「引擎」机器人现读（后端 main.ts、引擎对账都这样装）。 */
export function githubIssuePlans(gh: Pick<GitHub, 'readIssuePlan'>): IssuePlanReader {
  return {
    read: (repo, issueNumber) =>
      gh.readIssuePlan({ repo: { owner: repo.owner, name: repo.name }, issueNumber }),
  };
}

/** 机器人凭据没读到（githubAppMissing 那种情况）：一读就抛，接活不派（投递记成出错、对账重放），不当成挂在当前版本上的独立单。 */
export function issuePlansUnavailable(why: string): IssuePlanReader {
  return {
    async read() {
      throw new Error(`GitHub 机器人的凭据没读到，读不了 issue 挂在哪个版本、是不是母单子单：${why}`);
    },
  };
}

/** GitHub 对账补起待起认领这一轮的结果。 */
export interface PendingRestartReport {
  /** 看了几张待起超过几分钟的引擎认领。 */
  checked: number;
  /** 起了几张（含本来就在跑、只是认领还没改成在做的）。 */
  started: number;
  /** 不起了、放下了几张（开关关了、上一轮已经结束、单子关了）。 */
  released: number;
  /** 没起成、没查成的，一张一句。 */
  problems: string[];
}

/** 一轮最多补起几张待起的认领（多的下一轮再来）。 */
const PENDING_BATCH = 20;

export interface IssueIntake {
  /** issue、评论、PR 事件（PR 的贴「认领对得上」，#348）：一句做了什么（记进这条投递的 note）；别的事件 undefined。 */
  handle(event: IngestedEvent): Promise<string | undefined>;
  /**
   * 待起超过几分钟还没起来的引擎认领再起一次（GitHub 对账每轮调，方案第四节）：起工作流没成的投递最多自动重放 5 次、之后不再
   * 重放，靠这里照认领行里的工作流编号、经同一个拉起实现补起。只起从没派出去过的（任务还在排队）；工作流已经在跑的只把认领改成
   * 在做；上一轮已经结束的（重开再起那种）、开关关了、单子关了的放下认领，交回投递重放或交单。
   */
  restartPending(): Promise<PendingRestartReport>;
}

export function createIssueIntake(
  deps: Pick<Deps, 'store' | 'workflows' | 'requirements' | 'plans' | 'log' | 'now' | 'claims'>,
): IssueIntake {
  const { store, log } = deps;

  /**
   * 挂没挂在当前版本上、是不是母单子单：GitHub 上现读这张单挂的里程碑、仓里还开着的里程碑、标签和父子关系（重放时事件里带的
   * 那份可能早过时了，事件里也不带父子关系），交给 core 判。读不到、认不出就抛：这条投递记成出错、对账重放时再判，
   * 不当成挂在当前版本上的独立单。
   */
  async function gateOf(repo: IntakeRepo, issueNumber: number): Promise<AutoDispatchGate> {
    let plan: IssuePlan;
    try {
      plan = await deps.plans.read(repo, issueNumber);
    } catch (err) {
      throw new Error(
        `没查成：读不到 ${repo.owner}/${repo.name}#${issueNumber} 挂在哪个版本、是不是母单子单（${message(err)}），这张单没派；对账重放时再判`,
        { cause: err },
      );
    }
    return autoDispatchGate(plan);
  }

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
    repo: IntakeRepo,
    task: Task,
    event: IngestedEvent,
    p: z.infer<typeof IssuePayload>,
    users: User[],
  ): Promise<string> {
    // 自家机器人关的：做完了引擎自己关单，不叫停自己
    if (!event.wake) return 'stop=skip_bot';
    if (isFinishedTask(task.state)) return `task=${task.state}`;
    const actor = actorFor(memberFor(users, p.sender));
    const reason =
      p.action === 'deleted'
        ? 'GitHub 上删了这张 issue'
        : p.action === 'transferred'
          ? 'issue 转到别的仓了'
          : 'GitHub 上关了这张 issue';
    try {
      await deps.workflows.signal(requirementWorkflowId(repo, task.issueNumber), {
        name: 'stop',
        by: actor.id,
        reason,
      });
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
      return task ? stop(repo, task, event, p, users) : 'task=none';
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
    // 只派当前版本的单（0003 第 2、8 条）：未排期、别的版本、挂的里程碑关了的都不派，任务行留着（排队），之后挪进当前版本
    // （GitHub 的 milestoned 事件）照开关规矩再判一次；认不出版本号的算没查成，告警。
    // 母单、子单也不派（#252 之前：一张单只走一块，母单和子单各起一条会抢同一批文件）；#252 做完改成母单的 Lead 按块带子单。
    // 贴了「本机做」的也不派（#299 止血：帅位留给本机做的，开单、挪进当前版本、别的标签变动都不派）。
    // 人要交就用 fleet-api handover 一张一张明着交。
    // 急修（0003 第 4、8 条：只有带证据的急修能自动开单，排在本版之前）现在还没有自动开单的来源，这里不开特例；
    // 以后引擎能开急修单时，在这一步之前按单上的急修标记（带证据）放行，不改当前版本的判法。
    const version = await gateOf(repo, issue.number);
    if (!version.ok) {
      log[version.reason === 'version_unreadable' ? 'warn' : 'info'](`这张单不自动派：${version.why}`, {
        deliveryId: event.deliveryId,
        repo: event.repo,
        issueNumber: issue.number,
        reason: version.reason,
      });
      notes.push(`workflow=${version.reason}`);
      return notes.join(', ');
    }
    // 这个项目停派（流程配置认不出、从没同步过、太久没同步成）：不拉起，也不丢——记成等着（不占自动重放的次数），
    // 每轮对账先同步副本、再重放，副本好了那一轮就拉起
    const flow = replicaVerdict(repo.flow, deps.now());
    if (!flow.ok) {
      log.warn('流程配置副本不能用，这个项目停派：这张单等副本好了由对账重放再拉起', {
        deliveryId: event.deliveryId,
        repo: event.repo,
        issueNumber: issue.number,
        why: flow.why,
      });
      throw new RetryLaterError(`这个项目停派：${flow.why}。副本好了由对账重放再拉起`);
    }
    // 抢认领：本机拿着（帅位留给本机做的、工人在做的）就不派，写明谁拿着；引擎自己拿着的（重投、重放、上一次起工作流没成）
    // 照旧往下起
    const claim = await store.claimForEngine({
      repoId: repo.id,
      issueNumber: issue.number,
      workflowId: requirementWorkflowId(repo, issue.number),
      actor: INTAKE,
      note: decision === 'restart' ? 'GitHub 上重开了，接活再派一轮' : '接活自动派',
    });
    if (!claim.ok) {
      log.info(`这张单不自动派：${heldByOtherText(claim.claim, claim.now)}`, {
        deliveryId: event.deliveryId,
        repo: event.repo,
        issueNumber: issue.number,
        claimId: claim.claim.claimId,
      });
      notes.push('workflow=claimed_local');
      return notes.join(', ');
    }
    // 开关、副本都不进工作流的历史
    const { autoDispatchSince: _switch, flow: _flow, ...repoOnly } = repo;
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
    // 起成了（already_running：上一次其实起成了）：认领从待起改成在做。这一步没写上也不要紧，工作流写第一份快照时同样会改
    await store.startEngineClaim({ repoId: repo.id, issueNumber: issue.number });
    if (started === 'started') {
      await store.appendAudit(
        entry(INTAKE, 'task.start', task.id, {
          // 按哪个版本派的：挪版本、关版本之后回头查得清
          after: { milestone: version.milestone },
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
    if (isFinishedTask(task.state)) return `task=${task.state}`;

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
    // 按推荐先做了的（#259，带范围）不等回答、整张单做完前一直开着：随手一句评论（问进度、帅位的「在做」）
    // 不能当成改选，只有和某个选项一字不差的才算回答它；老式的（会话停着等）照旧任何一句都算
    const open = asked.filter(
      (a) => a.answer === undefined && (a.scope === undefined || a.options.includes(answer)),
    );
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
      await deps.workflows.signal(requirementWorkflowId(repo, task.issueNumber), {
        name: 'answer',
        by: actor.id,
        askId,
        answer,
      });
    } catch (err) {
      // 回答已经写进库（fleet ask 从库里读得到）；工作流不在就不用叫醒，连不上就记成出错、重放时补发
      if (err instanceof WorkflowGoneError) return 'ask=answered, workflow=gone';
      throw err;
    }
    return 'ask=answered';
  }

  /** 补起一张待起的认领：started / released / moved（这之间别处已经改了它）或一句没起成的原因。 */
  async function restartOne(
    claim: IssueClaim,
  ): Promise<'started' | 'released' | 'moved' | { problem: string }> {
    const base = await store.getRepo(claim.repoId);
    const repo = base && (await store.findRepoByName(base.owner, base.name));
    if (!repo) return { problem: `仓 ${claim.repoId} 的 #${claim.issueNumber} 待起：库里找不到这个仓` };
    const label = `${repo.owner}/${repo.name}#${claim.issueNumber}`;
    const target = { repoId: repo.id, issueNumber: claim.issueNumber };
    const release = async (why: string) =>
      (await store.releasePendingEngineClaim({
        ...target,
        claimId: claim.claimId,
        reason: why,
        actor: INTAKE,
      }))
        ? ('released' as const)
        : ('moved' as const);
    if (repo.autoDispatchSince === null)
      return release('「让 AI 接活」关着：待起的不起了，打开后由投递重放或交单再起');
    const task = await store.findTaskByIssue(repo.id, claim.issueNumber);
    if (!task) return { problem: `${label} 待起：库里没有这张单的任务行` };
    if (isFinishedTask(task.state)) {
      // 重开再起的那种：还在等的投递每轮都重放，由它按重开的规矩再起；这里起了会和它各起一轮
      return release(
        `上一轮已经结束（${task.state}），这一轮待起超过 ${ENGINE_PENDING_RESTART_MINUTES} 分钟没起来：放下，由投递重放或交单再起`,
      );
    }
    if (task.state !== 'queued') {
      // 工作流已经在跑（任务不在排队了），只是认领还没改成在做
      return (await store.startEngineClaim(target)).changed ? 'started' : 'moved';
    }
    const flow = replicaVerdict(repo.flow, deps.now());
    if (!flow.ok) return { problem: `${label} 待起：这个项目停派（${flow.why}），副本好了再起` };
    let plan: IssuePlan;
    try {
      plan = await deps.plans.read(repo, claim.issueNumber);
    } catch (err) {
      return { problem: `${label} 待起：没查成，读不到 GitHub 上这张单此刻的样子（${message(err)}）` };
    }
    if (plan.state === 'closed') return release('GitHub 上这张单关了：待起的不起了');
    // 开关、副本都不进工作流的历史（和接活拉起的是同一种输入、同一个拉起实现，工作流编号就是认领行里那个）
    const { autoDispatchSince: _switch, flow: _flow, ...repoOnly } = repo;
    const started = await deps.requirements.start({
      schemaVersion: 1,
      taskId: task.id,
      repo: repoOnly satisfies Repo,
      issueNumber: claim.issueNumber,
      title: task.title,
      rawRequest: task.rawRequest,
      requestedBy: plan.author ?? task.requestedBy,
    });
    if (started === 'started') {
      await store.appendAudit(
        entry(INTAKE, 'task.start', task.id, {
          reason: `待起的认领补起（待起超过 ${ENGINE_PENDING_RESTART_MINUTES} 分钟，GitHub 对账）`,
        }),
      );
    }
    await store.startEngineClaim(target);
    return 'started';
  }

  async function restartPending(): Promise<PendingRestartReport> {
    const { claims } = await store.listStalePendingEngineClaims({
      minutes: ENGINE_PENDING_RESTART_MINUTES,
      limit: PENDING_BATCH,
    });
    const report: PendingRestartReport = { checked: claims.length, started: 0, released: 0, problems: [] };
    for (const claim of claims) {
      try {
        const r = await restartOne(claim);
        if (r === 'started') report.started += 1;
        else if (r === 'released') report.released += 1;
        else if (r !== 'moved') report.problems.push(r.problem);
      } catch (err) {
        report.problems.push(`仓 ${claim.repoId} 的 #${claim.issueNumber} 待起，补起没成：${message(err)}`);
      }
    }
    return report;
  }

  return {
    async handle(event) {
      if (event.event === 'issues') return onIssue(event);
      if (event.event === 'issue_comment') return onComment(event);
      // PR 事件：按库里的认领贴「认领对得上」（#348）；机器人自己开的 PR 事件（不叫醒工作流的那种）也贴
      if (event.event === 'pull_request')
        return deps.claims ? deps.claims.onPullEvent(event) : 'claim_status=not_wired';
      return undefined;
    },
    restartPending,
  };
}
