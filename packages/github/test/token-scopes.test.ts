// 安装令牌按用途降权（#11）：git 用的令牌没有多余的权限，administration 只在续互动限制那一枚里，授权没勾的不请求。
import { describe, expect, it } from 'vitest';
import { REQUIRED_PERMISSIONS } from '../src/github.ts';
import { narrowToGranted, requiredPermissions, scopePermissions, TOKEN_SCOPES } from '../src/token-scopes.ts';
import { json, repo, setup } from './helpers.ts';

const mintBodies = (fake: ReturnType<typeof setup>['fake']) =>
  fake.calls('POST', /access_tokens$/).map((r) => r.body as { repositories: string[]; permissions?: object });

describe('令牌用途表', () => {
  it('git 用的令牌（git / git-read）只有 contents 和 metadata，没有 administration、issues、workflows', () => {
    for (const scope of ['git', 'git-read'] as const) {
      expect(Object.keys(scopePermissions('agent', scope)).sort()).toEqual(['contents', 'metadata']);
    }
    expect(scopePermissions('agent', 'git')).toEqual({ contents: 'write', metadata: 'read' });
    expect(scopePermissions('agent', 'git-read')).toEqual({ contents: 'read', metadata: 'read' });
  });

  it('administration 只在 engine 的 admin 里；没有任何别的用途带它，也没有用途带 workflows', () => {
    for (const [role, scopes] of Object.entries(TOKEN_SCOPES)) {
      for (const [scope, set] of Object.entries(scopes)) {
        expect(Object.keys(set ?? {}), `${role}/${scope}`).not.toContain('workflows');
        if (role === 'engine' && scope === 'admin') continue;
        expect(Object.keys(set ?? {}), `${role}/${scope}`).not.toContain('administration');
      }
    }
    expect(scopePermissions('engine', 'admin')).toEqual({ administration: 'write', metadata: 'read' });
  });

  it('自检要的权限 = 各用途的并集，值和改之前一模一样（没悄悄缩，也没悄悄放大）', () => {
    expect(REQUIRED_PERMISSIONS).toEqual({
      agent: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      engine: {
        contents: 'write',
        pull_requests: 'write',
        issues: 'write',
        administration: 'write',
        checks: 'read',
        actions: 'read',
        statuses: 'write',
        metadata: 'read',
      },
    });
    expect(requiredPermissions('agent')).toEqual(REQUIRED_PERMISSIONS.agent);
  });

  it('没定义的身份 + 用途组合报错，不兜底成「全部权限」', () => {
    expect(() => scopePermissions('engine', 'git')).toThrowError(/没有「git」这种令牌用途/);
    expect(() => scopePermissions('agent', 'admin')).toThrowError(/没有「admin」这种令牌用途/);
  });

  it('narrowToGranted：没授的项丢掉，装的等级低就跟着降，装的是 admin 级照要的请求', () => {
    expect(
      narrowToGranted(
        { contents: 'write', issues: 'write', statuses: 'write', metadata: 'read', checks: 'read' },
        { contents: 'read', statuses: 'write', metadata: 'read', checks: 'admin' },
      ),
    ).toEqual({ contents: 'read', statuses: 'write', metadata: 'read', checks: 'read' });
  });
});

describe('换令牌时请求体里写明权限', () => {
  it('引擎日常的令牌没有 administration，且按用途请求的恰好是那几项', async () => {
    const { gh, fake } = setup();
    await gh.client.request({ method: 'GET', path: '/repos/acme/widgets', auth: { as: 'engine', repo } });
    expect(mintBodies(fake)).toEqual([
      {
        repositories: ['widgets'],
        permissions: {
          contents: 'write',
          pull_requests: 'write',
          issues: 'write',
          checks: 'read',
          actions: 'read',
          statuses: 'write',
          metadata: 'read',
        },
      },
    ]);
    const call = fake.calls('GET', /^\/repos\/acme\/widgets$/)[0];
    expect(call?.grants?.administration).toBeUndefined();
  });

  it('续互动限制单独换一枚 admin 令牌（只有 administration 写 + metadata 读），和日常令牌不混用、各缓存各的', async () => {
    const { gh, fake } = setup();
    await gh.client.request({ method: 'GET', path: '/repos/acme/widgets', auth: { as: 'engine', repo } });
    expect(await gh.renewInteractionLimit({ repo })).toMatchObject({ action: 'set' });
    expect(mintBodies(fake).at(-1)).toEqual({
      repositories: ['widgets'],
      permissions: { administration: 'write', metadata: 'read' },
    });
    // 互动限制的请求（读、写、回读）都是 admin 令牌发的，日常请求不是
    for (const r of fake
      .calls('GET', /interaction-limits$/)
      .concat(fake.calls('PUT', /interaction-limits$/))) {
      expect(r.grants).toEqual({ administration: 'write', metadata: 'read' });
    }
    // 再来一轮：两种令牌都命中缓存，不再多换
    const minted = fake.tokensMinted;
    await gh.client.request({ method: 'GET', path: '/repos/acme/widgets', auth: { as: 'engine', repo } });
    await gh.renewInteractionLimit({ repo });
    expect(fake.tokensMinted).toBe(minted);
  });

  it('装上的授权里没有的项不请求：令牌照样换得出来，缺的那项对应的调用自己 403', async () => {
    const { gh, fake } = setup();
    fake.permissions.engine = {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
    };
    await gh.client.request({ method: 'GET', path: '/repos/acme/widgets', auth: { as: 'engine', repo } });
    expect(mintBodies(fake)[0]?.permissions).toEqual({
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
    });
  });

  it('授权后来补上了：下一次换令牌就带上（不靠重启）', async () => {
    const { gh, fake, clock } = setup();
    fake.permissions.engine = {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
    };
    await gh.client.request({ method: 'GET', path: '/repos/acme/widgets', auth: { as: 'engine', repo } });
    fake.permissions.engine = { ...fake.permissions.engine, statuses: 'write' };
    clock.advance(55 * 60_000);
    await gh.client.request({ method: 'GET', path: '/repos/acme/widgets', auth: { as: 'engine', repo } });
    expect(mintBodies(fake)[1]?.permissions).toMatchObject({ statuses: 'write' });
  });

  it('admin 用途要的权限装上的一项都没有：报 FORBIDDEN，不发互动限制的请求，也不拿日常令牌顶', async () => {
    const { gh, fake } = setup();
    fake.permissions.engine = { contents: 'write', pull_requests: 'write', issues: 'write' };
    // metadata 没授：admin 用途要的两项（administration、metadata）都不在装上的授权里
    await expect(gh.renewInteractionLimit({ repo })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fake.calls('GET', /interaction-limits$/)).toHaveLength(0);
    expect(fake.calls('PUT', /interaction-limits$/)).toHaveLength(0);
  });

  it('只有 metadata 没有 administration：admin 令牌只带 metadata，互动限制接口 403（报出来，不静默）', async () => {
    const { gh, fake } = setup();
    fake.permissions.engine = { contents: 'write', metadata: 'read' };
    await expect(gh.renewInteractionLimit({ repo })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mintBodies(fake)[0]?.permissions).toEqual({ metadata: 'read' });
    expect(fake.calls('PUT', /interaction-limits$/)).toHaveLength(0);
  });

  it('读不到授权表时按用途要的请求；GitHub 回 422「权限没授」报成 FORBIDDEN 并写明请求了什么，不当成没装', async () => {
    const { gh, fake } = setup();
    fake.permissions.engine = { contents: 'write', metadata: 'read' };
    // 安装查询不回 permissions：没法先收窄，多要的由 GitHub 来拒
    fake.before.push((req) =>
      req.method === 'GET' && /\/installation$/.test(req.path) ? json(200, { id: 22 }) : undefined,
    );
    await expect(
      gh.client.request({ method: 'GET', path: '/repos/acme/widgets', auth: { as: 'engine', repo } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 422 });
  });
});
