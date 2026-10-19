// 引擎的通用 GitHub 读写口（都用「引擎」机器人）：现读 PR、列开着的 PR、读头上某个 context 最新的一条提交
// 状态、贴提交状态（读得到 statuses 写权限才贴）、撤自动合并、关 PR、在 PR 上留言。
// 挂自动合并（hourly-reconcile）、读 PR 和贴 cold-verify（task-activities、task-verify）都走它。
// 对外的 `gh.claims`、ClaimsGitHub、createClaimsGitHub 是 #348「认领对得上」留下的老名字（认领账 #556 整个删了），
// 引擎那边一起改名之前先留着。
// 改这里之前必须知道：合并闸只认「引擎」机器人贴的那条（@fleet-dao/conventions 的 ENGINE_BOT_LOGIN），所以贴一律用引擎的身份；
// 没有 statuses 写权限、GitHub 没回权限表，都明确报错，不当成贴上了。
import { z } from 'zod';
import { enc, type RepoRef, repoSlug, unexpected } from './client.ts';
import { botLogin } from './credentials.ts';
import type { ActivityContext, Deps } from './deps.ts';
import { recordEcho } from './echo.ts';
import { GitHubError, isGitHubError } from './errors.ts';
import { type CommentIssueResult, commentPull } from './issues.ts';
import { assertPublishable } from './publish-check.ts';
import { defaultCommitMessage, PullSchema } from './pulls.ts';
import {
  assertBodySize,
  hasCloseKeywords,
  neutralizeCloseKeywords,
  type PrBodyInput,
  renderPrBody,
} from './text.ts';

/** 引擎读 PR 要的样子。 */
export interface PullFacts {
  number: number;
  /** GraphQL 用的编号（撤自动合并）。 */
  nodeId: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  title: string;
  /** 没写正文是空串。 */
  body: string;
  headSha: string;
  headRef: string;
  /** 从 fork 来的（head 仓不是这个仓，或 head 仓被删了）。 */
  fromFork: boolean;
  author: { login: string; id: number; type: string } | null;
  /** 开着 GitHub 的自动合并。 */
  autoMerge: boolean;
  /**
   * GitHub 算的「这个 PR 能不能并进主线」：false = 不能（和主线冲突、或别的挡着）；null = GitHub 还没算完。
   * 等合并靠它认出冲突（#1838：以前看不出冲突，一直等在合并队列里）。
   */
  mergeable?: boolean | null;
  /** GitHub 的细分状态：'dirty' = 和主线冲突、'blocked' = 等必过检查、'behind' = 落后主线…… */
  mergeableState?: string;
}

/**
 * PR 上的一条正式评审（GET /pulls/{n}/reviews）。state 照 GitHub 原样：APPROVED、CHANGES_REQUESTED、COMMENTED、
 * DISMISSED（被撤了）、PENDING（还没交）。改过正文的评审编号不变、body 是改后的。commitId 是审的那个提交（头换了它不跟着换）。
 */
export interface PullReview {
  id: number;
  author: { login: string; id: number; type: string } | null;
  state: string;
  /** 没写是空串。 */
  body: string;
  commitId: string | null;
  submittedAt: string | null;
}

/** 已核归属的一条正式评审行内原文；未知/过时位置留 null，不冒充当前行号。 */
export interface PullReviewComment {
  id: number;
  reviewId: number;
  author: { login: string; id: number; type: string };
  body: string;
  path: string;
  pullRequestUrl: string;
  line: number | null;
  originalLine: number | null;
  side: 'LEFT' | 'RIGHT' | null;
  startLine: number | null;
  originalStartLine: number | null;
  startSide: 'LEFT' | 'RIGHT' | null;
  commitId: string;
  originalCommitId: string;
  updatedAt: string;
}

/** 某个 context 在一个提交上最新的一条提交状态。 */
export interface LatestStatus {
  state: 'success' | 'failure' | 'error' | 'pending';
  description: string;
  /** 是不是「引擎」机器人贴的。 */
  byEngine: boolean;
}

export interface CommitStatusInput {
  context: string;
  state: 'success' | 'failure' | 'error' | 'pending';
  /** GitHub 限 140 个字符：调用方先截好。 */
  description: string;
  targetUrl?: string | undefined;
}

export interface ClaimsGitHub {
  /** 「引擎」机器人在 GitHub 上的登录名（REST 写法）：合并闸只认它贴的状态。 */
  engineLogin(): string;
  /** 这个 GitHub 用户是不是「干活的」机器人（引擎的 PR 都是它开的）。 */
  isAgentBot(
    user: { login?: string | null; id?: number | null; type?: string | null } | null | undefined,
  ): boolean;
  readPull(repo: RepoRef, number: number, options?: { requireMergeState: true }): Promise<PullFacts>;
  /** 开着的 PR（翻完页；翻不完抛错，不当成就这几个）。 */
  openPulls(repo: RepoRef): Promise<PullFacts[]>;
  /** 这个 PR 上全部正式评审（翻完页，按 GitHub 给的先后）；翻不完、认不出都抛错，不当成没有评审。 */
  listReviews(repo: RepoRef, number: number): Promise<PullReview[]>;
  /** 只读指定正式评审的全部行内原文，核仓/PR/review 归属；未翻全或同编号冲突明确抛错。 */
  listReviewComments(repo: RepoRef, number: number, reviewId: number): Promise<PullReviewComment[]>;
  /**
   * 从 since 起更新过、而且合并了的 PR（按更新时间从新到旧，读到更早的就停）。
   * 停点是 updated 早于 since，不是固定页数。安全网触顶还没走出窗口、认不出，都抛错：
   * 调用方不能把抛错当成「一个都没有」，也不能把没翻完的半截名单当成读全了。
   */
  listMergedPulls(repo: RepoRef, since: Date): Promise<PullFacts[]>;
  /** 这个提交上这个 context 最新的一条（没有是 null）。 */
  latestStatus(repo: RepoRef, sha: string, context: string): Promise<LatestStatus | null>;
  /** 以「引擎」机器人贴一条提交状态：安装令牌里没有 statuses 写权限（或读不到权限表）就抛错，不贴。 */
  setStatus(repo: RepoRef, sha: string, status: CommitStatusInput): Promise<void>;
  /** 撤掉这个 PR 的自动合并（GraphQL disablePullRequestAutoMerge）。 */
  disableAutoMerge(repo: RepoRef, pull: Pick<PullFacts, 'number' | 'nodeId'>): Promise<void>;
  /**
   * 给这个 PR 挂上自动合并（GraphQL enablePullRequestAutoMerge，squash）：用机器人（GitHub App）的身份挂，
   * 不用 Actions 自带的 GITHUB_TOKEN——它挂的自动合并合进主线后，不会触发主线上后面的工作流（#242）。
   * 有调用者预期头时先核对、再绑定现读头；显式写入非空安全 squash 消息并核回执；读不到、挂不上或消息未采用照抛，不当成已经安全挂上。
   */
  enableAutoMerge(
    repo: RepoRef,
    pull: Pick<PullFacts, 'number' | 'nodeId'> & { headSha?: string | undefined },
    ctx?: ActivityContext & { attempt?: number | undefined },
  ): Promise<void>;
  /** 关掉 PR（分支不动）。已经关了的不报错。 */
  closePull(repo: RepoRef, number: number): Promise<void>;
  /**
   * 换掉 PR 的正文（#2723：第 2 轮起「做了什么」换成这一轮会话的回复）。给结构就按 PR 模板渲染（renderPrBody），
   * 关单词中和成「关联」、超长和发布前检查照开 PR 那一套。标题、分支、状态都不动。
   */
  updatePullBody(repo: RepoRef, number: number, body: string | PrBodyInput): Promise<void>;
  /** 在 PR 上留一条评论（幂等，同一个 key 只发一次）。 */
  commentPull(repo: RepoRef, number: number, key: string, body: string): Promise<CommentIssueResult>;
}

const ClaimPullSchema = PullSchema.extend({ auto_merge: z.unknown().optional() });

const ReviewSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string(), id: z.number(), type: z.string() }).nullable().optional(),
  state: z.string(),
  body: z.string().nullable().optional(),
  commit_id: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
});

/** 一个 PR 的评审最多翻几页（每页 100）：评审过千条的 PR 不正常，翻不完照抛「没查全」。 */
const REVIEW_MAX_PAGES = 10;

const ReviewCommentSchema = z.object({
  id: z.number().int().positive().safe(),
  pull_request_review_id: z.number().int().positive().safe(),
  user: z.object({
    login: z.string().min(1),
    id: z.number().int().positive().safe(),
    type: z.string().min(1),
  }),
  body: z.string(),
  path: z.string().min(1),
  pull_request_url: z.string().url(),
  line: z.number().int().positive().nullable().optional(),
  original_line: z.number().int().positive().nullable().optional(),
  side: z.enum(['LEFT', 'RIGHT']).nullable().optional(),
  start_line: z.number().int().positive().nullable().optional(),
  original_start_line: z.number().int().positive().nullable().optional(),
  start_side: z.enum(['LEFT', 'RIGHT']).nullable().optional(),
  commit_id: z.string().min(1),
  original_commit_id: z.string().min(1),
  updated_at: z.string().datetime({ offset: true }),
});

/**
 * 列窗口里合并 PR 的翻页安全网（每页 100）。
 * 10 页盖不住 30 天窗口：本仓 closed PR 超过 1000，第 10 页末条仍在窗口内，
 * pages() 会整次抛「没翻完」，整理待办就读不到分片关系（法国）。
 * 100 页 = 一万条。真超过仍抛「没查全」，调用方按没读到处理。
 */
const MERGED_PULL_MAX_PAGES = 100;

const StatusSchema = z.object({
  context: z.string(),
  state: z.enum(['success', 'failure', 'error', 'pending']),
  description: z.string().nullable().optional(),
  creator: z.object({ login: z.string(), id: z.number(), type: z.string() }).nullable().optional(),
});

/** enablePullRequestAutoMerge 的 UNPROCESSABLE「is in unstable status」：回包里只有这一条，path 恰好是这个 mutation。 */
function isUnstableRefusal(details: unknown): boolean {
  const errors = (details as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length !== 1) return false;
  const e = errors[0] as { type?: unknown; message?: unknown; path?: unknown } | null;
  return (
    e?.type === 'UNPROCESSABLE' &&
    Array.isArray(e.path) &&
    e.path.length === 1 &&
    e.path[0] === 'enablePullRequestAutoMerge' &&
    e.message === 'Pull request Pull request is in unstable status'
  );
}

function factsOf(repo: RepoRef, p: z.infer<typeof ClaimPullSchema>): PullFacts {
  const merged = p.merged ?? (p.merged_at !== null && p.merged_at !== undefined);
  return {
    number: p.number,
    nodeId: p.node_id,
    state: p.state,
    merged,
    draft: p.draft ?? false,
    title: p.title,
    body: p.body ?? '',
    headSha: p.head.sha,
    headRef: p.head.ref,
    fromFork: p.head.repo === null || p.head.repo.full_name.toLowerCase() !== repoSlug(repo).toLowerCase(),
    author: p.user,
    autoMerge: p.auto_merge !== null && p.auto_merge !== undefined,
    ...(p.mergeable === undefined ? {} : { mergeable: p.mergeable }),
    ...(p.mergeable_state === undefined ? {} : { mergeableState: p.mergeable_state }),
  };
}

export function createClaimsGitHub(deps: Deps): ClaimsGitHub {
  const { client } = deps;
  const base = (repo: RepoRef) => `/repos/${enc(repo.owner)}/${enc(repo.name)}`;
  const auth = (repo: RepoRef) => ({ as: 'engine' as const, repo });

  return {
    engineLogin: () => botLogin(client.apps.engine),
    isAgentBot: (user) => deps.bots.is('agent', user),

    async readPull(repo, number, options) {
      const res = await client.request({
        method: 'GET',
        path: `${base(repo)}/pulls/${number}`,
        auth: auth(repo),
      });
      const parsed = ClaimPullSchema.safeParse(res.data);
      if (!parsed.success) throw unexpected(`读 PR #${number}`, res.data);
      if (parsed.data.number !== number) throw unexpected(`读 PR #${number}（回的号对不上）`, res.data);
      if (
        options?.requireMergeState &&
        parsed.data.merged === undefined &&
        parsed.data.merged_at === undefined
      )
        throw unexpected(`读 PR #${number}（合并状态未知）`, res.data);
      if (
        options?.requireMergeState &&
        ((parsed.data.merged === false && parsed.data.merged_at != null) ||
          (parsed.data.merged === true && parsed.data.merged_at === null))
      )
        throw unexpected(`读 PR #${number}（合并状态矛盾）`, res.data);
      return factsOf(repo, parsed.data);
    },

    async openPulls(repo) {
      const items = await client.all(
        {
          method: 'GET',
          path: `${base(repo)}/pulls`,
          auth: auth(repo),
          query: { state: 'open', per_page: 100 },
        },
        (d) => d,
        20,
      );
      return items.map((item) => {
        const parsed = ClaimPullSchema.safeParse(item);
        if (!parsed.success) throw unexpected(`列 ${repoSlug(repo)} 开着的 PR`, item);
        return factsOf(repo, parsed.data);
      });
    },

    async listReviews(repo, number) {
      const items = await client.all(
        {
          method: 'GET',
          path: `${base(repo)}/pulls/${number}/reviews`,
          auth: auth(repo),
          query: { per_page: 100 },
        },
        (d) => d,
        REVIEW_MAX_PAGES,
      );
      return items.map((item) => {
        const parsed = ReviewSchema.safeParse(item);
        if (!parsed.success) throw unexpected(`读 PR #${number} 的评审`, item);
        const r = parsed.data;
        return {
          id: r.id,
          author: r.user ?? null,
          state: r.state,
          body: r.body ?? '',
          commitId: r.commit_id ?? null,
          submittedAt: r.submitted_at ?? null,
        };
      });
    },

    async listReviewComments(repo, number, reviewId) {
      const items = await client.all(
        {
          method: 'GET',
          path: `${base(repo)}/pulls/${number}/reviews/${reviewId}/comments`,
          auth: auth(repo),
          query: { per_page: 100 },
        },
        (d) => d,
        REVIEW_MAX_PAGES,
      );
      const expected = new URL(`${client.apiUrl}${base(repo)}/pulls/${number}`);
      const comments = new Map<number, PullReviewComment>();
      for (const item of items) {
        const parsed = ReviewCommentSchema.safeParse(item);
        if (!parsed.success) throw unexpected(`读 PR #${number} review ${reviewId} 的行内原文`, item);
        const c = parsed.data;
        const url = new URL(c.pull_request_url);
        if (
          c.pull_request_review_id !== reviewId ||
          url.origin !== expected.origin ||
          url.pathname.toLowerCase() !== expected.pathname.toLowerCase() ||
          url.search ||
          url.hash ||
          url.username ||
          url.password
        )
          throw unexpected(`行内意见不属于 ${repoSlug(repo)} PR #${number} review ${reviewId}`, item);
        const comment: PullReviewComment = {
          id: c.id,
          reviewId: c.pull_request_review_id,
          author: c.user,
          body: c.body,
          path: c.path,
          pullRequestUrl: c.pull_request_url,
          line: c.line ?? null,
          originalLine: c.original_line ?? null,
          side: c.side ?? null,
          startLine: c.start_line ?? null,
          originalStartLine: c.original_start_line ?? null,
          startSide: c.start_side ?? null,
          commitId: c.commit_id,
          originalCommitId: c.original_commit_id,
          updatedAt: c.updated_at,
        };
        const prior = comments.get(comment.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(comment))
          throw unexpected(`review ${reviewId} 的行内 comment ${comment.id} 同编号内容冲突，未读全`, item);
        comments.set(comment.id, comment);
      }
      return [...comments.values()].sort((a, b) => a.id - b.id);
    },

    async listMergedPulls(repo, since) {
      // 读到比 since 更早就 return，pages() 正常收尾。页数上限只是安全网，不是「只看 10 页」。
      const out: PullFacts[] = [];
      for await (const page of client.pages(
        {
          method: 'GET',
          path: `${base(repo)}/pulls`,
          auth: auth(repo),
          query: { state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 },
        },
        MERGED_PULL_MAX_PAGES,
      )) {
        if (!Array.isArray(page.data)) throw unexpected(`列 ${repoSlug(repo)} 合并了的 PR`, page.data);
        let older = false;
        for (const item of page.data) {
          const parsed = ClaimPullSchema.safeParse(item);
          if (!parsed.success) throw unexpected(`列 ${repoSlug(repo)} 合并了的 PR`, item);
          const updated = Date.parse(parsed.data.updated_at);
          if (Number.isNaN(updated)) {
            throw unexpected(`列 ${repoSlug(repo)} 合并了的 PR（updated_at 认不出）`, item);
          }
          if (updated < since.getTime()) {
            older = true;
            break;
          }
          const facts = factsOf(repo, parsed.data);
          if (facts.merged) out.push(facts);
        }
        if (older || page.data.length < 100) return out;
      }
      return out;
    },

    async latestStatus(repo, sha, context) {
      // 逐条的列表新到旧、带 creator（合并状态接口 /status 不带是谁贴的）；找到第一条就停
      for await (const page of client.pages(
        {
          method: 'GET',
          path: `${base(repo)}/commits/${enc(sha)}/statuses`,
          auth: auth(repo),
          query: { per_page: 100 },
        },
        30,
      )) {
        if (!Array.isArray(page.data)) throw unexpected(`读 ${sha.slice(0, 7)} 的提交状态`, page.data);
        for (const item of page.data) {
          if (!item || typeof item !== 'object' || (item as { context?: unknown }).context !== context)
            continue;
          const parsed = StatusSchema.safeParse(item);
          if (!parsed.success) throw unexpected(`读 ${sha.slice(0, 7)} 上的「${context}」`, item);
          const s = parsed.data;
          return {
            state: s.state,
            description: (s.description ?? '').trim(),
            byEngine: deps.bots.is('engine', s.creator ?? null),
          };
        }
        if (page.data.length < 100) return null;
      }
      return null;
    },

    async setStatus(repo, sha, status) {
      const slug = repoSlug(repo);
      const token = await client.installationToken('engine', repo);
      const have = token.permissions?.statuses;
      if (token.permissions === undefined) {
        throw new GitHubError(
          'PERMISSIONS_UNKNOWN',
          `换「引擎」机器人在 ${slug} 上的令牌时 GitHub 没回权限表：读不到有没有 statuses 写权限，「${status.context}」没贴`,
        );
      }
      if (have !== 'write') {
        throw new GitHubError(
          'FORBIDDEN',
          `「引擎」机器人在 ${slug} 上没有 statuses 写权限（现在是 ${have ?? '没有'}），「${status.context}」贴不了：到 App 设置里把 Commit statuses 改成 Read and write，再到装它的地方点接受`,
          { details: { repo: slug, statuses: have ?? null } },
        );
      }
      const res = await client.request({
        method: 'POST',
        path: `${base(repo)}/statuses/${enc(sha)}`,
        auth: auth(repo),
        body: {
          state: status.state,
          context: status.context,
          description: status.description,
          ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
        },
      });
      const parsed = StatusSchema.safeParse(res.data);
      if (!parsed.success || parsed.data.context !== status.context || parsed.data.state !== status.state) {
        throw unexpected(`贴 ${sha.slice(0, 7)} 上的「${status.context}」的回执`, res.data);
      }
    },

    async disableAutoMerge(repo, pull) {
      await client.graphql(
        auth(repo),
        'mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { number } } }',
        { id: pull.nodeId },
        { mutation: true },
      );
    },

    async enableAutoMerge(repo, pull, ctx) {
      const options = {
        signal: ctx?.signal,
        ...(ctx?.attemptDeadlineMs === undefined ? {} : { attemptDeadlineMs: ctx.attemptDeadlineMs }),
        ...(ctx?.scheduleDeadlineMs === undefined ? {} : { scheduleDeadlineMs: ctx.scheduleDeadlineMs }),
      };
      const current = await client.request({
        method: 'GET',
        path: `${base(repo)}/pulls/${pull.number}`,
        auth: auth(repo),
        ...options,
      });
      const parsed = ClaimPullSchema.safeParse(current.data);
      if (!parsed.success || parsed.data.number !== pull.number || parsed.data.node_id !== pull.nodeId)
        throw unexpected(`挂 PR #${pull.number} 自动合并前核身份`, current.data);
      if (pull.headSha !== undefined && parsed.data.head.sha !== pull.headSha)
        throw unexpected(`挂 PR #${pull.number} 自动合并前核预期头`, {
          expected: pull.headSha,
          actual: parsed.data.head.sha,
        });
      const title = neutralizeCloseKeywords(parsed.data.title);
      const body = neutralizeCloseKeywords(parsed.data.body ?? '');
      if (hasCloseKeywords(parsed.data.title) || hasCloseKeywords(parsed.data.body ?? '')) {
        const changed = await client.request({
          method: 'PATCH',
          path: `${base(repo)}/pulls/${pull.number}`,
          auth: auth(repo),
          body: { title, body },
          ...options,
        });
        const updated = ClaimPullSchema.safeParse(changed.data);
        if (
          !updated.success ||
          updated.data.number !== pull.number ||
          updated.data.node_id !== pull.nodeId ||
          updated.data.title !== title ||
          updated.data.body !== body
        )
          throw unexpected(`挂 PR #${pull.number} 自动合并前去关单词的回执`, changed.data);
      }
      const headline = `${title.trim() || `PR #${pull.number}`} (#${pull.number})`;
      const commitBody = defaultCommitMessage(pull.number);
      const revokeUnverified = async (original: GitHubError): Promise<never> => {
        try {
          const disabled = await client.graphql(
            auth(repo),
            'mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { id number autoMergeRequest { commitHeadline } } } }',
            { id: pull.nodeId },
            { mutation: true, ...options },
          );
          const stopped = z
            .object({
              disablePullRequestAutoMerge: z.object({
                pullRequest: z.object({
                  id: z.literal(pull.nodeId),
                  number: z.literal(pull.number),
                  autoMergeRequest: z.null(),
                }),
              }),
            })
            .safeParse(disabled);
          if (!stopped.success) throw unexpected('撤掉未核实自动合并的回执', disabled);
        } catch (error) {
          throw new GitHubError(original.code, `${original.message}；撤挂也未核实`, {
            maybeLanded: true,
            details: {
              original: original.details,
              cleanup: error instanceof Error ? error.message : String(error),
            },
          });
        }
        throw original;
      };
      let result: unknown;
      try {
        result = await client.graphql(
          auth(repo),
          'mutation($id: ID!, $head: GitObjectID!, $headline: String!, $body: String!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, expectedHeadOid: $head, mergeMethod: SQUASH, commitHeadline: $headline, commitBody: $body }) { pullRequest { id number autoMergeRequest { commitHeadline commitBody mergeMethod } } } }',
          { id: pull.nodeId, head: parsed.data.head.sha, headline, body: commitBody },
          { mutation: true, ...options },
        );
      } catch (error) {
        if (error instanceof GitHubError) {
          // 非空子字段报错可把整份 payload 向上置 null；只认本次 mutation 的精确子字段路径。
          const details = error.details;
          const nestedAutoMergeError =
            typeof details === 'object' &&
            details !== null &&
            'errors' in details &&
            Array.isArray(details.errors) &&
            details.errors.some((entry: unknown) => {
              if (typeof entry !== 'object' || entry === null || !('path' in entry)) return false;
              const path = entry.path;
              return (
                Array.isArray(path) &&
                path.length > 1 &&
                path[0] === 'enablePullRequestAutoMerge' &&
                path
                  .slice(1)
                  .every(
                    (part: unknown) =>
                      typeof part === 'string' ||
                      (typeof part === 'number' && Number.isInteger(part) && part >= 0),
                  )
              );
            });
          if (error.maybeLanded || error.code === 'UNEXPECTED_RESPONSE' || nestedAutoMergeError)
            await revokeUnverified(error);
        }
        // 只认这个 mutation 自己回的那一条 UNPROCESSABLE unstable 临时拒绝：标成可重试，交活动既有的有界重试。
        // （git 档 3 次、退避），每次重入 armAutoMerge 从头现读 PR、评审、检查。码和原消息不变，原始 errors 原样留在
        // details 里，消息后面补上 type/path、PR、头、第几次尝试，重试用尽停下时一眼看得出。别的一律原样抛。
        if (isGitHubError(error, 'GRAPHQL_ERROR') && isUnstableRefusal(error.details)) {
          const attempt = typeof ctx?.attempt === 'number' ? ctx.attempt : null;
          const head = typeof pull.headSha === 'string' ? pull.headSha : null;
          const rawErrors = (error.details as { errors: unknown[] }).errors;
          throw new GitHubError(
            error.code,
            `${error.message}（UNPROCESSABLE enablePullRequestAutoMerge；原始 errors：${JSON.stringify(rawErrors)}；PR #${pull.number}${head ? ` 头 ${head}` : ''}${attempt === null ? '' : `，第 ${attempt} 次尝试`}；临时拒绝，交活动有界重试）`,
            {
              retryable: true,
              details: { ...(error.details as object), pull: pull.number, head, attempt },
              ...(error.status === undefined ? {} : { status: error.status }),
            },
          );
        }
        throw error;
      }
      // 核已挂请求的消息；这不证明 merge queue 最终会沿用它（GitHub 明确会忽略自定义消息）。
      const receipt = z
        .object({
          enablePullRequestAutoMerge: z.object({
            pullRequest: z.object({
              id: z.literal(pull.nodeId),
              number: z.literal(pull.number),
              autoMergeRequest: z.object({
                commitHeadline: z.literal(headline),
                commitBody: z.literal(commitBody),
                mergeMethod: z.literal('SQUASH'),
              }),
            }),
          }),
        })
        .safeParse(result);
      if (!receipt.success)
        await revokeUnverified(unexpected(`挂 PR #${pull.number} 自动合并的安全消息回执`, result));
    },

    async closePull(repo, number) {
      const res = await client.request({
        method: 'PATCH',
        path: `${base(repo)}/pulls/${number}`,
        auth: auth(repo),
        body: { state: 'closed' },
      });
      const parsed = PullSchema.safeParse(res.data);
      if (!parsed.success || parsed.data.state !== 'closed')
        throw unexpected(`关 PR #${number} 的回执`, res.data);
      // 自家关的：补收时认得出是回声，不当成外面关的
      await recordEcho(
        deps.ledger.idempotency,
        { repo, kind: 'pull', number, updatedAt: parsed.data.updated_at, role: 'engine' },
        client.now(),
      );
    },

    async updatePullBody(repo, number, input) {
      const body = neutralizeCloseKeywords(typeof input === 'string' ? input : renderPrBody(input));
      assertBodySize('PR 正文', body);
      assertPublishable(
        repo,
        `改 ${repoSlug(repo)} 上 PR #${number} 的正文`,
        [{ path: 'PR 正文', text: body }],
        deps.hygieneRepo,
      );
      const res = await client.request({
        method: 'PATCH',
        path: `${base(repo)}/pulls/${number}`,
        auth: auth(repo),
        body: { body },
      });
      const parsed = PullSchema.safeParse(res.data);
      if (!parsed.success || parsed.data.number !== number)
        throw unexpected(`改 PR #${number} 正文的回执`, res.data);
      // 自家改的：补收时认得出是回声
      await recordEcho(
        deps.ledger.idempotency,
        { repo, kind: 'pull', number, updatedAt: parsed.data.updated_at, role: 'engine' },
        client.now(),
      );
    },

    commentPull: (repo, number, key, body) => commentPull(deps, { repo, issueNumber: number, key, body }),
  };
}
