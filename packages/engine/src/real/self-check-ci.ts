// 规范 CI 的源码测试覆盖，不是本机 PASS 缓存。任何证据缺口都交回原自测。
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimOf } from '@fleet-dao/conventions';
import type { GitHubClient } from '@fleet-dao/github';
import type { CiTestCoverage } from '../task-contract.ts';

const SHA = /^[0-9a-f]{40}$/;
const REPO = { owner: 'thoerwink8', name: 'fleet-dao' };
const PREFIX = '/repos/thoerwink8/fleet-dao';
const obj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 只接受实际运行模块所在、root 保护的正式发布目录，不跟随 current 的后续切版。 */
export async function trustedReleaseCommit(moduleUrl = import.meta.url): Promise<string | null> {
  try {
    const root = await realpath(resolve(dirname(fileURLToPath(moduleUrl)), '../../../..'));
    const m = /^\/srv\/fleet-dao-releases\/([0-9a-f]{40})$/.exec(root);
    if (!m?.[1]) return null;
    for (const path of [root, dirname(root), '/srv', '/', join(root, '.fleet-release')]) {
      const s = await lstat(path);
      if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) !== 0) return null;
    }
    const marker = await readFile(join(root, '.fleet-release'), 'utf8');
    const commits = marker.split('\n').filter((line) => line.startsWith('commit='));
    const onMain = marker.split('\n').filter((line) => line.startsWith('on_main='));
    return commits.length === 1 &&
      commits[0] === `commit=${m[1]}` &&
      onMain.length === 1 &&
      onMain[0] === 'on_main=1'
      ? m[1]
      : null;
  } catch {
    return null;
  }
}

/** 配置/工具/选测合同全从发布 SHA 的官方对象读，不信候选自证。源码与测试本身由精确同树完整 CI 覆盖。 */
export function isCiContractPath(path: string): boolean {
  return (
    !path.includes('/') ||
    path.startsWith('.github/') ||
    path.startsWith('packages/conventions/') ||
    path === 'deploy/france.sh' ||
    /(^|\/)(?:package\.json|tsconfig[^/]*\.json|vitest[^/]*\.[^/]+|TEST_READS[^/]*)$/.test(path)
  );
}

function contractTree(value: unknown): Map<string, string> | null {
  if (!obj(value) || value.truncated !== false || !Array.isArray(value.tree)) return null;
  const entries = new Map<string, string>();
  for (const entry of value.tree) {
    if (!obj(entry) || typeof entry.path !== 'string' || typeof entry.sha !== 'string') return null;
    if (entry.mode === '160000') return null;
    if (entry.type === 'tree') continue;
    if (entry.type !== 'blob' || !SHA.test(entry.sha)) return null;
    if (isCiContractPath(entry.path)) {
      if (entry.mode !== '100644' && entry.mode !== '100755') return null;
      if (entries.has(entry.path)) return null;
      entries.set(entry.path, `${entry.mode}:${entry.sha}`);
    }
  }
  return entries;
}

export interface CiSourceInput {
  pr: number;
  head: string;
  tree: string;
  node: string;
  pnpm: string;
  vitest: string;
}

export type CiRead = (path: string, signal: AbortSignal) => Promise<unknown>;

/** 有界读数；不回看历史成功 run 绕过最近失败，不读取候选代码执行。 */
export function ciTestCoverage(read: CiRead, release: () => Promise<string | null> = trustedReleaseCommit) {
  return async (input: CiSourceInput, signal: AbortSignal): Promise<CiTestCoverage | null> => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const get = async (path: string) => {
      bounded.throwIfAborted();
      const value = await read(path, bounded);
      bounded.throwIfAborted();
      return value;
    };
    try {
      if (!SHA.test(input.head) || !SHA.test(input.tree) || !Number.isSafeInteger(input.pr) || input.pr < 1)
        return null;
      const commit = await release();
      if (commit === null || !SHA.test(commit)) return null;
      const pr = await get(`/pulls/${input.pr}`);
      if (
        !obj(pr) ||
        pr.state !== 'open' ||
        pr.number !== input.pr ||
        !obj(pr.head) ||
        pr.head.sha !== input.head ||
        !obj(pr.head.repo) ||
        pr.head.repo.full_name !== 'thoerwink8/fleet-dao' ||
        !obj(pr.base) ||
        pr.base.ref !== 'main' ||
        !obj(pr.base.repo) ||
        pr.base.repo.full_name !== 'thoerwink8/fleet-dao'
      )
        return null;
      const baseline = contractTree(await get(`/git/trees/${commit}?recursive=1`));
      const candidate = contractTree(await get(`/git/trees/${input.tree}?recursive=1`));
      if (!baseline || !candidate || baseline.size !== candidate.size) return null;
      for (const [path, hash] of baseline) if (candidate.get(path) !== hash) return null;
      const packageHash = baseline.get('package.json')?.split(':')[1];
      const lockHash = baseline.get('pnpm-lock.yaml')?.split(':')[1];
      if (!packageHash || !lockHash || !baseline.has('.github/workflows/ci.yml')) return null;
      const blob = async (hash: string) => {
        const v = await get(`/git/blobs/${hash}`);
        if (!obj(v) || v.encoding !== 'base64' || typeof v.content !== 'string') return null;
        const bytes = Buffer.from(v.content, 'base64');
        const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        return actual === hash ? bytes.toString('utf8') : null;
      };
      const packageText = await blob(packageHash);
      const lock = await blob(lockHash);
      if (packageText === null || lock === null) return null;
      const pkg: unknown = JSON.parse(packageText);
      if (!obj(pkg) || pkg.packageManager !== `pnpm@${input.pnpm}`) return null;
      // 锁文件实际选中的根 Vitest 必须等于现场读数；不是只比 package.json 中的宽版本范围。
      const versions = [
        ...lock.matchAll(
          /^ {6}vitest:\n {8}specifier: [^\n]+\n {8}version: ([0-9]+\.[0-9]+\.[0-9]+)(?:\([^\n]*)?$/gm,
        ),
      ];
      if (versions.length !== 1 || versions[0]?.[1] !== input.vitest) return null;
      const workflow = await get('/actions/workflows/ci.yml');
      if (!obj(workflow) || workflow.path !== '.github/workflows/ci.yml' || typeof workflow.id !== 'number')
        return null;
      const runs = await get(
        `/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${input.head}&per_page=100`,
      );
      if (!obj(runs) || !Array.isArray(runs.workflow_runs) || runs.total_count !== runs.workflow_runs.length)
        return null;
      // 多 run 的来源/新旧关系不明不猜；正常 synchronize 只有这一个固定 head 的 run。
      if (runs.workflow_runs.length !== 1) return null;
      const listed = runs.workflow_runs[0];
      if (!obj(listed) || typeof listed.id !== 'number') return null;
      const run = await get(`/actions/runs/${listed.id}`);
      if (
        !obj(run) ||
        run.id !== listed.id ||
        run.workflow_id !== workflow.id ||
        run.event !== 'pull_request' ||
        run.path !== '.github/workflows/ci.yml' ||
        run.head_sha !== input.head ||
        run.status !== 'completed' ||
        run.conclusion !== 'success' ||
        !Number.isSafeInteger(run.run_attempt) ||
        (run.run_attempt as number) < 1 ||
        !obj(run.repository) ||
        run.repository.full_name !== 'thoerwink8/fleet-dao' ||
        !Array.isArray(run.pull_requests) ||
        !run.pull_requests.some((v) => obj(v) && v.number === input.pr)
      )
        return null;
      const body = await get(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
      if (!obj(body) || !Array.isArray(body.jobs) || body.total_count !== body.jobs.length) return null;
      const jobs = body.jobs;
      const named = (name: string) => jobs.filter((j) => obj(j) && j.name === name);
      for (const name of ['check', 'changes']) {
        const matches = named(name);
        if (
          matches.length !== 1 ||
          !obj(matches[0]) ||
          matches[0].status !== 'completed' ||
          matches[0].conclusion !== 'success'
        )
          return null;
      }
      const changes = named('changes')[0];
      if (!obj(changes) || !Array.isArray(changes.steps)) return null;
      const claim = claimOf(changes.steps.map((s) => (obj(s) && typeof s.name === 'string' ? s.name : '')));
      if (claim === null || typeof claim === 'string' || claim.tree !== input.tree) return null;
      const claims = changes.steps.filter(
        (s) => obj(s) && typeof s.name === 'string' && s.name.startsWith('已测的树'),
      );
      if (
        claims.length !== 1 ||
        !obj(claims[0]) ||
        claims[0].name !== `已测的树 tree=${input.tree}` ||
        claims[0].conclusion !== 'success'
      )
        return null;
      const node = /^v?([0-9]+\.[0-9]+)\.[0-9]+$/.exec(input.node)?.[1];
      if (!node) return null;
      const tests = jobs.filter((j) => obj(j) && typeof j.name === 'string' && /^test \(.+\)$/.test(j.name));
      if (tests.length === 0) return null;
      const names = new Set<string>();
      const ciNodes = new Set<string>();
      for (const job of tests) {
        if (
          !obj(job) ||
          typeof job.name !== 'string' ||
          names.has(job.name) ||
          job.status !== 'completed' ||
          job.conclusion !== 'success' ||
          !Array.isArray(job.steps)
        )
          return null;
        names.add(job.name);
        const env = job.steps.filter(
          (s) => obj(s) && typeof s.name === 'string' && s.name.startsWith('已测的环境'),
        );
        if (
          env.length !== 1 ||
          !obj(env[0]) ||
          env[0].conclusion !== 'success' ||
          typeof env[0].name !== 'string'
        )
          return null;
        const measured = /^已测的环境 node=v?([0-9]+\.[0-9]+)\.[0-9]+$/.exec(env[0].name)?.[1];
        if (measured !== node) return null;
        ciNodes.add(env[0].name.slice('已测的环境 node='.length));
      }
      // 再读 run/PR，重跑/新推发生在取证途中不能继续沿用旧读数。
      const latest = await get(`/actions/runs/${run.id}`);
      const finalPr = await get(`/pulls/${input.pr}`);
      const finalRuns = await get(
        `/actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${input.head}&per_page=100`,
      );
      if (
        !obj(latest) ||
        latest.run_attempt !== run.run_attempt ||
        latest.status !== 'completed' ||
        latest.conclusion !== 'success' ||
        !obj(finalPr) ||
        finalPr.state !== 'open' ||
        !obj(finalPr.head) ||
        finalPr.head.sha !== input.head ||
        !obj(finalRuns) ||
        finalRuns.total_count !== 1 ||
        !Array.isArray(finalRuns.workflow_runs) ||
        finalRuns.workflow_runs.length !== 1 ||
        !obj(finalRuns.workflow_runs[0]) ||
        finalRuns.workflow_runs[0].id !== run.id
      )
        return null;
      return {
        repo: 'thoerwink8/fleet-dao',
        pr: input.pr,
        head: input.head,
        tree: input.tree,
        run: run.id as number,
        attempt: run.run_attempt as number,
        workflow: workflow.id,
        contractCommit: commit,
        contractHash: createHash('sha256')
          .update(JSON.stringify([...baseline].sort()))
          .digest('hex'),
        checks: ['check', 'changes', ...names],
        ciNodes: [...ciNodes],
        node: input.node,
      };
    } catch {
      signal.throwIfAborted();
      return null;
    }
  };
}

export function realCiTestCoverage(client: GitHubClient) {
  if (client.apiUrl !== 'https://api.github.com') return undefined;
  return ciTestCoverage(
    async (path, signal) =>
      (
        await client.request({
          method: 'GET',
          path: `${PREFIX}${path}`,
          auth: { as: 'engine', repo: REPO },
          signal,
        })
      ).data,
  );
}
