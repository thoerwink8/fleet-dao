// 「会话只交清单、引擎核了再执行」这一类一次性会话（整理待办 stage=groom、法国指挥官 stage=commander）共用的起会话那一段。
// 原来在 real/groom.ts 里，指挥官会话（#3294 第 2 片）要同一套，抽出来：选路（按用途，探一次）→ 路由查出执行方式和会话用户 →
// 备一个主线的只读检出（钉在读到的主线头）→ 生产 Spawner 起会话 → 收场删检出。
//
// 改这里之前必须知道：
// - 会话没有 GitHub 令牌：会话用户读不到引擎的凭据（design 第十四节），工作目录是主线的只读检出，单子和事实全在提示词里。
//   所有写操作都在调用方的引擎代码里（groom-plan.ts、park-triage.ts），这里压根没有写入口。
// - 登记进一次性会话的清单（oneShots.enter）：切号、发布排空都能停下它；停下的算这一次没成。
// - 模型和用量带回给调用方记账，不走 runOneShot 的记账、不占池的名额。

import { randomUUID } from 'node:crypto';
import { StopReason } from '@fleet-dao/adapters';
import { errMessage } from '@fleet-dao/shared/util';
import type { GroomSessionInput, GroomSessionOutcome } from '../jobs/groom.ts';
import type { PickRouteInput, PickRouteResult, PortContext, RouteChoice } from '../ports.ts';
import type { UserExec } from './exec.ts';
import type { GroomGitHub } from './groom.ts';
import type { OneShotSessions } from './one-shot-sessions.ts';
import { type AssignedProber, pickThenProbe, pickThenProbeStopText } from './pick-then-probe.ts';
import { hostSegmentSpawner, resolveSegmentRoute, type SegmentSpawnerDeps } from './segment-spawner.ts';
import { prepareSegmentTree } from './segment-tree.ts';
import type { WorkTrees } from './worktrees.ts';

export interface ReadOnlySessionWiring {
  gh: Pick<GroomGitHub, 'fetchMainline' | 'bundleCommits' | 'commitIdentity'>;
  trees: WorkTrees;
  exec: UserExec;
  /** 引擎自己的临时目录（bundle 落在这里）。 */
  tmpDir: string;
  spawner: SegmentSpawnerDeps;
  pickRoute: (input: PickRouteInput, ctx: PortContext) => Promise<PickRouteResult>;
  /** 派前探测（#1798 片 4）：给了就选到一条路由先探一次，探不通避开它再选，一轮最多 3 条。 */
  probe?: AssignedProber;
  sessions: OneShotSessions;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 哪一类会话：用途（选路按它）、提示里叫它什么、分支和占位编号的前缀。 */
export interface ReadOnlySessionKind {
  stage: 'groom' | 'commander';
  word: string;
}

const SPAWN_MARGIN_MS = 60_000;

export function readOnlySessionRunner(
  w: ReadOnlySessionWiring,
  kind: ReadOnlySessionKind,
): (input: GroomSessionInput) => Promise<GroomSessionOutcome> {
  const spawn = hostSegmentSpawner(w.spawner);
  const ref = (repo: GroomSessionInput['repo']) => ({ owner: repo.owner, name: repo.name });
  const { stage, word } = kind;
  return async (input) => {
    const runId = randomUUID();
    const stop = new AbortController();
    const ctx: PortContext = {
      signal: stop.signal,
      heartbeat: () => undefined,
      attempt: 1,
      lastHeartbeat: undefined,
    };
    // 1. 选路：按用途。taskId 只是个占位（没有属于任何需求的任务行，不预占池的名额）。
    //    派前探一次：探不通就避开它再选，一轮最多 3 条；3 条都不通就当这一次没成。
    const pickOnce = (avoidRouteIds: readonly string[]) =>
      w.pickRoute(
        {
          taskId: `${stage}:${runId}`,
          stage,
          avoidRouteIds: [...avoidRouteIds],
          avoidPoolIds: [],
          avoidModelIds: [],
        },
        ctx,
      );
    let route: RouteChoice;
    if (w.probe) {
      const outcome = await pickThenProbe({ pick: pickOnce, probe: w.probe });
      if (outcome.kind === 'unavailable') {
        return { ok: false, why: `选不到路由（用途 ${stage}）：${outcome.result.detail}` };
      }
      if (outcome.kind === 'exhausted') {
        return {
          ok: false,
          why: `选到的${word}路由派前探测都不通：${pickThenProbeStopText(outcome.failures)}`,
        };
      }
      route = outcome.route;
    } else {
      const got = await pickOnce([]);
      if (!got.ok) return { ok: false, why: `选不到路由（用途 ${stage}）：${got.detail}` };
      route = got.route;
    }
    // 2. 路由 → 会话用户（树要归它）
    let info: Awaited<ReturnType<typeof resolveSegmentRoute>>;
    try {
      info = await resolveSegmentRoute(w.spawner, route.routeId);
    } catch (err) {
      return { ok: false, why: errMessage(err), routeId: route.routeId };
    }
    const ticket = w.sessions.enter({ poolId: route.poolId, stage, taskId: `${stage}:${runId}` });
    ticket.attempt(runId);
    const dir = w.trees.treeFor(ref(input.repo), `fleet/${stage}-${runId.slice(0, 8)}`);
    const timeoutMs = input.timeoutMinutes * 60_000;
    let treeIdentity: Awaited<ReturnType<WorkTrees['adoptTemporary']>> | undefined;
    try {
      treeIdentity = await w.trees.adoptTemporary(dir, info.user);
      // 3. 主线的检出（钉在读到的主线头）
      await prepareSegmentTree(
        { gh: w.gh, trees: w.trees, exec: w.exec, tmpDir: w.tmpDir },
        {
          repo: { owner: input.repo.owner, name: input.repo.name, defaultBranch: input.repo.defaultBranch },
          worktreePath: dir,
          branch: `${stage}-${runId.slice(0, 8)}`,
          baseSha: input.mainHead,
          user: info.user,
          runId,
        },
        ctx,
      );
      // 4. 起会话：切号 / 排空叫停（ticket.signal）和我们自己的时限都接进去
      const timer = setTimeout(() => stop.abort(new StopReason('wall-clock', `${word}会话超时`)), timeoutMs);
      let out: Awaited<ReturnType<typeof spawn>>;
      try {
        ticket.running();
        out = await spawn({
          argv: [],
          cwd: dir,
          stdin: input.prompt,
          signal: AbortSignal.any([stop.signal, ticket.signal]),
          timeoutMs: timeoutMs + SPAWN_MARGIN_MS,
          // 生产 Spawner 只读 routeId、runId、effort；segment 在这里只是占位（不进 runs）
          input: {
            runId,
            segment: 'scope',
            modelId: route.modelId,
            routeId: route.routeId,
            prompt: input.prompt,
            cwd: dir,
          },
        });
      } finally {
        clearTimeout(timer);
      }
      const facts = out.facts;
      const usage = facts?.usage;
      const base = {
        routeId: route.routeId,
        ...(facts?.actualModel === undefined ? {} : { model: facts.actualModel }),
        ...(usage === undefined ? {} : { usage }),
        ...(facts?.costUsd === undefined ? {} : { costUsd: facts.costUsd }),
      };
      if (ticket.signal.aborted) {
        return {
          ok: false,
          why: `被切号或发布排空停下：${errMessage(ticket.signal.reason)}`,
          routeId: route.routeId,
        };
      }
      if (out.exitCode === 0) return { ok: true, answer: out.stdout, ...base };
      const why = out.killed
        ? `会话被杀（超时或被叫停）：${errMessage(stop.signal.reason ?? '原因不明')}`
        : `会话没成功收场（退出码 ${out.exitCode}）：${facts?.detail ?? out.stderr.slice(-300)}`;
      return { ok: false, why, routeId: route.routeId };
    } catch (err) {
      return { ok: false, why: errMessage(err), routeId: route.routeId };
    } finally {
      ticket.leave();
      if (treeIdentity)
        await w.trees.removeTemporary(dir, treeIdentity).catch((err: unknown) => {
          w.log('warn', `${word}会话的检出没删掉（引擎下次起来时的清理会收）`, {
            dir,
            error: errMessage(err),
          });
        });
    }
  };
}
