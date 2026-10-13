// 设置页导入仓库：每人用自己的 GitHub 用户令牌列仓、加进、移出、一键给两个 App 授权。令牌不进回应、不进操作记录。
import type { AppCoveragePort, GithubUserPort, ListedGithubRepo, UserInstallation } from '@fleet-dao/github';
import { DEV_USER_ID, IDS } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { cookieHeader, harness, write } from './harness.ts';

const SECRET = 'ghu_test_secret_do_not_leak';

function repo(over: Partial<ListedGithubRepo> = {}): ListedGithubRepo {
  return {
    id: 11,
    owner: 'lan',
    name: 'notes',
    ownerKind: 'user',
    accountId: 9,
    defaultBranch: 'main',
    canAdmin: true,
    ...over,
  };
}

function fakeUser(
  options: {
    repos?: ListedGithubRepo[];
    installations?: UserInstallation[] | (() => Promise<UserInstallation[]>);
    testCommand?: string | Error;
    login?: string;
  } = {},
): GithubUserPort & { puts: { installationId: number; repositoryId: number; token: string }[] } {
  const puts: { installationId: number; repositoryId: number; token: string }[] = [];
  return {
    puts,
    async listRepos() {
      return { repos: options.repos ?? [repo()], truncated: false };
    },
    async readTestCommand() {
      if (options.testCommand instanceof Error) throw options.testCommand;
      return options.testCommand ?? 'pnpm test';
    },
    async installations() {
      if (typeof options.installations === 'function') return options.installations();
      return options.installations ?? [];
    },
    async addRepository(token, installationId, repositoryId) {
      puts.push({ token, installationId, repositoryId });
    },
    async exchange() {
      return {
        accessToken: SECRET,
        refreshToken: 'ghr_refresh_secret',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
    },
    async refresh() {
      return { accessToken: SECRET };
    },
    async login() {
      return options.login ?? 'lan';
    },
    authorizeUrl(input) {
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('state', input.state);
      url.searchParams.set('role', input.role);
      return url.toString();
    },
    installUrl(input) {
      const url = new URL(`https://github.com/apps/${input.role}/installations/new/permissions`);
      url.searchParams.set('state', input.state);
      url.searchParams.set('target_id', String(input.targetId));
      url.searchParams.append('repository_ids[]', String(input.repositoryId));
      return url.toString();
    },
    accountInstallUrl(input) {
      const url = new URL(`https://github.com/apps/${input.role}/installations/new`);
      url.searchParams.set('state', input.state);
      return url.toString();
    },
  };
}

function coverage(
  agent: AppCoveragePort['coverage'] extends (role: infer _R) => Promise<infer T> ? T : never,
): AppCoveragePort {
  return {
    async coverage(role) {
      if (role === 'agent') return agent;
      return { ok: false, reason: '引擎安装列表没接上' };
    },
  };
}

async function audits(
  store: {
    listAudit: (q: { limit: number; target?: string }) => Promise<{
      items: { action: string; target: string; ok: boolean; error?: string | undefined; after?: unknown }[];
    }>;
  },
  action: string,
) {
  const page = await store.listAudit({ limit: 50 });
  return page.items.filter((item) => item.action === action);
}

describe('导入仓库', () => {
  it('没接上用户授权时 503，原因是装机时记下的那句', async () => {
    const h = harness({ githubUserProblem: '凭据文件读不到' });
    const session = await h.login();
    const res = await h.cockpit.request('/api/repos/github', { headers: { cookie: session.cookie } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: { code: 'github_user_unconfigured', message: '凭据文件读不到' },
    });
  });

  it('没连接时不拿空列表冒充没有仓', async () => {
    const h = harness({ githubUser: fakeUser() });
    const session = await h.login();
    const res = await h.cockpit.request('/api/repos/github', { headers: { cookie: session.cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connected: false,
      problem: '还没连接你的 GitHub。点「连接 GitHub」，用你自己的账号授权。',
      truncated: false,
      repos: [],
    });
  });

  it('列出个人仓和组织仓，标明在不在驾驶舱；认不出不是没装', async () => {
    const github = fakeUser({
      repos: [repo(), repo({ id: 12, owner: 'example', name: 'canary', ownerKind: 'org', accountId: 3 })],
    });
    const h = harness({
      githubUser: github,
      appCoverage: coverage({ ok: true, allOwners: [], repos: ['lan/notes'] }),
    });
    await h.store.saveGithubToken({
      userId: DEV_USER_ID,
      role: 'agent',
      githubLogin: 'lan',
      accessToken: SECRET,
    });
    const session = await h.login();
    const res = await h.cockpit.request('/api/repos/github', { headers: { cookie: session.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: {
        owner: string;
        name: string;
        ownerKind: string;
        inCockpit: boolean;
        repoId?: string;
        orgNote?: string;
        apps: { agent: string; engine: string };
        appsUnknown?: string;
      }[];
    };
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body).toMatchObject({
      connected: true,
      githubLogin: 'lan',
      truncated: false,
    });
    const rows = body.repos;
    const notes = rows.find((item) => item.name === 'notes');
    const canary = rows.find((item) => item.name === 'canary');
    expect(notes).toMatchObject({
      ownerKind: 'user',
      inCockpit: false,
      apps: { agent: 'installed', engine: 'unknown' },
      appsUnknown: '引擎安装列表没接上',
    });
    expect(notes?.orgNote).toBeUndefined();
    expect(canary).toMatchObject({
      ownerKind: 'org',
      inCockpit: true,
      repoId: IDS.repo,
      orgNote: '要组织先批准这个 App',
      apps: { agent: 'missing', engine: 'unknown' },
    });
  });

  it('加进驾驶舱不打开自动派单，再加一次不重复记；没权限、没默认分支都不插', async () => {
    const github = fakeUser({
      repos: [
        repo(),
        repo({ id: 13, name: 'empty', defaultBranch: '', canAdmin: true }),
        repo({ id: 14, name: 'shared', canAdmin: false }),
      ],
    });
    const h = harness({ githubUser: github });
    await h.store.saveGithubToken({
      userId: DEV_USER_ID,
      role: 'agent',
      githubLogin: 'lan',
      accessToken: SECRET,
    });
    const session = await h.login();
    const first = await h.cockpit.request(
      '/api/repos/import',
      write('POST', session, { owner: 'lan', name: 'notes' }),
    );
    expect(first.status).toBe(200);
    const created = (await first.json()) as {
      repoId: string;
      autoDispatch: boolean;
      created: boolean;
      testCommand: string;
    };
    expect(created).toMatchObject({
      autoDispatch: false,
      created: true,
      testCommand: 'pnpm test',
      owner: 'lan',
      name: 'notes',
    });
    expect(JSON.stringify(created)).not.toContain(SECRET);
    const stored = await h.store.findRepoByName('lan', 'notes');
    expect(stored?.autoDispatchSince).toBeNull();
    expect(stored?.ciPolicy).toBe('force');
    expect(await audits(h.store, 'repo.import')).toHaveLength(1);

    const again = await h.cockpit.request(
      '/api/repos/import',
      write('POST', session, { owner: 'Lan', name: 'NOTES' }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, repoId: created.repoId, autoDispatch: false });
    expect(await audits(h.store, 'repo.import')).toHaveLength(1);

    const denied = await h.cockpit.request(
      '/api/repos/import',
      write('POST', session, { owner: 'lan', name: 'shared' }),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'github_repo_not_admin' } });
    expect(await h.store.findRepoByName('lan', 'shared')).toBeNull();

    const noBranch = await h.cockpit.request(
      '/api/repos/import',
      write('POST', session, { owner: 'lan', name: 'empty' }),
    );
    expect(noBranch.status).toBe(400);
    expect(await noBranch.json()).toMatchObject({ error: { code: 'github_no_default_branch' } });
  });

  it('移出没在用的仓；样例仓还有任务时 409 且行还在；编号不对不记操作记录', async () => {
    const h = harness({ githubUser: fakeUser() });
    await h.store.saveGithubToken({
      userId: DEV_USER_ID,
      role: 'agent',
      githubLogin: 'lan',
      accessToken: SECRET,
    });
    const session = await h.login();
    const imported = await h.cockpit.request(
      '/api/repos/import',
      write('POST', session, { owner: 'lan', name: 'notes' }),
    );
    const { repoId } = (await imported.json()) as { repoId: string };
    const removed = await h.cockpit.request(`/api/repos/${repoId}`, write('DELETE', session));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true, owner: 'lan', name: 'notes' });
    expect(await h.store.findRepoByName('lan', 'notes')).toBeNull();
    expect(await audits(h.store, 'repo.remove')).toMatchObject([{ ok: true, target: `repo:${repoId}` }]);

    const blocked = await h.cockpit.request(`/api/repos/${IDS.repo}`, write('DELETE', session));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: 'repo_in_use' } });
    expect(await h.store.getRepo(IDS.repo)).not.toBeNull();
    const failed = (await audits(h.store, 'repo.remove')).filter((item) => item.ok === false);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toBe('in_use');

    const before = (await audits(h.store, 'repo.remove')).length;
    const missing = await h.cockpit.request('/api/repos/not-a-uuid', write('DELETE', session));
    expect(missing.status).toBe(404);
    expect(await audits(h.store, 'repo.remove')).toHaveLength(before);
  });

  it('一键授权：没令牌跳 GitHub；两个都是勾选安装时各 PUT 一次；全部仓不再 PUT', async () => {
    const none = fakeUser();
    const h = harness({ githubUser: none });
    const session = await h.login();
    const redirect = await h.cockpit.request(
      '/api/repos/github/authorize',
      write('POST', session, { owner: 'lan', name: 'notes' }),
    );
    expect(redirect.status).toBe(200);
    const jumped = (await redirect.json()) as { installed: boolean; redirect?: string };
    expect(jumped.installed).toBe(false);
    expect(jumped.redirect).toContain('https://github.com/login/oauth/authorize');
    expect(JSON.stringify(jumped)).not.toContain(SECRET);

    const selected = fakeUser({
      installations: [{ id: 100, accountLogin: 'lan', accountId: 9, repositorySelection: 'selected' }],
    });
    const both = harness({ githubUser: selected });
    await both.store.saveGithubToken({
      userId: DEV_USER_ID,
      role: 'agent',
      githubLogin: 'lan',
      accessToken: `${SECRET}-agent`,
    });
    await both.store.saveGithubToken({
      userId: DEV_USER_ID,
      role: 'engine',
      githubLogin: 'lan',
      accessToken: `${SECRET}-engine`,
    });
    const session2 = await both.login();
    const installed = await both.cockpit.request(
      '/api/repos/github/authorize',
      write('POST', session2, { owner: 'lan', name: 'notes' }),
    );
    expect(installed.status).toBe(200);
    const done = await installed.json();
    expect(done).toEqual({ installed: true, agent: 'installed', engine: 'installed' });
    expect(JSON.stringify(done)).not.toContain(SECRET);
    expect(selected.puts.map((item) => item.token).sort()).toEqual([`${SECRET}-agent`, `${SECRET}-engine`]);
    expect(selected.puts.every((item) => item.installationId === 100 && item.repositoryId === 11)).toBe(true);
    const rows = await audits(both.store, 'repo.apps.install');
    expect(rows.filter((item) => item.ok)).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(SECRET);

    const all = fakeUser({
      installations: [{ id: 200, accountLogin: 'lan', accountId: 9, repositorySelection: 'all' }],
    });
    const covered = harness({ githubUser: all });
    await covered.store.saveGithubToken({
      userId: DEV_USER_ID,
      role: 'agent',
      githubLogin: 'lan',
      accessToken: SECRET,
    });
    await covered.store.saveGithubToken({
      userId: DEV_USER_ID,
      role: 'engine',
      githubLogin: 'lan',
      accessToken: SECRET,
    });
    const session3 = await covered.login();
    const already = await covered.cockpit.request(
      '/api/repos/github/authorize',
      write('POST', session3, { owner: 'lan', name: 'notes' }),
    );
    expect(already.status).toBe(200);
    expect(await already.json()).toEqual({ installed: true, agent: 'installed', engine: 'installed' });
    expect(all.puts).toEqual([]);
  });

  it('组织还没批准时记失败，句子是要组织先批准这个 App', async () => {
    const github = fakeUser({ installations: [] });
    const h = harness({ githubUser: github });
    await h.store.saveGithubToken({
      userId: DEV_USER_ID,
      role: 'agent',
      githubLogin: 'lan',
      accessToken: SECRET,
    });
    const session = await h.login();
    const started = await h.cockpit.request(
      '/api/repos/github/authorize',
      write('POST', session, { owner: 'lan', name: 'notes' }),
    );
    const body = (await started.json()) as { redirect: string };
    const state = new URL(body.redirect).searchParams.get('state');
    const setup = await h.cockpit.request(`/auth/github/setup?state=${state}&setup_action=request`, {
      headers: { cookie: `${session.cookie}; ${cookieHeader(started)}` },
    });
    expect(setup.status).toBe(302);
    expect(setup.headers.get('location')).toContain('github=install_failed');
    const failed = (await audits(h.store, 'repo.apps.install')).filter((item) => item.ok === false);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toBe('要组织先批准这个 App');
  });

  it('连上之后一个安装都没有，就去账号安装页；授权状态对不上回到设置页', async () => {
    const github = fakeUser({ installations: [] });
    const h = harness({ githubUser: github });
    const session = await h.login();
    const connect = await h.cockpit.request('/api/repos/github/connect', write('POST', session));
    expect(connect.status).toBe(200);
    const body = (await connect.json()) as { connected: boolean; redirect: string };
    expect(body.connected).toBe(false);
    expect(body.redirect.startsWith('https://github.com/login/oauth/authorize')).toBe(true);
    const state = new URL(body.redirect).searchParams.get('state');
    const back = await h.cockpit.request(`/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `${session.cookie}; ${cookieHeader(connect)}` },
    });
    expect(back.status).toBe(302);
    const location = back.headers.get('location') ?? '';
    expect(location.startsWith('https://github.com/apps/agent/installations/new')).toBe(true);
    expect(location).not.toContain('repository_ids');
    expect(location).not.toContain(SECRET);
    const saved = await h.store.getGithubToken(DEV_USER_ID, 'agent');
    expect(saved?.accessToken).toBe(SECRET);
    expect(saved?.githubLogin).toBe('lan');

    const bad = await h.cockpit.request('/auth/github/callback?code=abc&state=not-the-one', {
      headers: { cookie: session.cookie },
    });
    expect(bad.status).toBe(302);
    expect(bad.headers.get('location')).toContain('github=state');
  });

  it('已经连上再装到别的账号，跳安装页，不带单个仓', async () => {
    const h = harness({ githubUser: fakeUser() });
    await h.store.saveGithubToken({
      userId: DEV_USER_ID,
      role: 'agent',
      githubLogin: 'lan',
      accessToken: SECRET,
    });
    const session = await h.login();
    const res = await h.cockpit.request(
      '/api/repos/github/connect',
      write('POST', session, { purpose: 'install-account' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean; redirect: string };
    expect(body.connected).toBe(true);
    expect(body.redirect.startsWith('https://github.com/apps/agent/installations/new?state=')).toBe(true);
    expect(body.redirect).not.toContain('repository_ids');
  });
});
