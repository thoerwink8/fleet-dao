import { describe, expect, it } from 'vitest';
import { humanPart, type IssueProgress, parseBody, renderProgress, spliceProgress } from '../src/progress.ts';
import { json, repo, setup } from './helpers.ts';

const progress = (over: Partial<IssueProgress> = {}): IssueProgress => ({
  state: 'running',
  current: '写验证码过期的测试',
  done: 3,
  total: 5,
  subtasks: [
    { key: 'A', title: '登录表单', state: 'merged', prNumber: 31 },
    { key: 'B', title: '验证码', state: 'running', prNumber: 32 },
    { key: 'C', title: '过期提示', state: 'pending', prNumber: null },
  ],
  docs: { requirement: 'specs/12-登录验证码/需求.md', plan: 'specs/12-登录验证码/方案.md' },
  ...over,
});

describe('进度段（纯文本）', () => {
  const where = { repo, defaultBranch: 'main' };

  it('渲染：进度条、子任务、文档链接；不写关单词；人写的标题里的 @ 不会提醒人', () => {
    const s = renderProgress(
      progress({ subtasks: [{ key: 'A', title: '找 @founder 确认', state: 'merged', prNumber: 31 }] }),
      where,
      '2026-09-25T12:00:00.000Z',
    );
    expect(s).toContain('**进度**：■■■□□ 3/5 · 进行中 · 正在：写验证码过期的测试');
    expect(s).toContain('A 找 @​founder 确认 ✅ #31');
    expect(s).toContain(
      '[需求](https://github.com/acme/widgets/blob/main/specs/12-%E7%99%BB%E5%BD%95%E9%AA%8C%E8%AF%81%E7%A0%81/%E9%9C%80%E6%B1%82.md)',
    );
    expect(s).not.toMatch(/close|fix|resolve/i);
    expect(s.startsWith('<!-- fleet:progress:start as-of=2026-09-25T12:00:00.000Z -->')).toBe(true);
  });

  it('只换标记之间的那一段，人写的前后原样保留（包括 CRLF）', () => {
    const body =
      '原话：给登录页加验证码\r\nAI 理解：……\r\n\r\n<!-- fleet:progress:start as-of=x -->\n旧的\n<!-- fleet:progress:end -->\r\n\r\n人后来补的一句';
    const next = spliceProgress(
      body,
      '<!-- fleet:progress:start as-of=y -->\n新的\n<!-- fleet:progress:end -->',
    );
    expect(next).toBe(
      '原话：给登录页加验证码\r\nAI 理解：……\r\n\r\n<!-- fleet:progress:start as-of=y -->\n新的\n<!-- fleet:progress:end -->\r\n\r\n人后来补的一句',
    );
    expect(humanPart(next)).toBe(humanPart(body));
  });

  it('没有进度段就追加在末尾；多出来的进度段、落单的开始标记都清掉', () => {
    expect(spliceProgress('原话', 'S')).toBe('原话\n\nS\n');
    expect(spliceProgress('', 'S')).toBe('S\n');
    const messy =
      '原话\n<!-- fleet:progress:start -->\na\n<!-- fleet:progress:end -->\n中间\n<!-- fleet:progress:start -->\nb\n<!-- fleet:progress:end -->';
    expect(spliceProgress(messy, 'S')).toBe('原话\nS\n中间\n');
    const orphan = '原话\n<!-- fleet:progress:start as-of=x -->\n人删了结束标记';
    expect(parseBody(orphan).section).toBeNull();
    expect(spliceProgress(orphan, 'S')).toBe('原话\n\n人删了结束标记\n\nS\n');
  });
});

describe('issue 进度段原地更新', () => {
  it('用「引擎」改正文：只动进度段，人写的一字不动；内容没变就不再写', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: '原话：给登录页加验证码（提出人：某某）\nAI 理解：加手机验证码' });
    const first = await gh.updateIssueProgress({ repo, issueNumber: issue.number, progress: progress() });
    expect(first).toEqual({ outcome: 'written', restoredHumanEdit: false, verified: true });
    expect(
      issue.body?.startsWith(
        '原话：给登录页加验证码（提出人：某某）\nAI 理解：加手机验证码\n\n<!-- fleet:progress:start',
      ),
    ).toBe(true);
    expect(fake.calls('PATCH', /\/issues\/\d+$/).map((r) => r.as)).toEqual(['engine']);

    const again = await gh.updateIssueProgress({
      repo,
      issueNumber: issue.number,
      progress: progress(),
      asOf: '2026-09-25T13:00:00Z',
    });
    expect(again.outcome).toBe('unchanged');
    expect(fake.calls('PATCH', /\/issues\/\d+$/)).toHaveLength(1);
  });

  it('慢到的旧快照不盖新的（as-of）', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: '原话' });
    await gh.updateIssueProgress({
      repo,
      issueNumber: issue.number,
      progress: progress({ done: 4 }),
      asOf: '2026-09-25T12:05:00Z',
    });
    const stale = await gh.updateIssueProgress({
      repo,
      issueNumber: issue.number,
      progress: progress({ done: 3 }),
      asOf: '2026-09-25T12:01:00Z',
    });
    expect(stale.outcome).toBe('stale');
    expect(issue.body).toContain('4/5');
  });

  it('同一张单并发更新：串行写，最后一份赢，人写的都在', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: '原话' });
    await Promise.all(
      [1, 2, 3].map((done) =>
        gh.updateIssueProgress({
          repo,
          issueNumber: issue.number,
          progress: progress({ done }),
          asOf: `2026-09-25T12:0${done}:00Z`,
        }),
      ),
    );
    expect(issue.body).toContain('3/5');
    expect(issue.body?.startsWith('原话\n\n')).toBe(true);
    expect(issue.body?.match(/fleet:progress:start/g)).toHaveLength(1);
  });

  it('读和写之间插进来的人手编辑被盖掉了：从编辑历史找回、放回去，并报警', async () => {
    const { gh, fake, logs } = setup();
    const issue = fake.addIssue({ body: '原话' });
    let raced = false;
    fake.before.push((req) => {
      // 我们刚读完、还没写的那一刻，创始人改了正文
      if (req.method === 'PATCH' && !raced) {
        raced = true;
        fake.editBody(issue, '原话\n补充：验证码 5 分钟过期', fake.human);
      }
      return undefined;
    });
    const res = await gh.updateIssueProgress({ repo, issueNumber: issue.number, progress: progress() });
    expect(res).toEqual({ outcome: 'written', restoredHumanEdit: true, verified: true });
    expect(issue.body?.startsWith('原话\n补充：验证码 5 分钟过期\n\n<!-- fleet:progress:start')).toBe(true);
    expect(logs.some((l) => l.level === 'error' && l.message.includes('人手编辑'))).toBe(true);
  });

  it('编辑历史读不到：写是写成了，但标明没核对成', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: '原话' });
    fake.before.push((req) =>
      req.path === '/graphql'
        ? json(200, { data: null, errors: [{ type: 'FORBIDDEN', message: 'no' }] })
        : undefined,
    );
    const res = await gh.updateIssueProgress({ repo, issueNumber: issue.number, progress: progress() });
    expect(res).toEqual({ outcome: 'written', restoredHumanEdit: false, verified: false });
  });

  it('B3：正文超上限发出前就拒', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: '字'.repeat(65_500) });
    await expect(
      gh.updateIssueProgress({ repo, issueNumber: issue.number, progress: progress() }),
    ).rejects.toMatchObject({
      code: 'BODY_TOO_LONG',
    });
    expect(fake.calls('PATCH', /\/issues\//)).toHaveLength(0);
  });

  it('拿 PR 号来更新 issue 进度：拒绝', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) =>
      req.method === 'GET' && /\/issues\/77$/.test(req.path)
        ? json(200, {
            number: 77,
            node_id: 'x',
            html_url: 'u',
            state: 'open',
            title: 't',
            body: '',
            user: fake.human,
            pull_request: { url: 'u' },
            updated_at: '2026-09-25T00:00:00Z',
          })
        : undefined,
    );
    await expect(
      gh.updateIssueProgress({ repo, issueNumber: 77, progress: progress() }),
    ).rejects.toMatchObject({
      code: 'NOT_AN_ISSUE',
    });
  });
});

describe('关单', () => {
  it('先写明去向再关，带 state_reason；回读 state 与 state_reason', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    const res = await gh.closeIssue({
      repo,
      issueNumber: issue.number,
      reason: 'completed',
      comment: '已完成：#31、#32 已合并；结果见 specs/12-x/结果.md',
    });
    expect(res).toMatchObject({ alreadyClosed: false, commentCreated: true });
    expect(issue.state).toBe('closed');
    expect(issue.state_reason).toBe('completed');
    expect(issue.comments[0]?.body).toMatch(
      /^已完成：#31、#32 已合并；结果见 specs\/12-x\/结果\.md\n\n<!-- fleet:close:[0-9a-f]{16} -->$/,
    );
    expect(issue.comments[0]?.user.login).toBe('fleet-test-engine[bot]');
  });

  it('重试（包括回执丢了）不会再发一条评论（B1）', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    let dropped = false;
    fake.dropAfter.push((req) => {
      if (req.method === 'POST' && req.path.endsWith('/comments') && !dropped) {
        dropped = true;
        return true;
      }
      return false;
    });
    const input = {
      repo,
      issueNumber: issue.number,
      reason: 'not_planned' as const,
      comment: '去向：并入 #40',
    };
    await expect(gh.closeIssue(input)).rejects.toMatchObject({ code: 'AMBIGUOUS_WRITE' });
    const res = await gh.closeIssue(input);
    expect(res.commentCreated).toBe(false);
    expect(issue.comments).toHaveLength(1);
    await gh.closeIssue(input);
    expect(issue.comments).toHaveLength(1);
    expect(issue.state_reason).toBe('not_planned');
  });

  it('评论过百也翻得到自己那条（不只翻第一页）', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    const input = { repo, issueNumber: issue.number, reason: 'completed' as const, comment: '完成' };
    await gh.closeIssue(input);
    const mine = issue.comments.pop();
    for (let i = 0; i < 150; i += 1)
      issue.comments.push({
        id: 5000 + i,
        body: `评论 ${i}`,
        user: fake.human,
        updated_at: '2026-09-25T00:00:00Z',
      });
    if (mine) issue.comments.push(mine);
    // 换一份账本：模拟账丢了，只能靠标记回查
    const fresh = setup();
    fresh.fake.issues.set(issue.number, issue);
    const res = await fresh.gh.closeIssue(input);
    expect(res.commentCreated).toBe(false);
    expect(issue.comments).toHaveLength(151);
  });

  it('A8：关单接口回了成功、回读却没关上：报错', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    fake.before.push((req) => {
      if (req.method === 'PATCH') return json(200, { number: issue.number });
      return undefined;
    });
    await expect(
      gh.closeIssue({ repo, issueNumber: issue.number, reason: 'completed' }),
    ).rejects.toMatchObject({
      code: 'READBACK_MISMATCH',
    });
  });
});

describe('互动限制续期', () => {
  it('还早：不动', async () => {
    const { gh, fake, clock } = setup();
    fake.interaction = {
      limit: 'collaborators_only',
      origin: 'repository',
      expires_at: new Date(clock.now().getTime() + 90 * 86_400_000).toISOString(),
    };
    expect(await gh.renewInteractionLimit({ repo })).toMatchObject({ action: 'fresh' });
    expect(fake.calls('PUT', /interaction-limits$/)).toHaveLength(0);
  });

  it('不足 30 天：显式续 six_months，回读到期时间真往后推了', async () => {
    const { gh, fake, clock } = setup();
    fake.interaction = {
      limit: 'collaborators_only',
      origin: 'repository',
      expires_at: new Date(clock.now().getTime() + 10 * 86_400_000).toISOString(),
    };
    expect(await gh.renewInteractionLimit({ repo })).toMatchObject({ action: 'renewed' });
    expect(fake.calls('PUT', /interaction-limits$/)[0]?.body).toEqual({
      limit: 'collaborators_only',
      expiry: 'six_months',
    });
    expect(fake.calls('PUT', /interaction-limits$/).map((r) => r.as)).toEqual(['engine']);
  });

  it('A8：接口回 200 但没生效：报错，不当续上了', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) => (req.method === 'PUT' ? json(200, {}) : undefined));
    await expect(gh.renewInteractionLimit({ repo })).rejects.toMatchObject({ code: 'READBACK_MISMATCH' });
  });

  it('账户级的限制：直说改不了', async () => {
    const { gh, fake } = setup();
    fake.interaction = { limit: 'collaborators_only', origin: 'user', expires_at: '2026-10-01T00:00:00Z' };
    await expect(gh.renewInteractionLimit({ repo })).rejects.toMatchObject({ code: 'ACCOUNT_LEVEL_LIMIT' });
  });
});
