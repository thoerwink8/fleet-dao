// 导入列表的数据从哪来：安装令牌读 GET /installation/repositories，不用用户 OAuth。
import { describe, expect, it } from 'vitest';
import { listInstallationRepositories } from '../src/installation-repos.ts';
import { OWNER, REPO } from './fake-github.ts';
import { setup } from './helpers.ts';

describe('安装令牌列仓', () => {
  it('用安装令牌读 /installation/repositories，令牌不限定单个仓', async () => {
    const { gh, fake } = setup();
    const repos = await listInstallationRepositories(gh.client, 'agent');
    expect(repos).toEqual([
      {
        id: 4242,
        owner: OWNER,
        name: REPO,
        fullName: `${OWNER}/${REPO}`,
        private: false,
        defaultBranch: 'main',
        ownerType: 'Organization',
        archived: false,
        empty: false,
      },
    ]);
    expect(fake.calls('GET', /^\/app\/installations$/).map((r) => r.as)).toEqual(['app:agent']);
    const mint = fake.calls('POST', /\/access_tokens$/)[0];
    expect(mint?.as).toBe('app:agent');
    expect(mint?.body).toEqual({ permissions: { metadata: 'read' } });
    expect(mint?.body).not.toHaveProperty('repositories');
    const listed = fake.calls('GET', /^\/installation\/repositories$/);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.as).toBe('agent');
  });

  it('这个机器人一个安装都没有：空列表，不去读 /installation/repositories', async () => {
    const { gh, fake } = setup();
    fake.installed.engine = false;
    await expect(listInstallationRepositories(gh.client, 'engine')).resolves.toEqual([]);
    expect(fake.calls('GET', /^\/installation\/repositories$/)).toHaveLength(0);
    expect(fake.calls('POST', /\/access_tokens$/)).toHaveLength(0);
  });
});
