// 驾驶舱「发版」卡读 GitHub 的几样（release-facts.ts，「引擎」机器人只读）：主线头、提交、汇总检查、compare、最近合并的 PR、单的标题。
// 故意造出的失败：形状认不出、一条检查都没有（不算绿）、差得多只读最后一页、没有合并了的 PR、号是 PR、请求本身失败往外抛。
import { describe, expect, it } from 'vitest';
import type { GhRequest, GitHubClient } from '../src/client.ts';
import { createReleaseFacts } from '../src/release-facts.ts';

const repo = { owner: 'o', name: 'r' };
const SHA = 'a'.repeat(40);

/** 只替身 request：按路径回数据，记下每次请求。 */
function stub(handler: (req: GhRequest) => unknown) {
  const calls: GhRequest[] = [];
  const client = {
    async request(req: GhRequest) {
      calls.push(req);
      return { status: 200, data: handler(req), headers: new Headers() };
    },
  } as unknown as GitHubClient;
  return { facts: createReleaseFacts(client), calls };
}

const commit = (sha: string, message: string, date = '2026-10-07T10:00:00Z') => ({
  sha,
  commit: { message, committer: { date } },
});
const run = (over: Record<string, unknown>) => ({
  id: 1,
  name: 'check',
  head_sha: SHA,
  status: 'completed',
  conclusion: 'success',
  ...over,
});

describe('mainlineHead / commit', () => {
  it('取提交说明第一行和提交时间，用「引擎」身份读 main', async () => {
    const { facts, calls } = stub(() => commit(SHA, '刷新耗时表 (#1230)\n\n正文'));
    expect(await facts.mainlineHead(repo)).toEqual({
      sha: SHA,
      title: '刷新耗时表 (#1230)',
      committedAt: '2026-10-07T10:00:00Z',
    });
    expect(calls[0]).toMatchObject({ path: '/repos/o/r/commits/main', auth: { as: 'engine' } });
  });

  it('形状认不出、缺提交时间：抛 UNEXPECTED_RESPONSE，不回空标题', async () => {
    await expect(stub(() => ({ nope: 1 })).facts.commit(repo, SHA)).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
    await expect(
      stub(() => ({ sha: SHA, commit: { message: 'x', committer: null, author: null } })).facts.commit(
        repo,
        SHA,
      ),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('请求本身失败：原样往外抛', async () => {
    const client = {
      async request() {
        throw new Error('连不上');
      },
    } as unknown as GitHubClient;
    await expect(createReleaseFacts(client).mainlineHead(repo)).rejects.toThrow('连不上');
  });
});

describe('mainCi', () => {
  it('check 完成且成功：绿', async () => {
    const { facts } = stub(() => ({ check_runs: [run({})] }));
    expect(await facts.mainCi(repo, SHA)).toEqual({ state: 'green', detail: '' });
  });

  it('check 失败：红，带结论；别的名字的检查不算', async () => {
    const { facts } = stub(() => ({
      check_runs: [run({ conclusion: 'failure', output: { title: '单测红' } }), run({ id: 2, name: 'x' })],
    }));
    expect(await facts.mainCi(repo, SHA)).toEqual({ state: 'red', detail: 'failure：单测红' });
  });

  it('还在跑：pending；同名重跑只认最新的一条', async () => {
    const running = stub(() => ({ check_runs: [run({ status: 'in_progress', conclusion: null })] }));
    expect((await running.facts.mainCi(repo, SHA)).state).toBe('pending');
    const rerun = stub(() => ({
      check_runs: [
        run({ id: 1, conclusion: 'failure', started_at: '2026-10-07T09:00:00Z' }),
        run({ id: 2, conclusion: 'success', started_at: '2026-10-07T09:30:00Z' }),
      ],
    }));
    expect((await rerun.facts.mainCi(repo, SHA)).state).toBe('green');
  });

  it('一条 check 都没有：pending 并说明还没有结果，不当绿', async () => {
    const { facts } = stub(() => ({ check_runs: [run({ name: 'other' })] }));
    expect(await facts.mainCi(repo, SHA)).toEqual({
      state: 'pending',
      detail: '这个提交还没有汇总检查的结果',
    });
  });

  it('形状认不出：抛错', async () => {
    await expect(stub(() => ({ check_runs: 'x' })).facts.mainCi(repo, SHA)).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    });
  });
});

describe('compare', () => {
  it('最近的在前（GitHub 给的是旧到新）；差几个取 ahead_by', async () => {
    const { facts, calls } = stub(() => ({
      status: 'ahead',
      ahead_by: 2,
      commits: [commit('1'.repeat(40), '旧 (#1)'), commit('2'.repeat(40), '新 (#2)')],
    }));
    expect(await facts.compare(repo, 'b'.repeat(40), SHA)).toEqual({
      status: 'ahead',
      aheadBy: 2,
      recent: [
        { sha: '2'.repeat(40), title: '新 (#2)' },
        { sha: '1'.repeat(40), title: '旧 (#1)' },
      ],
    });
    expect(calls[0]?.path).toBe(`/repos/o/r/compare/${'b'.repeat(40)}...${SHA}`);
  });

  it('差得超过一页：再读最后一页，最近的提交在那里', async () => {
    const { facts, calls } = stub((req) => {
      const page = Number(req.query?.page);
      return {
        status: 'ahead',
        ahead_by: 230,
        commits: page === 1 ? [commit('1'.repeat(40), '最旧 (#1)')] : [commit('9'.repeat(40), '最新 (#230)')],
      };
    });
    const r = await facts.compare(repo, 'b'.repeat(40), SHA);
    expect(r.aheadBy).toBe(230);
    expect(r.recent[0]?.title).toBe('最新 (#230)');
    expect(calls.map((c) => c.query?.page)).toEqual([1, 3]);
  });

  it('diverged 原样给出，不改成 ahead；状态认不出抛错', async () => {
    const { facts } = stub(() => ({ status: 'diverged', ahead_by: 1, commits: [] }));
    expect((await facts.compare(repo, 'b'.repeat(40), SHA)).status).toBe('diverged');
    await expect(
      stub(() => ({ status: 'weird', ahead_by: 1, commits: [] })).facts.compare(repo, 'b', SHA),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });
});

describe('lastMergedPull', () => {
  it('跳过关了没合的，取合并时间最新的（列表是按更新时间排的，不一定合并得最晚）', async () => {
    const { facts } = stub(() => [
      { number: 9, title: '关了没合', body: null, merged_at: null },
      { number: 7, title: '早合的', body: 'Closes #1', merged_at: '2026-10-07T08:00:00Z' },
      { number: 8, title: '晚合的', body: null, merged_at: '2026-10-07T09:00:00Z' },
    ]);
    expect(await facts.lastMergedPull(repo)).toEqual({
      number: 8,
      title: '晚合的',
      body: '',
      mergedAt: '2026-10-07T09:00:00Z',
    });
  });

  it('窗口里一个合并了的都没有：抛错，不回空', async () => {
    const { facts } = stub(() => [{ number: 9, title: 'x', body: null, merged_at: null }]);
    await expect(facts.lastMergedPull(repo)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('issueTitle', () => {
  it('取标题；号是 PR 抛 NOT_AN_ISSUE', async () => {
    expect(await stub(() => ({ number: 5, title: '一张单' })).facts.issueTitle(repo, 5)).toEqual({
      number: 5,
      title: '一张单',
    });
    await expect(
      stub(() => ({ number: 5, title: 'pr', pull_request: { url: 'x' } })).facts.issueTitle(repo, 5),
    ).rejects.toMatchObject({ code: 'NOT_AN_ISSUE' });
  });
});
