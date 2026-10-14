// 设置页「导入仓库」（#1989）：连上 GitHub 后列本人的仓、接进/移出驾驶舱、把 App 装到某个仓、断开。
// 身份那一套（列仓、装 App）用假替身，不联网；接进/移出只动我们的 repos 表。
// 故意造出的失败：没连 GitHub、仓不存在、组织仓没权限、还挂着单不能移出、没登录 401。
import {
  GITHUB_INSTALL_REPO,
  GITHUB_OAUTH_CONNECT,
  GITHUB_OAUTH_DISCONNECT,
  ImportableReposResponse,
  ImportRepoResponse,
  InstallAppResponse,
  REPO_IMPORT_ADD,
  RemoveRepoResponse,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { encryptToken } from '../src/github-token.ts';
import type { GitHubUserPort } from '../src/github-user.ts';
import { DEV_USER_ID, errorCode, harness, viaBearer, write } from './harness.ts';

const LIST = '/api/repos/importable';
const IMPORT = '/api/repos/import';
const INSTALL = '/api/repos/install';

/** 一份不联网的假 GitHub：两个个人仓，一个装了 App 一个没装；一个组织仓本人没 admin。 */
function fakeGitHub(overrides: Partial<GitHubUserPort> = {}): GitHubUserPort {
  const repos = [
    {
      id: 101,
      owner: 'me',
      name: 'widgets',
      fullName: 'me/widgets',
      private: false,
      defaultBranch: 'main',
      ownerType: 'User' as const,
      viewerCanAdmin: true,
      archived: false,
      empty: false,
      ownerId: 5,
    },
    {
      id: 102,
      owner: 'me',
      name: 'notes',
      fullName: 'me/notes',
      private: true,
      defaultBranch: 'main',
      ownerType: 'User' as const,
      viewerCanAdmin: true,
      archived: false,
      empty: false,
      ownerId: 5,
    },
    {
      id: 103,
      owner: 'acme',
      name: 'shared',
      fullName: 'acme/shared',
      private: false,
      defaultBranch: 'main',
      ownerType: 'Organization' as const,
      viewerCanAdmin: false,
      archived: false,
      empty: false,
      ownerId: 9,
    },
  ];
  return {
    configured: () => true,
    exchangeCode: async ({ role }) => ({ token: `gho_${role ?? 'agent'}`, scopes: 'repo', expiresAt: null }),
    viewer: async () => ({ id: 5, login: 'me' }),
    listRepos: async () => repos,
    readTestCommand: async () => 'pnpm test',
    installationsForApp: async () => new Map([['me', { id: 700, selection: 'selected' as const }]]),
    // 只有 widgets（101）在安装里，notes 没装
    installationRepoIds: async () => new Set([101]),
    addReposToInstallation: async () => {},
    removeReposFromInstallation: async () => {},
    authorizeUrl: ({ redirectUri, state, role }) =>
      `https://github.com/login/oauth/authorize?state=${state}&ru=${encodeURIComponent(redirectUri)}&role=${role ?? 'agent'}`,
    appInstallUrl: ({ role, repositoryId, state }) =>
      `https://github.com/apps/${role}/installations/new/permissions?repository_ids[]=${repositoryId}&state=${state}`,
    ...overrides,
  };
}

/** 让当前登录的人连上 GitHub（把一份假令牌存进 store，用真加密，读回时解得开）。 */
async function connect(h: ReturnType<typeof harness>) {
  for (const role of ['agent', 'engine'] as const) {
    await h.store.putGitHubToken({
      userId: DEV_USER_ID,
      githubId: 5,
      login: 'me',
      role,
      accessTokenCipher: encryptToken('gho_test_token', h.config.sessionSecret),
      scopes: 'repo',
      expiresAt: null,
    });
  }
}

/** 把这一跳 Set-Cookie 盖进下一次请求。同名的留最后一条（删掉旧的再写下一条时，用新的）。 */
function withSetCookies(cookieHeader: string, res: Response): string {
  const jar = new Map<string, string>();
  const take = (header: string) => {
    for (const part of header.split(';')) {
      const trimmed = part.trim();
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      jar.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
  };
  take(cookieHeader);
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of lines) take(line.split(';')[0] ?? '');
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

describe('GET /api/repos/importable', () => {
  it('没连 GitHub：connected=false、列表空', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    const res = await h.cockpit.request(LIST, { headers: { cookie: s.cookie } });
    expect(res.status).toBe(200);
    const body = ImportableReposResponse.parse(await res.json());
    expect(body.auth.connected).toBe(false);
    expect(body.repos).toEqual([]);
  });

  it('没接上 GitHub 身份那一套：200 + 一句原因，不拿空列表冒充「你没有仓」', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request(LIST, { headers: { cookie: s.cookie } });
    expect(res.status).toBe(200);
    const body = ImportableReposResponse.parse(await res.json());
    expect(body.auth.connected).toBe(false);
    expect(body.repos).toEqual([]);
    expect(body.reason).toContain('没接上 GitHub');
  });

  it('连上之后：列出本人的仓，标好个人/组织、App 装了没、在不在驾驶舱', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    await connect(h);
    const body = ImportableReposResponse.parse(
      await (await h.cockpit.request(LIST, { headers: { cookie: s.cookie } })).json(),
    );
    expect(body.auth).toMatchObject({ connected: true, login: 'me' });
    expect(body.repos.map((r) => r.fullName)).toEqual(['me/widgets', 'me/notes', 'acme/shared']);
    const widgets = body.repos.find((r) => r.fullName === 'me/widgets');
    expect(widgets).toMatchObject({ agentInstalled: true, engineInstalled: true, fullyInstalled: true });
    const notes = body.repos.find((r) => r.fullName === 'me/notes');
    expect(notes).toMatchObject({ agentInstalled: false, engineInstalled: false, canInstall: true });
    // 组织仓本人没 admin：能看，但不能一键装
    const org = body.repos.find((r) => r.fullName === 'acme/shared');
    expect(org).toMatchObject({ ownerType: 'Organization', viewerCanAdmin: false, canInstall: false });
    expect(org?.installBlockedWhy).toBeTruthy();
  });

  it('【故意造出的失败】没登录：401', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    expect((await h.cockpit.request(LIST)).status).toBe(401);
  });

  it('【故意造出的失败】带 Authorization 令牌不能调这个接口：401', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    expect((await h.cockpit.request(LIST, viaBearer('GET'))).status).toBe(401);
  });
});

describe('POST /api/repos/import', () => {
  it('没连 GitHub：409，不建仓', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    const res = await h.cockpit.request(IMPORT, write('POST', s, { githubId: 102 }));
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('github_not_connected');
  });

  it('接进驾驶舱：建一行、默认关着自动派活、记操作记录', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    await connect(h);
    const res = await h.cockpit.request(IMPORT, write('POST', s, { githubId: 102 }));
    expect(res.status).toBe(201);
    const body = ImportRepoResponse.parse(await res.json());
    expect(body).toMatchObject({ owner: 'me', name: 'notes', created: true });
    const created = h.store.data.repos.find((r) => r.id === body.repoId);
    expect(created).toMatchObject({
      owner: 'me',
      name: 'notes',
      defaultBranch: 'main',
      testCommand: 'pnpm test',
    });
    expect(created?.autoDispatchSince).toBeUndefined();
    expect(h.store.data.audit.filter((a) => a.action === REPO_IMPORT_ADD)).toHaveLength(1);
  });

  it('已经在驾驶舱里：created=false，不重复建', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    await connect(h);
    const first = ImportRepoResponse.parse(
      await (await h.cockpit.request(IMPORT, write('POST', s, { githubId: 102 }))).json(),
    );
    const again = ImportRepoResponse.parse(
      await (await h.cockpit.request(IMPORT, write('POST', s, { githubId: 102 }))).json(),
    );
    expect(again.created).toBe(false);
    expect(again.repoId).toBe(first.repoId);
  });

  it('【故意造出的失败】仓里认不出测试命令：400，不插一行', async () => {
    const h = harness({
      githubUser: fakeGitHub({
        readTestCommand: async () => {
          throw new Error('package.json 里没有 test 或 check 脚本');
        },
      }),
    });
    const s = await h.login();
    await connect(h);
    const before = h.store.data.repos.length;
    const res = await h.cockpit.request(IMPORT, write('POST', s, { githubId: 102 }));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('github_no_test_command');
    expect(h.store.data.repos).toHaveLength(before);
  });

  it('【故意造出的失败】不是他可见的仓：404，不猜', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    await connect(h);
    const res = await h.cockpit.request(IMPORT, write('POST', s, { githubId: 999 }));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('repo_not_visible');
  });
});

describe('DELETE /api/repos/:repoId/cockpit', () => {
  it('移出：删掉 repos 那一行、记操作记录', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    await connect(h);
    const created = ImportRepoResponse.parse(
      await (await h.cockpit.request(IMPORT, write('POST', s, { githubId: 102 }))).json(),
    );
    const res = await h.cockpit.request(`/api/repos/${created.repoId}/cockpit`, write('DELETE', s));
    expect(res.status).toBe(200);
    expect(RemoveRepoResponse.parse(await res.json()).removed).toBe(true);
    expect(h.store.data.repos.find((r) => r.id === created.repoId)).toBeUndefined();
  });

  it('【故意造出的失败】还挂着没结束的单：不删，回原因', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    await connect(h);
    // 样例库里的仓挂着需求（devFixtures 里 task12 在跑）
    const repoId = h.store.data.repos[0]?.id ?? '';
    const res = await h.cockpit.request(`/api/repos/${repoId}/cockpit`, write('DELETE', s));
    expect(res.status).toBe(200);
    const body = RemoveRepoResponse.parse(await res.json());
    expect(body.removed).toBe(false);
    expect(body.reason).toContain('挂着');
    expect(h.store.data.repos.find((r) => r.id === repoId)).toBeDefined();
  });

  it('【故意造出的失败】没有这个仓：404', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    const res = await h.cockpit.request(
      '/api/repos/a0000000-0000-4000-8000-0000000000ff/cockpit',
      write('DELETE', s),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/repos/install', () => {
  it('把 App 装到仓上：两个都装成', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    await connect(h);
    const res = await h.cockpit.request(INSTALL, write('POST', s, { githubId: 102 }));
    expect(res.status).toBe(200);
    expect(InstallAppResponse.parse(await res.json())).toEqual({ installed: 2, agent: true, engine: true });
    expect(h.store.data.audit.filter((a) => a.action === GITHUB_INSTALL_REPO)).toHaveLength(1);
  });

  it('【故意造出的失败】组织仓本人没 admin：403，说清要组织先批', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    await connect(h);
    const res = await h.cockpit.request(INSTALL, write('POST', s, { githubId: 103 }));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('needs_org_admin');
  });

  it('App 还没装到账号上：装不上，reason 说清要先装一次（不静默成功）', async () => {
    const h = harness({
      githubUser: fakeGitHub({ installationsForApp: async () => new Map() }),
    });
    const s = await h.login();
    await connect(h);
    const res = await h.cockpit.request(INSTALL, write('POST', s, { githubId: 102 }));
    expect(res.status).toBe(200);
    const body = InstallAppResponse.parse(await res.json());
    expect(body.installed).toBe(0);
    expect(body.reason).toContain('先去 GitHub 装');
  });
});

describe('POST /api/github/oauth/disconnect', () => {
  it('断开：删掉库里那份、记操作记录', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    await connect(h);
    const res = await h.cockpit.request('/api/github/oauth/disconnect', write('POST', s, {}));
    expect(res.status).toBe(200);
    expect(h.store.data.githubTokens.size).toBe(0);
    expect(h.store.data.audit.filter((a) => a.action === GITHUB_OAUTH_DISCONNECT)).toHaveLength(1);
  });
});

describe('一键授权', () => {
  it('点了跳 GitHub 授权页，回来后两个 App 都装到这个仓上，并记操作记录', async () => {
    const added: string[] = [];
    const h = harness({
      githubUser: fakeGitHub({
        addReposToInstallation: async (token, _id, ids) => {
          added.push(`${token}:${ids.join(',')}`);
        },
      }),
    });
    const s = await h.login();
    const first = await h.cockpit.request('/api/github/authorize?githubId=102', {
      headers: { cookie: s.cookie },
      redirect: 'manual',
    });
    expect(first.status).toBe(302);
    const agentUrl = new URL(first.headers.get('location') ?? '');
    expect(agentUrl.hostname).toBe('github.com');
    expect(agentUrl.pathname).toBe('/login/oauth/authorize');
    expect(agentUrl.searchParams.get('role')).toBe('agent');

    const backAgent = await h.cockpit.request(
      `/api/github/callback?code=abc&state=${agentUrl.searchParams.get('state')}`,
      { headers: { cookie: withSetCookies(s.cookie, first) }, redirect: 'manual' },
    );
    expect(backAgent.status).toBe(302);
    const engineUrl = new URL(backAgent.headers.get('location') ?? '');
    expect(engineUrl.searchParams.get('role')).toBe('engine');

    const backEngine = await h.cockpit.request(
      `/api/github/callback?code=def&state=${engineUrl.searchParams.get('state')}`,
      {
        headers: { cookie: backEngineCookie(s.cookie, first, backAgent) },
        redirect: 'manual',
      },
    );
    expect(backEngine.status).toBe(302);
    expect(backEngine.headers.get('location')).toContain('/settings?github=ok');
    expect(added).toEqual(['gho_agent:102', 'gho_engine:102']);
    expect(h.store.data.audit.filter((a) => a.action === GITHUB_INSTALL_REPO)).toHaveLength(2);
    expect(h.store.data.audit.filter((a) => a.action === GITHUB_OAUTH_CONNECT)).toHaveLength(2);
    expect(await h.store.getGitHubToken(DEV_USER_ID, 'agent')).not.toBeNull();
    expect(await h.store.getGitHubToken(DEV_USER_ID, 'engine')).not.toBeNull();
  });

  it('账号上还没装这个 App：跳 GitHub 安装页，不假装已经装上', async () => {
    const h = harness({
      githubUser: fakeGitHub({ installationsForApp: async () => new Map() }),
    });
    const s = await h.login();
    const first = await h.cockpit.request('/api/github/authorize?githubId=102', {
      headers: { cookie: s.cookie },
      redirect: 'manual',
    });
    const agentUrl = new URL(first.headers.get('location') ?? '');
    const back = await h.cockpit.request(
      `/api/github/callback?code=abc&state=${agentUrl.searchParams.get('state')}`,
      { headers: { cookie: withSetCookies(s.cookie, first) }, redirect: 'manual' },
    );
    expect(back.status).toBe(302);
    const install = new URL(back.headers.get('location') ?? '');
    expect(install.hostname).toBe('github.com');
    expect(install.pathname).toContain('/installations/new');
    expect(h.store.data.audit.filter((a) => a.action === GITHUB_INSTALL_REPO)).toHaveLength(0);
  });

  it('安装页回来：记上这一边，接着去给另一边授权', async () => {
    const h = harness({
      githubUser: fakeGitHub({ installationsForApp: async () => new Map() }),
    });
    const s = await h.login();
    const first = await h.cockpit.request('/api/github/authorize?githubId=102', {
      headers: { cookie: s.cookie },
      redirect: 'manual',
    });
    const agentUrl = new URL(first.headers.get('location') ?? '');
    const back = await h.cockpit.request(
      `/api/github/callback?code=abc&state=${agentUrl.searchParams.get('state')}`,
      { headers: { cookie: withSetCookies(s.cookie, first) }, redirect: 'manual' },
    );
    const install = new URL(back.headers.get('location') ?? '');
    const setup = await h.cockpit.request(`/api/github/setup?state=${install.searchParams.get('state')}`, {
      headers: { cookie: withSetCookies(s.cookie, back) },
      redirect: 'manual',
    });
    expect(setup.status).toBe(302);
    const engineUrl = new URL(setup.headers.get('location') ?? '');
    expect(engineUrl.searchParams.get('role')).toBe('engine');
    const audits = h.store.data.audit.filter((a) => a.action === GITHUB_INSTALL_REPO);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.ok).toBe(true);
  });

  it('组织还没批准：安装页带回 request，记失败，不接着装', async () => {
    const h = harness({
      githubUser: fakeGitHub({ installationsForApp: async () => new Map() }),
    });
    const s = await h.login();
    const first = await h.cockpit.request('/api/github/authorize?githubId=102', {
      headers: { cookie: s.cookie },
      redirect: 'manual',
    });
    const agentUrl = new URL(first.headers.get('location') ?? '');
    const back = await h.cockpit.request(
      `/api/github/callback?code=abc&state=${agentUrl.searchParams.get('state')}`,
      { headers: { cookie: withSetCookies(s.cookie, first) }, redirect: 'manual' },
    );
    const install = new URL(back.headers.get('location') ?? '');
    const setup = await h.cockpit.request(
      `/api/github/setup?state=${install.searchParams.get('state')}&setup_action=request`,
      { headers: { cookie: withSetCookies(s.cookie, back) }, redirect: 'manual' },
    );
    expect(setup.status).toBe(302);
    expect(setup.headers.get('location')).toContain('github=install_failed');
    const audits = h.store.data.audit.filter((a) => a.action === GITHUB_INSTALL_REPO);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.ok).toBe(false);
    expect(audits[0]?.error).toContain('要组织先批准这个 App');
  });
});

function backEngineCookie(session: string, first: Response, second: Response): string {
  return withSetCookies(withSetCookies(session, first), second);
}

describe('GET /github/connect', () => {
  it('跳 GitHub 授权页，带回 state', async () => {
    const h = harness({ githubUser: fakeGitHub() });
    const s = await h.login();
    const res = await h.cockpit.request('/api/github/connect', {
      headers: { cookie: s.cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('github.com/login/oauth/authorize');
  });

  it('【故意造出的失败】没接上 GitHub 身份那一套：503，不跳一个坏地址', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request('/api/github/connect', { headers: { cookie: s.cookie } });
    expect(res.status).toBe(503);
  });
});
