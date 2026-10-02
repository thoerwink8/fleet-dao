// 真端口的装配：库（packages/db）、GitHub（packages/github）、会话（packages/adapters 的插头，按执行方式分派：Claude Code、
// cursor-agent，real/hosts.ts）、工作树（fleet-agent-scope）各一份，拼成 EnginePorts。生产按环境变量装（realPortsFromEnv，
// 见 deploy/france/engine.env.example）；缺了哪一项就不起，讲清楚缺什么，不带着半套配置接活。

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bridgeMirasimConnector,
  type LedgerFs,
  type MirasimConnect,
  SESSION_USERS,
  type SessionUser,
  switchSessionOrg,
} from '@fleet-dao/adapters';
import { createDb, type Db } from '@fleet-dao/db';
import { assertPublishable, createGitHub, pgLedger, pgLocker } from '@fleet-dao/github';
import type { Client } from '@temporalio/client';
import type { EngineJobs, EngineTasks } from '../activities.ts';
import type { EngineDrain } from '../drain.ts';
import { type DrainControlDeps, drainRequestFile, readDrainRequest } from '../drain-control.ts';
import type { JevPort } from '../failure/jev.ts';
import { SESSION_MEMORY_HIGH_MB, SESSION_MEMORY_MAX_MB } from '../limits.ts';
import type { EnginePorts } from '../ports.ts';
import { canaryJob } from './canary.ts';
import { drainNotifier } from './drain-alerts.ts';
import { describeFailure, scopeExec, type UserExec } from './exec.ts';
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
import { issueGroomIdlePolicyFromEnv } from './issue-groom.ts';
import { issueKindJevFromEnv } from './issue-kind-jev.ts';
import { engineJevFromEnv } from './jev-port.ts';
import { registerEngineJobs } from './jobs.ts';
import { realKillEvidence } from './kill-evidence.ts';
import { realMemoryAdmission } from './memory-admission.ts';
import { orgDriftReporter, orgSwitchRound } from './org-switch.ts';
import { retireEngineSchedules } from './retire-schedules.ts';
import { routeProbeJob } from './route-probe.ts';
import { realRuns } from './runs-writer.ts';
import { checkIoRoot, DEFAULT_SESSION_IO_DIR, reportIoRoot } from './session-io.ts';
import { type SessionOrgReader, sessionOrgReader } from './session-org.ts';
import {
  createSessionPorts,
  DEFAULT_FORK_MAX_CONTEXT_TOKENS,
  type OrgSwitchSessions,
  type SessionPortsDeps,
} from './sessions.ts';
import { createStorePorts } from './store-ports.ts';
import { createTaskActivities } from './task-activities.ts';
import { createRunSegment } from './task-segment.ts';
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
  machine: string;
  claudeCommand(user: SessionUser): string[];
  cursorCommand(user: SessionUser): string[];
  grokCommand(user: SessionUser): string[];
  /** 会话用户自己的 Mirasim 服务：连接工厂、账本目录、读账本用的文件访问（mirasimDepsFor 生产装配）。 */
  mirasimConnect(user: SessionUser): MirasimConnect;
  mirasimLedgerDir(user: SessionUser): string;
  mirasimLedgerFs(user: SessionUser): LedgerFs;
  forkMaxContextTokens?: number;
  /** 错误分流、停滞预判问 Jev 用（real/jev-port.ts）；不给就不问，照规则走。 */
  jev?: JevPort;
  /**
   * 排空（drain.ts）：在排空时选路回「过一会儿再选」、起会话直接拒；在途会话登记在它上面，到截止按切号那一套停下。
   * 不给就不闸（测试、只起一次的工具）。
   */
  drain?: EngineDrain;
  /**
   * 发给别家（开 PR 前验证）的材料过卫生检查：生产用 github 包的 assertPublishable，和推分支、开 PR 同一套规则。
   * 不给就发不出去（验证会话起不来，报 HYGIENE_UNSCANNED），不当成查过了。
   */
  screen?: SessionPortsDeps['screen'];
  /** 会话脱开引擎跑的收发目录的根（session-io.ts，核过能用才给）；不给就接管道（引擎一停会话就断）。 */
  ioRoot?: string;
  /** 以下测试用。 */
  session?: Partial<
    Pick<
      SessionPortsDeps,
      | 'helper'
      | 'sudo'
      | 'gitBin'
      | 'shBin'
      | 'run'
      | 'now'
      | 'tickMs'
      | 'stallCheckMs'
      | 'flushMs'
      | 'baseEnv'
    >
  >;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface RealPorts {
  ports: EnginePorts;
  reapOrphanSessions(): Promise<number>;
  /** 切号那一刻在跑的会话（#59）：交给 real/org-switch.ts 停下、等收场。 */
  orgSwitchSessions: OrgSwitchSessions;
  /** 排空到截止时停下还在跑的会话（交回 engine_stop，按编号续上）；返回这次叫停的。 */
  drainStop(why: string): string[];
  /** 停机时放手脱开跑的会话（不停它们），新引擎起来接回；返回放手的。 */
  releaseDetached(): string[];
}

export function createRealPorts(deps: RealPortsDeps): RealPorts {
  const store = createStorePorts({
    db: deps.db,
    sessionOrg: deps.sessionOrg,
    ...(deps.drain ? { drain: deps.drain } : {}),
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
  const sessions = createSessionPorts({
    db: deps.db,
    trees: deps.trees,
    exec: deps.exec,
    gh: deps.gh,
    tmpDir: deps.tmpDir,
    machine: deps.machine,
    claudeCommand: deps.claudeCommand,
    cursorCommand: deps.cursorCommand,
    grokCommand: deps.grokCommand,
    mirasimConnect: deps.mirasimConnect,
    mirasimLedgerDir: deps.mirasimLedgerDir,
    mirasimLedgerFs: deps.mirasimLedgerFs,
    ...(deps.forkMaxContextTokens === undefined ? {} : { forkMaxContextTokens: deps.forkMaxContextTokens }),
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.jev ? { jev: deps.jev } : {}),
    ...(deps.screen ? { screen: deps.screen } : {}),
    ...(deps.drain ? { drain: deps.drain } : {}),
    ...(deps.ioRoot ? { ioRoot: deps.ioRoot } : {}),
    ...deps.session,
  });
  const ports: EnginePorts = {
    pickRoute: store.pickRoute,
    askHuman: store.askHuman,
    taskAsks: store.taskAsks,
    markAsksApplied: store.markAsksApplied,
    requestApproval: store.requestApproval,
    raiseAlert: store.raiseAlert,
    recordTiming: store.recordTiming,
    saveTaskState: store.saveTaskState,
    authorFamilies: store.authorFamilies,
    recordVerification: store.recordVerification,
    flowConfig: store.flowConfig,
    taskRequest: store.taskRequest,
    readCriteria: github.readCriteria,
    createWorktree: github.createWorktree,
    removeWorktree: github.removeWorktree,
    pushBranch: github.pushBranch,
    openPr: github.openPr,
    waitCi: github.waitCi,
    checkHighRisk: github.checkHighRisk,
    postSecondOpinion: github.postSecondOpinion,
    patchIdOf: github.patchIdOf,
    syncMainline: github.syncMainline,
    runTests: github.runTests,
    mergePr: github.mergePr,
    updateIssueProgress: github.updateIssueProgress,
    closeIssue: github.closeIssue,
    writeSpecDoc: github.writeSpecDoc,
    startSession: sessions.startSession,
    awaitSession: sessions.awaitSession,
    stopSession: sessions.stopSession,
  };
  return {
    ports,
    reapOrphanSessions: sessions.reapOrphanSessions,
    orgSwitchSessions: sessions.orgSwitch,
    drainStop: sessions.drainStop,
    releaseDetached: sessions.releaseDetached,
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
 */
export const DEFAULT_MIRASIM_BRIDGE_SCRIPT = fileURLToPath(
  new URL('../../../adapters/src/mirasim/bridge.ts', import.meta.url),
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
  forkMaxContextTokens: number;
  /** 会话脱开引擎跑的收发目录的根（FLEET_SESSION_IO_DIR，默认 DEFAULT_SESSION_IO_DIR）。 */
  sessionIoDir: string;
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
  const rawFork = env.FLEET_FORK_MAX_CONTEXT_TOKENS?.trim();
  const forkMaxContextTokens = rawFork ? Number(rawFork) : DEFAULT_FORK_MAX_CONTEXT_TOKENS;
  if (!Number.isInteger(forkMaxContextTokens) || forkMaxContextTokens <= 0) {
    problems.push(`FLEET_FORK_MAX_CONTEXT_TOKENS 要是正整数（现在是 ${rawFork}）`);
  }
  const sessionIoDir = env.FLEET_SESSION_IO_DIR?.trim() || DEFAULT_SESSION_IO_DIR;
  if (!sessionIoDir.startsWith('/'))
    problems.push(`FLEET_SESSION_IO_DIR 要写绝对路径（现在是 ${sessionIoDir}）`);
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
    forkMaxContextTokens,
    sessionIoDir,
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

/** 经 exec 以那个会话用户 cat 一个文件：值不上命令行、不进日志（只有路径在 argv 里）。 */
async function catAsUser(exec: UserExec, user: SessionUser, path: string): Promise<string> {
  const r = await execAs(exec, user, ['/bin/cat', '--', path], 'mirasim-cat');
  if (r.code !== 0) throw new Error(describeFailure(`读 ${path}`, r));
  return r.stdout.toString('utf8');
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
  /** 任务工作流（#632）的真活动：不碰会话的五个加动手会话；coldVerify 还没接（接之前报 TASK_NOT_CONFIGURED）。 */
  tasks: EngineTasks;
  registerJobs(): Promise<void>;
  /** 引擎起来对齐定时任务之后跑一遍：把退役名单（jobs/retired-schedules.ts）里 Temporal 上还在的删掉，见 real/retire-schedules.ts。 */
  retireSchedules(client: Pick<Client, 'schedule'>): Promise<void>;
  close(): Promise<void>;
  stateDir: string;
  /** 排空要的几样（drain-control.ts）：读发布脚本的排空请求、查发布锁、到点停会话、报提醒。 */
  drainControl: Omit<DrainControlDeps, 'drain' | 'log'>;
} {
  const config = realPortsConfigFromEnv(env);
  const { db, close } = createDb({ env: env as Record<string, string | undefined> });
  const gh = createGitHub({
    ledger: pgLedger(db),
    locker: pgLocker(db),
    env: env as Record<string, string | undefined>,
  });
  const trees = helperWorkTrees({ root: config.workRoot });
  const { claudeCommand, cursorCommand, grokCommand } = agentCommands(config);
  // 判断题：起来时读一遍 jev.json、建一遍后端、登记两道题（registerJobs）；之后每次问都现找一遍（改了配置、调度台换了
  // 判断路由不用重启，和 /healthz 的 judge 项同一个判法）。默认位置上没有 jev.json 才算没接、不问；别的读不成都报错。
  const jev = engineJevFromEnv(db, env);
  // 单子归类（#448）问的是同一份判断题配置，只是另一道题（issue-kind），走自己的一份轻量装配，不挤 jev.port 那套
  // choice/effect 抽象（见 issue-kind-jev.ts 顶注）；起来时也要登记，同一个 registerJobs 里跟着登记。
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
  // 会话脱开引擎跑（发布不碰在跑的会话）：收发目录的根核过能用才开；不能用照旧接管道起会话，推提醒说清这一版发布还会停会话
  const ioProblem = checkIoRoot(config.sessionIoDir);
  if (ioProblem) console.error(`会话不脱开跑（发布、重启引擎还会停在跑的会话）：${ioProblem}`);
  void reportIoRoot(db, config.machine, ioProblem).catch((error: unknown) =>
    console.error('收发目录的提醒没写进库', error instanceof Error ? error.message : String(error)),
  );
  const sessionOrg = sessionOrgReader({
    exec,
    user: sessionUser,
    reclaude: claudeCommand(sessionUser),
    onEvent: orgDriftReporter({ db, user: sessionUser, machine: config.machine }),
  });
  const real = createRealPorts({
    db,
    jev: jev.port,
    gh,
    // 发给别家的验证材料和推分支、开 PR 用同一套卫生检查（真密钥；只管 fleet-dao 这个仓，别的仓按它们自己的标准）。
    // guard 从 gh 里取同一份：配置里改了 hygieneRepo，这条路上也得跟着改，不然两边认的仓不一样。
    screen: (repo, what, texts) => assertPublishable(repo, what, texts, gh.deps.hygieneRepo),
    trees,
    exec,
    sessionOrg,
    tmpDir: join(config.stateDir, 'tmp'),
    archiveDir: join(config.stateDir, 'archive'),
    machine: config.machine,
    claudeCommand,
    cursorCommand,
    grokCommand,
    mirasimConnect: mirasim.connect,
    mirasimLedgerDir: mirasim.ledgerDir,
    mirasimLedgerFs: mirasim.ledgerFs,
    forkMaxContextTokens: config.forkMaxContextTokens,
    ...(extra.drain ? { drain: extra.drain } : {}),
    ...(ioProblem ? {} : { ioRoot: config.sessionIoDir }),
  });
  // 拼车用满切独享、恢复了切回（#157）：路由探针每一轮探之前判，经 root 帮手的 org-use 切；手上跑在 Claude 池上的会话
  // 先停下、切完续上（#59，换了池 fork 续上），不等它们跑完
  const orgSwitch = orgSwitchRound({
    db,
    org: sessionOrg,
    user: sessionUser,
    switchOrg: (to) => switchSessionOrg({ to, user: sessionUser }),
    sessions: real.orgSwitchSessions,
    machine: config.machine,
  });
  const jobs: EngineJobs = {
    githubReconcile: githubReconcileJob({
      db,
      gh,
      askIssueKind: issueKindJev.askKind,
      issueGroomIdlePolicy: issueGroomIdlePolicyFromEnv(env),
    }),
    // 路由探针和干活的会话用同一份执行体（reclaude、cursor-agent、grok、Mirasim）、同一个工作树的根（探针目录在它下面）
    routeProbe: routeProbeJob({
      db,
      trees,
      claudeCommand,
      cursorCommand,
      grokCommand,
      mirasimConnect: mirasim.connect,
      mirasimLedgerDir: mirasim.ledgerDir,
      mirasimLedgerFs: mirasim.ledgerFs,
      sessionOrg,
      orgSwitch,
      machine: config.machine,
    }),
    // 每小时对账：同一个工作树管家（删树经 fleet-agent-scope）、同一个会话用户执行器（看树里还剩什么）；引擎这份 GitHub
    // （同一套 App 凭据）审合了的 PR、给排队的单补拉时现读挂在哪个版本、做两个机器人的权限自检
    hourlyReconcile: hourlyReconcileJob({
      db,
      gh,
      trees,
      exec,
      sessionOrg,
      machine: config.machine,
      selfCheck: (repos) => gh.selfCheck(repos),
    }),
    // 全流程巡检（#223）：巡检仓写在引擎配置 FLEET_CANARY_REPO（没配这一轮记没跑成，看门狗报）；开单、写需求文档、挂版本都是「引擎」机器人
    canary: canaryJob({ db, gh, repo: env.FLEET_CANARY_REPO }),
    // 看门狗（#203）：按登记表看上面这些（和备份那几个）新不新鲜，没跑成、停了推提醒，恢复了自己撤
    watchdog: watchdogJob({ db }),
  };
  const taskLog = (message: string, fields?: Record<string, unknown>) => console.info(message, fields ?? {});
  // 动手会话（#632 S2-4b-2）：和 Fusion 的会话用同一份执行方式驱动，但自己一份（驱动没有状态，只是包着各家的 run 函数）；
  // 内存准入、会话的资源上限、runs 记账都用生产的那份。
  const tasks: EngineTasks = {
    ...createTaskActivities({ gh, trees, exec, log: taskLog }),
    runSegment: createRunSegment({
      tree: { gh, trees, exec, tmpDir: join(config.stateDir, 'tmp') },
      spawner: {
        db,
        drivers: hostDrivers({
          claudeCommand,
          cursorCommand,
          grokCommand,
          mirasimConnect: mirasim.connect,
          mirasimLedgerDir: mirasim.ledgerDir,
          mirasimLedgerFs: mirasim.ledgerFs,
        }),
        trees,
        baseEnv: env,
        resources: { memoryHighMb: SESSION_MEMORY_HIGH_MB, memoryMaxMb: SESSION_MEMORY_MAX_MB, swapMaxMb: 0 },
        log: taskLog,
      },
      runs: realRuns({ db }),
      memoryAdmission: realMemoryAdmission(),
      runsDir: join(config.stateDir, 'runs'),
      log: taskLog,
    }),
  };
  const evidence = realKillEvidence(extra.releasesDir ? { releasesDir: extra.releasesDir } : {});
  const drainControl: Omit<DrainControlDeps, 'drain' | 'log'> = {
    readRequest: () => readDrainRequest(drainRequestFile(evidence.releasesDir)),
    releaseLockBusy: () => evidence.releaseLockBusy(),
    ownSha: extra.ownSha ?? null,
    stopSessions: (why) => real.drainStop(why),
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
      // 判断题起不来、登记不上只报错（error 级日志 + /healthz 的 judge 项红），不挡引擎接活：照规则走一样能干。
      const registered = await jev.register();
      if (registered.level === 'error') console.error(registered.message);
      else console.info(registered.message);
      const issueKindRegistered = await issueKindJev.register();
      if (issueKindRegistered.level === 'error') console.error(issueKindRegistered.message);
      else console.info(issueKindRegistered.message);
    },
    retireSchedules: (client: Pick<Client, 'schedule'>) => retireEngineSchedules(client, db),
    close,
  };
}
