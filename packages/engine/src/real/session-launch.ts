// 起会话：startSession 是端口（停机排空的闸、三段走 runner 的分流、同一个 runId 重试不重起），launch 是 Fusion 链路真起会话
// （选路事实、续会话的方式、备树、提示词、卫生检查、起进程、开工记进库）；起来了却记不进库的会话由 abandonStarted 收掉。
// 从 sessions.ts 拆出来，函数体原样。

import { type CgroupScope, type SessionUser, type SpawnInfo, stopScope } from '@fleet-dao/adapters';
import {
  finishSessionRun,
  getSessionRun,
  latestRunOfSession,
  markSessionRunStarted,
  openSessionRun,
  recordEngineAudit,
  routeLaunchFacts,
  type SessionRunState,
  taskContext,
} from '@fleet-dao/db';
import { stoppingNote } from '../drain.ts';
import {
  type LaunchSessionInput,
  type PortContext,
  PortError,
  type SessionHandle,
  type StartSessionResult,
} from '../ports.ts';
import { hostName } from '../routing/names.ts';
import {
  type ContinueMode,
  type HostDriver,
  type HostRunSpec,
  type HostSession,
  isWiredHost,
  sessionUserOf,
  wiredHostNames,
} from './hosts.ts';
import { oomCounters } from './kill-evidence.ts';
import { isLeadKind, OUTPUT_FILES, type OutputKind, outputKindFor, stagePrompt } from './prompts.ts';
import { ENGINE_STOPPING_CODE, ORG_SWITCH_CODE } from './session-codes.ts';
import { decideContinuation, resumeStartupMs } from './session-continuation.ts';
import type { createDetached } from './session-detached.ts';
import { writeSessionMeta } from './session-io.ts';
import type { createLive, Live } from './session-live.ts';
import type { createPrepare } from './session-prepare.ts';
import type { createProgress } from './session-progress.ts';
import { otherVendor, screenForOtherVendor, VERIFY_MATERIAL, WORK_MATERIAL } from './session-screen.ts';
import type { createTree } from './session-tree.ts';
import type { SessionShared } from './session-types.ts';
import { errorText, scopeLimitsOf } from './session-util.ts';
import { launchSegment, SEGMENT_NOT_WIRED_CODE } from './sessions-segment.ts';
import { removeFileAs, worktreeChanges } from './user-git.ts';

/** 起会话要用到的、别的块造出来的函数。 */
export type LaunchParts = Pick<ReturnType<typeof createTree>, 'treeAs' | 'removeTmp'> &
  Pick<ReturnType<typeof createDetached>, 'ioDirOf' | 'metaOf' | 'removeIo'> &
  Pick<ReturnType<typeof createLive>, 'newLive'> &
  Pick<ReturnType<typeof createProgress>, 'onEvent' | 'onRateLimit'> &
  ReturnType<typeof createPrepare>;

export function createLaunch(shared: SessionShared, parts: LaunchParts) {
  const {
    deps,
    db,
    trees,
    drivers,
    clock,
    registry,
    segments,
    log,
    evidence,
    helperOpts,
    forkMax,
    spawnTimeoutMs,
  } = shared;
  const {
    treeAs,
    removeTmp,
    ioDirOf,
    metaOf,
    removeIo,
    newLive,
    onEvent,
    onRateLimit,
    prepareTree,
    relayFacts,
  } = parts;

  const resultOf = (live: Live, info: SpawnInfo): StartSessionResult => ({
    sessionId: live.sessionId,
    resumed: live.mode === 'resume' || live.mode === 'fork',
    handle: { pid: info.pid, ...(info.scope ? { scope: info.scope } : {}) },
  });

  /**
   * 接着干的方式：看这个会话上一次跑在哪（哪种执行方式、哪个账号池、哪个会话用户、哪个目录）。同一个池 --resume；
   * 换了池，原会话绑在旧组织上、直接续会被拒：能 fork 的（Claude）上下文还小就 --fork-session 续（同一个家目录，过程记录
   * 就在），不能 fork 的（cursor）、上下文大了，开新会话带接力任务书。下面几种也一律接力：上一轮的记录查不到、跑在已停用的
   * 会话用户下（过程记录在已删的家目录里）、上一轮的路由已不在（不知道是哪种执行方式、哪个池）、换了执行方式、换了目录
   * （两家的过程记录都按工作目录存：Claude 在 ~/.claude/projects/<目录>，cursor 在 ~/.cursor/chats/<目录的哈希>）、
   * 续的号不是 UUID（cursor 在报出真号之前就断了，手里只有临时号）。
   */
  async function continuation(
    resumeId: string,
    route: NonNullable<Awaited<ReturnType<typeof routeLaunchFacts>>>,
    driver: HostDriver,
    user: SessionUser,
    dir: string,
  ): Promise<{ mode: ContinueMode; prior: SessionRunState | null; why: string }> {
    const prior = await latestRunOfSession(db, resumeId);
    const before = prior ? await routeLaunchFacts(db, prior.routeId) : null;
    return { ...decideContinuation({ resumeId, prior, before, route, driver, user, dir, forkMax }), prior };
  }

  /**
   * 起会话的闸（停机排空，drain.ts）：引擎在停就不起，抛 ENGINE_STOPPING（不可重试：交回工作流，失败分流 ES1 不记账、回去选路，
   * 选路这时回「过一会儿再选」、新引擎起来再派）。过了闸先登记（和上面的判断之间没有 await：停机信号插不进来），
   * 起来了改成按会话自己的时限等，没起来就撤掉。同一个 runId 的重试（这个进程里已经起了的）不拦。
   */
  async function startSession(input: LaunchSessionInput, ctx: PortContext) {
    // 三段（对题 / 动手 / 验收）走 runner（#554-4）：起一个无头进程，登记 promise；立即返回 sessionId，
    // awaitSession 拿那个 promise 的 SegmentOutcome。不动 Fusion 的 registry / db session_runs 行 / 插头链。
    // Spawner 没接（生产）时，launchSegment 当场 SEGMENT_NOT_WIRED——同步返错，不留登记。
    if (input.brief.segment !== undefined) {
      if (!deps.segment) {
        throw new PortError(SEGMENT_NOT_WIRED_CODE, 'runner 段会话的依赖没装（deps.segment 没给）', {
          retryable: false,
        });
      }
      // 验证 buildCommand/spawner/runs upfront（launchSegment 内还会再挡一道；这里挡是登记进 segments map 之前）。
      if (deps.segment.spawner === undefined || deps.segment.buildCommand === undefined) {
        throw new PortError(
          SEGMENT_NOT_WIRED_CODE,
          'runner 段会话的生产 Spawner 还没接（#554-2 / #555 那一档）：起不了',
          { retryable: false },
        );
      }
      if (deps.segment.runs === undefined) {
        throw new PortError(SEGMENT_NOT_WIRED_CODE, 'runner 段会话没装 runs Writer（NotWired 也要装）', {
          retryable: false,
        });
      }
      // 起一个根本就没法起（形状不对）的会话时，launchSegment 同步抛——删登记，把错原样递出去。
      const pending = launchSegment(input, { db, ...deps.segment });
      segments.set(input.runId, pending);
      pending.catch(() => segments.delete(input.runId));
      return { sessionId: input.runId, resumed: false };
    }
    const known = registry.get(input.runId);
    if (known) return resultOf(known, await known.spawned);
    const stopping = deps.drain?.stopping();
    if (stopping) {
      throw new PortError(ENGINE_STOPPING_CODE, `${stoppingNote(stopping)}；这次没起会话 ${input.runId}`, {
        retryable: false,
      });
    }
    const since = clock().getTime();
    deps.drain?.track({
      runId: input.runId,
      stage: input.stage,
      taskId: input.taskId,
      phase: 'starting',
      since: new Date(since).toISOString(),
    });
    try {
      const started = await launch(input, ctx);
      const live = registry.get(input.runId);
      if (!live || live.detached) {
        // 交回的是上一个工人进程起的（看守接回或收掉它）；脱开引擎跑的会话停机不碰它、新引擎接回：排空都不用等
        deps.drain?.settle(input.runId);
        return started;
      }
      deps.drain?.track({
        runId: input.runId,
        stage: input.stage,
        taskId: input.taskId,
        phase: 'running',
        since: new Date(live.startedAt).toISOString(),
      });
      // 进程收场时没有看守挂着（看守被取消、工作流收尾只叫了停）：没人会交回它了，不再等它
      void live.cleaned.then(() => {
        if (live.awaiting === 0) deps.drain?.settle(input.runId);
      });
      return started;
    } catch (error) {
      deps.drain?.settle(input.runId);
      throw error;
    }
  }

  async function launch(input: LaunchSessionInput, ctx: PortContext) {
    const route = await routeLaunchFacts(db, input.route.routeId);
    if (!route) {
      throw new PortError('ROUTE_NOT_FOUND', `库里没有路由 ${input.route.routeId}`, { retryable: false });
    }
    if (!isWiredHost(route.hostId)) {
      throw new PortError(
        'HOST_NOT_WIRED',
        `执行方式 ${hostName(route.hostId)}（${route.hostId}）引擎还没接上（现在接了 ${wiredHostNames()}）`,
        { retryable: false },
      );
    }
    const driver = drivers[route.hostId];
    const who = sessionUserOf(driver, route.runAsUser);
    if ('missing' in who) {
      throw new PortError('CONFIG_MISSING', `账号池 ${route.poolId} ${who.missing}，起不了会话`, {
        retryable: false,
      });
    }
    const { user } = who;
    const task = await taskContext(db, input.taskId);
    if (!task) throw new PortError('TASK_NOT_FOUND', `库里没有任务 ${input.taskId}`, { retryable: false });
    let kind: OutputKind;
    try {
      kind = outputKindFor(input.stage, input.brief);
    } catch (error) {
      throw new PortError('BAD_INPUT', errorText(error), { retryable: false });
    }
    // 资源上限先换算、先校验：不对就在登记这一行之前拒，库里不留没起也没结束的会话
    const limits = scopeLimitsOf(input.resources);
    // 交代的测试命令记进这一行，交活认它（没有每仓流程配置了，直接用仓的 test_command）
    const testCommand = task.repo.testCommand;
    let dir: string;
    if (kind === 'delivery' || isLeadKind(kind)) {
      // Fusion 的 Lead 每一步都在这张单的工作树里（续同一个会话要同一个目录；写方案、写结果就提交在分支上）
      if (!input.worktreePath) {
        throw new PortError('BAD_INPUT', `${isLeadKind(kind) ? 'Lead 的会话' : '写码会话'}没给工作树`, {
          retryable: false,
        });
      }
      dir = input.worktreePath;
    } else {
      dir = trees.scratchFor(task.repo, task.issueNumber, input.stage, input.subtaskKey);
    }
    // 会话的 TMPDIR：编号放不进目录名的在登记之前就拒（和工作树同一道校验）
    const tmpDir = trees.tmpFor(input.runId);

    const opened = await openSessionRun(db, {
      id: input.runId,
      taskId: input.taskId,
      subtaskId: input.subtaskId ?? null,
      stage: input.stage,
      routeId: route.routeId,
      whyRoute: input.whyRoute,
      branch: input.brief.branch ?? null,
      queuedAt: new Date(input.queuedAt),
      workflowId: null,
      runAsUser: user,
      worktreePath: dir,
      testCommand,
    });
    const existing = opened.run;
    if (existing.stopRequested) {
      throw new PortError(
        'SESSION_STOPPED',
        `会话 ${input.runId} 已经叫停（${existing.stopRequested.reason}），不再起`,
        {
          retryable: false,
        },
      );
    }
    if (existing.endedAt) {
      throw new PortError('SESSION_ENDED', `会话 ${input.runId} 已经结束过，不再起`, { retryable: false });
    }
    if (existing.startedAt && existing.sessionId) {
      // 上一个工人进程起过、没等到回话就没了：原样交回，看守接不上会按 SESSION_LOST 收掉它、续会话重起。
      return {
        sessionId: existing.sessionId,
        resumed: Boolean(input.resumeSessionId),
        ...(existing.handle ? { handle: existing.handle } : {}),
      };
    }

    const { mode, prior, why } = input.resumeSessionId
      ? await continuation(input.resumeSessionId, route, driver, user, dir)
      : { mode: 'new' as const, prior: null, why: '' };
    // 切号停下的会话接着干（#59）：怎么续的进操作记录（驾驶舱看得到切号那一刻手上的活去哪了）；记不上不挡起会话
    if (prior?.failureCode === ORG_SWITCH_CODE) {
      await recordEngineAudit(db, {
        action: 'session-org.resume',
        target: `session-run:${input.runId}`,
        actorId: 'engine:sessions',
        before: { runId: prior.id, routeId: prior.routeId },
        after: { routeId: route.routeId, poolId: route.poolId, mode },
        reason:
          mode === 'fork'
            ? `切号停下的会话在 ${route.poolId} 上 fork 续上`
            : mode === 'resume'
              ? `切号停下的会话在同一个池 ${route.poolId} 上续上（切号没成，或又切回来了）`
              : `切号停下的会话续不上原会话，在 ${route.poolId} 上开新会话带接力任务书：${why}`,
        ok: true,
      }).catch((error: unknown) =>
        log('切号后续会话的操作记录没写进库', { runId: input.runId, error: errorText(error) }),
      );
    }
    // 这次的会话号：续会话就是原来那个；开新会话、fork 由驱动给——Claude 的号我们定，cursor 的先给临时号、真号 init 帧里报，
    // grok 的号我们定、但它真开了会话才交回工作流（hosts.ts 的 grokReport）。
    const fresh = driver.newSessionId(input.runId);
    let sessionId: string;
    let session: HostSession;
    if (mode === 'resume' && input.resumeSessionId) {
      sessionId = input.resumeSessionId;
      session = { mode: 'resume', id: sessionId };
    } else if (mode === 'fork' && input.resumeSessionId) {
      sessionId = fresh.id;
      session = { mode: 'fork', from: input.resumeSessionId, id: sessionId };
    } else {
      sessionId = fresh.id;
      session = { mode: 'new', id: sessionId };
    }
    const agentSessionId = session.mode === 'resume' || fresh.known ? sessionId : undefined;
    await prepareTree(input, task, kind, dir, user, mode, ctx.signal);
    const t = treeAs(dir, user, `prep-${input.runId}`, ctx.signal);
    // Lead 的结论文件按这一步定名：续同一个会话时，以前同一步留下的不能当成这一轮交的，起之前先删
    if (isLeadKind(kind)) await removeFileAs(t, OUTPUT_FILES[kind][0]);
    const relay =
      mode === 'relay'
        ? await relayFacts(
            prior,
            t,
            kind,
            input.baseHead,
            task.repo.defaultBranch,
            prior?.failureMessage ? `${why}；${prior.failureMessage}` : why,
          )
        : undefined;
    // 上一个会话没提交的改动（发布停机、续不上退回别的会话时留下的）：写进提示词，让它先读再接着做
    let leftover: string[] | { error: string };
    try {
      leftover = await worktreeChanges(t);
    } catch (error) {
      leftover = { error: errorText(error) };
    }
    const prompt = stagePrompt({
      stage: input.stage,
      brief: input.brief,
      repo: task.repo,
      issueNumber: task.issueNumber,
      mode,
      previousProblem: prior?.failureMessage ?? undefined,
      relay,
      leftover,
    });
    // 发给别家的（开 PR 前验证，Fusion 按简报派给别家的副手……）：整份提示词（这次真要发的那一份，续会话、接力的也算）
    // 先过卫生检查，过不了不起会话。简报是 Lead 写的，没进过公开的地方
    if (kind === 'verify' || otherVendor(input.route.family)) {
      screenForOtherVendor(
        { owner: task.repo.owner, name: task.repo.name },
        deps.screen,
        prompt,
        hostName(route.hostId),
        kind === 'verify' ? VERIFY_MATERIAL : WORK_MATERIAL,
      );
    }

    // 登记之后再核一次叫停：叫停可能落在上面建树的那几秒里。
    const again = await getSessionRun(db, input.runId);
    if (again?.stopRequested) {
      throw new PortError('SESSION_STOPPED', `会话 ${input.runId} 已经叫停，不再起`, { retryable: false });
    }
    // 建树的这几分钟里开始排空了（要发新版本）：进程还没起，不起了——起了也做不完这一步，树留着，新引擎起来接着用
    const draining = deps.drain?.stopping();
    if (draining) {
      throw new PortError(
        ENGINE_STOPPING_CODE,
        `${stoppingNote(draining)}；树建好了，进程没起（会话 ${input.runId}）`,
        {
          retryable: false,
        },
      );
    }
    // 临时目录紧挨着起进程建：从这里起，不管起没起来、怎么收场，插头一收场就删（下面的 live.cleaned）。
    // 建不成照工作树建不成一样报 ADOPT_FAILED；同一个 runId 重试时它在就改属主（帮手的 adopt 可重入）。
    await trees.adopt(tmpDir, user);

    // 会话脱开引擎进程（deps.ioRoot）：进程一起来引擎就可能被重启，接回要的记录（meta.json）先写好
    const ioDir = ioDirOf(input.runId);
    const abort = new AbortController();
    let spawnResolve!: (info: SpawnInfo) => void;
    let spawnReject!: (error: unknown) => void;
    const spawned = new Promise<SpawnInfo>((resolve, reject) => {
      spawnResolve = resolve;
      spawnReject = reject;
    });
    spawned.catch(() => undefined);
    const live = newLive({
      runId: input.runId,
      sessionId,
      agentSessionId,
      hostId: route.hostId,
      driver,
      taskId: input.taskId,
      stage: input.stage,
      kind,
      mode,
      user,
      poolId: route.poolId,
      routeId: route.routeId,
      dir,
      baseHead: input.baseHead,
      defaultBranch: task.repo.defaultBranch,
      reviewHead: input.brief.head,
      verifyCriteria: input.brief.verify?.criteria,
      previousCost: mode === 'resume' ? (prior?.sessionCostUsd ?? null) : undefined,
      startedAt: clock().getTime(),
      spawned,
      abort,
      detached: ioDir !== undefined,
      // 起进程前读一次资源池的累计数：被信号杀掉时比涨没涨（读不成的照实带着原因，不当成 0）
      oomBefore: oomCounters(evidence),
    });
    const cgroup: CgroupScope = { id: input.runId, user, limits, ...helperOpts };
    const startupMs = resumeStartupMs(mode, prior);
    const runSpec: HostRunSpec = {
      runId: input.runId,
      user,
      cwd: dir,
      prompt,
      env: {
        base: deps.baseEnv ?? process.env,
        fleetApi: input.launch.fleetApi,
        fleetToken: input.launch.fleetToken,
        pathPrepend: input.launch.pathPrepend,
        tmpDir,
      },
      limits: {
        // 插头自己的 idle 超时管「光是没动静」；总时长比看守的限时（sessionMinutes）早一分钟到，插头先收场。
        idleMs: input.stallSeconds * 1000,
        wallClockMs: Math.max(60_000, input.sessionMinutes * 60_000 - 60_000),
        // 续会话按已有长度多等第一帧（resumeStartupMs）
        ...(startupMs === undefined ? {} : { startupMs }),
      },
      testCommands: task.repo.testCommand ? [task.repo.testCommand] : [],
      cgroup,
      model: route.upstreamModel ?? route.modelId,
      // 驾驶舱给这条路由配的思考档位（没配用 high）；驱动起会话时照它判、照它传（hosts.ts 的 applySessionEffort）
      ...(route.effort === null ? {} : { effort: route.effort }),
      session,
      // 会话用户读不到引擎的配置和机器人凭据（design 第十四节），无头会话没人批权限：放开（驱动按执行方式给参数）。
      purpose: 'work',
    };
    if (ioDir) {
      try {
        await writeSessionMeta(ioDir, metaOf(live, runSpec, await live.oomBefore));
      } catch (error) {
        // 进程还没起：和「没起来」一样收尾（记结局、删临时目录），明确报错
        const failure = new PortError(
          'IO_PREP_FAILED',
          `会话的收发目录备不好（${ioDir}）：${errorText(error)}`,
          {
            retryable: false,
          },
        );
        await removeTmp(input.runId);
        await removeIo(input.runId);
        await finishSessionRun(db, {
          id: input.runId,
          outcome: 'failed',
          endedAt: clock(),
          failureCode: failure.code,
          failureMessage: failure.message,
          routeOutcome: 'neutral',
        }).catch((e: unknown) => log('没起来的会话没记上结局', { runId: input.runId, error: errorText(e) }));
        throw failure;
      }
    }
    registry.set(input.runId, live);
    let spawnedYet = false;
    live.report = driver
      .run(runSpec, {
        signal: abort.signal,
        ...(deps.now ? { now: deps.now } : {}),
        ...(ioDir ? { io: { dir: ioDir, release: live.release.signal } } : {}),
        onEvent: (e, m) => onEvent(live, e, m),
        onRateLimit: (reading) => onRateLimit(live, reading),
        onSpawn: (info) => {
          spawnedYet = true;
          live.scopeUnit = info.scope;
          spawnResolve(info);
        },
        // cursor 开新会话：真号到了才知道。先到的算（插头续会话时对不上的号不报，直接停）。
        onSessionId: (id) => {
          live.agentSessionId ??= id;
        },
      })
      .then(
        (report) => {
          if (!spawnedYet) {
            spawnReject(
              // 不可重试：活动原地重试用的是同一个 runId，库里这一行已经记了结局，第二次只会报「已经结束过」，
              // 把起不来的真原因（reclaude 不在之类，失败分流 CF1 认它）吞掉。交回工作流，由它换新 runId 再起。
              new PortError('SPAWN_FAILED', `会话没起来：${report.facts.spawnError ?? '进程起不来'}`, {
                retryable: false,
              }),
            );
          }
          return report;
        },
        (error: unknown) => {
          spawnReject(
            new PortError('LAUNCH_FAILED', `起会话之前就被拦下了：${errorText(error)}`, { retryable: false }),
          );
          throw error;
        },
      );
    live.report.catch(() => undefined);
    const settled = () => undefined;
    live.cleaned = live.report.then(settled, settled).then(() => removeTmp(input.runId));

    let info: SpawnInfo;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      info = await Promise.race([
        spawned,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new PortError('SPAWN_TIMEOUT', `等了 ${spawnTimeoutMs / 1000} 秒进程还没起来`, {
                  retryable: false,
                }),
              ),
            spawnTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      live.stop = { kind: 'stop', reason: '没起来' };
      abort.abort();
      registry.delete(input.runId);
      await finishSessionRun(db, {
        id: input.runId,
        outcome: 'failed',
        endedAt: clock(),
        failureCode: error instanceof PortError ? error.code : 'LAUNCH_FAILED',
        failureMessage: errorText(error),
        routeOutcome: 'neutral',
      }).catch((e: unknown) => log('没起来的会话没记上结局', { runId: input.runId, error: errorText(e) }));
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const handle: SessionHandle = { pid: info.pid, ...(info.scope ? { scope: info.scope } : {}) };
    // 进程已经起来了：开工（进程号、scope）必须记进库，工人重启后才能照记录收掉它。记不上就不能当成起好了——
    // 先把这个会话停掉、scope 收掉（和上面「没起来」的收尾一样），再明确报错，不留一个库里查不到的孤儿会话。
    let marked: 'ok' | 'not_found';
    try {
      marked = await markSessionRunStarted(db, {
        id: input.runId,
        startedAt: new Date(info.startedAt),
        sessionId,
        handle,
      });
    } catch (error) {
      const stopped = await abandonStarted(live, user, '开工没记进库');
      throw new PortError(
        'SESSION_RECORD_FAILED',
        `会话 ${input.runId} 起来了，开工却没记进库（${errorText(error)}）：已经停掉${stopped}`,
        { retryable: true },
      );
    }
    if (marked === 'not_found') {
      const stopped = await abandonStarted(live, user, '库里没这一行');
      throw new PortError(
        'SESSION_RECORD_MISSING',
        `会话 ${input.runId} 起来了，库里却没这一行：进程号和 scope 记不下，工人重启后收不掉它，已经停掉${stopped}`,
        { retryable: false },
      );
    }
    return resultOf(live, info);
  }

  /**
   * 起来了、却记不进库的会话：叫停它（插头收进程），再按编号让帮手把 scope 收掉，不等插头自己收完。
   * 回一句收得怎么样（收不掉写明原因），拼进报错里。
   */
  async function abandonStarted(live: Live, user: SessionUser, reason: string): Promise<string> {
    live.stop ??= { kind: 'stop', reason };
    live.abort.abort();
    registry.delete(live.runId);
    const error = await stopScope({ id: live.runId, user, ...helperOpts });
    return error ? `，但 scope 没收掉：${error}` : '';
  }

  return { startSession };
}
