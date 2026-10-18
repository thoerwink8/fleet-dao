// pnpm project 的真口子（见 ./project.ts 的 ProjectWorld）：GitHub 只经本机 gh（令牌留在 gh 里，不读出来），
// 法国只经 ssh 以 root 调 fleet-api（ssh 名字同指挥官的 france.mjs：环境变量 FLEET_FRANCE_SSH，或 ~/.fleet-dao/france-ssh 第一行）。
// 两个 App 装没装不读本机 gh 的 user/installations（本机身份缺 metadata 权限会 403，#2977），只经 fleet-api project installations。
// 按标题找单、按单号读单都不走搜索索引（#2995：刚创建的单搜索会晚一步，空不等于没有）。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  parsePolicyUrl,
  policyHead,
  policyRepo,
  policySourceContext,
} from '../../shared/src/ci-policy-bridge.ts';
import { policyReader, readPolicyHttp } from './ci-policy-bridge.ts';
import type { GhApi } from './gh-api.ts';
import type { Gh } from './issue-new.ts';
import { gateGitHub } from './merge-gate.ts';
import type { FleetApiResult, IssueFact, ProjectWorld, RepoFacts, RepoLabel } from './project.ts';

const FLEET_API = '/srv/fleet-dao-releases/current/packages/api/bin/fleet-api';

/** 路径一段段编码（中文文件名、空格），斜杠留着。 */
const encPath = (p: string) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

async function ghOk(gh: Gh, args: string[], what: string): Promise<string> {
  const r = await gh(args);
  if (r.code !== 0) throw new Error(`${what}没成（gh 退出码 ${r.code}）：${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

async function ghJson<T>(gh: Gh, args: string[], what: string): Promise<T> {
  const text = await ghOk(gh, args, what);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what}：gh 回的不是 JSON`);
  }
}

/** GET 一个仓内接口；404 回 null，别的错抛。 */
async function ghGetOrNull<T>(gh: Gh, path: string, what: string): Promise<T | null> {
  const r = await gh(['api', path]);
  if (r.code === 0) return JSON.parse(r.stdout) as T;
  if (/HTTP 404|Not Found/.test(r.stderr)) return null;
  throw new Error(`${what}没成（gh 退出码 ${r.code}）：${(r.stderr || r.stdout).trim()}`);
}

const numberFromUrl = (url: string, what: string): number => {
  const n = Number(/\/(\d+)\s*$/.exec(url.trim())?.[1]);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${what}：认不出 gh 回的地址 ${url.trim()}`);
  return n;
};

export type FleetApiRunner = (args: string[], stdin?: string) => Promise<FleetApiResult>;

/** 只许这几种字符进远端命令行：仓名、数字、选项、分支名。别的一律拒，不拼进 shell。 */
const SAFE_ARG = /^[A-Za-z0-9._/:=-]+$/;

export function franceSshHost(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const fromEnv = env.FLEET_FRANCE_SSH?.trim();
  if (fromEnv) return fromEnv;
  try {
    const line = readFileSync(join(home, '.fleet-dao', 'france-ssh'), 'utf8')
      .split(/\r?\n/)[0]
      ?.trim();
    if (line) return line;
  } catch {
    // 下面报
  }
  throw new Error(
    '不知道怎么登法国：设环境变量 FLEET_FRANCE_SSH，或把 ssh 名字写进 ~/.fleet-dao/france-ssh 第一行',
  );
}

/** 一条 fleet-api 最多等多久：到点杀掉 ssh，回退出码 124，调用方当没查成。 */
export const FLEET_API_TIMEOUT_MS = 120_000;

/** 经 ssh 在法国以 root 跑 fleet-api（它自己换成 fleet 身份）。超过 timeoutMs 杀掉、回退出码 124。 */
export function sshFleetApi(
  host: () => string,
  command = 'ssh',
  timeoutMs = FLEET_API_TIMEOUT_MS,
): FleetApiRunner {
  return (args, stdin) =>
    new Promise((done) => {
      const bad = args.find((a) => !SAFE_ARG.test(a));
      if (bad !== undefined) {
        done({ code: 2, stdout: '', stderr: `参数里有不许拼进远端命令行的字符：${bad}` });
        return;
      }
      let target: string;
      try {
        target = host();
      } catch (err) {
        done({ code: 2, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
        return;
      }
      const child = spawn(command, [target, `cd /tmp && sudo bash ${FLEET_API} ${args.join(' ')}`], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (c) => {
        stdout += String(c);
      });
      child.stderr.on('data', (c) => {
        stderr += String(c);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        done({ code: 127, stdout, stderr: `ssh 没起来：${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut)
          done({
            code: 124,
            stdout,
            stderr: `ssh 超时：${timeoutMs} 毫秒没跑完 fleet-api ${args.slice(0, 2).join(' ')}`,
          });
        else done({ code: code ?? 1, stdout, stderr });
      });
      // 子进程先退了（超时被杀）时写标准输入会 EPIPE：不当成崩
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin ?? '');
    });
}

/** issues 列表一页最多这么多。仓库这个接口没有 filter（那是 GET /issues 的），多传可能 422。 */
export const ISSUE_LIST_PAGE = 100;
/**
 * 页码翻页翻满还没见底：没读全，不能当成没有。
 * 和本包别处「翻了 50 页还没完，不当成读完了」同一个上限。
 */
export const ISSUE_LIST_PAGES_MAX = 50;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 认一张 issues API 回的单。认不出抛；PR 标出来，调用方自己决定算不算。 */
function parseIssueFact(raw: unknown, what: string): { fact: IssueFact; pull: boolean } {
  if (!isRecord(raw)) throw new Error(`${what}：认不出`);
  const number = raw.number;
  const title = raw.title;
  const state = raw.state;
  if (typeof title !== 'string' || !Number.isSafeInteger(number) || (number as number) <= 0) {
    throw new Error(`${what}：没有可信的单号或标题`);
  }
  if (typeof state !== 'string' || !state) throw new Error(`${what}：没有状态`);
  return {
    fact: { number: number as number, title, state },
    pull: raw.pull_request !== undefined && raw.pull_request !== null,
  };
}

/**
 * GET /repos/{slug}/issues，不走搜索索引。
 * 读全了没有这张完整标题回 null；没读成、没读全、有一条认不出抛错。
 */
async function issuesListedByTitle(gh: Gh, slug: string, title: string): Promise<IssueFact | null> {
  const what = `直接列 ${slug} 的单`;
  for (let page = 1; page <= ISSUE_LIST_PAGES_MAX; page++) {
    const path = `repos/${slug}/issues?state=all&sort=created&direction=desc&per_page=${ISSUE_LIST_PAGE}&page=${page}`;
    const list = await ghJson<unknown>(gh, ['api', path], `${what}第 ${page} 页`);
    if (!Array.isArray(list)) throw new Error(`${what}：回的不是数组`);
    for (const raw of list) {
      const parsed = parseIssueFact(raw, `${what}里有一条`);
      if (!parsed.pull && parsed.fact.title === title) return parsed.fact;
    }
    if (list.length < ISSUE_LIST_PAGE) return null;
  }
  throw new Error(`${what}：${ISSUE_LIST_PAGES_MAX} 页还没列完，不能当成没有「${title}」`);
}

/** GET /repos/{slug}/issues/{number}。没有这张单回 null；端口出错或认不出抛。 */
async function issueReadByNumber(gh: Gh, slug: string, number: number): Promise<IssueFact | null> {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`单号不可信：${String(number)}`);
  const what = `直接读 ${slug} #${number}`;
  const raw = await ghGetOrNull<unknown>(gh, `repos/${slug}/issues/${number}`, what);
  if (raw === null) return null;
  return parseIssueFact(raw, what).fact;
}

export function ghProjectWorld(
  gh: Gh,
  fleetApi: FleetApiRunner,
  fetchImpl: typeof fetch = fetch,
): ProjectWorld {
  return {
    async policyBridge(slug, githubId, descriptor) {
      const api: GhApi = {
        get: (path) => ghJson(gh, ['api', `repos/${slug}${path}`], '读真实策略仓/PR/source'),
        globalGet: (path) => ghJson(gh, ['api', path.replace(/^\//, '')], '读可信 writer 数字身份'),
        getOrNull: async () => {
          throw new Error('策略检查不用 getOrNull');
        },
        post: async () => {
          throw new Error('策略体检不允许写 GitHub');
        },
      };
      const identity = policyRepo(await api.get(''));
      if (
        !identity.public ||
        identity.githubId !== githubId ||
        identity.repo.toLowerCase() !== slug.toLowerCase()
      )
        throw new Error('策略桥实际仓身份或 public 不匹配');
      const endpoint = parsePolicyUrl(descriptor.endpoint, githubId);
      const response = await readPolicyHttp(endpoint, identity, fetchImpl);
      const reads = gateGitHub(api);
      const reader = policyReader(api, reads, slug, fetchImpl);
      let heads = 0;
      let missing = 0;
      for (const raw of await reads.openPrs()) {
        const head = policyHead(raw, identity);
        if (!head.open || head.fork) continue;
        heads++;
        const statuses = await reads.statuses(head.head);
        if (!statuses.some((s) => isRecord(s) && s.context === policySourceContext(head.number))) {
          missing++;
          continue;
        }
        if ((await reader(head.number, head.head)) !== response.ciPolicy)
          throw new Error('当前头 source 与真实 endpoint 模式不一致');
      }
      return { ciPolicy: response.ciPolicy, heads, missing };
    },
    async repo(slug) {
      const r = await ghJson<{
        id?: unknown;
        name?: unknown;
        owner?: { login?: unknown };
        default_branch?: unknown;
        archived?: unknown;
      }>(gh, ['api', `repos/${slug}`], `读 GitHub 上的 ${slug} `);
      if (typeof r.id !== 'number' || typeof r.name !== 'string' || typeof r.owner?.login !== 'string')
        throw new Error(`GitHub 回的 ${slug} 认不出`);
      const facts: RepoFacts = {
        id: r.id,
        owner: r.owner.login,
        name: r.name,
        defaultBranch: typeof r.default_branch === 'string' && r.default_branch ? r.default_branch : 'main',
        archived: r.archived === true,
      };
      return facts;
    },
    async addToInstallation(installationId, repoId) {
      // GitHub 只有单仓接口，没有请求体（#2749）
      await ghOk(
        gh,
        ['api', '-X', 'PUT', `user/installations/${installationId}/repositories/${repoId}`, '--silent'],
        `把仓 ${repoId} 加进安装 ${installationId}`,
      );
    },
    async labels(slug) {
      const list = await ghJson<RepoLabel[]>(
        gh,
        ['label', 'list', '-R', slug, '--limit', '500', '--json', 'name,color,description'],
        `读 ${slug} 的标签`,
      );
      return list.map((l) => ({ name: l.name, color: l.color, description: l.description ?? '' }));
    },
    async createLabel(slug, l) {
      await ghOk(
        gh,
        ['label', 'create', l.name, '-R', slug, '--color', l.color, '--description', l.description],
        `在 ${slug} 建标签「${l.name}」`,
      );
    },
    async editLabel(slug, l) {
      await ghOk(
        gh,
        ['label', 'edit', l.name, '-R', slug, '--color', l.color, '--description', l.description],
        `改 ${slug} 的标签「${l.name}」`,
      );
    },
    async listDir(slug, ref, dir) {
      const r = await ghGetOrNull<unknown>(
        gh,
        `repos/${slug}/contents/${encPath(dir)}?ref=${encodeURIComponent(ref)}`,
        `读 ${slug} 的 ${dir || '仓根'}`,
      );
      if (!Array.isArray(r)) return [];
      return r.flatMap((e: { name?: unknown; type?: unknown }) =>
        typeof e.name === 'string'
          ? [{ name: e.name, type: e.type === 'dir' ? ('dir' as const) : ('file' as const) }]
          : [],
      );
    },
    async fileText(slug, ref, path) {
      const r = await ghGetOrNull<{ content?: unknown; encoding?: unknown }>(
        gh,
        `repos/${slug}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`,
        `读 ${slug} 的 ${path}`,
      );
      if (r === null || Array.isArray(r)) return null;
      if (typeof r.content !== 'string' || r.encoding !== 'base64')
        throw new Error(`${slug} 的 ${path} 认不出`);
      return Buffer.from(r.content, 'base64').toString('utf8');
    },
    async openPrFrom(slug, head) {
      const list = await ghJson<{ number: number; url: string }[]>(
        gh,
        ['pr', 'list', '-R', slug, '--head', head, '--state', 'open', '--json', 'number,url'],
        `查 ${slug} 上 ${head} 开着的 PR`,
      );
      return list[0] ?? null;
    },
    async openFillPr(slug, input) {
      const baseSha = (
        await ghOk(
          gh,
          ['api', `repos/${slug}/git/ref/heads/${encPath(input.base)}`, '--jq', '.object.sha'],
          `读 ${slug} 的 ${input.base}`,
        )
      ).trim();
      // 分支在（上回开过又关了的）就拨回 base，不在就建
      const created = await gh([
        'api',
        '-X',
        'POST',
        `repos/${slug}/git/refs`,
        '-f',
        `ref=refs/heads/${input.head}`,
        '-f',
        `sha=${baseSha}`,
        '--silent',
      ]);
      if (created.code !== 0)
        await ghOk(
          gh,
          [
            'api',
            '-X',
            'PATCH',
            `repos/${slug}/git/refs/heads/${encPath(input.head)}`,
            '-f',
            `sha=${baseSha}`,
            '-F',
            'force=true',
            '--silent',
          ],
          `建分支 ${input.head}`,
        );
      for (const f of input.files) {
        const existing = await ghGetOrNull<{ sha?: unknown }>(
          gh,
          `repos/${slug}/contents/${encPath(f.path)}?ref=${encodeURIComponent(input.head)}`,
          `读 ${f.path}`,
        );
        const sha = existing && typeof existing.sha === 'string' ? ['-f', `sha=${existing.sha}`] : [];
        await ghOk(
          gh,
          [
            'api',
            '-X',
            'PUT',
            `repos/${slug}/contents/${encPath(f.path)}`,
            '-f',
            `message=补齐 fleet-dao 标准：${f.path}`,
            '-f',
            `content=${Buffer.from(f.text, 'utf8').toString('base64')}`,
            '-f',
            `branch=${input.head}`,
            ...sha,
            '--silent',
          ],
          `写 ${f.path}`,
        );
      }
      const url = await ghOk(
        gh,
        [
          'pr',
          'create',
          '-R',
          slug,
          '--base',
          input.base,
          '--head',
          input.head,
          '--title',
          input.title,
          '--body',
          input.body,
        ],
        `在 ${slug} 开补齐 PR`,
      );
      return { number: numberFromUrl(url, '开补齐 PR'), url: url.trim() };
    },
    async findIssue(slug, title) {
      // 和直接列单同一条路。以前这里走 gh issue list --search，索引延迟会把刚开的单说成没有。
      return issuesListedByTitle(gh, slug, title);
    },
    async listIssueByTitle(slug, title) {
      return issuesListedByTitle(gh, slug, title);
    },
    async readIssue(slug, number) {
      return issueReadByNumber(gh, slug, number);
    },
    async createIssue(slug, input) {
      const url = await ghOk(
        gh,
        [
          'issue',
          'create',
          '-R',
          slug,
          '--title',
          input.title,
          '--body',
          input.body,
          ...input.labels.flatMap((l) => ['--label', l]),
        ],
        `在 ${slug} 开单`,
      );
      return numberFromUrl(url, '开单');
    },
    fleetApi,
  };
}
