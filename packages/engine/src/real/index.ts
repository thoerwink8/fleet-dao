// 真端口的装配：库（packages/db）、GitHub（packages/github）、会话（packages/adapters 的 Claude Code 插头）、
// 工作树（fleet-agent-scope）各一份，拼成 EnginePorts。生产按环境变量装（realPortsFromEnv，见 deploy/france/engine.env.example）；
// 缺了哪一项就不起，讲清楚缺什么，不带着半套配置接活。

import { join } from 'node:path';
import type { SessionUser } from '@fleet-dao/adapters';
import { createDb, type Db } from '@fleet-dao/db';
import { createGitHub, pgLedger, pgLocker } from '@fleet-dao/github';
import type { EngineJobs } from '../activities.ts';
import type { JevPort } from '../failure/jev.ts';
import type { EnginePorts } from '../ports.ts';
import { scopeExec, type UserExec } from './exec.ts';
import { createGitHubPorts, type EngineGitHub } from './github-ports.ts';
import { githubReconcileJob, registerEngineJobs } from './github-reconcile.ts';
import { engineJevFromEnv } from './jev-port.ts';
import { createSessionPorts, DEFAULT_FORK_MAX_CONTEXT_TOKENS, type SessionPortsDeps } from './sessions.ts';
import { createStorePorts } from './store-ports.ts';
import { DEFAULT_WORK_ROOT, helperWorkTrees, type WorkTrees } from './worktrees.ts';

export interface RealPortsDeps {
  db: Db;
  gh: EngineGitHub;
  trees: WorkTrees;
  exec: UserExec;
  /** 引擎自己的临时目录（bundle）、存档目录（没合并就收的树里没提交的改动）。 */
  tmpDir: string;
  archiveDir: string;
  machine: string;
  claudeCommand(user: SessionUser): string[];
  forkMaxContextTokens?: number;
  /** 错误分流、停滞预判问 Jev 用（real/jev-port.ts）；不给就不问，照规则走。 */
  jev?: JevPort;
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
}

export function createRealPorts(deps: RealPortsDeps): RealPorts {
  const store = createStorePorts({
    db: deps.db,
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
    ...(deps.forkMaxContextTokens === undefined ? {} : { forkMaxContextTokens: deps.forkMaxContextTokens }),
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.jev ? { jev: deps.jev } : {}),
    ...deps.session,
  });
  const ports: EnginePorts = {
    pickRoute: store.pickRoute,
    askHuman: store.askHuman,
    requestApproval: store.requestApproval,
    raiseAlert: store.raiseAlert,
    recordTiming: store.recordTiming,
    saveTaskState: store.saveTaskState,
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
  return { ports, reapOrphanSessions: sessions.reapOrphanSessions };
}

/** reclaude 装在会话用户自己家里（docs/ops.md 第五节）；{user} 换成会话用户。 */
export const DEFAULT_CLAUDE_BIN = '/home/{user}/.local/bin/reclaude';
export const DEFAULT_ENGINE_STATE_DIR = '/var/lib/fleet-dao/engine';

export interface RealPortsConfig {
  machine: string;
  workRoot: string;
  stateDir: string;
  claudeBin: string;
  forkMaxContextTokens: number;
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
  const rawFork = env.FLEET_FORK_MAX_CONTEXT_TOKENS?.trim();
  const forkMaxContextTokens = rawFork ? Number(rawFork) : DEFAULT_FORK_MAX_CONTEXT_TOKENS;
  if (!Number.isInteger(forkMaxContextTokens) || forkMaxContextTokens <= 0) {
    problems.push(`FLEET_FORK_MAX_CONTEXT_TOKENS 要是正整数（现在是 ${rawFork}）`);
  }
  if (problems.length > 0) throw new Error(`真端口起不来，本机配置缺这些或不对：${problems.join('；')}`);
  return { machine, workRoot, stateDir, claudeBin, forkMaxContextTokens };
}

/**
 * 生产：按环境变量装真端口，连同定时任务要的东西（jobs）和起来时的登记（registerJobs：定时任务、判断题）。
 * 返回的 close 在工人停下后关库连接。
 */
export function realPortsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RealPorts & { jobs: EngineJobs; registerJobs(): Promise<void>; close(): Promise<void> } {
  const config = realPortsConfigFromEnv(env);
  const { db, close } = createDb({ env: env as Record<string, string | undefined> });
  const gh = createGitHub({
    ledger: pgLedger(db),
    locker: pgLocker(db),
    env: env as Record<string, string | undefined>,
  });
  // 判断题：起来时读一遍 jev.json、建一遍后端、登记两道题（registerJobs）；之后每次问都现找一遍（改了配置、调度台换了
  // 判断路由不用重启，和 /healthz 的 judge 项同一个判法）。默认位置上没有 jev.json 才算没接、不问；别的读不成都报错。
  const jev = engineJevFromEnv(db, env);
  const real = createRealPorts({
    db,
    jev: jev.port,
    gh,
    trees: helperWorkTrees({ root: config.workRoot }),
    exec: scopeExec(),
    tmpDir: join(config.stateDir, 'tmp'),
    archiveDir: join(config.stateDir, 'archive'),
    machine: config.machine,
    claudeCommand: (user) => [config.claudeBin.replaceAll('{user}', user)],
    forkMaxContextTokens: config.forkMaxContextTokens,
  });
  const jobs: EngineJobs = {
    githubReconcile: githubReconcileJob({ db, gh }),
  };
  return {
    ...real,
    jobs,
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
