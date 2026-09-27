// 装配：一个对象给引擎用（活动的真实现）、给后端用（事件之后的处理）、给定时任务用（对账补漏）。
// 生产：createGitHub({ ledger: pgLedger(db), locker: pgLocker(db) })——凭据从 /etc/fleet-dao/github 读（环境变量可改），
// 推送用的裸仓放在 FLEET_GITHUB_STATE_DIR（默认 /var/lib/fleet-dao/github）下。
import { join } from 'node:path';
import { type LoadedValues, loadSensitiveValues } from '@fleet-dao/hygiene';
import { z } from 'zod';
import {
  type BundleCommitsInput,
  type BundleCommitsResult,
  bundleCommits,
  type FetchMainlineInput,
  type FetchMainlineResult,
  fetchMainline,
} from './bundle.ts';
import { GitHubClient, type Logger, type RepoRef, repoSlug, type Sleep, unexpected } from './client.ts';
import {
  type ReadRepoFileInput,
  type ReadRepoFileResult,
  type ReadSpecDocInput,
  type ReadSpecDocResult,
  readRepoFile,
  readSpecDoc,
  type WriteSpecDocInput,
  type WriteSpecDocResult,
  writeSpecDoc,
} from './contents.ts';
import { type AppCredentials, type AppRole, appFilesFromEnv, loadApps, ROLE_NAMES } from './credentials.ts';
import {
  type ActivityContext,
  type BotIdentity,
  Bots,
  type Deps,
  type Locker,
  memoryLocker,
} from './deps.ts';
import { GitHubError } from './errors.ts';
import { createEventSink, type EventSink, type WorkflowWaker } from './events.ts';
import { execGit, type GitRunner } from './git.ts';
import {
  type InteractionLimitInput,
  type InteractionLimitResult,
  renewInteractionLimit,
} from './interaction.ts';
import { type IssuePlan, type ReadIssuePlanInput, readIssuePlan, readOpenMilestones } from './issue-plan.ts';
import {
  type CloseIssueInput,
  type CloseIssueResult,
  type CommentIssueInput,
  type CommentIssueResult,
  closeIssue,
  commentIssue,
  type OpenIssueInput,
  type OpenIssueResult,
  openIssue,
  readIssue,
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
import { type SyncMainlineInput, type SyncMainlineResult, syncMainline } from './sync.ts';

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
  /** 推分支前卫生检查用的已知敏感值名单；不给就按 packages/hygiene 的顺序找（服务器上是 /etc/fleet-dao/sensitive-values.txt）。 */
  sensitiveValues?: () => LoadedValues;
}

/**
 * 各身份要有的权限（自检用，引擎每小时对账跑一次、缺了报提醒、健康页 github_app 跟着红）。「干活的」只推分支、开 PR；
 * 「引擎」合并、改 issue、续互动限制、读 CI，还要在 PR 头上贴「认领对得上」（#299，commit status 要 statuses:write）。
 */
export const REQUIRED_PERMISSIONS: Record<AppRole, Record<string, 'read' | 'write'>> = {
  agent: { contents: 'write', pull_requests: 'write', metadata: 'read' },
  engine: {
    contents: 'write',
    pull_requests: 'write',
    issues: 'write',
    administration: 'write',
    checks: 'read',
    actions: 'read',
    statuses: 'write',
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
  /** 把最新主线并进 PR 分支、推上去（干净或本来就最新都算 clean；冲突、分支头对不上分别回 conflict / head_moved）。 */
  syncMainline(input: SyncMainlineInput, ctx?: ActivityContext): Promise<SyncMainlineResult>;
  /** 抓远端默认分支最新头进引擎的镜像（建工作树、并主线后快进都要先有这一步）。 */
  fetchMainline(input: FetchMainlineInput, ctx?: ActivityContext): Promise<FetchMainlineResult>;
  /** 从镜像打包给会话用户（`git fetch <bundle> <ref>` 用得到；会话读不到镜像本身）。 */
  bundleCommits(input: BundleCommitsInput, ctx?: ActivityContext): Promise<BundleCommitsResult>;
  openPr(input: OpenPrInput, ctx?: ActivityContext): Promise<OpenPrResult>;
  waitCi(input: WaitCiInput, ctx?: ActivityContext): Promise<CiWaitResult>;
  mergePr(input: MergePrInput, ctx?: ActivityContext): Promise<MergePrResult>;
  updateIssueProgress(
    input: UpdateIssueProgressInput,
    ctx?: ActivityContext,
  ): Promise<UpdateIssueProgressResult>;
  closeIssue(input: CloseIssueInput, ctx?: ActivityContext): Promise<CloseIssueResult>;
  /** 开一张单（幂等，按 key 认）：引擎对账时给提问另开一张（#259）；巡检（#223）每 6 小时在巡检仓开一张。 */
  openIssue(input: OpenIssueInput, ctx?: ActivityContext): Promise<OpenIssueResult>;
  /** 在一张 issue 上留一条评论（幂等，按 key 认），不关单、不改进度段：把回答写到提问那张单上。 */
  commentIssue(input: CommentIssueInput, ctx?: ActivityContext): Promise<CommentIssueResult>;
  renewInteractionLimit(input: InteractionLimitInput, ctx?: ActivityContext): Promise<InteractionLimitResult>;
  /** 需求文档直接写进默认分支（「引擎」机器人身份，Contents API）。 */
  writeSpecDoc(input: WriteSpecDocInput, ctx?: ActivityContext): Promise<WriteSpecDocResult>;
  /** 读默认分支上的需求文档；文件不在回 null。 */
  readSpecDoc(input: ReadSpecDocInput, ctx?: ActivityContext): Promise<ReadSpecDocResult | null>;
  /** 读默认分支头上的一个文件，带上读的是哪个提交（仓的流程配置 .fleet/flow.json 这样读）。读不到抛错，不当成文件不在。 */
  readRepoFile(input: ReadRepoFileInput, ctx?: ActivityContext): Promise<ReadRepoFileResult>;
  /**
   * 一张 issue 此刻挂在哪个里程碑、开没开着、重开过没有、是不是母单子单，加上仓里还开着的里程碑（「引擎」机器人一次 GraphQL
   * 现读）：接活判当前版本和母单子单、fleet-api handover 判能不能交都用它。读不到、认不出抛错，不拿「没挂」「开着」「独立单」顶。
   */
  readIssuePlan(input: ReadIssuePlanInput, ctx?: ActivityContext): Promise<IssuePlan>;
  /** 仓里此刻还开着的里程碑（「引擎」机器人现读）：巡检开单前找巡检仓的当前版本。读不到、没翻完抛错。 */
  readOpenMilestones(input: {
    repo: RepoRef;
    signal?: AbortSignal | undefined;
  }): Promise<{ number: number; title: string }[]>;
  /** 一张单此刻开没开着、关的原因（completed、not_planned……；开着是 null）。读不到、是 PR 都抛错。 */
  readIssueState(input: {
    repo: RepoRef;
    issueNumber: number;
    signal?: AbortSignal | undefined;
  }): Promise<{ state: 'open' | 'closed'; stateReason: string | null }>;
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
  // 推分支、写需求文档、开 PR 之前的卫生检查用同一份名单
  const sensitiveValues = options.sensitiveValues ?? (() => loadSensitiveValues({ env }));
  const deps: Deps = {
    client,
    facts: new RepoFactsCache(client),
    ledger: options.ledger,
    locker: options.locker ?? memoryLocker(),
    bots: new Bots(client),
    log: client.log,
    leaseRenewMs: options.leaseRenewMs,
    sensitiveValues,
  };
  const stateDir = options.stateDir ?? env.FLEET_GITHUB_STATE_DIR ?? '/var/lib/fleet-dao/github';
  const gitHost = options.gitHost ?? 'https://github.com/';
  const pushDeps = {
    client,
    facts: deps.facts,
    bots: deps.bots,
    git: options.git ?? execGit,
    gitUrl: options.gitUrl ?? ((r: RepoRef) => `${gitHost.replace(/\/+$/, '')}/${r.owner}/${r.name}.git`),
    gitHost,
    mirrorRoot: join(stateDir, 'mirrors'),
    maxBundleBytes: options.maxBundleBytes ?? MAX_BUNDLE_BYTES,
    log: client.log,
    baseEnv: env,
    sensitiveValues,
  };

  return {
    client,
    deps,
    async pushBranch(input, ctx = {}) {
      return pushBranch(pushDeps, { ...input, signal: input.signal ?? ctx.signal });
    },
    async syncMainline(input, ctx = {}) {
      return syncMainline(pushDeps, { ...input, signal: input.signal ?? ctx.signal });
    },
    async fetchMainline(input, ctx = {}) {
      return fetchMainline(pushDeps, { ...input, signal: input.signal ?? ctx.signal });
    },
    async bundleCommits(input, ctx = {}) {
      return bundleCommits(pushDeps, { ...input, signal: input.signal ?? ctx.signal });
    },
    async writeSpecDoc(input, ctx = {}) {
      return writeSpecDoc(deps, { ...input, signal: input.signal ?? ctx.signal });
    },
    async readSpecDoc(input, ctx = {}) {
      return readSpecDoc(deps, { ...input, signal: input.signal ?? ctx.signal });
    },
    async readRepoFile(input, ctx = {}) {
      return readRepoFile(deps, { ...input, signal: input.signal ?? ctx.signal });
    },
    async readIssuePlan(input, ctx = {}) {
      return readIssuePlan(client, { ...input, signal: input.signal ?? ctx.signal });
    },
    async readOpenMilestones(input) {
      return readOpenMilestones(client, input);
    },
    async readIssueState(input) {
      const issue = await readIssue(deps, input.repo, input.issueNumber, input.signal);
      if (issue.pull_request !== undefined && issue.pull_request !== null) {
        throw new GitHubError(
          'NOT_AN_ISSUE',
          `${repoSlug(input.repo)} #${input.issueNumber} 是 PR，不是 issue`,
        );
      }
      return {
        state: issue.state,
        stateReason: issue.state === 'open' ? null : (issue.state_reason ?? null),
      };
    },
    openPr: (input, ctx) => openPr(deps, input, ctx),
    waitCi: (input, ctx) => waitCi(deps, input, ctx),
    mergePr: (input, ctx) => mergePr(deps, input, ctx),
    updateIssueProgress: (input, ctx) => updateIssueProgress(deps, input, ctx),
    closeIssue: (input, ctx) => closeIssue(deps, input, ctx),
    openIssue: (input, ctx) => openIssue(deps, input, ctx),
    commentIssue: (input, ctx) => commentIssue(deps, input, ctx),
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
