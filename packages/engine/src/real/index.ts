// 真端口的装配：库（packages/db）、GitHub（packages/github）、会话（packages/adapters 的插头，按执行方式分派：Claude Code、
// cursor-agent，real/hosts.ts）、工作树（fleet-agent-scope）各一份，拼成 EnginePorts。生产按环境变量装（realPortsFromEnv，
// 见 deploy/france/desired-config.json 的 engine 段，env 样例 #747 删了）；缺了哪一项就不起，讲清楚缺什么，不带着半套配置接活。

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  bridgeMirasimConnector,
  type LedgerFs,
  type MirasimConnect,
  parseSessionProxy,
  SESSION_USERS,
  type SessionUser,
  switchSessionOrg,
} from '@fleet-dao/adapters';
import {
  createDb,
  type Db,
  finishScheduleRun,
  readEngineMasterRow,
  recordRouteProbeDone,
  recordRouteProbeStart,
  routeProbeAuditRows,
  scheduleHealth,
  startScheduleRun,
} from '@fleet-dao/db';
import { createGitHub } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import { pgLedger, pgLocker } from '@fleet-dao/store';
import type { Client } from '@temporalio/client';
import type { EngineJobs, EngineTasks } from '../activities.ts';
import type { EngineDrain } from '../drain.ts';
import { type DrainControlDeps, drainRequestFile, readDrainRequest } from '../drain-control.ts';
import { createEngineMasterGate, type EngineMasterGate } from '../engine-master.ts';
import { probeOrgNow } from '../jobs/route-probe.ts';
import { routeProbeLock } from '../jobs/route-probe-now.ts';
import { SESSION_MEMORY_HIGH_MB, SESSION_MEMORY_MAX_MB } from '../limits.ts';
import type { EnginePorts } from '../ports.ts';
import type { CarpoolRegistryView } from '../routing/index.ts';
import { configFromEnv } from '../worker.ts';
import { canaryJob } from './canary.ts';
import { carpoolApiReader } from './carpool-api.ts';
import { carpoolRegistry } from './carpool-cap.ts';
import { carpoolWatchJob } from './carpool-watch.ts';
import { drainNotifier } from './drain-alerts.ts';
import { describeFailure, scopeExec, type UserExec } from './exec.ts';
import { gitNetworkEnv } from './git-env.ts';
import { createGitHubPorts, type EngineGitHub } from './github-ports.ts';
import { githubReconcileJob } from './github-reconcile.ts';
import {
  cursorLaunchCommand,
  DEFAULT_CURSOR_API_KEY_FILE,
  DEFAULT_CURSOR_VERSIONS_DIR,
  DEFAULT_GROK_BIN,
  grokLaunchCommand,
  hostDrivers,
} from './hosts.ts';
import { hourlyReconcileJob } from './hourly-reconcile.ts';
import { intakeJob } from './intake.ts';
import { issueGroomIdlePolicyFromEnv } from './issue-groom.ts';
import { issueKindJevFromEnv } from './issue-kind-jev.ts';
import { registerEngineJobs } from './jobs.ts';
import { realMemoryAdmission } from './memory-admission.ts';
import { productionMemoryPeak } from './memory-peak.ts';
import { oneShotSessions } from './one-shot-sessions.ts';
import { NO_FUSION_SESSIONS, orgDriftReporter, orgSwitchRound } from './org-switch.ts';
import { orphanReaper } from './orphan-reap.ts';
import { type QuotaReadWiring, quotaReadJob } from './quota-read.ts';
import { realReleaseEvidence } from './release-evidence.ts';
import { retireEngineSchedules } from './retire-schedules.ts';
import { routeProbeJob } from './route-probe.ts';
import {
  lazyTemporalWakeClient,
  routeWakerFromDb,
  wakeAfterProbeNow,
  wakeAfterProbeRound,
} from './route-wake.ts';
import { realChannelAttempts, realReservations, realRuns } from './runs-writer.ts';
import type { SegmentSpawnerDeps } from './segment-spawner.ts';
import { type SessionOrgReader, sessionOrgReader } from './session-org.ts';
import { createStorePorts } from './store-ports.ts';
import { createTaskActivities } from './task-activities.ts';
import { createRunSegment } from './task-segment.ts';
import { createColdVerify } from './task-verify.ts';
import { watchdogJob } from './watchdog.ts';
import { DEFAULT_WORK_ROOT, helperWorkTrees, type WorkTrees } from './worktrees.ts';

export interface RealPortsDeps {
  db: Db;
  gh: EngineGitHub;
  trees: WorkTrees;
  exec: UserExec;
  /**
   * 会话用户此刻挂的组织（real/session-org.ts）：选路只派它挂着的那个 Claude 订阅池。和探针、切号是同一个（按同一个起点判）。
   */
  sessionOrg: SessionOrgReader;
  /** 引擎自己的临时目录（bundle）、存档目录（没合并就收的树里没提交的改动）。 */
  tmpDir: string;
  archiveDir: string;
  /**
   * 排空（drain.ts）：在排空时选路回「过一会儿再选」。不给就不闸（测试、只起一次的工具）。
   * 三段会话登记进排空清单的是 oneShotSessions（下面 realPortsFromEnv），不在这里。
   */
  drain?: EngineDrain;
  /** 引擎总开关（engine-master.ts，#1086）：关着选路不派（回「过一会儿再选」）。不给就不闸（测试、只起一次的工具）。 */
  master?: EngineMasterGate;
  /**
   * 拼车并发登记的现核（real/carpool-cap.ts，#896）：选路前问，核对不上不往拼车池派。必填：不给就是拼车池不受登记核对管，
   * 漏接要过不了类型检查，不靠默认。
   */
  carpoolRegistry: () => Promise<CarpoolRegistryView>;
  /** 以下测试用。 */
  session?: Partial<{ helper: string; sudo: readonly string[]; gitBin: string; shBin: string }>;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface RealPorts {
  ports: EnginePorts;
  /** 工人起来接活之前收上一轮留下的会话 scope、临时目录、没收场的 runs 行、预占的名额（real/orphan-reap.ts）；回收了几个 scope。 */
  reapOrphanSessions(): Promise<number>;
}

export function createRealPorts(deps: RealPortsDeps): RealPorts {
  const store = createStorePorts({
    db: deps.db,
    sessionOrg: deps.sessionOrg,
    carpoolRegistry: deps.carpoolRegistry,
    ...(deps.drain ? { drain: deps.drain } : {}),
    ...(deps.master ? { master: deps.master } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    // 派活时按内存做准入（#219）：读父节点 fleet-agents.slice 的 memory.current；本机开发没有这层就跳过（skip），不拦。
    memoryAdmission: realMemoryAdmission(),
  });
  const github = createGitHubPorts({
    gh: deps.gh,
    trees: deps.trees,
    exec: deps.exec,
    tmpDir: deps.tmpDir,
    archiveDir: deps.archiveDir,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.session?.gitBin ? { gitBin: deps.session.gitBin } : {}),
    ...(deps.session?.shBin ? { shBin: deps.session.shBin } : {}),
  });
  const ports: EnginePorts = {
    pickRoute: store.pickRoute,
    raiseAlert: store.raiseAlert,
    recordTiming: store.recordTiming,
    saveTaskState: store.saveTaskState,
    authorFamilies: store.authorFamilies,
    createWorktree: github.createWorktree,
    removeWorktree: github.removeWorktree,
    pushBranch: github.pushBranch,
    openPr: github.openPr,
    waitCi: github.waitCi,
    syncMainline: github.syncMainline,
    closeIssue: github.closeIssue,
  };
  return {
    ports,
    reapOrphanSessions: orphanReaper({
      db: deps.db,
      trees: deps.trees,
      ...(deps.session?.helper ? { helper: deps.session.helper } : {}),
      ...(deps.session?.sudo ? { sudo: deps.session.sudo } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    }),
  };
}

/** reclaude 装在会话用户自己家里（docs/ops.md 第五节）；{user} 换成会话用户。 */
export const DEFAULT_CLAUDE_BIN = '/home/{user}/.local/bin/reclaude';
export const DEFAULT_ENGINE_STATE_DIR = '/var/lib/fleet-dao/engine';
/**
 * 会话用户自己的 Mirasim 服务在他家里（{user} 换成会话用户；design 第十四节：单独起一份，不借旧系统那份）：
 * 令牌在 <这个目录>/.mirasim/run/local-<端口>.token，账本在 <这个目录>/.mirasim/traffic。端口不钉：装的时候由 Mirasim
 * 自己定，引擎每次连都现找（discoverMirasimEndpoint）。
 */
export const DEFAULT_MIRASIM_HOME = '/home/{user}';
/**
 * 桥接脚本（adapters 的 bridge.ts）：默认取和这份正在跑的引擎代码同一个检出里的那一份（和 worker.ts 的
 * DEFAULT_CLI_BIN_DIR 同一个道理——发布是整棵 monorepo 的检出，不是打包过的产物，packages/ 底下各仓还在原位）。
 * 会话用户读得到这份检出（405 那样的发布目录 755，第三节目录表），不用另外装一份。
 * 路径经 adapters 的 package.json exports 的子路径取（#901 ⑥：原来是 new URL('../../../adapters/src/…')，绕过 exports，
 * adapters 改目录结构会悄悄断；现在改了目录，exports 一行跟着改，真文件不在 test/real/mirasim-bridge-path.test.ts 当场红）。
 * 用 createRequire().resolve 而不是 import.meta.resolve：同步、在 vitest 和 node 里行为一样；都返回真实路径（不是 node_modules 里的符号链接）。
 */
export const DEFAULT_MIRASIM_BRIDGE_SCRIPT = createRequire(import.meta.url).resolve(
  '@fleet-dao/adapters/mirasim-bridge',
);
/** 会话读得到的 node（法国装机脚本、发布脚本到处这么写死，第五节）；桥接不用另外配置。 */
export const MIRASIM_BRIDGE_NODE = '/usr/bin/node';

export interface RealPortsConfig {
  machine: string;
  workRoot: string;
  stateDir: string;
  claudeBin: string;
  /** 会话用户家里 cursor-agent 的版本目录（{user} 换成会话用户）：每次起都在这下面现找 current → 最新版本。 */
  cursorVersionsDir: string;
  /** 会话用户家里的 grok（{user} 换成会话用户）：每次起都由会话用户先看它在不在。 */
  grokBin: string;
  /** 会话用户家里的 Mirasim 服务（{user} 换成会话用户）：每次连都现找端口、现读令牌。 */
  mirasimHome: string;
  /** 桥接脚本的绝对路径（会话用户读得到；real/index.ts 的 DEFAULT_MIRASIM_BRIDGE_SCRIPT）。 */
  mirasimBridge: string;
  /**
   * 会话出网经的代理（FLEET_SESSION_PROXY，规范成 http://主机:端口）：没写、空着是直连（法国）。
   * cursor-agent、grok 的会话带上，Claude 不带（hosts.ts）。
   */
  sessionProxy?: string;
}

/** 缺的、认不出的一律报错（一次列全），不带着半套配置接活。 */
export function realPortsConfigFromEnv(env: Readonly<Record<string, string | undefined>>): RealPortsConfig {
  const problems: string[] = [];
  const machine = env.FLEET_MACHINE_NAME?.trim() ?? '';
  if (!machine)
    problems.push('FLEET_MACHINE_NAME（这台机器给人看的名字，例如「法国」：要人重新登录时写清去哪台机器）');
  if (!env.DATABASE_URL?.trim()) problems.push('DATABASE_URL');
  const workRoot = env.FLEET_WORK_DIR?.trim() || DEFAULT_WORK_ROOT;
  if (!workRoot.startsWith('/')) problems.push(`FLEET_WORK_DIR 要写绝对路径（现在是 ${workRoot}）`);
  const stateDir = env.FLEET_ENGINE_STATE_DIR?.trim() || DEFAULT_ENGINE_STATE_DIR;
  if (!stateDir.startsWith('/')) problems.push(`FLEET_ENGINE_STATE_DIR 要写绝对路径（现在是 ${stateDir}）`);
  const claudeBin = env.FLEET_CLAUDE_BIN?.trim() || DEFAULT_CLAUDE_BIN;
  if (!claudeBin.startsWith('/')) problems.push(`FLEET_CLAUDE_BIN 要写绝对路径（现在是 ${claudeBin}）`);
  const cursorVersionsDir = env.FLEET_CURSOR_VERSIONS_DIR?.trim() || DEFAULT_CURSOR_VERSIONS_DIR;
  if (!cursorVersionsDir.startsWith('/')) {
    problems.push(`FLEET_CURSOR_VERSIONS_DIR 要写绝对路径（现在是 ${cursorVersionsDir}）`);
  }
  const grokBin = env.FLEET_GROK_BIN?.trim() || DEFAULT_GROK_BIN;
  if (!grokBin.startsWith('/')) problems.push(`FLEET_GROK_BIN 要写绝对路径（现在是 ${grokBin}）`);
  const mirasimHome = env.FLEET_MIRASIM_HOME?.trim() || DEFAULT_MIRASIM_HOME;
  if (!mirasimHome.startsWith('/')) problems.push(`FLEET_MIRASIM_HOME 要写绝对路径（现在是 ${mirasimHome}）`);
  // 默认值是 fileURLToPath 现算的（和 worker.ts 的 DEFAULT_CLI_BIN_DIR 同一个道理），在这台机器上本来就是绝对路径、
  // 只是开发机（Windows）上是 D:\... 这个样子——只有人手写了 FLEET_MIRASIM_BRIDGE 才照 POSIX 的绝对路径规矩查，
  // 默认值不查（法国是 Linux，真跑时这条本来就成立）。
  const rawMirasimBridge = env.FLEET_MIRASIM_BRIDGE?.trim();
  if (rawMirasimBridge && !rawMirasimBridge.startsWith('/')) {
    problems.push(`FLEET_MIRASIM_BRIDGE 要写绝对路径（现在是 ${rawMirasimBridge}）`);
  }
  const mirasimBridge = rawMirasimBridge || DEFAULT_MIRASIM_BRIDGE_SCRIPT;
  // 写了却认不出就不起：不悄悄当成直连（直连出不了网的机器上，会话会一个个莫名其妙地连不上）
  const rawProxy = env.FLEET_SESSION_PROXY?.trim();
  let sessionProxy: string | undefined;
  if (rawProxy) {
    try {
      sessionProxy = parseSessionProxy(rawProxy);
    } catch (err) {
      problems.push(`FLEET_SESSION_PROXY：${errMessage(err)}`);
    }
  }
  if (problems.length > 0) throw new Error(`真端口起不来，本机配置缺这些或不对：${problems.join('；')}`);
  return {
    machine,
    workRoot,
    stateDir,
    claudeBin,
    cursorVersionsDir,
    grokBin,
    mirasimHome,
    mirasimBridge,
    ...(sessionProxy === undefined ? {} : { sessionProxy }),
  };
}

/**
 * 起执行体的命令（绝对路径），会话和探针同一份：reclaude、cursor-agent、grok 都装在会话用户自己家里，{user} 换成会话用户。
 * cursor-agent 不钉版本：以会话用户的身份先读它家里的 API 密钥（DEFAULT_CURSOR_API_KEY_FILE，不做成配置），再在版本目录下
 * 现找 current → 最新版本（hosts.ts 的 cursorLaunchCommand）。grok 由会话用户先看在不在（grokLaunchCommand）。
 */
export function agentCommands(config: Pick<RealPortsConfig, 'claudeBin' | 'cursorVersionsDir' | 'grokBin'>): {
  claudeCommand(user: SessionUser): string[];
  cursorCommand(user: SessionUser): string[];
  grokCommand(user: SessionUser): string[];
} {
  return {
    claudeCommand: (user) => [config.claudeBin.replaceAll('{user}', user)],
    cursorCommand: (user) =>
      cursorLaunchCommand(
        config.cursorVersionsDir.replaceAll('{user}', user),
        DEFAULT_CURSOR_API_KEY_FILE.replaceAll('{user}', user),
      ),
    grokCommand: (user) => grokLaunchCommand(config.grokBin.replaceAll('{user}', user)),
  };
}

const MIRASIM_TOKEN_NAME = /^local-([1-9][0-9]{0,4})\.token$/;

/** 一条以那个会话用户的身份跑的短命令：起个短命 scope（scopeId 每次都不同，同一时刻不撞）。 */
function execAs(exec: UserExec, user: SessionUser, argv: string[], tag: string) {
  return exec({ user, cwd: '/', argv, timeoutMs: 10_000, scopeId: `${tag}-${randomUUID()}` });
}

/** ls 报「没有这个路径」的样子（GNU coreutils：退出 2，stderr 里这句）；和别的读不了（权限、没查成）分开报。 */
function isMissingPath(r: { code: number | null; stderr: string }): boolean {
  return r.code === 2 && /No such file or directory/.test(r.stderr);
}

/**
 * 经 exec 以那个会话用户 cat 一个文件：值不上命令行、不进日志（只有路径在 argv 里；错误里只有路径和 cat 的 stderr，没有内容）。
 * 读不了抛错、不回空串；没有这个文件、没权限分别带 code ENOENT、EACCES（和 node:fs 一样，额度读取器按它写「读不到」的原因）。
 */
export async function catAsUser(
  exec: UserExec,
  user: SessionUser,
  path: string,
  tag = 'mirasim-cat',
): Promise<string> {
  const r = await execAs(exec, user, ['/bin/cat', '--', path], tag);
  if (r.code !== 0) {
    const err = new Error(describeFailure(`读 ${path}`, r)) as NodeJS.ErrnoException;
    if (/No such file or directory/.test(r.stderr)) err.code = 'ENOENT';
    else if (/Permission denied/.test(r.stderr)) err.code = 'EACCES';
    throw err;
  }
  return r.stdout.toString('utf8');
}

/** 额度读取里凭据在会话用户家里的两种读取器（Cursor、Grok）：引擎用户读不到，经 exec 以会话用户读（#1195）。Mirasim 池要走桥接，不在这里。 */
export const QUOTA_USER_READERS = ['cursor-dashboard', 'grok-billing'] as const;

export function quotaAsUser(
  exec: UserExec,
  user: SessionUser,
  home: string,
): NonNullable<QuotaReadWiring['asUser']> {
  return {
    readers: QUOTA_USER_READERS,
    readFile: (path) => catAsUser(exec, user, path, 'quota-cat'),
    homeDir: home.replaceAll('{user}', user),
  };
}

/** 经 exec 以那个会话用户列一个目录：LedgerFs 的 readdir 要的形状（没有这个目录时抛 code 为 ENOENT 的错，和 node:fs 一样）。 */
async function lsAsUser(exec: UserExec, user: SessionUser, dir: string): Promise<string[]> {
  const r = await execAs(exec, user, ['/bin/ls', '-1', '--', dir], 'mirasim-ls');
  if (isMissingPath(r)) {
    const err = new Error(`没有这个目录：${dir}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  }
  if (r.code !== 0) throw new Error(describeFailure(`列 ${dir}`, r));
  return r.stdout
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * 这个会话用户自己的 Mirasim 服务在哪（design 第十四节：给他单独起一份，不借旧系统那份）：列他家里的
 * <home>/.mirasim/run，只认「恰好一份 local-<端口>.token」——一份都没有就是这个会话用户还没配好，不止一份就是认不出
 * 该用哪份（只该有一份 Mirasim 服务）。令牌本身不在这里读（每次建连都现读，不缓存：桥接自己以会话用户的身份读，
 * bridge.ts），这里只定端口和令牌文件的位置——这一步是 ls 一个目录，不是连端口，不受回环口防火墙限制。
 */
export async function discoverMirasimEndpoint(
  exec: UserExec,
  user: SessionUser,
  home: string,
): Promise<{ port: number; tokenFile: string }> {
  const dir = `${home}/.mirasim/run`;
  let names: string[];
  try {
    names = (await lsAsUser(exec, user, dir)).filter((n) => MIRASIM_TOKEN_NAME.test(n));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${user} 家里没有 ${dir}：这个会话用户还没单独起一份 Mirasim 服务（docs/ops.md 第五节「会话用户的 Mirasim」；配好之前 Mirasim 路由保持关闭，design 第十四节）`,
      );
    }
    throw err;
  }
  if (names.length === 0) {
    throw new Error(
      `${dir} 下没有 local-<端口>.token：这个会话用户还没单独起一份 Mirasim 服务（docs/ops.md 第五节「会话用户的 Mirasim」）`,
    );
  }
  if (names.length > 1) {
    throw new Error(
      `${dir} 下有 ${names.length} 份令牌（${names.join('、')}）：认不出该用哪一份，只该有一份 Mirasim 服务`,
    );
  }
  const name = names[0] as string;
  const port = Number(MIRASIM_TOKEN_NAME.exec(name)?.[1]);
  if (!Number.isInteger(port)) throw new Error(`令牌文件名认不出：${name}（该是 local-<端口>.token）`);
  return { port, tokenFile: `${dir}/${name}` };
}

export interface MirasimBridgeConfig {
  /** node 加桥接脚本的绝对路径（bridge-connect.ts 的 bridgeCommand）。 */
  command: readonly string[];
  /** 以下测试用：换假帮手、假 spawn。 */
  helper?: string;
  sudo?: readonly string[];
  spawn?: Parameters<typeof bridgeMirasimConnector>[1]['spawn'];
}

/**
 * 会话用户自己的 Mirasim 服务：账本目录、读账本用的（as-user）文件访问经 exec 以那个会话用户读（引擎自己的进程，
 * fleet 用户，进不去他的家，750，design 第十四节）；连接（connect）经桥接（bridge.ts）以那个会话用户的身份跑，不再由
 * 引擎的进程直连回环口——法国防火墙只放行会话用户和 root 连那个口（docs/ops.md 第五节「会话用户的口只许它自己连」，
 * #35），2026-09-28 实测引擎（fleet 用户）连不上，是这条路由派不出去的断链（#345 后续）。discoverMirasimEndpoint
 * 现找端口（exec 以会话用户 ls，不走网络，不碰防火墙）；令牌桥接自己以会话用户的身份现读，不经引擎传值。
 */
export function mirasimDepsFor(
  exec: UserExec,
  home: string,
  bridge: MirasimBridgeConfig,
): {
  connect(user: SessionUser): MirasimConnect;
  ledgerDir(user: SessionUser): string;
  ledgerFs(user: SessionUser): LedgerFs;
} {
  const homeOf = (user: SessionUser) => home.replaceAll('{user}', user);
  return {
    connect: (user) => async () => {
      const at = homeOf(user);
      const { port, tokenFile } = await discoverMirasimEndpoint(exec, user, at);
      return bridgeMirasimConnector(
        { user, port, tokenFile },
        {
          bridgeCommand: bridge.command,
          ...(bridge.helper ? { helper: bridge.helper } : {}),
          ...(bridge.sudo ? { sudo: bridge.sudo } : {}),
          ...(bridge.spawn ? { spawn: bridge.spawn } : {}),
        },
      )();
    },
    ledgerDir: (user) => `${homeOf(user)}/.mirasim/traffic`,
    ledgerFs: (user) => ({
      readdir: (dir) => lsAsUser(exec, user, dir),
      readFile: (path) => catAsUser(exec, user, path),
    }),
  };
}

/**
 * 生产：按环境变量装真端口，连同定时任务要的东西（jobs）和起来时的登记（registerJobs：定时任务、判断题）。
 * 返回的 close 在工人停下后关库连接。
 */
export function realPortsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  extra: { drain?: EngineDrain; ownSha?: string | null; releasesDir?: string } = {},
): RealPorts & {
  jobs: EngineJobs;
  /** 任务工作流（#632）的真活动：不碰会话的五个、动手会话、冷验收会话。 */
  tasks: EngineTasks;
  registerJobs(): Promise<void>;
  /** 引擎起来、定时器起之前跑一遍：把退役名单（jobs/retired-schedules.ts）里 Temporal 上还在的删掉，见 real/retire-schedules.ts。 */
  retireSchedules(client: Pick<Client, 'schedule'>): Promise<void>;
  /** 每个定时任务最近一轮是几点起的（schedule_runs）；一轮都没有的不在里面。进程内定时器起来时补最近一轮要看（jobs/timers.ts）。 */
  jobLastStartedAt(): Promise<ReadonlyMap<string, Date>>;
  /** 引擎总开关的闸（#1086）：worker 起来先 refresh 一次、再 start 周期刷新；定时器入口、选路、一次性会话登记读它。 */
  master: EngineMasterGate;
  /** 总开关关着、这个定时任务这一轮被跳过：记一条 partial 进 schedule_runs（看门狗不当成「停了」，定时任务页看得到原因）。 */
  recordSkippedRun(jobId: string, why: string): Promise<void>;
  close(): Promise<void>;
  stateDir: string;
  /** 排空要的几样（drain-control.ts）：读发布脚本的排空请求、查发布锁、到点停会话、报提醒。 */
  drainControl: Omit<DrainControlDeps, 'drain' | 'log'>;
} {
  const config = realPortsConfigFromEnv(env);
  const { db, close } = createDb({ env: env as Record<string, string | undefined> });
  // 引擎自己的 git（抓主线、推分支）也经这一档登记的代理出网：直连 github.com 不通时（Connection reset，
  // 动手前建工作树就卡在抓主线上，#786 同一个根）；git 认 http(s)_proxy 环境变量，gitEnv 照搬父环境里除凭据外的变量。
  // 只给 git 这一份环境，引擎进程自己的环境和起会话的环境（只从白名单抄）都不动；法国不登记代理、环境原样。
  const gh = createGitHub({
    ledger: pgLedger(db),
    locker: pgLocker(db),
    env: gitNetworkEnv(env as Record<string, string | undefined>, config.sessionProxy),
  });
  const trees = helperWorkTrees({ root: config.workRoot });
  const { claudeCommand, cursorCommand, grokCommand } = agentCommands(config);
  // 单子归类（#448）问的是判断题配置（issue-kind），走 issue-kind-jev.ts；起来时在 registerJobs 里登记。
  // 错误分流、停滞预判没有工作流再问，引擎不再登记、不再问。
  const issueKindJev = issueKindJevFromEnv(db, env);
  const exec = scopeExec();
  // Mirasim：会话（sessions.ts）和路由探针（route-probe.ts）共用同一份「怎么连、怎么读账本」；连接经桥接以会话用户的
  // 身份跑（法国防火墙只放行它自己和 root 连回环口），账本经这个 exec 以会话用户读（引擎自己的进程进不去他的家）
  const mirasim = mirasimDepsFor(exec, config.mirasimHome, {
    command: [MIRASIM_BRIDGE_NODE, config.mirasimBridge],
  });
  // 会话用户此刻挂的组织：法国只有一个会话用户（design 第九节），两个 Claude 池都跑在它下面、同一时刻只有它挂着的那个能派。
  // 以它跑它家里的 reclaude org list（和会话同一份 reclaude）；选路、探针、切号、每小时对账共用这一个（读成了的留 30 秒），
  // 按同一个起点判：读数变了、引擎没切过号，推 session-org:drift（带前后两次读数），定下来之前谁都不照它来（#335）
  const [sessionUser] = SESSION_USERS;
  const sessionOrg = sessionOrgReader({
    exec,
    user: sessionUser,
    reclaude: claudeCommand(sessionUser),
    proxy: config.sessionProxy,
    onEvent: orgDriftReporter({ db, user: sessionUser, machine: config.machine }),
  });
  // 拼车并发登记的核对（#194 方案 4.7、#896）：引擎起来核一遍推提醒（registerJobs），选路前、每小时对账判阶段派不派得出去时现核，
  // 对不上拼车池不派新活。同一个对象，「上一次对上没对上」的记忆只有一份。
  const carpoolCap = carpoolRegistry({ db, env, machine: config.machine });
  // 引擎总开关（#1086）：选路、一次性会话登记、定时器入口三处读同一个闸；起来时 worker 先刷新一次再起周期刷新。读不到按关。
  const master = createEngineMasterGate({
    read: () => readEngineMasterRow(db),
    log: (message) => console.info(message),
  });
  const real = createRealPorts({
    db,
    master,
    carpoolRegistry: () => carpoolCap.view(),
    gh,
    trees,
    exec,
    sessionOrg,
    tmpDir: join(config.stateDir, 'tmp'),
    archiveDir: join(config.stateDir, 'archive'),
    ...(extra.drain ? { drain: extra.drain } : {}),
  });
  // 三段的一次性会话（动手、验收）的登记：切号照它停下跑在 Claude 池上的那一段，切完任务工作流在原分支上重跑（#59）
  // 同时登记进发布排空的在途清单（#957）：不接 drain，发布排空看不见动手、验收会话，会提前放行、到点也停不到它们
  // （test/real/one-shot-drain.test.ts 钉着这一行和下面 stopSessions 里的 oneShots.drainStop）
  // 同时接引擎总开关：关着这一段不起会话（#1086，test/real/one-shot-sessions.test.ts 的「生产装配漏接引擎总开关」钉着这一行）
  const oneShots = oneShotSessions({ ...(extra.drain ? { drain: extra.drain } : {}), master });
  // 拼车用满切独享、恢复了切回（#157）：路由探针每一轮探之前判，经 root 帮手的 org-use 切；手上跑在 Claude 池上的会话
  // 先停下、切完接着干（#59：一次性会话在原分支上重跑这一段，Fusion 的会话换了池 fork 续上），不等它们跑完
  // #194：被拒当场判、定时盯读接口那一轮也走它（同一把单飞锁）；读接口给切号前现读，切完当场探切过去的池（和路由探针同一份探法）
  const readCarpoolApi = carpoolApiReader();
  // 叫醒等路由的活（real/route-wake.ts）：第一次叫醒时才连 Temporal（切号这条路上手里没有 Temporal 客户端）
  const temporal = configFromEnv(env as Record<string, string | undefined>);
  const wakeClient = lazyTemporalWakeClient({ address: temporal.address, namespace: temporal.namespace });
  const routeWake = routeWakerFromDb(db, wakeClient, (level, text, fields) =>
    console[level === 'info' ? 'info' : level](text, fields ?? {}),
  );
  const orgSwitch = orgSwitchRound({
    db,
    org: sessionOrg,
    user: sessionUser,
    switchOrg: (to) => switchSessionOrg({ to, user: sessionUser }),
    sessions: NO_FUSION_SESSIONS,
    oneShots,
    machine: config.machine,
    readApi: readCarpoolApi,
    // 切完探通，当场叫醒等路由的任务工作流重新选一次（#194 方案 4.3，不等 MAX_ROUTE_WAIT_SECONDS），见 real/route-wake.ts
    probeNow: wakeAfterProbeNow((to) => probeOrgNow(routeProbe(), to), routeWake),
  });
  const routeProbe = routeProbeJob({
    db,
    trees,
    claudeCommand,
    cursorCommand,
    grokCommand,
    mirasimConnect: mirasim.connect,
    mirasimLedgerDir: mirasim.ledgerDir,
    mirasimLedgerFs: mirasim.ledgerFs,
    sessionOrg,
    // 探针那一轮里切的号：这一轮探完核对之后也叫醒（当场触发的那条路在上面 probeNow 里叫过了，两条路不重叠）
    orgSwitch: wakeAfterProbeRound(orgSwitch, routeWake),
    machine: config.machine,
    ...(config.sessionProxy === undefined ? {} : { sessionProxy: config.sessionProxy }),
  });
  const jobs: EngineJobs = {
    githubReconcile: githubReconcileJob({
      db,
      gh,
      askIssueKind: issueKindJev.askKind,
      issueGroomIdlePolicy: issueGroomIdlePolicyFromEnv(env),
    }),
    // 路由探针和干活的会话用同一份执行体（reclaude、cursor-agent、grok、Mirasim）、同一个工作树的根（探针目录在它下面）
    routeProbe,
    // 驾驶舱的立即探测：和定时那一轮同一份探法、同一把锁，接手、探完各记一条操作记录
    routeProbeNow: () => ({
      rows: (since) => routeProbeAuditRows(db, since),
      start: (requestId, at) => recordRouteProbeStart(db, requestId, at),
      done: (input) => recordRouteProbeDone(db, input),
      probe: routeProbe,
      lock: routeProbeLock,
      now: () => new Date(),
      log: (level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}),
    }),
    // 定时读额度（#76）：读成的写 quota_windows，读不到按规矩报警
    // Cursor、Grok 池的登录文件在会话用户家里，引擎用户读不到：这两种读取器读文件经 exec 以会话用户读（#1195）
    quotaRead: quotaReadJob({ db, asUser: quotaAsUser(exec, sessionUser, config.mirasimHome) }),
    // 拼车额度盯读（#194）：每分钟起一条，按情况读开放接口、交给切号当场判
    carpoolWatch: carpoolWatchJob({
      db,
      user: sessionUser,
      sessionOrg,
      orgSwitch,
      readApi: readCarpoolApi,
    }),
    // 每小时对账：同一个工作树管家（删树经 fleet-agent-scope）、同一个会话用户执行器（看树里还剩什么）；引擎这份 GitHub
    // （同一套 App 凭据）审合了的 PR、给排队的单补拉时现读挂在哪个版本、做两个机器人的权限自检
    hourlyReconcile: hourlyReconcileJob({
      db,
      gh,
      trees,
      exec,
      sessionOrg,
      carpoolRegistry: () => carpoolCap.view(),
      machine: config.machine,
      selfCheck: (repos) => gh.selfCheck(repos),
    }),
    // 全流程巡检（#223）：巡检仓写在引擎配置 FLEET_CANARY_REPO（没配这一轮记没跑成，看门狗报）；开单、写需求文档、挂版本都是「引擎」机器人
    canary: canaryJob({ db, gh, repo: env.FLEET_CANARY_REPO }),
    // 看门狗（#203）：按登记表看上面这些（和备份那几个）新不新鲜，没跑成、停了推提醒，恢复了自己撤
    watchdog: watchdogJob({ db }),
    // 拉单（#632）：每 5 分钟读开着「让 AI 接活」的仓里该做的单、起任务工作流；开关全关时是正常的空闲
    intake: intakeJob({ db, gh }),
  };
  const taskLog = (message: string, fields?: Record<string, unknown>) => console.info(message, fields ?? {});
  // 动手会话（#632 S2-4b-2）和冷验收会话（S2-5b）：和 Fusion 的会话用同一份执行方式驱动，但自己一份（驱动没有状态，只是包着各家的
  // run 函数）；内存准入、会话的资源上限、runs 记账都用生产的那份，两种会话共用同一个 Spawner 装配。
  const segmentSpawner: SegmentSpawnerDeps = {
    db,
    drivers: hostDrivers({
      claudeCommand,
      cursorCommand,
      grokCommand,
      mirasimConnect: mirasim.connect,
      mirasimLedgerDir: mirasim.ledgerDir,
      mirasimLedgerFs: mirasim.ledgerFs,
      sessionProxy: config.sessionProxy,
    }),
    trees,
    baseEnv: env,
    resources: { memoryHighMb: SESSION_MEMORY_HIGH_MB, memoryMaxMb: SESSION_MEMORY_MAX_MB, swapMaxMb: 0 },
    // 会话 scope 的内存峰值写进 runs（#948）：边跑边读 cgroup 的 memory.peak
    memoryPeak: productionMemoryPeak(),
    // 拼车池上的会话被拒：证据当场交给切号判（#194 方案 4.3），不等路由探针那一轮；不等结果（切号要等这个会话收场）
    onCarpoolRejection: (rejection) => {
      void orgSwitch.now({ by: '拼车会话被拒', rejection });
    },
    log: taskLog,
  };
  const taskRuns = realRuns({ db });
  // 选路给三段的一段预占的池的名额（#757）：开跑那一行（taskRuns.start）换掉，没开跑就收场的由这两个活动放掉
  const reservations = realReservations({ db });
  const runsDir = join(config.stateDir, 'runs');
  const tasks: EngineTasks = {
    ...createTaskActivities({ gh, trees, exec, log: taskLog }),
    runSegment: createRunSegment({
      tree: { gh, trees, exec, tmpDir: join(config.stateDir, 'tmp') },
      spawner: segmentSpawner,
      runs: taskRuns,
      reservations,
      attempts: realChannelAttempts({ db }),
      memoryAdmission: realMemoryAdmission(),
      runsDir,
      sessions: oneShots,
      log: taskLog,
    }),
    coldVerify: createColdVerify({
      gh,
      pickRoute: real.ports.pickRoute,
      spawner: segmentSpawner,
      runs: taskRuns,
      reservations,
      memoryAdmission: realMemoryAdmission(),
      runsDir,
      sessions: oneShots,
      log: taskLog,
    }),
  };
  const evidence = realReleaseEvidence(extra.releasesDir ? { releasesDir: extra.releasesDir } : {});
  const drainControl: Omit<DrainControlDeps, 'drain' | 'log'> = {
    readRequest: () => readDrainRequest(drainRequestFile(evidence.releasesDir)),
    releaseLockBusy: () => evidence.releaseLockBusy(),
    ownSha: extra.ownSha ?? null,
    // 到截止停下三段的一次性会话（动手、验收，#957）；老 Fusion 会话端口已删，没有别的会话要停
    stopSessions: (why) => oneShots.drainStop(why),
    notify: drainNotifier({ db, machine: config.machine }),
  };
  return {
    ...real,
    jobs,
    tasks,
    drainControl,
    stateDir: config.stateDir,
    registerJobs: async () => {
      await registerEngineJobs(db);
      // 拼车并发上限和仓里登记的对不对得上（#194 方案 4.7）：对不上推提醒、不挡接活（拼车池由选路按 carpoolCap.view() 不派，#896）；
      // 库读不了照样抛，registerJobs 这一步不当成对上了
      await carpoolCap.check();
      // issue 归类登记不上只报错，不挡引擎接活。错误分流、停滞预判不再在这里登记。
      const issueKindRegistered = await issueKindJev.register();
      if (issueKindRegistered.level === 'error') console.error(issueKindRegistered.message);
      else console.info(issueKindRegistered.message);
    },
    retireSchedules: (client: Pick<Client, 'schedule'>) => retireEngineSchedules(client, db),
    master,
    recordSkippedRun: async (jobId, why) => {
      const at = new Date();
      const id = await startScheduleRun(db, jobId, at);
      await finishScheduleRun(db, id, { outcome: 'partial', why }, at);
    },
    jobLastStartedAt: async () =>
      new Map(
        (await scheduleHealth(db)).flatMap((h) =>
          h.lastRun ? [[h.job.id, h.lastRun.startedAt] as const] : [],
        ),
      ),
    close: async () => {
      await wakeClient
        .close()
        .catch((error: unknown) => console.error('叫醒用的 Temporal 连接没关干净', errMessage(error)));
      await close();
    },
  };
}
