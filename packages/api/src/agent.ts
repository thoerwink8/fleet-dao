// fleet 命令的接口（/agent/v1，照 shared/agent-api.ts）：只认 fleet 令牌，只能动令牌对应的那一次会话。
// 每条命令只写库，不发信号：引擎的任务工作流不听 fleet 命令的叫醒（它只听继续、放弃、路由叫醒），以前这里发的
// agentEvent / requireApproval 发给一个不存在的工作流、没人收（#901）。

import { ASK_HOLD_NAMES, type AskHold, type AskScope, checkAsk } from '@fleet-dao/core';
import {
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
  TaskResponse,
} from '@fleet-dao/shared';
import { checkDone } from '@fleet-dao/store';
import { Hono, type MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { verifyAgentToken } from './agent-token.ts';
import type { Deps } from './deps.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { AgentSession, AskRecord } from './ports.ts';

export type AgentEnv = { Variables: { agent: AgentSession } };

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

/**
 * fleet ask 当场回什么：创始人回过这一句（同一个会话问过一模一样的）就回他的回答；不然按提问的范围——
 * 这张单范围内的按推荐先做，超出范围的另开单，碰人闸的先按推荐做、合并前等批。
 * 同一句在这之前按老问法问过（库里那一条没有范围）：照这次带的范围回。
 */
function askReply(ask: AskRecord, scope: AskScope, recommended: string): z.input<typeof AskResponse> {
  if (ask.answer !== undefined) return { askId: ask.id, status: 'answered', answer: ask.answer };
  switch (ask.scope ?? scope) {
    case 'outside':
      return { askId: ask.id, status: 'outside' };
    case 'hold':
      return { askId: ask.id, status: 'held', answer: ask.recommended ?? recommended };
    case 'task':
      return { askId: ask.id, status: 'assumed', answer: ask.recommended ?? recommended };
  }
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

export function agentRoutes(deps: Deps): Hono<AgentEnv> {
  const { store } = deps;
  const bootedAt = deps.now().getTime();
  const app = new Hono<AgentEnv>();
  app.use('*', agentAuth(deps));
  const ok = { ok: true } as const;

  /**
   * 碰了人闸的提问（scope = hold）：以前是给工作流发 requireApproval 信号，合并前等创始人批。引擎的任务工作流没有这个接收处
   * （人闸只有它自己按改到的路径判的那一种：改标准、先审后合的路径），所以现在没法按提问加人闸——明说没加上（409），
   * 不回「已按推荐先做、合并前等批」装作拦住了。问题本身已经记在库里，驾驶舱看得到（#901）。
   */
  function holdMerge(hold: AskHold): never {
    throw new ApiError(
      409,
      'hold_not_supported',
      `问题已经记下，但人闸（${ASK_HOLD_NAMES[hold]}）没加上：现在的任务工作流不支持按提问追加人闸，合并前没有东西会拦`,
    );
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
    return c.json(ok);
  });

  app.post(AgentRoutes.say.path, idempotent(deps, 'agent.say', bootedAt), async (c) => {
    const session = c.get('agent');
    const { text } = await readJson(c, SayRequest);
    await store.appendProgress(session.runId, 'say', { text });
    return c.json(ok);
  });

  // 问他不挡路（#259）：不合格的（没带选项、没带推荐）当场退回让会话补齐；合格的记下、当场回，不等回答。
  app.post(AgentRoutes.ask.path, async (c) => {
    const session = c.get('agent');
    const body = await readJson(c, AskRequest);
    const checked = checkAsk(body);
    if (!checked.ok) throw new ApiError(400, 'ask_incomplete', checked.why);
    const q = checked.ask;
    const { ask } = await store.openAsk({
      runId: session.runId,
      taskId: session.taskId,
      question: q.question,
      options: q.options,
      scope: q.scope,
      recommended: q.recommended,
      ...(q.hold ? { hold: q.hold } : {}),
    });
    // 追问和它的 ask 进度在 openAsk 里同一事务写进去了。碰了人闸的：每次问（含重试、同一句再问）都明说没加上。
    const hold = ask.hold ?? q.hold;
    if (hold) holdMerge(hold);
    return reply(c, AskResponse, askReply(ask, q.scope, q.recommended));
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
    const verdict = checkDone({
      stage: session.stage,
      branch: session.branch,
      testCommand: session.testCommand,
      request,
      pr,
      tests,
    });
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
    return c.json(ok);
  });

  app.post(AgentRoutes.blocked.path, idempotent(deps, 'agent.blocked', bootedAt), async (c) => {
    const session = c.get('agent');
    const body = await readJson(c, BlockedRequest);
    await store.appendProgress(session.runId, 'blocked', { reason: body.reason, needs: body.needs });
    return c.json(ok);
  });

  return app;
}
