// 动手这一段能不能续上一段的会话（planSegmentResume，决定 0088 第 3 条）：找上一段在 runs 里记下的会话号，对一遍执行方式、
// 账号池、会话用户，能续回会话号，续不上回白话原因。工作流照它决定这一段带不带 resumeSessionId。
//
// 改这里之前必须知道：
// - 续不上不是错：一律回 kind:'new' 加原因（工作流写进任务进度，原分支原树开新会话）。只有入参认不出才抛。
// - 上一段被暂停取消时，工作流不等那个活动收场（取消是 TRY_CANCEL），runs 那一行可能还没写会话号：等它收场，最多
//   RESUME_SETTLE_MS；还没收场就按续不上办，不拿一个还在跑的会话去续。
// - 同一个账号池才续：Claude 的会话绑着账号（换了组织直接 --resume 会被拒），cursor、grok、Mirasim 的会话记录跟着各自的
//   登录走。会话用户不同，会话记录不在同一个家目录里。工作树是不是同一棵由工作流比（它手上有路径）。
// - 会话号只认执行体报的真号（segment-spawner.ts 只往 runs 写真号）；起会话前的临时号（cursor-pending: 一类）不续。
// - 不比模型。#2742（2026-10-16，法国刚切到 0c35f93a）就是这条：前几段 opus 被发版停机取消（「引擎叫停（其他：CANCELLED）」，
//   当时 Mirasim 不脱开），继续后选路点到 mirasim-relay 的 sonnet，主机、池、会话用户都没变，仍续上那段 opus。
//   快照读回 claude-opus-5-5[1m]，点名是 claude-sonnet-5-5。不是中转换模（sonnet 在名册里，新会话的快照会是 sonnet[1m]），
//   也不是 `[1m]` 剥错。对不上之后怎么重派在任务工作流，不在这里改判续的条件。

import type { RunRow } from '@fleet-dao/db';
import { abortableSleep, errMessage } from '@fleet-dao/shared/util';
import { type PortContext, PortError } from '../ports.ts';
import type {
  PlanSegmentResumeInput,
  PlanSegmentResumeResult,
  SegmentSettledInput,
  SegmentSettledResult,
} from '../task-contract.ts';
import { resolveSegmentRoute, type SegmentSpawnerDeps } from './segment-spawner.ts';

/** 上一段还没收场时最多等多久（毫秒）、多久看一次。要在活动 quick 档 30 秒以内。 */
export const RESUME_SETTLE_MS = 20_000;
export const RESUME_POLL_MS = 2_000;

/** 判续不续要的那一面：执行方式、账号池、会话用户。 */
export interface ResumeSide {
  hostId: string;
  poolId: string;
  user: string;
}

/**
 * 纯判法：上一段（库里那一行和它路由的那一面）对这一次选定的路由。能续回会话号，续不上回原因。
 * 原因按人能看懂的先后：没收场 → 没记会话号 → 临时号 → 执行方式 → 账号池 → 会话用户。
 */
export function resumeVerdict(
  previous: { runId: string; endedAt: Date | null; sessionId: string | null; side: ResumeSide },
  next: ResumeSide,
): PlanSegmentResumeResult {
  if (previous.endedAt === null) return { kind: 'new', reason: '上一段的会话还没收场' };
  const sessionId = previous.sessionId?.trim() ?? '';
  if (sessionId === '') return { kind: 'new', reason: '上一段没记下会话号' };
  if (/^[a-z]+-pending:/.test(sessionId)) return { kind: 'new', reason: '上一段只有起会话前的临时号' };
  if (previous.side.hostId !== next.hostId) {
    return { kind: 'new', reason: `换了执行方式（${previous.side.hostId} → ${next.hostId}）` };
  }
  if (previous.side.poolId !== next.poolId) {
    return { kind: 'new', reason: `换了账号池（${previous.side.poolId} → ${next.poolId}）` };
  }
  if (previous.side.user !== next.user) {
    return { kind: 'new', reason: `换了会话用户（${previous.side.user} → ${next.user}）` };
  }
  return { kind: 'resume', sessionId, runId: previous.runId };
}

export interface PlanSegmentResumeDeps {
  /** 路由编号 → 执行方式、池、会话用户（和起会话同一个查法）。 */
  spawner: Pick<SegmentSpawnerDeps, 'routeFacts' | 'db' | 'drivers'>;
  getRun: (runId: string) => Promise<RunRow | null>;
  latestManualRun: (taskId: string, startedAfter: Date) => Promise<RunRow | null>;
  settleMs?: number;
  pollMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function createPlanSegmentResume(deps: PlanSegmentResumeDeps) {
  const settleMs = deps.settleMs ?? RESUME_SETTLE_MS;
  const pollMs = deps.pollMs ?? RESUME_POLL_MS;
  const sleep = deps.sleep ?? abortableSleep;

  return async (input: PlanSegmentResumeInput, ctx: PortContext): Promise<PlanSegmentResumeResult> => {
    if (input?.schemaVersion !== 1 || !input.taskId || !input.routeId || !input.previous) {
      throw new PortError('INVALID_INPUT', '判续会话：要有 taskId、routeId 和上一段', { retryable: false });
    }
    let after: Date | undefined;
    if ('startedAfter' in input.previous) {
      after = new Date(input.previous.startedAfter);
      if (Number.isNaN(after.getTime())) {
        throw new PortError(
          'INVALID_INPUT',
          `判续会话：startedAfter 认不出（${input.previous.startedAfter}）`,
          {
            retryable: false,
          },
        );
      }
    }
    const read = () =>
      'runId' in input.previous
        ? deps.getRun(input.previous.runId)
        : deps.latestManualRun(input.taskId, after as Date);
    const started = Date.now();
    let row = await read();
    while (row && row.endedAt === null && Date.now() - started < settleMs) {
      ctx.heartbeat();
      await sleep(pollMs, ctx.signal);
      row = await read();
    }
    if (!row) return { kind: 'new', reason: '库里找不到上一段' };
    if (!row.routeId) return { kind: 'new', reason: '上一段没记路由' };

    let previousSide: ResumeSide;
    try {
      const prev = await resolveSegmentRoute(deps.spawner, row.routeId);
      previousSide = { hostId: prev.route.hostId, poolId: prev.route.poolId, user: prev.user };
    } catch (error) {
      return { kind: 'new', reason: `上一段的路由现在起不了会话：${errMessage(error)}` };
    }
    let nextSide: ResumeSide;
    try {
      const next = await resolveSegmentRoute(deps.spawner, input.routeId);
      nextSide = { hostId: next.route.hostId, poolId: next.route.poolId, user: next.user };
    } catch (error) {
      return { kind: 'new', reason: `这一次的路由查不出会话用户：${errMessage(error)}` };
    }
    return resumeVerdict(
      { runId: row.id, endedAt: row.endedAt, sessionId: row.sessionId, side: previousSide },
      nextSide,
    );
  };
}

/**
 * 上一段收场了没有（segmentSettled，决定 0093）：重试、重派之前问一次，没收场就不起第二段（同一张单不并发两段）。
 * 和判续会话同一个等法：没收场最多等 settleMs；库里没有那一段 = 没起来，算收场。库读不了原样抛，不当成收场了。
 */
export function createSegmentSettled(
  deps: Pick<PlanSegmentResumeDeps, 'latestManualRun' | 'settleMs' | 'pollMs' | 'sleep'>,
) {
  const settleMs = deps.settleMs ?? RESUME_SETTLE_MS;
  const pollMs = deps.pollMs ?? RESUME_POLL_MS;
  const sleep = deps.sleep ?? abortableSleep;
  return async (input: SegmentSettledInput, ctx: PortContext): Promise<SegmentSettledResult> => {
    const after = new Date(input?.startedAfter ?? '');
    if (input?.schemaVersion !== 1 || !input.taskId || Number.isNaN(after.getTime())) {
      throw new PortError('INVALID_INPUT', '查上一段收场没有：要有 taskId 和认得出的 startedAfter', {
        retryable: false,
      });
    }
    const started = Date.now();
    let row = await deps.latestManualRun(input.taskId, after);
    while (row && row.endedAt === null && Date.now() - started < settleMs) {
      ctx.heartbeat();
      await sleep(pollMs, ctx.signal);
      row = await deps.latestManualRun(input.taskId, after);
    }
    if (!row || row.endedAt !== null) return { settled: true };
    return {
      settled: false,
      runId: row.id,
      detail: `上一段会话（${row.id}）等了 ${Math.round(settleMs / 1000)} 秒还没收场`,
    };
  };
}
