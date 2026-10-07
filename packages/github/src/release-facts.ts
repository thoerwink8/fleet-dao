// 驾驶舱「发版」卡（#1231）和「发布到法国」按钮（#1232）读的 GitHub 现状（都用「引擎」机器人，只读）：
// 主线头的提交、一个提交的标题和时间、主线头汇总检查（check）的结果、两个提交之间差几个、主线最近合并的一个 PR、一张单的标题。
// 读不到、认不出一律抛错（GitHubError），由调用方各行各自判「没查成」，不拿空、0、「已是最新」顶。
// 改这里之前必须知道：
// - 汇总检查只认 ci.yml 的 `check` 这一项（必过检查的汇总，同 release-train-lib.mjs 的 mainCi）：一条都没有算「还在跑」，不算绿。
// - compare 的提交列表是旧到新、最多 100 个一页；差得多时只读最后一页（最近的），差几个以 GitHub 回的 ahead_by 为准。
import { z } from 'zod';
import { type CheckRun, CheckRunSchema, evaluateChecks } from './checks.ts';
import { enc, type GitHubClient, type RepoRef, repoSlug, unexpected } from './client.ts';
import { GitHubError } from './errors.ts';

export const RELEASE_CHECK_NAME = 'check';
const COMPARE_PAGE = 100;
/** 最近合并的 PR 只翻这么多张（按更新时间新的在前）；翻完一张合并了的都没有算没查成。 */
const MERGED_PULL_WINDOW = 50;

export interface CommitFact {
  sha: string;
  /** 提交说明第一行。 */
  title: string;
  /** 提交时间（ISO）。 */
  committedAt: string;
}

export interface CiFact {
  state: 'green' | 'red' | 'pending';
  /** 一句话说明（红了是哪一项、还在跑是没出结果还是没跑完）。 */
  detail: string;
}

export interface CompareFact {
  /** identical = 同一个提交；ahead = head 比 base 新（base 是 head 的祖先）；behind / diverged = 不是这种关系。 */
  status: 'identical' | 'ahead' | 'behind' | 'diverged';
  /** head 比 base 多几个提交（GitHub 的 ahead_by）。 */
  aheadBy: number;
  /** head 一侧最近的提交（新到旧，最多一页）。 */
  recent: { sha: string; title: string }[];
}

export interface MergedPullFact {
  number: number;
  title: string;
  /** 正文原样，没写是空串。 */
  body: string;
  mergedAt: string;
}

export interface ReleaseFactsReader {
  /** 主线（main 分支）头的提交。 */
  mainlineHead(repo: RepoRef, signal?: AbortSignal): Promise<CommitFact>;
  commit(repo: RepoRef, sha: string, signal?: AbortSignal): Promise<CommitFact>;
  /** 这个提交上汇总检查（check）的结果。 */
  mainCi(repo: RepoRef, sha: string, signal?: AbortSignal): Promise<CiFact>;
  compare(repo: RepoRef, base: string, head: string, signal?: AbortSignal): Promise<CompareFact>;
  /** 主线最近合并的一个 PR；窗口里一个都没有抛错。 */
  lastMergedPull(repo: RepoRef, signal?: AbortSignal): Promise<MergedPullFact>;
  /** 一张单的标题；号其实是 PR 抛错。 */
  issueTitle(repo: RepoRef, number: number, signal?: AbortSignal): Promise<{ number: number; title: string }>;
}

const CommitSchema = z.object({
  sha: z.string(),
  commit: z.object({
    message: z.string(),
    committer: z.object({ date: z.string() }).nullable().optional(),
    author: z.object({ date: z.string() }).nullable().optional(),
  }),
});
const CompareSchema = z.object({
  status: z.enum(['identical', 'ahead', 'behind', 'diverged']),
  ahead_by: z.number().int().min(0),
  commits: z.array(CommitSchema),
});
const CheckRunsSchema = z.object({ check_runs: z.array(CheckRunSchema) });
const MergedPullListSchema = z.array(
  z.object({
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullable().optional(),
    merged_at: z.string().nullable().optional(),
  }),
);
const IssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  pull_request: z.unknown().optional(),
});

function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function commitFact(c: z.infer<typeof CommitSchema>, what: string): CommitFact {
  const at = c.commit.committer?.date ?? c.commit.author?.date;
  if (!at || Number.isNaN(Date.parse(at))) throw unexpected(`${what}（缺提交时间）`, c);
  return { sha: c.sha, title: firstLine(c.commit.message), committedAt: at };
}

export function createReleaseFacts(client: GitHubClient): ReleaseFactsReader {
  const base = (repo: RepoRef) => `/repos/${enc(repo.owner)}/${enc(repo.name)}`;
  const auth = (repo: RepoRef) => ({ as: 'engine' as const, repo });

  async function getCommit(repo: RepoRef, ref: string, signal?: AbortSignal): Promise<CommitFact> {
    const what = `读 ${repoSlug(repo)} 的提交 ${ref.slice(0, 12)}`;
    const res = await client.request({
      method: 'GET',
      path: `${base(repo)}/commits/${enc(ref)}`,
      auth: auth(repo),
      signal,
    });
    const parsed = CommitSchema.safeParse(res.data);
    if (!parsed.success) throw unexpected(what, res.data);
    return commitFact(parsed.data, what);
  }

  async function comparePage(repo: RepoRef, spec: string, page: number, signal?: AbortSignal) {
    const res = await client.request({
      method: 'GET',
      path: `${base(repo)}/compare/${spec}`,
      auth: auth(repo),
      query: { per_page: COMPARE_PAGE, page },
      signal,
    });
    const parsed = CompareSchema.safeParse(res.data);
    if (!parsed.success) throw unexpected(`比较 ${spec}`, res.data);
    return parsed.data;
  }

  return {
    mainlineHead: (repo, signal) => getCommit(repo, 'main', signal),
    commit: (repo, sha, signal) => getCommit(repo, sha, signal),

    async mainCi(repo, sha, signal) {
      const res = await client.request({
        method: 'GET',
        path: `${base(repo)}/commits/${enc(sha)}/check-runs`,
        auth: auth(repo),
        query: { per_page: 100 },
        signal,
      });
      const parsed = CheckRunsSchema.safeParse(res.data);
      if (!parsed.success) throw unexpected(`读 ${sha.slice(0, 12)} 的检查结果`, res.data);
      const runs: CheckRun[] = parsed.data.check_runs;
      const e = evaluateChecks([RELEASE_CHECK_NAME], runs, []);
      if (e.overall === 'green') return { state: 'green', detail: '' };
      if (e.overall === 'red') {
        const f = e.checks.find((c) => c.state === 'failure');
        return { state: 'red', detail: [f?.conclusion, f?.detail].filter(Boolean).join('：') || '检查没过' };
      }
      return {
        state: 'pending',
        detail: e.overall === 'none' ? '这个提交还没有汇总检查的结果' : '汇总检查还在跑',
      };
    },

    async compare(repo, baseSha, headSha, signal) {
      const spec = `${enc(baseSha)}...${enc(headSha)}`;
      let page = await comparePage(repo, spec, 1, signal);
      // 差得多：提交旧到新、一页 100 个，最近的在最后一页
      if (page.ahead_by > COMPARE_PAGE) {
        page = await comparePage(repo, spec, Math.ceil(page.ahead_by / COMPARE_PAGE), signal);
      }
      const recent = page.commits.map((c) => ({ sha: c.sha, title: firstLine(c.commit.message) })).reverse();
      return { status: page.status, aheadBy: page.ahead_by, recent };
    },

    async lastMergedPull(repo, signal) {
      const res = await client.request({
        method: 'GET',
        path: `${base(repo)}/pulls`,
        auth: auth(repo),
        query: {
          state: 'closed',
          base: 'main',
          sort: 'updated',
          direction: 'desc',
          per_page: MERGED_PULL_WINDOW,
        },
        signal,
      });
      const parsed = MergedPullListSchema.safeParse(res.data);
      if (!parsed.success) throw unexpected(`列 ${repoSlug(repo)} 最近关掉的 PR`, res.data);
      let best: MergedPullFact | undefined;
      for (const p of parsed.data) {
        if (!p.merged_at) continue;
        if (!best || Date.parse(p.merged_at) > Date.parse(best.mergedAt)) {
          best = { number: p.number, title: p.title, body: p.body ?? '', mergedAt: p.merged_at };
        }
      }
      if (!best) {
        throw new GitHubError(
          'NOT_FOUND',
          `最近关掉的 ${parsed.data.length} 个 PR 里没有合并了的，找不到最近合并的一个（没查成）`,
        );
      }
      return best;
    },

    async issueTitle(repo, number, signal) {
      const res = await client.request({
        method: 'GET',
        path: `${base(repo)}/issues/${number}`,
        auth: auth(repo),
        signal,
      });
      const parsed = IssueSchema.safeParse(res.data);
      if (!parsed.success) throw unexpected(`读 #${number}`, res.data);
      if (parsed.data.pull_request !== undefined && parsed.data.pull_request !== null) {
        throw new GitHubError('NOT_AN_ISSUE', `${repoSlug(repo)} #${number} 是 PR，不是 issue`);
      }
      return { number: parsed.data.number, title: parsed.data.title };
    },
  };
}
