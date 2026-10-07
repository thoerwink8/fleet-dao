// 每周刷新耗时表的真接线（#921）：用引擎机器人的令牌读 ci.yml 日志、读默认分支上的表和测试文件，
// 表有变化就从读到的那个提交拉分支、写入、开 PR、挂自动合并（和 pnpm pr:open 同一套：没碰改标准才挂，squash）。
// 改这里之前必须知道：
// - 分支叫 ci-timings/YYYY-MM-DD，不走 fleet/<单号>-t<8 位>：那种分支要冷验收，这张表没有对应的单。
// - 同一天再跑一次：分支已经在就在上面改文件、PR 已经开着就复用，自动合并挂过了（报 already）不当失败。
// - 标准路径清单读不到、认不出：没查成，分支都不建。清单说这次改动碰到标准：不开 PR、不挂自动合并。
// - 运行列表、job 列表、文件树认不出都是没查成，不当成「一轮都没有」或「仓里没有测试」。job 翻不完页同样没查成，不许少算测试台。
// - 原始 job 日志没有 `gh run view --log` 的「job 名<TAB>」前缀，这里补上，parseRunLog 才认得出 `test (`。

import {
  isFlowBranch,
  isTestFile,
  parseStandardPaths,
  STANDARD_PATHS_FILE,
  standardFiles,
  TIMINGS_FILE,
} from '@fleet-dao/conventions';
import type { Db } from '@fleet-dao/db';
import { finishScheduleRun, startScheduleRun } from '@fleet-dao/db';
import {
  assertPublishable,
  type GitHub,
  type GitHubClient,
  HYGIENE_REPO,
  type RepoRef,
} from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import type { CiTimingsGitHub, CiTimingsJobDeps, OpenTimingsPrInput } from '../jobs/ci-timings.ts';

export interface CiTimingsWiring {
  db: Db;
  github: Pick<GitHub, 'client' | 'readRepoFile' | 'claims'>;
  now?: () => Date;
  log?: CiTimingsJobDeps['log'];
  repo?: RepoRef;
}

/** 给测试注入的那一层：请求、读文件、挂自动合并。生产用 createGitHub 拿到的那份。 */
export interface CiTimingsApi {
  client: Pick<GitHubClient, 'request' | 'all'>;
  readRepoFile: GitHub['readRepoFile'];
  enableAutoMerge: GitHub['claims']['enableAutoMerge'];
  repo?: RepoRef;
}

const COMMIT_MESSAGE = '刷新 CI 测试耗时表';

function notRead(why: string): never {
  throw new Error(`没查成：${why}`);
}

function encPath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function idOf(value: unknown, what: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  notRead(`${what}认不出`);
}

function apiMessage(data: unknown): string {
  if (data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string') {
    return (data as { message: string }).message.slice(0, 300);
  }
  return '';
}

interface ListedJob {
  id: string;
  name: string;
  conclusion: string | null;
}

export function ciTimingsGitHub(api: CiTimingsApi): CiTimingsGitHub {
  const repo = api.repo ?? HYGIENE_REPO;
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const auth = { as: 'engine' as const, repo };
  const { client } = api;

  async function jobsOf(runId: string): Promise<ListedJob[]> {
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
    return items.map((item) => {
      if (!item || typeof item !== 'object') notRead(`运行 ${runId} 的 job 列表里有一条认不出`);
      const row = item as { id?: unknown; name?: unknown; conclusion?: unknown };
      if (typeof row.name !== 'string') notRead(`运行 ${runId} 的 job 名字认不出`);
      if (row.conclusion !== null && typeof row.conclusion !== 'string') {
        notRead(`运行 ${runId} 的 job「${row.name}」结论认不出`);
      }
      return { id: idOf(row.id, `运行 ${runId} 的 job 编号`), name: row.name, conclusion: row.conclusion };
    });
  }

  async function testFilesAt(commit: string): Promise<string[]> {
    const res = await client.request({
      method: 'GET',
      path: `${base}/git/trees/${commit}`,
      auth,
      query: { recursive: 1 },
    });
    const data = res.data;
    if (!data || typeof data !== 'object') notRead('仓的文件树认不出');
    const body = data as { tree?: unknown; truncated?: unknown };
    if (body.truncated === true) notRead('仓的文件树被截断，列不全测试文件');
    if (!Array.isArray(body.tree)) notRead('仓的文件树认不出（没有 tree）');
    const entries: { path: string; type: string }[] = [];
    for (const item of body.tree) {
      if (!item || typeof item !== 'object') notRead('仓的文件树里有一条认不出');
      const path = (item as { path?: unknown }).path;
      const type = (item as { type?: unknown }).type;
      if (typeof path !== 'string' || typeof type !== 'string') notRead('仓的文件树里有一条没有路径');
      entries.push({ path, type });
    }
    const has = (dir: string) => entries.some((e) => e.path === dir || e.path.startsWith(`${dir}/`));
    if (!has('packages') || !has('agents/test'))
      notRead('列不出 packages/ 或 agents/test/（测试文件从这里找）');
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.type !== 'blob' || !isTestFile(entry.path)) continue;
      if (/[\s\p{Cc}]/u.test(entry.path)) {
        notRead(`测试文件名里有空白或控制字符：${JSON.stringify(entry.path)}`);
      }
      files.push(entry.path);
    }
    files.sort();
    return files;
  }

  return {
    async listSuccessfulRuns(limit) {
      const res = await client.request({
        method: 'GET',
        path: `${base}/actions/workflows/ci.yml/runs`,
        auth,
        query: { status: 'success', per_page: limit },
      });
      const data = res.data;
      if (
        !data ||
        typeof data !== 'object' ||
        !Array.isArray((data as { workflow_runs?: unknown }).workflow_runs)
      ) {
        notRead('ci.yml 运行列表认不出（没有 workflow_runs）');
      }
      const runs = (data as { workflow_runs: unknown[] }).workflow_runs.slice(0, limit);
      return runs.map((item) => {
        if (!item || typeof item !== 'object') notRead('ci.yml 运行列表里有一条认不出');
        return { id: idOf((item as { id?: unknown }).id, 'ci.yml 运行编号') };
      });
    },

    async successfulTestBoxes(runId) {
      const jobs = await jobsOf(runId);
      return jobs.filter((job) => job.name.startsWith('test (') && job.conclusion === 'success').length;
    },

    async runLog(runId) {
      const jobs = (await jobsOf(runId)).filter(
        (job) => job.name.startsWith('test (') && job.conclusion === 'success',
      );
      const lines: string[] = [];
      for (const job of jobs) {
        const res = await client.request({
          method: 'GET',
          path: `${base}/actions/jobs/${encodeURIComponent(job.id)}/logs`,
          auth,
        });
        if (typeof res.data !== 'string' || res.data.length === 0) {
          notRead(`运行 ${runId} 的「${job.name}」日志读不到`);
        }
        for (const line of res.data.split(/\r?\n/)) {
          if (line.length === 0) continue;
          lines.push(`${job.name}\tlog\t${line}`);
        }
      }
      return lines.join('\n');
    },

    async readHead() {
      const read = await api.readRepoFile({ repo, path: TIMINGS_FILE });
      if (!/^[0-9a-f]{40}$/.test(read.commit)) notRead('默认分支的提交认不出');
      if (read.file.kind === 'not_file') notRead(`${TIMINGS_FILE} ${read.file.why}`);
      return {
        commit: read.commit,
        timingsText: read.file.kind === 'text' ? read.file.text : null,
        testFiles: await testFilesAt(read.commit),
      };
    },

    openPr(input) {
      return openTimingsPr(api, repo, input);
    },
  };
}

async function openTimingsPr(
  api: CiTimingsApi,
  repo: RepoRef,
  input: OpenTimingsPrInput,
): Promise<{ number: number; url: string }> {
  if (!/^[0-9a-f]{40}$/.test(input.baseCommit)) notRead(`开分支用的提交认不出：${input.baseCommit}`);
  const day = input.at.toISOString().slice(0, 10);
  const branch = `ci-timings/${day}`;
  if (isFlowBranch(branch)) throw new Error(`分支 ${branch} 像引擎任务分支，这张表不走那条`);

  const listed = await api.readRepoFile({ repo, path: STANDARD_PATHS_FILE }).catch((err: unknown) => {
    const why = errMessage(err);
    // 清单读不到就不知道该不该挂自动合并：没查成，分支都不建（和 pnpm pr:open 判不了就不开一样）。
    throw new Error(why.includes('没查成') ? why : `没查成：读不到 ${STANDARD_PATHS_FILE}（${why}）`);
  });
  if (listed.file.kind !== 'text') notRead(`读不到 ${STANDARD_PATHS_FILE}`);
  const rules = parseStandardPaths(listed.file.text);
  if (typeof rules === 'string') notRead(`${STANDARD_PATHS_FILE} ${rules}`);
  const hits = standardFiles([{ filename: TIMINGS_FILE, status: 'modified' }], rules);
  if (hits.length > 0) {
    throw new Error(`改到了标准路径（${hits.map((h) => h.file).join('、')}），人闸：改标准，不开 PR`);
  }
  assertPublishable(repo, `刷新 ${repo.owner}/${repo.name} 的 CI 测试耗时表`, [
    { path: TIMINGS_FILE, text: input.content },
    { path: 'PR 标题', text: input.title },
    { path: 'PR 正文', text: input.body },
    { path: '提交说明', text: COMMIT_MESSAGE },
    { path: '分支名', text: branch },
  ]);

  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const auth = { as: 'engine' as const, repo };
  const { client } = api;
  const created = await client.request({
    method: 'POST',
    path: `${base}/git/refs`,
    auth,
    body: { ref: `refs/heads/${branch}`, sha: input.baseCommit },
    allow: [422],
  });
  if (created.status === 422 && !/already exists/i.test(apiMessage(created.data))) {
    throw new Error(`建分支 ${branch} 被拒绝：${apiMessage(created.data) || created.status}`);
  }

  const filePath = `${base}/contents/${encPath(TIMINGS_FILE)}`;
  const current = await client.request({
    method: 'GET',
    path: filePath,
    auth,
    query: { ref: branch },
    allow: [404],
  });
  let sha: string | undefined;
  let same = false;
  if (current.status !== 404) {
    if (!current.data || typeof current.data !== 'object') throw new Error('读分支上的耗时表认不出');
    const row = current.data as { type?: unknown; encoding?: unknown; content?: unknown; sha?: unknown };
    if (
      row.type !== 'file' ||
      row.encoding !== 'base64' ||
      typeof row.content !== 'string' ||
      typeof row.sha !== 'string'
    ) {
      throw new Error('读分支上的耗时表认不出');
    }
    sha = row.sha;
    same = Buffer.from(row.content.replace(/\n/g, ''), 'base64').toString('utf8') === input.content;
  }
  if (!same) {
    const written = await client.request({
      method: 'PUT',
      path: filePath,
      auth,
      body: {
        message: COMMIT_MESSAGE,
        content: Buffer.from(input.content, 'utf8').toString('base64'),
        branch,
        ...(sha === undefined ? {} : { sha }),
      },
      allow: [409, 422],
    });
    if (written.status === 409 || written.status === 422) {
      throw new Error(
        `写 ${TIMINGS_FILE} 被拒绝（${written.status}：${apiMessage(written.data) || '没有原因'}）`,
      );
    }
    const commit = (written.data as { commit?: { sha?: unknown } } | null)?.commit?.sha;
    if (typeof commit !== 'string') throw new Error(`写 ${TIMINGS_FILE} 的回执认不出`);
  }

  const found = await client.request({
    method: 'GET',
    path: `${base}/pulls`,
    auth,
    query: { head: `${repo.owner}:${branch}`, state: 'open', per_page: 10 },
  });
  if (!Array.isArray(found.data)) throw new Error('找已开的 PR 时返回认不出');
  const existing = found.data[0];
  const pull = existing ? pullOf(existing, '已开的 PR') : await createPull();

  try {
    await api.enableAutoMerge(repo, { number: pull.number, nodeId: pull.nodeId });
  } catch (err) {
    const message = errMessage(err);
    if (!/already/i.test(message)) throw new Error(`PR #${pull.number} 已开，自动合并没挂上：${message}`);
  }
  return { number: pull.number, url: pull.url };

  async function createPull(): Promise<{ number: number; nodeId: string; url: string }> {
    const opened = await client.request({
      method: 'POST',
      path: `${base}/pulls`,
      auth,
      body: { title: input.title, head: branch, base: listed.defaultBranch, body: input.body },
    });
    return pullOf(opened.data, '开 PR');
  }

  function pullOf(data: unknown, what: string): { number: number; nodeId: string; url: string } {
    if (!data || typeof data !== 'object') throw new Error(`${what}的回执认不出`);
    const row = data as { number?: unknown; node_id?: unknown; html_url?: unknown };
    if (typeof row.number !== 'number' || !Number.isInteger(row.number) || row.number <= 0) {
      throw new Error(`${what}的回执认不出`);
    }
    if (typeof row.node_id !== 'string' || row.node_id.length === 0)
      throw new Error(`${what}的回执没有 node_id`);
    const url =
      typeof row.html_url === 'string' && row.html_url.length > 0
        ? row.html_url
        : `https://github.com/${repo.owner}/${repo.name}/pull/${row.number}`;
    return { number: row.number, nodeId: row.node_id, url };
  }
}

/** 给 EngineJobs.ciTimings 用的工厂。 */
export function ciTimingsJob(w: CiTimingsWiring): () => CiTimingsJobDeps {
  const now = w.now ?? (() => new Date());
  const log: CiTimingsJobDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const github = ciTimingsGitHub({
    client: w.github.client,
    readRepoFile: w.github.readRepoFile,
    enableAutoMerge: (repo, pull) => w.github.claims.enableAutoMerge(repo, pull),
    ...(w.repo === undefined ? {} : { repo: w.repo }),
  });
  return () => ({
    github,
    runs: {
      start: (job, at) => startScheduleRun(w.db, job, at),
      finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
    },
    now,
    log,
  });
}
