// 会话端口按执行方式分派（design 第九节「执行方式」）。每种执行方式一个驱动，管三件事：拼起会话的参数、跑插头、把插头的
// 报告整理成同一个形状（HostReport）。起会话、看守、结局判定、失败分流、记账（sessions.ts）和路由探针（route-probe.ts）
// 只认这个形状，不认哪一家的报告。接上的执行方式就是 WIRED_HOSTS：别的执行方式会话端口明确报 HOST_NOT_WIRED，
// 选路不派（store-ports.ts），探针记 not_wired。
//
// 各家的不同都收在驱动里：
// - Claude Code（经 reclaude）：会话号由我们定（--session-id）；换了账号池还能 fork 续；终帧报会话累计花费、实际回话的模型、
//   上下文大小，流里有额度读数（带清零时刻）。会话用户按账号池定（pools.run_as_user：它绑着 reclaude 组织）。
// - cursor-agent：开新会话的会话号是它在 init 帧里自己起的，事先定不了——先回一个一眼看得出不是 UUID 的临时号
//   （cursor-pending:<runId>），真号一到经 onSessionId 报上来。没有 fork：换了账号池一律开新会话带接力任务书。终帧只报
//   这一轮的 token（含缓存读写），没有花费、没有实际模型（init 里的 model 是界面名，docs/reference/adapters.md CU-08）。
//   认证、额度、网络的报错只在 stderr（退出 1、没有 JSON）：原话放进 rawError，失败信息里带上，失败分流靠它认。
//   Cursor 的池不绑会话用户（库里约束会话用户和 reclaude 组织类型同有同无），跑在法国唯一的会话用户下。认证用 API 密钥
//   （创始人 2026-09-27 拍：浏览器登录在没有桌面的服务器上存不下，docs/ops.md 第五节）：密钥是会话用户家里的一个文件，
//   引擎进不去它的家（750），帮手脚本也不放 FLEET_* 以外的变量（adapters 的 scopeLaunch）——所以由会话用户自己在起
//   cursor-agent 的那一步读它、放进环境（cursorLaunchCommand 的前一段）。值只在 cursor-agent 的环境里：不上命令行、
//   不进日志、进度、失败信息和库。
//   cursor-agent 装在会话用户家里、不在 PATH 上，升级会删掉旧版本目录：每次起都由会话用户自己按 current → 最新版本目录现找
//   （cursorLaunchCommand 的后一段，CU-03）。
// - grok（SuperGrok 订阅的 Grok Build 命令行，#266）：会话号由我们定（-s <UUID>，续会话 -r），终帧回同一个号和实际模型
//   （grok-4.7-build 这种带渠道后缀的名字，插头认得）。但号是我们定的不等于会话建成了：没登录、起不来、点的型号不认时它在
//   开会话之前就退出，拿这个号 -r 只会报「not found」——所以开新会话时这个号先不算数，见到它真开了会话（终帧，或报错以外的
//   任何一帧）才交回工作流（grokReport），没开成就交空串、下次开新会话。没有我们用得上的 fork：换了账号池一律接力。终帧里
//   没有回答正文，回答是插头攒的最后一段话。认证是会话用户家里的登录态（~/.grok/auth.json，官方安装脚本、device code 登录，
//   普通文件、没有桌面也存得下，grok 自己续期）；没登录、过期了在 error 帧和 stderr 里说「Not signed in」「Run `grok login`」，
//   失败分流按 AU7 认。和 Cursor 一样不绑会话用户、跑在法国唯一的会话用户下；装在他家里的 ~/.grok/bin/grok，由会话用户自己
//   看它是不是能跑的文件（grokLaunchCommand），不是就报没装。
// - mirasim（#345，只留「中继额度」路由的薄插头，design 第三节第 12 条）：和前三家都不同——不是我们 spawn 一个子进程，
//   而是引擎自己的进程（fleet 用户）经回环 ws 连一份「已经在跑」的 Mirasim 服务；工具是在那份服务的进程里执行的，所以
//   design 第十四节要求给会话用户单独起一份（登录一次），不借旧系统那份——配好之前这条路由保持关闭（目录样例的 enabled）。
//   服务端认的是「执行体」（agent：claude / codex / pi / dsh……），不是路由的模型 id；模型串→执行体的对应表见
//   MIRASIM_AGENT_BY_MODEL，认不出的模型串明确报错，不落到某个默认执行体上。只留「中转」这一种路由（route: 'cloud'，
//   MS-28：不许反代，只能用官方客户端），所以结束后一定要给账本目录（ledgerDir）：账本没读成、没查到起针之后的 2xx
//   都算「中转没查成」（relayUnknown，进 facts，DL3 挂起报警），不当成会话真交了活。
//   会话号不是我们起的：server 的 accepted 帧回 sessionKey（<agent>:<uuid>），事先给不出，和 cursor 一样先回一个一眼看得出
//   不是真号的临时号（MIRASIM_PENDING_PREFIX），真号经 onAccepted → onSessionId 报上来。没有 fork（换了账号池一律接力）。
//   令牌文件、账本都在这份服务的用户家里（~/.mirasim/run/local-<端口>.token、~/.mirasim/traffic），引擎自己的进程进不去
//   那个家（750）：连接工厂（mirasimConnect）、读账本（mirasimLedgerFs）在生产装配里都经 exec 帮手以那个会话用户读，
//   不直接读本机文件（real/index.ts）。
//   协议没有「探针模式」这种权限旗标（不像 Claude 的 dontAsk、cursor 的 --force、grok 的 --always-approve）：探针能不能
//   不跑工具全靠 PROBE_PROMPT 那句「不要调用任何工具」，服务端那边会不会听不是我们控制得了的——这是协议本身的限制，
//   不是漏接了什么。
import { randomUUID } from 'node:crypto';
import {
  type AgentRunOptions,
  type CgroupScope,
  type ClaudeCodeRunOptions,
  type ClaudeCodeRunReport,
  type ClaudeCodeRunSpec,
  type CursorRunOptions,
  type CursorRunReport,
  type CursorRunSpec,
  claudeRunFacts,
  cursorRunFacts,
  type GrokRunReport,
  type GrokRunSpec,
  grokRunFacts,
  type LedgerFs,
  type MirasimConnect,
  type MirasimRunOptions,
  type MirasimRunReport,
  type MirasimRunSpec,
  mirasimRunSummary,
  type ProcessLimits,
  type RateLimitReading,
  type RunFacts,
  runClaudeCode,
  runCursorAgent,
  runGrok,
  runMirasim,
  SESSION_USERS,
  type SessionEnvInput,
  type SessionUser,
  type SpawnInfo,
} from '@fleet-dao/adapters';
import type { HostId, ProgressEvent } from '@fleet-dao/shared';
import { hostName } from '../routing/names.ts';

/** 引擎接上的执行方式。加一家：写它的驱动，探针跟着就能探、选路跟着就派。 */
export const WIRED_HOSTS = [
  'claude-code',
  'cursor-agent',
  'grok',
  'mirasim',
] as const satisfies readonly HostId[];
export type WiredHost = (typeof WIRED_HOSTS)[number];

export function isWiredHost(hostId: string): hostId is WiredHost {
  return (WIRED_HOSTS as readonly string[]).includes(hostId);
}

/** 「Claude Code、Cursor Agent、Grok 命令行、Mirasim」：没接上的报错、探针的原因里用。 */
export function wiredHostNames(): string {
  return WIRED_HOSTS.map(hostName).join('、');
}

/** 接着干的方式：new 开新会话；resume 续上原会话；fork 从原会话分出一个新号（只有 Claude）；relay 开新会话带接力任务书。 */
export type ContinueMode = 'new' | 'resume' | 'fork' | 'relay';

/** 交给插头的会话：new 的 id 是我们起的号（cursor 用不上：它自己起）；resume 续 id；fork 从 from 分出新号 id。 */
export type HostSession =
  | { mode: 'new'; id: string }
  | { mode: 'resume'; id: string }
  | { mode: 'fork'; from: string; id: string };

export interface HostRunSpec {
  runId: string;
  user: SessionUser;
  cwd: string;
  prompt: string;
  env: SessionEnvInput;
  limits: Partial<ProcessLimits>;
  testCommands: readonly string[];
  cgroup: CgroupScope;
  /** 发给执行体的模型串：路由的 upstream_model，没有就用模型 id。 */
  model: string;
  session: HostSession;
  /**
   * work = 干活的会话：命令一律放行（会话用户读不到引擎的配置和机器人凭据，design 第十四节；无头会话没人批权限）；
   * probe = 路由探针：一个命令都不许跑，能不存会话记录就不存。
   */
  purpose: 'work' | 'probe';
}

export interface HostRunHooks {
  signal?: AbortSignal;
  now?: () => Date;
  onEvent?: (event: ProgressEvent) => unknown;
  onRateLimit?: (reading: RateLimitReading) => unknown;
  onSpawn?: (info: SpawnInfo) => unknown;
  /** 执行体报出自己的会话号（cursor 的 init 帧）。同步调，别抛。 */
  onSessionId?: (id: string) => void;
}

/** 这一轮的 token（终帧报的）。读不到的字段不给，不记成 0。 */
export interface HostUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** 各家插头的报告整理成的同一个形状。只有某一家有的字段，别家不给（读不到的不当成 0）。 */
export interface HostReport {
  hostId: WiredHost;
  /** 判定事实（各家插头的 xxxRunFacts）：判法只有 judgeRun 一份。 */
  facts: RunFacts;
  /**
   * 执行体报的会话号：Claude 就是我们给的那个；cursor 是它 init 帧（或终帧）里的；grok 是我们给的那个、它真开了会话才给
   * （终帧回的，或者见到了报错以外的帧）。没读到、没开成不给。
   */
  sessionId?: string;
  usage: HostUsage;
  /** 只有 Claude 报：会话累计花费（续会话含前几轮）、会话结束时的上下文大小。 */
  sessionCostUsd?: number;
  /** 实际回话的模型：Claude 流里的、grok 终帧 modelUsage 的键（grok-4.7-build）；cursor 没有。 */
  actualModel?: string;
  contextTokens?: number;
  /** 额度用满时上游给的清零时刻（Claude 流里的额度读数）。 */
  resetsAt?: string;
  /** 上游的 HTTP 状态码（Claude 终帧的 api_error_status）。 */
  httpStatus?: number;
  /** 终帧里的回答（探针看它是不是只回了 OK；grok 的终帧没有正文，是插头攒的最后一段话）。 */
  answer?: string;
  /**
   * 判定原因里没有的报错原话（cursor 的认证、额度、网络报错只在 stderr：退出 1、没有 JSON；grok 的在 error 帧和 stderr）：
   * 失败信息里没有就接上，失败分流靠它认出是哪一种。Claude 的报错在流里、已经在判定原因里，不给。
   */
  rawError?: string;
  wallMs: number;
  stderrTail: string;
}

export interface HostDriver {
  hostId: WiredHost;
  /**
   * 会话用户从哪来。pool：账号池定（Claude：pools.run_as_user 绑着 reclaude 组织，没定就起不了）；
   * sole：不绑池，用法国唯一的会话用户（它家里登好了这一家）。
   */
  userFrom: 'pool' | 'sole';
  /** 换了账号池能不能 fork 续（Claude 能；cursor、grok 不能，换池一律接力）。 */
  canFork: boolean;
  /**
   * 开新会话、fork 时用的会话号。known = 起来就算数，结局照它交回工作流（Claude）；不是的要等执行体报上来才算：cursor 给的
   * 是临时号、真号 init 帧里给；grok 的号是我们给的（-s），但登录不上、起不来时它根本没建这个会话，看它开没开成（grokReport）。
   */
  newSessionId(runId: string): { id: string; known: boolean };
  run(spec: HostRunSpec, hooks: HostRunHooks): Promise<HostReport>;
  /** 登录失效时人该怎么修（规则表里通用的登录失效 AU2 管各家的登录，没写修法）。 */
  loginFix(machine: string, user: string): string;
}

/** 起插头的函数：生产是 runClaudeCode / runCursorAgent / runGrok / runMirasim；测试按执行方式给假插头（不起真执行体）。 */
export interface HostRunners {
  'claude-code'?: (spec: ClaudeCodeRunSpec, options: ClaudeCodeRunOptions) => Promise<ClaudeCodeRunReport>;
  'cursor-agent'?: (spec: CursorRunSpec, options: CursorRunOptions) => Promise<CursorRunReport>;
  grok?: (spec: GrokRunSpec, options: AgentRunOptions) => Promise<GrokRunReport>;
  mirasim?: (spec: MirasimRunSpec, options: MirasimRunOptions) => Promise<MirasimRunReport>;
}

export interface HostDriverDeps {
  /** 起 Claude Code 的命令（绝对路径）：reclaude 装在会话用户自己家里。 */
  claudeCommand(user: SessionUser): string[];
  /** 起 cursor-agent 的命令（绝对路径）：装在会话用户自己家里，生产用 cursorLaunchCommand 现找版本目录。 */
  cursorCommand(user: SessionUser): string[];
  /** 起 grok 的命令（绝对路径）：装在会话用户自己家里，生产用 grokLaunchCommand 先看在不在。 */
  grokCommand(user: SessionUser): string[];
  /**
   * 连到这个会话用户自己的 Mirasim 服务（给他单独起的那份，design 第十四节）：不是起命令，是开一条到本机回环的 ws；
   * 每次起会话都现连（重试、读令牌的活见 adapters 的 mirasimConnector）。生产装配见 real/index.ts。
   */
  mirasimConnect(user: SessionUser): MirasimConnect;
  /** 这个会话用户的 Mirasim 账本目录（他家里的 ~/.mirasim/traffic）：中转路由结束后核实走没走上游（MS-27）。 */
  mirasimLedgerDir(user: SessionUser): string;
  /** 读账本用：引擎自己的进程进不去会话用户的家（750），经这个以他的身份读（real/index.ts 的生产装配）。 */
  mirasimLedgerFs(user: SessionUser): LedgerFs;
  run?: HostRunners;
}

export function hostDrivers(deps: HostDriverDeps): Record<WiredHost, HostDriver> {
  return {
    'claude-code': claudeDriver(deps.claudeCommand, deps.run?.['claude-code'] ?? runClaudeCode),
    'cursor-agent': cursorDriver(deps.cursorCommand, deps.run?.['cursor-agent'] ?? runCursorAgent),
    grok: grokDriver(deps.grokCommand, deps.run?.grok ?? runGrok),
    mirasim: mirasimDriver(
      deps.mirasimConnect,
      deps.mirasimLedgerDir,
      deps.mirasimLedgerFs,
      deps.run?.mirasim ?? runMirasim,
    ),
  };
}

/**
 * 以哪个会话用户起：池上定了的照池；不绑池的执行方式用法国唯一的会话用户。定了却不认识、该绑没绑、会话用户不止一个
 * 不知道用哪个，都返回缺什么（调用方明确报错，不瞎挑一个）。
 */
export function sessionUserOf(
  driver: Pick<HostDriver, 'userFrom'>,
  runAsUser: string | null,
  /** 现在的会话用户（测试用：造「不止一个」「一个都没有」）。 */
  all: readonly SessionUser[] = SESSION_USERS,
): { user: SessionUser } | { missing: string } {
  if (runAsUser) {
    const bound = all.find((u) => u === runAsUser);
    return bound
      ? { user: bound }
      : { missing: `定的会话用户 ${runAsUser} 不是现在的会话用户（${all.join('、')}）` };
  }
  if (driver.userFrom === 'pool') return { missing: '没定会话用户（pools.run_as_user 是空的）' };
  const [sole, ...more] = all;
  if (!sole || more.length > 0) {
    return { missing: `没绑会话用户，会话用户又不止一个（${all.join('、')}），不知道以谁起` };
  }
  return { user: sole };
}

function defined<K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> {
  return value === undefined || value === null ? {} : ({ [key]: value } as Record<K, V>);
}

/** 插头的公共回调（onSessionId 另给：只有 cursor 的插头认它）。不给的不带，不传 undefined 进去。 */
function agentHooks(command: string[], hooks: HostRunHooks): ClaudeCodeRunOptions {
  return {
    command,
    ...(hooks.signal ? { signal: hooks.signal } : {}),
    ...(hooks.now ? { now: hooks.now } : {}),
    ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
    ...(hooks.onRateLimit ? { onRateLimit: hooks.onRateLimit } : {}),
    ...(hooks.onSpawn ? { onSpawn: hooks.onSpawn } : {}),
  };
}

// ---- Claude Code

function claudeDriver(
  command: (user: SessionUser) => string[],
  run: NonNullable<HostRunners['claude-code']>,
): HostDriver {
  return {
    hostId: 'claude-code',
    userFrom: 'pool',
    canFork: true,
    newSessionId: () => ({ id: randomUUID(), known: true }),
    async run(spec, hooks) {
      const report = await run(
        {
          runId: spec.runId,
          cwd: spec.cwd,
          prompt: spec.prompt,
          env: spec.env,
          limits: spec.limits,
          testCommands: spec.testCommands,
          cgroup: spec.cgroup,
          model: spec.model,
          session: spec.session,
          // 探针一个工具都不给（dontAsk）、不存会话记录（每 15 分钟一次，不往会话用户家里攒）
          ...(spec.purpose === 'probe'
            ? { permissionMode: 'dontAsk' as const, persistSession: false }
            : { permissionMode: 'bypassPermissions' as const }),
        },
        agentHooks(command(spec.user), hooks),
      );
      return claudeReport(report);
    },
    loginFix: (machine, user) =>
      `在${machine}上以 ${user} 重跑 reclaude login（docs/ops.md 第五节），在浏览器里批准`,
  };
}

export function claudeReport(report: ClaudeCodeRunReport): HostReport {
  const r = report.stream.result;
  const exhausted = [...report.stream.rateLimits].reverse().find((x) => x.exhausted);
  const resetsAt =
    exhausted?.resetsAt ?? exhausted?.windows.find((w) => w.name === exhausted.rateLimitType)?.resetsAt;
  return {
    hostId: 'claude-code',
    facts: claudeRunFacts(report),
    ...defined('sessionId', report.stream.sessionId),
    usage: {
      ...defined('inputTokens', r?.usage?.inputTokens),
      ...defined('outputTokens', r?.usage?.outputTokens),
      ...defined('cacheReadTokens', r?.usage?.cacheReadInputTokens),
      ...defined('cacheWriteTokens', r?.usage?.cacheCreationInputTokens),
    },
    ...defined('sessionCostUsd', r?.sessionCostUsd),
    ...defined('actualModel', report.stream.observedModel),
    ...defined('contextTokens', report.stream.lastContextTokens),
    ...defined('resetsAt', resetsAt),
    ...defined('httpStatus', r?.apiErrorStatus),
    ...defined('answer', r?.text),
    wallMs: report.wallMs,
    stderrTail: report.stderrTail,
  };
}

// ---- cursor-agent

/** 开新会话时先回的临时号的前缀：一眼看得出不是 UUID，拿它续会话会被认出来、改走接力。 */
export const CURSOR_PENDING_PREFIX = 'cursor-pending:';

/** 会话用户家里 cursor-agent 的版本目录（{user} 换成会话用户）：官方安装脚本装在这下面，一个版本一个目录。 */
export const DEFAULT_CURSOR_VERSIONS_DIR = '/home/{user}/.local/share/cursor-agent/versions';

/**
 * 会话用户家里放 Cursor API 密钥的文件（{user} 换成会话用户）：属它、600、只有一行密钥、不带换行（docs/ops.md 第五节
 * 「会话用户的 Cursor 密钥」）。不做成配置：放密钥的命令、装机脚本的读回都认这一处（deploy/lib/cursor-key.sh 的
 * CURSOR_API_KEY_FILE，hosts.test.ts 核对两边一样）。
 */
export const DEFAULT_CURSOR_API_KEY_FILE = '/home/{user}/.cursor/fleet-api-key';

/** 没装时 stderr 那句的开头：和 Node 起不来时的原话一个样子，失败分流按「执行方式或路由配置不对」（CF1）认。 */
export const CURSOR_MISSING = 'spawn cursor-agent ENOENT';

/** 密钥文件没放好时 stderr 那句的开头：失败分流按它认成 AU6（整池暂停，照原因放好再继续）。 */
export const CURSOR_KEY_BAD = 'Cursor 密钥没放好';
/** 密钥文件没放好时的退出码（sysexits 的 EX_CONFIG）：和没装（127）、cursor-agent 自己的退出码分得开。 */
export const CURSOR_KEY_EXIT = 78;

// 两段都一行写完：命令行要经 sudo（会记日志），不带换行这类控制字符。
//
// 前一段：以会话用户的身份读它家里的密钥文件，export 成 CURSOR_API_KEY，再 exec 后面的命令（后一段）。值只在这个进程的变量
// 和 cursor-agent 的环境里：cat 的参数只有路径，报错只报路径、属主、权限，不打值。判据和装机脚本的读回一样
// （deploy/lib/cursor-key.sh 的 check_cursor_key：不是符号链接、是普通文件、非空、属会话用户自己、600），另外核内容：只该是
// 一行密钥（末尾最多一个换行），里面有空白、换行、控制字符（Windows 的回车）都不认——不然交给 Cursor 去报「密钥无效」，
// 人会白换一把。
// 没放好就报「Cursor 密钥没放好：<哪里不对>。文件是 <路径>，…」、退出 78，不起 cursor-agent，也不去试浏览器登录。哪里不对
// 紧跟在开头那句后面、到句号为止：失败分流（AU6）把这一段摘进「要人拍」的提醒，人不用翻日志就知道要改什么。
const CURSOR_KEY_SCRIPT = [
  'key=$1',
  'shift',
  `bad() { echo "${CURSOR_KEY_BAD}：$1。文件是 $key，照 docs/ops.md 第五节「会话用户的 Cursor 密钥」放好" >&2; exit ${CURSOR_KEY_EXIT}; }`,
  'if [ -L "$key" ]; then bad "是符号链接，只认真文件"; fi',
  'if [ ! -e "$key" ]; then bad "不在"; fi',
  'if [ ! -f "$key" ]; then bad "不是普通文件"; fi',
  'if [ ! -s "$key" ]; then bad "是空的"; fi',
  'uid=$(stat -c %u -- "$key" 2>/dev/null) && mode=$(stat -c %a -- "$key" 2>/dev/null) || bad "查不了属主和权限，stat 没跑成"',
  'me=$(id -u)',
  'if [ "$uid" != "$me" ]; then bad "属主不对：是 uid $uid，要是会话用户自己的 uid $me"; fi',
  'if [ "$mode" != 600 ]; then bad "权限是 $mode，要 600"; fi',
  // $(cat) 会把末尾的换行全去掉：只放过末尾那一个（echo 写进去的），先数一遍，多了就是两行或末尾多了空行
  'n=$(wc -l < "$key" 2>/dev/null) || bad "读不了"',
  'if [ "$n" -gt 1 ]; then bad "有 $n 个换行，只该是一行密钥、末尾最多一个换行"; fi',
  'k=$(cat -- "$key" 2>/dev/null) || bad "读不了"',
  'case $k in "") bad "只有换行，没有密钥" ;; *[[:space:]]* | *[[:cntrl:]]*) bad "里面有空白、换行或控制字符，只该是一行密钥、不带换行" ;; esac',
  'CURSOR_API_KEY=$k',
  'export CURSOR_API_KEY',
  'exec "$@"',
].join('; ');

// 后一段：版本目录名只认「数字.数字」开头的（2026.09.23-86fc751 这种；安装时下载的临时包是 UUID 起名的，不认），按版本号
// 倒序（sort -V：月、日不补零也排得对），里面有能跑的 cursor-agent 才算；找到就 exec 成 cursor-agent（进程号不变，还是插头
// 拿着的那一个）。
const CURSOR_FIND_SCRIPT = [
  'dir=$1',
  'shift',
  'bin=',
  'if [ -x "$dir/current/cursor-agent" ]; then bin=$dir/current/cursor-agent; else for v in $(ls -1 "$dir" 2>/dev/null | grep -E \'^[0-9]+\\.[0-9][0-9A-Za-z._-]*$\' | sort -rV); do if [ -x "$dir/$v/cursor-agent" ]; then bin=$dir/$v/cursor-agent; break; fi; done; fi',
  `if [ -z "$bin" ]; then echo "${CURSOR_MISSING}：$dir 下既没有 current，也没有能跑的版本目录（会话用户家里没装 cursor-agent）" >&2; exit 127; fi`,
  'exec "$bin" "$@"',
].join('; ');

/** 前一段（读密钥）在命令里占几项：后一段（找 cursor-agent）从这里开始。 */
export const CURSOR_KEY_STAGE_LENGTH = 5;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要拦控制字符
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * 起 cursor-agent 的命令，两段接力、都以会话用户的身份跑：先从它家里的密钥文件读出 API 密钥、放进环境，再现找 current →
 * 最新版本目录（CU-03：升级会删掉旧版本目录，钉死一个版本会起不来）、exec 成 cursor-agent。路径经参数传给脚本，不拼进脚本
 * （没有注入）；插头的参数接在后面，原样交给 cursor-agent。
 */
export function cursorLaunchCommand(versionsDir: string, apiKeyFile: string): string[] {
  for (const [what, path] of [
    ['版本目录', versionsDir],
    ['密钥文件', apiKeyFile],
  ] as const) {
    if (!path.startsWith('/')) throw new Error(`cursor-agent 的${what}要写绝对路径：${path}`);
    if (CONTROL_CHAR.test(path)) throw new Error(`cursor-agent 的${what}里有控制字符，不写上命令行`);
  }
  return [
    '/bin/sh',
    '-c',
    CURSOR_KEY_SCRIPT,
    'cursor-key',
    apiKeyFile,
    '/bin/sh',
    '-c',
    CURSOR_FIND_SCRIPT,
    'cursor-agent',
    versionsDir,
  ];
}

function cursorDriver(
  command: (user: SessionUser) => string[],
  run: NonNullable<HostRunners['cursor-agent']>,
): HostDriver {
  return {
    hostId: 'cursor-agent',
    userFrom: 'sole',
    canFork: false,
    newSessionId: (runId) => ({ id: `${CURSOR_PENDING_PREFIX}${runId}`, known: false }),
    async run(spec, hooks) {
      if (spec.session.mode === 'fork') {
        throw new Error('cursor-agent 没有 fork：换了账号池要开新会话带接力任务书');
      }
      const report = await run(
        {
          runId: spec.runId,
          cwd: spec.cwd,
          prompt: spec.prompt,
          model: spec.model,
          session: spec.session.mode === 'resume' ? { mode: 'resume', id: spec.session.id } : { mode: 'new' },
          // 干活的会话照 Claude 的理由放开命令（--force）；探针不放，什么命令都不许跑。不管放不放，插头都带 --trust（只信任
          // 工作目录、不放开命令）：不带的话，没信任过的目录里 -p 只打一段 Workspace Trust 提示就退出（CU-01）
          force: spec.purpose === 'work',
          env: spec.env,
          limits: spec.limits,
          testCommands: spec.testCommands,
          cgroup: spec.cgroup,
        },
        {
          ...agentHooks(command(spec.user), hooks),
          ...(hooks.onSessionId ? { onSessionId: hooks.onSessionId } : {}),
        },
      );
      return cursorReport(report);
    },
    // 浏览器登录在没有桌面的服务器上存不下（docs/ops.md 第五节）：Cursor 的认证是会话用户家里的 API 密钥，修法是换一把
    loginFix: (machine, user) =>
      `去 Cursor 后台（cursor.com/dashboard/api）重新生成一把 API 密钥，照 docs/ops.md 第五节「会话用户的 Cursor 密钥」那条命令放进${machine}（${user} 家里的 ~/.cursor/fleet-api-key）`,
  };
}

export function cursorReport(report: CursorRunReport): HostReport {
  const r = report.stream.result;
  const facts = cursorRunFacts(report);
  return {
    hostId: 'cursor-agent',
    facts,
    ...defined('sessionId', report.stream.sessionId),
    usage: {
      ...defined('inputTokens', r?.usage?.inputTokens),
      ...defined('outputTokens', r?.usage?.outputTokens),
      ...defined('cacheReadTokens', r?.usage?.cacheReadTokens),
      ...defined('cacheWriteTokens', r?.usage?.cacheWriteTokens),
    },
    ...defined('answer', r?.text),
    ...defined('rawError', facts.lastWords),
    wallMs: report.wallMs,
    stderrTail: report.stderrTail,
  };
}

// ---- grok

/** 会话用户家里的 grok（{user} 换成会话用户）：官方安装脚本装在 ~/.grok/bin/grok（链到 ~/.grok/downloads 下的二进制）。 */
export const DEFAULT_GROK_BIN = '/home/{user}/.grok/bin/grok';

/** 没装时 stderr 那句的开头：和 Node 起不来时的原话一个样子，失败分流按「执行方式或路由配置不对」（CF1）认。 */
export const GROK_MISSING = 'spawn grok ENOENT';

// 一行写完（命令行要经 sudo 记日志）：以会话用户的身份看 grok 在不在、能不能跑（引擎进不去他的家，看不了），能跑就 exec 成它
// （进程号不变，还是插头拿着的那一个）；不在、不是文件（-x 对目录也成立）、不能跑就照没装报、退出 127。装机脚本的读回
// （deploy/lib/grok.sh 的 grok_version）照同一个判法。插头还会在它前面垫一个 cat：grok 从 /dev/stdin 读提示词要真管道，
// Node 给的是 socketpair（adapters 的 runGrok）。
const GROK_FIND_SCRIPT = [
  'bin=$1',
  'shift',
  `if [ ! -f "$bin" ] || [ ! -x "$bin" ]; then echo "${GROK_MISSING}：$bin 不在或不能跑（会话用户家里没装 grok 命令行，docs/ops.md 第五节「会话用户的 grok」）" >&2; exit 127; fi`,
  'exec "$bin" "$@"',
].join('; ');

/** 起 grok 的命令：以会话用户的身份先看它在不在，在就 exec 成它；位置经参数传给脚本，不拼进脚本。 */
export function grokLaunchCommand(bin: string): string[] {
  if (!bin.startsWith('/')) throw new Error(`grok 的位置要写绝对路径：${bin}`);
  if (CONTROL_CHAR.test(bin)) throw new Error('grok 的位置里有控制字符，不写上命令行');
  return ['/bin/sh', '-c', GROK_FIND_SCRIPT, 'grok', bin];
}

function grokDriver(
  command: (user: SessionUser) => string[],
  run: NonNullable<HostRunners['grok']>,
): HostDriver {
  return {
    hostId: 'grok',
    userFrom: 'sole',
    canFork: false,
    // 号是我们定的（-s），但它真开了会话才算数（grokReport）：没登录、起不来时拿它 -r 只会报 not found
    newSessionId: () => ({ id: randomUUID(), known: false }),
    async run(spec, hooks) {
      if (spec.session.mode === 'fork') {
        throw new Error('grok 不 fork：换了账号池要开新会话带接力任务书');
      }
      const report = await run(
        {
          runId: spec.runId,
          cwd: spec.cwd,
          prompt: spec.prompt,
          model: spec.model,
          session:
            spec.session.mode === 'resume'
              ? { mode: 'resume', id: spec.session.id }
              : { mode: 'new', id: spec.session.id },
          // 干活的会话照 Claude 的理由放开命令（--always-approve，GK-04）；探针不放：一个命令都不许跑
          alwaysApprove: spec.purpose === 'work',
          env: spec.env,
          limits: spec.limits,
          testCommands: spec.testCommands,
          cgroup: spec.cgroup,
        },
        agentHooks(command(spec.user), hooks),
      );
      return grokReport(report);
    },
    loginFix: (machine, user) =>
      `在${machine}上以 ${user} 跑 grok login --device-code（docs/ops.md 第五节「会话用户的 grok」），在任意设备的浏览器里打开它给的链接、确认那串码`,
  };
}

/**
 * grok 的报告整理成同一个形状。会话号：终帧回的那个；没有终帧（半路被停、断了）但见到了报错以外的帧，就是我们给它的那个
 * （它开会话之后才出帧：头一帧是 available_commands，法国真跑记录）；一帧都没有、只有 error 帧（没登录、起不来、型号不认，
 * 法国实跑 2026-09-27）就是没开成会话，不给——交回工作流的是空串，下次开新会话，不拿一个没建成的号去 -r（它报 not found）。
 */
export function grokReport(report: GrokRunReport): HostReport {
  const s = report.stream;
  const end = s.end;
  const facts = grokRunFacts(report);
  const opened = s.frames > s.errors.length;
  return {
    hostId: 'grok',
    facts,
    ...defined('sessionId', end?.sessionId ?? (opened ? report.session.id : undefined)),
    usage: {
      ...defined('inputTokens', end?.usage?.inputTokens),
      ...defined('outputTokens', end?.usage?.outputTokens),
      ...defined('cacheReadTokens', end?.usage?.cacheReadTokens),
      ...defined('cacheWriteTokens', end?.usage?.cacheWriteTokens),
    },
    ...defined('actualModel', end?.models[0]),
    ...defined('answer', report.stream.answer),
    ...defined('rawError', facts.lastWords),
    wallMs: report.wallMs,
    stderrTail: report.stderrTail,
  };
}

// ---- mirasim

/**
 * 路由的 upstreamModel → Mirasim 服务端认的执行体名（docs/reference/adapters.md 第五~七节；对应
 * deploy/examples/catalog.example.json 里 mirasim-relay 池现在的四条路由）。认不出的模型串明确报错、不落到某个默认
 * 执行体上——新增一条 Mirasim 路由时要把这张表也改了，不然只会在真起会话那一刻才报错（mirasimAgentFor 抛出）。
 */
export const MIRASIM_AGENT_BY_MODEL: Readonly<Record<string, string>> = {
  'claude-opus-5-5': 'claude',
  'gpt-5.6-luna': 'codex',
  'kimi-k3': 'pi',
  'deepseek-flash': 'dsh',
};

/** pi 起会话不带 model（吃服务端全局默认 agents.pi.model），只拿 expectModel 核对回读的快照符不符（PI-02）。 */
const MIRASIM_MODELLESS_AGENTS = new Set(['pi']);

/** 认不出的模型串明确报错（不瞎猜执行体）：故意造这条失败的测试见 hosts.test.ts「Mirasim 的驱动」。 */
export function mirasimAgentFor(upstreamModel: string): string {
  const agent = MIRASIM_AGENT_BY_MODEL[upstreamModel];
  if (!agent) {
    throw new Error(
      `Mirasim 认不出这个模型该起哪个执行体：${upstreamModel}（现在认得 ${Object.keys(MIRASIM_AGENT_BY_MODEL).join('、')}；新路由要把 MIRASIM_AGENT_BY_MODEL 也改了）`,
    );
  }
  return agent;
}

/** 会话号临时号的前缀：真号是服务端 accepted 帧回的 <agent>:<uuid>，起会话之前给不出（和 cursor 同一个道理）。 */
export const MIRASIM_PENDING_PREFIX = 'mirasim-pending:';

function mirasimDriver(
  connect: (user: SessionUser) => MirasimConnect,
  ledgerDir: (user: SessionUser) => string,
  ledgerFs: (user: SessionUser) => LedgerFs,
  run: NonNullable<HostRunners['mirasim']>,
): HostDriver {
  return {
    hostId: 'mirasim',
    userFrom: 'sole',
    canFork: false,
    newSessionId: (runId) => ({ id: `${MIRASIM_PENDING_PREFIX}${runId}`, known: false }),
    async run(spec, hooks) {
      if (spec.session.mode === 'fork') {
        throw new Error('Mirasim 没有 fork：换了账号池要开新会话带接力任务书');
      }
      const agent = mirasimAgentFor(spec.model);
      const report = await run(
        {
          runId: spec.runId,
          cwd: spec.cwd,
          prompt: spec.prompt,
          agent,
          // 只留「中继额度」这一种路由（design 第三节第 12 条；MS-28：不许反代，只能用官方客户端）
          route: 'cloud',
          ...(MIRASIM_MODELLESS_AGENTS.has(agent) ? { expectModel: spec.model } : { model: spec.model }),
          session:
            spec.session.mode === 'resume' ? { mode: 'resume', key: spec.session.id } : { mode: 'new' },
          testCommands: spec.testCommands,
        },
        {
          connect: connect(spec.user),
          ledgerDir: ledgerDir(spec.user),
          ledgerFs: ledgerFs(spec.user),
          ...(hooks.signal ? { signal: hooks.signal } : {}),
          ...(hooks.now ? { now: hooks.now } : {}),
          ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
          // 服务端 accepted 帧才给真会话号（和 cursor 的 init 帧一个道理）
          ...(hooks.onSessionId ? { onAccepted: (info) => hooks.onSessionId?.(info.sessionKey) } : {}),
        },
      );
      return mirasimReport(report);
    },
    loginFix: (machine, user) =>
      `用 Mirasim 桌面端以 SSH 远程模式连 ${user}@${machine}，把这个会话用户自己的 Mirasim 服务装起来、登一次账号（docs/ops.md 第五节「会话用户的 Mirasim」）`,
  };
}

/**
 * Mirasim 的报告整理成同一个形状。没有 stderrTail（协议是 ws 帧、不是子进程）：给空串，不冒充有过程记录可查。起没起来、
 * 中途停在哪、终帧的原因都已经在 facts 里（mirasimRunSummary → mirasimRunFacts；judgeRun 直接从 facts.spawnError /
 * launchUnknown / terminal 取详情），不重复进 rawError——和 Claude 一个道理（Claude 的报错也在流里，已经在判定原因里）。
 * 没有 sessionCostUsd、httpStatus、contextTokens：中转扣的是 Mirasim 账号额度，不折美元，也没有这几个概念。
 */
export function mirasimReport(report: MirasimRunReport): HostReport {
  const summary = mirasimRunSummary(report);
  const text = report.session.state.text.trim();
  return {
    hostId: 'mirasim',
    facts: summary.facts,
    ...defined('sessionId', summary.sessionId),
    usage: summary.usage,
    ...defined('actualModel', summary.actualModel),
    ...defined('answer', text || undefined),
    wallMs: report.wallMs,
    stderrTail: '',
  };
}
