// 接回：看守在新工人上重试、手上没有这个会话时，照收发目录和库里那一行把上一个工人起的会话接回（不起进程，从头重读输出，
// 库里确认过的行只重建状态、不再写库）。从 sessions.ts 拆出来，函数体原样。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type CgroupScope, IO_FILES, type SpawnInfo } from '@fleet-dao/adapters';
import { getSessionRun } from '@fleet-dao/db';
import type { AwaitSessionInput } from '../ports.ts';
import type { HostRunSpec } from './hosts.ts';
import { readSessionMeta } from './session-io.ts';
import type { createLive, Live } from './session-live.ts';
import type { createProgress } from './session-progress.ts';
import type { SessionShared } from './session-types.ts';
import { errorText } from './session-util.ts';

/** 接回要用到的、别的块造出来的几个函数。 */
export interface ReattachParts {
  ioDirOf(runId: string): string | undefined;
  newLive: ReturnType<typeof createLive>['newLive'];
  onEvent: ReturnType<typeof createProgress>['onEvent'];
  onRateLimit: ReturnType<typeof createProgress>['onRateLimit'];
  removeTmp(runId: string): Promise<void>;
}
export function createReattach(shared: SessionShared, parts: ReattachParts) {
  const { deps, db, trees, drivers, helperOpts, registry, log } = shared;
  const { ioDirOf, newLive, onEvent, onRateLimit, removeTmp } = parts;

  /**
   * 看守在新工人上重试、手上没有这个会话：照收发目录和库里那一行接回（不起进程，从头重读输出：库里确认过的行只重建状态、
   * 不再写库；之后的照常处理）。会话已经跑完了也一样接回：读到外壳写的退出码就收场、判结局。接不回回原因。
   */
  async function reattach(input: AwaitSessionInput): Promise<{ live: Live } | { lost: string }> {
    const dir = ioDirOf(input.runId);
    if (!dir) return { lost: '引擎工人重启过，输出管道断了' };
    const got = await readSessionMeta(dir);
    if ('error' in got) return { lost: `引擎工人重启过，接不回：${got.error}` };
    const m = got.meta;
    if (m.runId !== input.runId || m.sessionId !== input.sessionId) {
      return { lost: `接回记录对不上（记的是会话 ${m.sessionId}）` };
    }
    const stored = await getSessionRun(db, input.runId);
    if (!stored) return { lost: '接不回：库里没这一轮' };
    if (stored.endedAt) return { lost: '接不回：库里这一轮已经记了结局' };
    let prompt: string;
    try {
      prompt = await readFile(join(dir, IO_FILES.prompt), 'utf8');
    } catch (error) {
      return { lost: `接不回：提示词文件读不成（${errorText(error)}）` };
    }
    // 等库、读文件的这一会儿，同一个会话可能已经被别的看守接回了：用那一个
    const known = registry.get(input.runId);
    if (known) return { live: known };
    const driver = drivers[m.hostId];
    const cgroup: CgroupScope = {
      id: m.runId,
      user: m.user,
      ...(m.cgroupLimits ? { limits: m.cgroupLimits } : {}),
      ...helperOpts,
    };
    const info: SpawnInfo = {
      pid: stored.handle?.pid ?? 0,
      runId: m.runId,
      ...(stored.handle?.scope ? { scope: stored.handle.scope } : {}),
      startedAt: new Date(m.startedAt).toISOString(),
    };
    const live = newLive({
      runId: m.runId,
      sessionId: m.sessionId,
      agentSessionId: m.agentSessionId ?? undefined,
      hostId: m.hostId,
      driver,
      taskId: m.taskId,
      stage: m.stage,
      kind: m.kind,
      mode: m.mode,
      user: m.user,
      poolId: m.poolId,
      routeId: m.routeId,
      dir: m.dir,
      baseHead: m.baseHead ?? undefined,
      defaultBranch: m.defaultBranch,
      reviewHead: m.reviewHead ?? undefined,
      verifyCriteria: m.verifyCriteria ?? undefined,
      previousCost: m.previousCost,
      startedAt: m.startedAt,
      spawned: Promise.resolve(info),
      abort: new AbortController(),
      detached: true,
      oomBefore: Promise.resolve(m.oomBefore),
    });
    live.scopeUnit = info.scope;
    // 引擎不在的时候叫停了：接回就停（插头经帮手收 scope）
    if (stored.stopRequested) {
      live.stop = { kind: 'stop', reason: stored.stopRequested.reason };
      live.abort.abort();
    }
    const spec: HostRunSpec = {
      runId: m.runId,
      user: m.user,
      cwd: m.dir,
      prompt,
      // 接回不起进程：环境、通行证用不着（也没落盘）
      env: { base: {}, fleetApi: '', fleetToken: '', pathPrepend: [], tmpDir: trees.tmpFor(m.runId) },
      limits: m.limits,
      testCommands: m.testCommands,
      cgroup,
      model: m.model,
      session: m.session,
      purpose: m.purpose,
    };
    registry.set(live.runId, live);
    live.report = driver.run(spec, {
      signal: live.abort.signal,
      ...(deps.now ? { now: deps.now } : {}),
      io: { dir, attach: true, release: live.release.signal },
      replayUntil: (stored.outputSeq ?? -1) + 1,
      onEvent: (e, meta) => onEvent(live, e, meta),
      onRateLimit: (reading) => onRateLimit(live, reading),
      onSessionId: (id) => {
        live.agentSessionId ??= id;
      },
    });
    live.report.catch(() => undefined);
    const settled = () => undefined;
    live.cleaned = live.report.then(settled, settled).then(() => removeTmp(live.runId));
    log('接回了上一个引擎工人起的会话', {
      runId: live.runId,
      confirmedSeq: stored.outputSeq,
      stopRequested: Boolean(stored.stopRequested),
    });
    return { live };
  }

  return { reattach };
}
