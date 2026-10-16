// 驾驶舱「提需求」的指挥官会话（jobs/intake-chat.ts，#2061）的真装配。
//
// 改这里之前必须知道：
// - 会话怎么起：沿用临时指挥官整理（real/groom.ts）那条路——选路按用途 intake-chat（路由两层的用途 → 模型 → 路由；Fable 只有
//   创始人本人配进这个用途才选得到，决定 0033）→ 路由查出执行方式和会话用户（resolveSegmentRoute）→ 主线的只读检出
//   （prepareSegmentTree，钉在读到的主线头）→ 生产 Spawner 起会话。会话没有 GitHub 令牌（Spawner 只抄白名单里的环境、
//   不发 fleet 通行证）：开单、评论都由后端和引擎做。
// - 登记进一次性会话清单（oneShots.enter）：切号、发布排空都能停下它；停下的写「指挥官暂停了：被切号或发布排空停下」。
// - 多轮：会话活着（检出还在、路由没换）就 --resume 续同一个会话，只喂新消息；路由换了、检出没了就删掉旧检出、按存档重起。
//   选了模型的需求只派那个模型（PickRouteInput.models），续会话时黏在原路由上（stickRouteId）。
// - 别家挑错：一次性会话，避开指挥官那一族，自己的检出用完就删，不碰指挥官的会话。
// - 模型和用量不走 runOneShot 的记账（和 groom 一样，不占池的名额）。过程记录要外键，Spawner 补一行没有 route_id 的锚点。
//   失败一律交回原因，不抛。

import { randomUUID } from 'node:crypto';
import { StopReason } from '@fleet-dao/adapters';
import {
  type ChatSessionAfter,
  claimRequestChat,
  type Db,
  failRequestChat,
  finishCommanderReply,
  finishRequestReview,
  forgetRequestChatSession,
  idleRequestChats,
  modelFamilies,
  recoverRunningRequestChats,
  requestChatStopRequested,
  writeRequestChatProgress,
} from '@fleet-dao/db';
import { INTAKE_CHAT_PURPOSE, type IntakeChatLimits } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import {
  type IntakeChatDeps,
  type IntakeSessionInput,
  type IntakeSessionOutcome,
  progressOf,
} from '../jobs/intake-chat.ts';
import type { PickRouteInput, PickRouteResult, PortContext } from '../ports.ts';
import type { OneShotSpawner } from '../runner/one-shot.ts';
import type { UserExec } from './exec.ts';
import { type MirrorGitHub, mapped } from './mirror.ts';
import type { OneShotSessions } from './one-shot-sessions.ts';
import { hostSegmentSpawner, resolveSegmentRoute, type SegmentSpawnerDeps } from './segment-spawner.ts';
import { prepareSegmentTree } from './segment-tree.ts';
import type { Identity } from './user-git.ts';
import type { WorkTrees } from './worktrees.ts';

export type IntakeChatGitHub = MirrorGitHub & {
  commitIdentity(repo: { owner: string; name: string }): Promise<Identity>;
};

export interface IntakeChatWiring {
  db: Db;
  gh: IntakeChatGitHub;
  trees: Pick<WorkTrees, 'treeFor' | 'remove' | 'ownerOf' | 'adopt'>;
  exec: UserExec;
  tmpDir: string;
  /** 生产 Spawner 的装配（和动手、验收、整理同一份）：路由查询和起会话都用它。 */
  spawner: SegmentSpawnerDeps;
  /** 起会话的那一下：不给就用 hostSegmentSpawner(spawner)。测试换假会话。 */
  spawn?: OneShotSpawner;
  pickRoute: (input: PickRouteInput, ctx: PortContext) => Promise<PickRouteResult>;
  sessions: OneShotSessions;
  /** 模型 → 族（挑错避开指挥官那一族）。不给就查库的 models 表。 */
  familyOf?: (modelIds: string[]) => Promise<string[]>;
  limits?: IntakeChatLimits;
  now?: () => Date;
  log?: IntakeChatDeps['log'];
}

const SPAWN_MARGIN_MS = 60_000;
const EMPTY: ChatSessionAfter = { sessionId: null, routeId: null, modelId: null, workdir: null };

/** 一轮会话：选路 → 检出（续或重起）→ 登记 → 起会话。 */
export function intakeChatSession(
  w: IntakeChatWiring,
): (input: IntakeSessionInput) => Promise<IntakeSessionOutcome> {
  const log =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const familyOf = w.familyOf ?? ((ids: string[]) => modelFamilies(w.db, ids));
  const spawn = w.spawn ?? hostSegmentSpawner(w.spawner);
  const removeQuietly = async (dir: string) => {
    await w.trees.remove(dir).catch((err: unknown) => {
      log('warn', '指挥官会话的检出没删掉（引擎下次起来时的清理会收）', { dir, error: errMessage(err) });
    });
  };

  return async (input) => {
    const runId = randomUUID();
    const ctx: PortContext = {
      signal: input.signal,
      heartbeat: () => undefined,
      attempt: 1,
      lastHeartbeat: undefined,
    };
    const keep = input.resume
      ? {
          sessionId: input.resume.sessionId,
          routeId: input.resume.routeId,
          modelId: null,
          workdir: input.resume.workdir,
        }
      : EMPTY;
    // 1. 选路：用途 intake-chat；选了模型只派那个；续会话黏在原路由上；挑错避开指挥官那一族
    let avoidFamilies: string[] = [];
    if (input.avoidModelIds.length > 0) {
      try {
        avoidFamilies = await familyOf(input.avoidModelIds);
      } catch (err) {
        return {
          ok: false,
          why: `指挥官用的模型是哪一族没查成，挑不了「别家」：${errMessage(err)}`,
          session: keep,
        };
      }
    }
    const got = await w.pickRoute(
      {
        taskId: `intake-chat:${input.requestId}`,
        stage: INTAKE_CHAT_PURPOSE,
        avoidRouteIds: [],
        avoidPoolIds: [],
        avoidModelIds: [],
        ...(input.modelId ? { models: [input.modelId] } : {}),
        ...(input.resume ? { stickRouteId: input.resume.routeId } : {}),
        ...(avoidFamilies.length > 0 ? { avoidFamilies } : {}),
      },
      ctx,
    );
    if (!got.ok) return { ok: false, why: `选不到路由（用途 intake-chat）：${got.detail}`, session: keep };
    const route = got.route;
    let info: Awaited<ReturnType<typeof resolveSegmentRoute>>;
    try {
      info = await resolveSegmentRoute(w.spawner, route.routeId);
    } catch (err) {
      return { ok: false, why: errMessage(err), session: keep };
    }
    // 2. 续还是重起：路由没换、检出还在才续；不然删掉旧检出、按存档重起
    let resume = input.resume;
    if (resume && (resume.routeId !== route.routeId || (await w.trees.ownerOf(resume.workdir)) === null)) {
      await removeQuietly(resume.workdir);
      resume = null;
    }
    const review = input.kind === 'review';
    const dir = resume
      ? resume.workdir
      : w.trees.treeFor(input.repo, `fleet/intake-${input.seq}-${runId.slice(0, 8)}`);
    const ticket = w.sessions.enter({
      poolId: route.poolId,
      stage: INTAKE_CHAT_PURPOSE,
      taskId: `intake-chat:${input.requestId}`,
    });
    ticket.attempt(runId);
    let keepDir = false;
    try {
      if (!resume) {
        const main = await mapped(() =>
          w.gh.fetchMainline({ repo: { owner: input.repo.owner, name: input.repo.name } }),
        );
        await prepareSegmentTree(
          { gh: w.gh, trees: w.trees, exec: w.exec, tmpDir: w.tmpDir },
          {
            repo: input.repo,
            worktreePath: dir,
            branch: `intake-${input.seq}-${runId.slice(0, 8)}`,
            baseSha: main.head,
            user: info.user,
            runId,
          },
          ctx,
        );
      }
      const timeoutMs = input.timeoutMinutes * 60_000;
      const timer = new AbortController();
      const clock = setTimeout(
        () => timer.abort(new StopReason('wall-clock', `${input.timeoutMinutes} 分钟没回完`)),
        timeoutMs,
      );
      const stream = { text: '' };
      let out: Awaited<ReturnType<OneShotSpawner>>;
      try {
        ticket.running();
        input.onProgress({ phase: 'thinking', text: '' });
        out = await spawn({
          argv: [],
          cwd: dir,
          stdin: resume ? (input.prompt.resume ?? input.prompt.fresh) : input.prompt.fresh,
          signal: AbortSignal.any([input.signal, ticket.signal, timer.signal]),
          timeoutMs: timeoutMs + SPAWN_MARGIN_MS,
          input: {
            runId,
            segment: 'scope',
            modelId: route.modelId,
            routeId: route.routeId,
            prompt: input.prompt.fresh,
            cwd: dir,
          },
          ...(resume ? { resumeSessionId: resume.sessionId } : {}),
          onTranscript: (entry) => {
            if (review) return;
            const p = progressOf(stream, entry);
            if (p) input.onProgress(p);
          },
        });
      } finally {
        clearTimeout(clock);
      }
      const sessionId = out.facts?.sessionId ?? resume?.sessionId ?? null;
      const alive: ChatSessionAfter = review
        ? EMPTY
        : { sessionId, routeId: route.routeId, modelId: route.modelId, workdir: dir };
      if (input.signal.aborted) {
        keepDir = !review && sessionId !== null;
        return { ok: false, why: '有人点了停下', stoppedByHuman: true, session: keepDir ? alive : EMPTY };
      }
      if (ticket.signal.aborted) {
        return {
          ok: false,
          why: `被切号或发布排空停下：${errMessage(ticket.signal.reason)}`,
          session: EMPTY,
        };
      }
      if (out.exitCode !== 0) {
        const why = out.killed
          ? `会话被杀（${errMessage(timer.signal.reason ?? '超时或被叫停')}）`
          : `会话没成功收场（退出码 ${out.exitCode}）：${out.facts?.detail ?? out.stderr.slice(-300)}`;
        return { ok: false, why, session: EMPTY };
      }
      keepDir = !review && sessionId !== null;
      return { ok: true, text: out.stdout, session: keepDir ? alive : EMPTY, modelId: route.modelId };
    } catch (err) {
      return { ok: false, why: `起会话没成：${errMessage(err)}`, session: EMPTY };
    } finally {
      ticket.leave();
      if (!keepDir) await removeQuietly(dir);
    }
  };
}

/** 给 EngineJobs.intakeChat 用的工厂：每一眼现装。 */
export function intakeChatJob(w: IntakeChatWiring): () => IntakeChatDeps {
  const now = w.now ?? (() => new Date());
  const log: IntakeChatDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const runSession = intakeChatSession({ ...w, log });
  return () => ({
    claim: () => claimRequestChat(w.db, now()),
    progress: (requestId, p) => writeRequestChatProgress(w.db, requestId, p, now()),
    stopRequested: (requestId) => requestChatStopRequested(w.db, requestId),
    runSession,
    finishReply: async (i) => {
      await finishCommanderReply(w.db, { ...i, now: now() });
    },
    finishReview: async (i) => {
      await finishRequestReview(w.db, { ...i, now: now() });
    },
    fail: (i) => failRequestChat(w.db, { ...i, now: now() }),
    idle: (cutoff) => idleRequestChats(w.db, cutoff),
    removeDir: async (dir) => {
      await w.trees.remove(dir);
    },
    forget: (i) => forgetRequestChatSession(w.db, { ...i, now: now() }),
    recover: () => recoverRunningRequestChats(w.db, now()),
    ...(w.limits ? { limits: w.limits } : {}),
    now,
    log,
  });
}
