// 工人起来、接活之前收上一轮引擎留下的东西：还在册的会话 scope、会话的临时目录、runs 里还开着的一次性会话那几行、
// 选路预占着的名额。只在 worker.ts 的 createEngineWorker 里调一次（真端口才有）。
//
// 改这里之前必须知道：
// - 三段的一次性会话（动手 runSegment、验收 coldVerify）不脱开引擎进程跑，上一轮引擎一退它们就断了：scope 要收、临时目录
//   要清、库里没收场的 runs 行要收成没跑完——不收，切号就一直以为它们在跑、一直等（#157）；预占的名额不清，选路就一直当池占着（#757）。
//   所以这几步只能在接活之前跑：这时进程里没有任何会话，清的时候不会碰到这一轮刚起的。
// - 老 Fusion 会话端口（startSession / awaitSession，会话脱开引擎跑、重启后接回）已经没有调用方，整条线随 #901 删了；
//   所以这里不再留「还能接回的」：scope 在册就是上一轮的、没人会来接，一律收掉。
// - 列不出 scope 要明确报错，不当成一个都没有（照旧让工人起不来，比悄悄留着孤儿好）；临时目录列不出、删不掉只记日志，
//   不挡工人接活（留着的只占盘，下次起来再清）。

import { listAgentScopes, SESSION_USERS, stopScope } from '@fleet-dao/adapters';
import { clearReservations, closeOpenRuns, type Db, resolveAlertWithReason } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import type { WorkTrees } from './worktrees.ts';

/** 工人起来时收掉上一轮引擎留下、还开着的 runs 行（#157）写的原因。 */
export const ORPHAN_RUN_REASON =
  '引擎重启时这一段还没收场：一次性会话不脱开引擎进程跑，上一轮引擎一退它就断了（新引擎起来时收掉了它的 scope），按没跑完收掉';

/** 已退役的提醒编号（原来 session-io.ts 的 IO_ROOT_ALERT_KEY）。 */
export const RETIRED_IO_ROOT_ALERT_KEY = 'engine-session-io';

export interface OrphanReapDeps {
  db: Db;
  /** 会话临时目录的管理（real/worktrees.ts）：只用列、删这两样。 */
  trees: Pick<WorkTrees, 'listTmp' | 'remove'>;
  /** 经 sudo 调的帮手（fleet-agent-scope）；测试里换成假的。 */
  helper?: string;
  sudo?: readonly string[];
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** 回收掉了几个会话 scope。 */
export function orphanReaper(deps: OrphanReapDeps): () => Promise<number> {
  const { db, trees } = deps;
  const clock = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message, fields) => console.warn(message, fields ?? {}));
  const helperOpts = {
    ...(deps.helper ? { helper: deps.helper } : {}),
    ...(deps.sudo ? { sudo: deps.sudo } : {}),
  };

  /** 上一轮会话留下的临时目录：_tmp 下的全清掉。列不出来、删不掉都明说没清成（记日志），不抛。回删掉了几个。 */
  async function sweepTmp(): Promise<number> {
    let dirs: string[];
    try {
      dirs = await trees.listTmp();
    } catch (error) {
      log('上一轮会话留下的临时目录没清成：列不出来', { error: errMessage(error) });
      return 0;
    }
    let removed = 0;
    const failed: string[] = [];
    for (const dir of dirs) {
      try {
        if (!(await trees.remove(dir)).gone) removed += 1;
      } catch (error) {
        failed.push(`${dir}：${errMessage(error)}`);
      }
    }
    if (failed.length > 0) {
      log(`上一轮会话留下的临时目录有 ${failed.length} 个没删掉（下次起来再清）`, {
        failed: failed.slice(0, 10),
      });
    }
    return removed;
  }

  return async function reapOrphanSessions(): Promise<number> {
    const listed = await listAgentScopes(helperOpts);
    if (!listed.ok) {
      throw new Error(`查不了上一轮留下的会话（fleet-agent-scope list）：${listed.detail}`);
    }
    let reaped = 0;
    for (const scope of listed.scopes) {
      if (scope.state === 'inactive') continue;
      log(`上一轮留下的会话 ${scope.id} 没人会再来接，收掉`);
      // stop 只按编号收；用户只过帮手参数的校验。
      const error = await stopScope({ id: scope.id, user: SESSION_USERS[0], ...helperOpts });
      if (error) throw new Error(`收不掉上一轮留下的会话 ${scope.id}：${error}`);
      reaped += 1;
    }
    const swept = await sweepTmp();
    if (swept > 0) log(`删掉上一轮会话留下的临时目录 ${swept} 个`);
    const closed = await closeOpenRuns(db, { endedAt: clock(), reason: ORPHAN_RUN_REASON });
    if (closed.length > 0) {
      log(`上一轮引擎起的一次性会话没收场的 ${closed.length} 个，库里那几行收成没跑完：${closed.join('、')}`);
    }
    const dropped = await clearReservations(db);
    if (dropped.length > 0) {
      log(
        `上一轮选路时预占、还没开跑的名额 ${dropped.length} 个，清掉：${dropped.map((r) => `${r.taskId}/${r.segment}@${r.routeId}`).join('、')}`,
      );
    }
    // 「收发目录的根不能用」那条提醒（原来 real/session-io.ts 的 reportIoRoot 推、能用了自己撤）：写它的代码删了，库里要是还开着
    // 一条就没人会撤，在这里撤一次（撤过了、本来就没有都不算错；撤不成只记日志，不挡接活）
    try {
      await resolveAlertWithReason(db, {
        dedupeKey: RETIRED_IO_ROOT_ALERT_KEY,
        by: 'engine:sessions',
        why: '会话不再脱开引擎跑（老会话端口已删，#901），这条提醒作废',
        at: clock(),
      });
    } catch (error) {
      log('退役的收发目录提醒没撤掉（不挡接活）', { error: errMessage(error) });
    }
    return reaped;
  };
}
