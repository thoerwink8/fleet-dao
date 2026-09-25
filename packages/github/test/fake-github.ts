// 本地假 GitHub：内存里的一个仓，按真接口的路径与形状回话（形状对照 test/fixtures 里录的真返回）。不出网。
// 校验两个 App 的 JWT 签名、按令牌认身份，每个请求都记下来（谁、调了什么、带了什么），测试据此断言「用的是哪个机器人」。
import { createPublicKey, generateKeyPairSync, type KeyObject, verify } from 'node:crypto';
import type { AppCredentials, AppRole } from '../src/credentials.ts';

export const OWNER = 'acme';
export const REPO = 'widgets';
export const API = 'https://api.github.test';

let keys: { agent: KeyObject; engine: KeyObject } | undefined;

/** 两个测试用的 App（私钥现场生成，不进仓）。 */
export function testApps(): Record<AppRole, AppCredentials> {
  keys ??= {
    agent: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
    engine: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
  };
  return {
    agent: {
      role: 'agent',
      appId: 101,
      clientId: 'Iv1.agent',
      slug: 'fleet-test-agent',
      privateKey: keys.agent,
      source: 'test',
    },
    engine: {
      role: 'engine',
      appId: 202,
      clientId: 'Iv1.engine',
      slug: 'fleet-test-engine',
      privateKey: keys.engine,
      source: 'test',
    },
  };
}

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** 谁发的：agent / engine（安装令牌）、app:agent / app:engine（JWT）、anonymous。 */
  as: string;
  headers: Headers;
}

export interface GhUser {
  login: string;
  id: number;
  type: 'User' | 'Bot';
}

export interface PullState {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  mergeable_state: string;
  user: GhUser;
  merged_by: GhUser | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  updated_at: string;
  merged_at: string | null;
}

export interface CheckRunState {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  output?: { title: string | null; summary: string | null };
}

export interface IssueState {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  state_reason: string | null;
  user: GhUser;
  created_at: string;
  updated_at: string;
  /** 评论没给 created_at 的，按 updated_at 算（没改过的评论两者相同）。 */
  comments: { id: number; body: string; user: GhUser; updated_at: string; created_at?: string }[];
  /** 编辑历史，新的在前（和 GraphQL userContentEdits 一样）。 */
  edits: { diff: string; editor: GhUser }[];
}

type Handler = (req: Recorded) => Response | undefined | Promise<Response | undefined>;

export class FakeGitHub {
  readonly apps = testApps();
  readonly requests: Recorded[] = [];
  readonly bots: Record<AppRole, GhUser> = {
    agent: { login: 'fleet-test-agent[bot]', id: 9001, type: 'Bot' },
    engine: { login: 'fleet-test-engine[bot]', id: 9002, type: 'Bot' },
  };
  readonly human: GhUser = { login: 'founder', id: 42, type: 'User' };
  defaultBranch = 'main';
  requiredChecks = ['check'];
  /** 哪些身份装到了这个仓上。 */
  installed: Record<AppRole, boolean> = { agent: true, engine: true };
  permissions: Record<AppRole, Record<string, string>> = {
    agent: { contents: 'write', pull_requests: 'write', metadata: 'read', checks: 'read' },
    engine: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      administration: 'write',
      checks: 'read',
      actions: 'read',
      metadata: 'read',
    },
  };
  pulls = new Map<number, PullState>();
  issues = new Map<number, IssueState>();
  checkRuns: CheckRunState[] = [];
  statuses: { sha: string; context: string; state: string; updated_at: string }[] = [];
  workflowRuns = new Map<string, number>();
  refs = new Map<string, string>();
  /** compare main...<sha> 的 behind_by。 */
  behindBy = new Map<string, number>();
  interaction: { limit: string; origin: string; expires_at: string } | null = null;
  deliveries: { id: number; guid: string; delivered_at: string; status_code: number; event: string }[] = [];
  redelivered: number[] = [];
  tokensMinted = 0;
  /** 插一段：返回 Response 就不走正常处理（限流、5xx……）。 */
  before: Handler[] = [];
  /** 正常处理完后丢掉回执（模拟「写成了，但回执没收到」）：返回 true 就抛网络错。 */
  dropAfter: ((req: Recorded) => boolean)[] = [];
  /** 设了就把新建的 PR、评论、正文编辑记到这个人名下（模拟「作者不是机器人」）。 */
  authorOverride: GhUser | null = null;
  private nextNumber = 1;
  private nextId = 1000;
  private readonly tokens = new Map<string, { role: AppRole; expiresAt: number }>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  // —— 摆数据 ——

  addIssue(init: Partial<IssueState> & { title?: string } = {}): IssueState {
    const n = this.nextNumber++;
    const issue: IssueState = {
      number: n,
      title: init.title ?? `需求 ${n}`,
      body: init.body ?? null,
      state: init.state ?? 'open',
      state_reason: init.state_reason ?? null,
      user: init.user ?? this.human,
      created_at: init.created_at ?? this.iso(),
      updated_at: this.iso(),
      comments: init.comments ?? [],
      edits: init.edits ?? [],
    };
    this.issues.set(n, issue);
    return issue;
  }

  addPull(init: Partial<PullState> & { head: { ref: string; sha: string } }): PullState {
    const n = this.nextNumber++;
    const pr: PullState = {
      number: n,
      title: init.title ?? `PR ${n}`,
      body: init.body ?? '',
      state: init.state ?? 'open',
      draft: init.draft ?? false,
      merged: init.merged ?? false,
      merge_commit_sha: init.merge_commit_sha ?? null,
      mergeable: init.mergeable === undefined ? true : init.mergeable,
      mergeable_state: init.mergeable_state ?? 'clean',
      user: init.user ?? this.bots.agent,
      merged_by: init.merged_by ?? null,
      head: init.head,
      base: init.base ?? { ref: this.defaultBranch },
      updated_at: init.updated_at ?? this.iso(),
      merged_at: init.merged_at ?? null,
    };
    this.pulls.set(n, pr);
    this.refs.set(pr.head.ref, pr.head.sha);
    return pr;
  }

  addCheck(
    sha: string,
    name: string,
    conclusion: string | null,
    extra: Partial<CheckRunState> = {},
  ): CheckRunState {
    const run: CheckRunState = {
      id: this.nextId++,
      name,
      head_sha: sha,
      status: conclusion === null ? 'in_progress' : 'completed',
      conclusion,
      started_at: this.iso(),
      completed_at: conclusion === null ? null : this.iso(),
      output: { title: conclusion === 'failure' ? '2 个测试没过' : null, summary: null },
      ...extra,
    };
    this.checkRuns.push(run);
    return run;
  }

  /** 某个身份发的请求。 */
  by(as: string): Recorded[] {
    return this.requests.filter((r) => r.as === as);
  }

  calls(method: string, pathPattern: RegExp): Recorded[] {
    return this.requests.filter((r) => r.method === method && pathPattern.test(r.path));
  }

  // —— fetch ——

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init.headers);
    const method = (init.method ?? 'GET').toUpperCase();
    const text = typeof init.body === 'string' ? init.body : '';
    const req: Recorded = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body: text ? JSON.parse(text) : undefined,
      as: this.identify(headers.get('authorization')),
      headers,
    };
    this.requests.push(req);
    for (const h of this.before) {
      const res = await h(req);
      if (res) return res;
    }
    const res = await this.route(req);
    if (this.dropAfter.some((d) => d(req))) throw new TypeError('fetch failed（假服务：回执丢了）');
    return res;
  };

  private identify(auth: string | null): string {
    if (!auth) return 'anonymous';
    const token = auth.replace(/^(Bearer|token)\s+/i, '');
    const minted = this.tokens.get(token);
    if (minted) return minted.expiresAt > this.now().getTime() ? minted.role : 'expired';
    for (const role of ['agent', 'engine'] as const) {
      if (this.verifyJwt(token, role)) return `app:${role}`;
    }
    return 'invalid';
  }

  private verifyJwt(jwt: string, role: AppRole): boolean {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) return false;
    const pub = createPublicKey(this.apps[role].privateKey);
    if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'))) return false;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as {
      iat: number;
      exp: number;
      iss: string;
    };
    const nowS = Math.floor(this.now().getTime() / 1000);
    return (
      claims.iss === this.apps[role].clientId &&
      claims.iat <= nowS &&
      claims.exp > nowS &&
      claims.exp - claims.iat <= 600
    );
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
    return new Response(data === undefined ? null : JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', 'x-github-request-id': 'TEST:1', ...headers },
    });
  }

  private notFound(): Response {
    return this.json(404, { message: 'Not Found' });
  }

  private user(role: AppRole | string): GhUser {
    if (this.authorOverride) return this.authorOverride;
    return role === 'agent' || role === 'engine' ? this.bots[role] : this.human;
  }

  private pullJson(p: PullState) {
    const full = `${OWNER}/${REPO}`;
    return {
      number: p.number,
      node_id: `PR_${p.number}`,
      html_url: `https://github.test/${full}/pull/${p.number}`,
      state: p.state,
      title: p.title,
      body: p.body,
      draft: p.draft,
      merged: p.merged,
      merged_at: p.merged_at,
      merge_commit_sha: p.merge_commit_sha,
      mergeable: p.mergeable,
      mergeable_state: p.mergeable_state,
      user: p.user,
      merged_by: p.merged_by,
      head: { ref: p.head.ref, sha: p.head.sha, repo: { full_name: full } },
      base: { ref: p.base.ref, sha: 'b'.repeat(40), repo: { full_name: full } },
      updated_at: p.updated_at,
    };
  }

  private issueJson(i: IssueState) {
    return {
      number: i.number,
      node_id: `I_${i.number}`,
      html_url: `https://github.test/${OWNER}/${REPO}/issues/${i.number}`,
      state: i.state,
      state_reason: i.state_reason,
      title: i.title,
      body: i.body,
      user: i.user,
      created_at: i.created_at,
      updated_at: i.updated_at,
    };
  }

  private page<T>(req: Recorded, items: T[]): Response {
    const per = Number(req.query.get('per_page') ?? 30);
    const page = Number(req.query.get('page') ?? 1);
    const slice = items.slice((page - 1) * per, page * per);
    const headers: Record<string, string> = {};
    if (page * per < items.length) {
      const next = new URL(`${API}${req.path}`);
      for (const [k, v] of req.query) next.searchParams.set(k, v);
      next.searchParams.set('page', String(page + 1));
      headers.link = `<${next.href}>; rel="next"`;
    }
    return this.json(200, slice, headers);
  }

  private async route(req: Recorded): Promise<Response> {
    const { method: m, path } = req;
    const as = req.as;
    const isApp = as.startsWith('app:');
    const role = (isApp ? as.slice(4) : as) as AppRole;
    if (as === 'invalid' || as === 'expired') return this.json(401, { message: 'Bad credentials' });

    // —— App（JWT）——
    let x = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path);
    if (x && m === 'GET') {
      if (!isApp) return this.json(401, { message: 'A JSON web token could not be decoded' });
      if (x[1] !== OWNER || x[2] !== REPO || !this.installed[role]) return this.notFound();
      return this.json(200, { id: role === 'agent' ? 11 : 22 });
    }
    x = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (x && m === 'POST') {
      if (!isApp) return this.json(401, { message: 'A JSON web token could not be decoded' });
      if (Number(x[1]) !== (role === 'agent' ? 11 : 22)) return this.notFound();
      this.tokensMinted += 1;
      const token = `ghs_test${role}${this.tokensMinted}xxxxxxxxxxxxxxxx`;
      const expiresAt = this.now().getTime() + 60 * 60_000;
      this.tokens.set(token, { role, expiresAt });
      return this.json(201, {
        token,
        expires_at: new Date(expiresAt).toISOString(),
        permissions: this.permissions[role],
      });
    }
    x = /^\/app\/installations\/(\d+)$/.exec(path);
    if (x && m === 'GET') {
      if (!isApp) return this.json(401, { message: 'JWT required' });
      return this.json(200, { id: Number(x[1]), permissions: this.permissions[role] });
    }
    if (path === '/app/hook/deliveries' && m === 'GET') {
      if (!isApp) return this.json(401, { message: 'JWT required' });
      return this.page(req, this.deliveries);
    }
    x = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(path);
    if (x && m === 'POST') {
      if (!isApp) return this.json(401, { message: 'JWT required' });
      this.redelivered.push(Number(x[1]));
      return this.json(202, {});
    }
    if (isApp) return this.json(403, { message: 'JWT 只能调 /app 接口' });

    x = /^\/users\/([^/]+)$/.exec(path);
    if (x && m === 'GET') {
      const login = decodeURIComponent(x[1] ?? '');
      const bot = Object.values(this.bots).find((b) => b.login === login);
      return bot ? this.json(200, bot) : this.notFound();
    }
    if (path === '/graphql' && m === 'POST') return this.graphql(req, role);

    const repoPrefix = `/repos/${OWNER}/${REPO}`;
    if (!path.startsWith(repoPrefix)) return this.notFound();
    const rest = path.slice(repoPrefix.length);

    if (rest === '' && m === 'GET') {
      return this.json(200, {
        default_branch: this.defaultBranch,
        full_name: `${OWNER}/${REPO}`,
        private: false,
      });
    }
    x = /^\/rules\/branches\/(.+)$/.exec(rest);
    if (x && m === 'GET') {
      if (decodeURIComponent(x[1] ?? '') !== this.defaultBranch) return this.json(200, []);
      return this.json(200, [
        { type: 'deletion' },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: this.requiredChecks.map((context) => ({ context })),
          },
        },
      ]);
    }

    // —— PR ——
    if (rest === '/pulls' && m === 'GET') {
      let list = [...this.pulls.values()];
      const head = req.query.get('head');
      if (head) list = list.filter((p) => `${OWNER}:${p.head.ref}` === head);
      const state = req.query.get('state') ?? 'open';
      if (state !== 'all') list = list.filter((p) => p.state === state);
      if (req.query.get('sort') === 'updated') {
        list.sort(
          (a, b) =>
            (req.query.get('direction') === 'asc' ? 1 : -1) * a.updated_at.localeCompare(b.updated_at),
        );
      }
      return this.page(
        req,
        list.map((p) => {
          const {
            merged: _m,
            mergeable: _g,
            mergeable_state: _s,
            merged_by: _b,
            ...rest2
          } = this.pullJson(p);
          return rest2;
        }),
      );
    }
    if (rest === '/pulls' && m === 'POST') {
      const b = req.body as { title: string; head: string; base: string; body: string; draft?: boolean };
      if ([...this.pulls.values()].some((p) => p.head.ref === b.head && p.state === 'open')) {
        return this.json(422, {
          message: 'Validation Failed',
          errors: [
            {
              resource: 'PullRequest',
              code: 'custom',
              message: `A pull request already exists for ${OWNER}:${b.head}.`,
            },
          ],
        });
      }
      const sha = this.refs.get(b.head);
      if (!sha)
        return this.json(422, { message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid' }] });
      const pr = this.addPull({
        title: b.title,
        body: b.body,
        head: { ref: b.head, sha },
        base: { ref: b.base },
        draft: b.draft ?? false,
        user: this.user(role),
        mergeable: null,
        mergeable_state: 'unknown',
      });
      return this.json(201, this.pullJson(pr));
    }
    x = /^\/pulls\/(\d+)$/.exec(rest);
    if (x) {
      const pr = this.pulls.get(Number(x[1]));
      if (!pr) return this.notFound();
      if (m === 'GET') {
        const out = this.pullJson(pr);
        // GitHub 第一次单张读时后台才算 mergeable
        if (pr.mergeable === null && pr.state === 'open' && pr.mergeable_state === 'unknown') {
          pr.mergeable = true;
          pr.mergeable_state = 'clean';
        }
        return this.json(200, out);
      }
      if (m === 'PATCH') {
        const b = req.body as { title?: string; body?: string };
        if (b.title !== undefined) pr.title = b.title;
        if (b.body !== undefined) pr.body = b.body;
        pr.updated_at = this.iso();
        return this.json(200, this.pullJson(pr));
      }
    }
    x = /^\/pulls\/(\d+)\/merge$/.exec(rest);
    if (x && m === 'PUT') {
      const pr = this.pulls.get(Number(x[1]));
      if (!pr) return this.notFound();
      const b = req.body as { sha?: string; merge_method?: string };
      if (pr.merged || pr.state !== 'open')
        return this.json(405, { message: 'Pull Request is not mergeable' });
      if (b.sha && b.sha !== pr.head.sha) {
        return this.json(409, { message: 'Head branch was modified. Review and try the merge again.' });
      }
      if (pr.mergeable === false) return this.json(405, { message: 'Pull Request is not mergeable' });
      if (pr.draft) return this.json(405, { message: 'Pull Request is still a draft' });
      pr.merged = true;
      pr.state = 'closed';
      pr.merged_at = this.iso();
      pr.updated_at = this.iso();
      pr.merge_commit_sha = 'c'.repeat(40);
      pr.merged_by = this.user(role);
      return this.json(200, {
        sha: pr.merge_commit_sha,
        merged: true,
        message: 'Pull Request successfully merged',
      });
    }

    // —— CI ——
    x = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest);
    if (x && m === 'GET') {
      const runs = this.checkRuns.filter((r) => r.head_sha === x?.[1]);
      return this.json(200, {
        total_count: runs.length,
        check_runs: runs.map((r) => ({ ...r, html_url: `https://github.test/run/${r.id}` })),
      });
    }
    x = /^\/commits\/([0-9a-f]+)\/status$/.exec(rest);
    if (x && m === 'GET') {
      const statuses = this.statuses.filter((s) => s.sha === x?.[1]);
      return this.json(200, { state: 'pending', statuses });
    }
    if (rest === '/actions/runs' && m === 'GET') {
      return this.json(200, {
        total_count: this.workflowRuns.get(req.query.get('head_sha') ?? '') ?? 0,
        workflow_runs: [],
      });
    }
    x = /^\/compare\/(.+)\.\.\.([0-9a-f]+)$/.exec(rest);
    if (x && m === 'GET') {
      return this.json(200, { status: 'ahead', ahead_by: 1, behind_by: this.behindBy.get(x[2] ?? '') ?? 0 });
    }

    // —— 分支 ——
    x = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (x && m === 'GET') {
      const sha = this.refs.get(decodeURIComponent(x[1] ?? ''));
      return sha ? this.json(200, { ref: `refs/heads/${x[1]}`, object: { sha } }) : this.notFound();
    }
    x = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
    if (x && m === 'DELETE') {
      const name = decodeURIComponent(x[1] ?? '');
      if (!this.refs.delete(name)) return this.json(422, { message: 'Reference does not exist' });
      return new Response(null, { status: 204 });
    }

    // —— issue ——
    if (rest === '/issues' && m === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const since = req.query.get('since');
      const list = [...this.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .filter((i) => !since || i.updated_at >= since)
        .map((i) => this.issueJson(i));
      return this.page(req, list);
    }
    if (rest === '/issues/comments' && m === 'GET') {
      const since = req.query.get('since');
      const list = [...this.issues.values()].flatMap((i) =>
        i.comments
          .filter((c) => !since || c.updated_at >= since)
          .map((c) => ({
            id: c.id,
            html_url: `https://github.test/c/${c.id}`,
            body: c.body,
            user: c.user,
            created_at: c.created_at ?? c.updated_at,
            updated_at: c.updated_at,
            issue_url: `${API}/repos/${OWNER}/${REPO}/issues/${i.number}`,
          })),
      );
      return this.page(req, list);
    }
    x = /^\/issues\/(\d+)$/.exec(rest);
    if (x) {
      const issue = this.issues.get(Number(x[1]));
      if (!issue) return this.notFound();
      if (m === 'GET') return this.json(200, this.issueJson(issue));
      if (m === 'PATCH') {
        const b = req.body as { body?: string; state?: 'open' | 'closed'; state_reason?: string };
        if (b.body !== undefined && b.body !== issue.body) this.editBody(issue, b.body, this.user(role));
        if (b.state) issue.state = b.state;
        if (b.state_reason !== undefined) issue.state_reason = b.state_reason;
        issue.updated_at = this.iso();
        return this.json(200, this.issueJson(issue));
      }
    }
    x = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (x) {
      const issue = this.issues.get(Number(x[1]));
      if (!issue) return this.notFound();
      const view = (c: IssueState['comments'][number]) => ({
        id: c.id,
        html_url: `https://github.test/${OWNER}/${REPO}/issues/${issue.number}#issuecomment-${c.id}`,
        body: c.body,
        user: c.user,
        created_at: c.created_at ?? c.updated_at,
        updated_at: c.updated_at,
      });
      if (m === 'GET') return this.page(req, issue.comments.map(view));
      if (m === 'POST') {
        const c = {
          id: this.nextId++,
          body: (req.body as { body: string }).body,
          user: this.user(role),
          updated_at: this.iso(),
        };
        issue.comments.push(c);
        // 和真 GitHub 一样：新评论把 issue 的 updated_at 推到评论的时刻
        issue.updated_at = c.updated_at;
        return this.json(201, view(c));
      }
    }

    // —— 互动限制 ——
    if (rest === '/interaction-limits') {
      if (m === 'GET') return this.json(200, this.interaction ?? {});
      if (m === 'PUT') {
        const b = req.body as { limit: string; expiry?: string };
        const days = b.expiry === 'six_months' ? 182 : 1;
        this.interaction = {
          limit: b.limit,
          origin: 'repository',
          expires_at: new Date(this.now().getTime() + days * 86_400_000).toISOString(),
        };
        return this.json(200, this.interaction);
      }
    }
    return this.notFound();
  }

  /** 改正文并记编辑历史：第一次编辑时，GitHub 把原始正文也记成一条。 */
  editBody(issue: IssueState, body: string, editor: GhUser): void {
    if (issue.edits.length === 0) issue.edits.unshift({ diff: issue.body ?? '', editor: issue.user });
    issue.edits.unshift({ diff: body, editor });
    issue.body = body;
    issue.updated_at = this.iso();
  }

  private graphql(req: Recorded, role: AppRole): Response {
    const { query, variables } = req.body as { query: string; variables: Record<string, unknown> };
    if (query.includes('markPullRequestReadyForReview')) {
      const n = Number(String(variables.id).replace('PR_', ''));
      const pr = this.pulls.get(n);
      if (!pr) return this.json(200, { data: null, errors: [{ type: 'NOT_FOUND', message: 'not found' }] });
      pr.draft = false;
      return this.json(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    }
    if (query.includes('userContentEdits')) {
      const issue = this.issues.get(Number(variables.number));
      if (!issue) return this.json(200, { data: { repository: { issue: null } } });
      const nodes = issue.edits.slice(0, 10).map((e) => ({
        diff: e.diff,
        deletedAt: null,
        editor: {
          __typename: e.editor.type,
          login: e.editor.login.replace(/\[bot\]$/, ''),
          databaseId: e.editor.id,
        },
      }));
      return this.json(200, { data: { repository: { issue: { userContentEdits: { nodes } } } } });
    }
    return this.json(200, { data: null, errors: [{ message: `假服务不认识这个查询（${role}）` }] });
  }
}
