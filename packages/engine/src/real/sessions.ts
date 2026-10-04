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
  type CgroupScope,
  type DeliveryCheck,
  judgeRun,
  listAgentScopes,
  reapSession,
  SESSION_USERS,
  type SessionUser,
  type SpawnInfo,
  stopScope,
} from '@fleet-dao/adapters';
import { PLAN_DOC } from '@fleet-dao/conventions';
import {
  clearReservations,
  closeOpenRuns,
  finishSessionRun,
  getSessionRun,
  latestRunOfSession,
  markSessionRunStarted,
  openAlertsByPrefix,
  openSessionRun,
  recordEngineAudit,
  requestSessionStop,
  resolveAlertByKey,
  routeLaunchFacts,
  runProgressFacts,
  type SessionRunState,
  type TaskContext,
  taskContext,
  upsertAlert,
} from '@fleet-dao/db';
import type { RunOutcome } from '@fleet-dao/shared';
import { stoppingNote } from '../drain.ts';
import { judgeStallWithJev, NO_JEV, triageFailureAsked } from '../failure/ask.ts';
import type { JevReply } from '../failure/jev.ts';
import { judgeStall } from '../failure/stall.ts';
import type { FailureVerdict, TriageChoice } from '../failure/types.ts';
import {
  type AwaitSessionInput,
  type LaunchSessionInput,
  type PortContext,
  PortError,
  type SessionEnd,
  type SessionHandle,
  type SessionOutput,
  type StartSessionResult,
  type StopSessionInput,
} from '../ports.ts';
import { hostName } from '../routing/names.ts';
import {
  type ContinueMode,
  type HostDriver,
  type HostReport,
  type HostRunSpec,
  type HostSession,
  hostDrivers,
  isWiredHost,
  sessionUserOf,
  wiredHostNames,
} from './hosts.ts';
import { explainKill, killSignal, oomCounters, realKillEvidence, scopeOomKills } from './kill-evidence.ts';
import { bundleFromMirror, mapped } from './mirror.ts';
import type { OrgSwitchSessions } from './org-switch.ts';
import {
  isLeadKind,
  type LeadOutputKind,
  OUT_DIR,
  OUTPUT_FILES,
  type OutputKind,
  outputKindFor,
  type Parsed,
  parseLeadBrief,
  parseLeadPlan,
  parseLeadRebut,
  parseLeadReview,
  parseLeadText,
  parseLeadVerdict,
  parsePlan,
  parseRequirementDoc,
  parseReview,
  parseTriage,
  parseVerify,
  type RelayFacts,
  stagePrompt,
} from './prompts.ts';
import {
  DEFAULT_FORK_MAX_CONTEXT_TOKENS,
  ENGINE_STOP_CODE,
  ENGINE_STOPPING_CODE,
  ORG_SWITCH_CODE,
  ORPHAN_RUN_REASON,
  orgSwitchFailure,
} from './session-codes.ts';
import { createDetached } from './session-detached.ts';
import { writeSessionMeta } from './session-io.ts';
import { createLive, type Live } from './session-live.ts';
import { createProgress } from './session-progress.ts';
import { createReattach } from './session-reattach.ts';
import { createTree } from './session-tree.ts';
import type { SessionPorts, SessionPortsDeps, SessionShared } from './session-types.ts';
import { asSessionUser, errorText, SHA, scopeLimitsOf, withRawError } from './session-util.ts';
import { launchSegment, SEGMENT_NOT_WIRED_CODE, type SegmentOutcome } from './sessions-segment.ts';
import { POOL_HOLD_PREFIX, poolHoldKey } from './store-ports.ts';
import {
  changedFilesSince,
  checkoutBranch,
  checkoutDetached,
  commitsSince,
  diffstatSince,
  excludeLocally,
  fetchBundle,
  hasCheckout,
  hasCommit,
  hasMainline,
  hasRepo,
  headOf,
  headOfIncoming,
  ownSpan,
  pinMainline,
  readFileAs,
  removeFileAs,
  type UserTree,
  uncommittedTracked,
  worktreeChanges,
} from './user-git.ts';

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
export { confirmedSeq } from './session-progress.ts';
export type { SessionPorts, SessionPortsDeps } from './session-types.ts';
export { scopeSize } from './session-util.ts';

import { decideContinuation, resumeStartupMs } from './session-continuation.ts';
import { otherVendor, screenForOtherVendor, VERIFY_MATERIAL, WORK_MATERIAL } from './session-screen.ts';

export { type ContinuationFacts, decideContinuation, resumeStartupMs } from './session-continuation.ts';
export {
  type Material,
  otherVendor,
  screenForOtherVendor,
  VERIFY_MATERIAL,
  WORK_MATERIAL,
} from './session-screen.ts';
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

  // ---- 起会话

  async function prepareTree(
    input: LaunchSessionInput,
    task: TaskContext,
    kind: OutputKind,
    dir: string,
    user: SessionUser,
    mode: ContinueMode,
    signal: AbortSignal,
  ): Promise<void> {
    const owner = await trees.ownerOf(dir);
    const fresh = owner === null;
    if (owner !== user) await trees.adopt(dir, user);
    const t = treeAs(dir, user, `prep-${input.runId}`, signal);
    const identity = await identityOf(task.repo);
    const repoRef = { owner: task.repo.owner, name: task.repo.name };
    if (kind === 'delivery' || isLeadKind(kind)) {
      // 续上一轮的树：检出过的原样接着用。只看 .git 在不在不够——建树时 init 之后取包失败、同一个 runId 重试，
      // 留下的是个空仓；那样的照常取包、检出，不在空树里起会话。Fusion 的 Lead 第一步（写方案）就在新树上起。
      if (fresh || !(await hasCheckout(t))) {
        const base = input.baseHead;
        const branch = input.brief.branch;
        if (!base || !SHA.test(base) || !branch) {
          throw new PortError(
            'BAD_INPUT',
            `${isLeadKind(kind) ? 'Lead 的会话' : '写码会话'}要给起会话前的头（baseHead）和分支（brief.branch）`,
            { retryable: false },
          );
        }
        const { bytes, ref } = await bundleFromMirror(gh, deps.tmpDir, repoRef, base, [], signal);
        await fetchBundle(t, bytes, ref, { identity });
        await checkoutBranch(t, branch, base);
        // 第一轮的 base 就是建树时记下的主线头（createWorktree 的 baseSha）。树丢了、从返工时的分支头重建的，钉的是分支头：
        // test:changed 只算这一轮的改动——前几轮的在那几轮的会话里测过，CI 还会全测。
        await pinMainline(t, task.repo.defaultBranch, base);
      } else if (!(await hasMainline(t, task.repo.defaultBranch))) {
        // 钉主线之前（#218）建的老树接着用：照「从分支头重建的树」的规矩钉到起会话前的头。交活核对要扣掉并进来的主线，
        // 树里没钉就判不了（ownSpan 明确报 MAINLINE_MISSING）；这样钉，这一步的改动从起会话前的头比，和钉主线之前一样
        const base = input.baseHead;
        if (base && SHA.test(base)) await pinMainline(t, task.repo.defaultBranch, base);
      }
      // Lead 的结论文件写在工作树的 .fleet-out/ 里：记进这棵树自己的忽略清单，git add 不会把它提交进分支
      await excludeLocally(t, `${OUT_DIR}/`);
      return;
    }
    // 分诊、需求文档、方案、审查、开 PR 前验证：检出副本。续同一个会话（resume / fork）不动它；开新会话从干净的检出起。
    if (!fresh && (mode === 'resume' || mode === 'fork')) return;
    let sha: string;
    const checksHead = kind === 'review' || kind === 'verify';
    if (checksHead) {
      sha = input.brief.head ?? '';
      if (!SHA.test(sha)) {
        const who = kind === 'review' ? '审查会话要给 PR 的头' : '验证会话要给送检的头';
        throw new PortError('BAD_INPUT', `${who}（完整提交号）：${sha || '没给'}`, {
          retryable: false,
        });
      }
    } else {
      sha = (await mapped(() => gh.fetchMainline({ repo: repoRef, signal }))).head;
    }
    const exclude: string[] = [];
    const known = await hasRepo(t);
    // 仓里已经有这个提交（主线没动过）：直接换检出。要是照样去镜像取，包里一个新提交都没有，git 拒绝打空包。
    if (!known || !(await hasCommit(t, sha))) {
      if (known) {
        const last = await headOfIncoming(t).catch(() => undefined);
        if (last) exclude.push(last);
      }
      const { bytes, ref } = await bundleFromMirror(gh, deps.tmpDir, repoRef, sha, exclude, signal);
      await fetchBundle(t, bytes, ref, { identity });
    }
    await checkoutDetached(t, sha);
    // 分诊、文档、方案检出的就是主线头；审查、验证检出的是送检的头，主线另取进来再钉（提示词让它 git diff origin/<主线>...HEAD）。
    let mainline = sha;
    if (checksHead) {
      mainline = (await mapped(() => gh.fetchMainline({ repo: repoRef, signal }))).head;
      if (!(await hasCommit(t, mainline))) {
        const { bytes, ref } = await bundleFromMirror(gh, deps.tmpDir, repoRef, mainline, [sha], signal);
        await fetchBundle(t, bytes, ref);
      }
    }
    await pinMainline(t, task.repo.defaultBranch, mainline);
  }

  async function relayFacts(
    prior: SessionRunState | null,
    t: UserTree,
    kind: OutputKind,
    base: string | undefined,
    defaultBranch: string,
    why: string,
  ): Promise<RelayFacts> {
    const progress = prior ? await runProgressFacts(db, prior.id, { saysLimit: 8 }) : null;
    const delivery = (kind === 'delivery' || isLeadKind(kind)) && base !== undefined && SHA.test(base);
    // 已提交了什么：并进来的主线不算（接力的会话照它接着干，主线上别人的提交不是这一步做的）
    const span = delivery ? await ownSpan(t, base, defaultBranch) : null;
    return {
      steps: progress?.lastPlan?.steps ?? [],
      says: (progress?.says ?? []).map((s) => s.text).filter(Boolean),
      commits: span ? await commitsSince(t, span, 30) : [],
      diffstat: span ? await diffstatSince(t, span) : [],
      why,
    };
  }

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

  async function deliveryCheck(
    live: Live,
  ): Promise<{ check: DeliveryCheck; head?: string; changed: string[] }> {
    const base = live.baseHead;
    const target = base ?? '（没给起会话前的头）';
    const t = treeAs(live.dir, live.user, `done-${live.runId}`);
    try {
      const head = await headOf(t);
      const dirty = await uncommittedTracked(t);
      if (dirty.length > 0) {
        return {
          check: {
            state: 'not_delivered',
            target,
            uncommitted: dirty.length,
            detail: `工作树里有没提交的已跟踪改动（引擎只推提交，这部分会丢）：${dirty.slice(0, 5).join('；')}`,
          },
          head,
          changed: [],
        };
      }
      if (!base || !SHA.test(base)) {
        return {
          check: { state: 'unknown', target, detail: '没给起会话前的头，判不了有没有新提交' },
          head,
          changed: [],
        };
      }
      // 并进来的主线不算这一步交的（user-git.ts 的 ownSpan）：只并了主线、自己没写东西的不算交了
      const span = head === base ? null : await ownSpan(t, base, live.defaultBranch);
      const commits = span ? await commitsSince(t, span, 50) : [];
      if (!span || commits.length === 0) {
        return {
          check: {
            state: 'not_delivered',
            target,
            newCommits: 0,
            detail: `起会话前的头 ${base.slice(0, 7)} 之后没有新提交（并进来的主线不算）`,
          },
          head,
          changed: [],
        };
      }
      const changed = await changedFilesSince(t, span);
      if (changed.length === 0) {
        return {
          check: {
            state: 'not_delivered',
            target,
            newCommits: commits.length,
            hasDiff: false,
            detail: '有新提交，但除了并进来的主线，和起会话前比没有内容差异',
          },
          head,
          changed,
        };
      }
      return {
        check: {
          state: 'delivered',
          target,
          newCommits: commits.length,
          hasDiff: true,
          uncommitted: 0,
          detail: `${commits.length} 个新提交，改了 ${changed.length} 个文件`,
        },
        head,
        changed,
      };
    } catch (error) {
      return { check: { state: 'unknown', target, detail: errorText(error) }, changed: [] };
    }
  }

  async function readOutput(live: Live): Promise<Parsed<SessionOutput>> {
    const t = treeAs(live.dir, live.user, `out-${live.runId}`);
    const read = async (path: string) => {
      const text = await readFileAs(t, path);
      return text;
    };
    try {
      switch (live.kind) {
        case 'triage': {
          const text = await read(OUTPUT_FILES.triage[0]);
          if (text === null) return { error: `会话结束了，但没写 ${OUTPUT_FILES.triage[0]}` };
          const v = parseTriage(text);
          return 'error' in v ? v : { ok: { kind: 'triage', verdict: v.ok } };
        }
        case 'doc': {
          const text = await read(OUTPUT_FILES.doc[0]);
          if (text === null) return { error: `会话结束了，但没写 ${OUTPUT_FILES.doc[0]}` };
          // 「对应计划：」那一行要对得上检出副本里的 plan.md（仓里没有就只要写清）
          const plan = await read(PLAN_DOC);
          const v = parseRequirementDoc(text, plan ?? undefined);
          return 'error' in v ? v : { ok: { kind: 'doc', markdown: v.ok } };
        }
        case 'plan': {
          const [md, json] = await Promise.all([read(OUTPUT_FILES.plan[0]), read(OUTPUT_FILES.plan[1])]);
          if (md === null || json === null) {
            return {
              error: `会话结束了，但没写 ${md === null ? OUTPUT_FILES.plan[0] : OUTPUT_FILES.plan[1]}`,
            };
          }
          const v = parsePlan(md, json);
          return 'error' in v
            ? v
            : { ok: { kind: 'plan', markdown: v.ok.markdown, subtasks: v.ok.subtasks } };
        }
        case 'review': {
          const text = await read(OUTPUT_FILES.review[0]);
          if (text === null) return { error: `会话结束了，但没写 ${OUTPUT_FILES.review[0]}` };
          const v = parseReview(text, live.reviewHead ?? '');
          return 'error' in v ? v : { ok: { kind: 'review', review: v.ok } };
        }
        case 'verify': {
          const text = await read(OUTPUT_FILES.verify[0]);
          if (text === null) return { error: `会话结束了，但没写结论 ${OUTPUT_FILES.verify[0]}` };
          const v = parseVerify(text, live.verifyCriteria ?? [], live.reviewHead ?? '');
          return 'error' in v ? v : { ok: { kind: 'verify', report: v.ok } };
        }
        case 'delivery':
          return { error: '写码会话不读结论文件' };
        case 'lead-plan':
        case 'lead-verdict':
        case 'lead-rebut':
        case 'lead-brief':
        case 'lead-review':
        case 'lead-text':
          return await readLeadOutput(live, live.kind, read);
      }
    } catch (error) {
      throw new PortError('READ_FAILED', `读会话交回来的结论文件没成：${errorText(error)}`, {
        retryable: true,
      });
    }
  }

  /**
   * Lead 这一步交回的：结论文件（按这一步定名）加上工作树的样子。写方案、写结果那两步可以在分支上提交，头和这一步改到的
   * 文件从提交里读（不信文件里写的）；其余几步只看不改，头动了就算交错了。有没提交的已跟踪改动都算交错了（引擎只推提交）。
   */
  async function readLeadOutput(
    live: Live,
    kind: LeadOutputKind,
    read: (path: string) => Promise<string | null>,
  ): Promise<Parsed<SessionOutput>> {
    const file = OUTPUT_FILES[kind][0];
    const text = await read(file);
    if (text === null) return { error: `会话结束了，但没写结论 ${file}` };
    const t = treeAs(live.dir, live.user, `lead-${live.runId}`);
    const head = await headOf(t);
    const dirty = await uncommittedTracked(t);
    if (dirty.length > 0) {
      return {
        error: `工作树里有没提交的已跟踪改动（引擎只推提交，这部分会丢）：${dirty.slice(0, 5).join('；')}`,
      };
    }
    const base = live.baseHead;
    if (!base || !SHA.test(base)) return { error: '没给起会话前的头，判不了这一步提交了什么' };
    const commits = kind === 'lead-plan' || kind === 'lead-review';
    if (!commits && head !== base) {
      return {
        error: `这一步只看不改，头却从 ${base.slice(0, 7)} 变成了 ${head.slice(0, 7)}：用 git reset --hard ${base} 退回起这一步之前的头再交（要改的写进结论里）`,
      };
    }
    // 并进来的主线不算这一步改的（user-git.ts 的 ownSpan）
    const changedFiles =
      commits && head !== base ? await changedFilesSince(t, await ownSpan(t, base, live.defaultBranch)) : [];
    switch (kind) {
      case 'lead-plan': {
        const v = parseLeadPlan(text);
        return 'error' in v ? v : { ok: { kind, head, changedFiles, ...v.ok } };
      }
      case 'lead-review': {
        const v = parseLeadReview(text);
        return 'error' in v ? v : { ok: { kind, head, changedFiles, ...v.ok } };
      }
      case 'lead-verdict': {
        const v = parseLeadVerdict(text);
        return 'error' in v ? v : { ok: { kind, ...v.ok } };
      }
      case 'lead-rebut': {
        const v = parseLeadRebut(text);
        return 'error' in v ? v : { ok: { kind, ...v.ok } };
      }
      case 'lead-brief': {
        const v = parseLeadBrief(text);
        return 'error' in v ? v : { ok: { kind, ...v.ok } };
      }
      case 'lead-text': {
        const v = parseLeadText(text);
        return 'error' in v ? v : { ok: { kind, ...v.ok } };
      }
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
