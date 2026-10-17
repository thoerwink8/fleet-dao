// 导入列表走安装令牌列出来的仓；OAuth 装仓那几条路由不再注册。
import type { InstallationListedRepo } from '@fleet-dao/github';
import { WEB_API_PREFIX, WebRoutes } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { mergedInstallations } from '../src/repo-import-routes.ts';
import { errorCode, harness, write } from './harness.ts';

const widget: InstallationListedRepo = {
  id: 4242,
  owner: 'acme',
  name: 'widgets',
  fullName: 'acme/widgets',
  private: false,
  defaultBranch: 'main',
  ownerType: 'Organization',
  archived: false,
  empty: false,
};

const notes: InstallationListedRepo = {
  id: 4243,
  owner: 'acme',
  name: 'notes',
  fullName: 'acme/notes',
  private: true,
  defaultBranch: 'main',
  ownerType: 'User',
  archived: false,
  empty: false,
};

function listed(rows: { agent: InstallationListedRepo[]; engine: InstallationListedRepo[] }) {
  return {
    async list(role: 'agent' | 'engine') {
      return role === 'agent' ? rows.agent : rows.engine;
    },
  };
}

describe('导入列表（安装令牌）', () => {
  it('没接上 GitHub：200，repos 空，reason 写明，不当成没有仓', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request(`${WEB_API_PREFIX}${WebRoutes.importableRepos.path}`, {
      headers: { cookie: s.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: unknown[]; reason?: string };
    expect(body.repos).toEqual([]);
    expect(body.reason).toContain('没接上 GitHub');
  });

  it('两个机器人的安装并成一行：一边有、两边都有，并标上在不在驾驶舱', async () => {
    const h = harness({
      installationRepos: listed({ agent: [widget, notes], engine: [widget] }),
    });
    const s = await h.login();
    const res = await h.cockpit.request(`${WEB_API_PREFIX}${WebRoutes.importableRepos.path}`, {
      headers: { cookie: s.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: {
        githubId: number;
        fullName: string;
        agentInstalled: boolean;
        engineInstalled: boolean;
        fullyInstalled: boolean;
        inCockpit: boolean;
      }[];
      reason?: string;
    };
    expect(body.reason).toBeUndefined();
    const byId = new Map(body.repos.map((r) => [r.githubId, r]));
    expect(byId.get(4242)).toMatchObject({
      fullName: 'acme/widgets',
      agentInstalled: true,
      engineInstalled: true,
      fullyInstalled: true,
    });
    expect(byId.get(4243)).toMatchObject({
      agentInstalled: true,
      engineInstalled: false,
      fullyInstalled: false,
      inCockpit: false,
    });
  });

  it('列仓失败：200，repos 空，reason 是原因，不把异常甩成 500', async () => {
    const h = harness({
      installationRepos: {
        async list() {
          throw new Error('GitHub 超时');
        },
      },
    });
    const s = await h.login();
    const res = await h.cockpit.request(`${WEB_API_PREFIX}${WebRoutes.importableRepos.path}`, {
      headers: { cookie: s.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repos: unknown[]; reason?: string };
    expect(body.repos).toEqual([]);
    expect(body.reason).toContain('GitHub 超时');
  });

  it('接进驾驶舱认安装列表里的仓号；不在列表里 404', async () => {
    const h = harness({
      installationRepos: listed({ agent: [notes], engine: [] }),
    });
    const s = await h.login();
    const missing = await h.cockpit.request(
      `${WEB_API_PREFIX}${WebRoutes.importRepo.path}`,
      write('POST', s, { githubId: 1 }),
    );
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('repo_not_visible');

    const created = await h.cockpit.request(
      `${WEB_API_PREFIX}${WebRoutes.importRepo.path}`,
      write('POST', s, { githubId: notes.id }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      created: boolean;
      owner: string;
      name: string;
      appsInstalled: boolean;
      agentInstalled: boolean;
      engineInstalled: boolean;
    };
    expect(body).toMatchObject({
      created: true,
      owner: 'acme',
      name: 'notes',
      appsInstalled: false,
      agentInstalled: true,
      engineInstalled: false,
    });
    expect(body).toHaveProperty('installLinks');
  });
});

describe('两个机器人的归并（导入列表和 fleet-api project installations 共用，#2977）', () => {
  it('按仓号并成一行：一边有、两边都有各一行，不重复', async () => {
    const rows = await mergedInstallations(listed({ agent: [widget, notes], engine: [widget] }));
    expect(rows.map((r) => [r.repo.id, r.agent, r.engine])).toEqual([
      [4242, true, true],
      [4243, true, false],
    ]);
    const engineOnly = await mergedInstallations(listed({ agent: [], engine: [notes] }));
    expect(engineOnly.map((r) => [r.repo.id, r.agent, r.engine])).toEqual([[4243, false, true]]);
  });

  it('一边失败整次失败：原样抛，不拿缺了一边的表冒充全的', async () => {
    const source = {
      async list(role: 'agent' | 'engine') {
        if (role === 'agent') throw new Error('agent HTTP 403');
        return [widget];
      },
    };
    await expect(mergedInstallations(source)).rejects.toThrow('agent HTTP 403');
  });
});

describe('OAuth 装仓路由已删', () => {
  it('契约里没有 beginOauth / continueInstall / installAppOnRepo 那几条', () => {
    for (const name of [
      'installAppOnRepo',
      'disconnectGitHub',
      'githubConnect',
      'githubCallback',
      'githubAuthorize',
      'githubSetup',
    ]) {
      expect(Object.keys(WebRoutes), name).not.toContain(name);
    }
  });

  it('登录后去请求：404', async () => {
    const h = harness();
    const s = await h.login();
    const gone = [
      { method: 'POST' as const, path: `${WEB_API_PREFIX}/repos/install` },
      { method: 'POST' as const, path: `${WEB_API_PREFIX}/github/oauth/disconnect` },
      { method: 'GET' as const, path: `${WEB_API_PREFIX}/github/connect` },
      { method: 'GET' as const, path: `${WEB_API_PREFIX}/github/callback` },
      { method: 'GET' as const, path: `${WEB_API_PREFIX}/github/authorize` },
      { method: 'GET' as const, path: `${WEB_API_PREFIX}/github/setup` },
    ];
    for (const item of gone) {
      const res = await h.cockpit.request(
        item.path,
        item.method === 'GET' ? { headers: { cookie: s.cookie } } : write(item.method, s, { githubId: 1 }),
      );
      expect(res.status, `${item.method} ${item.path}`).toBe(404);
    }
  });
});
