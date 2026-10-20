// 引擎的通用 GitHub 读写口（engine-pulls.ts）：都用「引擎」机器人。没有 statuses 写权限、权限表读不到都明确报错，
// 不当成贴上了；读头上的状态认得出是谁贴的；撤自动合并、关 PR（分支不动）、在 PR 上留言。
import { describe, expect, it } from 'vitest';
import { isGitHubError } from '../src/errors.ts';
import { API } from './fake-github.ts';
import { json, repo, setup, sha } from './helpers.ts';

const CTX = '认领对得上';

const inlinePath = '/repos/acme/widgets/pulls/7/reviews/99/comments';
const inlineFact = (over: Record<string, unknown> = {}) => ({
  id: 101,
  pull_request_review_id: 99,
  user: { login: 'boss', id: 9, type: 'User' },
  body: '原文\n  保留缩进',
  path: 'src/auth.ts',
  pull_request_url: `${API}/repos/acme/widgets/pulls/7`,
  line: null,
  original_line: null,
  commit_id: sha('a'),
  original_commit_id: sha('b'),
  updated_at: '2026-10-18T00:00:00Z',
  ...over,
});

describe('engine-pulls：正式review行内原文', () => {
  it('真实HTTP逐页读取、只读引擎身份、合法缺失/空位置保留；相同编号去重并按id排稳', async () => {
    const { gh, fake } = setup();
    fake.before.push((r) =>
      r.path !== inlinePath
        ? undefined
        : r.query.get('page') === '2'
          ? json(200, [
              inlineFact(),
              inlineFact({ id: 102, line: 12, side: 'RIGHT', start_line: 10, start_side: 'RIGHT' }),
            ])
          : json(200, [inlineFact({ id: 103 })], {
              link: `<${API}${inlinePath}?per_page=100&page=2>; rel="next"`,
            }),
    );
    const got = await gh.claims.listReviewComments(repo, 7, 99);
    expect(got.map((c) => c.id)).toEqual([101, 102, 103]);
    expect(got[0]).toMatchObject({
      reviewId: 99,
      body: '原文\n  保留缩进',
      line: null,
      originalLine: null,
      side: null,
      startLine: null,
      startSide: null,
    });
    expect(got[1]).toMatchObject({ line: 12, side: 'RIGHT', startLine: 10, startSide: 'RIGHT' });
    expect(fake.calls('GET', /reviews\/99\/comments$/).map((c) => c.as)).toEqual(['engine', 'engine']);
    expect(fake.calls('GET', /reviews\/99\/comments$/)[0]?.query.get('per_page')).toBe('100');
  });

  it.each([
    { body: undefined },
    { body: 7 },
    { pull_request_review_id: 100 },
    { pull_request_url: `${API}/repos/other/widgets/pulls/7` },
    { pull_request_url: `${API}/repos/acme/widgets/pulls/8` },
    { pull_request_url: 'https://other.test/repos/acme/widgets/pulls/7' },
    { user: null },
    { updated_at: 'not-a-date' },
  ])('坏字段或串repo/PR/review明确报没查成：%j', async (over) => {
    const { gh, fake } = setup();
    fake.before.push((r) => (r.path === inlinePath ? json(200, [inlineFact(over)]) : undefined));
    await expect(gh.claims.listReviewComments(repo, 7, 99)).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });

  it('同编号冲突内容明确失败；完全相同的重复页条目只返回一次', async () => {
    for (const conflict of [false, true]) {
      const { gh, fake } = setup();
      fake.before.push((r) =>
        r.path === inlinePath
          ? json(200, [inlineFact(), inlineFact(conflict ? { body: 'edited during pagination' } : {})])
          : undefined,
      );
      if (conflict) await expect(gh.claims.listReviewComments(repo, 7, 99)).rejects.toThrow('同编号内容冲突');
      else expect(await gh.claims.listReviewComments(repo, 7, 99)).toHaveLength(1);
    }
  });

  it('安全网触顶仍有下一页就报未读全，不返回前10页', async () => {
    const { gh, fake } = setup();
    fake.before.push((r) =>
      r.path === inlinePath
        ? json(200, [], {
            link: `<${API}${inlinePath}?page=${Number(r.query.get('page') ?? 1) + 1}>; rel="next"`,
          })
        : undefined,
    );
    await expect(gh.claims.listReviewComments(repo, 7, 99)).rejects.toMatchObject({ code: 'TOO_MANY_PAGES' });
    expect(fake.calls('GET', /reviews\/99\/comments$/)).toHaveLength(10);
  });
});

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

  it('closed PR 满 10 页还有下一页、末条仍新于 since：窗口里合并的照样读回，不整次抛没查全', async () => {
    const { gh, fake } = setup();
    const since = new Date('2026-09-09T00:00:00Z');
    const newest = Date.parse('2026-10-08T00:00:00Z');
    // 第 1 页就有一张合并的；后面 999 张只是关掉、没合并，把合并的那张挤到第 11 页
    const early = fake.addPull({
      head: { ref: 'fix/early', sha: sha('e') },
      state: 'closed',
      merged: true,
      merged_at: '2026-10-08T00:00:00Z',
      updated_at: new Date(newest).toISOString(),
      body: '**需求**：Refs #10\n',
    });
    for (let i = 1; i < 1000; i += 1) {
      fake.addPull({
        head: { ref: `fix/pad-${i}`, sha: sha(`p${i}`) },
        state: 'closed',
        merged: false,
        updated_at: new Date(newest - i * 1000).toISOString(),
      });
    }
    const late = fake.addPull({
      head: { ref: 'fix/late', sha: sha('l') },
      state: 'closed',
      merged: true,
      merged_at: '2026-10-07T00:00:00Z',
      updated_at: new Date(newest - 1000 * 1000).toISOString(),
      title: 'design 决定表（#139 第 1 片）',
      body: '**需求**：Refs #139\n',
    });
    fake.addPull({
      head: { ref: 'fix/old', sha: sha('o') },
      state: 'closed',
      merged: true,
      merged_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
      body: '**需求**：Refs #1\n',
    });
    const got = await gh.claims.listMergedPulls(repo, since);
    expect(got.map((p) => p.number)).toEqual([early.number, late.number]);
    expect(got[1]?.body).toContain('Refs #139');
    // 第 10 页末条仍在窗口内，必须再翻第 11 页才看到更早的并停下；不能停在 10，也不能整本翻完
    expect(fake.calls('GET', /\/pulls$/)).toHaveLength(11);
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

describe('engine-pulls：读正式评审（#2991）', () => {
  const reviewsOf = (reply: () => Response) => (req: { path: string }) =>
    /\/pulls\/7\/reviews$/.test(req.path) ? reply() : undefined;

  it('以引擎机器人读 PR 上全部评审：原文、review id、审的提交、作者原样带回；没写正文是空串', async () => {
    const { gh, fake } = setup();
    fake.before.push(
      reviewsOf(
        () =>
          new Response(
            JSON.stringify([
              {
                id: 5560285247,
                user: { login: 'boss', id: 9, type: 'User' },
                state: 'CHANGES_REQUESTED',
                body: '来源认证有洞：别信 payload 里的 sender',
                commit_id: sha('a'),
                submitted_at: '2026-10-17T01:00:00Z',
              },
              { id: 2, user: null, state: 'COMMENTED', body: null, commit_id: null, submitted_at: null },
            ]),
            { status: 200 },
          ),
      ),
    );
    const got = await gh.claims.listReviews(repo, 7);
    expect(got).toEqual([
      {
        id: 5560285247,
        author: { login: 'boss', id: 9, type: 'User' },
        state: 'CHANGES_REQUESTED',
        body: '来源认证有洞：别信 payload 里的 sender',
        commitId: sha('a'),
        submittedAt: '2026-10-17T01:00:00Z',
      },
      { id: 2, author: null, state: 'COMMENTED', body: '', commitId: null, submittedAt: null },
    ]);
    const calls = fake.calls('GET', /\/pulls\/7\/reviews$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.as).toBe('engine');
    expect(calls[0]?.query.get('per_page')).toBe('100');
  });

  it('【故意造出的失败】评审列表认不出、GitHub 回 5xx：抛错，不当成没有评审', async () => {
    const bad = setup();
    bad.fake.before.push(
      reviewsOf(() => new Response(JSON.stringify([{ id: 'x', state: 'APPROVED' }]), { status: 200 })),
    );
    await expect(bad.gh.claims.listReviews(repo, 7)).rejects.toThrow();
    const down = setup();
    down.fake.before.push(
      reviewsOf(() => new Response(JSON.stringify({ message: 'boom' }), { status: 500 })),
    );
    await expect(down.gh.claims.listReviews(repo, 7)).rejects.toThrow();
  });
});

describe('engine-pulls：撤自动合并、关 PR、留言', () => {
  it('Refs 与开放责任的 PR：历史提交含关单词也不能成为默认 squash 消息', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({
      head: { ref: 'fleet/3210-t1', sha: sha('a') },
      body: '**需求**：Refs #3210（验收责任未结）',
    });
    await gh.claims.enableAutoMerge(repo, { number: pr.number, nodeId: `PR_${pr.number}` });
    const request = fake.calls('POST', /^\/graphql$/).at(-1)?.body as {
      variables: { headline?: string; body?: string };
    };
    // GitHub 未指定正文时会使用分支提交列表；模拟 #3225 的生产形状。
    const actualSquash = request.variables.body || '修复提醒\n\nCloses #3210\nFixes #3210';
    expect(actualSquash).not.toMatch(/(?:closes|fixes|resolves) #3210/i);
    expect(request.variables.headline?.trim()).toBeTruthy();
    expect(request.variables.body?.trim()).toBeTruthy();
    expect(fake.pulls.get(pr.number)?.body).toContain('Refs #3210');
    expect(fake.calls('PATCH', /\/issues\//)).toEqual([]);
  });

  it.each([
    null,
    { id: 'PR_1', number: 1, autoMergeRequest: null },
    { id: 'PR_999', number: 999, autoMergeRequest: null },
    {
      id: 'PR_1',
      number: 1,
      autoMergeRequest: { commitHeadline: 'default', commitBody: 'Closes #3210', mergeMethod: 'SQUASH' },
    },
  ])('挂自动合并回执未知或消息未采用就报错：%j', async (receipt) => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'fleet/3210-t1', sha: sha('a') } });
    fake.before.push((req) => {
      if (
        req.path !== '/graphql' ||
        !(req.body as { query: string }).query.includes('enablePullRequestAutoMerge')
      )
        return undefined;
      // 写已落地但回执不明：必须撤掉，不能只向调用者抛错。
      pr.auto_merge = true;
      return json(200, { data: { enablePullRequestAutoMerge: { pullRequest: receipt } } });
    });
    await expect(
      gh.claims.enableAutoMerge(repo, { number: pr.number, nodeId: `PR_${pr.number}` }),
    ).rejects.toThrow('安全消息回执');
    expect(pr.auto_merge).toBe(false);
  });

  it('GraphQL 部分成功带 errors：不把已挂上的自动合并留在后台', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'fleet/3210-t1', sha: sha('a') } });
    fake.before.push((req) => {
      if (
        req.path === '/graphql' &&
        (req.body as { query: string }).query.includes('enablePullRequestAutoMerge')
      ) {
        pr.auto_merge = true;
        return json(200, {
          data: { enablePullRequestAutoMerge: { pullRequest: { number: pr.number } } },
          errors: [{ message: 'child field unavailable' }],
        });
      }
      return undefined;
    });
    await expect(
      gh.claims.enableAutoMerge(repo, { number: pr.number, nodeId: `PR_${pr.number}` }),
    ).rejects.toThrow('child field unavailable');
    expect(pr.auto_merge).toBe(false);
  });

  it.each([{ enablePullRequestAutoMerge: null }, null])(
    'GraphQL null bubbling 隐去已成功挂载的 payload：%j',
    async (data) => {
      const { gh, fake } = setup();
      const pr = fake.addPull({ head: { ref: 'fleet/3210-t1', sha: sha('a') } });
      fake.before.push((req) => {
        if (
          req.path === '/graphql' &&
          (req.body as { query: string }).query.includes('enablePullRequestAutoMerge')
        ) {
          pr.auto_merge = true;
          return json(200, {
            data,
            errors: [
              {
                message: 'non-null child field unavailable',
                path: ['enablePullRequestAutoMerge', 'pullRequest', 'id'],
              },
            ],
          });
        }
        return undefined;
      });
      await expect(
        gh.claims.enableAutoMerge(repo, { number: pr.number, nodeId: `PR_${pr.number}` }),
      ).rejects.toThrow('non-null child field unavailable');
      expect(pr.auto_merge).toBe(false);
    },
  );

  it.each(
    [
      ['enablePullRequestAutoMerge'],
      ['anotherMutation', 'pullRequest', 'id'],
      ['enablePullRequestAutoMerge', null],
      'enablePullRequestAutoMerge.pullRequest',
    ].map((path) => ({ path })),
  )('仅精确 mutation 子字段路径才判未知写；确定拒挂保留原错：%j', async ({ path }) => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'fleet/3210-t1', sha: sha('a') } });
    fake.before.push((req) => {
      if (
        req.path === '/graphql' &&
        (req.body as { query: string }).query.includes('enablePullRequestAutoMerge')
      )
        return json(200, {
          data: { enablePullRequestAutoMerge: null },
          errors: [{ message: 'Pull request is in clean status', path }],
        });
      return undefined;
    });
    await expect(
      gh.claims.enableAutoMerge(repo, { number: pr.number, nodeId: `PR_${pr.number}` }),
    ).rejects.toMatchObject({
      code: 'GRAPHQL_ERROR',
      maybeLanded: false,
      message: expect.stringContaining('clean status'),
    });
    expect(fake.calls('POST', /^\/graphql$/)).toHaveLength(1);
    expect(pr.auto_merge).toBe(false);
  });

  it('挂载已落地但 GraphQL data 丢失：客户端解析错误也必须撤挂', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'fleet/3210-t1', sha: sha('a') } });
    fake.before.push((req) => {
      if (
        req.path === '/graphql' &&
        (req.body as { query: string }).query.includes('enablePullRequestAutoMerge')
      ) {
        pr.auto_merge = true;
        return json(200, {});
      }
      return undefined;
    });
    await expect(
      gh.claims.enableAutoMerge(repo, { number: pr.number, nodeId: `PR_${pr.number}` }),
    ).rejects.toThrow('GraphQL');
    expect(pr.auto_merge).toBe(false);
  });

  it('安全消息未知且撤挂失败：保留原失败并标明写入结果未知', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'fleet/3210-t1', sha: sha('a') } });
    fake.before.push((req) => {
      if (req.path !== '/graphql') return undefined;
      const query = (req.body as { query: string }).query;
      if (query.includes('enablePullRequestAutoMerge')) {
        pr.auto_merge = true;
        return json(200, { data: { enablePullRequestAutoMerge: null } });
      }
      return json(200, { data: { disablePullRequestAutoMerge: null } });
    });
    await expect(
      gh.claims.enableAutoMerge(repo, { number: pr.number, nodeId: `PR_${pr.number}` }),
    ).rejects.toMatchObject({ maybeLanded: true, message: expect.stringContaining('安全消息回执') });
    expect(pr.auto_merge).toBe(true);
  });

  it('现读后又推新头：GitHub expectedHeadOid 拒绝，不挂到未经确认的新头', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'fleet/3210-t1', sha: sha('a') } });
    fake.before.push((req) => {
      if (req.path === '/graphql') pr.head.sha = sha('b');
      return undefined;
    });
    await expect(
      gh.claims.enableAutoMerge(repo, { number: pr.number, nodeId: `PR_${pr.number}`, headSha: sha('a') }),
    ).rejects.toThrow('Head OID does not match');
    expect(pr.auto_merge).toBe(false);
  });

  it('验过的头到挂载前已变：不把新 GET 的头当成预期头', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'fleet/3210-t1', sha: sha('b') } });
    await expect(
      gh.claims.enableAutoMerge(repo, { number: pr.number, nodeId: `PR_${pr.number}`, headSha: sha('a') }),
    ).rejects.toThrow('预期头');
    expect(fake.calls('POST', /^\/graphql$/)).toEqual([]);
  });

  it('挂自动合并核精确身份、当前头，并中和旧 PR 标题正文', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({
      head: { ref: 'fleet/3210-t1', sha: sha('a') },
      title: 'Fixes #3210',
      body: 'Closes #3210',
    });
    await expect(gh.claims.enableAutoMerge(repo, { number: pr.number, nodeId: 'PR_wrong' })).rejects.toThrow(
      '核身份',
    );
    expect(fake.calls('POST', /^\/graphql$/)).toEqual([]);
    await gh.claims.enableAutoMerge(repo, { number: pr.number, nodeId: `PR_${pr.number}` });
    const request = fake.calls('POST', /^\/graphql$/).at(-1)?.body as {
      variables: { head: string; headline: string; body: string };
      query: string;
    };
    expect(request.variables.head).toBe(sha('a'));
    expect(request.query).toContain('expectedHeadOid: $head');
    expect(request.variables.headline).not.toMatch(/Fixes/i);
    expect(fake.pulls.get(pr.number)?.body).toBe('关联 #3210');
  });

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

  it('改 PR 正文（#2723）：按模板渲染，中和关单词且保留关联，分支和状态不动', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'fleet/12-t1', sha: sha('a') }, body: '旧的' });
    await gh.claims.updatePullBody(repo, pr.number, {
      requirement: 12,
      did: ['按 #12 的要求动手（第 2 轮）', 'Closes #12 的那条做完了'],
      verified: ['看检查'],
    });
    const body = fake.pulls.get(pr.number)?.body ?? '';
    expect(body).toContain('**做了什么**：');
    expect(body).toContain('- 按 #12 的要求动手（第 2 轮）');
    expect(body).toContain('- 关联 #12 的那条做完了');
    expect(body).not.toMatch(/Closes #12/i);
    expect(fake.pulls.get(pr.number)?.state).toBe('open');
  });

  it('会话逐字写了 Closes #本单：改正文的需求栏保留这句', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'fleet/3445-t1', sha: sha('a') }, body: '旧的' });
    await gh.claims.updatePullBody(repo, pr.number, {
      requirement: 3445,
      did: ['按 #3445 的要求动手（第 2 轮）', 'Closes #3445'],
      verified: ['看检查'],
    });
    const body = fake.pulls.get(pr.number)?.body ?? '';
    expect(body).toContain('**需求**：Closes #3445');
    expect(body).toContain('- 关联 #3445');
  });

  it('【故意造出的失败】往 issue 号上留「PR 的话」：拒绝，不写到 issue 上', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    await expect(gh.claims.commentPull(repo, issue.number, 'k', 'x')).rejects.toThrow('不是 PR');
    expect(fake.issues.get(issue.number)?.comments).toEqual([]);
  });
});

describe('engine-pulls：挂自动合并的 unstable 临时拒绝（#3198）', () => {
  const HEAD = sha('a');
  /** #3198 事件 254 的原样 errors。 */
  const unstable = {
    type: 'UNPROCESSABLE',
    path: ['enablePullRequestAutoMerge'],
    message: 'Pull request Pull request is in unstable status',
  };
  const refuse = (errors: unknown[]) => {
    const { gh, fake } = setup();
    for (let n = 1; n < 7; n += 1) fake.addIssue();
    fake.addPull({ head: { ref: 'fleet/3219-t1', sha: HEAD } });
    fake.before.push((r) =>
      r.path !== '/graphql'
        ? undefined
        : (r.body as { query: string }).query.includes('enablePullRequestAutoMerge')
          ? json(200, { data: { enablePullRequestAutoMerge: null }, errors })
          : json(200, {
              data: {
                disablePullRequestAutoMerge: {
                  pullRequest: { id: 'PR_7', number: 7, autoMergeRequest: null },
                },
              },
            }),
    );
    return gh.claims
      .enableAutoMerge(repo, { number: 7, nodeId: 'PR_7', headSha: HEAD }, { attempt: 2 })
      .catch((e: unknown) => e);
  };

  it('只有 enablePullRequestAutoMerge 的那一条 UNPROCESSABLE unstable：标成可重试，码和原消息不变，原始 errors 原样留着，补 PR/头/尝试', async () => {
    const err = await refuse([unstable]);
    expect(err).toMatchObject({
      code: 'GRAPHQL_ERROR',
      retryable: true,
      maybeLanded: false,
      details: { errors: [unstable], pull: 7, head: HEAD, attempt: 2 },
    });
    const message = String((err as Error).message);
    expect(message).toContain('GraphQL 出错：Pull request Pull request is in unstable status');
    expect(message).toContain('UNPROCESSABLE enablePullRequestAutoMerge');
    expect(message).toContain(`原始 errors：${JSON.stringify([unstable])}`);
    expect(message).toContain(`PR #7 头 ${HEAD}`);
    expect(message).toContain('第 2 次尝试');
  });

  it.each([
    ['别的 path', [{ ...unstable, path: ['disablePullRequestAutoMerge'] }], 'GRAPHQL_ERROR'],
    ['path 多一层', [{ ...unstable, path: ['enablePullRequestAutoMerge', 'pullRequest'] }], 'GRAPHQL_ERROR'],
    ['没有 path', [{ type: unstable.type, message: unstable.message }], 'GRAPHQL_ERROR'],
    ['别的 type', [{ ...unstable, type: 'STALE_DATA' }], 'GRAPHQL_ERROR'],
    [
      '权限拒绝',
      [{ ...unstable, type: 'FORBIDDEN', message: 'Resource not accessible by integration' }],
      'FORBIDDEN',
    ],
    ['别的消息', [{ ...unstable, message: 'Pull request is in dirty status' }], 'GRAPHQL_ERROR'],
    ['消息多一个句号', [{ ...unstable, message: `${unstable.message}.` }], 'GRAPHQL_ERROR'],
    ['消息大小写不同', [{ ...unstable, message: unstable.message.toLowerCase() }], 'GRAPHQL_ERROR'],
    ['消息带首尾空白', [{ ...unstable, message: ` ${unstable.message} ` }], 'GRAPHQL_ERROR'],
    [
      '重复的 Pull request 前缀',
      [{ ...unstable, message: `Pull request ${unstable.message}` }],
      'GRAPHQL_ERROR',
    ],
    [
      '消息只带 unstable 子串',
      [{ ...unstable, message: 'Auto merge is not allowed, unstable policy' }],
      'GRAPHQL_ERROR',
    ],
    [
      '策略拒绝',
      [{ ...unstable, message: 'Auto merge is not allowed for this repository' }],
      'GRAPHQL_ERROR',
    ],
    [
      '混合多条 errors',
      [unstable, { ...unstable, message: 'Auto merge is not allowed for this repository' }],
      'GRAPHQL_ERROR',
    ],
  ])('%s：原样抛、不可重试', async (_name, errors, code) => {
    const err = await refuse(errors);
    expect(isGitHubError(err)).toBe(true);
    expect(err).toMatchObject({ code, retryable: false, details: { errors } });
    expect(String((err as Error).message)).not.toContain('交活动有界重试');
  });
});
