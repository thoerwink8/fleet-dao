import { openAlertsByPrefix, resolveAlertByKey, upsertAlert } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { triageFailureAsked } from '../failure/ask.ts';
import type { JevReply } from '../failure/jev.ts';
import type { FailureVerdict, TriageChoice } from '../failure/types.ts';
import type { SessionEnd } from '../ports.ts';
import type { Live } from './session-live.ts';
import type { SessionShared } from './session-types.ts';
import { poolHoldKey } from './store-ports.ts';

export function createPoolHold(shared: SessionShared) {
  const { deps, db, clock, jev, jevTimeout, log } = shared;

  /**
   * 会话结束后：跑通了撤掉整池暂停；失败了过一遍失败分流，认出要人修的整池问题就整池暂停，并定这次算不算路由的账。
   * 规则认不出的失败在这里问 Jev（活动里问，工作流不问）：回答交回去，由 awaitSession 带给工作流的失败分流。
   */
  async function holdOrRelease(
    live: Live,
    end: SessionEnd,
  ): Promise<{ routeOutcome: 'ok' | 'fail' | 'neutral'; jev?: JevReply<TriageChoice> }> {
    if (end.outcome === 'done' || end.outcome === 'blocked') {
      // 这个池能跑通了（续会话的试探成了）：撤掉整池暂停。
      try {
        const held = await openAlertsByPrefix(db, poolHoldKey(live.poolId));
        if (held.some((a) => a.dedupeKey === poolHoldKey(live.poolId))) {
          await resolveAlertByKey(db, { dedupeKey: poolHoldKey(live.poolId), by: 'engine' });
        }
      } catch (error) {
        log('账号池的暂停没撤掉', { poolId: live.poolId, error: errMessage(error) });
      }
      return { routeOutcome: 'ok' };
    }
    if (end.outcome !== 'failed' || !end.failure) return { routeOutcome: 'neutral' };
    const f = end.failure;
    let verdict: FailureVerdict;
    let asked: JevReply<TriageChoice> | undefined;
    try {
      ({ verdict, jev: asked } = await triageFailureAsked(
        {
          source: `session:${live.stage}`,
          stage: live.stage,
          poolId: live.poolId,
          routeId: live.routeId,
          hostId: live.hostId,
          code: f.code,
          message: f.message,
          ...(f.httpStatus === undefined ? {} : { httpStatus: f.httpStatus }),
          ...(f.exitCode === undefined ? {} : { exitCode: f.exitCode }),
          ...(f.signal === undefined ? {} : { signal: f.signal }),
          ...(f.transcriptTail ? { transcriptTail: f.transcriptTail } : {}),
          ...(f.resetsAt ? { resetsAt: f.resetsAt } : {}),
          machine: deps.machine,
          runAsUser: live.user,
          now: clock().toISOString(),
        },
        {
          jev,
          ...jevTimeout,
          ctx: {
            subject: `run:${live.runId}`,
            about: `任务 ${live.taskId} 的 ${live.stage} 阶段（会话失败）`,
          },
        },
      ));
    } catch (error) {
      log('失败分流判不了这次会话（按不算路由账记）', { runId: live.runId, error: errMessage(error) });
      return { routeOutcome: 'neutral' };
    }
    const jevPart = asked ? { jev: asked } : {};
    if (verdict.shared?.scope === 'pool' && verdict.shared.until === undefined) {
      // 要人修的整池问题：所有任务一起避开这个池，等人修好（或续会话的试探跑通）。规则没写修法的登录失效（AU2 管各家的
      // 登录），修法照执行方式写：去哪台机器、以哪个会话用户重新登录哪一家。
      const fix =
        verdict.humanFix ??
        (verdict.rule === 'AU2' ? live.driver.loginFix(`「${deps.machine}」`, live.user) : undefined);
      try {
        await upsertAlert(db, {
          dedupeKey: poolHoldKey(live.poolId),
          level: 'decision',
          taskId: live.taskId,
          title: `账号池 ${live.poolId} 整池暂停：${verdict.title}`,
          body: [fix, verdict.reason].filter(Boolean).join('。'),
        });
      } catch (error) {
        log('账号池暂停没写进库（选路照样会派过去）', { poolId: live.poolId, error: errMessage(error) });
      }
    }
    return { routeOutcome: verdict.routeOutcome, ...jevPart };
  }

  return { holdOrRelease };
}
