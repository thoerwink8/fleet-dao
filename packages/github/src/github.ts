// 装配：一个对象给引擎用（活动的真实现）、给后端用（事件之后的处理）、给定时任务用（对账补漏）。
// 生产：createGitHub({ ledger: pgLedger(db), locker: pgLocker(db) })——凭据从 /etc/fleet-dao/github 读（环境变量可改），
// 推送用的裸仓放在 FLEET_GITHUB_STATE_DIR（默认 /var/lib/fleet-dao/github）下。
import { join } from 'node:path';
import { z } from 'zod';
import { GitHubClient, type Logger, type RepoRef, repoSlug, type Sleep, unexpected } from './client.ts';
import { type AppCredentials, type AppRole, appFilesFromEnv, loadApps, ROLE_NAMES } from './credentials.ts';
import {
  type ActivityContext,
  type BotIdentity,
  Bots,
  type Deps,
  type Locker,
  memoryLocker,
} from './deps.ts';
import { createEventSink, type EventSink, type WorkflowWaker } from './events.ts';
import { execGit, type GitRunner } from './git.ts';
import {
  type InteractionLimitInput,
  type InteractionLimitResult,
  renewInteractionLimit,
} from './interaction.ts';
import {
  type CloseIssueInput,
  type CloseIssueResult,
  closeIssue,
  type UpdateIssueProgressInput,
  type UpdateIssueProgressResult,
  updateIssueProgress,
} from './issues.ts';
import type { Ledger } from './ledger.ts';
import {
  type CiWaitResult,
  type MergePrInput,
  type MergePrResult,
  mergePr,
  type OpenPrInput,
  type OpenPrResult,
  openPr,
  type WaitCiInput,
  waitCi,
} from './pulls.ts';
import { MAX_BUNDLE_BYTES, type PushBranchInput, type PushBranchResult, pushBranch } from './push.ts';
import { createReconciler, type Reconciler, type ReconcilerOptions } from './reconcile.ts';
import { RepoFactsCache } from './repos.ts';

export interface GitHubOptions {
  /** 防重复写的账、PR 镜像：生产用 pgLedger(db)。 */
  ledger: Ledger;
  /** 同一张 issue 的进度写入、同一个仓的合并串行：生产用 pgLocker(db)（跨工人），默认只在本进程内。 */
  locker?: Locker;
  /** 不给就从本机配置读（appFilesFromEnv(env)）。 */
  apps?: Record<AppRole, AppCredentials>;
  env?: Record<string, string | undefined>;
  log?: Logger;
  /** 限流时原地最多等多久（见 GitHubClientOptions）；活动的心跳超时要比它长。 */
  maxRateLimitWaitMs?: number;
  /** 以下测试用。 */
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: Sleep;
  git?: GitRunner;
  gitHost?: string;
  gitUrl?: (repo: RepoRef) => string;
  stateDir?: string;
  writeSpacingMs?: number;
  leaseRenewMs?: number;
  /** 会话交来的包最大多少字节，默认 MAX_BUNDLE_BYTES。 */
  maxBundleBytes?: number;
}

/** 各身份要有的权限（自检用）。「干活的」只推分支、开 PR；「引擎」合并、改 issue、续互动限制、读 CI。 */
export const REQUIRED_PERMISSIONS: Record<AppRole, Record<string, 'read' | 'write'>> = {
  agent: { contents: 'write', pull_requests: 'write', metadata: 'read' },
  engine: {
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    administration: 'write',
    checks: 'read',
    actions: 'read',
    metadata: 'read',
  },
};

export interface SelfCheckItem {
  role: AppRole;
  repo: string;
  ok: boolean;
  /** 缺的权限；读不到时为空、why 里写原因。 */
  missing: string[];
  /** 机器人不该有却有的写权限（例如「干活的」有 issues:write）。 */
  extra: string[];
  why?: string | undefined;
}

export interface GitHub {
  client: GitHubClient;
  deps: Deps;
  pushBranch(input: PushBranchInput, ctx?: ActivityContext): Promise<PushBranchResult>;
  openPr(input: OpenPrInput, ctx?: ActivityContext): Promise<OpenPrResult>;
  waitCi(input: WaitCiInput, ctx?: ActivityContext): Promise<CiWaitResult>;
  mergePr(input: MergePrInput, ctx?: ActivityContext): Promise<MergePrResult>;
  updateIssueProgress(
    input: UpdateIssueProgressInput,
    ctx?: ActivityContext,
  ): Promise<UpdateIssueProgressResult>;
  closeIssue(input: CloseIssueInput, ctx?: ActivityContext): Promise<CloseIssueResult>;
  renewInteractionLimit(input: InteractionLimitInput, ctx?: ActivityContext): Promise<InteractionLimitResult>;
  /** 会话提交用的身份（「干活的」机器人）：引擎建工作树时写进 user.name / user.email。 */
  commitIdentity(repo: RepoRef): Promise<BotIdentity>;
  /** 两个机器人在这些仓上的权限够不够。读不到算没查成（ok=false、why 写原因），不算「没有差异」。 */
  selfCheck(repos: RepoRef[]): Promise<SelfCheckItem[]>;
  eventSink(waker: WorkflowWaker): EventSink;
  reconciler(options: ReconcilerOptions): Reconciler;
}

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

export function createGitHub(options: GitHubOptions): GitHub {
  const env = options.env ?? process.env;
  const apps = options.apps ?? loadApps(appFilesFromEnv(env));
  const client = new GitHubClient({
    apps,
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.writeSpacingMs !== undefined ? { writeSpacingMs: options.writeSpacingMs } : {}),
    ...(options.maxRateLimitWaitMs !== undefined ? { maxRateLimitWaitMs: options.maxRateLimitWaitMs } : {}),
  });
  const deps: Deps = {
    client,
    facts: new RepoFactsCache(client),
    ledger: options.ledger,
    locker: options.locker ?? memoryLocker(),
    bots: new Bots(client),
    log: client.log,
    leaseRenewMs: options.leaseRenewMs,
  };
  const stateDir = options.stateDir ?? env.FLEET_GITHUB_STATE_DIR ?? '/var/lib/fleet-dao/github';
  const gitHost = options.gitHost ?? 'https://github.com/';
  const pushDeps = {
    client,
    facts: deps.facts,
    git: options.git ?? execGit,
    gitUrl: options.gitUrl ?? ((r: RepoRef) => `${gitHost.replace(/\/+$/, '')}/${r.owner}/${r.name}.git`),
    gitHost,
    mirrorRoot: join(stateDir, 'mirrors'),
    maxBundleBytes: options.maxBundleBytes ?? MAX_BUNDLE_BYTES,
    log: client.log,
    baseEnv: env,
  };

  return {
    client,
    deps,
    async pushBranch(input, ctx = {}) {
      return pushBranch(pushDeps, { ...input, signal: input.signal ?? ctx.signal });
    },
    openPr: (input, ctx) => openPr(deps, input, ctx),
    waitCi: (input, ctx) => waitCi(deps, input, ctx),
    mergePr: (input, ctx) => mergePr(deps, input, ctx),
    updateIssueProgress: (input, ctx) => updateIssueProgress(deps, input, ctx),
    closeIssue: (input, ctx) => closeIssue(deps, input, ctx),
    renewInteractionLimit: (input, ctx) => renewInteractionLimit(deps, input, ctx),
    commitIdentity: (repo) => deps.bots.identity('agent', repo),
    async selfCheck(repos) {
      const out: SelfCheckItem[] = [];
      for (const repo of repos) {
        for (const role of ['agent', 'engine'] as const) {
          try {
            const id = await client.installationId(role, repo, undefined, { fresh: true });
            const res = await client.request({
              method: 'GET',
              path: `/app/installations/${id}`,
              auth: { as: 'app', role },
            });
            const parsed = z.object({ permissions: z.record(z.string(), z.string()) }).safeParse(res.data);
            if (!parsed.success) throw unexpected('读安装的权限表', res.data);
            const have = parsed.data.permissions;
            const need = REQUIRED_PERMISSIONS[role];
            const missing = Object.entries(need)
              .filter(([k, lvl]) => (LEVEL[have[k] ?? ''] ?? 0) < (LEVEL[lvl] ?? 0))
              .map(([k, lvl]) => `${k}:${lvl}`);
            // 「干活的」不该能改 issue：摘掉之后「issue 只经引擎写」在 GitHub 这层就成立
            const extra = role === 'agent' && (LEVEL[have.issues ?? ''] ?? 0) >= 2 ? ['issues:write'] : [];
            out.push({ role, repo: repoSlug(repo), ok: missing.length === 0, missing, extra });
          } catch (err) {
            out.push({
              role,
              repo: repoSlug(repo),
              ok: false,
              missing: [],
              extra: [],
              why: `${ROLE_NAMES[role]}没查成：${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
      return out;
    },
    eventSink: (waker) => createEventSink(deps, waker),
    reconciler: (reconcilerOptions) => createReconciler(deps, reconcilerOptions),
  };
}
