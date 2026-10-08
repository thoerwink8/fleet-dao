// 单子进门自动打标挂版本（#448）要读写的 GitHub 现状：开着的单加全部里程碑、一张单的标签时间线、补类别标签、挂里程碑。
// 读不到、形状认不出一律抛错（调用方记没查成），不拿「一张都没有」顶。
import { describe, expect, it } from 'vitest';
import type { GhRequest, GhResponse, GitHubClient } from '../src/client.ts';
import { isGitHubError } from '../src/errors.ts';
import { addIssueLabel, readGroomFacts, readIssueLabelEvents, setIssueMilestone } from '../src/groom.ts';

const repo = { owner: 'o', name: 'r' };
const BOT_USER = { login: 'fleet-dao-engine[bot]', id: 9, type: 'Bot' };
const HUMAN_USER = { login: 'thoerwink8', id: 1, type: 'User' };
const bots = {
  is: (_role: 'engine' | 'agent', u: { login?: string | null } | null | undefined) =>
    u?.login === BOT_USER.login,
};

type RestClient = Pick<GitHubClient, 'request' | 'all'>;

/** 假的 REST 客户端：按路径认是查什么；某一步可以故意出错（抛给调用方）。 */
function fakeClient(opts: {
  milestones?: unknown[] | Error;
  issues?: unknown[] | Error;
  events?: unknown[] | Error;
  labelPost?: unknown[] | Error;
  milestonePatch?: unknown | Error;
}) {
  const calls: { method: string; path: string; query?: unknown; body?: unknown }[] = [];
  const give = <T>(v: T | Error): T => {
    if (v instanceof Error) throw v;
    return v;
  };
  const client: RestClient = {
    async all<T>(req: GhRequest): Promise<T[]> {
      calls.push({ method: req.method, path: req.path, query: req.query });
      if (req.path.endsWith('/milestones')) return give(opts.milestones ?? []) as T[];
      if (/\/issues\/\d+\/events$/.test(req.path)) return give(opts.events ?? []) as T[];
      if (req.path.endsWith('/issues')) return give(opts.issues ?? []) as T[];
      throw new Error(`假客户端没准备 all() ${req.path}`);
    },
    async request<T>(req: GhRequest): Promise<GhResponse<T>> {
      calls.push({ method: req.method, path: req.path, body: req.body });
      if (req.method === 'POST' && req.path.endsWith('/labels')) {
        return { status: 200, data: give(opts.labelPost ?? []) as T, headers: new Headers() };
      }
      if (req.method === 'PATCH') {
        return { status: 200, data: give(opts.milestonePatch ?? {}) as T, headers: new Headers() };
      }
      throw new Error(`假客户端没准备 request() ${req.method} ${req.path}`);
    },
  };
  return { client, calls };
}

const milestone = (over: Partial<{ number: number; title: string; state: string }> = {}) => ({
  number: 3,
  title: 'v1 Fusion 接活',
  state: 'open',
  ...over,
});

const issueRow = (over: Record<string, unknown> = {}) => ({
  number: 12,
  title: '登录验证码',
  body: '正文',
  user: HUMAN_USER,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-02T00:00:00Z',
  labels: [{ name: '需求' }],
  milestone: null,
  ...over,
});

describe('readGroomFacts：开着的单加全部里程碑', () => {
  it('里程碑说明原文带回（拉单读版本里的先后）；没写说明（null）是空串', async () => {
    const { client } = fakeClient({
      milestones: [
        milestone({ description: '<!-- fleet:order -->\n1. #12\n<!-- /fleet:order -->' } as never),
        milestone({ number: 4, title: 'v2', description: null } as never),
      ],
    });
    const got = await readGroomFacts({ client, bots }, { repo });
    expect(got.milestones.map((m) => m.description)).toEqual([
      '<!-- fleet:order -->\n1. #12\n<!-- /fleet:order -->',
      '',
    ]);
  });

  it('一次读全：milestones、issues 合并成 GroomFacts', async () => {
    const { client, calls } = fakeClient({
      milestones: [milestone(), milestone({ number: 2, title: 'v0 老版本', state: 'closed' })],
      issues: [
        issueRow(),
        issueRow({ number: 13, milestone: { number: 3, title: 'v1 Fusion 接活', state: 'open' } }),
      ],
    });
    const got = await readGroomFacts({ client, bots }, { repo });
    expect(got).toEqual({
      milestones: [
        { number: 3, title: 'v1 Fusion 接活', state: 'open', description: '' },
        { number: 2, title: 'v0 老版本', state: 'closed', description: '' },
      ],
      issues: [
        {
          number: 12,
          title: '登录验证码',
          body: '正文',
          author: 'thoerwink8',
          authorId: 1,
          authorType: 'User',
          authorIsBot: false,
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-02T00:00:00Z',
          labels: ['需求'],
          milestone: null,
        },
        {
          number: 13,
          title: '登录验证码',
          body: '正文',
          author: 'thoerwink8',
          authorId: 1,
          authorType: 'User',
          authorIsBot: false,
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-02T00:00:00Z',
          labels: ['需求'],
          milestone: { number: 3, title: 'v1 Fusion 接活' },
        },
      ],
    });
    expect(calls.map((c) => c.query)).toContainEqual({ state: 'all', per_page: 100 });
    expect(calls.map((c) => c.query)).toContainEqual({ state: 'open', per_page: 100 });
  });

  it('机器人开的单：authorIsBot 为 true（引擎、干活的两个角色都算）', async () => {
    const { client } = fakeClient({ milestones: [], issues: [issueRow({ user: BOT_USER })] });
    const got = await readGroomFacts({ client, bots }, { repo });
    expect(got.issues[0]?.authorIsBot).toBe(true);
    // 拉单按白名单认人要数字编号和类型：机器人只按编号认、且类型必须是 Bot
    expect(got.issues[0]).toMatchObject({ authorId: 9, authorType: 'Bot' });
  });

  it('账号删了（user 是 null）：作者三项都是 null，不编一个', async () => {
    const { client } = fakeClient({ milestones: [], issues: [issueRow({ user: null })] });
    const got = await readGroomFacts({ client, bots }, { repo });
    expect(got.issues[0]).toMatchObject({ author: null, authorId: null, authorType: null });
  });

  it('作者账号删了（user 是 null）：author 是 null，不算机器人', async () => {
    const { client } = fakeClient({ milestones: [], issues: [issueRow({ user: null })] });
    const got = await readGroomFacts({ client, bots }, { repo });
    expect(got.issues[0]).toMatchObject({ author: null, authorIsBot: false });
  });

  it('PR 混在 issues 列表里（带 pull_request 字段）：过滤掉，不当成 issue', async () => {
    const { client } = fakeClient({
      milestones: [],
      issues: [issueRow(), issueRow({ number: 99, pull_request: {} })],
    });
    const got = await readGroomFacts({ client, bots }, { repo });
    expect(got.issues.map((i) => i.number)).toEqual([12]);
  });

  it('正文是 null：当空字符串，不是没查成', async () => {
    const { client } = fakeClient({ milestones: [], issues: [issueRow({ body: null })] });
    const got = await readGroomFacts({ client, bots }, { repo });
    expect(got.issues[0]?.body).toBe('');
  });

  it('【故意造出的失败】里程碑列表读不到：抛错，不当成一个都没有', async () => {
    const { client } = fakeClient({ milestones: new Error('回了 500') });
    await expect(readGroomFacts({ client, bots }, { repo })).rejects.toThrow('回了 500');
  });

  it('【故意造出的失败】一条里程碑形状认不出（少了 state）：抛 UNEXPECTED_RESPONSE', async () => {
    const { client } = fakeClient({ milestones: [{ number: 1, title: 'x' }] });
    const err = await readGroomFacts({ client, bots }, { repo }).catch((e: unknown) => e);
    expect(isGitHubError(err) && err.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('【故意造出的失败】一条 issue 形状认不出（少了 created_at）：抛 UNEXPECTED_RESPONSE，不拿「读到的几条」顶', async () => {
    const { client } = fakeClient({
      milestones: [],
      issues: [{ number: 1, title: 'x', body: '', user: null, updated_at: 't', labels: [], milestone: null }],
    });
    const err = await readGroomFacts({ client, bots }, { repo }).catch((e: unknown) => e);
    expect(isGitHubError(err) && err.code).toBe('UNEXPECTED_RESPONSE');
  });
});

describe('readIssueLabelEvents：标签的加/摘事件', () => {
  const labeled = (over: Record<string, unknown> = {}) => ({
    event: 'labeled',
    actor: HUMAN_USER,
    label: { name: '需求' },
    created_at: '2026-09-01T00:00:00Z',
    ...over,
  });

  it('只留 labeled/unlabeled，别的事件（评论、改里程碑……）过滤掉', async () => {
    const { client } = fakeClient({
      events: [
        labeled(),
        { event: 'milestoned', actor: HUMAN_USER, created_at: 't' },
        { event: 'commented', actor: null, created_at: null },
      ],
    });
    const got = await readIssueLabelEvents({ client, bots }, { repo, issueNumber: 12 });
    expect(got).toEqual([{ label: '需求', action: 'labeled', bot: false, at: '2026-09-01T00:00:00Z' }]);
  });

  it('机器人贴的、人摘的：bot 字段分得清', async () => {
    const { client } = fakeClient({
      events: [
        labeled({ actor: BOT_USER, created_at: '2026-09-01T00:00:00Z' }),
        {
          event: 'unlabeled',
          actor: HUMAN_USER,
          label: { name: '需求' },
          created_at: '2026-09-05T00:00:00Z',
        },
      ],
    });
    const got = await readIssueLabelEvents({ client, bots }, { repo, issueNumber: 12 });
    expect(got.map((e) => ({ action: e.action, bot: e.bot }))).toEqual([
      { action: 'labeled', bot: true },
      { action: 'unlabeled', bot: false },
    ]);
  });

  it('【故意造出的失败】labeled 事件没带标签名：抛 UNEXPECTED_RESPONSE', async () => {
    const { client } = fakeClient({ events: [{ event: 'labeled', actor: HUMAN_USER, created_at: 't' }] });
    const err = await readIssueLabelEvents({ client, bots }, { repo, issueNumber: 12 }).catch(
      (e: unknown) => e,
    );
    expect(isGitHubError(err) && err.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('【故意造出的失败】labeled 事件没带时刻：抛 UNEXPECTED_RESPONSE', async () => {
    const { client } = fakeClient({
      events: [{ event: 'labeled', actor: HUMAN_USER, label: { name: '需求' } }],
    });
    const err = await readIssueLabelEvents({ client, bots }, { repo, issueNumber: 12 }).catch(
      (e: unknown) => e,
    );
    expect(isGitHubError(err) && err.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('【故意造出的失败】读不到：抛错，不当成没有事件', async () => {
    const { client } = fakeClient({ events: new Error('回了 404') });
    await expect(readIssueLabelEvents({ client, bots }, { repo, issueNumber: 12 })).rejects.toThrow(
      '回了 404',
    );
  });
});

describe('addIssueLabel：给单加类别标签', () => {
  it('成功：返回加完之后的全部标签', async () => {
    const { client, calls } = fakeClient({ labelPost: [{ name: '需求' }, { name: '母单' }] });
    const got = await addIssueLabel({ client }, { repo, issueNumber: 12, label: '需求' });
    expect(got).toEqual(['需求', '母单']);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { labels: ['需求'] } });
  });

  it('【故意造出的失败】GitHub 回的不是标签列表：抛 UNEXPECTED_RESPONSE', async () => {
    const { client } = fakeClient({ labelPost: [{ oops: true }] });
    const err = await addIssueLabel({ client }, { repo, issueNumber: 12, label: '需求' }).catch(
      (e: unknown) => e,
    );
    expect(isGitHubError(err) && err.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('【故意造出的失败】写失败（GitHub 回错）：抛错，不当成加成了', async () => {
    const { client } = fakeClient({ labelPost: new Error('回了 403') });
    await expect(addIssueLabel({ client }, { repo, issueNumber: 12, label: '需求' })).rejects.toThrow(
      '回了 403',
    );
  });
});

describe('setIssueMilestone：给单挂里程碑', () => {
  it('成功：返回挂完之后的里程碑', async () => {
    const { client, calls } = fakeClient({
      milestonePatch: { milestone: { number: 3, title: 'v1 Fusion 接活', state: 'open' } },
    });
    const got = await setIssueMilestone({ client }, { repo, issueNumber: 12, milestone: 3 });
    expect(got).toEqual({ number: 3, title: 'v1 Fusion 接活' });
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { milestone: 3 } });
  });

  it('【故意造出的失败】GitHub 回的没有 milestone 字段：抛 UNEXPECTED_RESPONSE，不当成「没挂」', async () => {
    const { client } = fakeClient({ milestonePatch: { oops: true } });
    const err = await setIssueMilestone({ client }, { repo, issueNumber: 12, milestone: 3 }).catch(
      (e: unknown) => e,
    );
    expect(isGitHubError(err) && err.code).toBe('UNEXPECTED_RESPONSE');
  });

  it('【故意造出的失败】写失败：抛错，不当成挂成了', async () => {
    const { client } = fakeClient({ milestonePatch: new Error('回了 422') });
    await expect(setIssueMilestone({ client }, { repo, issueNumber: 12, milestone: 3 })).rejects.toThrow(
      '回了 422',
    );
  });
});
