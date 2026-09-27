// 挂里程碑、读还开着的里程碑、读一张单开没开着（「引擎」机器人）：巡检（#223）每 6 小时在巡检仓开一张固定的小单，
// 写好需求文档再挂当前版本、收尾时看单子关成什么样就经这里（开单本身是 openIssue，测在 issues.test.ts）。读不到、认不出一律抛错，不拿空顶。
import { describe, expect, it } from 'vitest';
import { json, repo, setup } from './helpers.ts';

describe('挂里程碑、读还开着的里程碑、读一张单开没开着', () => {
  it('挂上当前版本：回执核对挂的就是这个编号；已经挂着就不再写', async () => {
    const { gh, fake } = setup();
    fake.milestones.set(3, 'v1 巡检');
    const issue = fake.addIssue();
    expect(await gh.setIssueMilestone({ repo, issueNumber: issue.number, milestone: 3 })).toEqual({
      changed: true,
    });
    expect(issue.milestone).toEqual({ number: 3, title: 'v1 巡检' });
    const writes = fake.requests.filter((r) => r.method === 'PATCH').length;
    expect(await gh.setIssueMilestone({ repo, issueNumber: issue.number, milestone: 3 })).toEqual({
      changed: false,
    });
    expect(fake.requests.filter((r) => r.method === 'PATCH').length).toBe(writes);
  });

  it('【故意造出的失败】回执里挂的不是这个编号：报 READBACK_MISMATCH，不当成挂上了', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    fake.before.push((req) =>
      req.method === 'PATCH'
        ? json(200, {
            number: issue.number,
            milestone: { number: 99 },
            updated_at: '2026-09-25T12:00:00Z',
          })
        : undefined,
    );
    await expect(
      gh.setIssueMilestone({ repo, issueNumber: issue.number, milestone: 3 }),
    ).rejects.toMatchObject({
      code: 'READBACK_MISMATCH',
    });
  });

  it('还开着的里程碑：关了的不列；回的形状认不出抛错（不当成一个都没有）', async () => {
    const { gh, fake } = setup();
    fake.milestones.set(1, 'v1 巡检');
    fake.milestones.set(2, 'v2 以后');
    fake.closedMilestones.add(2);
    expect(await gh.readOpenMilestones({ repo })).toEqual([{ number: 1, title: 'v1 巡检' }]);
    fake.before.push((req) =>
      req.path === '/graphql' ? json(200, { data: { repository: {} } }) : undefined,
    );
    await expect(gh.readOpenMilestones({ repo })).rejects.toThrow();
  });

  it('一张单开没开着、关的原因；没有这张单抛错（不当成开着）', async () => {
    const { gh, fake } = setup();
    const open = fake.addIssue();
    const done = fake.addIssue({ state: 'closed', state_reason: 'completed' });
    expect(await gh.readIssueState({ repo, issueNumber: open.number })).toEqual({
      state: 'open',
      stateReason: null,
    });
    expect(await gh.readIssueState({ repo, issueNumber: done.number })).toEqual({
      state: 'closed',
      stateReason: 'completed',
    });
    await expect(gh.readIssueState({ repo, issueNumber: 999 })).rejects.toThrow();
  });
});
