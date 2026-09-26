// 会话端口按执行方式分派（design 第九节「执行方式」）。每种执行方式一个驱动，管三件事：拼起会话的参数、跑插头、把插头的
// 报告整理成同一个形状（HostReport）。起会话、看守、结局判定、失败分流、记账（sessions.ts）和路由探针（route-probe.ts）
// 只认这个形状，不认哪一家的报告。接上的执行方式就是 WIRED_HOSTS：别的执行方式会话端口明确报 HOST_NOT_WIRED，
// 选路不派（store-ports.ts），探针记 not_wired。
//
// 两家的不同都收在驱动里：
// - Claude Code（经 reclaude）：会话号由我们定（--session-id）；换了账号池还能 fork 续；终帧报会话累计花费、实际回话的模型、
//   上下文大小，流里有额度读数（带清零时刻）。会话用户按账号池定（pools.run_as_user：它绑着 reclaude 组织）。
// - cursor-agent：开新会话的会话号是它在 init 帧里自己起的，事先定不了——先回一个一眼看得出不是 UUID 的临时号
//   （cursor-pending:<runId>），真号一到经 onSessionId 报上来。没有 fork：换了账号池一律开新会话带接力任务书。终帧只报
//   这一轮的 token（含缓存读写），没有花费、没有实际模型（init 里的 model 是界面名，docs/reference/adapters.md CU-08）。
//   认证、额度、网络的报错只在 stderr（退出 1、没有 JSON）：原话放进 rawError，失败信息里带上，失败分流靠它认。
//   Cursor 的池不绑会话用户（库里约束会话用户和 reclaude 组织类型同有同无），跑在法国唯一的会话用户下：Cursor 的登录态在它
//   自己家里（它跑过一次 cursor-agent login），不往会话环境里塞 CURSOR_API_KEY（帮手脚本也不放，adapters 的 scopeLaunch）。
//   cursor-agent 装在会话用户家里、不在 PATH 上，升级会删掉旧版本目录：每次起都由会话用户自己按 current → 最新版本目录现找
//   （cursorLaunchCommand，CU-03）——引擎进不去会话用户的家（700），替它找不了。
import { randomUUID } from 'node:crypto';
import {
  type CgroupScope,
  type ClaudeCodeRunOptions,
  type ClaudeCodeRunReport,
  type ClaudeCodeRunSpec,
  type CursorRunOptions,
  type CursorRunReport,
  type CursorRunSpec,
  claudeRunFacts,
  cursorRunFacts,
  type ProcessLimits,
  type RateLimitReading,
  type RunFacts,
  runClaudeCode,
  runCursorAgent,
  SESSION_USERS,
  type SessionEnvInput,
  type SessionUser,
  type SpawnInfo,
} from '@fleet-dao/adapters';
import type { HostId, ProgressEvent } from '@fleet-dao/shared';
import { hostName } from '../routing/names.ts';

/** 引擎接上的执行方式。加一家：写它的驱动，探针跟着就能探、选路跟着就派。 */
export const WIRED_HOSTS = ['claude-code', 'cursor-agent'] as const satisfies readonly HostId[];
export type WiredHost = (typeof WIRED_HOSTS)[number];

export function isWiredHost(hostId: string): hostId is WiredHost {
  return (WIRED_HOSTS as readonly string[]).includes(hostId);
}

/** 「Claude Code、Cursor Agent」：没接上的报错、探针的原因里用。 */
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
  /** 执行体报的会话号：Claude 就是我们给的那个；cursor 是它 init 帧（或终帧）里的。没读到不给。 */
  sessionId?: string;
  usage: HostUsage;
  /** 只有 Claude 报：会话累计花费（续会话含前几轮）、实际回话的模型、会话结束时的上下文大小。 */
  sessionCostUsd?: number;
  actualModel?: string;
  contextTokens?: number;
  /** 额度用满时上游给的清零时刻（Claude 流里的额度读数）。 */
  resetsAt?: string;
  /** 上游的 HTTP 状态码（Claude 终帧的 api_error_status）。 */
  httpStatus?: number;
  /** 终帧里的回答（探针看它是不是只回了 OK）。 */
  answer?: string;
  /**
   * 只在 stderr 里的报错原话（cursor 的认证、额度、网络报错：退出 1、没有 JSON）：失败信息里没有就接上，失败分流靠它认出
   * 是哪一种。Claude 的报错在流里、已经在判定原因里，不给。
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
  /** 换了账号池能不能 fork 续（Claude 能；cursor 没有 fork，换池一律接力）。 */
  canFork: boolean;
  /**
   * 开新会话、fork 时回给工作流的会话号。known = 这就是执行体要用的号（Claude）；不是的是临时号（cursor），真号 init 帧里给。
   */
  newSessionId(runId: string): { id: string; known: boolean };
  run(spec: HostRunSpec, hooks: HostRunHooks): Promise<HostReport>;
  /** 登录失效时人该怎么修（规则表里通用的登录失效 AU2 管各家的登录，没写修法）。 */
  loginFix(machine: string, user: string): string;
}

/** 起插头的函数：生产是 runClaudeCode / runCursorAgent；测试按执行方式给假插头（不起真执行体）。 */
export interface HostRunners {
  'claude-code'?: (spec: ClaudeCodeRunSpec, options: ClaudeCodeRunOptions) => Promise<ClaudeCodeRunReport>;
  'cursor-agent'?: (spec: CursorRunSpec, options: CursorRunOptions) => Promise<CursorRunReport>;
}

export interface HostDriverDeps {
  /** 起 Claude Code 的命令（绝对路径）：reclaude 装在会话用户自己家里。 */
  claudeCommand(user: SessionUser): string[];
  /** 起 cursor-agent 的命令（绝对路径）：装在会话用户自己家里，生产用 cursorLaunchCommand 现找版本目录。 */
  cursorCommand(user: SessionUser): string[];
  run?: HostRunners;
}

export function hostDrivers(deps: HostDriverDeps): Record<WiredHost, HostDriver> {
  return {
    'claude-code': claudeDriver(deps.claudeCommand, deps.run?.['claude-code'] ?? runClaudeCode),
    'cursor-agent': cursorDriver(deps.cursorCommand, deps.run?.['cursor-agent'] ?? runCursorAgent),
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

/** 没装时 stderr 那句的开头：和 Node 起不来时的原话一个样子，失败分流按「执行方式或路由配置不对」（CF1）认。 */
export const CURSOR_MISSING = 'spawn cursor-agent ENOENT';

// 一行写完：命令行要经 sudo（会记日志），不带换行这类控制字符。版本目录名只认「数字.数字」开头的（2026.09.23-86fc751
// 这种；安装时下载的临时包是 UUID 起名的，不认），按版本号倒序（sort -V：月、日不补零也排得对），里面有能跑的 cursor-agent
// 才算；找到就 exec 成 cursor-agent（进程号不变，还是插头拿着的那一个）。
const CURSOR_LAUNCH_SCRIPT = [
  'dir=$1',
  'shift',
  'bin=',
  'if [ -x "$dir/current/cursor-agent" ]; then bin=$dir/current/cursor-agent; else for v in $(ls -1 "$dir" 2>/dev/null | grep -E \'^[0-9]+\\.[0-9][0-9A-Za-z._-]*$\' | sort -rV); do if [ -x "$dir/$v/cursor-agent" ]; then bin=$dir/$v/cursor-agent; break; fi; done; fi',
  `if [ -z "$bin" ]; then echo "${CURSOR_MISSING}：$dir 下既没有 current，也没有能跑的版本目录（会话用户家里没装 cursor-agent）" >&2; exit 127; fi`,
  'exec "$bin" "$@"',
].join('; ');

/**
 * 起 cursor-agent 的命令：以会话用户的身份现找 current → 最新版本目录（CU-03：升级会删掉旧版本目录，钉死一个版本会起不来）。
 * 版本目录经参数传给脚本，不拼进脚本（没有注入）；插头的参数接在后面，原样交给 cursor-agent。
 */
export function cursorLaunchCommand(versionsDir: string): string[] {
  if (!versionsDir.startsWith('/')) throw new Error(`cursor-agent 的版本目录要写绝对路径：${versionsDir}`);
  return ['/bin/sh', '-c', CURSOR_LAUNCH_SCRIPT, 'cursor-agent', versionsDir];
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
          // 干活的会话照 Claude 的理由放开命令（--force）；探针不放，什么命令都不许跑
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
    loginFix: (machine, user) => `在${machine}上以 ${user} 跑 cursor-agent login，在浏览器里批准`,
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
