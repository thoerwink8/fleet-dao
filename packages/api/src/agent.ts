// fleet 命令的接口（/agent/v1，照 shared/agent-api.ts）：只认 fleet 令牌，只能动令牌对应的那一次会话。
// 每条命令先写库、再叫醒工作流；库是准，信号只是叫醒。
import {
  AGENT_EVENT_WAKE_KINDS,
  AgentRoutes,
  AskRequest,
  AskResponse,
  BlockedRequest,
  DoneRequest,
  HistoryRequest,
  HistoryResponse,
  IDEMPOTENCY_KEY_HEADER,
  PlanRequest,
  SayRequest,
  subtaskWorkflowId,
  TaskResponse,
} from '@fleet-dao/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { verifyAgentToken } from './agent-token.ts';
import type { AskWaiters } from './changes.ts';
import type { Deps } from './deps.ts';
import { checkDone } from './done-check.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { AgentSession, AskRecord, TaskSignal } from './ports.ts';
import { requirementWorkflowIdForTask } from './temporal.ts';

export type AgentEnv = { Variables: { agent: AgentSession } };

/** 等回答时隔多久回库看一眼（数据库变化通知没接上时的兜底）。 */
const ASK_POLL_MS = 5_000;
/** 幂等键最长多少字（插头用的是 uuid）。 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
/** 占着键超过这么久还没做完，当它已经死了（连接断了、卡死了），接过来重做。正常一条命令毫秒级做完。 */
const ABANDONED_CLAIM_MS = 60_000;

/**
 * 按 Idempotency-Key 去重（同一会话内）：第一次成功的结果记下来，重试直接回它，不会把一句话记成两句；
 * 没成功（4xx/5xx）就放掉键，重试会重新执行。没带键的请求照常执行（兼容老客户端）。
 * 本进程启动前占的键一定是上一个进程留下的（fleet 接口只有一个进程，只听本机），重试当场接过来重做——
 * 不然发版重启那一下在途的命令，插头几次重试全吃 in_flight，白白失败。
 */
function idempotent(deps: Deps, action: string, bootedAt: number): MiddlewareHandler<AgentEnv> {
  return async (c, next) => {
    const key = c.req.header(IDEMPOTENCY_KEY_HEADER)?.trim();
    if (!key) return next();
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new ApiError(400, 'invalid_idempotency_key', `${IDEMPOTENCY_KEY_HEADER} 太长`);
    }
    const { store, log } = deps;
    const ids = { runId: c.get('agent').runId, key };
    const takeOverBefore = new Date(Math.max(bootedAt, deps.now().getTime() - ABANDONED_CLAIM_MS));
    const claim = await store.claimCommand({ ...ids, action, takeOverBefore: takeOverBefore.toISOString() });
    if (claim.status === 'other-action') {
      throw new ApiError(
        409,
        'idempotency_key_reused',
        `这个幂等键已经用在别的命令（${claim.action}）上了：一条命令一个键`,
      );
    }
    if (claim.status === 'done') {
      const { status, body } = claim.result as { status: ContentfulStatusCode; body: unknown };
      return c.json(body as object, status);
    }
    if (claim.status === 'in-flight') {
      c.header('Retry-After', '1');
      throw new ApiError(503, 'in_flight', '同一条命令（同一个幂等键）还在处理，稍后用同一个键重试');
    }
    if (claim.tookOver) {
      log.warn('幂等键上一次占着没做完（进程重启过或卡住了），接过来重新执行', { runId: ids.runId, action });
    }
    // 记结果、放键都只动自己这次的占用：被接管以后，旧请求再做完或失败都碰不到接管它的那次。
    const mine = { ...ids, token: claim.token };
    try {
      await next();
    } catch (err) {
      await store.releaseCommand(mine);
      throw err;
    }
    if (c.res.status >= 200 && c.res.status < 300 && !c.error) {
      const body: unknown = await c.res.clone().json();
      try {
        if (!(await store.completeCommand(mine, { status: c.res.status, body }))) {
          log.warn('命令做完了，但这个幂等键已被别的请求接管，回执以接管的那次为准', {
            runId: ids.runId,
            action,
          });
        }
      } catch (err) {
        // 命令已经做了，只是回执没记上：重试会在键过期（ABANDONED_CLAIM_MS）后重做一次。留日志。
        log.error('命令做完了，但幂等回执没记上', { runId: ids.runId, action, error: String(err) });
      }
    } else {
      await store.releaseCommand(mine);
    }
  };
}

const TOKEN_PROBLEMS = {
  malformed: '令牌格式不对',
  bad_signature: '令牌签名不对',
  expired: '令牌过期了',
  not_yet_valid: '令牌的签发时间在未来（两台机器时钟对不上？）',
  ttl_too_long: '令牌有效期超过上限，不认',
} as const;

type AgentEventKind = Extract<TaskSignal, { name: 'agentEvent' }>['kind'];

/** 这一类 fleet 命令值不值得叫醒工作流（say、plan 不值得，只进库）。 */
function isWakeKind(kind: AgentEventKind): kind is (typeof AGENT_EVENT_WAKE_KINDS)[number] {
  return (AGENT_EVENT_WAKE_KINDS as readonly string[]).includes(kind);
}

export function agentAuth(deps: Deps): MiddlewareHandler<AgentEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new ApiError(
        401,
        'agent_token_missing',
        '缺 fleet 令牌（请求头 Authorization: Bearer <FLEET_TOKEN>）',
      );
    }
    const check = verifyAgentToken(
      deps.config.agentTokenSecret,
      header.slice('Bearer '.length).trim(),
      deps.now(),
    );
    if (!check.ok) throw new ApiError(401, 'agent_token_invalid', TOKEN_PROBLEMS[check.reason]);
    const { claims } = check;
    const session = await deps.store.getAgentSession(claims.runId);
    if (
      !session ||
      session.taskId !== claims.taskId ||
      (session.subtaskId ?? null) !== (claims.subtaskId ?? null)
    ) {
      throw new ApiError(401, 'agent_token_invalid', '令牌对应的会话不存在');
    }
    if (session.endedAt) throw new ApiError(401, 'agent_session_ended', '这次会话已经结束，令牌作废');
    c.set('agent', session);
    await next();
  };
}

export function agentRoutes(deps: Deps, waiters: AskWaiters): Hono<AgentEnv> {
  const { store, log } = deps;
  const bootedAt = deps.now().getTime();
  const app = new Hono<AgentEnv>();
  app.use('*', agentAuth(deps));
  const ok = { ok: true } as const;

  /**
   * 叫醒工作流：只有 AGENT_EVENT_WAKE_KINDS 这几类（ask、done、blocked）才发，say、plan 只进库、不发信号
   * （每条都发的话，一个需求二十来个子任务能把需求的历史撑到上万条事件，撞上 Temporal 的信号上限）。
   * 直接发给会话所属的工作流：子任务会话发它的子任务工作流（编号直接拼），需求自己的会话（分诊、需求文档、方案）
   * 发需求工作流（编号查库拼）。叫醒失败不挡命令：记录已经写库，引擎按库补看；但要留日志，不能悄悄吞掉。
   */
  async function wake(session: AgentSession, kind: AgentEventKind, askId?: string) {
    if (!isWakeKind(kind)) return;
    try {
      const workflowId = session.subtaskId
        ? subtaskWorkflowId(session.subtaskId)
        : await requirementWorkflowIdForTask(store, session.taskId);
      await deps.workflows.signal(workflowId, { name: 'agentEvent', runId: session.runId, kind, askId });
    } catch (err) {
      log.warn('fleet 命令已写库，但叫醒工作流没成功', { runId: session.runId, kind, error: String(err) });
    }
  }

  async function waitForAnswer(askId: string, ms: number, signal: AbortSignal): Promise<AskRecord | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const ask = await store.getAsk(askId);
      if (ask?.answer !== undefined) return ask;
      const left = deadline - Date.now();
      if (left <= 0 || signal.aborted) return null;
      await waiters.sleep(askId, Math.min(left, ASK_POLL_MS), signal);
    }
  }

  app.get(AgentRoutes.task.path, async (c) => {
    const session = c.get('agent');
    const [task, repo, subtasks, plans] = await Promise.all([
      store.getTask(session.taskId),
      store.getRepo(session.repoId),
      session.subtaskId ? store.listSubtasks([session.taskId]) : Promise.resolve([]),
      store.getPlans([session.runId]),
    ]);
    if (!task || !repo) throw new ApiError(500, 'task_missing', '会话对应的任务或仓不在库里');
    const subtask = subtasks.find((s) => s.id === session.subtaskId);
    return reply(c, TaskResponse, {
      taskId: task.id,
      subtaskId: session.subtaskId,
      repo: `${repo.owner}/${repo.name}`,
      branch: session.branch,
      specDir: task.specDir,
      request: task.rawRequest,
      acceptance: session.acceptance,
      touches: subtask?.touches ?? [],
      plan: (plans.get(session.runId)?.steps ?? []).map((s) => ({ title: s.title, state: s.state })),
    });
  });

  app.post(AgentRoutes.plan.path, idempotent(deps, 'agent.plan', bootedAt), async (c) => {
    const session = c.get('agent');
    const { steps } = await readJson(c, PlanRequest);
    await store.savePlan(
      session.runId,
      steps.map((s, index) => ({ index, title: s.title, state: s.state })),
    );
    await wake(session, 'plan');
    return c.json(ok);
  });

  app.post(AgentRoutes.say.path, idempotent(deps, 'agent.say', bootedAt), async (c) => {
    const session = c.get('agent');
    const { text } = await readJson(c, SayRequest);
    await store.appendProgress(session.runId, 'say', { text });
    await wake(session, 'say');
    return c.json(ok);
  });

  app.post(AgentRoutes.ask.path, async (c) => {
    const session = c.get('agent');
    const body = await readJson(c, AskRequest);
    const { ask, created } = await store.openAsk({
      runId: session.runId,
      taskId: session.taskId,
      question: body.question,
      options: body.options ?? [],
    });
    // 追问和它的 ask 进度在 openAsk 里同一事务写进去了，这里只叫醒工作流。
    if (created) await wake(session, 'ask', ask.id);
    const answered =
      ask.answer !== undefined
        ? ask
        : body.blocking && deps.config.askWaitMs > 0
          ? await waitForAnswer(ask.id, deps.config.askWaitMs, c.req.raw.signal)
          : null;
    return reply(
      c,
      AskResponse,
      answered?.answer !== undefined
        ? { askId: ask.id, status: 'answered', answer: answered.answer }
        : { askId: ask.id, status: 'pending' },
    );
  });

  app.post(AgentRoutes.history.path, async (c) => {
    const session = c.get('agent');
    const { query, limit } = await readJson(c, HistoryRequest);
    const items = await store.searchHistory({ repoId: session.repoId, query, limit });
    return reply(c, HistoryResponse, { items });
  });

  app.post(AgentRoutes.done.path, idempotent(deps, 'agent.done', bootedAt), async (c) => {
    const session = c.get('agent');
    const request = await readJson(c, DoneRequest);
    const [pr, tests] = await Promise.all([
      request.prNumber === undefined
        ? Promise.resolve(null)
        : store.getPullRequest(session.repoId, request.prNumber),
      store.listTestRuns(session.runId),
    ]);
    const verdict = checkDone({ stage: session.stage, branch: session.branch, request, pr, tests });
    if (!verdict.ok) {
      // 退回也落库（任务时间线和操作记录里看得到），不只打日志：「交了几次、为什么被退」是判假完成的依据。
      await store.appendAudit({
        actor: { kind: 'agent', id: session.runId },
        action: 'agent.done_rejected',
        target: `task:${session.taskId}`,
        after: {
          runId: session.runId,
          summary: request.summary,
          prNumber: request.prNumber,
          testsPassed: request.testsPassed,
          code: verdict.code,
          reasons: verdict.reasons,
        },
        via: 'agent',
        ok: false,
        error: verdict.code,
      });
      throw new ApiError(verdict.status, verdict.code, verdict.message, { reasons: verdict.reasons });
    }
    await store.appendProgress(session.runId, 'done', {
      summary: request.summary,
      prNumber: request.prNumber,
      testsPassed: request.testsPassed,
      verified: verdict.evidence,
    });
    await wake(session, 'done');
    return c.json(ok);
  });

  app.post(AgentRoutes.blocked.path, idempotent(deps, 'agent.blocked', bootedAt), async (c) => {
    const session = c.get('agent');
    const body = await readJson(c, BlockedRequest);
    await store.appendProgress(session.runId, 'blocked', { reason: body.reason, needs: body.needs });
    await wake(session, 'blocked');
    return c.json(ok);
  });

  return app;
}
