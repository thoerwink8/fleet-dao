// fleet 命令的接口（/agent/v1，照 shared/agent-api.ts）：只认 fleet 令牌，只能动令牌对应的那一次会话。
// 每条命令先写库、再叫醒工作流；库是准，信号只是叫醒。
import {
  AgentRoutes,
  AskRequest,
  AskResponse,
  BlockedRequest,
  DoneRequest,
  HistoryRequest,
  HistoryResponse,
  PlanRequest,
  SayRequest,
  TaskResponse,
} from '@fleet-dao/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import { verifyAgentToken } from './agent-token.ts';
import type { AskWaiters } from './changes.ts';
import type { Deps } from './deps.ts';
import { checkDone } from './done-check.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { AgentSession, AskRecord, TaskSignal } from './ports.ts';

export type AgentEnv = { Variables: { agent: AgentSession } };

/** 等回答时隔多久回库看一眼（数据库变化通知没接上时的兜底）。 */
const ASK_POLL_MS = 5_000;

const TOKEN_PROBLEMS = {
  malformed: '令牌格式不对',
  bad_signature: '令牌签名不对',
  expired: '令牌过期了',
  not_yet_valid: '令牌的签发时间在未来（两台机器时钟对不上？）',
  ttl_too_long: '令牌有效期超过上限，不认',
} as const;

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
  const app = new Hono<AgentEnv>();
  app.use('*', agentAuth(deps));
  const ok = { ok: true } as const;

  /** 叫醒工作流失败不挡命令：记录已经写库，引擎按库补看；但要留日志，不能悄悄吞掉。 */
  async function wake(
    session: AgentSession,
    kind: Extract<TaskSignal, { name: 'agentEvent' }>['kind'],
    askId?: string,
  ) {
    try {
      await deps.workflows.signal(session.taskId, { name: 'agentEvent', runId: session.runId, kind, askId });
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

  app.post(AgentRoutes.plan.path, async (c) => {
    const session = c.get('agent');
    const { steps } = await readJson(c, PlanRequest);
    await store.savePlan(
      session.runId,
      steps.map((s, index) => ({ index, title: s.title, state: s.state })),
    );
    await wake(session, 'plan');
    return c.json(ok);
  });

  app.post(AgentRoutes.say.path, async (c) => {
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
    if (created) {
      await store.appendProgress(session.runId, 'ask', { askId: ask.id, question: ask.question });
      await wake(session, 'ask', ask.id);
    }
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

  app.post(AgentRoutes.done.path, async (c) => {
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

  app.post(AgentRoutes.blocked.path, async (c) => {
    const session = c.get('agent');
    const body = await readJson(c, BlockedRequest);
    await store.appendProgress(session.runId, 'blocked', { reason: body.reason, needs: body.needs });
    await wake(session, 'blocked');
    return c.json(ok);
  });

  return app;
}
