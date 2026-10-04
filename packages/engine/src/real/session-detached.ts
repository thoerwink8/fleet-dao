// 脱开引擎进程跑的会话的收发目录：路径（ioDirOf）、接回记录 meta（metaOf）、删（removeIo）和工人起来时清（sweepIo）、
// 上一个工人起的会话还接不接得回（keepForReattach）、引擎不在时跑完的会话（finishedWhileAway）。session-io.ts 管文件格式，
// 这里管什么时候建、什么时候删、哪些留着。从 sessions.ts 拆出来，函数体原样。

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getSessionRun } from '@fleet-dao/db';
import type { HostRunSpec } from './hosts.ts';
import type { OomCounters } from './kill-evidence.ts';
import { REATTACH_MARGIN_MS } from './session-codes.ts';
import { readSessionMeta, type SessionMeta } from './session-io.ts';
import type { Live } from './session-live.ts';
import type { SessionShared } from './session-types.ts';
import { errorText } from './session-util.ts';

const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

export function createDetached(shared: SessionShared) {
  const { deps, db, clock, registry, log } = shared;

  /** 这个会话的收发目录；没配根（走管道）、编号不像 scope 编号都是 undefined。 */
  const ioDirOf = (runId: string): string | undefined =>
    deps.ioRoot && SCOPE_ID.test(runId) ? join(deps.ioRoot, runId) : undefined;

  function metaOf(live: Live, spec: HostRunSpec, oomBefore: OomCounters): SessionMeta {
    return {
      v: 1,
      runId: live.runId,
      sessionId: live.sessionId,
      agentSessionId: live.agentSessionId ?? null,
      hostId: live.hostId,
      taskId: live.taskId,
      stage: live.stage,
      kind: live.kind,
      mode: live.mode,
      user: live.user,
      poolId: live.poolId,
      routeId: live.routeId,
      dir: live.dir,
      baseHead: live.baseHead ?? null,
      defaultBranch: live.defaultBranch,
      reviewHead: live.reviewHead ?? null,
      verifyCriteria: live.verifyCriteria ?? null,
      ...(live.previousCost === undefined ? {} : { previousCost: live.previousCost }),
      startedAt: live.startedAt,
      oomBefore,
      limits: spec.limits,
      testCommands: [...spec.testCommands],
      cgroupLimits: spec.cgroup.limits ?? null,
      model: spec.model,
      session: spec.session,
      purpose: spec.purpose,
    };
  }

  /** 删收发目录。不抛：删不掉记日志，工人下次起来时 sweepIo 再清。 */
  async function removeIo(runId: string): Promise<void> {
    const dir = ioDirOf(runId);
    if (!dir) return;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      log('会话的收发目录没删掉（工人下次起来时再清）', { runId, dir, error: errorText(error) });
    }
  }

  /** 工人起来时：收发目录里既不在这个进程手上、也不留着接回的，删掉。列不出、删不掉只记日志。 */
  async function sweepIo(keep: ReadonlySet<string>): Promise<void> {
    if (!deps.ioRoot) return;
    let names: string[];
    try {
      names = await readdir(deps.ioRoot);
    } catch (error) {
      log('上一轮会话留下的收发目录没清成：列不出来', { dir: deps.ioRoot, error: errorText(error) });
      return;
    }
    for (const name of names) {
      if (registry.has(name) || keep.has(name)) continue;
      try {
        await rm(join(deps.ioRoot, name), { recursive: true, force: true });
      } catch (error) {
        log('上一轮会话留下的收发目录没删掉（下次起来再清）', { name, error: errorText(error) });
      }
    }
  }

  /**
   * 上一个工人起的这个会话接不接得回：有接回记录、库里这一轮没结束也没叫停、没过总时限加 REATTACH_MARGIN_MS。
   * 接得回回 true，接不回回原因。库读不成照抛（不能因为一次读库失败就收掉在跑的会话）。
   */
  async function keepForReattach(runId: string): Promise<true | string> {
    const dir = ioDirOf(runId);
    if (!dir) return deps.ioRoot ? `编号 ${runId} 不像会话编号` : '这个引擎没配收发目录，会话不脱开跑';
    const got = await readSessionMeta(dir);
    if ('error' in got) return got.error;
    const stored = await getSessionRun(db, runId);
    if (!stored) return '库里没这一轮';
    if (stored.endedAt) return '库里这一轮已经记了结局';
    if (stored.stopRequested) return `已经叫停（${stored.stopRequested.reason}）`;
    const deadline = got.meta.startedAt + (got.meta.limits.wallClockMs ?? 0) + REATTACH_MARGIN_MS;
    if (clock().getTime() > deadline) {
      return `过了总时限还没人接回（起于 ${new Date(got.meta.startedAt).toISOString()}）`;
    }
    return true;
  }

  /** 收发目录里有、scope 已经没了、还能接回的（keepForReattach）：引擎不在时跑完的会话。列不出记日志、当没有。 */
  async function finishedWhileAway(seen: ReadonlySet<string>): Promise<string[]> {
    if (!deps.ioRoot) return [];
    let names: string[];
    try {
      names = await readdir(deps.ioRoot);
    } catch (error) {
      log('收发目录列不出来，引擎不在时跑完的会话接不回', { dir: deps.ioRoot, error: errorText(error) });
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      if (seen.has(name) || registry.has(name)) continue;
      const why = await keepForReattach(name);
      if (why === true) out.push(name);
    }
    return out;
  }

  return { ioDirOf, metaOf, removeIo, sweepIo, keepForReattach, finishedWhileAway };
}
