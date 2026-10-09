// 读主线上 ci.yml 最近的 push 运行（#766）。写法照 ci-timings：列表认不出就没查成，不许回空列表冒充「没有」。
// 只要 push、只要 main。进行中的也原样带回（判法不拿它改结论）。最近一次已结束且是 failure 的，带上失败作业名。
import { type GitHubClient, HYGIENE_REPO, type RepoRef } from '@fleet-dao/github';
import type { MainPushRun } from '../jobs/main-red-push.ts';

/** 给测试注入的那一层。生产用 createGitHub 拿到的 client。 */
export interface MainCiRunsApi {
  client: Pick<GitHubClient, 'request' | 'all'>;
  repo?: RepoRef;
}

/** 一页够用：更新的进行中运行再多，最近一次已结束的也在这一页里。翻不到下一页不算没查成。 */
export const MAIN_CI_RUNS_PAGE = 30;

function notRead(why: string): never {
  throw new Error(why.includes('没查成') ? why : `没查成：${why}`);
}

function idOf(value: unknown, what: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  notRead(`${what}认不出`);
}

interface ParsedRun {
  id: string;
  status: string;
  conclusion: string | null;
  sha: string;
  url: string;
  failedJobs: string[];
}

/** 主线 ci.yml 的 push 运行，新的在前。读不到、认不出照抛。 */
export function mainCiRuns(api: MainCiRunsApi): () => Promise<MainPushRun[]> {
  const repo = api.repo ?? HYGIENE_REPO;
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const auth = { as: 'engine' as const, repo };
  const { client } = api;

  async function failedJobNames(runId: string): Promise<string[]> {
    const items = await client.all(
      {
        method: 'GET',
        path: `${base}/actions/runs/${encodeURIComponent(runId)}/jobs`,
        auth,
        query: { filter: 'latest', per_page: 100 },
      },
      (data) => {
        if (!data || typeof data !== 'object' || !Array.isArray((data as { jobs?: unknown }).jobs)) {
          notRead(`运行 ${runId} 的 job 列表认不出（没有 jobs）`);
        }
        return (data as { jobs: unknown[] }).jobs;
      },
    );
    const names: string[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') notRead(`运行 ${runId} 的 job 列表里有一条认不出`);
      const row = item as { name?: unknown; conclusion?: unknown };
      if (typeof row.name !== 'string' || row.name.trim() === '') notRead(`运行 ${runId} 的 job 名字认不出`);
      if (row.conclusion !== null && typeof row.conclusion !== 'string') {
        notRead(`运行 ${runId} 的 job「${row.name}」结论认不出`);
      }
      if (row.conclusion === 'failure') names.push(row.name);
    }
    return names;
  }

  return async () => {
    const res = await client.request({
      method: 'GET',
      path: `${base}/actions/workflows/ci.yml/runs`,
      auth,
      query: { branch: 'main', event: 'push', per_page: MAIN_CI_RUNS_PAGE },
    });
    const data = res.data;
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray((data as { workflow_runs?: unknown }).workflow_runs)
    ) {
      notRead('ci.yml 运行列表认不出（没有 workflow_runs）');
    }
    const raw = (data as { workflow_runs: unknown[] }).workflow_runs;
    const runs: ParsedRun[] = raw.map((item) => {
      if (!item || typeof item !== 'object') notRead('ci.yml 运行列表里有一条认不出');
      const row = item as {
        id?: unknown;
        status?: unknown;
        conclusion?: unknown;
        head_sha?: unknown;
        head_branch?: unknown;
        event?: unknown;
        html_url?: unknown;
      };
      const id = idOf(row.id, 'ci.yml 运行编号');
      if (row.event !== 'push') notRead(`ci.yml 运行 ${id} 不是 push（event=${String(row.event)}）`);
      if (row.head_branch !== 'main')
        notRead(`ci.yml 运行 ${id} 不在 main（head_branch=${String(row.head_branch)}）`);
      if (typeof row.status !== 'string' || row.status === '') notRead(`ci.yml 运行 ${id} 的 status 认不出`);
      let conclusion: string | null;
      if (row.status === 'completed') {
        if (typeof row.conclusion !== 'string' || row.conclusion === '') {
          notRead(`ci.yml 运行 ${id} 已结束，结论认不出`);
        }
        conclusion = row.conclusion;
      } else if (row.conclusion === null || row.conclusion === undefined) {
        conclusion = null;
      } else if (typeof row.conclusion === 'string') {
        conclusion = row.conclusion;
      } else {
        notRead(`ci.yml 运行 ${id} 的结论认不出`);
      }
      if (typeof row.head_sha !== 'string' || !/^[0-9a-f]{40}$/.test(row.head_sha)) {
        notRead(`ci.yml 运行 ${id} 的提交号认不出`);
      }
      const url =
        typeof row.html_url === 'string' && row.html_url.startsWith('https://')
          ? row.html_url
          : `https://github.com/${repo.owner}/${repo.name}/actions/runs/${id}`;
      return { id, status: row.status, conclusion, sha: row.head_sha, url, failedJobs: [] };
    });

    const finished = runs.find((r) => r.status === 'completed');
    if (finished && finished.conclusion === 'failure') {
      finished.failedJobs = await failedJobNames(finished.id);
    }
    return runs.map((r) => ({
      status: r.status,
      conclusion: r.conclusion,
      sha: r.sha,
      url: r.url,
      failedJobs: r.failedJobs,
    }));
  };
}
