// 两个 App 各自装到了哪些仓。用 App JWT 列安装；勾选了部分仓的，再用安装令牌列仓。
// 读失败整列认不出，不把「没查成」标成「没装」。

import type { GitHubClient } from './client.ts';
import type { AppRole } from './credentials.ts';
import { GitHubError, registerSecret } from './errors.ts';
import { parseInstallationList } from './user-oauth.ts';

export interface AppCoverage {
  ok: true;
  /** 小写的属主登录名：这个 App 在该账号上装了全部仓。 */
  allOwners: string[];
  /** 小写的 owner/name：只装了选中的仓。 */
  repos: string[];
}

export interface AppCoveragePort {
  coverage(role: AppRole): Promise<AppCoverage | { ok: false; reason: string }>;
}

const PAGE_CAP = 10;

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match?.[1] && match[2]?.split(/\s+/).includes('next')) return match[1];
  }
  return null;
}

export function createAppCoverage(options: {
  client: Pick<GitHubClient, 'all' | 'request'>;
  fetch?: typeof fetch;
  apiUrl?: string;
}): AppCoveragePort {
  const fetchImpl = options.fetch ?? fetch;
  const apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');

  async function selectedRepos(token: string): Promise<string[] | { ok: false; reason: string }> {
    registerSecret(token);
    const repos: string[] = [];
    let url = `${apiUrl}/installation/repositories?per_page=100`;
    for (let page = 1; page <= PAGE_CAP; page += 1) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'fleet-dao',
            authorization: `Bearer ${token}`,
          },
        });
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : '列安装里的仓失败' };
      }
      const text = await response.text();
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, reason: `列安装里的仓失败（${response.status}）` };
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, reason: '安装里的仓列表认不出' };
      }
      const list =
        typeof data === 'object' &&
        data !== null &&
        'repositories' in data &&
        Array.isArray(data.repositories)
          ? data.repositories
          : undefined;
      if (!list) return { ok: false, reason: '安装里的仓列表认不出' };
      for (const item of list) {
        if (
          typeof item === 'object' &&
          item !== null &&
          'full_name' in item &&
          typeof item.full_name === 'string' &&
          item.full_name.includes('/')
        ) {
          repos.push(item.full_name.toLowerCase());
        }
      }
      const next = nextLink(response.headers.get('link'));
      if (!next) return repos;
      if (page === PAGE_CAP) return { ok: false, reason: '安装的仓太多，这次没列全' };
      url = next;
    }
    return { ok: false, reason: '安装的仓太多，这次没列全' };
  }

  return {
    async coverage(role) {
      try {
        const items = await options.client.all(
          { method: 'GET', path: '/app/installations', auth: { as: 'app', role } },
          (data) => data,
        );
        const parsed = parseInstallationList(items);
        if (!parsed.ok) return parsed;
        const allOwners: string[] = [];
        const repos: string[] = [];
        for (const installation of parsed.installations) {
          if (installation.repositorySelection === 'all') {
            allOwners.push(installation.accountLogin.toLowerCase());
            continue;
          }
          const minted = await options.client.request<{ token?: unknown }>({
            method: 'POST',
            path: `/app/installations/${installation.id}/access_tokens`,
            auth: { as: 'app', role },
            idempotent: true,
          });
          const token = minted.data.token;
          if (typeof token !== 'string' || token === '') return { ok: false, reason: '换不到安装令牌' };
          const selected = await selectedRepos(token);
          if (!Array.isArray(selected)) return selected;
          repos.push(...selected);
        }
        return { ok: true, allOwners, repos };
      } catch (err) {
        const reason =
          err instanceof GitHubError ? err.message : err instanceof Error ? err.message : '安装情况没查成';
        return { ok: false, reason };
      }
    },
  };
}
