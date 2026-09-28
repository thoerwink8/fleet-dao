// 贴提交状态、读 PR、撤自动合并、留言这一侧要的 GitHub 读写（都用「引擎」机器人）：现读 PR、列开着的 PR、读头上某个
// context 最新的一条提交状态、贴提交状态（读得到 statuses 写权限才贴）、撤自动合并、关 PR、在 PR 上留言。原是给「认领
// 对得上」（#348）用的，那套 #446 起删了；second-opinion（@fleet-dao/engine 的 github-ports.ts）接着用它贴状态、读状态、
// 留言，接口不用改。
// 改这里之前必须知道：贴状态一律用引擎的身份；没有 statuses 写权限、GitHub 没回权限表，都明确报错，不当成贴上了。
import { z } from 'zod';
import { enc, type RepoRef, repoSlug, unexpected } from './client.ts';
import { botLogin } from './credentials.ts';
import type { Deps } from './deps.ts';
import { recordEcho } from './echo.ts';
import { GitHubError } from './errors.ts';
import { type CommentIssueResult, commentPull } from './issues.ts';
import { PullSchema } from './pulls.ts';

/** 认领这一侧要的 PR 的样子。 */
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
  readPull(repo: RepoRef, number: number): Promise<PullFacts>;
  /** 开着的 PR（翻完页；翻不完抛错，不当成就这几个）。 */
  openPulls(repo: RepoRef): Promise<PullFacts[]>;
  /** 这个提交上这个 context 最新的一条（没有是 null）。 */
  latestStatus(repo: RepoRef, sha: string, context: string): Promise<LatestStatus | null>;
  /** 以「引擎」机器人贴一条提交状态：安装令牌里没有 statuses 写权限（或读不到权限表）就抛错，不贴。 */
  setStatus(repo: RepoRef, sha: string, status: CommitStatusInput): Promise<void>;
  /** 撤掉这个 PR 的自动合并（GraphQL disablePullRequestAutoMerge）。 */
  disableAutoMerge(repo: RepoRef, pull: Pick<PullFacts, 'number' | 'nodeId'>): Promise<void>;
  /** 关掉 PR（分支不动）。已经关了的不报错。 */
  closePull(repo: RepoRef, number: number): Promise<void>;
  /** 在 PR 上留一条评论（幂等，同一个 key 只发一次）。 */
  commentPull(repo: RepoRef, number: number, key: string, body: string): Promise<CommentIssueResult>;
}

const ClaimPullSchema = PullSchema.extend({ auto_merge: z.unknown().optional() });

const StatusSchema = z.object({
  context: z.string(),
  state: z.enum(['success', 'failure', 'error', 'pending']),
  description: z.string().nullable().optional(),
  creator: z.object({ login: z.string(), id: z.number(), type: z.string() }).nullable().optional(),
});

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
  };
}

export function createClaimsGitHub(deps: Deps): ClaimsGitHub {
  const { client } = deps;
  const base = (repo: RepoRef) => `/repos/${enc(repo.owner)}/${enc(repo.name)}`;
  const auth = (repo: RepoRef) => ({ as: 'engine' as const, repo });

  return {
    engineLogin: () => botLogin(client.apps.engine),
    isAgentBot: (user) => deps.bots.is('agent', user),

    async readPull(repo, number) {
      const res = await client.request({
        method: 'GET',
        path: `${base(repo)}/pulls/${number}`,
        auth: auth(repo),
      });
      const parsed = ClaimPullSchema.safeParse(res.data);
      if (!parsed.success) throw unexpected(`读 PR #${number}`, res.data);
      if (parsed.data.number !== number) throw unexpected(`读 PR #${number}（回的号对不上）`, res.data);
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

    commentPull: (repo, number, key, body) => commentPull(deps, { repo, issueNumber: number, key, body }),
  };
}
