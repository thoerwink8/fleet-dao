// 会话的叫停、收孤儿和停机：stopSession（叫停一个会话）、reapOrphanSessions（工人起来接活之前收上一轮留下的）、orgSwitch（切号停下
// 在跑的）、drainStop（排空到截止停下还接着管道的）、releaseDetached（引擎停机时放手脱开跑的）。从 sessions.ts 拆出来，函数体原样。

import { listAgentScopes, SESSION_USERS, stopScope } from '@fleet-dao/adapters';
import { clearReservations, closeOpenRuns, getSessionRun, requestSessionStop } from '@fleet-dao/db';
import { PortError, type StopSessionInput } from '../ports.ts';
import type { OrgSwitchSessions } from './org-switch.ts';
import { ORPHAN_RUN_REASON } from './session-codes.ts';
import type { createDetached } from './session-detached.ts';
import type { createTree } from './session-tree.ts';
import type { SessionPorts, SessionShared } from './session-types.ts';
import { asSessionUser } from './session-util.ts';

/** 收场要用到的、别的块造出来的函数。 */
export type LifecycleParts = Pick<ReturnType<typeof createTree>, 'removeTmp' | 'sweepTmp'> &
  Pick<ReturnType<typeof createDetached>, 'removeIo' | 'sweepIo' | 'keepForReattach' | 'finishedWhileAway'>;

export function createLifecycle(
  shared: SessionShared,
  parts: LifecycleParts,
): Pick<SessionPorts, 'stopSession' | 'reapOrphanSessions' | 'orgSwitch' | 'drainStop' | 'releaseDetached'> {
  const { db, clock, registry, log, helperOpts } = shared;
  const { removeTmp, sweepTmp, removeIo, sweepIo, keepForReattach, finishedWhileAway } = parts;

  async function stopSession(input: StopSessionInput) {
    await requestSessionStop(db, { runId: input.runId, reason: input.reason });
    const live = registry.get(input.runId);
    if (live) {
      // 优雅停（停在干净的点）还没做：一律立刻停，工作树里已提交的不会丢。
      live.stop ??= { kind: 'stop', reason: input.reason };
      live.abort.abort();
      return;
    }
    // 不在这个工人进程里（工人重启过）：按记下的 scope 收，收掉了再删它的临时目录。
    const stored = await getSessionRun(db, input.runId);
    const user = asSessionUser(stored?.runAsUser);
    if (!stored?.startedAt || !user) return;
    const error = await stopScope({ id: input.runId, user, ...helperOpts });
    if (error)
      throw new PortError('STOP_FAILED', `停会话 ${input.runId} 没成：${error}`, { retryable: true });
    await removeTmp(input.runId);
    await removeIo(input.runId);
  }

  async function reapOrphanSessions(): Promise<number> {
    const listed = await listAgentScopes(helperOpts);
    if (!listed.ok) {
      throw new Error(`查不了上一轮留下的会话（fleet-agent-scope list）：${listed.detail}`);
    }
    let reaped = 0;
    const kept: string[] = [];
    for (const scope of listed.scopes) {
      if (scope.state === 'inactive') continue;
      // 脱开引擎跑的、还能接回的留着：看守（awaitSession）重试到这个新工人上时接回，停机不碰在跑的会话
      const why = await keepForReattach(scope.id);
      if (why === true) {
        kept.push(scope.id);
        continue;
      }
      log(`上一轮留下的会话 ${scope.id} 接不回，收掉：${why}`);
      // stop 只按编号收；用户只过帮手参数的校验。
      const error = await stopScope({ id: scope.id, user: SESSION_USERS[0], ...helperOpts });
      if (error) throw new Error(`收不掉上一轮留下的会话 ${scope.id}：${error}`);
      reaped += 1;
    }
    if (kept.length > 0) log(`上一轮起的会话还在跑、留给看守接回 ${kept.length} 个：${kept.join('、')}`);
    // 引擎不在的时候跑完了的（scope 已经没了，退出码在收发目录里）：也留着，看守接回时收场、判结局
    const done = await finishedWhileAway(new Set(kept));
    if (done.length > 0)
      log(`上一轮起的会话在引擎不在时跑完了、留给看守收场 ${done.length} 个：${done.join('、')}`);
    kept.push(...done);
    // 收掉的会话的临时目录、收发目录（上一轮没来得及删的、工人被强杀时在跑的）一起清掉；留着接回的不动
    const swept = await sweepTmp(new Set(kept));
    if (swept > 0) log(`删掉上一轮会话留下的临时目录 ${swept} 个`);
    await sweepIo(new Set(kept));
    // 三段的一次性会话（runs 表）不脱开引擎进程跑、没有能接回的：上一轮引擎一退它们就断了（scope 上面收掉了），库里还开着的
    // 那几行收成没跑完——不收，切号就一直以为它们在跑、一直等（#157）。所以这一步只能在工人起来、接活之前跑
    const closed = await closeOpenRuns(db, { endedAt: clock(), reason: ORPHAN_RUN_REASON });
    if (closed.length > 0) {
      log(`上一轮引擎起的一次性会话没收场的 ${closed.length} 个，库里那几行收成没跑完：${closed.join('、')}`);
    }
    // 上一轮选路时给三段的一段预占的名额（#757）：那些段的活动跟着上一轮引擎断了，一个都起不来，不清掉选路就一直当池占着
    // （最多到预占过期）。和上面一样只能在接活之前清：清的时候不能有这一轮选路刚占的
    const dropped = await clearReservations(db);
    if (dropped.length > 0) {
      log(
        `上一轮选路时预占、还没开跑的名额 ${dropped.length} 个，清掉：${dropped.map((r) => `${r.taskId}/${r.segment}@${r.routeId}`).join('、')}`,
      );
    }
    return reaped;
  }

  const orgSwitch: OrgSwitchSessions = {
    stop(poolIds, why) {
      const stopped: string[] = [];
      for (const live of registry.values()) {
        if (!poolIds.has(live.poolId) || live.stop) continue;
        live.stop = { kind: 'org-switch', why };
        live.abort.abort();
        stopped.push(live.runId);
      }
      return stopped;
    },
    live: (poolIds) => [...registry.values()].filter((l) => poolIds.has(l.poolId)).map((l) => l.runId),
  };

  /** 脱开引擎跑的会话（detached）不停：引擎重启后接回。只停还接着管道的（这一版之前起的）。 */
  function drainStop(why: string): string[] {
    const stopped: string[] = [];
    for (const live of registry.values()) {
      if (live.stop || live.detached) continue;
      live.stop = { kind: 'engine-stop', why };
      live.abort.abort();
      stopped.push(live.runId);
    }
    return stopped;
  }

  function releaseDetached(): string[] {
    const released: string[] = [];
    for (const live of [...registry.values()]) {
      if (!live.detached) continue;
      live.release.abort();
      clearTimeout(live.flushTimer);
      live.flushTimer = undefined;
      // 没进库的进度不写了：这些行没确认，新引擎接回时从这里起照常再处理一遍
      live.pending.length = 0;
      registry.delete(live.runId);
      released.push(live.runId);
    }
    return released;
  }

  return { stopSession, reapOrphanSessions, orgSwitch, drainStop, releaseDetached };
}
