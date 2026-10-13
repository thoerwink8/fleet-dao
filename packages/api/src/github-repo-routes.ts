// 设置页「导入仓库」：每人用自己的 GitHub 用户令牌看自己的仓，加进或移出驾驶舱，一键给两个 App 授权。
// 令牌只留在库里。跳转地址只许 https://github.com，由这里拼，不接请求里带来的网址。

import {
  type AppCoveragePort,
  type GithubUserPort,
  installPlan,
  isGitHubError,
  type ListedGithubRepo,
  registerSecret,
} from '@fleet-dao/github';
import {
  GithubAuthorizeRequest,
  GithubAuthorizeResponse,
  GithubConnectRequest,
  GithubConnectResponse,
  GithubReposResponse,
  ImportRepoRequest,
  ImportRepoResponse,
  ORG_APP_APPROVAL_NOTE,
  REPO_APPS_INSTALL,
  REPO_IMPORT,
  REPO_REMOVE,
  RemoveRepoResponse,
  WebRoutes,
} from '@fleet-dao/shared';
import type { Context, Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { Actor, GithubAppRole, GithubUserToken } from './ports.ts';
import type { CockpitEnv } from './session.ts';
import { readSession, saveGithubOAuthState, takeGithubOAuthState } from './session.ts';
import { pkceChallenge, randomToken } from './tokens.ts';

const NOT_CONNECTED = '还没连接你的 GitHub。点「连接 GitHub」，用你自己的账号授权。';
const EXPIRED = '授权过期，请重新连接 GitHub';
const COVERAGE_MISSING = 'App 装了没没接上';

type AppState = 'installed' | 'missing' | 'unknown';

function portOf(deps: Deps): GithubUserPort {
  if (!deps.githubUser) {
    throw new ApiError(503, 'github_user_unconfigured', deps.githubUserProblem || 'GitHub 用户授权没接上');
  }
  return deps.githubUser;
}

function onlyGithub(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(500, 'bad_redirect', '授权地址不在 GitHub');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new ApiError(500, 'bad_redirect', '授权地址不在 GitHub');
  }
  return parsed.toString();
}

function callbackUri(deps: Deps): string {
  return new URL('/auth/github/callback', deps.config.publicUrl).toString();
}

function accountInstallRedirect(c: Context, deps: Deps, uid: string, role: GithubAppRole): string {
  const state = randomToken(16);
  const verifier = randomToken(32);
  saveGithubOAuthState(
    c,
    deps.config,
    { state, verifier, uid, role, next: '/settings?github=connected' },
    deps.now(),
  );
  return onlyGithub(portOf(deps).accountInstallUrl({ role, state }));
}

async function connectPurpose(c: Context): Promise<'list' | 'install-account'> {
  const text = await c.req.text();
  if (text.trim() === '') return 'list';
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_json', '请求体不是合法的 JSON');
  }
  const parsed = GithubConnectRequest.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'invalid_request', '请求内容不符合约定');
  return parsed.data.purpose ?? 'list';
}

function back(
  deps: Deps,
  query: 'ok' | 'connected' | 'exchange_failed' | 'state' | 'install_failed',
): string {
  return new URL(`/settings?github=${query}`, deps.config.publicUrl).toString();
}

function messageOf(err: unknown): string {
  if (isGitHubError(err) || err instanceof Error) return err.message;
  return 'GitHub 没做成';
}

function remember(token: GithubUserToken): void {
  registerSecret(token.accessToken);
  if (token.refreshToken) registerSecret(token.refreshToken);
}

async function freshToken(
  deps: Deps,
  userId: string,
  role: GithubAppRole,
): Promise<{ kind: 'ok'; token: GithubUserToken } | { kind: 'missing' } | { kind: 'expired' }> {
  const row = await deps.store.getGithubToken(userId, role);
  if (!row) return { kind: 'missing' };
  remember(row);
  const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : undefined;
  if (expiresAt === undefined || expiresAt - deps.now().getTime() > 60_000) return { kind: 'ok', token: row };
  if (!row.refreshToken) {
    await deps.store.deleteGithubToken(userId, role);
    return { kind: 'expired' };
  }
  try {
    const next = await portOf(deps).refresh({ role, refreshToken: row.refreshToken });
    const saved: GithubUserToken = {
      userId,
      role,
      githubLogin: row.githubLogin,
      accessToken: next.accessToken,
      ...((next.refreshToken ?? row.refreshToken)
        ? { refreshToken: next.refreshToken ?? row.refreshToken }
        : {}),
      ...(next.expiresAt ? { expiresAt: next.expiresAt } : {}),
    };
    remember(saved);
    await deps.store.saveGithubToken(saved);
    return { kind: 'ok', token: saved };
  } catch {
    await deps.store.deleteGithubToken(userId, role);
    return { kind: 'expired' };
  }
}

function startOauth(
  c: Context,
  deps: Deps,
  uid: string,
  role: GithubAppRole,
  repo?: { owner: string; name: string },
): string {
  const state = randomToken(16);
  const verifier = randomToken(32);
  saveGithubOAuthState(
    c,
    deps.config,
    {
      state,
      verifier,
      uid,
      role,
      next: repo ? '/settings?github=ok' : '/settings?github=connected',
      ...(repo ? { owner: repo.owner, name: repo.name } : {}),
    },
    deps.now(),
  );
  return onlyGithub(
    portOf(deps).authorizeUrl({
      role,
      redirectUri: callbackUri(deps),
      state,
      codeChallenge: pkceChallenge(verifier),
    }),
  );
}

async function targetFor(deps: Deps, repo: { owner: string; name: string }): Promise<string> {
  const known = await deps.store.findRepoByName(repo.owner, repo.name);
  return known ? `repo:${known.id}` : `github:${repo.owner}/${repo.name}`;
}

async function auditInstall(
  deps: Deps,
  uid: string,
  repo: { owner: string; name: string },
  role: GithubAppRole,
  ok: boolean,
  error?: string,
): Promise<void> {
  await deps.store.appendAudit({
    actor: { kind: 'user', id: uid },
    action: REPO_APPS_INSTALL,
    target: await targetFor(deps, repo),
    via: 'cockpit',
    ok,
    ...(error ? { error } : {}),
    after: { app: role, owner: repo.owner, name: repo.name },
  });
}

async function installOne(
  c: Context,
  deps: Deps,
  uid: string,
  role: GithubAppRole,
  repo: ListedGithubRepo,
  accessToken: string,
): Promise<'installed' | { redirect: string }> {
  const github = portOf(deps);
  let installations: Awaited<ReturnType<GithubUserPort['installations']>>;
  try {
    installations = await github.installations(accessToken);
  } catch (err) {
    const reason = messageOf(err);
    await auditInstall(deps, uid, repo, role, false, reason);
    throw new ApiError(502, 'github_install_failed', reason);
  }
  const plan = installPlan({
    slug: 'placeholder',
    repo: { id: repo.id, accountId: repo.accountId, owner: repo.owner },
    installations,
    state: 'x',
  });
  if (plan.kind === 'put' || plan.kind === 'covered') {
    if (plan.kind === 'put') {
      try {
        await github.addRepository(accessToken, plan.installationId, repo.id);
      } catch (err) {
        const reason = messageOf(err);
        const text =
          repo.ownerKind === 'org' && !reason.includes(ORG_APP_APPROVAL_NOTE)
            ? `${reason}。${ORG_APP_APPROVAL_NOTE}`
            : reason;
        await auditInstall(deps, uid, repo, role, false, text);
        throw new ApiError(403, 'github_install_failed', text);
      }
    }
    await auditInstall(deps, uid, repo, role, true);
    return 'installed';
  }
  const state = randomToken(16);
  const verifier = randomToken(32);
  saveGithubOAuthState(
    c,
    deps.config,
    {
      state,
      verifier,
      uid,
      role,
      owner: repo.owner,
      name: repo.name,
      next: '/settings?github=ok',
    },
    deps.now(),
  );
  return {
    redirect: onlyGithub(github.installUrl({ role, targetId: repo.accountId, repositoryId: repo.id, state })),
  };
}

async function listedRepo(
  deps: Deps,
  accessToken: string,
  owner: string,
  name: string,
): Promise<ListedGithubRepo> {
  let listed: { repos: ListedGithubRepo[] };
  try {
    listed = await portOf(deps).listRepos(accessToken);
  } catch (err) {
    if (isGitHubError(err, 'AUTH_FAILED')) throw new ApiError(401, 'github_auth_expired', EXPIRED);
    throw new ApiError(502, 'github_list_failed', messageOf(err));
  }
  const repo = listed.repos.find(
    (item) =>
      item.owner.toLowerCase() === owner.toLowerCase() && item.name.toLowerCase() === name.toLowerCase(),
  );
  if (!repo) throw new ApiError(404, 'github_repo_not_visible', '你的 GitHub 上看不到这个仓');
  if (!repo.canAdmin)
    throw new ApiError(403, 'github_repo_not_admin', '没有这个仓的管理权限，加不进、也装不上 App');
  return repo;
}

/** 两个 App 依次装。缺令牌就去授权；账号上还没有安装就去安装页。 */
async function ensureInstalled(
  c: Context,
  deps: Deps,
  uid: string,
  repo: ListedGithubRepo,
): Promise<
  { redirect: string; installed: false } | { installed: true; agent: 'installed'; engine: 'installed' }
> {
  for (const role of ['agent', 'engine'] as const) {
    const fresh = await freshToken(deps, uid, role);
    if (fresh.kind !== 'ok') {
      return { installed: false, redirect: startOauth(c, deps, uid, role, repo) };
    }
    const step = await installOne(c, deps, uid, role, repo, fresh.token.accessToken);
    if (step !== 'installed') return { installed: false, redirect: step.redirect };
  }
  return { installed: true, agent: 'installed', engine: 'installed' };
}

async function coverageOf(
  deps: Deps,
  role: GithubAppRole,
): Promise<Awaited<ReturnType<AppCoveragePort['coverage']>>> {
  if (!deps.appCoverage) return { ok: false, reason: COVERAGE_MISSING };
  return deps.appCoverage.coverage(role);
}

function stateFor(
  coverage: Awaited<ReturnType<AppCoveragePort['coverage']>>,
  repo: { owner: string; name: string },
): AppState {
  if (!coverage.ok) return 'unknown';
  const owner = repo.owner.toLowerCase();
  if (coverage.allOwners.includes(owner)) return 'installed';
  if (coverage.repos.includes(`${owner}/${repo.name.toLowerCase()}`)) return 'installed';
  return 'missing';
}

export function registerGithubRepoRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: Context<CockpitEnv>) => Actor,
): void {
  app.get(WebRoutes.githubRepos.path, async (c) => {
    const github = portOf(deps);
    const uid = c.get('user').id;
    const fresh = await freshToken(deps, uid, 'agent');
    if (fresh.kind !== 'ok') {
      return reply(c, GithubReposResponse, {
        connected: false,
        problem: fresh.kind === 'expired' ? EXPIRED : NOT_CONNECTED,
        truncated: false,
        repos: [],
      });
    }
    let listed: Awaited<ReturnType<GithubUserPort['listRepos']>>;
    try {
      listed = await github.listRepos(fresh.token.accessToken);
    } catch (err) {
      if (isGitHubError(err, 'AUTH_FAILED')) {
        await deps.store.deleteGithubToken(uid, 'agent');
        return reply(c, GithubReposResponse, {
          connected: false,
          problem: EXPIRED,
          truncated: false,
          repos: [],
        });
      }
      throw new ApiError(502, 'github_list_failed', messageOf(err));
    }
    const [agentCoverage, engineCoverage] = await Promise.all([
      coverageOf(deps, 'agent'),
      coverageOf(deps, 'engine'),
    ]);
    const unknown = [agentCoverage, engineCoverage]
      .flatMap((item) => (item.ok ? [] : [item.reason]))
      .filter((reason, index, all) => all.indexOf(reason) === index)
      .join('；');
    const repos = [];
    for (const repo of listed.repos) {
      const known = await deps.store.findRepoByName(repo.owner, repo.name);
      const agent = stateFor(agentCoverage, repo);
      const engine = stateFor(engineCoverage, repo);
      repos.push({
        owner: repo.owner,
        name: repo.name,
        ownerKind: repo.ownerKind,
        defaultBranch: repo.defaultBranch,
        inCockpit: known !== null,
        ...(known ? { repoId: known.id } : {}),
        canAdmin: repo.canAdmin,
        apps: { agent, engine },
        ...(unknown === '' ? {} : { appsUnknown: unknown }),
        ...(repo.ownerKind === 'org' ? { orgNote: ORG_APP_APPROVAL_NOTE } : {}),
      });
    }
    return reply(c, GithubReposResponse, {
      connected: true,
      githubLogin: fresh.token.githubLogin,
      truncated: listed.truncated,
      repos,
    });
  });

  app.post(WebRoutes.connectGithub.path, async (c) => {
    portOf(deps);
    const uid = c.get('user').id;
    const purpose = await connectPurpose(c);
    const fresh = await freshToken(deps, uid, 'agent');
    if (fresh.kind === 'ok' && purpose === 'install-account') {
      return reply(c, GithubConnectResponse, {
        connected: true,
        redirect: accountInstallRedirect(c, deps, uid, 'agent'),
      });
    }
    if (fresh.kind === 'ok') return reply(c, GithubConnectResponse, { connected: true });
    return reply(c, GithubConnectResponse, {
      connected: false,
      redirect: startOauth(c, deps, uid, 'agent'),
    });
  });

  app.post(WebRoutes.authorizeGithubRepo.path, async (c) => {
    const body = await readJson(c, GithubAuthorizeRequest);
    const uid = c.get('user').id;
    const fresh = await freshToken(deps, uid, 'agent');
    if (fresh.kind !== 'ok') {
      return reply(c, GithubAuthorizeResponse, {
        installed: false,
        redirect: startOauth(c, deps, uid, 'agent', body),
      });
    }
    const repo = await listedRepo(deps, fresh.token.accessToken, body.owner, body.name);
    const result = await ensureInstalled(c, deps, uid, repo);
    return reply(c, GithubAuthorizeResponse, result);
  });

  app.post(WebRoutes.importRepo.path, async (c) => {
    const body = await readJson(c, ImportRepoRequest);
    const uid = c.get('user').id;
    const fresh = await freshToken(deps, uid, 'agent');
    if (fresh.kind !== 'ok')
      throw new ApiError(409, 'github_not_connected', fresh.kind === 'expired' ? EXPIRED : NOT_CONNECTED);
    const repo = await listedRepo(deps, fresh.token.accessToken, body.owner, body.name);
    if (repo.defaultBranch === '') throw new ApiError(400, 'github_no_default_branch', '这个仓没有默认分支');
    let testCommand: string;
    try {
      testCommand = await portOf(deps).readTestCommand(fresh.token.accessToken, repo);
    } catch (err) {
      throw new ApiError(400, 'github_no_test_command', messageOf(err));
    }
    const imported = await deps.store.importRepo(
      {
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        testCommand,
      },
      {
        actor: actorOf(c),
        action: REPO_IMPORT,
        target: `github:${repo.owner}/${repo.name}`,
        reason: '驾驶舱上点了加进',
        via: c.get('via'),
        ok: true,
      },
    );
    return reply(c, ImportRepoResponse, {
      repoId: imported.repo.id,
      owner: imported.repo.owner,
      name: imported.repo.name,
      defaultBranch: imported.repo.defaultBranch,
      testCommand: imported.repo.testCommand,
      autoDispatch: false,
      created: imported.created,
    });
  });

  app.delete(WebRoutes.removeRepo.path, async (c) => {
    const repoId = c.req.param('repoId');
    const result = await deps.store.removeRepo(repoId, {
      actor: actorOf(c),
      action: REPO_REMOVE,
      target: `repo:${repoId}`,
      reason: '驾驶舱上点了移出',
      via: c.get('via'),
    });
    if (result === 'not_found') throw new ApiError(404, 'repo_not_found', '没有这个项目');
    if (result.status === 'in_use') {
      throw new ApiError(
        409,
        'repo_in_use',
        `这个仓在驾驶舱里还有任务、PR 或提醒跟进，移不出去（任务 ${result.tasks}、PR ${result.pulls}、提醒 ${result.alerts}）。历史没删。`,
      );
    }
    return reply(c, RemoveRepoResponse, { removed: true, owner: result.owner, name: result.name });
  });
}

export function registerGithubOAuthRoutes(app: Hono<CockpitEnv>, deps: Deps): void {
  app.get('/github/callback', async (c) => {
    const saved = takeGithubOAuthState(c, deps.config, deps.now());
    const session = readSession(c, deps.config, deps.now());
    const state = c.req.query('state');
    if (!saved || !session || saved.uid !== session.uid || saved.state !== state) {
      return c.redirect(back(deps, 'state'), 302);
    }
    const error = c.req.query('error');
    const code = c.req.query('code');
    const repo = saved.owner && saved.name ? { owner: saved.owner, name: saved.name } : undefined;
    if (error || !code) {
      if (repo) await auditInstall(deps, session.uid, repo, saved.role, false, error || '没有授权码');
      return c.redirect(back(deps, 'exchange_failed'), 302);
    }
    try {
      const token = await portOf(deps).exchange({
        role: saved.role,
        code,
        redirectUri: callbackUri(deps),
        codeVerifier: saved.verifier,
      });
      const githubLogin = await portOf(deps).login(token.accessToken);
      const savedToken: GithubUserToken = {
        userId: session.uid,
        role: saved.role,
        githubLogin,
        accessToken: token.accessToken,
        ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
        ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      };
      remember(savedToken);
      await deps.store.saveGithubToken(savedToken);
      if (!repo) {
        try {
          const seen = await portOf(deps).installations(token.accessToken);
          // 一个安装都没有时，列仓是空的。接着去 GitHub 让人选账号和仓，选完才列得出来。
          if (seen.length === 0) {
            return c.redirect(accountInstallRedirect(c, deps, session.uid, saved.role), 302);
          }
        } catch {
          // 列安装失败仍算连上了，列表接口会把原因写出来。
        }
        return c.redirect(back(deps, 'connected'), 302);
      }
    } catch (err) {
      if (repo) await auditInstall(deps, session.uid, repo, saved.role, false, messageOf(err));
      return c.redirect(back(deps, 'exchange_failed'), 302);
    }
    try {
      const agent = await freshToken(deps, session.uid, 'agent');
      if (agent.kind !== 'ok') return c.redirect(startOauth(c, deps, session.uid, 'agent', repo), 302);
      const visible = await listedRepo(deps, agent.token.accessToken, repo.owner, repo.name);
      const result = await ensureInstalled(c, deps, session.uid, visible);
      if (!result.installed) return c.redirect(result.redirect, 302);
      return c.redirect(back(deps, 'ok'), 302);
    } catch (err) {
      await auditInstall(deps, session.uid, repo, saved.role, false, messageOf(err));
      return c.redirect(back(deps, 'install_failed'), 302);
    }
  });

  app.get('/github/setup', async (c) => {
    const saved = takeGithubOAuthState(c, deps.config, deps.now());
    const session = readSession(c, deps.config, deps.now());
    const state = c.req.query('state');
    if (!saved || !session || saved.uid !== session.uid || saved.state !== state) {
      return c.redirect(back(deps, 'state'), 302);
    }
    if (!saved.owner || !saved.name) {
      if (c.req.query('setup_action') === 'request') return c.redirect(back(deps, 'install_failed'), 302);
      return c.redirect(back(deps, 'connected'), 302);
    }
    const repo = { owner: saved.owner, name: saved.name };
    if (c.req.query('setup_action') === 'request') {
      await auditInstall(deps, session.uid, repo, saved.role, false, ORG_APP_APPROVAL_NOTE);
      return c.redirect(back(deps, 'install_failed'), 302);
    }
    try {
      const agent = await freshToken(deps, session.uid, 'agent');
      if (agent.kind !== 'ok') return c.redirect(startOauth(c, deps, session.uid, 'agent', repo), 302);
      const visible = await listedRepo(deps, agent.token.accessToken, repo.owner, repo.name);
      const result = await ensureInstalled(c, deps, session.uid, visible);
      if (!result.installed) return c.redirect(result.redirect, 302);
      return c.redirect(back(deps, 'ok'), 302);
    } catch (err) {
      await auditInstall(deps, session.uid, repo, saved.role, false, messageOf(err));
      return c.redirect(back(deps, 'install_failed'), 302);
    }
  });
}
