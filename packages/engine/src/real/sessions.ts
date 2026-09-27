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
// 看守：进程是这个工人进程起的（registry）。接不上（工人重启过、输出管道断了）就按记下的 scope 收掉旧会话，回
// SESSION_LOST，工作流续会话重起。过程中：心跳；进度事件攒一小批写库（fleet done 的核实要读会话自己跑过的测试，
// 所以写得要快）；额度读数顺手记账；每分钟按进展判一次停滞（failure/stall.ts），在绕圈、工具卡死就停掉，结局 stalled
// （光是没动静由插头自己的 idle 超时管）。结束后：写码类看 fleet done 和工作树（有新提交、没有没提交的已跟踪改动）；
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
  type PlanPayload,
  type RateLimitReading,
  reapSession,
  SESSION_USERS,
  type SessionUser,
  type SpawnInfo,
  stopScope,
  type ToolPayload,
} from '@fleet-dao/adapters';
import { readingsFromRateLimit } from '@fleet-dao/adapters/quota';
import { PLAN_DOC } from '@fleet-dao/conventions';
import {
  appendProgressEvents,
  type Db,
  finishSessionRun,
  getSessionRun,
  latestRunOfSession,
  markSessionRunStarted,
  openAlertsByPrefix,
  openSessionRun,
  requestSessionStop,
  resolveAlertByKey,
  routeLaunchFacts,
  runProgressFacts,
  type SessionRunState,
  savePoolQuota,
  type TaskContext,
  taskContext,
  upsertAlert,
} from '@fleet-dao/db';
import type { ProgressEvent, RunOutcome, StageKind } from '@fleet-dao/shared';
import { judgeStallWithJev, NO_JEV, triageFailureAsked } from '../failure/ask.ts';
import type { JevPort, JevReply } from '../failure/jev.ts';
import { judgeStall, type StallPolicy, type StallToolCall } from '../failure/stall.ts';
import type { FailureVerdict, TriageChoice } from '../failure/types.ts';
import {
  type AwaitSessionInput,
  type EnginePorts,
  type LaunchSessionInput,
  PortError,
  type SessionEnd,
  type SessionHandle,
  type SessionOutput,
  type StartSessionResult,
} from '../ports.ts';
import { hostName } from '../routing/names.ts';
import type { UserExec } from './exec.ts';
import { sessionTestCommandOrStop } from './flow-gate.ts';
import {
  type ContinueMode,
  type HostDriver,
  type HostReport,
  type HostRunners,
  type HostSession,
  hostDrivers,
  isWiredHost,
  sessionUserOf,
  type WiredHost,
  wiredHostNames,
} from './hosts.ts';
import { bundleFromMirror, type MirrorGitHub, mapped } from './mirror.ts';
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
  hasRepo,
  headOf,
  headOfIncoming,
  pinMainline,
  readFileAs,
  removeFileAs,
  type UserTree,
  uncommittedTracked,
} from './user-git.ts';
import type { WorkTrees } from './worktrees.ts';

/** 上下文比这个小才 fork 续到别的会话用户；大了开新会话带接力任务书（design 第九节「上下文越长越贵」）。 */
export const DEFAULT_FORK_MAX_CONTEXT_TOKENS = 100_000;

export type { ContinueMode };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ContinuationFacts {
  /** 工作流要接着的会话号（可能是 cursor 的临时号）。 */
  resumeId: string;
  /** 这个号最近一轮的记录（latestRunOfSession）；查不到 = null。 */
  prior: Pick<SessionRunState, 'runAsUser' | 'routeId' | 'worktreePath' | 'contextTokens'> | null;
  /** 上一轮的路由现在的样子（routeLaunchFacts）；查不到 = null。 */
  before: { hostId: string; poolId: string } | null;
  /** 这次的路由。 */
  route: { poolId: string };
  driver: Pick<HostDriver, 'hostId' | 'canFork'>;
  user: SessionUser;
  /** 这次会话的工作目录。 */
  dir: string;
  forkMax: number;
}

/**
 * 续上一个会话的方式：同池、同会话用户、同执行方式、同一个目录、真号 → --resume；只换了池、执行方式能 fork、上一轮上下文还小
 * → fork；别的一律接力（开新会话带接力任务书），why 写清为什么续不上。先后就是判断的先后，每个分支都有测试。
 * 不硬续的理由：会话记录存在会话用户家里、按工作目录分（Claude 的 ~/.claude/projects/<目录>、cursor 的 ~/.cursor/chats/<目录的哈希>），
 * 换了用户、目录、执行方式都找不到；cursor 的临时号不是它的会话号；cursor 没有 fork，切了池原会话续不上。
 */
export function decideContinuation(x: ContinuationFacts): { mode: ContinueMode; why: string } {
  const { resumeId, prior, before } = x;
  const relay = (why: string) => ({ mode: 'relay' as const, why });
  if (!prior) return relay(`上一个会话 ${resumeId} 的记录查不到`);
  if (asSessionUser(prior.runAsUser) !== x.user) {
    return relay(
      `上一个会话 ${resumeId} 跑在 ${prior.runAsUser ?? '没记'} 下，不是现在的会话用户 ${x.user}，续不上`,
    );
  }
  if (!before) {
    return relay(`上一个会话 ${resumeId} 的路由 ${prior.routeId} 已不在，不知道它是哪种执行方式、哪个账号池`);
  }
  if (before.hostId !== x.driver.hostId) {
    return relay(
      `上一个会话 ${resumeId} 是 ${hostName(before.hostId)} 的，这次是 ${hostName(x.driver.hostId)}：换了执行方式，续不上`,
    );
  }
  if (!UUID.test(resumeId)) {
    return relay(`上一个会话的号 ${resumeId} 不是执行体自己的会话号（会话在报出会话号之前就断了），续不上`);
  }
  if (prior.worktreePath !== x.dir) {
    return relay(
      `上一个会话 ${resumeId} 在 ${prior.worktreePath ?? '没记的目录'} 里跑，这次在 ${x.dir}：过程记录按目录存，换了目录续不上`,
    );
  }
  if (before.poolId === x.route.poolId) return { mode: 'resume', why: '' };
  const moved = `换了账号池（${before.poolId} → ${x.route.poolId}）`;
  if (!x.driver.canFork) return relay(`${moved}，${hostName(x.driver.hostId)} 不能 fork`);
  if (prior.contextTokens !== null && prior.contextTokens < x.forkMax) return { mode: 'fork', why: '' };
  return relay(
    prior.contextTokens === null
      ? `${moved}，上一轮的上下文大小不知道`
      : `${moved}，上一轮的上下文有 ${prior.contextTokens} 个 token，大了不 fork`,
  );
}

export interface SessionPortsDeps {
  db: Db;
  trees: WorkTrees;
  /** 以会话用户的身份跑命令（生产 scopeExec）。 */
  exec: UserExec;
  gh: MirrorGitHub & {
    commitIdentity(repo: { owner: string; name: string }): Promise<{ name: string; email: string }>;
  };
  /** 引擎自己的临时目录（从镜像打的 bundle 落在这里，读进内存就删）。 */
  tmpDir: string;
  /** 这台机器给人看的名字（例如「法国」）：只有人能修的（重新登录）要写清去哪台机器。 */
  machine: string;
  /** 起 Claude Code 的命令（绝对路径）：reclaude 装在会话用户自己家里。 */
  claudeCommand(user: SessionUser): string[];
  /** 起 cursor-agent 的命令（绝对路径）：装在会话用户自己家里，生产用 hosts.ts 的 cursorLaunchCommand 现找版本目录。 */
  cursorCommand(user: SessionUser): string[];
  /** 起 grok 的命令（绝对路径）：装在会话用户自己家里，生产用 hosts.ts 的 grokLaunchCommand 先看在不在。 */
  grokCommand(user: SessionUser): string[];
  forkMaxContextTokens?: number;
  /** 经 sudo 调的帮手（fleet-agent-scope）；测试里换成假的。 */
  helper?: string;
  sudo?: readonly string[];
  /** 会话目录里跑的 git、sh（测试里换成 PATH 上的）。 */
  gitBin?: string;
  shBin?: string;
  /** 宿主环境（会话环境只从里面抄一小撮基础变量，见 adapters/env.ts）。 */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** 起会话的插头，按执行方式给；测试里换成假的（不起真执行体）。没给的用真插头。 */
  run?: HostRunners;
  /**
   * 发给别家之前的卫生检查（和推分支、开 PR 同一套规则和名单：github 包的 assertPublishable）。查出来、名单没读到、
   * 没扫成都抛带码的错（HYGIENE_BLOCKED / HYGIENE_NAME_BLOCKED / HYGIENE_LIST_MISSING / HYGIENE_UNSCANNED）。
   * 开 PR 前验证的会话起之前整份提示词过一遍；没配就不起验证会话（明确报错），不当成查过没事。
   */
  screen?: (what: string, texts: { path: string; text: string }[]) => void;
  stallPolicy?: Partial<StallPolicy>;
  /** 规则认不出的失败、拿不准的停滞去问 Jev（real/jev-port.ts）；不给就不问，照默认走。 */
  jev?: JevPort;
  /** 问一次 Jev 最多等多久，默认 askJev 的 2 秒；超了当没判出来（后台那一问答回来照样记进判断记录）。 */
  jevTimeoutMs?: number;
  /** 同一个会话的停滞题多久最多问一次 Jev（看守每分钟判一次，拿不准的区间有半个多小时）。 */
  stallJevEveryMs?: number;
  now?: () => Date;
  /** 看守多久醒一次（心跳、写进度）、多久判一次停滞、进度攒多久写一次、等进程起来最多多久。 */
  tickMs?: number;
  stallCheckMs?: number;
  flushMs?: number;
  spawnTimeoutMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export type SessionPorts = Pick<EnginePorts, 'startSession' | 'awaitSession' | 'stopSession'> & {
  /** 工人起来接活之前：收掉上一轮留下的会话 scope（fleet-agent-scope list 再逐个 stop）、清掉它们的临时目录，回收了几个会话。 */
  reapOrphanSessions(): Promise<number>;
};

interface Live {
  runId: string;
  /** 起会话时回给工作流的号（看守拿它对会话）：cursor 开新会话时是临时号。 */
  sessionId: string;
  /** 执行体真用的会话号：Claude、续会话一开始就知道；cursor 开新会话要等 init 帧报上来，没报就一直没有。 */
  agentSessionId: string | undefined;
  hostId: WiredHost;
  driver: HostDriver;
  taskId: string;
  stage: StageKind;
  kind: OutputKind;
  mode: ContinueMode;
  user: SessionUser;
  poolId: string;
  routeId: string;
  dir: string;
  baseHead: string | undefined;
  reviewHead: string | undefined;
  /** 开 PR 前验证对照的「怎么算做完」：读结论文件时拿它核逐条答全了没有。 */
  verifyCriteria: string[] | undefined;
  /** 续会话时上一轮结束时的会话累计花费：这一轮的花费按它求差。 */
  previousCost: number | null | undefined;
  startedAt: number;
  spawned: Promise<SpawnInfo>;
  report: Promise<HostReport>;
  /** 插头收场（进程、scope 都收了）之后删这次会话的临时目录；不会失败（删不掉只记日志）。 */
  cleaned: Promise<void>;
  abort: AbortController;
  stop: { kind: 'stop'; reason: string } | { kind: 'stall'; rule: string; basis: string } | undefined;
  pending: ProgressEvent[];
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  flushing: Promise<void>;
  writeError: string | undefined;
  dropped: number;
  lastEventAt: number | null;
  /** 上次为停滞题问 Jev 的时刻（Date.now()）；没问过是 undefined。 */
  stallJevAt?: number;
  lastStepAt: number | undefined;
  lastFileAt: number | undefined;
  tools: Map<string, { name: string; since: number }>;
  recent: StallToolCall[];
  says: string[];
  plan: Map<string, string>;
  quotaError: string | undefined;
}

const STEP_RANK: Record<string, number> = { pending: 0, in_progress: 1, done: 2 };
const PENDING_MAX = 5_000;
const RECENT_TOOLS = 30;
const SAYS_KEPT = 12;
const SHA = /^[0-9a-f]{40}$/;
const OUTCOME: Record<SessionEnd['outcome'], RunOutcome> = {
  done: 'ok',
  blocked: 'ok',
  failed: 'failed',
  stalled: 'stalled',
  stopped: 'stopped',
};
const NEEDS = new Set(['human', 'info', 'access', 'other']);

function asSessionUser(user: string | null | undefined): SessionUser | undefined {
  return (SESSION_USERS as readonly string[]).includes(user ?? '') ? (user as SessionUser) : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 失败信息接上执行体只在 stderr 里说的原话（已经在里面的不重复）：cursor 的认证、额度、网络报错就只有它。 */
function withRawError(message: string, raw: string | undefined): string {
  return raw && !message.includes(raw) ? `${message}（执行体原话：${raw}）` : message;
}

/**
 * 以 MB 计的上限 → 帮手脚本（fleet-agent-scope）认的写法：0 只能写「0」（它和插头的校验都不认「0M」，
 * 2026-09-26 法国第一次真起会话就卡在交换区上限「0M」上），别的写「<整数>M」。
 * 不是非负整数的明确拒：不起会话，也不悄悄取整。
 */
export function scopeSize(name: string, mb: number): string {
  if (!Number.isSafeInteger(mb) || mb < 0) {
    throw new PortError('BAD_INPUT', `会话的资源上限 ${name} 要是非负整数（MB）：${mb}`, {
      retryable: false,
    });
  }
  return mb === 0 ? '0' : `${mb}M`;
}

/** 发给别家的材料在卫生检查里叫什么（报错里的位置只有它和行号、规则名，没有值）。 */
export interface Material {
  what: string;
  path: string;
}
export const VERIFY_MATERIAL: Material = { what: '发给别家的验证材料', path: '验证提示词' };
export const WORK_MATERIAL: Material = { what: '发给别家的交代', path: '提示词' };

/** 自家（Claude）之外的族都算别家：派给它的整份提示词先过卫生检查。 */
export function otherVendor(family: string): boolean {
  return family.trim().toLowerCase() !== 'claude';
}

/**
 * 发给别家之前的卫生检查：查出来的报 MATERIAL_BLOCKED（不可重试；失败分流 HY4 当场挂起报警——材料是工作流交代的，
 * 换路由、退回会话都还是它）；名单没读到、没扫成原样报 HYGIENE_LIST_MISSING / HYGIENE_UNSCANNED（HY2 挂起）；没配检查、
 * 检查自己出错都算没扫成，不发。报错里只有位置、行号和规则名（assertPublishable 不打值）。
 */
export function screenForOtherVendor(
  screen: SessionPortsDeps['screen'],
  prompt: string,
  to: string,
  material: Material = VERIFY_MATERIAL,
): void {
  if (!screen) {
    throw new PortError(
      'HYGIENE_UNSCANNED',
      `${material.what}没法过卫生检查（会话端口没配检查），不发给${to}`,
      {
        retryable: false,
      },
    );
  }
  try {
    screen(material.what, [{ path: material.path, text: prompt }]);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const details = (error as { details?: unknown } | null)?.details;
    if (code === 'HYGIENE_BLOCKED' || code === 'HYGIENE_NAME_BLOCKED') {
      const raw = (details as { findings?: unknown } | undefined)?.findings;
      const findings = Array.isArray(raw)
        ? (raw as { path?: unknown; line?: unknown; rule?: unknown }[])
        : [];
      const where = findings
        .slice(0, 10)
        .map(
          (f) =>
            `${String(f.path)}${typeof f.line === 'number' && f.line > 0 ? ` 第 ${f.line} 行` : ''} ${String(f.rule)}`,
        )
        .join('；');
      throw new PortError(
        'MATERIAL_BLOCKED',
        where
          ? `${material.what}没过卫生检查，没发给${to}：查出 ${findings.length} 处（${where}）`
          : `${material.what}没过卫生检查，没发给${to}：${errorText(error)}`,
        { retryable: false, details },
      );
    }
    if (code === 'HYGIENE_LIST_MISSING' || code === 'HYGIENE_UNSCANNED') {
      throw new PortError(code, errorText(error), { retryable: false, details });
    }
    throw new PortError('HYGIENE_UNSCANNED', `${material.what}没扫成，不发给${to}：${errorText(error)}`, {
      retryable: false,
    });
  }
}

function scopeLimitsOf(r: LaunchSessionInput['resources']): NonNullable<CgroupScope['limits']> {
  return {
    memoryHigh: scopeSize('memoryHighMb', r.memoryHighMb),
    memoryMax: scopeSize('memoryMaxMb', r.memoryMaxMb),
    memorySwapMax: scopeSize('swapMaxMb', r.swapMaxMb),
  };
}

export function createSessionPorts(deps: SessionPortsDeps): SessionPorts {
  const { db, trees, gh } = deps;
  const clock = deps.now ?? (() => new Date());
  const drivers = hostDrivers({
    claudeCommand: deps.claudeCommand,
    cursorCommand: deps.cursorCommand,
    grokCommand: deps.grokCommand,
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
  const helperOpts = {
    ...(deps.helper ? { helper: deps.helper } : {}),
    ...(deps.sudo ? { sudo: deps.sudo } : {}),
  };
  const registry = new Map<string, Live>();
  const identities = new Map<string, Promise<{ name: string; email: string }>>();

  const treeAs = (dir: string, user: SessionUser, prefix: string, signal?: AbortSignal): UserTree => ({
    exec: deps.exec,
    user,
    dir,
    scopePrefix: prefix,
    ...(signal ? { signal } : {}),
    ...(deps.gitBin ? { git: deps.gitBin } : {}),
    ...(deps.shBin ? { sh: deps.shBin } : {}),
  });

  const identityOf = (repo: TaskContext['repo']) => {
    const key = `${repo.owner}/${repo.name}`;
    let p = identities.get(key);
    if (!p) {
      p = mapped(() => gh.commitIdentity(repo));
      identities.set(key, p);
      p.catch(() => identities.delete(key));
    }
    return p;
  };

  /** 删这次会话的临时目录。不抛（会话的结局不受它影响）：删不掉明说没删掉，工人下次起来时 sweepTmp 再清。 */
  async function removeTmp(runId: string): Promise<void> {
    let dir: string | undefined;
    try {
      dir = trees.tmpFor(runId);
      await trees.remove(dir);
    } catch (error) {
      log('会话的临时目录没删掉（工人下次起来时再清）', {
        runId,
        ...(dir ? { dir } : {}),
        error: errorText(error),
      });
    }
  }

  /**
   * 上一轮会话留下的临时目录：工人起来时（上一轮的会话 scope 都收了）把 _tmp 下的全清掉，这个进程里在跑的不碰。
   * 列不出来、删不掉都明说没清成（记日志），不挡工人接活：留着的只占盘，下次起来再清。回删掉了几个。
   */
  async function sweepTmp(): Promise<number> {
    let dirs: string[];
    try {
      dirs = await trees.listTmp();
    } catch (error) {
      log('上一轮会话留下的临时目录没清成：列不出来', { error: errorText(error) });
      return 0;
    }
    const mine = new Set([...registry.keys()].map((runId) => trees.tmpFor(runId)));
    let removed = 0;
    const failed: string[] = [];
    for (const dir of dirs) {
      if (mine.has(dir)) continue;
      try {
        if (!(await trees.remove(dir)).gone) removed += 1;
      } catch (error) {
        failed.push(`${dir}：${errorText(error)}`);
      }
    }
    if (failed.length > 0) {
      log(`上一轮会话留下的临时目录有 ${failed.length} 个没删掉（下次起来再清）`, {
        failed: failed.slice(0, 10),
      });
    }
    return removed;
  }

  // ---- 进度：攒一小批写库

  const flush = (live: Live): Promise<void> => {
    live.flushing = live.flushing.then(async () => {
      while (live.pending.length > 0) {
        const batch = live.pending.splice(0, 500);
        try {
          const r = await appendProgressEvents(
            db,
            live.runId,
            batch.map((e) => ({ at: new Date(e.at), kind: e.kind, payload: e.payload })),
          );
          if (r === 'run_not_found') {
            live.writeError ??= `库里没有会话 ${live.runId}，进度写不进去`;
            return;
          }
        } catch (error) {
          live.writeError ??= errorText(error);
          // 写不进去先放回去，下一轮再写；攒太多就丢最老的，记下丢了几条（不静默）。
          live.pending.unshift(...batch);
          if (live.pending.length > PENDING_MAX) {
            const drop = live.pending.length - PENDING_MAX;
            live.pending.splice(0, drop);
            live.dropped += drop;
          }
          return;
        }
      }
    });
    return live.flushing;
  };

  const scheduleFlush = (live: Live) => {
    if (live.flushTimer) return;
    live.flushTimer = setTimeout(() => {
      live.flushTimer = undefined;
      void flush(live);
    }, flushMs);
  };

  const onEvent = (live: Live, event: ProgressEvent) => {
    const at = Date.parse(event.at);
    const when = Number.isNaN(at) ? clock().getTime() : at;
    live.lastEventAt = when;
    const payload = event.payload as Record<string, unknown> | null;
    if (event.kind === 'tool' && payload) {
      const tool = payload as unknown as ToolPayload;
      if (tool.phase === 'start') {
        live.tools.set(tool.toolUseId, { name: tool.name, since: when });
        live.recent.push({ name: tool.name, summary: tool.summary, action: tool.action });
        if (live.recent.length > RECENT_TOOLS) live.recent.shift();
      } else {
        live.tools.delete(tool.toolUseId);
      }
    } else if (event.kind === 'file') {
      live.lastFileAt = when;
    } else if (event.kind === 'plan' && payload) {
      const steps = (payload as unknown as PlanPayload).steps ?? [];
      const advanced = steps.some(
        (s) => (STEP_RANK[s.state] ?? 0) > (STEP_RANK[live.plan.get(s.title) ?? 'pending'] ?? 0),
      );
      if (advanced) live.lastStepAt = when;
      live.plan = new Map(steps.map((s) => [s.title, s.state]));
    } else if (event.kind === 'say' && typeof payload?.text === 'string') {
      live.says.push(payload.text);
      if (live.says.length > SAYS_KEPT) live.says.shift();
    }
    live.pending.push(event);
    scheduleFlush(live);
  };

  const onRateLimit = (live: Live, reading: RateLimitReading) => {
    const windows = readingsFromRateLimit(reading, { poolId: live.poolId });
    if (!windows?.length) return;
    // 会话里顺带读到的只是几个窗口：complete=false，不标别的窗口过期、不算一次读成。
    void savePoolQuota(db, {
      poolId: live.poolId,
      readAt: reading.observedAt,
      complete: false,
      windows,
    }).catch((error: unknown) => {
      live.quotaError ??= errorText(error);
    });
  };

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
    why: string,
  ): Promise<RelayFacts> {
    const progress = prior ? await runProgressFacts(db, prior.id, { saysLimit: 8 }) : null;
    const delivery = (kind === 'delivery' || isLeadKind(kind)) && base !== undefined && SHA.test(base);
    return {
      steps: progress?.lastPlan?.steps ?? [],
      says: (progress?.says ?? []).map((s) => s.text).filter(Boolean),
      commits: delivery ? await commitsSince(t, base, 30) : [],
      diffstat: delivery ? await diffstatSince(t, base) : [],
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

  async function startSession(input: LaunchSessionInput, ctx: Parameters<EnginePorts['startSession']>[1]) {
    const known = registry.get(input.runId);
    if (known) return resultOf(known, await known.spawned);

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
    // 流程配置副本也先核（flow-gate.ts）：坏了、太旧不起；写码阶段项目没写测试命令明确失败。交代的命令记进这一行，交活认它
    const testCommand = sessionTestCommandOrStop(task, input.stage, clock());
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
            prior?.failureMessage ? `${why}；${prior.failureMessage}` : why,
          )
        : undefined;
    const prompt = stagePrompt({
      stage: input.stage,
      brief: input.brief,
      repo: task.repo,
      issueNumber: task.issueNumber,
      mode,
      previousProblem: prior?.failureMessage ?? undefined,
      relay,
    });
    // 发给别家的（开 PR 前验证，Fusion 按简报派给别家的副手……）：整份提示词（这次真要发的那一份，续会话、接力的也算）
    // 先过卫生检查，过不了不起会话。简报是 Lead 写的，没进过公开的地方
    if (kind === 'verify' || otherVendor(input.route.family)) {
      screenForOtherVendor(
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
    // 临时目录紧挨着起进程建：从这里起，不管起没起来、怎么收场，插头一收场就删（下面的 live.cleaned）。
    // 建不成照工作树建不成一样报 ADOPT_FAILED；同一个 runId 重试时它在就改属主（帮手的 adopt 可重入）。
    await trees.adopt(tmpDir, user);

    const abort = new AbortController();
    let spawnResolve!: (info: SpawnInfo) => void;
    let spawnReject!: (error: unknown) => void;
    const spawned = new Promise<SpawnInfo>((resolve, reject) => {
      spawnResolve = resolve;
      spawnReject = reject;
    });
    spawned.catch(() => undefined);
    const live: Live = {
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
      reviewHead: input.brief.head,
      verifyCriteria: input.brief.verify?.criteria,
      previousCost: mode === 'resume' ? (prior?.sessionCostUsd ?? null) : undefined,
      startedAt: clock().getTime(),
      spawned,
      report: Promise.resolve(undefined as unknown as HostReport),
      cleaned: Promise.resolve(),
      abort,
      stop: undefined,
      pending: [],
      flushTimer: undefined,
      flushing: Promise.resolve(),
      writeError: undefined,
      dropped: 0,
      lastEventAt: null,
      lastStepAt: undefined,
      lastFileAt: undefined,
      tools: new Map(),
      recent: [],
      says: [],
      plan: new Map(),
      quotaError: undefined,
    };
    const cgroup: CgroupScope = { id: input.runId, user, limits, ...helperOpts };
    registry.set(input.runId, live);
    let spawnedYet = false;
    live.report = driver
      .run(
        {
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
          },
          testCommands: task.repo.testCommand ? [task.repo.testCommand] : [],
          cgroup,
          model: route.upstreamModel ?? route.modelId,
          session,
          // 会话用户读不到引擎的配置和机器人凭据（design 第十四节），无头会话没人批权限：放开（驱动按执行方式给参数）。
          purpose: 'work',
        },
        {
          signal: abort.signal,
          ...(deps.now ? { now: deps.now } : {}),
          onEvent: (e) => onEvent(live, e),
          onRateLimit: (reading) => onRateLimit(live, reading),
          onSpawn: (info) => {
            spawnedYet = true;
            spawnResolve(info);
          },
          // cursor 开新会话：真号到了才知道。先到的算（插头续会话时对不上的号不报，直接停）。
          onSessionId: (id) => {
            live.agentSessionId ??= id;
          },
        },
      )
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
      const commits = head === base ? [] : await commitsSince(t, base, 50);
      if (commits.length === 0) {
        return {
          check: {
            state: 'not_delivered',
            target,
            newCommits: 0,
            detail: `起会话前的头 ${base.slice(0, 7)} 之后没有新提交`,
          },
          head,
          changed: [],
        };
      }
      const changed = await changedFilesSince(t, base);
      if (changed.length === 0) {
        return {
          check: {
            state: 'not_delivered',
            target,
            newCommits: commits.length,
            hasDiff: false,
            detail: '有新提交，但和起会话前比没有内容差异',
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
    const changedFiles = commits && head !== base ? await changedFilesSince(t, base) : [];
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

    if (live.stop?.kind === 'stop') return { ...common, outcome: 'stopped' };
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
      if (verdict.outcome !== 'ok') return failed(verdict.reason, verdict.detail);
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
    if (verdict.outcome !== 'ok') return failed(verdict.reason, verdict.detail);
    const output = await readOutput(live);
    if ('error' in output) return failed('wrong_output', output.error);
    return { ...common, outcome: 'done', output: output.ok };
  }

  async function awaitSession(input: AwaitSessionInput, ctx: Parameters<EnginePorts['awaitSession']>[1]) {
    const live = registry.get(input.runId);
    if (!live || live.sessionId !== input.sessionId) {
      // 接不上：工人重启过（会话的输出管道已经断了）。按记下的 scope 收掉旧会话，交回 SESSION_LOST，工作流续会话重起。
      const stored = await getSessionRun(db, input.runId);
      const user = asSessionUser(stored?.runAsUser);
      const handle = input.handle ?? stored?.handle ?? undefined;
      const reaped = await reapLost(input.runId, user, handle);
      // 旧会话的临时目录跟着删：续会话是新的 runId、新的临时目录，这一个没人再用
      await removeTmp(input.runId);
      const message = `接不上会话 ${input.sessionId}：引擎工人重启过，输出管道断了${reaped}`;
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

    let nextStall = Date.now() + stallCheckMs;
    let settled = false;
    const ended = live.report.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
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

  async function stopSession(input: Parameters<EnginePorts['stopSession']>[0]) {
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
  }

  async function reapOrphanSessions(): Promise<number> {
    const listed = await listAgentScopes(helperOpts);
    if (!listed.ok) {
      throw new Error(`查不了上一轮留下的会话（fleet-agent-scope list）：${listed.detail}`);
    }
    let reaped = 0;
    for (const scope of listed.scopes) {
      if (scope.state === 'inactive') continue;
      // stop 只按编号收；用户只过帮手参数的校验。
      const error = await stopScope({ id: scope.id, user: SESSION_USERS[0], ...helperOpts });
      if (error) throw new Error(`收不掉上一轮留下的会话 ${scope.id}：${error}`);
      reaped += 1;
    }
    // 会话都收了：它们的临时目录（上一轮没来得及删的、工人被强杀时在跑的）一起清掉
    const swept = await sweepTmp();
    if (swept > 0) log(`删掉上一轮会话留下的临时目录 ${swept} 个`);
    return reaped;
  }

  return { startSession, awaitSession, stopSession, reapOrphanSessions };
}

/** 选路那边认的前缀，从这里也导出一份：session 端口写、store 端口读，同一个常量。 */
export { POOL_HOLD_PREFIX };
