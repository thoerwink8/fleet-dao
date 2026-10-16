// 列一个机器人已经装上的仓：安装令牌读 GET /installation/repositories。
//
// 不走用户 OAuth。步骤：App JWT 列安装（GET /app/installations）→ 每个安装换一枚不限定单个仓的访问令牌
// → 用这枚令牌读 /installation/repositories。限定到一个仓的令牌只能看见那一个仓，列不全。

import type { GitHubClient } from './client.ts';
import type { AppRole } from './credentials.ts';

/** 安装能访问的一个仓。页面和导入用这几项。 */
export interface InstallationListedRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  ownerType: 'User' | 'Organization';
  archived: boolean;
  /** size 为 0：空仓，没有代码可派。 */
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
  owner?: { login?: unknown; type?: unknown } | null;
}

function toListed(raw: unknown): InstallationListedRepo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as RawRepo;
  const owner = r.owner?.login;
  const name = r.name;
  if (typeof owner !== 'string' || typeof name !== 'string' || typeof r.id !== 'number') return null;
  const fullName = typeof r.full_name === 'string' ? r.full_name : `${owner}/${name}`;
  return {
    id: r.id,
    owner,
    name,
    fullName,
    private: r.private === true,
    defaultBranch: typeof r.default_branch === 'string' && r.default_branch ? r.default_branch : 'main',
    ownerType: r.owner?.type === 'Organization' ? 'Organization' : 'User',
    archived: r.archived === true,
    empty: r.size === 0,
  };
}

function repositoriesOf(data: unknown): unknown {
  if (typeof data === 'object' && data !== null && 'repositories' in data) {
    return (data as { repositories: unknown }).repositories;
  }
  return data;
}

/**
 * 这个机器人每个安装能访问的仓，按 GitHub 仓号去重。
 * 一个安装都没有就回空数组（不是失败）。换令牌或列仓失败原样抛，调用方别当成「没有仓」。
 */
export async function listInstallationRepositories(
  client: GitHubClient,
  role: AppRole,
  signal?: AbortSignal,
): Promise<InstallationListedRepo[]> {
  const installations = await client.all<{ id?: unknown }>({
    method: 'GET',
    path: '/app/installations',
    auth: { as: 'app', role },
    query: { per_page: 100 },
    signal,
  });
  const out: InstallationListedRepo[] = [];
  const seen = new Set<number>();
  for (const inst of installations) {
    if (typeof inst.id !== 'number') continue;
    const minted = await client.accessTokenForInstallation(role, inst.id, signal);
    const repos = await client.all(
      {
        method: 'GET',
        path: '/installation/repositories',
        auth: { as: 'bearer', token: minted.token },
        query: { per_page: 100 },
        signal,
      },
      repositoriesOf,
    );
    for (const raw of repos) {
      const repo = toListed(raw);
      if (!repo || seen.has(repo.id)) continue;
      seen.add(repo.id);
      out.push(repo);
    }
  }
  return out;
}
