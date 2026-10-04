// 引擎端口 → AI 会话：起会话、看守、叫停、收孤儿。按路由的执行方式分派给驱动（real/hosts.ts）：接上了 Claude Code
// （经 reclaude）和 cursor-agent，都是无头起；别的执行方式明确报 HOST_NOT_WIRED。下面只认驱动交回的同一个形状（HostReport）。
//
// 起会话：按 runId 幂等（库里 session_runs 一行；叫停过的 runId 不再起）。会话用户：Claude 按账号池定（pools.run_as_user，
// 它绑着 reclaude 组织）；Cursor 的池不绑，用法国唯一的会话用户（hosts.ts 的 sessionUserOf）。
// 会话号：Claude 的由我们定；cursor 开新会话的号是它 init 帧里自己起的，开工先记临时号（cursor-pending:<runId>），真号到了
// 记在看守上，结束时交给工作流、写进库（下次 latestRunOfSession(真号) 查得到）。
// 会话断了接着干（design 第一节、第九节、第十四节）：法国只有一个会话用户，续会话都在同一个家目录里。同一个账号池
// （同一个 reclaude 组织）--resume 续上；换了池（切号后原会话绑在旧组织上，直接续会被拒）、上下文还小
// （< forkMaxContextTokens）就 --fork-session 续（只有 Claude 能 fork）；上下文大了、cursor 换了池、上一轮跑在已停用的
// 会话用户下、换了执行方式、换了目录（会话记录按目录存）、续的号不是 UUID（cursor 的临时号），开新会话、带接力任务书
// （做到哪了、已提交了什么）。工作树由会话用户自己从引擎镜像打的 bundle 建，
// 引擎不以自己的身份在会话目录里跑 git。进程起来（onSpawn）才算开工：记进程号和 scope，交回工作流。
// 每个会话一个自己的临时目录（会话的 TMPDIR）：工作树根下的 _tmp/<runId>（worktrees.ts），不在工作树里、归会话用户。
// 会话里跑的测试往临时目录留的东西（vitest 每跑一次留一个转译缓存目录、测试没收的临时目录）都落在这里：插头收场后
// 整个删掉（正常结束、失败、被叫停、没起来都一样）；工人重启接不上的在 awaitSession / stopSession 里删；工人起来时
// reapOrphanSessions 把上一轮剩下的全清掉。删不掉不改会话的结局，只记日志、下次起来再清。
//
// 停机排空（drain.ts）：引擎在停时不起新会话（ENGINE_STOPPING）；接管道跑的会话登记着，交回工作流才撤，停机等它们做完。
// 发布不碰会话（deps.ioRoot，session-io.ts）：会话脱开引擎进程跑，输入输出、退出码走收发目录里的文件，每行输出一个序号，
// 进度事件和「确认到哪一行」同一个事务进库；停机不停、排空不等，工人停下后放手（releaseDetached），新工人收孤儿时留着
// 能接回的（keepForReattach），看守重试到新工人上时接回（reattach）：确认过的行只重放、不再写库。
// 会话被信号杀掉（没终帧、137/143）时按证据写是谁杀的（kill-evidence.ts：引擎在停、内存超限、没查到），不猜。
// 看守：进程是这个工人进程起的（registry），或者接回的。接不上（接管道跑的旧会话、接回记录没了、库里已经结束）就按记下的
// scope 收掉旧会话，回 SESSION_LOST，工作流续会话重起。过程中：心跳；进度事件攒一小批写库（fleet done 的核实要读会话自己跑过的测试，
// 所以写得要快）；额度读数顺手记账；每分钟按进展判一次停滞（failure/stall.ts），在绕圈、工具卡死就停掉，结局 stalled
// （光是没动静由插头自己的 idle 超时管）。结束后：写码类看 fleet done 和工作树（有新提交、没有没提交的已跟踪改动；
// 新提交、改了哪些文件都扣掉会话并进来的主线，user-git.ts 的 ownSpan）；
// 分诊、需求文档、方案、审查、开 PR 前验证读 .fleet-out/ 下的结论文件，形状不对算交错了（验证的用 core 的 checkReport 核）。
// 发给别家的（开 PR 前验证、Fusion 派给别家的副手）：起会话前整份提示词先过卫生检查（screenForOtherVendor），过不了不起。
// Fusion 的 Lead（brief.lead）每一步都在这张单的工作树里跑、续同一个会话，交什么按这一步定（prompts.ts 的 LEAD_KIND）：
// 结论文件写在 .fleet-out/（记进工作树的 .git/info/exclude，不会被提交；起会话前清掉上一轮留下的同名文件），写方案、
// 写结果那两步的头和改动从提交里读，其余几步只看不改（头动了、有没提交的改动都算交错了）。
// 失败原样交给工作流的失败分流（只在 stderr 里的报错原话接在失败信息后面：cursor 的认证、额度、网络报错就只有它）；
// 这里只按同一张规则表认出「要人修的整池问题」（设备被撤销、封号、登录失效、欠费）：写一条 pool-hold:<池> 的「要人拍」
// 提醒（写清去哪台机器、以哪个会话用户重新登录），选路就避开整个池；续会话的那一单是试探，跑通了就撤掉这条提醒。
// Jev（判断题）只在这个活动里问（design 第十一节「错误分流」「停滞预判」）：规则认不出的失败问一次，回答随结局交给工作流的
// 失败分流；停滞拿不准时问，同一个会话隔 stallJevEveryMs 才再问。只记不拦的题、没判出来的一律照规则走。

import { listAgentScopes, SESSION_USERS, stopScope } from '@fleet-dao/adapters';
import { clearReservations, closeOpenRuns, getSessionRun, requestSessionStop } from '@fleet-dao/db';
import { NO_JEV } from '../failure/ask.ts';
import { PortError, type StopSessionInput } from '../ports.ts';
import { type ContinueMode, hostDrivers } from './hosts.ts';
import { realKillEvidence } from './kill-evidence.ts';
import type { OrgSwitchSessions } from './org-switch.ts';
import { DEFAULT_FORK_MAX_CONTEXT_TOKENS, ORPHAN_RUN_REASON } from './session-codes.ts';
import { createDetached } from './session-detached.ts';
import { createEnd } from './session-end.ts';
import { createLaunch } from './session-launch.ts';
import { createLive, type Live } from './session-live.ts';
import { createOutput } from './session-output.ts';
import { createPoolHold } from './session-pool-hold.ts';
import { createPrepare } from './session-prepare.ts';
import { createProgress } from './session-progress.ts';
import { createReattach } from './session-reattach.ts';
import { createTree } from './session-tree.ts';
import type { SessionPorts, SessionPortsDeps, SessionShared } from './session-types.ts';
import { asSessionUser } from './session-util.ts';
import { createWatch } from './session-watch.ts';
import type { SegmentOutcome } from './sessions-segment.ts';
import { POOL_HOLD_PREFIX } from './store-ports.ts';

// 拆出去的模块里的名字，对外仍从这里导出（import 路径不变）。
export {
  DEFAULT_FORK_MAX_CONTEXT_TOKENS,
  ENGINE_STOP_CODE,
  ENGINE_STOPPING_CODE,
  ORG_SWITCH_CODE,
  ORPHAN_RUN_REASON,
  REATTACH_MARGIN_MS,
  RESUME_STARTUP_MAX_MS,
  RESUME_STARTUP_RUN_MS_PER_MINUTE,
  RESUME_STARTUP_TOKENS_PER_MINUTE,
  STARTUP_BASE_MS,
} from './session-codes.ts';
export { type ContinuationFacts, decideContinuation, resumeStartupMs } from './session-continuation.ts';
export { confirmedSeq } from './session-progress.ts';
export {
  type Material,
  otherVendor,
  screenForOtherVendor,
  VERIFY_MATERIAL,
  WORK_MATERIAL,
} from './session-screen.ts';
export type { SessionPorts, SessionPortsDeps } from './session-types.ts';
export { scopeSize } from './session-util.ts';

/**
 * 切号那一刻在跑的 Fusion 会话（#59；接口定义在 real/org-switch.ts）。只管这个工人进程里起的会话：会话都由它起，工人重启时
 * 上一轮留下的已经收掉了。stop 把进程已经起来的停下（它们交回 org_switch，工作流切完续同一个会话）；还在建树、没起进程的不碰：
 * 它们一起进程就在 live 里，下一次再停。
 */
export type { ContinueMode, OrgSwitchSessions };

export function createSessionPorts(deps: SessionPortsDeps): SessionPorts {
  const { db, trees, gh } = deps;
  const clock = deps.now ?? (() => new Date());
  const drivers = hostDrivers({
    claudeCommand: deps.claudeCommand,
    cursorCommand: deps.cursorCommand,
    grokCommand: deps.grokCommand,
    mirasimConnect: deps.mirasimConnect,
    mirasimLedgerDir: deps.mirasimLedgerDir,
    mirasimLedgerFs: deps.mirasimLedgerFs,
    sessionProxy: deps.sessionProxy,
    ...(deps.run ? { run: deps.run } : {}),
  });
  const forkMax = deps.forkMaxContextTokens ?? DEFAULT_FORK_MAX_CONTEXT_TOKENS;
  const tickMs = deps.tickMs ?? 5_000;
  const stallCheckMs = deps.stallCheckMs ?? 60_000;
  const jev = deps.jev ?? NO_JEV;
  const jevTimeout = deps.jevTimeoutMs === undefined ? {} : { timeoutMs: deps.jevTimeoutMs };
  const stallJevEveryMs = deps.stallJevEveryMs ?? 10 * 60_000;
  const flushMs = deps.flushMs ?? 300;
  const spawnTimeoutMs = deps.spawnTimeoutMs ?? 120_000;
  const log = deps.log ?? ((message, fields) => console.warn(message, fields ?? {}));
  const evidence = deps.killEvidence ?? realKillEvidence();
  const helperOpts = {
    ...(deps.helper ? { helper: deps.helper } : {}),
    ...(deps.sudo ? { sudo: deps.sudo } : {}),
  };
  const registry = new Map<string, Live>();
  /**
   * 三段（对题 / 动手 / 验收）走 runner 的会话 registry（#554-4）：`brief.segment` 给定了的 startSession
   * 起的 runId 在这里；awaitSession 先查这里，查到走 runner 路径（与 Fusion 链路不交叉）。
   * 会话跑完 / 异常后从 map 里取走（runner 是 fire-and-forget，不存在重复 await 的语义）。
   */
  const segments = new Map<string, Promise<SegmentOutcome>>();
  const identities = new Map<string, Promise<{ name: string; email: string }>>();
  const shared: SessionShared = {
    deps,
    db,
    trees,
    gh,
    clock,
    drivers,
    forkMax,
    tickMs,
    stallCheckMs,
    jev,
    jevTimeout,
    stallJevEveryMs,
    flushMs,
    spawnTimeoutMs,
    log,
    evidence,
    helperOpts,
    registry,
    segments,
    identities,
  };
  const { newLive } = createLive(shared);
  const { treeAs, identityOf, removeTmp, sweepTmp } = createTree(shared);
  const { ioDirOf, metaOf, removeIo, sweepIo, keepForReattach, finishedWhileAway } = createDetached(shared);
  const { flush, onEvent, onRateLimit } = createProgress(shared);
  const { reattach } = createReattach(shared, { ioDirOf, newLive, onEvent, onRateLimit, removeTmp });
  const { prepareTree, relayFacts } = createPrepare(shared, { treeAs, identityOf });
  const { deliveryCheck, readOutput } = createOutput({ treeAs });
  const { holdOrRelease } = createPoolHold(shared);
  const { costOfThisRun, agentIdOf, endOf, sessionEndFromSegment } = createEnd(shared, {
    deliveryCheck,
    readOutput,
  });
  const { startSession } = createLaunch(shared, {
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
  });

  const { awaitSession } = createWatch(shared, {
    reattach,
    flush,
    removeTmp,
    removeIo,
    holdOrRelease,
    costOfThisRun,
    agentIdOf,
    endOf,
    sessionEndFromSegment,
  });

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

  return {
    startSession,
    awaitSession,
    stopSession,
    reapOrphanSessions,
    orgSwitch,
    drainStop,
    releaseDetached,
  };
}

/** 选路那边认的前缀，从这里也导出一份：session 端口写、store 端口读，同一个常量。 */
export { POOL_HOLD_PREFIX };
