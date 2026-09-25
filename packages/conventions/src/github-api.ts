// 欠账检查、阶段收口要读 GitHub 上 issue 和里程碑现在的样子：只读，走 REST 接口。
// 令牌按 GITHUB_TOKEN → GH_TOKEN → 本机 `gh auth token` 的顺序找，都没有就不带（公开仓不带令牌也读得到，
// 只是每小时 60 次）。令牌只放进请求头，报错里不带。读不到、认不出一律抛，由调用方判「没查成」，不当成没问题。
import { execFileSync } from 'node:child_process';

export interface IssueInfo {
  number: number;
  title: string;
  state: 'open' | 'closed';
  /** 这个号其实是 PR（issue 和 PR 共用一套号）。 */
  isPr: boolean;
  /** ISO 时间。 */
  createdAt: string;
  labels: string[];
  milestone: string | null;
}

export interface MilestoneInfo {
  number: number;
  title: string;
  state: 'open' | 'closed';
}

export interface GitHubReader {
  /** 开着的 issue（不含 PR）。 */
  openIssues(): Promise<IssueInfo[]>;
  /** 这个号现在的样子；没有这个号（404、410）返回 undefined。 */
  issue(n: number): Promise<IssueInfo | undefined>;
  /** 所有里程碑（开着的、关了的）。 */
  milestones(): Promise<MilestoneInfo[]>;
  /** 这个里程碑里开着的 issue 和 PR。 */
  openInMilestone(milestone: number): Promise<IssueInfo[]>;
}

type Env = Record<string, string | undefined>;

/** 仓名：GITHUB_REPOSITORY（Actions 里有），没有就从 origin 的地址认。认不出返回 undefined。 */
export function repoName(env: Env, root: string, git = gitOrigin): string | undefined {
  const fromEnv = env.GITHUB_REPOSITORY?.trim();
  if (fromEnv) return /^[\w.-]+\/[\w.-]+$/.test(fromEnv) ? fromEnv : undefined;
  const url = git(root);
  const m = url && /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m?.[1];
}

function gitOrigin(root: string): string | undefined {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
}

function ghToken(): string | undefined {
  try {
    const t = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

export function liveGitHub(
  repo: string,
  env: Env,
  opts: { fetchImpl?: typeof fetch; token?: () => string | undefined } = {},
): GitHubReader {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  let token: string | undefined | null = null;
  const auth = () => {
    if (token === null) token = env.GITHUB_TOKEN || env.GH_TOKEN || (opts.token ?? ghToken)();
    return token;
  };

  const get = async (path: string): Promise<Response> => {
    const t = auth();
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fleet-dao-conventions',
    };
    if (t) headers.authorization = `Bearer ${t}`;
    let res: Response;
    try {
      res = await fetchImpl(path.startsWith('http') ? path : `${api}${path}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new Error(`连不上 GitHub（${message(e)}）`);
    }
    return res;
  };

  const failed = (res: Response, what: string): Error => {
    const limited = res.status === 403 || res.status === 429;
    const hint =
      limited && res.headers.get('x-ratelimit-remaining') === '0'
        ? auth()
          ? '：被限流了'
          : '：被限流了（没带令牌时每小时 60 次；设 GITHUB_TOKEN，或本机 gh auth login）'
        : '';
    return new Error(`读${what}，GitHub 回了 ${res.status}${hint}`);
  };

  /** 逐页读完（按 Link 头的 next）。 */
  const pages = async (path: string, what: string): Promise<unknown[]> => {
    const all: unknown[] = [];
    let next: string | undefined = path;
    for (let i = 0; next; i++) {
      if (i >= 50) throw new Error(`读${what}翻了 50 页还没完，不当成读完了`);
      const res = await get(next);
      if (!res.ok) throw failed(res, what);
      const data = await json(res, what);
      if (!Array.isArray(data)) throw new Error(`读${what}，读回来的不是列表`);
      all.push(...data);
      next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
    }
    return all;
  };

  return {
    async openIssues() {
      const rows = await pages(`/repos/${repo}/issues?state=open&per_page=100`, '开着的 issue');
      return rows.map((r) => toIssue(r, '开着的 issue')).filter((i) => !i.isPr);
    },
    async issue(n) {
      const res = await get(`/repos/${repo}/issues/${n}`);
      if (res.status === 404 || res.status === 410) return undefined;
      if (!res.ok) throw failed(res, ` #${n} `);
      return toIssue(await json(res, ` #${n} `), ` #${n} `);
    },
    async milestones() {
      const rows = await pages(`/repos/${repo}/milestones?state=all&per_page=100`, '里程碑');
      return rows.map(toMilestone);
    },
    async openInMilestone(milestone) {
      const rows = await pages(
        `/repos/${repo}/issues?milestone=${milestone}&state=open&per_page=100`,
        '里程碑里开着的单',
      );
      return rows.map((r) => toIssue(r, '里程碑里开着的单'));
    },
  };
}

async function json(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`读${what}，读回来的不是 JSON（${message(e)}）`);
  }
}

/** 接口回来的一条 issue；缺字段就抛，不猜。 */
export function toIssue(raw: unknown, what = 'issue'): IssueInfo {
  const bad = (field: string) => new Error(`读${what}，有一条认不出（${field}）`);
  if (!isObject(raw)) throw bad('不是对象');
  const { number, title, state, created_at, labels, milestone, pull_request } = raw;
  if (typeof number !== 'number') throw bad('number');
  if (typeof title !== 'string') throw bad('title');
  if (state !== 'open' && state !== 'closed') throw bad('state');
  if (typeof created_at !== 'string') throw bad('created_at');
  if (!Array.isArray(labels) || !labels.every((l) => isObject(l) && typeof l.name === 'string')) {
    throw bad('labels');
  }
  if (milestone !== null && !(isObject(milestone) && typeof milestone.title === 'string')) {
    throw bad('milestone');
  }
  return {
    number,
    title,
    state,
    isPr: pull_request !== undefined && pull_request !== null,
    createdAt: created_at,
    labels: labels.map((l) => String((l as { name: string }).name)),
    milestone: milestone === null ? null : String((milestone as { title: string }).title),
  };
}

function toMilestone(raw: unknown): MilestoneInfo {
  if (
    !isObject(raw) ||
    typeof raw.number !== 'number' ||
    typeof raw.title !== 'string' ||
    (raw.state !== 'open' && raw.state !== 'closed')
  ) {
    throw new Error('读里程碑，有一条认不出');
  }
  return { number: raw.number, title: raw.title, state: raw.state };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function message(e: unknown): string {
  const cause = e instanceof Error && isObject(e.cause) ? e.cause.code : undefined;
  const text = e instanceof Error ? e.message : String(e);
  return typeof cause === 'string' ? `${text}：${cause}` : text;
}
