import { describe, expect, it } from 'vitest';
import { createPolicyGitHub } from '../src/policy-source.ts';
import { API } from './fake-github.ts';
import { json, repo, setup, sha } from './helpers.ts';

const identity = { githubId: 123, repo: 'acme/widgets', public: true };
const status = (over: Record<string, unknown> = {}) => ({
  id: 1,
  context: 'fleet-ci-policy-source/pr/7',
  state: 'success',
  creator: { id: 9002, type: 'Bot', login: 'fleet-dao-engine[bot]' },
  url: `${API}/repos/acme/widgets/statuses/${sha('a')}`,
  target_url: `https://policy.example.test/api/public/ci-policy/v1/repos/123?pr=7&head=${sha('a')}`,
  ...over,
});

describe('engine App 策略 source 严格适配', () => {
  it('真实client按installation身份发表并完整分页回读creator/target_url/repo/sha', async () => {
    const { gh, fake } = setup();
    const source = createPolicyGitHub(gh.deps);
    fake.before.push((r) => {
      if (r.path === `/repos/acme/widgets/statuses/${sha('a')}`) return json(201, status());
      if (r.path.includes(`/commits/${sha('a')}/statuses`))
        return r.query.get('page') === '2'
          ? json(200, [status({ id: 2, state: 'failure' })])
          : json(200, [status()], {
              link: `<${API}/repos/acme/widgets/commits/${sha('a')}/statuses?page=2>; rel="next"`,
            });
      return undefined;
    });
    await source.write(repo, identity, sha('a'), {
      context: 'fleet-ci-policy-source/pr/7',
      state: 'success',
      description: 'source',
      targetUrl: String(status().target_url),
    });
    expect(fake.calls('POST', /\/statuses\//).map((r) => r.as)).toEqual(['engine']);
    expect(fake.calls('GET', /\/statuses$/)).toHaveLength(2);
  });
  it.each([
    { creator: { id: 1, type: 'Bot' } },
    { target_url: 'https://other.test/elsewhere' },
    { url: `${API}/repos/other/repo/statuses/${sha('a')}` },
    { state: 'pending' },
  ])('写后回读字段不对不能报成功 %j', async (over) => {
    const { gh, fake } = setup();
    const source = createPolicyGitHub(gh.deps);
    fake.before.push((r) => {
      if (r.path === `/repos/acme/widgets/statuses/${sha('a')}`) return json(201, status());
      if (r.path.includes(`/commits/${sha('a')}/statuses`)) return json(200, [status(over)]);
      return undefined;
    });
    await expect(
      source.write(repo, identity, sha('a'), {
        context: 'fleet-ci-policy-source/pr/7',
        state: 'success',
        description: 'source',
        targetUrl: String(status().target_url),
      }),
    ).rejects.toThrow();
  });
  it.each([
    { state: 'success', creator: { id: 41882, type: 'Bot', login: 'github-actions[bot]' } },
    { state: 'pending', creator: { id: 41882, type: 'Bot', login: 'github-actions[bot]' } },
    { state: 'success' },
    { url: `${API}/repos/acme/widgets/statuses/${sha('b')}` },
    { target_url: 'https://other.test/gate' },
  ])('撤绿必须核同context最新一条，不能回退旧engine pending %j', async (over) => {
    const { gh, fake } = setup();
    const source = createPolicyGitHub(gh.deps);
    const pending = status({ context: 'merge-gate', state: 'pending', target_url: null });
    fake.before.push((r) => {
      if (r.path === `/repos/acme/widgets/statuses/${sha('a')}`) return json(201, pending);
      if (r.path.includes(`/commits/${sha('a')}/statuses`))
        return json(200, [{ ...pending, ...over, id: 2 }, pending]);
      return undefined;
    });
    await expect(
      source.write(repo, identity, sha('a'), {
        context: 'merge-gate',
        state: 'pending',
        description: 'revoke',
      }),
    ).rejects.toThrow();
  });
  it.each([false, true])('撤绿确认必须读全分页，后页失败=%s', async (failPage) => {
    const { gh, fake } = setup();
    const source = createPolicyGitHub(gh.deps);
    const pending = status({ context: 'merge-gate', state: 'pending', target_url: null });
    fake.before.push((r) => {
      if (r.path === `/repos/acme/widgets/statuses/${sha('a')}`) return json(201, pending);
      if (r.path.includes(`/commits/${sha('a')}/statuses`))
        return r.query.get('page') === '2'
          ? json(failPage ? 403 : 200, failPage ? { message: 'page2 unavailable' } : [])
          : json(200, [status({ context: 'unrelated' }), pending], {
              link: `<${API}/repos/acme/widgets/commits/${sha('a')}/statuses?page=2>; rel="next"`,
            });
      return undefined;
    });
    const write = source.write(repo, identity, sha('a'), {
      context: 'merge-gate',
      state: 'pending',
      description: 'revoke',
    });
    if (failPage) await expect(write).rejects.toThrow();
    else await expect(write).resolves.toBeUndefined();
    expect(fake.calls('GET', /\/statuses$/)).toHaveLength(2);
  });
  it('source授权reader仍选最新可信engine，不被其它writer覆盖', async () => {
    const { gh, fake } = setup();
    fake.before.push((r) =>
      r.path.includes(`/commits/${sha('a')}/statuses`)
        ? json(200, [status({ id: 2, creator: { id: 41882, type: 'Bot' } }), status()])
        : undefined,
    );
    expect(
      await createPolicyGitHub(gh.deps).latest(repo, identity, sha('a'), 'fleet-ci-policy-source/pr/7'),
    ).toMatchObject({ id: 1 });
  });
  it('private字段缺失、仓号缺失、跨仓PR均拒绝', async () => {
    for (const raw of [
      { id: 123, full_name: 'acme/widgets' },
      { full_name: 'acme/widgets', private: false },
    ]) {
      const { gh, fake } = setup();
      const source = createPolicyGitHub(gh.deps);
      fake.before.push((r) => (r.path === '/repos/acme/widgets' ? json(200, raw) : undefined));
      await expect(source.repo(repo)).rejects.toThrow('public/private');
    }
    const { gh, fake } = setup();
    const source = createPolicyGitHub(gh.deps);
    fake.before.push((r) =>
      r.path === '/repos/acme/widgets/pulls/7'
        ? json(200, {
            number: 7,
            state: 'open',
            head: { sha: sha('a'), repo: { id: 123, full_name: 'acme/widgets' } },
            base: { repo: { id: 999, full_name: 'other/repo' } },
          })
        : undefined,
    );
    await expect(source.pull(repo, 7, identity)).rejects.toThrow('仓号');
  });
  it('权限表缺statuses:write时不发表，不自行扩权限', async () => {
    const { gh, fake } = setup();
    fake.permissions.engine = { ...fake.permissions.engine, statuses: 'read' };
    await expect(
      createPolicyGitHub(gh.deps).write(repo, identity, sha('a'), {
        context: 'fleet-ci-policy-source/pr/7',
        state: 'success',
        description: 'source',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fake.calls('POST', /\/statuses\//)).toEqual([]);
  });
});
