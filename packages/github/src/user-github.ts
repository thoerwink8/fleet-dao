// 用登录人自己的 GitHub 用户令牌列仓、读测试命令、把两个 App 装到已有安装上。
// 不走 GitHubClient 的安装令牌队列：用户令牌和 App 安装令牌不是一条路。
import type { AppOAuth, AppRole } from './credentials.ts';
import { GitHubError, registerSecret } from './errors.ts';
import {
  authorizeUrl,
  installPlan,
  type ListedGithubRepo,
  newInstallationUrl,
  parseAccessToken,
  parseInstallationList,
  parseRepoPage,
  testCommandFromRepo,
  type UserInstallation,
} from './user-oauth.ts';

export type { ListedGithubRepo, UserInstallation };

export interface OauthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface GithubUserPort {
  listRepos(accessToken: string): Promise<{ repos: ListedGithubRepo[]; truncated: boolean }>;
  readTestCommand(
    accessToken: string,
    repo: { owner: string; name: string; defaultBranch: string },
  ): Promise<string>;
  installations(accessToken: string): Promise<UserInstallation[]>;
  addRepository(accessToken: string, installationId: number, repositoryId: number): Promise<void>;
  exchange(input: {
    role: AppRole;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<OauthToken>;
  refresh(input: { role: AppRole; refreshToken: string }): Promise<OauthToken>;
  login(accessToken: string): Promise<string>;
  authorizeUrl(input: { role: AppRole; redirectUri: string; state: string; codeChallenge: string }): string;
  installUrl(input: { role: AppRole; targetId: number; repositoryId: number; state: string }): string;
  /** 这个 App 还没装到任何账号：去 GitHub 让人选账号和仓。 */
  accountInstallUrl(input: { role: AppRole; state: string }): string;
}

const PAGE_CAP = 10;
const API_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'fleet-dao',
};

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match?.[1] && match[2]?.split(/\s+/).includes('next')) return match[1];
  }
  return null;
}

function messageOf(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'message' in data && typeof data.message === 'string') {
    return data.message;
  }
  return '';
}

export function createGithubUserClient(options: {
  oauth: Record<AppRole, AppOAuth>;
  fetch?: typeof fetch;
  apiUrl?: string;
  now?: () => Date;
}): GithubUserPort {
  const fetchImpl = options.fetch ?? fetch;
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const now = options.now ?? (() => new Date());
  for (const app of Object.values(options.oauth)) registerSecret(app.clientSecret);

  async function send(
    token: string,
    url: string,
    init: { method: string; accept?: string; body?: unknown },
  ): Promise<{ status: number; data: unknown; text: string; headers: Headers }> {
    registerSecret(token);
    const headers: Record<string, string> = {
      ...API_HEADERS,
      authorization: `Bearer ${token}`,
      ...(init.accept ? { accept: init.accept } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (err) {
      throw new GitHubError(
        'NETWORK',
        `连不上 GitHub（${err instanceof Error ? err.message : '未知错误'}）`,
        {
          retryable: true,
        },
      );
    }
    const text = await response.text();
    let data: unknown = text;
    if (text !== '' && !(init.accept ?? '').includes('raw')) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, data, text, headers: response.headers };
  }

  async function pages(token: string, path: string): Promise<{ pages: unknown[]; truncated: boolean }> {
    const pagesOut: unknown[] = [];
    let url = `${apiUrl}${path}`;
    for (let page = 1; page <= PAGE_CAP; page += 1) {
      const res = await send(token, url, { method: 'GET' });
      if (res.status === 401) {
        throw new GitHubError('AUTH_FAILED', 'GitHub 不认这个用户令牌', { status: 401 });
      }
      if (res.status < 200 || res.status >= 300) {
        throw new GitHubError('GITHUB', messageOf(res.data) || `GitHub 回了 ${res.status}`, {
          status: res.status,
        });
      }
      pagesOut.push(res.data);
      const next = nextLink(res.headers.get('link'));
      if (!next) return { pages: pagesOut, truncated: false };
      if (page === PAGE_CAP) return { pages: pagesOut, truncated: true };
      url = next;
    }
    return { pages: pagesOut, truncated: true };
  }

  function tokenOf(parsed: ReturnType<typeof parseAccessToken>, secret: string): OauthToken {
    if (!parsed.ok) {
      throw new GitHubError('AUTH_FAILED', parsed.reason.split(secret).join('…'));
    }
    registerSecret(parsed.accessToken);
    if (parsed.refreshToken) registerSecret(parsed.refreshToken);
    const expiresAt =
      parsed.expiresIn === undefined
        ? undefined
        : new Date(now().getTime() + parsed.expiresIn * 1000).toISOString();
    return {
      accessToken: parsed.accessToken,
      ...(parsed.refreshToken === undefined ? {} : { refreshToken: parsed.refreshToken }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }

  async function postToken(role: AppRole, body: Record<string, string>): Promise<OauthToken> {
    const app = options.oauth[role];
    let response: Response;
    try {
      response = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, ...body }),
      });
    } catch (err) {
      throw new GitHubError(
        'NETWORK',
        `连不上 GitHub（${err instanceof Error ? err.message : '未知错误'}）`,
        {
          retryable: true,
        },
      );
    }
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new GitHubError('AUTH_FAILED', 'GitHub 的令牌回应不是 JSON');
    }
    return tokenOf(parseAccessToken(data), app.clientSecret);
  }

  return {
    async listRepos(accessToken) {
      const { pages: got, truncated } = await pages(
        accessToken,
        '/user/repos?affiliation=owner,organization_member,collaborator&per_page=100',
      );
      const repos: ListedGithubRepo[] = [];
      for (const page of got) {
        const parsed = parseRepoPage(page);
        if (!parsed.ok) throw new GitHubError('GITHUB', parsed.reason);
        repos.push(...parsed.repos);
      }
      return { repos, truncated };
    },
    async readTestCommand(accessToken, repo) {
      if (repo.defaultBranch === '') throw new GitHubError('BAD_INPUT', '这个仓没有默认分支');
      const root = await send(
        accessToken,
        `${apiUrl}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/?ref=${encodeURIComponent(repo.defaultBranch)}`,
        { method: 'GET' },
      );
      if (root.status === 401)
        throw new GitHubError('AUTH_FAILED', 'GitHub 不认这个用户令牌', { status: 401 });
      if (root.status === 403 || root.status === 404) {
        throw new GitHubError('CONTENTS', '读不到这个仓的文件（没有 Contents 权限，或默认分支上是空的）', {
          status: root.status,
        });
      }
      if (!Array.isArray(root.data)) throw new GitHubError('GITHUB', '仓根目录认不出');
      const names = root.data.flatMap((item) =>
        typeof item === 'object' && item !== null && 'name' in item && typeof item.name === 'string'
          ? [item.name]
          : [],
      );
      const readRaw = async (name: string): Promise<string> => {
        const file = await send(
          accessToken,
          `${apiUrl}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${name}?ref=${encodeURIComponent(repo.defaultBranch)}`,
          { method: 'GET', accept: 'application/vnd.github.raw' },
        );
        if (file.status === 403 || file.status === 404) {
          throw new GitHubError('CONTENTS', `读不到 ${name}（没有 Contents 权限，或文件不在默认分支上）`, {
            status: file.status,
          });
        }
        if (file.status < 200 || file.status >= 300) {
          throw new GitHubError('GITHUB', messageOf(file.data) || `读 ${name} 失败`, { status: file.status });
        }
        return file.text;
      };
      const packageJson = names.includes('package.json') ? await readRaw('package.json') : null;
      const makefile = packageJson === null && names.includes('Makefile') ? await readRaw('Makefile') : null;
      const derived = testCommandFromRepo({ packageJson, names, makefile });
      if (!derived.ok) throw new GitHubError('BAD_INPUT', derived.reason);
      return derived.command;
    },
    async installations(accessToken) {
      const { pages: got } = await pages(accessToken, '/user/installations?per_page=100');
      const installations: UserInstallation[] = [];
      for (const page of got) {
        const parsed = parseInstallationList(page);
        if (!parsed.ok) throw new GitHubError('GITHUB', parsed.reason);
        installations.push(...parsed.installations);
      }
      return installations;
    },
    async addRepository(accessToken, installationId, repositoryId) {
      const res = await send(
        accessToken,
        `${apiUrl}/user/installations/${installationId}/repositories/${repositoryId}`,
        { method: 'PUT' },
      );
      if (res.status === 204 || res.status === 201) return;
      const message = messageOf(res.data);
      if (res.status === 422 && /already/i.test(message)) return;
      if (res.status === 401)
        throw new GitHubError('AUTH_FAILED', 'GitHub 不认这个用户令牌', { status: 401 });
      throw new GitHubError('INSTALL', message || `把仓加进安装失败（${res.status}）`, {
        status: res.status,
      });
    },
    exchange(input) {
      return postToken(input.role, {
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      });
    },
    refresh(input) {
      return postToken(input.role, { grant_type: 'refresh_token', refresh_token: input.refreshToken });
    },
    async login(accessToken) {
      const res = await send(accessToken, `${apiUrl}/user`, { method: 'GET' });
      if (res.status === 401)
        throw new GitHubError('AUTH_FAILED', 'GitHub 不认这个用户令牌', { status: 401 });
      if (
        res.status < 200 ||
        res.status >= 300 ||
        typeof res.data !== 'object' ||
        res.data === null ||
        !('login' in res.data) ||
        typeof res.data.login !== 'string' ||
        res.data.login === ''
      ) {
        throw new GitHubError('GITHUB', '读不到 GitHub 登录名', { status: res.status });
      }
      return res.data.login;
    },
    authorizeUrl(input) {
      return authorizeUrl({
        clientId: options.oauth[input.role].clientId,
        redirectUri: input.redirectUri,
        state: input.state,
        codeChallenge: input.codeChallenge,
      });
    },
    installUrl(input) {
      const plan = installPlan({
        slug: options.oauth[input.role].slug,
        repo: { id: input.repositoryId, accountId: input.targetId, owner: '' },
        installations: [],
        state: input.state,
      });
      if (plan.kind !== 'browser') throw new GitHubError('INSTALL', '安装页地址没拼出来');
      return plan.url;
    },
    accountInstallUrl(input) {
      return newInstallationUrl({ slug: options.oauth[input.role].slug, state: input.state });
    },
  };
}
