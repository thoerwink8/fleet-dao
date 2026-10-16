// 工人起来、接活之前收上一轮引擎留下的东西：还在册的会话 scope、会话的临时目录、runs 里还开着的一次性会话那几行、
// 选路预占着的名额。只在 worker.ts 的 createEngineWorker 里调一次（真端口才有）。
//
// 改这里之前必须知道：
// - 放手的 Mirasim 会话（#2815）没有本机 scope：到了 TTL 没人接回，凭交接单（mirasim.json）给服务端发 stop，再收临时目录、
//   交接目录、runs 那一行；刚放手的和命令行那几家一样不碰。
// - 走管道的一次性会话（验收、整理）上一轮引擎一退就断了：scope 要收、临时目录要清、库里没收场的 runs 行要收成
//   没跑完——不收，切号就一直以为它们在跑、一直等（#157）；预占的名额不清，选路就一直当池占着（#757）。
//   所以这几步只能在接活之前跑：这时进程里没有任何会话，清的时候不会碰到这一轮刚起的。
// - 脱开引擎跑的动手会话（#2238，session-handoff.ts）：上一个引擎走时放了手、收发目录里有放手标记、还没过 HANDOFF_TTL_MS 的，
//   scope、临时目录、runs 那一行都不碰——工作流马上会带 attach 来接回。没有标记的收发目录（收过场、或者被叫停的）删掉。
//   到了 TTL 还带着标记的（没人来接：单子在引擎不在时被放弃了之类）由起来后的那一次延迟清扫照孤儿收掉。
// - 列不出 scope 要明确报错，不当成一个都没有（照旧让工人起不来，比悄悄留着孤儿好）；临时目录列不出、删不掉只记日志，
//   不挡工人接活（留着的只占盘，下次起来再清）。

import { listAgentScopes, SESSION_USERS, stopScope } from '@fleet-dao/adapters';
import { clearReservations, closeOpenRuns, type Db, resolveAlertWithReason } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import {
  awaitingAttach,
  HANDOFF_TTL_MS,
  type IoEntry,
  listIo,
  type MirasimHandle,
  removeIo,
} from './session-handoff.ts';
import type { WorkTrees } from './worktrees.ts';

/** 工人起来时收掉上一轮引擎留下、还开着的 runs 行（#157）写的原因。 */
export const ORPHAN_RUN_REASON =
  '引擎重启时这一段还没收场：会话走管道跑，上一轮引擎一退它就断了（新引擎起来时收掉了它的 scope），按没跑完收掉';

/** 放手的会话过了时限没人接回、照孤儿收掉时 runs 那一行写的原因。 */
export const UNCLAIMED_RUN_REASON =
  '引擎重启时这一段脱开引擎接着跑，放手以后过了时限没人接回（单子多半在引擎不在时被放弃了），照孤儿收掉';

/** 已退役的提醒编号（原来 session-io.ts 的 IO_ROOT_ALERT_KEY）。 */
export const RETIRED_IO_ROOT_ALERT_KEY = 'engine-session-io';

export interface OrphanReapDeps {
  db: Db;
  /** 会话临时目录的管理（real/worktrees.ts）：只用列、删这两样。 */
  trees: Pick<WorkTrees, 'listTmp' | 'remove' | 'tmpFor'>;
  /** 动手会话的收发目录的根（#2238，session-handoff.ts）。不给 = 不认放手标记，scope 一律收（测试、开发机）。 */
  ioRoot?: string;
  /** 放手以后等人接回多久（默认 HANDOFF_TTL_MS）。 */
  handoffTtlMs?: number;
  /**
   * 给服务端的 Mirasim 会话发 stop、等它翻终态（#2815，adapters 的 stopMirasimSession）。放手的 Mirasim 会话没有本机 scope，
   * 过了时限没人接回时靠它收。不给 = 只收本机的东西，服务端的会话留着（测试、没装 Mirasim 的开发机）。
   * 抛了或没确认只记日志，不挡收别的。
   */
  stopMirasim?: (handle: MirasimHandle) => Promise<{ confirmed: boolean; detail: string }>;
  /** 起来以后过多久清扫一次没人接回的（默认 = handoffTtlMs）；测试换掉。 */
  later?: (fn: () => void, ms: number) => void;
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

  const ttlMs = deps.handoffTtlMs ?? HANDOFF_TTL_MS;
  const later =
    deps.later ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref?.();
    });

  /** 收发目录列一遍；列不出来只记日志、当一个都没有（那就和以前一样，scope 一律收）。 */
  async function readIo(): Promise<IoEntry[]> {
    if (!deps.ioRoot) return [];
    try {
      return await listIo(deps.ioRoot);
    } catch (error) {
      log('动手会话的收发目录列不出来：放了手的会话认不出，照孤儿收', { error: errMessage(error) });
      return [];
    }
  }

  /**
   * Mirasim 的会话在服务端跑、没有本机 scope：凭交接单给服务端发 stop。不抛，没发成只记日志（本机的东西照收）。
   * 没装 stopMirasim 时服务端的会话留着，明说。
   */
  async function stopMirasimSession(handle: MirasimHandle): Promise<void> {
    if (!deps.stopMirasim) {
      log('Mirasim 会话没人接回，可这个引擎没装停 Mirasim 会话的手段：服务端的会话留着', {
        runId: handle.runId,
        sessionKey: handle.sessionKey,
      });
      return;
    }
    try {
      const stopped = await deps.stopMirasim(handle);
      log(
        stopped.confirmed
          ? `没人接回的 Mirasim 会话 ${handle.sessionKey} 已发 stop 收掉`
          : `没人接回的 Mirasim 会话 ${handle.sessionKey} 发了 stop，没看到它翻终态（停没停没查成）`,
        { runId: handle.runId, detail: stopped.detail },
      );
    } catch (error) {
      log(`没人接回的 Mirasim 会话 ${handle.sessionKey} 的 stop 没发成（服务端的会话可能还在跑）`, {
        runId: handle.runId,
        error: errMessage(error),
      });
    }
  }

  /** 到了 TTL 还没人接回的：scope、收发目录、临时目录、runs 那一行照孤儿收。不抛，收不掉的记日志。 */
  async function sweepUnclaimed(ids: readonly string[]): Promise<void> {
    const left = new Map((await readIo()).map((e) => [e.runId, e]));
    const unclaimed = ids.filter((id) => left.get(id)?.detachedAt !== undefined);
    if (unclaimed.length === 0) return;
    for (const id of unclaimed) {
      log(`脱开跑的会话 ${id} 放手后 ${Math.round(ttlMs / 60_000)} 分钟没人接回，照孤儿收掉`);
      const mirasim = left.get(id)?.mirasim;
      if (mirasim) await stopMirasimSession(mirasim);
      else {
        const error = await stopScope({ id, user: SESSION_USERS[0], ...helperOpts });
        if (error) log(`没人接回的会话 ${id} 收不掉`, { error });
      }
      const dir = left.get(id)?.dir;
      if (dir)
        await removeIo(dir).catch((e: unknown) => log('收发目录没删掉', { dir, error: errMessage(e) }));
      await trees
        .remove(trees.tmpFor(id))
        .catch((e: unknown) => log('临时目录没删掉', { id, error: errMessage(e) }));
    }
    try {
      await closeOpenRuns(db, { endedAt: clock(), reason: UNCLAIMED_RUN_REASON, only: unclaimed });
    } catch (error) {
      log('没人接回的会话那几行 runs 没收上', { error: errMessage(error) });
    }
  }

  /** 上一轮会话留下的临时目录：_tmp 下的全清掉（等人接回的除外）。列不出来、删不掉都明说没清成（记日志），不抛。回删掉了几个。 */
  async function sweepTmp(keep: ReadonlySet<string>): Promise<number> {
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
      if (keep.has(dir.split('/').pop() ?? '')) continue;
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
    const io = await readIo();
    const keep = awaitingAttach(io, clock(), ttlMs);
    let reaped = 0;
    for (const scope of listed.scopes) {
      if (scope.state === 'inactive') continue;
      if (keep.has(scope.id)) {
        log(`上一个引擎放了手的会话 ${scope.id} 还在跑，留着等工作流接回`);
        continue;
      }
      log(`上一轮留下的会话 ${scope.id} 没人会再来接，收掉`);
      // stop 只按编号收；用户只过帮手参数的校验。
      const error = await stopScope({ id: scope.id, user: SESSION_USERS[0], ...helperOpts });
      if (error) throw new Error(`收不掉上一轮留下的会话 ${scope.id}：${error}`);
      reaped += 1;
    }
    const swept = await sweepTmp(keep);
    if (swept > 0) log(`删掉上一轮会话留下的临时目录 ${swept} 个`);
    // 收发目录：等人接回的留着，别的（收过场、被叫停、过了时限的）删掉
    for (const e of io) {
      if (keep.has(e.runId)) continue;
      // Mirasim 的会话不在本机 scope 里、上面收不到：交接单还在说明它没收过场（收过场的连目录一起删了），服务端的会话
      // 可能还在跑（放手过了时限、或引擎没走完优雅停机就退了），这时发 stop
      if (e.mirasim) await stopMirasimSession(e.mirasim);
      await removeIo(e.dir).catch((error: unknown) =>
        log('上一轮会话留下的收发目录没删掉（下次起来再清）', { dir: e.dir, error: errMessage(error) }),
      );
    }
    const closed = await closeOpenRuns(db, {
      endedAt: clock(),
      reason: ORPHAN_RUN_REASON,
      except: [...keep],
    });
    if (keep.size > 0) later(() => void sweepUnclaimed([...keep]), ttlMs);
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
