// 一批单号（issue 或 PR）此刻开没开着（#2783，拉单查「前置：」里的单）：「引擎」机器人一次 GraphQL 查一批，不一张单一次请求。
// 读不到、形状认不出、有号查不到一律抛错，不拿「关了」顶。
import { describe, expect, it } from 'vitest';
import { repo, setup } from './helpers.ts';

describe('readIssueStates', () => {
  it('一批号一次查完：开着的 issue、关了的 issue、开着的 PR、合了的 PR；以「引擎」身份', async () => {
    const { gh, fake } = setup();
    const open = fake.addIssue();
    const closed = fake.addIssue({ state: 'closed', state_reason: 'completed' });
    const openPr = fake.addPull({ head: { ref: 'a', sha: 'a'.repeat(40) } });
    const mergedPr = fake.addPull({ head: { ref: 'b', sha: 'b'.repeat(40) }, merged: true, state: 'closed' });
    const got = await gh.readIssueStates({
      repo,
      numbers: [open.number, closed.number, openPr.number, mergedPr.number],
    });
    expect([...got]).toEqual([
      [open.number, 'open'],
      [closed.number, 'closed'],
      [openPr.number, 'open'],
      [mergedPr.number, 'closed'],
    ]);
    const calls = fake.calls('POST', /\/graphql$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.as).toBe('engine');
  });

  it('没有号：不发请求，回空', async () => {
    const { gh, fake } = setup();
    expect([...(await gh.readIssueStates({ repo, numbers: [] }))]).toEqual([]);
    expect(fake.calls('POST', /\/graphql$/)).toEqual([]);
  });

  it('号很多也只按批发：120 个号分 3 批（每批最多 50 个），不是 120 次', async () => {
    const { gh, fake } = setup();
    const numbers = Array.from({ length: 120 }, () => fake.addIssue().number);
    const got = await gh.readIssueStates({ repo, numbers });
    expect(got.size).toBe(120);
    expect(fake.calls('POST', /\/graphql$/)).toHaveLength(3);
  });

  it('重复的号只问一次', async () => {
    const { gh, fake } = setup();
    const a = fake.addIssue();
    const got = await gh.readIssueStates({ repo, numbers: [a.number, a.number] });
    expect([...got]).toEqual([[a.number, 'open']]);
  });

  it('【故意造出的失败】有个号不存在：整批抛 NOT_FOUND，不拿「关了」顶', async () => {
    const { gh, fake } = setup();
    const a = fake.addIssue();
    await expect(gh.readIssueStates({ repo, numbers: [a.number, 99999] })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
