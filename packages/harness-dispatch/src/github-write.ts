// 内核发布那一步用的 GitHub 写口（#3783，第 7 片）：只有推分支之后的几件事——查分支、查 PR、开 PR、改名分支、关 PR。
// 没有合并：这个文件里不存在任何合并或「挂自动合并」的调用（`test/github-write.test.ts` 扫源码守着），合不合由现有合并闸和人决定。
// 令牌是 PUBLISH_PERMISSIONS 的短期令牌（见 github-app.ts），只在内核进程里；每次 GitHub 调用经 onCall 记账（旧坑 E1）。
export interface PrInfo {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  headSha: string;
  body: string;
}

export interface GitHubWriter {
  /** 分支现在指向哪个提交，没有这个分支回 null。 */
  branchSha(repo: string, branch: string): Promise<string | null>;
  defaultBranch(repo: string): Promise<string>;
  /** 以这个分支为头的 PR（不论开着还是关了），没有回 null。 */
  prByHead(repo: string, branch: string): Promise<PrInfo | null>;
  /** 开着的 PR 里提到这张单的（头分支带单号前缀，或正文有 closes/fixes/resolves #单号）。 */
  openPrsForIssue(repo: string, issue: number): Promise<PrInfo[]>;
  openPr(repo: string, pr: { head: string; base: string; title: string; body: string }): Promise<PrInfo>;
  getPr(repo: string, number: number): Promise<PrInfo>;
  /** 这个提交的合并状态汇总：pending 还在跑（切回要等）、failure/success 有结论、none 没有任何状态。 */
  commitStatus(repo: string, sha: string): Promise<'pending' | 'success' | 'failure' | 'none'>;
  /** 切回用：把分支改名（在原提交上建新名、再删旧名）。 */
  renameBranch(repo: string, from: string, to: string): Promise<void>;
  /** 切回用：关掉 PR（不合并）。 */
  closePr(repo: string, number: number): Promise<void>;
}

export interface GitHubWriteOptions {
  /** 按仓给发布令牌（见 github-app.ts 的 PUBLISH_PERMISSIONS）。 */
  tokenFor: (repo: string) => Promise<string>;
  api?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** 每次调用记一笔：`GET /pulls` 这样的粗名字。 */
  onCall?: (what: string) => void;
}

/** GitHub 回了明确的错（4xx 不是限流）：这次请求一定没生效，调用方可以确定地失败。 */
export class GitHubDefiniteError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(what: string, status: number, detail: string) {
    super(`${what}：HTTP ${status} ${detail}`.trim());
    this.name = 'GitHubDefiniteError';
    this.status = status;
    this.detail = detail;
  }
}

/** 没拿到明确回答（超时、断线、5xx、限流）：写类请求可能已经生效，调用方按「结果不知道」处理。 */
export class GitHubUncertainError extends Error {
  constructor(what: string, why: string) {
    super(`${what}：${why}`);
    this.name = 'GitHubUncertainError';
  }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

export function githubWriter(o: GitHubWriteOptions): GitHubWriter {
  const api = (o.api ?? 'https://api.github.com').replace(/\/$/, '');
  const f = o.fetch ?? fetch;

  async function call(
    repo: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    if (!REPO.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) {
      throw new Error(`仓名不合法：${repo}`);
    }
    const what = `${method} ${path.replace(/[?].*$/, '').replace(/\/\d+/g, '/:n')}`;
    o.onCall?.(what);
    let res: Response;
    try {
      res = await f(`${api}/repos/${repo}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await o.tokenFor(repo)}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new GitHubUncertainError(what, err instanceof Error ? err.message : String(err));
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status >= 500 || res.status === 429 || (res.status === 403 && isRateLimited(res, text))) {
      throw new GitHubUncertainError(what, `HTTP ${res.status}`);
    }
    return { status: res.status, json };
  }

  const ok = (what: string, r: { status: number; json: unknown }) => {
    if (r.status >= 200 && r.status < 300) return r.json;
    const msg = (r.json as { message?: unknown } | null)?.message;
    throw new GitHubDefiniteError(what, r.status, typeof msg === 'string' ? msg.slice(0, 300) : '');
  };

  const toPr = (raw: unknown): PrInfo => {
    const p = raw as {
      number?: unknown;
      html_url?: unknown;
      state?: unknown;
      merged?: unknown;
      merged_at?: unknown;
      body?: unknown;
      head?: { ref?: unknown; sha?: unknown };
    };
    if (typeof p?.number !== 'number' || typeof p.html_url !== 'string' || !p.head) {
      throw new Error('GitHub 回的 PR 形状认不出');
    }
    return {
      number: p.number,
      url: p.html_url,
      state: p.state === 'open' ? 'open' : 'closed',
      merged: p.merged === true || typeof p.merged_at === 'string',
      headRef: String(p.head.ref ?? ''),
      headSha: String(p.head.sha ?? ''),
      body: typeof p.body === 'string' ? p.body : '',
    };
  };

  return {
    async branchSha(repo, branch) {
      const r = await call(repo, 'GET', `/git/ref/heads/${encodeRef(branch)}`);
      if (r.status === 404) return null;
      const json = ok('查分支', r) as { object?: { sha?: unknown } };
      if (typeof json.object?.sha !== 'string') throw new Error('GitHub 回的分支形状认不出');
      return json.object.sha;
    },

    async defaultBranch(repo) {
      const json = ok('查仓', await call(repo, 'GET', '')) as { default_branch?: unknown };
      if (typeof json.default_branch !== 'string' || !json.default_branch) {
        throw new Error('GitHub 回的仓形状认不出');
      }
      return json.default_branch;
    },

    async prByHead(repo, branch) {
      const owner = repo.split('/')[0] ?? '';
      const r = await call(
        repo,
        'GET',
        `/pulls?state=all&per_page=5&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      );
      const list = ok('查 PR', r);
      if (!Array.isArray(list)) throw new Error('GitHub 回的 PR 列表形状认不出');
      const first = list.map(toPr).find((p) => p.headRef === branch);
      return first ?? null;
    },

    async openPrsForIssue(repo, issue) {
      const out: PrInfo[] = [];
      for (let page = 1; page <= 5; page++) {
        const list = ok(
          '列开着的 PR',
          await call(repo, 'GET', `/pulls?state=open&per_page=100&page=${page}`),
        );
        if (!Array.isArray(list)) throw new Error('GitHub 回的 PR 列表形状认不出');
        for (const raw of list) {
          const pr = toPr(raw);
          if (mentionsIssue(pr, issue)) out.push(pr);
        }
        if (list.length < 100) break;
      }
      return out;
    },

    async openPr(repo, pr) {
      const r = await call(repo, 'POST', '/pulls', pr);
      return toPr(ok('开 PR', r));
    },

    async getPr(repo, number) {
      return toPr(ok('读 PR', await call(repo, 'GET', `/pulls/${number}`)));
    },

    async commitStatus(repo, sha) {
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`提交号不对：${sha}`);
      const json = ok('读提交状态', await call(repo, 'GET', `/commits/${sha}/status`)) as {
        state?: unknown;
        total_count?: unknown;
      };
      if (json.total_count === 0) return 'none';
      return json.state === 'pending' || json.state === 'success' || json.state === 'failure'
        ? json.state
        : json.state === 'error'
          ? 'failure'
          : 'none';
    },

    async renameBranch(repo, from, to) {
      const sha = await this.branchSha(repo, from);
      if (!sha) throw new GitHubDefiniteError('改名分支', 404, `${from} 不存在`);
      const made = await call(repo, 'POST', '/git/refs', { ref: `refs/heads/${to}`, sha });
      // 422 = 新名字已经在：上一次做了一半，接着删旧名
      if (made.status !== 422) ok('建新分支名', made);
      ok('删旧分支名', await call(repo, 'DELETE', `/git/refs/heads/${encodeRef(from)}`));
    },

    async closePr(repo, number) {
      ok('关 PR', await call(repo, 'PATCH', `/pulls/${number}`, { state: 'closed' }));
    },
  };
}

/** 路径里的分支名：每一段单独转义，斜杠留着（`fleet2/12-d3-a1`）。 */
function encodeRef(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

function isRateLimited(res: Response, text: string): boolean {
  return res.headers.get('x-ratelimit-remaining') === '0' || /rate limit|abuse/i.test(text);
}

/** PR 是不是在做这张单：头分支带 `fleet/<单号>-` 或 `fleet2/<单号>-`，或正文有 closes/fixes/resolves #单号。 */
export function mentionsIssue(pr: Pick<PrInfo, 'headRef' | 'body'>, issue: number): boolean {
  if (new RegExp(`^fleet2?/${issue}(?:-|$)`).test(pr.headRef)) return true;
  for (const m of pr.body.matchAll(CLOSES)) if (Number(m[1]) === issue) return true;
  return false;
}
