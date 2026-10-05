// 装配：一个对象给引擎用（活动的真实现）、给后端用（事件之后的处理）、给定时任务用（对账补漏）。
// 生产：createGitHub({ ledger: pgLedger(db), locker: pgLocker(db) })（这两个在 @fleet-dao/store）——凭据从 /etc/fleet-dao/github 读（环境变量可改），
// 推送用的裸仓放在 FLEET_GITHUB_STATE_DIR（默认 /var/lib/fleet-dao/github）下。

import { join } from 'node:path';
import { errMessage } from '@fleet-dao/shared/util';
import { z } from 'zod';
import {
  type BundleCommitsInput,
  type BundleCommitsResult,
  bundleCommits,
  type FetchBranchInput,
  type FetchBranchResult,
  type FetchMainlineInput,
  type FetchMainlineResult,
  fetchBranchHead,
  fetchMainline,
} from './bundle.ts';
import { type ClaimsGitHub, createClaimsGitHub } from './claims.ts';
import { GitHubClient, type Logger, type RepoRef, repoSlug, type Sleep, unexpected } from './client.ts';
import { type CommitAncestryInput, commitContains } from './commit-relation.ts';
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
  addIssueLabel,
  type GroomFacts,
  type GroomLabelEvent,
  readGroomFacts,
  readIssueLabelEvents,
  setIssueMilestone,
} from './groom.ts';
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
  type PrFile,
  pullFiles,
  type WaitCiInput,
  waitCi,
} from './pulls.ts';
import { MAX_BUNDLE_BYTES, type PushBranchInput, type PushBranchResult, pushBranch } from './push.ts';
import {
  auditMergedPrs,
  createReconciler,
  type MergedPrAuditReport,
  type Reconciler,
  type ReconcilerOptions,
} from './reconcile.ts';
import { RepoFactsCache } from './repos.ts';
import { type SyncMainlineInput, type SyncMainlineResult, syncMainline } from './sync.ts';
import { requiredPermissions } from './token-scopes.ts';

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
  /** 卫生检查管的是哪个仓，默认 fleet-dao 自己（见 hygiene-scope.ts）；测试夹具的仓不是它时指过去。 */
  hygieneRepo?: RepoRef;
}

/**
 * 各身份要有的权限（自检用，引擎每小时对账跑一次、缺了报提醒、健康页 github_app 跟着红）。「干活的」只推分支、开 PR；
 * 「引擎」合并、改 issue、续互动限制、读 CI，还要在 PR 头上贴「认领对得上」（#299，commit status 要 statuses:write）。
 * 由 token-scopes.ts 里各用途要的权限取并集算出：令牌实际请求的永远不超过这张表，这张表里的每一项也都有用途在用。
 */
export const REQUIRED_PERMISSIONS: Record<AppRole, Record<string, 'read' | 'write'>> = {
  agent: requiredPermissions('agent'),
  engine: requiredPermissions('engine'),
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
  /** 抓一个分支此刻在远端的头（不认镜像里旧引用还在不在，重新问一次）：推被拒时认领远端新头用。 */
  fetchBranchHead(input: FetchBranchInput, ctx?: ActivityContext): Promise<FetchBranchResult>;
  openPr(input: OpenPrInput, ctx?: ActivityContext): Promise<OpenPrResult>;
  waitCi(input: WaitCiInput, ctx?: ActivityContext): Promise<CiWaitResult>;
  /** PR 改到的文件（翻完页、带 patch）：先审后合按路径判要不要等第二意见用它，判法和合并闸同一份（#253）。 */
  pullFiles(input: { repo: RepoRef; prNumber: number; signal?: AbortSignal }): Promise<PrFile[]>;
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
   * head 是不是一个不少地包含 base（GitHub compare）：流程配置对账判「读到的新字段是不是还没发布的引擎版本才认得」用它
   * （jobs/flow-config.ts）。比较不出关系（多半是不同的仓）回 null，不当成「不含」。GitHub 接口出错照样抛。
   */
  commitContains(input: CommitAncestryInput, ctx?: ActivityContext): Promise<boolean | null>;
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
  /**
   * 一张单的标题、正文（原样，带引擎写的进度段）、开没开着（「引擎」机器人现读）：拼动手的交代用。是 PR 抛 NOT_AN_ISSUE，
   * 读不到、认不出抛错；正文是空的回空串（空正文是单子的事实，由交代那一侧报「没有可做的需求」）。
   */
  readIssue(input: {
    repo: RepoRef;
    issueNumber: number;
    signal?: AbortSignal | undefined;
  }): Promise<{ number: number; title: string; body: string; state: 'open' | 'closed' }>;
  /** 会话提交用的身份（「干活的」机器人）：引擎建工作树时写进 user.name / user.email。 */
  commitIdentity(repo: RepoRef): Promise<BotIdentity>;
  /** 引擎的通用 GitHub 读写口（「引擎」机器人）：现读 PR、读贴提交状态、撤自动合并、关 PR、在 PR 上留言（名字沿用 #348 的「claims」）。 */
  claims: ClaimsGitHub;
  /** 两个机器人在这些仓上的权限够不够。读不到算没查成（ok=false、why 写原因），不算「没有差异」。 */
  selfCheck(repos: RepoRef[]): Promise<SelfCheckItem[]>;
  /**
   * 单子进门自动打标挂版本（#448，「引擎」机器人现读）：开着的单（标题、正文、作者、标签、里程碑、创建/更新时刻）
   * 加全部里程碑（含关了的，判版本交接用）。读不到、认不出、翻不完抛错，不拿「一张都没有」顶。
   */
  readGroomFacts(input: { repo: RepoRef; signal?: AbortSignal | undefined }): Promise<GroomFacts>;
  /** 一张单标签加/摘的时间线（#448）：判「类别标签是不是被人摘过」「过时是什么时候贴上的」。读不到、翻不完抛错。 */
  readIssueLabelEvents(input: {
    repo: RepoRef;
    issueNumber: number;
    signal?: AbortSignal | undefined;
  }): Promise<GroomLabelEvent[]>;
  /** 给一张单加一个标签（#448，幂等）：返回加完之后单上的全部标签。 */
  addIssueLabel(
    input: { repo: RepoRef; issueNumber: number; label: string },
    ctx?: ActivityContext,
  ): Promise<string[]>;
  /** 给一张单挂里程碑（#448）：返回挂完之后的里程碑。 */
  setIssueMilestone(
    input: { repo: RepoRef; issueNumber: number; milestone: number },
    ctx?: ActivityContext,
  ): Promise<{ number: number; title: string } | null>;
  eventSink(waker: WorkflowWaker): EventSink;
  reconciler(options: ReconcilerOptions): Reconciler;
  /**
   * 一段时间里合了的 PR：镜像没记成已合并的补上；我们两个机器人开的，还要是「引擎」合的、账上有合并记录。
   * 不用接活那道门。每小时对账调它（按 findings 的 kind 分，不认 problems 里的字）。
   */
  auditMergedPrs(repoFullName: string, since: Date): Promise<MergedPrAuditReport>;
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
    ...(options.hygieneRepo ? { hygieneRepo: options.hygieneRepo } : {}),
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
    ...(options.hygieneRepo ? { hygieneRepo: options.hygieneRepo } : {}),
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
    async fetchBranchHead(input, ctx = {}) {
      return fetchBranchHead(pushDeps, { ...input, signal: input.signal ?? ctx.signal });
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
    async commitContains(input, ctx = {}) {
      return commitContains(deps, { ...input, signal: input.signal ?? ctx.signal });
    },
    async readIssuePlan(input, ctx = {}) {
      return readIssuePlan(client, { ...input, signal: input.signal ?? ctx.signal });
    },
    async readOpenMilestones(input) {
      return readOpenMilestones(client, input);
    },
    readGroomFacts: (input) => readGroomFacts(deps, input),
    readIssueLabelEvents: (input) => readIssueLabelEvents(deps, input),
    async addIssueLabel(input, ctx = {}) {
      return addIssueLabel(deps, input, ctx);
    },
    async setIssueMilestone(input, ctx = {}) {
      return setIssueMilestone(deps, input, ctx);
    },
    async readIssue(input) {
      const issue = await readIssue(deps, input.repo, input.issueNumber, input.signal);
      if (issue.pull_request !== undefined && issue.pull_request !== null) {
        throw new GitHubError(
          'NOT_AN_ISSUE',
          `${repoSlug(input.repo)} #${input.issueNumber} 是 PR，不是 issue`,
        );
      }
      return { number: issue.number, title: issue.title, body: issue.body ?? '', state: issue.state };
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
    pullFiles: (input) => pullFiles(deps, input.repo, input.prNumber, input.signal),
    mergePr: (input, ctx) => mergePr(deps, input, ctx),
    updateIssueProgress: (input, ctx) => updateIssueProgress(deps, input, ctx),
    closeIssue: (input, ctx) => closeIssue(deps, input, ctx),
    openIssue: (input, ctx) => openIssue(deps, input, ctx),
    commentIssue: (input, ctx) => commentIssue(deps, input, ctx),
    renewInteractionLimit: (input, ctx) => renewInteractionLimit(deps, input, ctx),
    commitIdentity: (repo) => deps.bots.identity('agent', repo),
    claims: createClaimsGitHub(deps),
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
              why: `${ROLE_NAMES[role]}没查成：${errMessage(err)}`,
            });
          }
        }
      }
      return out;
    },
    eventSink: (waker) => createEventSink(deps, waker),
    reconciler: (reconcilerOptions) => createReconciler(deps, reconcilerOptions),
    auditMergedPrs: (repoFullName, since) => auditMergedPrs(deps, repoFullName, since),
  };
}
