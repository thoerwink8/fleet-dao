// 设置页「仓库」一节的「导入仓库」（#1989）：列本人 GitHub 上看得见的仓、把仓接进/移出驾驶舱、
// 把两个 App 一键装到某个仓、连接/断开本人 GitHub 授权。
//
// 身份那一半（列仓、装 App）走本人 OAuth 用户令牌：GitHub 只认本人令牌，App 机器人令牌看不到别人的个人仓。
// 令牌密文存 github_tokens（api 的 github-token.ts 加密），明文只在内存里过一下，不进日志、不进接口返回。
//
// 分工：
// - 「接进/移出驾驶舱」只动我们自己的 repos 表（store.addRepo / removeRepo），记操作记录；
// - 「装 App」调 GitHub 的 PUT /user/installations/{id}/repositories（本人身份）；
// - 「连接 GitHub」走 OAuth 网页流（auth.ts 那套 state/PKCE 的简化版，GitHub 用 client_secret）。

import {
  DisconnectGitHubResponse,
  GITHUB_INSTALL_REPO,
  GITHUB_OAUTH_CONNECT,
  GITHUB_OAUTH_DISCONNECT,
  type ImportableRepo,
  ImportableReposResponse,
  ImportRepoRequest,
  ImportRepoResponse,
  InstallAppRequest,
  InstallAppResponse,
  REPO_IMPORT_ADD,
  REPO_IMPORT_REMOVE,
  RemoveRepoResponse,
  WebRoutes,
} from '@fleet-dao/shared';
import type { Context, Hono } from 'hono';
import type { Deps } from './deps.ts';
import { decryptToken, encryptToken, GitHubTokenCipherError } from './github-token.ts';
import type { GitHubAppRole, GitHubUserPort } from './github-user.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { Actor } from './ports.ts';
import { type CockpitEnv, saveRepoOAuthState, takeRepoOAuthState } from './session.ts';
import { randomToken, safeEqual } from './tokens.ts';

/** 这个人某一边 App 的令牌明文（只在内存里用一下）。 */
async function tokenOf(deps: Deps, userId: string, role: GitHubAppRole): Promise<string | null> {
  const row = await deps.store.getGitHubToken(userId, role);
  if (!row) return null;
  try {
    return decryptToken(row.accessTokenCipher, deps.config.sessionSecret);
  } catch (err) {
    if (err instanceof GitHubTokenCipherError) {
      // 存的那份读不出来（换过会话密钥、数据被动过）：不当成「没连过」，说清要重连。
      throw new ApiError(409, 'github_token_unreadable', '存着的 GitHub 授权读不出来了，请重新连接', {
        why: err.message,
      });
    }
    throw err;
  }
}

/** 把 GitHub 回的分页结果里一个仓映射成页面用的形状。installations 两个 App 各一遍，去重后合并。 */
function toImportable(
  repo: {
    id: number;
    owner: string;
    name: string;
    fullName: string;
    private: boolean;
    defaultBranch: string;
    ownerType: 'User' | 'Organization';
    viewerCanAdmin: boolean;
    archived: boolean;
    empty: boolean;
  },
  installed: { agent: boolean; engine: boolean },
  cockpit: { inCockpit: boolean; reposId?: string | undefined },
): ImportableRepo {
  const fullyInstalled = installed.agent && installed.engine;
  // 能不能本人一键装：要本人是这个仓的 admin；组织仓还要组织批准过这个 App（那条 GitHub 那边才判得准，
  // 这里先按 admin 给「能装」），空仓和归档仓不给接（没代码可派活 / 已归档）。
  const blocked = repo.empty
    ? '空仓：没有代码，接进来也没有活可派'
    : repo.archived
      ? '已归档：不再改动'
      : !repo.viewerCanAdmin
        ? repo.ownerType === 'Organization'
          ? '要组织管理员先批准这个 App（你在这个组织里没有 admin）'
          : '你对这个仓没有 admin 权限'
        : undefined;
  return {
    githubId: repo.id,
    owner: repo.owner,
    name: repo.name,
    fullName: repo.fullName,
    private: repo.private,
    defaultBranch: repo.defaultBranch,
    ownerType: repo.ownerType,
    viewerCanAdmin: repo.viewerCanAdmin,
    archived: repo.archived,
    empty: repo.empty,
    agentInstalled: installed.agent,
    engineInstalled: installed.engine,
    fullyInstalled,
    inCockpit: cockpit.inCockpit,
    ...(cockpit.reposId === undefined ? {} : { reposId: cockpit.reposId }),
    canInstall: blocked === undefined && !fullyInstalled,
    ...(blocked === undefined ? {} : { installBlockedWhy: blocked }),
  };
}

export function registerRepoImportRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: Context<CockpitEnv>) => Actor,
): void {
  const { store } = deps;

  /**
   * 这台后端的 GitHub 身份那一套。读接口（GET importableRepos）没接上时按本仓约定回 200 + 一句原因，
   * 不拿 503 让页面读不出形状；写接口没接上时回 503（写不成就是写不成，别装成写过了）。
   */
  function portOrNull(): GitHubUserPort | null {
    return deps.githubUser ?? null;
  }
  function port(): GitHubUserPort {
    const p = portOrNull();
    if (!p) {
      throw new ApiError(
        503,
        'github_user_unavailable',
        '这台后端没接上 GitHub（机器人凭据没读到），导入仓库用不了',
      );
    }
    return p;
  }

  /** 读这个人存着的那份授权状态（不解密，只报有没有、能不能解）。 */
  async function authState(userId: string) {
    const row =
      (await store.getGitHubToken(userId, 'agent')) ?? (await store.getGitHubToken(userId, 'engine'));
    if (!row) return { connected: false as const };
    try {
      decryptToken(row.accessTokenCipher, deps.config.sessionSecret);
    } catch (err) {
      return {
        connected: true as const,
        login: row.login,
        scopes: row.scopes,
        connectedAt: row.updatedAt,
        unreadable: true,
        unreadableWhy: err instanceof GitHubTokenCipherError ? err.message : String(err),
      };
    }
    return {
      connected: true as const,
      login: row.login,
      scopes: row.scopes,
      connectedAt: row.updatedAt,
    };
  }

  app.get(WebRoutes.importableRepos.path, async (c) => {
    const userId = c.get('user').id;
    // 这台后端没接上 GitHub：回 200 + 一句原因（页面照 reason 画，不给一个点了没反应的「连接」按钮）。
    const p = portOrNull();
    if (!p) {
      return reply(c, ImportableReposResponse, {
        auth: { connected: false },
        repos: [],
        reason: '这台后端没接上 GitHub（机器人凭据没读到），导入仓库用不了',
      });
    }
    const auth = await authState(userId);
    if (!auth.connected) {
      return reply(c, ImportableReposResponse, { auth, repos: [] });
    }
    let agentToken: string | null;
    let engineToken: string | null;
    try {
      agentToken = await tokenOf(deps, userId, 'agent');
      engineToken = await tokenOf(deps, userId, 'engine');
    } catch (err) {
      if (err instanceof ApiError) {
        // 读不出来：页面上按「要重连」处理，不把整个列表读失败。
        return reply(c, ImportableReposResponse, {
          auth: { ...auth, unreadable: true, unreadableWhy: String(err.details) },
          repos: [],
          reason: '存着的 GitHub 授权读不出来，请断开后重新连接',
        });
      }
      throw err;
    }
    // 列仓两边的令牌都能用。装没装必须用那一边自己的令牌：GitHub 只让它看见自己那个 App。
    const token = agentToken ?? engineToken;
    if (!token) return reply(c, ImportableReposResponse, { auth, repos: [] });

    // 令牌文件里的 client_id/client_secret 没配好：连接那一步会失败，这里先如实说。
    if (!p.configured()) {
      return reply(c, ImportableReposResponse, {
        auth,
        repos: [],
        reason: '这台后端的 GitHub App 凭据里缺 client_id/client_secret，列仓和装 App 都用不了',
      });
    }

    let repos: Awaited<ReturnType<GitHubUserPort['listRepos']>>;
    let agentInstalls: Awaited<ReturnType<GitHubUserPort['installationsForApp']>>;
    let engineInstalls: Awaited<ReturnType<GitHubUserPort['installationsForApp']>>;
    try {
      // 三件事并行：列仓、两个 App 各自的安装（按 owner 认）。没有那一边的令牌就当没装。
      [repos, agentInstalls, engineInstalls] = await Promise.all([
        p.listRepos(token),
        agentToken ? p.installationsForApp('agent', agentToken) : Promise.resolve(new Map()),
        engineToken ? p.installationsForApp('engine', engineToken) : Promise.resolve(new Map()),
      ]);
    } catch (err) {
      // 令牌被撤了（401）：删掉库里那份，提示重连——不把一串报错抛给页面。
      if (isUnauthorized(err)) {
        await store.deleteGitHubToken(userId);
        return reply(c, ImportableReposResponse, {
          auth: { connected: false },
          repos: [],
          reason: 'GitHub 说这份授权已失效（可能你在 GitHub 上撤了），已清掉，请重新连接',
        });
      }
      throw err;
    }

    // 两个 App 各自的安装覆盖了哪些仓：按 owner 找安装，再读该安装能访问的仓编号。
    // selection=all 时这个账号下的仓都算装了，不用再去问仓编号（再 PUT 单个仓 GitHub 会拒）。
    const cockpitRows = await store.listRepos();
    const cockpitByName = new Map(cockpitRows.map((r) => [`${r.owner}/${r.name}`.toLowerCase(), r.id]));

    const installedIds = new Map<number, { agent: boolean; engine: boolean }>();
    await Promise.all(
      repos.map(async (repo) => {
        const key = repo.owner.toLowerCase();
        const agentInstall = agentInstalls.get(key);
        const engineInstall = engineInstalls.get(key);
        const [agentIds, engineIds] = await Promise.all([
          agentInstall === undefined || agentInstall.selection === 'all' || !agentToken
            ? Promise.resolve(new Set<number>())
            : p.installationRepoIds(agentToken, agentInstall.id),
          engineInstall === undefined || engineInstall.selection === 'all' || !engineToken
            ? Promise.resolve(new Set<number>())
            : p.installationRepoIds(engineToken, engineInstall.id),
        ]);
        installedIds.set(repo.id, {
          agent: agentInstall?.selection === 'all' || agentIds.has(repo.id),
          engine: engineInstall?.selection === 'all' || engineIds.has(repo.id),
        });
      }),
    );

    const items = repos.map((repo) => {
      const installed = installedIds.get(repo.id) ?? { agent: false, engine: false };
      const reposId = cockpitByName.get(repo.fullName.toLowerCase());
      return toImportable(repo, installed, {
        inCockpit: reposId !== undefined,
        ...(reposId === undefined ? {} : { reposId }),
      });
    });

    return reply(c, ImportableReposResponse, { auth, repos: items });
  });

  app.post(WebRoutes.importRepo.path, async (c) => {
    const userId = c.get('user').id;
    const body = await readJson(c, ImportRepoRequest);
    const p = port();
    const token = (await tokenOf(deps, userId, 'agent')) ?? (await tokenOf(deps, userId, 'engine'));
    if (!token) throw new ApiError(409, 'github_not_connected', '还没连接 GitHub，先在页面上连一下');

    // 从本人可见的仓里找这个编号：找不到 = 不是他的仓（或号是编的），不猜。
    const repos = await p.listRepos(token);
    const repo = repos.find((r) => r.id === body.githubId);
    if (!repo) throw new ApiError(404, 'repo_not_visible', '这个仓不在你 GitHub 账号能看到的范围里');

    let testCommand: string;
    try {
      testCommand = await p.readTestCommand(token, {
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '读不到测试命令';
      throw new ApiError(400, 'github_no_test_command', message);
    }

    const result = await store.addRepo(
      {
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        testCommand,
      },
      {
        actor: actorOf(c),
        action: REPO_IMPORT_ADD,
        target: `repo:${repo.fullName.toLowerCase()}`,
        reason: `从驾驶舱导入 ${repo.fullName}`,
        via: c.get('via'),
        ok: true,
      },
    );
    return reply(
      c,
      ImportRepoResponse,
      { repoId: result.repo.id, owner: result.repo.owner, name: result.repo.name, created: result.created },
      result.created ? 201 : 200,
    );
  });

  app.delete(WebRoutes.removeRepo.path, async (c) => {
    const repoId = c.req.param('repoId');
    const repo = await store.getRepo(repoId);
    if (!repo) throw new ApiError(404, 'repo_not_found', '没有这个项目');
    const outcome = await store.removeRepo(
      { repoId },
      {
        actor: actorOf(c),
        action: REPO_IMPORT_REMOVE,
        target: `repo:${repo.owner}/${repo.name}`.toLowerCase(),
        reason: `从驾驶舱移出 ${repo.owner}/${repo.name}`,
        via: c.get('via'),
        ok: true,
      },
    );
    if (outcome === 'not_found') throw new ApiError(404, 'repo_not_found', '没有这个项目');
    if (outcome === 'has_tasks') {
      return reply(c, RemoveRepoResponse, {
        removed: false,
        reason: '这个仓还挂着没结束的需求（排队或在做），先把它们处理掉再移出',
      });
    }
    return reply(c, RemoveRepoResponse, { removed: true });
  });

  app.post(WebRoutes.installAppOnRepo.path, async (c) => {
    const userId = c.get('user').id;
    const body = await readJson(c, InstallAppRequest);
    const p = port();
    const agentToken = await tokenOf(deps, userId, 'agent');
    const engineToken = await tokenOf(deps, userId, 'engine');
    const token = agentToken ?? engineToken;
    if (!token) throw new ApiError(409, 'github_not_connected', '还没连接 GitHub，先在页面上连一下');

    const repos = await p.listRepos(token);
    const repo = repos.find((r) => r.id === body.githubId);
    if (!repo) throw new ApiError(404, 'repo_not_visible', '这个仓不在你 GitHub 账号能看到的范围里');
    if (repo.ownerType === 'Organization' && !repo.viewerCanAdmin) {
      throw new ApiError(
        403,
        'needs_org_admin',
        '这是组织的仓，要组织管理员先批准这个 App，你在这个组织里没有 admin',
      );
    }

    // 两个 App 各用自己的用户令牌。令牌只能看见签发它的那个 App 的安装。
    // 装了「全部仓」时这个仓已经在里面，再 PUT 单个仓 GitHub 会拒。
    const key = repo.owner.toLowerCase();
    const putOne = async (
      role: GitHubAppRole,
      roleToken: string | null,
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const label = role === 'agent' ? '干活的' : '引擎';
      if (!roleToken) return { ok: false, reason: `还没有「${label}」App 的授权，点「一键授权」` };
      const hit = (await p.installationsForApp(role, roleToken)).get(key);
      if (!hit) return { ok: false, reason: `「${label}」App 还没装到你的账号/组织下，先去 GitHub 装一次` };
      if (hit.selection !== 'all') await p.addReposToInstallation(roleToken, hit.id, [repo.id]);
      return { ok: true };
    };
    const agentResult = await putOne('agent', agentToken);
    const engineResult = await putOne('engine', engineToken);
    const agent = agentResult.ok;
    const engine = engineResult.ok;
    const reasons = [agentResult, engineResult].flatMap((r) => (r.ok ? [] : [r.reason]));

    await store.appendAudit({
      actor: actorOf(c),
      action: GITHUB_INSTALL_REPO,
      target: `repo:${repo.fullName.toLowerCase()}`,
      reason: `把 App 装到 ${repo.fullName}`,
      via: c.get('via'),
      ok: reasons.length === 0,
      ...(reasons.length === 0 ? {} : { error: reasons.join('；') }),
    });
    return reply(c, InstallAppResponse, {
      installed: (agent ? 1 : 0) + (engine ? 1 : 0),
      agent,
      engine,
      ...(reasons.length === 0 ? {} : { reason: reasons.join('；') }),
    });
  });

  app.post(WebRoutes.disconnectGitHub.path, async (c) => {
    const userId = c.get('user').id;
    const existing = await store.listGitHubTokens(userId);
    if (existing.length > 0) {
      await store.deleteGitHubToken(userId);
      await store.appendAudit({
        actor: actorOf(c),
        action: GITHUB_OAUTH_DISCONNECT,
        target: `user:${userId}`,
        reason: '断开 GitHub 授权',
        via: c.get('via'),
        ok: true,
      });
    }
    return reply(c, DisconnectGitHubResponse, { disconnected: existing.length > 0 });
  });

  const redirectUri = `${deps.config.publicUrl.origin}/api/github/callback`;

  /** 跳转地址只许 https://github.com。页面上的链接由这里拼，不接请求里带来的网址。 */
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

  /** 去 GitHub 授权页换某一边 App 的用户令牌。githubId 有值时，回来接着把这个仓装进那个 App。 */
  function beginOauth(
    c: Context<CockpitEnv>,
    input: { role: GitHubAppRole; githubId?: number; next: string },
  ): Response {
    const p = port();
    if (!p.configured()) {
      throw new ApiError(
        503,
        'github_app_not_configured',
        '这台后端的 GitHub App 凭据里缺 client_id/client_secret',
      );
    }
    const state = randomToken(16);
    saveRepoOAuthState(
      c,
      deps.config,
      {
        state,
        verifier: randomToken(43),
        next: input.next,
        role: input.role,
        step: 'oauth',
        ...(input.githubId === undefined ? {} : { githubId: input.githubId }),
      },
      deps.now(),
    );
    return c.redirect(onlyGithub(p.authorizeUrl({ redirectUri, state, role: input.role })), 302);
  }

  /**
   * 这一边的令牌已经在手里：把这个仓装进这个 App。
   * 账号上还没有安装时，跳 GitHub 的安装页（Setup URL 再回到 /github/setup）。
   * 「干活的」装完接着去给「引擎」授权，这样一次点击回来两个 App 都在这个仓上。
   */
  async function continueInstall(
    c: Context<CockpitEnv>,
    input: { role: GitHubAppRole; githubId: number; token: string },
  ): Promise<Response> {
    const p = port();
    const userId = c.get('user').id;
    const label = input.role === 'agent' ? '干活的' : '引擎';
    const repos = await p.listRepos(input.token);
    const repo = repos.find((r) => r.id === input.githubId);
    if (!repo) return c.redirect('/settings?github=install_failed#repos', 302);
    if (repo.ownerType === 'Organization' && !repo.viewerCanAdmin) {
      await store.appendAudit({
        actor: { kind: 'user', id: userId },
        action: GITHUB_INSTALL_REPO,
        target: `repo:${repo.fullName.toLowerCase()}`,
        reason: `一键授权 ${repo.fullName} 的「${label}」App`,
        via: c.get('via'),
        ok: false,
        error: '要组织先批准这个 App',
      });
      return c.redirect('/settings?github=install_failed#repos', 302);
    }
    const hit = (await p.installationsForApp(input.role, input.token)).get(repo.owner.toLowerCase());
    if (!hit) {
      const state = randomToken(16);
      saveRepoOAuthState(
        c,
        deps.config,
        {
          state,
          verifier: randomToken(43),
          next: '/settings?github=ok#repos',
          role: input.role,
          step: 'setup',
          githubId: input.githubId,
        },
        deps.now(),
      );
      return c.redirect(
        onlyGithub(
          p.appInstallUrl({
            role: input.role,
            ownerId: repo.ownerId,
            repositoryId: repo.id,
            state,
          }),
        ),
        302,
      );
    }
    if (hit.selection !== 'all') await p.addReposToInstallation(input.token, hit.id, [repo.id]);
    await store.appendAudit({
      actor: { kind: 'user', id: userId },
      action: GITHUB_INSTALL_REPO,
      target: `repo:${repo.fullName.toLowerCase()}`,
      reason: `一键授权把「${label}」App 装到 ${repo.fullName}`,
      via: c.get('via'),
      ok: true,
    });
    if (input.role === 'agent') {
      return beginOauth(c, { role: 'engine', githubId: input.githubId, next: '/settings?github=ok#repos' });
    }
    return c.redirect('/settings?github=ok#repos', 302);
  }

  // —— OAuth 网页流（连接 GitHub / 一键授权）——
  // 挂在驾驶舱接口下（/api/github/…），过登录门：要登进驾驶舱的人才能连自己的 GitHub。
  // 回调地址是 /api/github/callback，安装页回来是 /api/github/setup。GitHub App 上这两条都要登记。
  app.get('/github/connect', (c) => beginOauth(c, { role: 'agent', next: '/settings#repos' }));

  app.get(WebRoutes.githubAuthorize.path, (c) => {
    const raw = c.req.query('githubId');
    const githubId = Number(raw);
    if (!raw || !Number.isSafeInteger(githubId) || githubId <= 0) {
      throw new ApiError(400, 'invalid_request', '缺了要授权的仓');
    }
    return beginOauth(c, { role: 'agent', githubId, next: '/settings?github=ok#repos' });
  });

  app.get('/github/callback', async (c) => {
    const saved = takeRepoOAuthState(c, deps.config, deps.now());
    const state = c.req.query('state');
    if (!saved || saved.step === 'setup' || !state || !safeEqual(state, saved.state)) {
      throw new ApiError(
        400,
        'oauth_state_mismatch',
        '连接状态对不上或已过期（10 分钟内要完成授权），请重新连接',
      );
    }
    if (c.req.query('error')) {
      throw new ApiError(401, 'oauth_denied', '你在 GitHub 授权页取消了授权');
    }
    const code = c.req.query('code');
    if (!code) throw new ApiError(400, 'oauth_no_code', 'GitHub 没有带回授权码，请重新连接');
    const p = port();
    const role = saved.role ?? 'agent';
    const exchanged = await p.exchangeCode({ code, redirectUri, role });
    const who = await p.viewer(exchanged.token);
    const userId = c.get('user').id;
    await store.putGitHubToken({
      userId,
      githubId: who.id,
      login: who.login,
      role,
      accessTokenCipher: encryptToken(exchanged.token, deps.config.sessionSecret),
      scopes: exchanged.scopes,
      expiresAt: exchanged.expiresAt,
    });
    const label = role === 'agent' ? '干活的' : '引擎';
    await store.appendAudit({
      actor: { kind: 'user', id: userId },
      action: GITHUB_OAUTH_CONNECT,
      target: `user:${userId}`,
      reason: `连接 GitHub（${who.login}，${label}）`,
      via: c.get('via'),
      ok: true,
    });
    if (saved.githubId !== undefined) {
      return continueInstall(c, { role, githubId: saved.githubId, token: exchanged.token });
    }
    return c.redirect(saved.next, 302);
  });

  app.get(WebRoutes.githubSetup.path, async (c) => {
    const saved = takeRepoOAuthState(c, deps.config, deps.now());
    const state = c.req.query('state');
    if (saved === null) {
      throw new ApiError(400, 'oauth_state_mismatch', '安装状态对不上或已过期，请重新点「一键授权」');
    }
    if (
      saved.step !== 'setup' ||
      !state ||
      !safeEqual(state, saved.state) ||
      saved.githubId === undefined ||
      saved.role === undefined
    ) {
      throw new ApiError(400, 'oauth_state_mismatch', '安装状态对不上或已过期，请重新点「一键授权」');
    }
    const label = saved.role === 'agent' ? '干活的' : '引擎';
    const userId = c.get('user').id;
    if (c.req.query('setup_action') === 'request') {
      await store.appendAudit({
        actor: { kind: 'user', id: userId },
        action: GITHUB_INSTALL_REPO,
        target: `github:${saved.githubId}`,
        reason: `一键授权「${label}」App`,
        via: c.get('via'),
        ok: false,
        error: '要组织先批准这个 App',
      });
      return c.redirect('/settings?github=install_failed#repos', 302);
    }
    await store.appendAudit({
      actor: { kind: 'user', id: userId },
      action: GITHUB_INSTALL_REPO,
      target: `github:${saved.githubId}`,
      reason: `一键授权：GitHub 安装页把「${label}」App 装上了`,
      via: c.get('via'),
      ok: true,
    });
    if (saved.role === 'agent') {
      return beginOauth(c, { role: 'engine', githubId: saved.githubId, next: '/settings?github=ok#repos' });
    }
    return c.redirect('/settings?github=ok#repos', 302);
  });
}

/** GitHub 回 401 / 令牌失效的判法（@fleet-dao/github 的 GitHubError 形状：code 字段）。 */
function isUnauthorized(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; status?: unknown };
  return e.code === 'FORBIDDEN' || e.status === 401 || e.code === 'UNAUTHORIZED';
}
