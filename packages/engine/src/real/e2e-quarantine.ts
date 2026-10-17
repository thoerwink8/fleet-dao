// 隔离集进出的真接线：用引擎机器人读开着的偶发单、隔离集文件、每天的 e2e-quarantine 报告，
// 从主线拉开 e2e-quarantine/sync、写入 quarantine.json、开 PR、挂自动合并。不调模型。
// 改这里之前必须知道：
// - 分支不走 fleet/<单号>-t<8 位>：那种分支要冷验收。有开着的 PR 时不删分支、不再开一张。
// - 没有开着的 PR 时先删掉旧分支再从当前主线拉开，免得旧分支把主线上后来的提交在 PR 里倒回去。
// - 隔离集报告在 artifact 的 zip 里（results-quarantine.json）。下载要先拿令牌、再跟着 302 走，不把令牌带到签名地址上。
// - 单、PR、报告认不出都是没查成，不当成「没有」。

import { inflateRawSync } from 'node:zlib';
import { beijingDate, outcomesOf, QUARANTINE_PATH, type QuarantineDay } from '@fleet-dao/conventions';
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
import {
  type E2eQuarantineGitHub,
  type E2eQuarantineJobDeps,
  QUARANTINE_BRANCH,
} from '../jobs/e2e-quarantine.ts';

export interface E2eQuarantineWiring {
  db: Db;
  github: Pick<GitHub, 'client' | 'readRepoFile' | 'closeIssue' | 'claims'>;
  now?: () => Date;
  log?: E2eQuarantineJobDeps['log'];
  repo?: RepoRef;
  fetch?: typeof fetch;
}

const COMMIT_MESSAGE = '更新 e2e 隔离集';
/** 一份报告包超过这个就当没查成，不把整包读进内存。 */
const MAX_ZIP_BYTES = 200 * 1024 * 1024;

function notRead(why: string): never {
  throw new Error(`没查成：${why}`);
}

function encPath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function apiMessage(data: unknown): string {
  if (data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string') {
    return (data as { message: string }).message.slice(0, 300);
  }
  return '';
}

/** 从 zip 里取出名字以 suffix 结尾的那个文件。没有就返回 null。认不出的压缩方式抛。 */
export function unzipText(buf: Buffer, suffix: string): string | null {
  if (buf.length < 22) return null;
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buf.length) return null;
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error('隔离集报告包是 ZIP64，认不出');
  let p = cdOffset;
  const end = Math.min(buf.length, cdOffset + cdSize);
  while (p + 46 <= end) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!(name === suffix || name.endsWith(`/${suffix}`))) continue;
    if (localOff + 30 > buf.length) throw new Error(`隔离集报告包里 ${name} 的位置对不上`);
    const localName = buf.readUInt16LE(localOff + 26);
    const localExtra = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + localName + localExtra;
    const data = buf.subarray(dataOff, dataOff + compSize);
    if (data.length !== compSize) throw new Error(`隔离集报告包里 ${name} 被截断`);
    if (method === 0) return data.toString('utf8');
    if (method === 8) return inflateRawSync(data).toString('utf8');
    throw new Error(`隔离集报告包的压缩方式 ${method} 认不出`);
  }
  return null;
}

async function downloadZip(fetchImpl: typeof fetch, url: string, token: string): Promise<Buffer> {
  const first = await fetchImpl(url, {
    redirect: 'manual',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'fleet-dao-engine',
    },
  });
  const redirected =
    first.status === 301 || first.status === 302 || first.status === 307 || first.status === 308;
  const next = redirected ? first.headers.get('location') : null;
  if (next) await first.body?.cancel();
  const res = next
    ? await fetchImpl(next, { redirect: 'follow', headers: { 'User-Agent': 'fleet-dao-engine' } })
    : first;
  if (!res.ok) throw new Error(`下载隔离集报告失败（${res.status}）`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_ZIP_BYTES) throw new Error(`隔离集报告包太大（${len} 字节）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw new Error(`隔离集报告包太大（${buf.length} 字节）`);
  return buf;
}

export function e2eQuarantineGitHub(api: {
  client: Pick<GitHubClient, 'request' | 'installationToken'>;
  readRepoFile: GitHub['readRepoFile'];
  closeIssue: GitHub['closeIssue'];
  enableAutoMerge: GitHub['claims']['enableAutoMerge'];
  repo?: RepoRef;
  fetch?: typeof fetch;
}): E2eQuarantineGitHub {
  const repo = api.repo ?? HYGIENE_REPO;
  const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const auth = { as: 'engine' as const, repo };
  const { client } = api;
  const fetchImpl = api.fetch ?? fetch;

  async function pages(path: string, query: Record<string, string | number>): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; page <= 5; page++) {
      const res = await client.request({ method: 'GET', path, auth, query: { ...query, page } });
      if (!Array.isArray(res.data)) notRead(`${path} 认不出`);
      out.push(...res.data);
      if (res.data.length < 100) return out;
    }
    notRead(`${path} 翻了 5 页还没翻完`);
  }

  return {
    async readQuarantine() {
      const read = await api.readRepoFile({ repo, path: QUARANTINE_PATH });
      if (!/^[0-9a-f]{40}$/.test(read.commit)) notRead('默认分支的提交认不出');
      if (read.file.kind === 'missing') notRead(`没有 ${QUARANTINE_PATH}`);
      if (read.file.kind !== 'text') notRead(`${QUARANTINE_PATH} ${read.file.why}`);
      if (read.defaultBranch.length === 0) notRead('默认分支的名字认不出');
      return { commit: read.commit, text: read.file.text, base: read.defaultBranch };
    },

    async openIssues() {
      const rows = await pages(`${base}/issues`, { state: 'open', per_page: 100 });
      const issues: { number: number; title: string }[] = [];
      for (const item of rows) {
        if (!item || typeof item !== 'object') notRead('开着的单里有一条认不出');
        const row = item as { number?: unknown; title?: unknown; pull_request?: unknown };
        if (row.pull_request) continue;
        if (typeof row.number !== 'number' || !Number.isInteger(row.number) || row.number <= 0) {
          notRead('开着的单号认不出');
        }
        if (typeof row.title !== 'string') notRead(`单 #${row.number} 的标题认不出`);
        if (row.title.startsWith('e2e 偶发')) issues.push({ number: row.number, title: row.title });
      }
      return issues;
    },

    async openPulls() {
      const rows = await pages(`${base}/pulls`, { state: 'open', per_page: 100 });
      return rows.map((item) => {
        if (!item || typeof item !== 'object') notRead('开着的 PR 里有一条认不出');
        const row = item as {
          number?: unknown;
          title?: unknown;
          body?: unknown;
          node_id?: unknown;
          head?: { ref?: unknown };
        };
        if (typeof row.number !== 'number' || !Number.isInteger(row.number) || row.number <= 0) {
          notRead('开着的 PR 号认不出');
        }
        if (typeof row.title !== 'string') notRead(`PR #${row.number} 的标题认不出`);
        if (row.body !== null && typeof row.body !== 'string') notRead(`PR #${row.number} 的正文认不出`);
        if (typeof row.node_id !== 'string' || row.node_id.length === 0) {
          notRead(`PR #${row.number} 没有 node_id`);
        }
        if (typeof row.head?.ref !== 'string' || row.head.ref.length === 0) {
          notRead(`PR #${row.number} 的分支认不出`);
        }
        return {
          number: row.number,
          nodeId: row.node_id,
          title: row.title,
          body: row.body ?? '',
          head: row.head.ref,
        };
      });
    },

    async quarantineDays() {
      const res = await client.request({
        method: 'GET',
        path: `${base}/actions/workflows/e2e-quarantine.yml/runs`,
        auth,
        query: { per_page: 40 },
      });
      const data = res.data;
      if (
        !data ||
        typeof data !== 'object' ||
        !Array.isArray((data as { workflow_runs?: unknown }).workflow_runs)
      ) {
        notRead('e2e-quarantine 的运行列表认不出');
      }
      const runs = (data as { workflow_runs: unknown[] }).workflow_runs;
      const picked = new Map<string, { id: number; day: string }>();
      for (const item of runs) {
        if (!item || typeof item !== 'object') notRead('e2e-quarantine 的运行里有一条认不出');
        const row = item as {
          id?: unknown;
          conclusion?: unknown;
          created_at?: unknown;
          run_started_at?: unknown;
        };
        if (row.conclusion !== 'success' && row.conclusion !== 'failure') continue;
        if (typeof row.id !== 'number' || !Number.isInteger(row.id) || row.id <= 0) notRead('运行编号认不出');
        const when = typeof row.run_started_at === 'string' ? row.run_started_at : row.created_at;
        if (typeof when !== 'string' || Number.isNaN(Date.parse(when)))
          notRead(`运行 ${row.id} 的时刻认不出`);
        const day = beijingDate(new Date(when));
        // 列表新的在前：同一天只留第一次见到的，也就是最后一次运行。
        if (!picked.has(day)) picked.set(day, { id: row.id, day });
      }
      const token = (await client.installationToken('engine', repo)).token;
      const days: QuarantineDay[] = [];
      for (const run of picked.values()) {
        const listed = await client.request({
          method: 'GET',
          path: `${base}/actions/runs/${run.id}/artifacts`,
          auth,
          query: { per_page: 100 },
        });
        const body = listed.data;
        if (
          !body ||
          typeof body !== 'object' ||
          !Array.isArray((body as { artifacts?: unknown }).artifacts)
        ) {
          notRead(`运行 ${run.id} 的报告列表认不出`);
        }
        const artifacts = (body as { artifacts: unknown[] }).artifacts;
        const artifact = artifacts.find((a) => {
          if (!a || typeof a !== 'object') return false;
          const name = (a as { name?: unknown }).name;
          return typeof name === 'string' && name.startsWith('e2e-quarantine-');
        }) as { expired?: unknown; archive_download_url?: unknown } | undefined;
        if (!artifact || artifact.expired === true) continue;
        if (typeof artifact.archive_download_url !== 'string') notRead(`运行 ${run.id} 的报告地址认不出`);
        const zip = await downloadZip(fetchImpl, artifact.archive_download_url, token);
        const json = unzipText(zip, 'results-quarantine.json');
        if (json === null) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(json) as unknown;
        } catch {
          notRead(`运行 ${run.id} 的隔离集报告不是 JSON`);
        }
        days.push({ day: run.day, outcomes: outcomesOf(parsed) });
      }
      return days;
    },

    async openPr(input) {
      if (!/^[0-9a-f]{40}$/.test(input.baseCommit)) notRead(`开分支用的提交认不出：${input.baseCommit}`);
      if (QUARANTINE_BRANCH.startsWith('fleet/')) throw new Error(`分支 ${QUARANTINE_BRANCH} 像引擎任务分支`);
      assertPublishable(repo, `更新 ${repo.owner}/${repo.name} 的 e2e 隔离集`, [
        { path: QUARANTINE_PATH, text: input.content },
        { path: 'PR 标题', text: input.title },
        { path: 'PR 正文', text: input.body },
        { path: '提交说明', text: COMMIT_MESSAGE },
        { path: '分支名', text: QUARANTINE_BRANCH },
      ]);
      const existing = await findPull();
      if (existing) return existing;
      await client.request({
        method: 'DELETE',
        path: `${base}/git/refs/heads/${QUARANTINE_BRANCH}`,
        auth,
        allow: [404, 422],
      });
      const created = await client.request({
        method: 'POST',
        path: `${base}/git/refs`,
        auth,
        body: { ref: `refs/heads/${QUARANTINE_BRANCH}`, sha: input.baseCommit },
        allow: [422],
      });
      if (created.status === 422) {
        throw new Error(`建分支 ${QUARANTINE_BRANCH} 被拒绝：${apiMessage(created.data) || created.status}`);
      }
      await writeFile(input.content);
      return createPull(input);
    },

    async armAutoMerge(pull) {
      try {
        await api.enableAutoMerge(repo, pull);
      } catch (err) {
        const message = errMessage(err);
        if (!/already/i.test(message)) throw new Error(`PR #${pull.number} 已开，自动合并没挂上：${message}`);
      }
    },

    async closeIssue(issue, comment) {
      await api.closeIssue({ repo, issueNumber: issue, reason: 'completed', comment });
    },
  };

  async function findPull(): Promise<{ number: number; url: string; nodeId: string } | null> {
    const res = await client.request({
      method: 'GET',
      path: `${base}/pulls`,
      auth,
      query: { head: `${repo.owner}:${QUARANTINE_BRANCH}`, state: 'open', per_page: 10 },
    });
    if (!Array.isArray(res.data)) notRead('找已开的隔离集 PR 时返回认不出');
    const row = res.data[0];
    if (!row) return null;
    return pullOf(row, '已开的隔离集 PR');
  }

  async function writeFile(content: string): Promise<void> {
    const filePath = `${base}/contents/${encPath(QUARANTINE_PATH)}`;
    const current = await client.request({
      method: 'GET',
      path: filePath,
      auth,
      query: { ref: QUARANTINE_BRANCH },
      allow: [404],
    });
    let sha: string | undefined;
    if (current.status !== 404) {
      if (!current.data || typeof current.data !== 'object') throw new Error('读分支上的隔离集认不出');
      const row = current.data as { type?: unknown; encoding?: unknown; content?: unknown; sha?: unknown };
      if (
        row.type !== 'file' ||
        row.encoding !== 'base64' ||
        typeof row.content !== 'string' ||
        typeof row.sha !== 'string'
      ) {
        throw new Error('读分支上的隔离集认不出');
      }
      sha = row.sha;
      if (Buffer.from(row.content.replace(/\n/g, ''), 'base64').toString('utf8') === content) return;
    }
    const written = await client.request({
      method: 'PUT',
      path: filePath,
      auth,
      body: {
        message: COMMIT_MESSAGE,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: QUARANTINE_BRANCH,
        ...(sha === undefined ? {} : { sha }),
      },
      allow: [409, 422],
    });
    if (written.status === 409 || written.status === 422) {
      throw new Error(
        `写 ${QUARANTINE_PATH} 被拒绝（${written.status}：${apiMessage(written.data) || '没有原因'}）`,
      );
    }
    const commit = (written.data as { commit?: { sha?: unknown } } | null)?.commit?.sha;
    if (typeof commit !== 'string') throw new Error(`写 ${QUARANTINE_PATH} 的回执认不出`);
  }

  async function createPull(input: { title: string; body: string; base: string }): Promise<{
    number: number;
    url: string;
    nodeId: string;
  }> {
    const opened = await client.request({
      method: 'POST',
      path: `${base}/pulls`,
      auth,
      body: { title: input.title, head: QUARANTINE_BRANCH, base: input.base, body: input.body },
    });
    return pullOf(opened.data, '开隔离集 PR');
  }

  function pullOf(data: unknown, what: string): { number: number; url: string; nodeId: string } {
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

/** 给 EngineJobs.e2eQuarantine 用的工厂。 */
export function e2eQuarantineJob(w: E2eQuarantineWiring): () => E2eQuarantineJobDeps {
  const now = w.now ?? (() => new Date());
  const log: E2eQuarantineJobDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const github = e2eQuarantineGitHub({
    client: w.github.client,
    readRepoFile: w.github.readRepoFile,
    closeIssue: w.github.closeIssue,
    enableAutoMerge: (repo, pull) => w.github.claims.enableAutoMerge(repo, pull),
    ...(w.repo === undefined ? {} : { repo: w.repo }),
    ...(w.fetch === undefined ? {} : { fetch: w.fetch }),
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
