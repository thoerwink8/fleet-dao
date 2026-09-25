// 欠账的定时任务、阶段收口要读 GitHub 上 issue 和里程碑现在的样子，欠账的定时任务还往单上留言，
// PR 补贴（pr-labels）读 PR、往 PR 上补类别标签和里程碑：走 REST 接口。
// 必过检查（pnpm check）不许用这里（#87：同一份代码什么时候跑结果都一样）。
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

/** 欠账的定时任务往单上留言用（要能写 issue 的令牌）。 */
export interface GitHubCommenter {
  /** 这张单上所有留言的正文。 */
  comments(n: number): Promise<string[]>;
  comment(n: number, body: string): Promise<void>;
}

/** PR 补贴（pr-labels.ts）用：读 PR 现在的样子，补类别标签和里程碑（要能写 PR 的令牌）。 */
export interface GitHubPrLabeler {
  /** PR 现在的样子；读不到（含没有这个号）就抛。 */
  pull(n: number): Promise<PullInfo>;
  /** 给 PR 加一个标签；返回加完以后 PR 上的全部标签（GitHub 回的）。 */
  addLabel(n: number, name: string): Promise<string[]>;
  /** 给 PR 挂里程碑（按里程碑的号）；返回挂完以后的里程碑名字（GitHub 回的）。 */
  setMilestone(n: number, milestone: number): Promise<string | null>;
}

export interface PullInfo {
  number: number;
  title: string;
  body: string;
  labels: string[];
  milestone: string | null;
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
): GitHubReader & GitHubCommenter & GitHubPrLabeler {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  let token: string | undefined | null = null;
  const auth = () => {
    if (token === null) token = env.GITHUB_TOKEN || env.GH_TOKEN || (opts.token ?? ghToken)();
    return token;
  };

  const get = async (path: string, init: { method?: string; body?: string } = {}): Promise<Response> => {
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
        ...init,
        headers: init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
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
    return new Error(`${what.startsWith('在') ? what : `读${what}`}，GitHub 回了 ${res.status}${hint}`);
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
    async comments(n) {
      const rows = await pages(`/repos/${repo}/issues/${n}/comments?per_page=100`, ` #${n} 的留言`);
      return rows.map((r) => {
        if (!isObject(r) || typeof r.body !== 'string')
          throw new Error(`读 #${n} 的留言，有一条认不出（body）`);
        return r.body;
      });
    },
    async comment(n, body) {
      const res = await get(`/repos/${repo}/issues/${n}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      if (res.status !== 201) throw failed(res, `在 #${n} 上留言`);
    },
    async pull(n) {
      const what = ` PR #${n} `;
      const res = await get(`/repos/${repo}/pulls/${n}`);
      if (!res.ok) throw failed(res, what);
      const raw = await json(res, what);
      if (!isObject(raw)) throw new Error(`读${what}，读回来的不是对象`);
      if (raw.body !== null && typeof raw.body !== 'string') throw new Error(`读${what}，认不出（body）`);
      const { number, title, labels, milestone } = toIssue({ ...raw, pull_request: {} }, what);
      if (number !== n) throw new Error(`要读 PR #${n}，读回来的是 #${number}`);
      return { number, title, body: raw.body ?? '', labels, milestone };
    },
    async addLabel(n, name) {
      const what = `给 PR #${n} 加标签「${name}」`;
      const res = await get(`/repos/${repo}/issues/${n}/labels`, {
        method: 'POST',
        body: JSON.stringify({ labels: [name] }),
      });
      if (!res.ok) throw failed(res, `在${what}时`);
      const data = await json(res, what);
      if (!Array.isArray(data) || !data.every((l) => isObject(l) && typeof l.name === 'string')) {
        throw new Error(`${what}，GitHub 回的认不出（应当是标签列表）`);
      }
      return data.map((l) => String((l as { name: string }).name));
    },
    async setMilestone(n, milestone) {
      const what = `给 PR #${n} 挂里程碑`;
      const res = await get(`/repos/${repo}/issues/${n}`, {
        method: 'PATCH',
        body: JSON.stringify({ milestone }),
      });
      if (!res.ok) throw failed(res, `在${what}时`);
      return toIssue(await json(res, what), what).milestone;
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
