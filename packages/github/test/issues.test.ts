import { describe, expect, it } from 'vitest';
import { createGitHub } from '../src/github.ts';
import { digest } from '../src/idempotency.ts';
import { humanPart, type IssueProgress, parseBody, renderProgress, spliceProgress } from '../src/progress.ts';
import { API } from './fake-github.ts';
import { json, repo, setup, tempDir } from './helpers.ts';

/** 等条件成立（真时间，最多 ms 毫秒）；到点不成立就返回 false，由调用方决定算不算失败。 */
async function settle(cond: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return cond();
}

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

describe('写进度段之前的卫生检查（公开的 issue 正文，推前扫描拦不到）', () => {
  it('子任务标题（方案会话写的）里有真密钥：不写（HYGIENE_BLOCKED，不可重试），一个请求都不发，报错只带位置不带值', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: '原话' });
    const before = fake.requests.length;
    const token = ['ghp', 'q7Rz2LmX9vKp4TnB8wYc1HdF6jGs3NaEw5Yu'].join('_');
    const err = await gh
      .updateIssueProgress({
        repo,
        issueNumber: issue.number,
        progress: progress({
          subtasks: [
            { key: 'A', title: '登录表单', state: 'merged', prNumber: 31 },
            { key: 'B', title: `令牌 ${token}`, state: 'running', prNumber: null },
          ],
        }),
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'HYGIENE_BLOCKED', retryable: false });
    expect((err as Error).message).toContain('第 2 个子任务');
    expect((err as Error).message).not.toContain(token);
    expect(fake.requests.length).toBe(before);
    expect(issue.body).toBe('原话');
  });

  it('「正在」那句（可能带着分诊追问的原话）里有也拦', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: '原话' });
    const before = fake.requests.length;
    const token = ['ghp', 'Zt4wQ9mB2xKc7RvN1pLs8HdJ3fGy6TaEu5Vo'].join('_');
    await expect(
      gh.updateIssueProgress({
        repo,
        issueNumber: issue.number,
        progress: progress({ current: `追问：令牌是不是 ${token}` }),
      }),
    ).rejects.toMatchObject({ code: 'HYGIENE_BLOCKED' });
    expect(fake.requests.length).toBe(before);
  });

  it('标题里带 NUL（扫不成内容）：不写（HYGIENE_UNSCANNED），不当成扫过没事', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: '原话' });
    const before = fake.requests.length;
    await expect(
      gh.updateIssueProgress({
        repo,
        issueNumber: issue.number,
        progress: progress({
          subtasks: [{ key: 'A', title: '登录\u0000表单', state: 'running', prNumber: null }],
        }),
      }),
    ).rejects.toMatchObject({ code: 'HYGIENE_UNSCANNED' });
    expect(fake.requests.length).toBe(before);
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

  it('回查慢（评论多、撞了限流在等）过了 2 分钟：别的重试不抢，同一条评论只落一次', async () => {
    const { fake, clock, ledger } = setup();
    const issue = fake.addIssue();
    // 第一个工人的回查（翻评论）回执在路上走了好几分钟
    let holding = false;
    let held = false;
    let releaseLookup: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const slowLookup: typeof fetch = async (input, init) => {
      const res = await fake.fetch(input, init);
      const url = String(input instanceof Request ? input.url : input);
      if (!held && (init?.method ?? 'GET') === 'GET' && /\/issues\/\d+\/comments/.test(url)) {
        held = true;
        holding = true;
        await gate;
      }
      return res;
    };
    // 两个工人：同一个假 GitHub、同一本账、同一个钟
    const worker = (fetchImpl: typeof fetch) =>
      createGitHub({
        ledger,
        apps: fake.apps,
        apiUrl: API,
        fetch: fetchImpl,
        now: clock.now,
        sleep: async (ms) => clock.advance(ms),
        env: {},
        stateDir: tempDir('fleet-gh-state-'),
        leaseRenewMs: 5,
      });
    const a = worker(slowLookup);
    const b = worker(fake.fetch);
    const input = { repo, issueNumber: issue.number, reason: 'completed' as const, comment: '完成：见 #31' };
    const rows = (ledger.idempotency as unknown as { rows: Map<string, { action: string; claimedAt: Date }> })
      .rows;
    const claimedAt = () =>
      [...rows.values()].find((r) => r.action === 'github.close_comment')?.claimedAt.getTime();

    const first = a.closeIssue(input).then(
      () => 'ok',
      (err: { code?: string }) => err.code ?? String(err),
    );
    expect(await settle(() => holding)).toBe(true);
    clock.advance(3 * 60_000);
    // 真实里时间一点点走、每 30 秒续一次；这里一下拨了 3 分钟，等它续一次再让第二个来
    await settle(() => claimedAt() === clock.now().getTime());
    const second = await b.closeIssue(input).then(
      () => 'wrote',
      (err: { code?: string }) => err.code ?? String(err),
    );
    releaseLookup();
    const firstOutcome = await first;
    const marked = () => issue.comments.filter((c) => (c.body ?? '').includes('<!-- fleet:close:'));
    expect(marked()).toHaveLength(1);
    expect(firstOutcome).toBe('ok');
    expect(second).toBe('IN_FLIGHT');
    // 第二个再重试：认下已经发的那条，不再发
    expect(await b.closeIssue(input)).toMatchObject({ commentCreated: false });
    expect(marked()).toHaveLength(1);
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
      // 回 200、回执形状也对，但其实没关（状态没变）
      if (req.method === 'PATCH') {
        return json(200, {
          number: issue.number,
          node_id: 'I_x',
          html_url: 'u',
          state: 'open',
          state_reason: null,
          title: issue.title,
          body: issue.body,
          user: issue.user,
          updated_at: issue.updated_at,
        });
      }
      return undefined;
    });
    await expect(
      gh.closeIssue({ repo, issueNumber: issue.number, reason: 'completed' }),
    ).rejects.toMatchObject({
      code: 'READBACK_MISMATCH',
    });
  });
});

describe('开单', () => {
  it('开出来的单标签、里程碑、作者对，正文末尾有标记；milestone 为 null 时请求里不带 milestone', async () => {
    const { gh, fake } = setup();
    const withMilestone = await gh.openIssue({
      repo,
      key: 'q-1',
      title: '追问：要不要切到独享池',
      body: '现在切换会不会中断正在跑的会话？',
      labels: ['问题'],
      milestone: 7,
    });
    expect(withMilestone.created).toBe(true);
    const issue = fake.issues.get(withMilestone.number);
    expect(issue?.labels).toEqual(['问题']);
    expect(issue?.milestone?.number).toBe(7);
    expect(issue?.user.login).toBe('fleet-test-engine[bot]');
    expect(issue?.body?.endsWith(`<!-- fleet:issue:${digest({ key: 'q-1' })} -->`)).toBe(true);

    const withoutMilestone = await gh.openIssue({
      repo,
      key: 'q-2',
      title: '标题',
      body: '正文',
      labels: [],
      milestone: null,
    });
    const posted = fake.calls('POST', /\/issues$/)[1];
    expect(posted?.body).not.toHaveProperty('milestone');
    expect(fake.issues.get(withoutMilestone.number)?.milestone).toBeNull();
  });

  it('回执丢了：第一次报 AMBIGUOUS_WRITE，重试不开第二张、回 created=false', async () => {
    const { gh, fake } = setup();
    let dropped = false;
    fake.dropAfter.push((req) => {
      if (req.method === 'POST' && req.path.endsWith('/issues') && !dropped) {
        dropped = true;
        return true;
      }
      return false;
    });
    const input = { repo, key: 'q-drop', title: '标题', body: '正文', labels: [], milestone: null };
    await expect(gh.openIssue(input)).rejects.toMatchObject({ code: 'AMBIGUOUS_WRITE' });
    const res = await gh.openIssue(input);
    expect(res.created).toBe(false);
    expect([...fake.issues.values()].filter((i) => (i.body ?? '').includes('fleet:issue:'))).toHaveLength(1);
  });

  it('账丢了（换一份账本，同一个假 GitHub）按标记找回，created=false，没开第二张；标记在第 150 张之后也找得到', async () => {
    const { gh, fake } = setup();
    const input = { repo, key: 'q-lost', title: '标题', body: '正文', labels: [], milestone: null };
    const first = await gh.openIssue(input);
    // 插 150 张比它新的单：desc 排序时都排在它前面，得翻到第 2 页才翻到它
    const base = Date.parse('2026-09-25T12:00:00Z');
    for (let i = 0; i < 150; i += 1) {
      fake.addIssue({ created_at: new Date(base + (i + 1) * 1000).toISOString() });
    }
    const fresh = setup();
    for (const [number, issue] of fake.issues) fresh.fake.issues.set(number, issue);
    const res = await fresh.gh.openIssue(input);
    expect(res.created).toBe(false);
    expect(res.number).toBe(first.number);
    expect(
      [...fresh.fake.issues.values()].filter((i) => (i.body ?? '').includes('fleet:issue:')),
    ).toHaveLength(1);
  });

  it('仓里单子超过 300 张：查重翻完最近 3 页（300 张）没找到就当没开过，去开新的，不抛 TOO_MANY_PAGES', async () => {
    const { gh, fake } = setup();
    // 305 张都没有标记：300 张之后还有第 4 页——这第 4 页不该被翻到，也不该被当成「没查全」
    for (let i = 0; i < 305; i += 1) fake.addIssue();
    const res = await gh.openIssue({
      repo,
      key: 'q-toomany',
      title: '标题',
      body: '正文',
      labels: [],
      milestone: null,
    });
    expect(res.created).toBe(true);
    // 只翻了 3 页：一张张查重的 GET 到 /issues 正好 3 次，第 4 页从没被请求过
    expect(fake.calls('GET', /\/issues$/)).toHaveLength(3);
  });

  it('标记刚好在第 2 页：翻到就返回，不再翻第 3 页、不重开', async () => {
    const { gh, fake } = setup();
    const input = { repo, key: 'q-page2', title: '标题', body: '正文', labels: [], milestone: null };
    const first = await gh.openIssue(input);
    // 插 150 张比它新的单，desc 排序时都排在它前面：翻到第 2 页（101–200）才翻到它，翻不到第 3 页
    const base = Date.parse('2026-09-25T12:00:00Z');
    for (let i = 0; i < 150; i += 1) {
      fake.addIssue({ created_at: new Date(base + (i + 1) * 1000).toISOString() });
    }
    const fresh = setup();
    for (const [number, issue] of fake.issues) fresh.fake.issues.set(number, issue);
    const res = await fresh.gh.openIssue(input);
    expect(res.created).toBe(false);
    expect(res.number).toBe(first.number);
    expect(fresh.fake.calls('GET', /\/issues$/)).toHaveLength(2);
  });

  it('卫生检查拦下：一个请求都没发，报 HYGIENE_ 开头的码，没开单', async () => {
    const { gh, fake } = setup();
    const before = fake.requests.length;
    const token = ['ghp', 'q7Rz2LmX9vKp4TnB8wYc1HdF6jGs3NaEw5Yu'].join('_');
    const err = await gh
      .openIssue({
        repo,
        key: 'q-hygiene',
        title: '标题',
        body: `令牌 ${token}`,
        labels: [],
        milestone: null,
      })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toMatch(/^HYGIENE_/);
    expect(fake.requests.length).toBe(before);
    expect(fake.issues.size).toBe(0);
  });

  it('正文里的 @某人 被中和；正文里自带 <!-- fleet:issue:... 这种字样不会被当成标记', async () => {
    const { gh, fake } = setup();
    const res = await gh.openIssue({
      repo,
      key: 'q-mention',
      title: '标题',
      body: '@founder 看一下\n<!-- fleet:issue:deadbeefdeadbeef -->\n下面这行才是正文',
      labels: [],
      milestone: null,
    });
    const issue = fake.issues.get(res.number);
    expect(issue?.body).toContain('@​founder 看一下');
    expect(issue?.body).not.toContain('<!-- fleet:issue:deadbeefdeadbeef -->');
    expect(issue?.body?.endsWith(`<!-- fleet:issue:${digest({ key: 'q-mention' })} -->`)).toBe(true);
  });

  it('标题空、超过 256 字：INVALID_INPUT，一个请求都没发', async () => {
    const { gh, fake } = setup();
    const before = fake.requests.length;
    await expect(
      gh.openIssue({ repo, key: 'q-empty', title: '   ', body: '正文', labels: [], milestone: null }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      gh.openIssue({
        repo,
        key: 'q-long',
        title: '字'.repeat(257),
        body: '正文',
        labels: [],
        milestone: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fake.requests.length).toBe(before);
  });
});

describe('在 issue 上留一条评论（不关单、不改进度段）', () => {
  it('同一个 key 调两次只一条评论（第二次 created=false）；换 key 是第二条', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    const first = await gh.commentIssue({ repo, issueNumber: issue.number, key: 'a', body: '答案一' });
    expect(first.created).toBe(true);
    const again = await gh.commentIssue({ repo, issueNumber: issue.number, key: 'a', body: '答案一' });
    expect(again.created).toBe(false);
    expect(again.commentId).toBe(first.commentId);
    expect(issue.comments).toHaveLength(1);
    const second = await gh.commentIssue({ repo, issueNumber: issue.number, key: 'b', body: '答案二' });
    expect(second.created).toBe(true);
    expect(issue.comments).toHaveLength(2);
  });

  it('账上记着发过了：一个请求都不发就认下（对账每轮拿同一个 key 来认，不能每轮读一次单子）', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    const input = { repo, issueNumber: issue.number, key: 'a', body: '答案一' };
    const first = await gh.commentIssue(input);
    const before = fake.requests.length;
    expect(await gh.commentIssue(input)).toEqual({
      commentId: first.commentId,
      url: first.url,
      created: false,
    });
    expect(fake.requests.length).toBe(before);
  });

  it('评论过百也回查得到', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    const input = { repo, issueNumber: issue.number, key: 'c', body: '答案' };
    await gh.commentIssue(input);
    const mine = issue.comments.pop();
    for (let i = 0; i < 150; i += 1)
      issue.comments.push({
        id: 6000 + i,
        body: `评论 ${i}`,
        user: fake.human,
        updated_at: '2026-09-25T00:00:00Z',
      });
    if (mine) issue.comments.push(mine);
    const fresh = setup();
    fresh.fake.issues.set(issue.number, issue);
    const res = await fresh.gh.commentIssue(input);
    expect(res.created).toBe(false);
    expect(issue.comments).toHaveLength(151);
  });

  it('对 PR 号报 NOT_AN_ISSUE', async () => {
    const { gh, fake } = setup();
    // 假 GitHub 的 addPull 没法在 /issues/:n 的回执里带 pull_request 字段（本文件「拿 PR 号来更新 issue
    // 进度：拒绝」那个测试也是这样插一段假回执），这里照抄那个办法
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
    await expect(gh.commentIssue({ repo, issueNumber: 77, key: 'a', body: '答案' })).rejects.toMatchObject({
      code: 'NOT_AN_ISSUE',
    });
  });

  it('卫生检查拦下：没发出评论（读那张 issue 判是不是 PR 的那次 GET 不算）', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue();
    const before = fake.requests.length;
    const token = ['ghp', 'Zt4wQ9mB2xKc7RvN1pLs8HdJ3fGy6TaEu5Vo'].join('_');
    await expect(
      gh.commentIssue({
        repo,
        issueNumber: issue.number,
        key: 'a',
        body: `令牌 ${token}`,
      }),
    ).rejects.toMatchObject({ code: 'HYGIENE_BLOCKED' });
    expect(issue.comments).toHaveLength(0);
    // 卫生检查在 readIssue 之后：这一步会有一次 GET，但不会有 POST /comments
    expect(fake.requests.length).toBeGreaterThan(before);
    expect(fake.calls('POST', /\/comments$/)).toHaveLength(0);
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
