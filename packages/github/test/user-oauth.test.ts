// 驾驶舱「导入仓库」用的纯函数：把 GitHub 的仓列表、测试命令、授权地址、令牌回应、安装计划
// 从 HTTP 里拆出来。这里不发请求。
import { describe, expect, it } from 'vitest';
import {
  authorizeUrl,
  installPlan,
  newInstallationUrl,
  parseAccessToken,
  parseInstallationList,
  parseRepoPage,
  testCommandFromRepo,
} from '../src/user-oauth.ts';

const repo = (over: Record<string, unknown> = {}) => ({
  id: 11,
  name: 'notes',
  default_branch: 'main',
  permissions: { admin: true },
  owner: { login: 'Person', id: 9, type: 'User' },
  ...over,
});

describe('parseRepoPage', () => {
  it('个人仓和组织仓分开认，管理权限照 permissions.admin', () => {
    const parsed = parseRepoPage([
      repo(),
      repo({
        id: 12,
        name: 'kit',
        default_branch: 'trunk',
        permissions: { admin: false, push: true },
        owner: { login: 'Org-Example', id: 3, type: 'Organization' },
      }),
    ]);
    expect(parsed).toEqual({
      ok: true,
      repos: [
        {
          id: 11,
          owner: 'Person',
          name: 'notes',
          ownerKind: 'user',
          accountId: 9,
          defaultBranch: 'main',
          canAdmin: true,
        },
        {
          id: 12,
          owner: 'Org-Example',
          name: 'kit',
          ownerKind: 'org',
          accountId: 3,
          defaultBranch: 'trunk',
          canAdmin: false,
        },
      ],
    });
  });

  it('缺编号、名字或属主的条目丢掉；没有默认分支留空，不编一个 main', () => {
    const parsed = parseRepoPage([
      repo({ id: undefined }),
      repo({ name: '' }),
      repo({ owner: { login: 'Person', type: 'User' } }),
      repo({ id: 4, name: 'empty', default_branch: undefined }),
    ]);
    expect(parsed).toEqual({
      ok: true,
      repos: [
        {
          id: 4,
          owner: 'Person',
          name: 'empty',
          ownerKind: 'user',
          accountId: 9,
          defaultBranch: '',
          canAdmin: true,
        },
      ],
    });
  });

  it('不是数组就认不出，不当成一个仓都没有', () => {
    expect(parseRepoPage({ message: 'bad' })).toEqual({ ok: false, reason: '仓列表不是数组' });
  });
});

describe('testCommandFromRepo', () => {
  it('有 test 脚本时按锁文件写成对应的包管理器 test', () => {
    expect(
      testCommandFromRepo({
        packageJson: JSON.stringify({ scripts: { test: 'vitest run' } }),
        names: ['package.json', 'pnpm-lock.yaml'],
      }),
    ).toEqual({ ok: true, command: 'pnpm test' });
    expect(
      testCommandFromRepo({
        packageJson: JSON.stringify({ scripts: { test: 'vitest run' } }),
        names: ['yarn.lock'],
      }),
    ).toEqual({ ok: true, command: 'yarn test' });
    expect(
      testCommandFromRepo({
        packageJson: JSON.stringify({ scripts: { test: 'vitest run' } }),
        names: ['package-lock.json'],
      }),
    ).toEqual({ ok: true, command: 'npm test' });
    expect(
      testCommandFromRepo({
        packageJson: JSON.stringify({ scripts: { check: 'tsc -b' } }),
        names: ['bun.lock'],
      }),
    ).toEqual({ ok: true, command: 'bun check' });
  });

  it('packageManager 优先于锁文件；脚本自己已经带了运行器就原样用', () => {
    expect(
      testCommandFromRepo({
        packageJson: JSON.stringify({ packageManager: 'yarn@1.22.19', scripts: { test: 'vitest' } }),
        names: ['pnpm-lock.yaml'],
      }),
    ).toEqual({ ok: true, command: 'yarn test' });
    expect(
      testCommandFromRepo({
        packageJson: JSON.stringify({ scripts: { test: 'pnpm test --filter web' } }),
        names: [],
      }),
    ).toEqual({ ok: true, command: 'pnpm test --filter web' });
  });

  it('认不出包管理器就不编 pnpm test；JSON 坏了、没有脚本也说认不出', () => {
    expect(
      testCommandFromRepo({
        packageJson: JSON.stringify({ scripts: { test: 'vitest' } }),
        names: [],
      }).ok,
    ).toBe(false);
    expect(testCommandFromRepo({ packageJson: '{', names: [] })).toEqual({
      ok: false,
      reason: 'package.json 认不出',
    });
    expect(
      testCommandFromRepo({
        packageJson: JSON.stringify({ name: 'x' }),
        names: ['Makefile'],
        makefile: 'test:\n\techo hi\n',
      }).ok,
    ).toBe(false);
  });

  it('没有 package.json 时，Makefile 里有 test 目标才用 make test', () => {
    expect(
      testCommandFromRepo({ packageJson: null, names: ['Makefile'], makefile: 'build:\n\techo x\n' }).ok,
    ).toBe(false);
    expect(
      testCommandFromRepo({ packageJson: null, names: ['Makefile'], makefile: 'test:\n\techo hi\n' }),
    ).toEqual({ ok: true, command: 'make test' });
  });
});

describe('authorizeUrl', () => {
  it('带上 PKCE，地址只在 github.com，不带 client_secret', () => {
    const url = authorizeUrl({
      clientId: 'Iv1.x',
      redirectUri: 'https://cockpit.example.test/auth/github/callback',
      state: 'state-token-value',
      codeChallenge: 'challenge-value',
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://github.com');
    expect(parsed.pathname).toBe('/login/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('Iv1.x');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(parsed.searchParams.get('state')).toBe('state-token-value');
    expect(url).not.toContain('client_secret');
    expect(url).not.toContain('sec-value');
  });
});

describe('parseAccessToken', () => {
  it('读出访问令牌和刷新令牌', () => {
    expect(
      parseAccessToken({ access_token: 'tok-agent', refresh_token: 'tok-refresh', expires_in: 60 }),
    ).toEqual({ ok: true, accessToken: 'tok-agent', refreshToken: 'tok-refresh', expiresIn: 60 });
  });

  it('失败原因里不留下令牌原文', () => {
    const parsed = parseAccessToken({
      error: 'bad_verification_code',
      error_description: 'rejected tok-agent',
      access_token: 'tok-agent',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).not.toContain('tok-agent');
      expect(parsed.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('安装计划', () => {
  const target = { id: 11, accountId: 9, owner: 'Person' };

  it('账号上已有这个 App 的安装就走 PUT', () => {
    const list = parseInstallationList({
      installations: [
        {
          id: 70,
          account: { login: 'person', id: 9, type: 'User' },
          repository_selection: 'selected',
        },
      ],
    });
    expect(list).toEqual({
      ok: true,
      installations: [{ id: 70, accountLogin: 'person', accountId: 9, repositorySelection: 'selected' }],
    });
    expect(
      installPlan({
        slug: 'fleet-dao-agent',
        repo: target,
        installations: list.ok ? list.installations : [],
        state: 'st',
      }),
    ).toEqual({ kind: 'put', installationId: 70 });
  });

  it('装了全部仓就不用再把单个仓加进去', () => {
    const plan = installPlan({
      slug: 'fleet-dao-agent',
      repo: target,
      installations: [{ id: 70, accountLogin: 'person', accountId: 9, repositorySelection: 'all' }],
      state: 'st',
    });
    expect(plan).toEqual({ kind: 'covered', installationId: 70 });
  });

  it('还没有安装就给出安装页地址，带上这一个仓', () => {
    const plan = installPlan({ slug: 'fleet-dao-agent', repo: target, installations: [], state: 'st' });
    expect(plan.kind).toBe('browser');
    if (plan.kind !== 'browser') return;
    const url = new URL(plan.url);
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/apps/fleet-dao-agent/installations/new/permissions');
    expect(url.searchParams.get('target_id')).toBe('9');
    expect(url.searchParams.getAll('repository_ids[]')).toEqual(['11']);
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('还没装到任何账号时，安装页不预选仓', () => {
    const url = new URL(newInstallationUrl({ slug: 'fleet-dao-agent', state: 'st' }));
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/apps/fleet-dao-agent/installations/new');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.has('repository_ids[]')).toBe(false);
  });

  it('安装范围既不是 all 也不是 selected 时整份认不出', () => {
    expect(
      parseInstallationList({
        installations: [{ id: 1, account: { login: 'a', id: 2 }, repository_selection: 'custom' }],
      }),
    ).toEqual({ ok: false, reason: '认不出的安装范围' });
  });
});
