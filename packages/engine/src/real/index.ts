// 真端口的装配：库（packages/db）、GitHub（packages/github）、会话（packages/adapters 的插头，按执行方式分派：Claude Code、
// cursor-agent，real/hosts.ts）、工作树（fleet-agent-scope）各一份，拼成 EnginePorts。生产按环境变量装（realPortsFromEnv，
// 见 deploy/france/engine.env.example）；缺了哪一项就不起，讲清楚缺什么，不带着半套配置接活。

import { join } from 'node:path';
import { SESSION_USERS, type SessionUser, switchSessionOrg } from '@fleet-dao/adapters';
import { createDb, type Db } from '@fleet-dao/db';
import { assertPublishable, createGitHub, pgLedger, pgLocker } from '@fleet-dao/github';
import type { EngineJobs } from '../activities.ts';
import type { EngineDrain } from '../drain.ts';
import { type DrainControlDeps, drainRequestFile, readDrainRequest } from '../drain-control.ts';
import type { JevPort } from '../failure/jev.ts';
import type { EnginePorts } from '../ports.ts';
import { alertDispatchJob } from './alert-dispatch.ts';
import { canaryJob } from './canary.ts';
import { drainNotifier } from './drain-alerts.ts';
import { scopeExec, type UserExec } from './exec.ts';
import { createGitHubPorts, type EngineGitHub } from './github-ports.ts';
import { githubReconcileJob } from './github-reconcile.ts';
import {
  cursorLaunchCommand,
  DEFAULT_CURSOR_API_KEY_FILE,
  DEFAULT_CURSOR_VERSIONS_DIR,
  DEFAULT_GROK_BIN,
  grokLaunchCommand,
} from './hosts.ts';
import { hourlyReconcileJob } from './hourly-reconcile.ts';
import { engineJevFromEnv } from './jev-port.ts';
import { registerEngineJobs } from './jobs.ts';
import { realKillEvidence } from './kill-evidence.ts';
import { orgDriftReporter, orgSwitchRound } from './org-switch.ts';
import { routeProbeJob } from './route-probe.ts';
import { checkIoRoot, DEFAULT_SESSION_IO_DIR, reportIoRoot } from './session-io.ts';
import { type SessionOrgReader, sessionOrgReader } from './session-org.ts';
import {
  createSessionPorts,
  DEFAULT_FORK_MAX_CONTEXT_TOKENS,
  type OrgSwitchSessions,
  type SessionPortsDeps,
} from './sessions.ts';
import { createStorePorts } from './store-ports.ts';
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
  forkMaxContextTokens?: number;
  /** 错误分流、停滞预判问 Jev 用（real/jev-port.ts）；不给就不问，照规则走。 */
  jev?: JevPort;
  /**
   * 排空（drain.ts）：在排空时选路回「过一会儿再选」、起会话直接拒；在途会话登记在它上面，到截止按切号那一套停下。
   * 不给就不闸（测试、只起一次的工具）。
   */
  drain?: EngineDrain;
  /**
   * 发给别家（开 PR 前验证）的材料过卫生检查：生产用 github 包的 assertPublishable 和推分支同一份名单。
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

export interface RealPortsConfig {
  machine: string;
  workRoot: string;
  stateDir: string;
  claudeBin: string;
  /** 会话用户家里 cursor-agent 的版本目录（{user} 换成会话用户）：每次起都在这下面现找 current → 最新版本。 */
  cursorVersionsDir: string;
  /** 会话用户家里的 grok（{user} 换成会话用户）：每次起都由会话用户先看它在不在。 */
  grokBin: string;
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

/**
 * 生产：按环境变量装真端口，连同定时任务要的东西（jobs）和起来时的登记（registerJobs：定时任务、判断题）。
 * 返回的 close 在工人停下后关库连接。
 */
export function realPortsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  extra: { drain?: EngineDrain; ownSha?: string | null; releasesDir?: string } = {},
): RealPorts & {
  jobs: EngineJobs;
  registerJobs(): Promise<void>;
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
  const exec = scopeExec();
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
    // 发给别家的验证材料和推分支、开 PR 用同一份已知敏感值名单（createGitHub 按环境变量找的那份）
    screen: (what, texts) => assertPublishable(what, texts, gh.deps.sensitiveValues),
    trees,
    exec,
    sessionOrg,
    tmpDir: join(config.stateDir, 'tmp'),
    archiveDir: join(config.stateDir, 'archive'),
    machine: config.machine,
    claudeCommand,
    cursorCommand,
    grokCommand,
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
    githubReconcile: githubReconcileJob({ db, gh }),
    // 路由探针和干活的会话用同一份执行体（reclaude、cursor-agent、grok）、同一个工作树的根（探针目录在它下面）
    routeProbe: routeProbeJob({
      db,
      trees,
      claudeCommand,
      cursorCommand,
      grokCommand,
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
    // 提醒派单（design 15.3「谁在处理」）：没人认领、停着没动的提醒再推，没挂单的卡住报警开跟进单（「引擎」机器人开，不开在巡检仓）
    alertDispatch: alertDispatchJob({ db, gh, canaryRepo: env.FLEET_CANARY_REPO }),
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
    drainControl,
    stateDir: config.stateDir,
    registerJobs: async () => {
      await registerEngineJobs(db);
      // 判断题起不来、登记不上只报错（error 级日志 + /healthz 的 judge 项红），不挡引擎接活：照规则走一样能干。
      const registered = await jev.register();
      if (registered.level === 'error') console.error(registered.message);
      else console.info(registered.message);
    },
    close,
  };
}
