// 一张 issue 此刻挂在哪个版本、开没开着、是不是母单或子单（接活判当前版本和母单子单、fleet-api handover 判开没开着）：
// 「引擎」机器人一次 GraphQL 现读，全走假服务。读不到、形状认不出、没翻完一律抛错，不拿「没挂」「不是子单」「开着」顶。
import { describe, expect, it } from 'vitest';
import { json, repo, setup } from './helpers.ts';

const V1 = { number: 8, title: 'v1 Fusion 接活' };
const V2 = { number: 9, title: 'v2 引擎打磨' };
const P1 = { number: 2, title: 'P1 核心闭环' };

describe('readIssuePlan', () => {
  it('挂在 v1 上的独立单：带回它挂的里程碑、仓里还开着的里程碑（关了的不带）、开关状态、作者、标签，不是母单也不是子单；以「引擎」身份一次查完', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ milestone: V1, labels: ['需求'] });
    fake.milestones.set(V2.number, V2.title);
    fake.milestones.set(P1.number, P1.title);
    fake.closedMilestones.add(P1.number);
    expect(await gh.readIssuePlan({ repo, issueNumber: issue.number })).toEqual({
      state: 'open',
      reopened: false,
      pullRequest: false,
      author: 'founder',
      milestone: V1,
      openMilestones: [V1, V2],
      labels: ['需求'],
      parent: null,
      subIssues: 0,
    });
    const [call, ...more] = fake.calls('POST', /\/graphql$/);
    expect(more).toEqual([]);
    if (!call) throw new Error('没查 GraphQL');
    expect(call.as).toBe('engine');
    expect((call.body as { variables: unknown }).variables).toEqual({
      owner: repo.owner,
      name: repo.name,
      number: issue.number,
    });
  });

  it('母单、子单认得出：贴「母单」的、下面挂着子单的、挂在别的单下面的', async () => {
    const { gh, fake } = setup();
    const mother = fake.addIssue({ labels: ['需求', '母单'], milestone: V1 });
    const child = fake.addIssue({ parent: mother.number, milestone: V1 });
    expect(await gh.readIssuePlan({ repo, issueNumber: mother.number })).toMatchObject({
      labels: ['需求', '母单'],
      parent: null,
      subIssues: 1,
    });
    expect(await gh.readIssuePlan({ repo, issueNumber: child.number })).toMatchObject({
      parent: mother.number,
      subIssues: 0,
    });
  });

  it('没挂里程碑（未排期）是 null；关了又重开的记 reopened；关着的记 closed；这个号是 PR 的记 pullRequest', async () => {
    const { gh, fake } = setup();
    fake.milestones.set(V1.number, V1.title);
    const unscheduled = fake.addIssue();
    const reopened = fake.addIssue({ state_reason: 'reopened', milestone: V2 });
    const closed = fake.addIssue({ state: 'closed', state_reason: 'completed', milestone: V1 });
    const pr = fake.addPull({ head: { ref: 'x', sha: 'a'.repeat(40) } });
    expect(await gh.readIssuePlan({ repo, issueNumber: unscheduled.number })).toMatchObject({
      milestone: null,
      reopened: false,
      openMilestones: [V1, V2],
    });
    expect(await gh.readIssuePlan({ repo, issueNumber: reopened.number })).toMatchObject({
      state: 'open',
      reopened: true,
      milestone: V2,
    });
    expect(await gh.readIssuePlan({ repo, issueNumber: closed.number })).toMatchObject({
      state: 'closed',
      reopened: false,
    });
    expect(await gh.readIssuePlan({ repo, issueNumber: pr.number })).toMatchObject({
      pullRequest: true,
      state: 'open',
    });
  });

  it('【故意造出的失败】查父子关系这一栏整栏没回来：抛「没查成」，不当成不是子单', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ milestone: V1 });
    fake.before.push((req) => {
      if (req.path !== '/graphql') return undefined;
      return json(200, {
        data: {
          repository: {
            issueOrPullRequest: {
              __typename: 'Issue',
              state: 'OPEN',
              stateReason: null,
              author: { login: 'founder' },
              milestone: V1,
              labels: { totalCount: 0, nodes: [] },
              subIssuesSummary: { total: 0 },
            },
            milestones: { totalCount: 1, nodes: [V1] },
          },
        },
      });
    });
    await expect(gh.readIssuePlan({ repo, issueNumber: issue.number })).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
      message: expect.stringContaining('没查成'),
    });
  });

  it('【故意造出的失败】GraphQL 报错（没权限、查不到这张单）、一直 502：都抛错，不拿空的顶', async () => {
    const forbidden = setup();
    const a = forbidden.fake.addIssue({ milestone: V1 });
    forbidden.fake.before.push((req) =>
      req.path === '/graphql'
        ? json(200, {
            data: null,
            errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }],
          })
        : undefined,
    );
    await expect(forbidden.gh.readIssuePlan({ repo, issueNumber: a.number })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const { gh } = setup();
    await expect(gh.readIssuePlan({ repo, issueNumber: 404 })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const down = setup();
    const b = down.fake.addIssue({ milestone: V1 });
    down.fake.before.push((req) =>
      req.path === '/graphql' ? json(502, { message: 'Bad Gateway' }) : undefined,
    );
    await expect(down.gh.readIssuePlan({ repo, issueNumber: b.number })).rejects.toThrow();
  });

  it('【故意造出的失败】还开着的里程碑、这张单的标签超过一次能读的（100 个）：抛「没查成」，不拿前 100 个当全部', async () => {
    for (const over of ['milestones', 'labels'] as const) {
      const { gh, fake } = setup();
      const issue = fake.addIssue({ milestone: V1 });
      fake.before.push((req) => {
        if (req.path !== '/graphql') return undefined;
        return json(200, {
          data: {
            repository: {
              issueOrPullRequest: {
                __typename: 'Issue',
                state: 'OPEN',
                stateReason: null,
                author: { login: 'founder' },
                milestone: V1,
                labels: { totalCount: over === 'labels' ? 101 : 0, nodes: [] },
                parent: null,
                subIssuesSummary: { total: 0 },
              },
              milestones: { totalCount: over === 'milestones' ? 101 : 1, nodes: [V1] },
            },
          },
        });
      });
      await expect(gh.readIssuePlan({ repo, issueNumber: issue.number }), over).rejects.toMatchObject({
        code: 'TOO_MANY_PAGES',
        message: expect.stringContaining('没查成'),
      });
    }
  });
});
