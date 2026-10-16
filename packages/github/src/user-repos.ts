// 用户身份那一套（#1989）：换 OAuth 用户令牌、列「我 GitHub 上能看到的仓」、把 App 安装加仓/减仓。
//
// 为什么必须走用户令牌（官方文档 + 实测）：列「某个 App 安装能看到哪些仓」（GET /user/installations/{id}/repositories）
// 和「把一个仓加进/移出某个安装」（PUT/DELETE /user/installations/{id}/repositories/{repo}，一次一个仓、没有请求体）这三条，GitHub 只认**本人的** OAuth 用户令牌；
// App 机器人令牌调不了（403）。所以这一层不能用 client.ts 那套 App JWT / 安装令牌。
//
// 三条路都过 client.request，只把 auth 换成 { as: 'user', token }：
// - 限流退避、写请求串行、错误分类照旧，不在这一层重写一遍。
// - token 只在这里过一下，不进日志（redact 按模式打码 ghp_ / gho_ / github_pat_ 这些前缀）。
import type { GhResponse, GitHubClient, Logger } from './client.ts';
import { GitHubError, redact } from './errors.ts';
import { testCommandFromRepo } from './test-command.ts';

/** 换用户令牌的两个端点（GitHub 的 OAuth 网页流）。 */
export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** 一个仓（用户视角）。GitHub 回的仓对象里我们只用这几项。 */
export interface UserRepo {
  /** GitHub 的数字编号（加/减安装要它）。 */
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  /** 默认分支；网络不通或仓是空的时 GitHub 可能不给，退回 'main'。 */
  defaultBranch: string;
  /** 主人账号的数字编号。装 App 的安装页要用它当 target_id；GitHub 没给时是 0。 */
  ownerId: number;
  /** 主人是个人还是组织。组织仓要用 App 得组织先批准，页面上分开显示。 */
  ownerType: 'User' | 'Organization';
  /** 主人是组织时，本人对它的权限（admin = 能改安装；不是就是只读/写入者）。 */
  viewerCanAdmin: boolean;
  archived: boolean;
  /** 是不是空仓（GitHub 的 size=0）：空仓不接进来（没代码可派活）。 */
  empty: boolean;
}

interface RawRepo {
  id?: unknown;
  name?: unknown;
  full_name?: unknown;
  private?: unknown;
  default_branch?: unknown;
  archived?: unknown;
  size?: unknown;
  owner?: { login?: unknown; type?: unknown; id?: unknown } | null;
  permissions?: { admin?: unknown } | null;
}

function toUserRepo(r: RawRepo): UserRepo | null {
  const owner = r.owner?.login;
  const name = r.name;
  const fullName = r.full_name;
  if (typeof owner !== 'string' || typeof name !== 'string' || typeof r.id !== 'number') return null;
  const ownerType = r.owner?.type === 'Organization' ? 'Organization' : 'User';
  return {
    id: r.id,
    owner,
    name,
    fullName: typeof fullName === 'string' ? fullName : `${owner}/${name}`,
    private: r.private === true,
    // 空仓 GitHub 不给 default_branch：退回 main（接进来时按它写 default_branch，之后对账能改）
    defaultBranch: typeof r.default_branch === 'string' && r.default_branch ? r.default_branch : 'main',
    ownerId: typeof r.owner?.id === 'number' && r.owner.id > 0 ? r.owner.id : 0,
    ownerType,
    viewerCanAdmin: r.permissions?.admin === true,
    archived: r.archived === true,
    // size 单位 KB；0 当空仓（GitHub 对空仓 size 就是 0，且没有 default_branch）
    empty: r.size === 0,
  };
}

export type GitHubAppRole = 'agent' | 'engine';

/** 一份安装：all 表示这个账号下的仓都已经在里面，不能再 PUT 单个仓。 */
export interface UserAppInstallation {
  id: number;
  selection: 'all' | 'selected';
}

/** 本人身份接口的这一口。 */
export interface GitHubUserApi {
  /** OAuth 授权页要的 client_id（「干活的」那个 App 的）。没配好时是空串。 */
  readonly clientId: string;
  /** 某一边 App 的 client_id。没配好时是空串。 */
  clientIdFor(role: GitHubAppRole): string;
  /** 某一边 App 的 slug（安装页地址用它）。 */
  slugFor(role: GitHubAppRole): string;
  /** 两个 App 是不是都配好了 client_id/client_secret（缺了时「连接 GitHub」要如实回 503）。 */
  configured(): boolean;
  /**
   * 授权码换用户令牌。code 是哪个 App 的授权页发的，就必须用那个 App 的 client_secret 换。
   * 不传 role 时用「干活的」那个（连接 GitHub、只列仓）。
   */
  exchangeCode(input: { code: string; redirectUri: string; role?: GitHubAppRole }): Promise<{
    token: string;
    scopes: string;
    expiresAt: string | null;
  }>;
  /** 这个令牌是谁的、还在不在（失效 401 时调用方据此删掉库里那份）。 */
  viewer(token: string): Promise<{ id: number; login: string }>;
  /**
   * 这个 App 装到本人账号/组织下、本人看得见的安装。
   * key 是 owner（小写）。令牌只能看见签发它的那个 App，所以 role 和 token 必须是同一边。
   */
  installationsForApp(role: GitHubAppRole, token: string): Promise<Map<string, UserAppInstallation>>;
  /** 从默认分支上的 package.json / Makefile 推出测试命令。认不出就抛错，不编一条。 */
  readTestCommand(
    token: string,
    repo: { owner: string; name: string; defaultBranch: string },
  ): Promise<string>;
  /** 这个安装现在能访问的仓的编号集合。 */
  installationRepoIds(token: string, installationId: number): Promise<Set<number>>;
  /** 把一批仓加进这个安装（App 就此多出这些仓的权限）。 */
  addReposToInstallation(token: string, installationId: number, repoIds: readonly number[]): Promise<void>;
  /** 把一批仓从这个安装里去掉（App 就此失去这些仓的权限）；本来就不在里面 GitHub 也回 204。 */
  removeReposFromInstallation(
    token: string,
    installationId: number,
    repoIds: readonly number[],
  ): Promise<void>;
  /** 本人能看到的全部仓（含组织仓，按本人权限过滤）；分页翻到底。 */
  listRepos(token: string): Promise<UserRepo[]>;
}

export function createGitHubUserApi(
  client: GitHubClient,
  options: {
    appCredentials: {
      agent: { clientId?: string | undefined; clientSecret?: string | undefined; slug: string };
      engine: { clientId?: string | undefined; clientSecret?: string | undefined; slug: string };
    };
    log?: Logger;
  },
): GitHubUserApi {
  const log = options.log;

  const oauthFor = (role: 'agent' | 'engine') => {
    const creds = options.appCredentials[role];
    if (!creds.clientId || !creds.clientSecret) {
      throw new GitHubError(
        'BAD_CONFIG',
        `这台机器上「${role === 'agent' ? '干活的' : '引擎'}」App 的凭据里没有 client_id/client_secret：一键授权要它，请把建 App 时 GitHub 回的那份凭据原样放上`,
      );
    }
    return { clientId: creds.clientId, clientSecret: creds.clientSecret };
  };

  return {
    // 授权页用「干活的」那个 App 的 client_id：装 App 那一步两个 App 都装，但发起授权只用得着一个。
    get clientId() {
      return options.appCredentials.agent.clientId ?? '';
    },
    clientIdFor(role) {
      return options.appCredentials[role].clientId ?? '';
    },
    slugFor(role) {
      return options.appCredentials[role].slug;
    },
    configured() {
      return Boolean(
        options.appCredentials.agent.clientId &&
          options.appCredentials.agent.clientSecret &&
          options.appCredentials.engine.clientId &&
          options.appCredentials.engine.clientSecret,
      );
    },
    async exchangeCode({ code, redirectUri, role = 'agent' }) {
      // code 跟发起授权的那个 App 绑在一起，必须用同一边的 client_secret 换。
      const { clientId, clientSecret } = oauthFor(role);
      const res = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      let body: {
        access_token?: unknown;
        scope?: unknown;
        token_type?: unknown;
        expires_in?: unknown;
        error?: unknown;
        error_description?: unknown;
      };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        throw new GitHubError(
          'GITHUB_UNAVAILABLE',
          `GitHub 的换令牌接口返回的不是 JSON（HTTP ${res.status}）`,
        );
      }
      if (typeof body.access_token !== 'string' || !body.access_token) {
        const why =
          typeof body.error_description === 'string'
            ? body.error_description
            : String(body.error ?? res.status);
        // 用户点了取消、或 code 过期（一次性、几分钟）：让页面提示重新授权，不重试。
        throw new GitHubError('FORBIDDEN', `GitHub 没给用户令牌：${redact(why)}`, { status: res.status });
      }
      const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null;
      return {
        token: body.access_token,
        scopes: typeof body.scope === 'string' ? body.scope : '',
        expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
    },

    async viewer(token) {
      const res: GhResponse<{ id?: unknown; login?: unknown }> = await client.request({
        method: 'GET',
        path: '/user',
        auth: { as: 'user', token },
      });
      const { id, login } = res.data;
      if (typeof id !== 'number' || typeof login !== 'string') {
        throw new GitHubError('GITHUB_UNAVAILABLE', 'GitHub 的 /user 返回的形状看不懂');
      }
      return { id, login };
    },

    async installationsForApp(role, token) {
      // GET /user/installations 只列「签发这份令牌的那个 App」装在本人能访问的账号上的安装。
      // 所以引擎那边必须用引擎的令牌来问，不能拿干活的那份顶。按 slug 再滤一次，别的 App 不认。
      const wantSlug = options.appCredentials[role].slug;
      const out = new Map<string, UserAppInstallation>();
      for await (const page of client.pages<{ installations?: unknown }>({
        method: 'GET',
        path: '/user/installations',
        auth: { as: 'user', token },
        query: { per_page: 100 },
      })) {
        const list = (page.data as { installations?: unknown }).installations;
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const inst = item as {
            id?: unknown;
            app_slug?: unknown;
            repository_selection?: unknown;
            account?: { login?: unknown } | null;
          };
          const account = inst.account?.login;
          if (typeof inst.id !== 'number' || typeof account !== 'string') continue;
          if (inst.app_slug !== wantSlug) continue;
          out.set(account.toLowerCase(), {
            id: inst.id,
            selection: inst.repository_selection === 'all' ? 'all' : 'selected',
          });
        }
      }
      return out;
    },

    async readTestCommand(token, repo) {
      if (!repo.defaultBranch) {
        throw new GitHubError('BAD_INPUT', '这个仓没有默认分支，读不出测试命令');
      }
      const root = await client.request<unknown>({
        method: 'GET',
        path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/`,
        auth: { as: 'user', token },
        query: { ref: repo.defaultBranch },
      });
      if (!Array.isArray(root.data)) throw new GitHubError('BAD_INPUT', '仓根目录认不出');
      const names = root.data.flatMap((item) => {
        if (typeof item !== 'object' || item === null || !('name' in item)) return [];
        return typeof item.name === 'string' ? [item.name] : [];
      });
      const readFile = async (name: string): Promise<string> => {
        const file = await client.request<{ content?: unknown; encoding?: unknown }>({
          method: 'GET',
          path: `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${encodeURIComponent(name)}`,
          auth: { as: 'user', token },
          query: { ref: repo.defaultBranch },
        });
        const content = file.data.content;
        if (typeof content !== 'string' || file.data.encoding !== 'base64') {
          throw new GitHubError('BAD_INPUT', `读不到 ${name}`);
        }
        return Buffer.from(content, 'base64').toString('utf8');
      };
      const packageJson = names.includes('package.json') ? await readFile('package.json') : null;
      const makefile = packageJson === null && names.includes('Makefile') ? await readFile('Makefile') : null;
      const derived = testCommandFromRepo({ packageJson, names, makefile });
      if (!derived.ok) throw new GitHubError('BAD_INPUT', derived.reason);
      return derived.command;
    },

    async installationRepoIds(token, installationId) {
      const ids = new Set<number>();
      for await (const page of client.pages<{ repositories?: unknown }>({
        method: 'GET',
        path: `/user/installations/${installationId}/repositories`,
        auth: { as: 'user', token },
        query: { per_page: 100 },
      })) {
        const list = (page.data as { repositories?: unknown }).repositories;
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const repo = item as { id?: unknown };
          if (typeof repo.id === 'number') ids.add(repo.id);
        }
      }
      return ids;
    },

    async addReposToInstallation(token, installationId, repoIds) {
      // GitHub 只有单仓接口 PUT /user/installations/{id}/repositories/{repo}，没有请求体（#2749：原来不带仓号、带一串仓号，从没成过）
      for (const id of repoIds) {
        await client.request({
          method: 'PUT',
          path: `/user/installations/${installationId}/repositories/${id}`,
          auth: { as: 'user', token },
          // 已经被加进去过：GitHub 回的 204 和首次一样，不另判
          idempotent: true,
        });
      }
      if (repoIds.length === 0) return;
      log?.info('把仓加进 App 安装', { installationId, count: repoIds.length });
    },

    async removeReposFromInstallation(token, installationId, repoIds) {
      for (const id of repoIds) {
        await client.request({
          method: 'DELETE',
          path: `/user/installations/${installationId}/repositories/${id}`,
          auth: { as: 'user', token },
          idempotent: true,
        });
      }
      if (repoIds.length === 0) return;
      log?.info('把仓移出 App 安装', { installationId, count: repoIds.length });
    },

    async listRepos(token) {
      // GET /user/repos 是「本人能看到的全部」：自己的个人仓 + 本人是成员的组织的仓（按本人权限给）。
      // affiliation 三种都要（owner/collaborator/organization_member）：组织仓多半是 organization_member 那一类，
      // 只写 owner 会看不到 —— 而创始人要的就是「我 GitHub 所有的仓」。
      const out: UserRepo[] = [];
      const seen = new Set<number>();
      for await (const page of client.pages<unknown>({
        method: 'GET',
        path: '/user/repos',
        auth: { as: 'user', token },
        query: { per_page: 100, affiliation: 'owner,collaborator,organization_member', sort: 'full_name' },
      })) {
        const list = Array.isArray(page.data) ? page.data : [];
        for (const item of list) {
          const repo = toUserRepo(item as RawRepo);
          if (!repo || seen.has(repo.id)) continue;
          seen.add(repo.id);
          out.push(repo);
        }
      }
      return out;
    },
  };
}
