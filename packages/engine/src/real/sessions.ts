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

import {
  judgeRun,
  listAgentScopes,
  reapSession,
  SESSION_USERS,
  type SessionUser,
  stopScope,
} from '@fleet-dao/adapters';
import {
  clearReservations,
  closeOpenRuns,
  finishSessionRun,
  getSessionRun,
  openAlertsByPrefix,
  requestSessionStop,
  resolveAlertByKey,
  runProgressFacts,
  upsertAlert,
} from '@fleet-dao/db';
import type { RunOutcome } from '@fleet-dao/shared';
import { judgeStallWithJev, NO_JEV, triageFailureAsked } from '../failure/ask.ts';
import type { JevReply } from '../failure/jev.ts';
import { judgeStall } from '../failure/stall.ts';
import type { FailureVerdict, TriageChoice } from '../failure/types.ts';
import {
  type AwaitSessionInput,
  type PortContext,
  PortError,
  type SessionEnd,
  type SessionHandle,
  type StopSessionInput,
} from '../ports.ts';
import { type ContinueMode, type HostReport, hostDrivers } from './hosts.ts';
import { explainKill, killSignal, realKillEvidence, scopeOomKills } from './kill-evidence.ts';
import type { OrgSwitchSessions } from './org-switch.ts';
import {
  DEFAULT_FORK_MAX_CONTEXT_TOKENS,
  ENGINE_STOP_CODE,
  ORPHAN_RUN_REASON,
  orgSwitchFailure,
} from './session-codes.ts';
import { createDetached } from './session-detached.ts';
import { createLaunch } from './session-launch.ts';
import { createLive, type Live } from './session-live.ts';
import { createOutput } from './session-output.ts';
import { createPrepare } from './session-prepare.ts';
import { createProgress } from './session-progress.ts';
import { createReattach } from './session-reattach.ts';
import { createTree } from './session-tree.ts';
import type { SessionPorts, SessionPortsDeps, SessionShared } from './session-types.ts';
import { asSessionUser, errorText, withRawError } from './session-util.ts';
import type { SegmentOutcome } from './sessions-segment.ts';
import { POOL_HOLD_PREFIX, poolHoldKey } from './store-ports.ts';

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

const OUTCOME: Record<SessionEnd['outcome'], RunOutcome> = {
  done: 'ok',
  blocked: 'ok',
  failed: 'failed',
  stalled: 'stalled',
  stopped: 'stopped',
};
const NEEDS = new Set(['human', 'info', 'access', 'other']);

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

  // ---- 看守

  async function reapLost(runId: string, user: SessionUser | undefined, handle: SessionHandle | undefined) {
    if (!user) return '（库里没记会话用户，旧会话的 scope 没法收）';
    try {
      const r = await reapSession({
        runId,
        scope: { id: runId, user, ...helperOpts },
        ...(handle?.pid ? { rootPid: handle.pid } : {}),
      });
      if (r.error) return `（收旧会话时出错：${r.error}）`;
      if (r.leftovers === undefined) return '（旧会话收没收干净没查成）';
      if (r.leftovers > 0) return `（旧会话还剩 ${r.leftovers} 个进程没收掉）`;
      return r.found > 0 ? `（收掉了旧会话的 ${r.found} 个进程）` : '';
    } catch (error) {
      return `（收旧会话时出错：${errorText(error)}）`;
    }
  }

  /**
   * 看守每醒一次：记下这个工人手上同时在跑的别的会话有几个、读会话自己 scope 的按内存杀进程记录——进程被信号杀掉时，
   * 它的 scope 多半已经收掉了，只能靠平时读下的（kill-evidence.ts）。读不到不算错，那一项证据就是没有。
   */
  async function noteMemoryAndPeers(live: Live): Promise<void> {
    live.peersSeen = Math.max(live.peersSeen, registry.size - 1);
    if (!live.scopeUnit) return;
    const n = await scopeOomKills(evidence, live.scopeUnit);
    if (n !== undefined) live.scopeOomSeen = Math.max(live.scopeOomSeen ?? 0, n);
  }

  async function checkStall(live: Live): Promise<void> {
    let pendingAsk: { question: string; askedAt: Date } | null = null;
    try {
      pendingAsk = (await runProgressFacts(db, live.runId, { saysLimit: 1 }))?.pendingAsk ?? null;
    } catch (error) {
      log('停滞判断读不到在等的问题，这一轮不判', { runId: live.runId, error: errorText(error) });
      return;
    }
    const iso = (ms: number) => new Date(ms).toISOString();
    const facts = {
      now: clock().toISOString(),
      startedAt: iso(live.startedAt),
      lastEventAt: live.lastEventAt === null ? null : iso(live.lastEventAt),
      ...(live.lastStepAt === undefined ? {} : { lastStepAt: iso(live.lastStepAt) }),
      ...(live.lastFileAt === undefined ? {} : { lastFileChangeAt: iso(live.lastFileAt) }),
      processAlive: true,
      toolsInFlight: [...live.tools.values()].map((t) => ({ name: t.name, since: iso(t.since) })),
      ...(pendingAsk
        ? {
            waiting: {
              on: 'human' as const,
              since: pendingAsk.askedAt.toISOString(),
              detail: pendingAsk.question,
            },
          }
        : {}),
      recentTools: live.recent,
      transcriptTail: live.says.slice(-5),
    };
    // 拿不准的停滞才问 Jev（judgeStallWithJev 先照规则判一次）；同一个会话 stallJevEveryMs 内只问一次，其余照规则判。
    // Jev 只能把拿不准的判成停滞（在绕圈、死了），不能把规则判的停滞判回正常；只记不拦的题、把握不够的答案都不算数。
    const mayAsk = live.stallJevAt === undefined || Date.now() - live.stallJevAt >= stallJevEveryMs;
    const verdict = mayAsk
      ? await judgeStallWithJev(facts, {
          jev: {
            ask: (question, ctx) => {
              live.stallJevAt = Date.now();
              return jev.ask(question, ctx);
            },
          },
          ctx: {
            subject: `run:${live.runId}`,
            about: `任务 ${live.taskId} 的 ${live.stage} 阶段（会话没推进）`,
          },
          ...jevTimeout,
          ...(deps.stallPolicy ? { policy: deps.stallPolicy } : {}),
        })
      : judgeStall(facts, deps.stallPolicy);
    // 光是没动静（D5）交给插头的 idle 超时：它按真实活动（包括思考帧）计时，这里只看得到进度事件。
    const act = verdict.state === 'looping' || (verdict.state === 'dead' && verdict.rule !== 'D5');
    if (act && !live.stop) {
      live.stop = { kind: 'stall', rule: verdict.rule, basis: verdict.basis };
      live.abort.abort();
    }
  }

  function costOfThisRun(live: Live, sessionCost: number | undefined): number | undefined {
    if (sessionCost === undefined || live.mode === 'fork') return undefined;
    if (live.mode !== 'resume') return sessionCost;
    if (live.previousCost === null || live.previousCost === undefined) return undefined;
    return Math.max(0, sessionCost - live.previousCost);
  }

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
        log('账号池的暂停没撤掉', { poolId: live.poolId, error: errorText(error) });
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
      log('失败分流判不了这次会话（按不算路由账记）', { runId: live.runId, error: errorText(error) });
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
        log('账号池暂停没写进库（选路照样会派过去）', { poolId: live.poolId, error: errorText(error) });
      }
    }
    return { routeOutcome: verdict.routeOutcome, ...jevPart };
  }

  /**
   * 交给工作流的会话号：执行体真用的那个（Claude、续会话一开始就知道；cursor 开新会话要 init 帧或终帧报上来；grok 开新会话
   * 要它真开了会话）。没报出来就是空串：工作流保留上一个，不拿临时号、没建成的号去续。
   */
  const agentIdOf = (live: Live, report?: HostReport): string =>
    live.agentSessionId ?? report?.sessionId ?? '';

  async function endOf(live: Live, report: HostReport): Promise<SessionEnd> {
    const common = {
      sessionId: agentIdOf(live, report),
      // 终帧报的这一轮的 token（含缓存读写）；读不到的不给，不记成 0。
      usage: report.usage,
      ...(report.sessionCostUsd === undefined ? {} : { sessionCostUsd: report.sessionCostUsd }),
    };
    const notes = [
      live.writeError ? `进度事件没写进库：${live.writeError}` : '',
      live.dropped > 0 ? `丢了 ${live.dropped} 条进度事件` : '',
    ].filter(Boolean);
    const failed = (code: string, message: string): SessionEnd => ({
      ...common,
      outcome: 'failed',
      failure: {
        code,
        message: [withRawError(message, report.rawError), ...notes].join('；'),
        ...(report.resetsAt ? { resetsAt: report.resetsAt } : {}),
        ...(report.httpStatus === undefined ? {} : { httpStatus: report.httpStatus }),
        exitCode: report.facts.exitCode ?? null,
        signal: report.facts.signal ?? null,
        transcriptTail: live.says.slice(-6),
        machine: deps.machine,
        runAsUser: live.user,
      },
    });
    /**
     * 没交终帧就退了、而且是被信号杀掉的（信号 SIGKILL、SIGTERM，或 sh 包着交回的 137、143）：按证据定是谁杀的
     * （kill-evidence.ts），码换成 engine_stop / oom_killed / signal_unexplained 交给失败分流，证据接在原文后面。不猜。
     */
    const failedOrKilled = async (code: string, message: string): Promise<SessionEnd> => {
      const signal =
        code === 'no_result' || code === 'exit_nonzero'
          ? killSignal(report.facts.exitCode, report.facts.signal)
          : null;
      if (!signal) return failed(code, message);
      const scopeNow = live.scopeUnit ? await scopeOomKills(evidence, live.scopeUnit) : undefined;
      const seen = [live.scopeOomSeen, scopeNow].filter((n): n is number => n !== undefined);
      const cause = await explainKill(evidence, {
        signal,
        endedAt: live.startedAt + report.wallMs,
        stopping: deps.drain?.stopping() ?? null,
        before: await live.oomBefore,
        scopeSeen: seen.length > 0 ? Math.max(...seen) : undefined,
        othersRunning: live.peersSeen,
      });
      return failed(cause.code, `${message}；${cause.why}`);
    };

    if (live.stop?.kind === 'stop') return { ...common, outcome: 'stopped' };
    // 切号停下的：交回 org_switch（可重试），工作流续同一个会话，换了池就 fork 续上（失败分流 OS1）
    if (live.stop?.kind === 'org-switch') {
      return {
        ...common,
        outcome: 'failed',
        failure: { ...orgSwitchFailure(live.stop.why), machine: deps.machine, runAsUser: live.user },
      };
    }
    // 排空到截止停下的：交回 engine_stop（可重试），新引擎起来工作流续同一个会话（失败分流 KL3，不记账）
    if (live.stop?.kind === 'engine-stop') {
      return {
        ...common,
        outcome: 'failed',
        failure: {
          code: ENGINE_STOP_CODE,
          message: `要发新版本，到了宽限的截止先停下：${live.stop.why}；新引擎起来按编号续上`,
          retryable: true,
          machine: deps.machine,
          runAsUser: live.user,
        },
      };
    }
    if (live.stop?.kind === 'stall') {
      return {
        ...common,
        outcome: 'stalled',
        failure: {
          code: 'SESSION_STALLED',
          message: `${live.stop.rule}：${live.stop.basis}`,
          retryable: true,
        },
      };
    }

    let progress: Awaited<ReturnType<typeof runProgressFacts>>;
    try {
      progress = await runProgressFacts(db, live.runId);
    } catch (error) {
      return failed('delivery_unknown', `会话交没交活没查成（读不到进度）：${errorText(error)}`);
    }
    const done = progress?.done ?? null;
    const blocked = progress?.blocked ?? null;
    if (blocked && (!done || blocked.at.getTime() > done.at.getTime())) {
      const needs = NEEDS.has(blocked.needs)
        ? (blocked.needs as 'human' | 'info' | 'access' | 'other')
        : 'other';
      return { ...common, outcome: 'blocked', blocked: { reason: blocked.reason || '会话说卡住了', needs } };
    }

    if (live.kind === 'delivery') {
      const delivery = await deliveryCheck(live);
      const verdict = judgeRun(report.facts, delivery.check);
      if (verdict.outcome === 'stalled') {
        return {
          ...common,
          outcome: 'stalled',
          failure: { code: 'SESSION_STALLED', message: verdict.detail, retryable: true },
        };
      }
      if (verdict.outcome === 'stopped') return { ...common, outcome: 'stopped' };
      if (verdict.outcome !== 'ok') return failedOrKilled(verdict.reason, verdict.detail);
      if (!done) {
        return failed('not_delivered', '会话结束了，但没用 fleet done 交活（也没用 fleet blocked 说卡在哪）');
      }
      if (!delivery.head) return failed('delivery_unknown', '读不到工作树的头');
      return {
        ...common,
        outcome: 'done',
        output: {
          kind: 'delivery',
          head: delivery.head,
          summary: done.summary,
          testsPassed: done.testsPassed === true,
          changedFiles: delivery.changed,
        },
      };
    }

    const verdict = judgeRun(report.facts);
    if (verdict.outcome === 'stalled') {
      return {
        ...common,
        outcome: 'stalled',
        failure: { code: 'SESSION_STALLED', message: verdict.detail, retryable: true },
      };
    }
    if (verdict.outcome === 'stopped') return { ...common, outcome: 'stopped' };
    if (verdict.outcome !== 'ok') return failedOrKilled(verdict.reason, verdict.detail);
    const output = await readOutput(live);
    if ('error' in output) return failed('wrong_output', output.error);
    return { ...common, outcome: 'done', output: output.ok };
  }

  /**
   * 三段（对题 / 动手 / 验收）走 runner 的 SessionEnd 转换（#554-4）：
   * runner 没 OutputKind / 没 .fleet-out/（那是 Lead / Verify 一路的形状），产出 = stdout 短句 + verdict。
   * - outcome done + verdict ok → done（会话跑通；output 不写——三段的调用方自己拿 SegmentOutcome 的事由 #554-2 接）
   * - outcome done + verdict failed / outcome != done → failed，failure.code 用 runner 的形状。
   * **没拿到 evidence 时不在这里判 manual 的业务对错**（那是 #554-2）；本切片只保证「会话起完不起坏」。
   */
  function sessionEndFromSegment(outcome: SegmentOutcome, input: AwaitSessionInput): SessionEnd {
    const { result, verdict } = outcome;
    const ok = result.outcome === 'done' && verdict.kind === 'ok';
    if (ok) {
      return { sessionId: outcome.sessionId, outcome: 'done' };
    }
    const failedReason = verdict.kind === 'failed' ? verdict.reason : `outcome=${result.outcome}`;
    return {
      sessionId: outcome.sessionId,
      outcome: result.outcome === 'timeout' || result.outcome === 'killed' ? 'stopped' : 'failed',
      failure: {
        code:
          result.outcome === 'done' ? 'SEGMENT_VERDICT_FAILED' : `SEGMENT_${result.outcome.toUpperCase()}`,
        message: `runner 段会话 ${input.runId} ${result.outcome}：${failedReason}`,
        retryable: result.outcome === 'timeout' || result.outcome === 'failed',
        exitCode: result.exitCode,
      },
    };
  }

  async function awaitSession(input: AwaitSessionInput, ctx: PortContext) {
    // 三段（对题 / 动手 / 验收）走 runner（#554-4）：先看 segments registry；查到了等那个 promise，
    // 把 SegmentOutcome 折成 SessionEnd 交回。查不到才走 Fusion 老链路（registry / db / reattach）。
    const segPromise = segments.get(input.runId);
    if (segPromise) {
      try {
        const outcome = await segPromise;
        segments.delete(input.runId);
        return sessionEndFromSegment(outcome, input);
      } catch (error) {
        segments.delete(input.runId);
        throw error;
      }
    }
    let live = registry.get(input.runId);
    let whyLost = '引擎工人重启过，输出管道断了';
    if (!live) {
      // 工人重启过：会话脱开引擎跑的（走文件），照收发目录接回；接不回再按下面收掉它
      const back = await reattach(input);
      if ('lost' in back) whyLost = back.lost;
      else live = back.live;
    }
    if (!live || live.sessionId !== input.sessionId) {
      // 接不上：按记下的 scope 收掉旧会话，交回 SESSION_LOST，工作流续会话重起。
      const stored = await getSessionRun(db, input.runId);
      const user = asSessionUser(stored?.runAsUser);
      const handle = input.handle ?? stored?.handle ?? undefined;
      const reaped = await reapLost(input.runId, user, handle);
      // 旧会话的临时目录跟着删：续会话是新的 runId、新的临时目录，这一个没人再用
      await removeTmp(input.runId);
      const message = `接不上会话 ${input.sessionId}：${whyLost}${reaped}`;
      await removeIo(input.runId);
      if (stored && !stored.endedAt) {
        await finishSessionRun(db, {
          id: input.runId,
          outcome: 'failed',
          endedAt: clock(),
          failureCode: 'SESSION_LOST',
          failureMessage: message,
          routeOutcome: 'neutral',
        });
      }
      return {
        sessionId: input.sessionId,
        outcome: 'failed' as const,
        failure: {
          code: 'SESSION_LOST',
          message,
          retryable: true,
          machine: deps.machine,
          ...(user ? { runAsUser: user } : {}),
        },
      };
    }

    live.awaiting += 1;
    let settled = false;
    try {
      return await watchLive(live, ctx, () => {
        settled = true;
      });
    } finally {
      live.awaiting -= 1;
      // 交回了：停机不用再等它。看守被取消（会话还在跑）的不撤：停机照它自己的时限等，收场时起会话那头撤
      if (settled) deps.drain?.settle(live.runId);
    }
  }

  /** 看守挂着的那一段：等进程收场、心跳、写进度、判停滞，收场后判结局、写库、交回。onSettled 在进程收场时叫。 */
  async function watchLive(live: Live, ctx: PortContext, onSettled: () => void): Promise<SessionEnd> {
    let nextStall = Date.now() + stallCheckMs;
    let settled = false;
    const ended = live.report.then(
      () => {
        settled = true;
        onSettled();
      },
      () => {
        settled = true;
        onSettled();
      },
    );
    while (!settled) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        ended,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, tickMs);
        }),
      ]);
      clearTimeout(timer);
      if (settled) break;
      if (ctx.signal.aborted) {
        // 活动被取消（工作流叫停）：会话由工作流收尾时按 runId 停，这里不替它做主。
        throw ctx.signal.reason ?? new Error('看守被取消');
      }
      ctx.heartbeat({ runId: live.runId, sessionId: live.sessionId });
      await flush(live);
      await noteMemoryAndPeers(live);
      if (Date.now() >= nextStall) {
        nextStall = Date.now() + stallCheckMs;
        try {
          await checkStall(live);
        } catch (error) {
          log('停滞判断出错（这一轮不判）', { runId: live.runId, error: errorText(error) });
        }
      }
    }

    clearTimeout(live.flushTimer);
    live.flushTimer = undefined;
    await flush(live);
    let end: SessionEnd;
    let report: HostReport | undefined;
    try {
      report = await live.report;
      end = await endOf(live, report);
    } catch (error) {
      end = {
        sessionId: agentIdOf(live, report),
        outcome: 'failed',
        failure: {
          code: error instanceof PortError ? error.code : 'LAUNCH_FAILED',
          message: errorText(error),
          machine: deps.machine,
          runAsUser: live.user,
        },
      };
    }
    registry.delete(live.runId);
    // 插头已经收场：临时目录删完再交回（不会失败，删不掉只记日志）
    await live.cleaned;
    await removeIo(live.runId);
    const { routeOutcome, jev: asked } = await holdOrRelease(live, end);
    // 问过 Jev 的（规则认不出的失败）：回答随结局交给工作流，工作流的失败分流带着它判，不在工作流里再问。
    if (asked && end.failure) end = { ...end, failure: { ...end.failure, jev: asked } };
    const cost = costOfThisRun(live, end.sessionCostUsd);
    const contextTokens = report?.contextTokens;
    const actualModel = report?.actualModel;
    try {
      await finishSessionRun(db, {
        id: live.runId,
        outcome: OUTCOME[end.outcome],
        endedAt: clock(),
        // 执行体真用的号（cursor 开新会话是 init 帧里的真号，下次 latestRunOfSession(真号) 查得到）；没报出来就不改，
        // 库里留着开工时记的临时号（接不上时工作流拿它来续，照它找得到这一轮、开新会话带接力任务书）。
        ...(end.sessionId ? { sessionId: end.sessionId } : {}),
        ...(actualModel ? { actualModel } : {}),
        ...(end.usage?.inputTokens === undefined ? {} : { inputTokens: end.usage.inputTokens }),
        ...(end.usage?.outputTokens === undefined ? {} : { outputTokens: end.usage.outputTokens }),
        // 缓存读写折额度当量要用（#216）：终帧没报的不给，库里留空（没读到），不记 0
        ...(end.usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: end.usage.cacheReadTokens }),
        ...(end.usage?.cacheWriteTokens === undefined
          ? {}
          : { cacheWriteTokens: end.usage.cacheWriteTokens }),
        ...(cost === undefined ? {} : { costUsd: cost }),
        ...(end.sessionCostUsd === undefined ? {} : { sessionCostUsd: end.sessionCostUsd }),
        ...(end.failure ? { failureCode: end.failure.code, failureMessage: end.failure.message } : {}),
        routeOutcome,
        ...(contextTokens === undefined ? {} : { contextTokens }),
      });
    } catch (error) {
      log('会话结局没写进库（工作流记计时时会再写一次）', { runId: live.runId, error: errorText(error) });
    }
    if (live.quotaError) log('会话里读到的额度没记上', { poolId: live.poolId, error: live.quotaError });
    return end;
  }

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
