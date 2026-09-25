// 「读不到」一律报明确的失败（AGENTS.md 底线）：每条读 GitHub 的路径各造一次读不到或形状认不出，
// 断言结果是「没查成」或抛错——不许变成空列表、0、ok，更不许据此去写（没找到旧 PR 就再开一张 = 重复写）。
import { describe, expect, it } from 'vitest';
import { json, repo, setup, sha } from './helpers.ts';

const A = sha('a');
const garbage = () => json(200, { unexpected: true });

describe('读不到 ≠ 没有', () => {
  it('按分支找 PR 的返回认不出：报错，不当「没有 PR」再开一张', async () => {
    const { gh, fake } = setup();
    fake.refs.set('task/1', A);
    fake.before.push((req) => (req.method === 'GET' && req.path.endsWith('/pulls') ? garbage() : undefined));
    await expect(gh.openPr({ repo, branch: 'task/1', head: A, title: 't', body: 'b' })).rejects.toMatchObject(
      {
        code: 'UNEXPECTED_RESPONSE',
      },
    );
    expect(fake.calls('POST', /\/pulls$/)).toHaveLength(0);
  });

  it('翻评论的返回认不出：报错，不当「没发过」再发一条', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    fake.before.push((req) =>
      req.method === 'GET' && req.path.endsWith('/comments') ? garbage() : undefined,
    );
    await expect(
      gh.closeIssue({ repo, issueNumber: issue.number, reason: 'completed' }),
    ).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
    expect(issue.comments).toHaveLength(0);
  });

  it('检查、工作流的返回认不出：等 CI 报「没查成」，不当零条检查', async () => {
    for (const path of ['/check-runs', '/status', '/actions/runs']) {
      const { gh, fake } = setup();
      const pr = fake.addPull({ head: { ref: 'task/1', sha: A } });
      fake.before.push((req) => (req.path.endsWith(path) ? garbage() : undefined));
      expect(await gh.waitCi({ repo, prNumber: pr.number, head: A }), path).toMatchObject({
        state: 'unknown',
      });
    }
  });

  it('比较主线的返回认不出：不合并', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'task/1', sha: A } });
    fake.addCheck(A, 'check', 'success');
    fake.before.push((req) => (req.path.includes('/compare/') ? garbage() : undefined));
    await expect(gh.mergePr({ repo, prNumber: pr.number, expectedHead: A })).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
    expect(fake.calls('PUT', /\/merge$/)).toHaveLength(0);
  });

  it('issue 的返回认不出：不改正文', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: '原话' });
    fake.before.push((req) =>
      req.method === 'GET' && /\/issues\/\d+$/.test(req.path) ? garbage() : undefined,
    );
    await expect(
      gh.updateIssueProgress({
        repo,
        issueNumber: issue.number,
        progress: { state: 'running', current: 'x', done: 0, total: 1, subtasks: [], docs: {} },
      }),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    expect(fake.calls('PATCH', /\/issues\//)).toHaveLength(0);
  });

  it('互动限制的返回认不出：报没查成，不当「没有限制」去设', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) =>
      req.method === 'GET' && req.path.endsWith('/interaction-limits') ? json(200, { limit: 7 }) : undefined,
    );
    await expect(gh.renewInteractionLimit({ repo })).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
    expect(fake.calls('PUT', /interaction-limits$/)).toHaveLength(0);
  });

  it('仓的事实、机器人账号的返回认不出：报错', async () => {
    const facts = setup();
    facts.fake.before.push((req) => (req.path === '/repos/acme/widgets' ? garbage() : undefined));
    await expect(facts.gh.deps.facts.get(repo)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });

    const bot = setup();
    bot.fake.before.push((req) =>
      req.path.startsWith('/users/') ? json(200, { login: 'x', id: 1, type: 'User' }) : undefined,
    );
    await expect(bot.gh.commitIdentity(repo)).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('安装的权限表读不到：自检写「没查成」，不写「缺这缺那」', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) =>
      /^\/app\/installations\/\d+$/.test(req.path) ? json(200, { id: 1 }) : undefined,
    );
    const report = await gh.selfCheck([repo]);
    expect(report.every((r) => !r.ok && r.missing.length === 0 && (r.why ?? '').includes('没查成'))).toBe(
      true,
    );
  });

  const noIntake = { ingest: async () => ({ verdict: 'duplicate' as const }) };
  const pollDeliveryId = () => 'x';

  it('轮询：一开头就读不到报 unscanned；送进去一部分后断了报 partial（不报 ok）', async () => {
    const denied = setup();
    denied.fake.before.push((req) =>
      req.path.endsWith('/issues') ? json(403, { message: 'nope' }) : undefined,
    );
    const r1 = await denied.gh
      .reconciler({ intake: noIntake, pollDeliveryId })
      .poll('acme/widgets', new Date(0));
    expect(r1.outcome).toBe('unscanned');

    const odd = setup();
    odd.fake.addIssue();
    odd.fake.before.push((req) => (req.path.endsWith('/issues/comments') ? garbage() : undefined));
    const r2 = await odd.gh
      .reconciler({ intake: noIntake, pollDeliveryId })
      .poll('acme/widgets', new Date(0));
    expect(r2).toMatchObject({ outcome: 'partial', checked: 1, why: expect.stringContaining('没做完') });
  });

  it('对账：列表读不到报 unscanned；单张读不到报 partial 并写明哪张没查成', async () => {
    const down = setup();
    down.fake.before.push((req) => (req.path.endsWith('/issues') ? json(500, { message: 'x' }) : undefined));
    const open = await down.gh
      .reconciler({ intake: noIntake, pollDeliveryId })
      .auditOpenIssues('acme/widgets');
    expect(open).toMatchObject({ outcome: 'unscanned', scanned: 0 });

    const partly = setup();
    const pr = partly.fake.addPull({
      head: { ref: 'task/1', sha: A },
      state: 'closed',
      merged: true,
      merged_at: '2026-09-25T11:00:00Z',
      merge_commit_sha: sha('c'),
      merged_by: partly.fake.bots.engine,
    });
    partly.fake.before.push((req) =>
      req.path.endsWith(`/pulls/${pr.number}`) ? json(502, { message: 'x' }) : undefined,
    );
    const merged = await partly.gh
      .reconciler({ intake: noIntake, pollDeliveryId })
      .auditMergedPrs('acme/widgets', new Date('2026-09-25T00:00:00Z'));
    expect(merged.outcome).toBe('partial');
    expect(merged.problems.some((p) => p.startsWith(`#${pr.number} 没查成`))).toBe(true);
  });

  it('CI 事件回 GitHub 重读失败：事件处理报错（后端会撤掉投递登记，等重投或补收），不把镜像写成「没有 CI」', async () => {
    const { gh, fake, ledger } = setup();
    const sink = gh.eventSink({ wake: async () => {} });
    await sink.accept({
      deliveryId: 'd1',
      source: 'webhook',
      event: 'pull_request',
      repo: 'acme/widgets',
      wake: true,
      receivedAt: '2026-09-25T12:00:00Z',
      payload: {
        pull_request: {
          number: 5,
          state: 'open',
          updated_at: '2026-09-25T12:00:00Z',
          head: { ref: 'task/5', sha: A },
        },
      },
    });
    fake.before.push((req) =>
      req.path.endsWith('/check-runs') ? json(403, { message: 'nope' }) : undefined,
    );
    await expect(
      sink.accept({
        deliveryId: 'd2',
        source: 'webhook',
        event: 'check_run',
        repo: 'acme/widgets',
        wake: true,
        receivedAt: '2026-09-25T12:01:00Z',
        payload: { action: 'completed', check_run: { head_sha: A, pull_requests: [] } },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const rows = await ledger.pullRequestsByHead((await ledger.repoId(repo)) ?? '', A);
    expect(rows.map((r) => r.checks)).toEqual(['pending']);
  });
});
