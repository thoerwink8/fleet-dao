// 新内核读 GitHub（#3811）：只读。读单的快照变成影子工人的六项指示；读旧 PR 合没合、合并 diff 给影子评分。
// 令牌（按仓现换的只读短期令牌）只在内核进程里（工人环境不带任何 GitHub 变量）；只发 GET 和 GraphQL 查询，不发任何写。
import type { BatchItem, MergedReader } from '@fleet-dao/harness-store';

export interface GitHubReadOptions {
  /** 按仓（owner/name）给只读令牌（见 github-app.ts） */
  tokenFor: (repo: string) => Promise<string>;
  api?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const CONTEXT_MAX = 20_000;
const DIFF_MAX = 2_000_000;

export function githubReader(o: GitHubReadOptions) {
  const api = (o.api ?? 'https://api.github.com').replace(/\/$/, '');
  const f = o.fetch ?? fetch;
  const headers = async (repo: string, accept = 'application/vnd.github+json') => ({
    authorization: `Bearer ${await o.tokenFor(repo)}`,
    accept,
    'x-github-api-version': '2022-11-28',
  });
  const call = async (url: string, init: RequestInit, what: string): Promise<Response> => {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
    if (!res.ok) throw new Error(`${what}：HTTP ${res.status}`);
    return res;
  };

  async function taskFor(item: BatchItem) {
    const res = await call(
      `${api}/repos/${item.repo}/issues/${item.issue}`,
      { headers: await headers(item.repo) },
      `读 ${item.repo}#${item.issue}`,
    );
    const issue = (await res.json()) as { title?: string; body?: string | null; pull_request?: unknown };
    if (issue.pull_request) throw new Error(`${item.repo}#${item.issue} 是 PR，不是单`);
    const title = String(issue.title ?? '').trim();
    if (!title) throw new Error(`${item.repo}#${item.issue} 没有标题`);
    return {
      task: `做 ${item.repo}#${item.issue}：${title}`,
      expected: '在当前目录里改好代码、补上测试，留下可以合并的改动（不用提交、不用推）',
      must_do: '按单里「怎么算做完」做；改完跑一遍仓里相关的测试',
      must_not: '不碰部署脚本和密钥；不推送、不开 PR、不连 GitHub',
      context: `# ${title}\n\n${String(issue.body ?? '')}`.slice(0, CONTEXT_MAX),
      stop_when: '「怎么算做完」都满足、相关测试过，或确定做不了（交 blocked 并写清原因）',
    };
  }

  const readMerged: MergedReader = async (repo, issue) => {
    const [owner, name] = repo.split('/');
    const query = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number merged mergeCommit{oid}}}}}}`;
    const res = await call(
      `${api}/graphql`,
      {
        method: 'POST',
        headers: await headers(repo),
        body: JSON.stringify({ query, variables: { owner, name, n: issue } }),
      },
      `查 ${repo}#${issue} 的合并 PR`,
    );
    const body = (await res.json()) as {
      errors?: { message: string }[];
      data?: {
        repository?: {
          issue?: {
            closedByPullRequestsReferences?: {
              nodes?: { number: number; merged: boolean; mergeCommit: { oid: string } | null }[];
            };
          } | null;
        };
      };
    };
    if (body.errors?.length) throw new Error(`查 ${repo}#${issue} 的合并 PR：${body.errors[0]?.message}`);
    const nodes = body.data?.repository?.issue?.closedByPullRequestsReferences?.nodes;
    if (!nodes) throw new Error(`查 ${repo}#${issue} 的合并 PR：回来的形状认不出`);
    const pr = nodes.find((n) => n.merged && n.mergeCommit);
    if (!pr?.mergeCommit) return undefined;
    const diffRes = await call(
      `${api}/repos/${repo}/pulls/${pr.number}`,
      { headers: await headers(repo, 'application/vnd.github.diff') },
      `读 ${repo}#${pr.number} 的 diff`,
    );
    const diff = await diffRes.text();
    if (diff.length > DIFF_MAX) throw new Error(`${repo}#${pr.number} 的 diff 超过 ${DIFF_MAX} 字符`);
    return { pr: pr.number, sha: pr.mergeCommit.oid, diff };
  };

  return { taskFor, readMerged };
}
