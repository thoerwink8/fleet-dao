// 一张 issue 此刻挂在哪个版本（接活判当前版本、fleet-api handover 判开没开着）：「引擎」机器人现读，全走假服务。
// 读不到、形状认不出一律抛错，不拿「没挂里程碑」「开着」顶。
import { describe, expect, it } from 'vitest';
import { json, repo, setup } from './helpers.ts';

const V1 = { number: 8, title: 'v1 Fusion 接活' };
const V2 = { number: 9, title: 'v2 引擎打磨' };
const P1 = { number: 2, title: 'P1 核心闭环' };

describe('readIssuePlan', () => {
  it('挂在 v1 上：带回它挂的里程碑、仓里还开着的里程碑（关了的不带）、开关状态和作者，以「引擎」身份读', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ milestone: V1 });
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
    });
    const reads = fake.calls('GET', /\/(issues\/\d+|milestones)$/);
    expect(reads.map((r) => [r.path.replace(/^\/repos\/[^/]+\/[^/]+/, ''), r.as])).toEqual([
      [`/issues/${issue.number}`, 'engine'],
      ['/milestones', 'engine'],
    ]);
  });

  it('没挂里程碑（未排期）是 null；关了又重开的记 reopened；关着的记 closed', async () => {
    const { gh, fake } = setup();
    fake.milestones.set(V1.number, V1.title);
    const unscheduled = fake.addIssue();
    const reopened = fake.addIssue({ state_reason: 'reopened', milestone: V2 });
    const closed = fake.addIssue({ state: 'closed', state_reason: 'completed', milestone: V1 });
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
  });

  it('还开着的里程碑超过一页：翻完所有页再判，不拿第一页当全部', async () => {
    const { gh, fake } = setup();
    for (let n = 100; n < 250; n++) fake.milestones.set(n, `v${n} 以后的`);
    const issue = fake.addIssue({ milestone: V1 });
    const plan = await gh.readIssuePlan({ repo, issueNumber: issue.number });
    expect(plan.openMilestones).toHaveLength(151);
    expect(fake.calls('GET', /\/milestones$/).length).toBeGreaterThan(1);
  });

  it('【故意造出的失败】issue 的返回里整栏没有 milestone：抛「没查成」，不当成没挂里程碑', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ milestone: V1 });
    fake.before.push((req) =>
      req.method === 'GET' && req.path.endsWith(`/issues/${issue.number}`)
        ? json(200, { number: issue.number, state: 'open', user: { login: 'founder' } })
        : undefined,
    );
    await expect(gh.readIssuePlan({ repo, issueNumber: issue.number })).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
      message: expect.stringContaining('没查成'),
    });
  });

  it('【故意造出的失败】列里程碑时 GitHub 一直 502、回的不是里程碑：都抛错，不拿空列表当「没有当前版本」', async () => {
    const down = setup();
    const a = down.fake.addIssue({ milestone: V1 });
    down.fake.before.push((req) =>
      req.path.endsWith('/milestones') ? json(502, { message: 'Bad Gateway' }) : undefined,
    );
    await expect(down.gh.readIssuePlan({ repo, issueNumber: a.number })).rejects.toThrow();

    const odd = setup();
    const b = odd.fake.addIssue({ milestone: V1 });
    odd.fake.before.push((req) =>
      req.path.endsWith('/milestones') ? json(200, [{ id: 1, name: '不是里程碑的形状' }]) : undefined,
    );
    await expect(odd.gh.readIssuePlan({ repo, issueNumber: b.number })).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });

  it('issue 不在（或 App 没装到这个仓）：抛错', async () => {
    const { gh } = setup();
    await expect(gh.readIssuePlan({ repo, issueNumber: 404 })).rejects.toThrow();
  });
});
