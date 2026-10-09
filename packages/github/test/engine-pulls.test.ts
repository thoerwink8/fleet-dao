// 引擎的通用 GitHub 读写口（engine-pulls.ts）：都用「引擎」机器人。没有 statuses 写权限、权限表读不到都明确报错，
// 不当成贴上了；读头上的状态认得出是谁贴的；撤自动合并、关 PR（分支不动）、在 PR 上留言。
import { describe, expect, it } from 'vitest';
import { isGitHubError } from '../src/errors.ts';
import { repo, setup, sha } from './helpers.ts';

const CTX = '认领对得上';

describe('engine-pulls：读 PR', () => {
  it('现读一个 PR：正文、头、作者、自动合并开没开；列开着的 PR 不带关了的', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({
      head: { ref: 'fix/a', sha: sha('a') },
      body: '**需求**：#12',
      auto_merge: true,
      user: fake.human,
    });
    fake.addPull({ head: { ref: 'fix/b', sha: sha('b') }, state: 'closed' });
    const got = await gh.claims.readPull(repo, pr.number);
    expect(got).toMatchObject({
      number: pr.number,
      nodeId: `PR_${pr.number}`,
      state: 'open',
      merged: false,
      body: '**需求**：#12',
      headSha: sha('a'),
      headRef: 'fix/a',
      fromFork: false,
      author: fake.human,
      autoMerge: true,
    });
    expect((await gh.claims.openPulls(repo)).map((p) => p.number)).toEqual([pr.number]);
    const merged = fake.addPull({
      head: { ref: 'fix/merged', sha: sha('m') },
      state: 'closed',
      merged: true,
      merged_at: '2026-10-02T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      body: '**需求**：Refs #139\n',
    });
    fake.addPull({
      head: { ref: 'fix/closed', sha: sha('c') },
      state: 'closed',
      merged: false,
      merged_at: null,
      updated_at: '2026-10-03T00:00:00Z',
    });
    fake.addPull({
      head: { ref: 'fix/old', sha: sha('o') },
      state: 'closed',
      merged: true,
      merged_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
    });
    expect(
      (await gh.claims.listMergedPulls(repo, new Date('2026-09-01T00:00:00Z'))).map((p) => p.number),
    ).toEqual([merged.number]);
    expect(gh.claims.isAgentBot(fake.bots.agent)).toBe(true);
    expect(gh.claims.isAgentBot(fake.human)).toBe(false);
    expect(gh.claims.engineLogin()).toBe('fleet-test-engine[bot]');
  });
});

describe('engine-pulls：提交状态', () => {
  it('以引擎机器人贴；读回最新的一条、认得出是不是引擎贴的', async () => {
    const { gh, fake } = setup();
    expect(await gh.claims.latestStatus(repo, sha('a'), CTX)).toBeNull();
    await gh.claims.setStatus(repo, sha('a'), { context: CTX, state: 'failure', description: '#12 对不上' });
    await gh.claims.setStatus(repo, sha('a'), {
      context: CTX,
      state: 'success',
      description: '#12 对得上',
      targetUrl: 'https://github.test/x',
    });
    expect(fake.calls('POST', /\/statuses\//).map((r) => r.as)).toEqual(['engine', 'engine']);
    expect(await gh.claims.latestStatus(repo, sha('a'), CTX)).toEqual({
      state: 'success',
      description: '#12 对得上',
      byEngine: true,
    });
    // 别人（有推送权限的人）后贴的同名状态：读出来是最新的那条、标明不是引擎贴的
    fake.statuses.push({
      sha: sha('a'),
      context: CTX,
      state: 'success',
      description: '我说行',
      creator: fake.human,
      updated_at: '2026-09-25T12:30:00Z',
    });
    expect(await gh.claims.latestStatus(repo, sha('a'), CTX)).toEqual({
      state: 'success',
      description: '我说行',
      byEngine: false,
    });
  });

  it('【故意造出的失败】安装令牌里没有 statuses 写权限：明确报错、写明怎么改，一条都不贴', async () => {
    const { gh, fake } = setup();
    fake.permissions.engine = { ...fake.permissions.engine, statuses: 'read' };
    const err = await gh.claims
      .setStatus(repo, sha('a'), { context: CTX, state: 'success', description: 'x' })
      .catch((e: unknown) => e);
    expect(isGitHubError(err, 'FORBIDDEN')).toBe(true);
    expect(String((err as Error).message)).toContain('没有 statuses 写权限（现在是 read）');
    expect(fake.calls('POST', /\/statuses\//)).toEqual([]);
    expect(fake.statuses).toEqual([]);
  });

  it('【故意造出的失败】换令牌时 GitHub 没回权限表：读不到有没有权限，不贴', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) =>
      /access_tokens$/.test(req.path)
        ? new Response(
            JSON.stringify({ token: 'ghs_testnoperms1234567890', expires_at: '2026-09-25T13:00:00Z' }),
            {
              status: 201,
            },
          )
        : undefined,
    );
    const err = await gh.claims
      .setStatus(repo, sha('a'), { context: CTX, state: 'success', description: 'x' })
      .catch((e: unknown) => e);
    expect(isGitHubError(err, 'PERMISSIONS_UNKNOWN')).toBe(true);
    expect(fake.statuses).toEqual([]);
  });

  it('【故意造出的失败】状态列表认不出：抛错，不当成没有', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) =>
      /\/statuses$/.test(req.path)
        ? new Response(JSON.stringify({ statuses: [] }), { status: 200 })
        : undefined,
    );
    await expect(gh.claims.latestStatus(repo, sha('a'), CTX)).rejects.toThrow('没查成');
  });
});

describe('engine-pulls：撤自动合并、关 PR、留言', () => {
  it('撤自动合并；关 PR 不删分支；在 PR 上留言同一个 key 只发一次', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'fix/a', sha: sha('a') }, auto_merge: true });
    await gh.claims.disableAutoMerge(repo, { number: pr.number, nodeId: `PR_${pr.number}` });
    expect(fake.pulls.get(pr.number)?.auto_merge).toBe(false);
    await gh.claims.closePull(repo, pr.number);
    expect(fake.pulls.get(pr.number)?.state).toBe('closed');
    expect(fake.calls('DELETE', /\/git\/refs\//)).toEqual([]);
    expect(fake.refs.get('fix/a')).toBe(sha('a'));
    const first = await gh.claims.commentPull(repo, pr.number, 'claim-void:x', '认领作废了');
    const again = await gh.claims.commentPull(repo, pr.number, 'claim-void:x', '认领作废了');
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(fake.pulls.get(pr.number)?.comments).toHaveLength(1);
  });

  it('【故意造出的失败】往 issue 号上留「PR 的话」：拒绝，不写到 issue 上', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    await expect(gh.claims.commentPull(repo, issue.number, 'k', 'x')).rejects.toThrow('不是 PR');
    expect(fake.issues.get(issue.number)?.comments).toEqual([]);
  });
});
