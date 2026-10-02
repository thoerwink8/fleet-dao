// 读还开着的里程碑、读一张单开没开着（「引擎」机器人）：巡检（#223）开单前找巡检仓的当前版本、收尾时看单子关成什么样就经这里
// （开单挂里程碑是 openIssue，测在 issues.test.ts）。读不到、认不出一律抛错，不拿空顶。
import { describe, expect, it } from 'vitest';
import { json, repo, setup } from './helpers.ts';

describe('读还开着的里程碑、读一张单开没开着', () => {
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

describe('读一张单的标题、正文、开没开着', () => {
  it('原样回标题和正文（空正文回空串）、开没开着；没有这张单、是 PR 都抛错（不当成空单）', async () => {
    const { gh, fake } = setup();
    const withBody = fake.addIssue({ title: '给驾驶舱加状态', body: '## 场景\n\n要看到每张单走到哪一步' });
    const empty = fake.addIssue({ title: '空正文' });
    const closed = fake.addIssue({ state: 'closed', state_reason: 'completed' });
    expect(await gh.readIssue({ repo, issueNumber: withBody.number })).toEqual({
      number: withBody.number,
      title: '给驾驶舱加状态',
      body: '## 场景\n\n要看到每张单走到哪一步',
      state: 'open',
    });
    expect(await gh.readIssue({ repo, issueNumber: empty.number })).toMatchObject({ body: '' });
    expect(await gh.readIssue({ repo, issueNumber: closed.number })).toMatchObject({ state: 'closed' });
    await expect(gh.readIssue({ repo, issueNumber: 999 })).rejects.toThrow();
    const pr = fake.addPull({ head: { ref: 'fleet/1-x', sha: 'a'.repeat(40) } });
    await expect(gh.readIssue({ repo, issueNumber: pr.number })).rejects.toMatchObject({
      code: 'NOT_AN_ISSUE',
    });
  });
});
