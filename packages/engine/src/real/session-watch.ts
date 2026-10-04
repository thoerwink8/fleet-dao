import { reapSession, type SessionUser } from '@fleet-dao/adapters';
import { finishSessionRun, getSessionRun, runProgressFacts } from '@fleet-dao/db';
import type { RunOutcome } from '@fleet-dao/shared';
import { judgeStallWithJev } from '../failure/ask.ts';
import { judgeStall } from '../failure/stall.ts';
import {
  type AwaitSessionInput,
  type PortContext,
  PortError,
  type SessionEnd,
  type SessionHandle,
} from '../ports.ts';
import type { HostReport } from './hosts.ts';
import { scopeOomKills } from './kill-evidence.ts';
import type { createDetached } from './session-detached.ts';
import type { createEnd } from './session-end.ts';
import type { Live } from './session-live.ts';
import type { createPoolHold } from './session-pool-hold.ts';
import type { createProgress } from './session-progress.ts';
import type { createReattach } from './session-reattach.ts';
import type { createTree } from './session-tree.ts';
import type { SessionShared } from './session-types.ts';
import { asSessionUser, errorText } from './session-util.ts';

const OUTCOME: Record<SessionEnd['outcome'], RunOutcome> = {
  done: 'ok',
  blocked: 'ok',
  failed: 'failed',
  stalled: 'stalled',
  stopped: 'stopped',
};

/** 看守要用到的、别的块造出来的函数。 */
export type WatchParts = Pick<ReturnType<typeof createReattach>, 'reattach'> &
  Pick<ReturnType<typeof createProgress>, 'flush'> &
  Pick<ReturnType<typeof createTree>, 'removeTmp'> &
  Pick<ReturnType<typeof createDetached>, 'removeIo'> &
  ReturnType<typeof createPoolHold> &
  ReturnType<typeof createEnd>;

export function createWatch(shared: SessionShared, parts: WatchParts) {
  const {
    deps,
    db,
    clock,
    registry,
    segments,
    log,
    evidence,
    jev,
    jevTimeout,
    stallJevEveryMs,
    tickMs,
    stallCheckMs,
    helperOpts,
  } = shared;
  const {
    reattach,
    flush,
    removeTmp,
    removeIo,
    holdOrRelease,
    costOfThisRun,
    agentIdOf,
    endOf,
    sessionEndFromSegment,
  } = parts;

  async function reapLost(runId: string, user: SessionUser | undefined, handle: SessionHandle | undefined) {
    if (!user) return '（库里没记会话用户，旧会话的 scope 没法收）';
    try {
      const r = await reapSession({
        runId,
        scope: { id: runId, user, ...helperOpts },
        ...(handle?.pid ? { rootPid: handle.pid } : {}),
      });
      if (r.error) return `（收旧会话时出错：${r.error}）`;
      if (r.leftovers === undefined) return '（旧会话收没收干净没查成）';
      if (r.leftovers > 0) return `（旧会话还剩 ${r.leftovers} 个进程没收掉）`;
      return r.found > 0 ? `（收掉了旧会话的 ${r.found} 个进程）` : '';
    } catch (error) {
      return `（收旧会话时出错：${errorText(error)}）`;
    }
  }

  /**
   * 看守每醒一次：记下这个工人手上同时在跑的别的会话有几个、读会话自己 scope 的按内存杀进程记录——进程被信号杀掉时，
   * 它的 scope 多半已经收掉了，只能靠平时读下的（kill-evidence.ts）。读不到不算错，那一项证据就是没有。
   */
  async function noteMemoryAndPeers(live: Live): Promise<void> {
    live.peersSeen = Math.max(live.peersSeen, registry.size - 1);
    if (!live.scopeUnit) return;
    const n = await scopeOomKills(evidence, live.scopeUnit);
    if (n !== undefined) live.scopeOomSeen = Math.max(live.scopeOomSeen ?? 0, n);
  }

  async function checkStall(live: Live): Promise<void> {
    let pendingAsk: { question: string; askedAt: Date } | null = null;
    try {
      pendingAsk = (await runProgressFacts(db, live.runId, { saysLimit: 1 }))?.pendingAsk ?? null;
    } catch (error) {
      log('停滞判断读不到在等的问题，这一轮不判', { runId: live.runId, error: errorText(error) });
      return;
    }
    const iso = (ms: number) => new Date(ms).toISOString();
    const facts = {
      now: clock().toISOString(),
      startedAt: iso(live.startedAt),
      lastEventAt: live.lastEventAt === null ? null : iso(live.lastEventAt),
      ...(live.lastStepAt === undefined ? {} : { lastStepAt: iso(live.lastStepAt) }),
      ...(live.lastFileAt === undefined ? {} : { lastFileChangeAt: iso(live.lastFileAt) }),
      processAlive: true,
      toolsInFlight: [...live.tools.values()].map((t) => ({ name: t.name, since: iso(t.since) })),
      ...(pendingAsk
        ? {
            waiting: {
              on: 'human' as const,
              since: pendingAsk.askedAt.toISOString(),
              detail: pendingAsk.question,
            },
          }
        : {}),
      recentTools: live.recent,
      transcriptTail: live.says.slice(-5),
    };
    // 拿不准的停滞才问 Jev（judgeStallWithJev 先照规则判一次）；同一个会话 stallJevEveryMs 内只问一次，其余照规则判。
    // Jev 只能把拿不准的判成停滞（在绕圈、死了），不能把规则判的停滞判回正常；只记不拦的题、把握不够的答案都不算数。
    const mayAsk = live.stallJevAt === undefined || Date.now() - live.stallJevAt >= stallJevEveryMs;
    const verdict = mayAsk
      ? await judgeStallWithJev(facts, {
          jev: {
            ask: (question, ctx) => {
              live.stallJevAt = Date.now();
              return jev.ask(question, ctx);
            },
          },
          ctx: {
            subject: `run:${live.runId}`,
            about: `任务 ${live.taskId} 的 ${live.stage} 阶段（会话没推进）`,
          },
          ...jevTimeout,
          ...(deps.stallPolicy ? { policy: deps.stallPolicy } : {}),
        })
      : judgeStall(facts, deps.stallPolicy);
    // 光是没动静（D5）交给插头的 idle 超时：它按真实活动（包括思考帧）计时，这里只看得到进度事件。
    const act = verdict.state === 'looping' || (verdict.state === 'dead' && verdict.rule !== 'D5');
    if (act && !live.stop) {
      live.stop = { kind: 'stall', rule: verdict.rule, basis: verdict.basis };
      live.abort.abort();
    }
  }

  async function awaitSession(input: AwaitSessionInput, ctx: PortContext) {
    // 三段（对题 / 动手 / 验收）走 runner（#554-4）：先看 segments registry；查到了等那个 promise，
    // 把 SegmentOutcome 折成 SessionEnd 交回。查不到才走 Fusion 老链路（registry / db / reattach）。
    const segPromise = segments.get(input.runId);
    if (segPromise) {
      try {
        const outcome = await segPromise;
        segments.delete(input.runId);
        return sessionEndFromSegment(outcome, input);
      } catch (error) {
        segments.delete(input.runId);
        throw error;
      }
    }
    let live = registry.get(input.runId);
    let whyLost = '引擎工人重启过，输出管道断了';
    if (!live) {
      // 工人重启过：会话脱开引擎跑的（走文件），照收发目录接回；接不回再按下面收掉它
      const back = await reattach(input);
      if ('lost' in back) whyLost = back.lost;
      else live = back.live;
    }
    if (!live || live.sessionId !== input.sessionId) {
      // 接不上：按记下的 scope 收掉旧会话，交回 SESSION_LOST，工作流续会话重起。
      const stored = await getSessionRun(db, input.runId);
      const user = asSessionUser(stored?.runAsUser);
      const handle = input.handle ?? stored?.handle ?? undefined;
      const reaped = await reapLost(input.runId, user, handle);
      // 旧会话的临时目录跟着删：续会话是新的 runId、新的临时目录，这一个没人再用
      await removeTmp(input.runId);
      const message = `接不上会话 ${input.sessionId}：${whyLost}${reaped}`;
      await removeIo(input.runId);
      if (stored && !stored.endedAt) {
        await finishSessionRun(db, {
          id: input.runId,
          outcome: 'failed',
          endedAt: clock(),
          failureCode: 'SESSION_LOST',
          failureMessage: message,
          routeOutcome: 'neutral',
        });
      }
      return {
        sessionId: input.sessionId,
        outcome: 'failed' as const,
        failure: {
          code: 'SESSION_LOST',
          message,
          retryable: true,
          machine: deps.machine,
          ...(user ? { runAsUser: user } : {}),
        },
      };
    }

    live.awaiting += 1;
    let settled = false;
    try {
      return await watchLive(live, ctx, () => {
        settled = true;
      });
    } finally {
      live.awaiting -= 1;
      // 交回了：停机不用再等它。看守被取消（会话还在跑）的不撤：停机照它自己的时限等，收场时起会话那头撤
      if (settled) deps.drain?.settle(live.runId);
    }
  }

  /** 看守挂着的那一段：等进程收场、心跳、写进度、判停滞，收场后判结局、写库、交回。onSettled 在进程收场时叫。 */
  async function watchLive(live: Live, ctx: PortContext, onSettled: () => void): Promise<SessionEnd> {
    let nextStall = Date.now() + stallCheckMs;
    let settled = false;
    const ended = live.report.then(
      () => {
        settled = true;
        onSettled();
      },
      () => {
        settled = true;
        onSettled();
      },
    );
    while (!settled) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        ended,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, tickMs);
        }),
      ]);
      clearTimeout(timer);
      if (settled) break;
      if (ctx.signal.aborted) {
        // 活动被取消（工作流叫停）：会话由工作流收尾时按 runId 停，这里不替它做主。
        throw ctx.signal.reason ?? new Error('看守被取消');
      }
      ctx.heartbeat({ runId: live.runId, sessionId: live.sessionId });
      await flush(live);
      await noteMemoryAndPeers(live);
      if (Date.now() >= nextStall) {
        nextStall = Date.now() + stallCheckMs;
        try {
          await checkStall(live);
        } catch (error) {
          log('停滞判断出错（这一轮不判）', { runId: live.runId, error: errorText(error) });
        }
      }
    }

    clearTimeout(live.flushTimer);
    live.flushTimer = undefined;
    await flush(live);
    let end: SessionEnd;
    let report: HostReport | undefined;
    try {
      report = await live.report;
      end = await endOf(live, report);
    } catch (error) {
      end = {
        sessionId: agentIdOf(live, report),
        outcome: 'failed',
        failure: {
          code: error instanceof PortError ? error.code : 'LAUNCH_FAILED',
          message: errorText(error),
          machine: deps.machine,
          runAsUser: live.user,
        },
      };
    }
    registry.delete(live.runId);
    // 插头已经收场：临时目录删完再交回（不会失败，删不掉只记日志）
    await live.cleaned;
    await removeIo(live.runId);
    const { routeOutcome, jev: asked } = await holdOrRelease(live, end);
    // 问过 Jev 的（规则认不出的失败）：回答随结局交给工作流，工作流的失败分流带着它判，不在工作流里再问。
    if (asked && end.failure) end = { ...end, failure: { ...end.failure, jev: asked } };
    const cost = costOfThisRun(live, end.sessionCostUsd);
    const contextTokens = report?.contextTokens;
    const actualModel = report?.actualModel;
    try {
      await finishSessionRun(db, {
        id: live.runId,
        outcome: OUTCOME[end.outcome],
        endedAt: clock(),
        // 执行体真用的号（cursor 开新会话是 init 帧里的真号，下次 latestRunOfSession(真号) 查得到）；没报出来就不改，
        // 库里留着开工时记的临时号（接不上时工作流拿它来续，照它找得到这一轮、开新会话带接力任务书）。
        ...(end.sessionId ? { sessionId: end.sessionId } : {}),
        ...(actualModel ? { actualModel } : {}),
        ...(end.usage?.inputTokens === undefined ? {} : { inputTokens: end.usage.inputTokens }),
        ...(end.usage?.outputTokens === undefined ? {} : { outputTokens: end.usage.outputTokens }),
        // 缓存读写折额度当量要用（#216）：终帧没报的不给，库里留空（没读到），不记 0
        ...(end.usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: end.usage.cacheReadTokens }),
        ...(end.usage?.cacheWriteTokens === undefined
          ? {}
          : { cacheWriteTokens: end.usage.cacheWriteTokens }),
        ...(cost === undefined ? {} : { costUsd: cost }),
        ...(end.sessionCostUsd === undefined ? {} : { sessionCostUsd: end.sessionCostUsd }),
        ...(end.failure ? { failureCode: end.failure.code, failureMessage: end.failure.message } : {}),
        routeOutcome,
        ...(contextTokens === undefined ? {} : { contextTokens }),
      });
    } catch (error) {
      log('会话结局没写进库（工作流记计时时会再写一次）', { runId: live.runId, error: errorText(error) });
    }
    if (live.quotaError) log('会话里读到的额度没记上', { poolId: live.poolId, error: live.quotaError });
    return end;
  }

  return { awaitSession };
}
