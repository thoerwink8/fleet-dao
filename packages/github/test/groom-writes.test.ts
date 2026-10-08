// 临时指挥官整理待办（#1338）要用的两个 GitHub 口：往一张单正文末尾追加一段（原文不动、幂等）、读最近关掉的单（开新单前查重）。
import { describe, expect, it } from 'vitest';
import { repo, setup } from './helpers.ts';

const ORIGINAL = '## 场景\n\n想要导出。\n\n## 原话\n\n「导出」\n';
const APPEND = '## 引擎整理补充\n\n### 怎么算做完\n\n- 页面上多出「导出」按钮';

describe('appendIssueBody · 往正文末尾追加，原文不动', () => {
  it('原文一字不动，追加段接在末尾；用「引擎」身份写', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: ORIGINAL });
    const got = await gh.appendIssueBody({ repo, issueNumber: issue.number, key: 'k1', text: APPEND });
    expect(got).toMatchObject({ outcome: 'written', restoredHumanEdit: false });
    expect(issue.body?.startsWith(ORIGINAL.trimEnd())).toBe(true);
    expect(issue.body).toContain('## 引擎整理补充');
    expect(issue.body).toContain('页面上多出「导出」按钮');
    expect(fake.calls('PATCH', /\/issues\/\d+$/).map((r) => r.as)).toEqual(['engine']);
  });

  it('同一个 key 再来一次不重复追加（幂等），换 key 才是新的一段', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: ORIGINAL });
    await gh.appendIssueBody({ repo, issueNumber: issue.number, key: 'k1', text: APPEND });
    const second = await gh.appendIssueBody({ repo, issueNumber: issue.number, key: 'k1', text: APPEND });
    expect(second.outcome).toBe('unchanged');
    expect(fake.calls('PATCH', /\/issues\/\d+$/)).toHaveLength(1);
    expect((issue.body?.match(/## 引擎整理补充/g) ?? []).length).toBe(1);
  });

  it('追加的文字里的 @某人 被中和，<!-- --> 不能伪造标记', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: ORIGINAL });
    await gh.appendIssueBody({
      repo,
      issueNumber: issue.number,
      key: 'k1',
      text: '请 @founder 看 <!-- fleet:progress:start -->',
    });
    expect(issue.body).not.toContain('@founder');
    expect(issue.body).not.toMatch(/<!-- fleet:progress:start -->/);
  });

  it('【故意造出的失败】对 PR 号追加 → NOT_AN_ISSUE，什么都没改', async () => {
    const { gh, fake } = setup();
    const pr = fake.addPull({ head: { ref: 'fleet/1-a', sha: 'a'.repeat(40) } });
    const err = await gh
      .appendIssueBody({ repo, issueNumber: pr.number, key: 'k1', text: APPEND })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('NOT_AN_ISSUE');
    expect(fake.calls('PATCH', /\/issues\/\d+$/)).toHaveLength(0);
  });

  it('【故意造出的失败】追加的内容是空的 → INVALID_INPUT，一个请求都不发', async () => {
    const { gh, fake } = setup();
    const issue = fake.addIssue({ body: ORIGINAL });
    const before = fake.requests.length;
    const err = await gh
      .appendIssueBody({ repo, issueNumber: issue.number, key: 'k1', text: '   ' })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('INVALID_INPUT');
    expect(fake.requests.length).toBe(before);
  });
});

describe('listClosedIssues · 最近关掉的单', () => {
  it('只给 since 之后关掉的单，不含开着的、不含 PR', async () => {
    const { gh, fake } = setup();
    fake.addIssue({ title: '开着的' });
    const closed = fake.addIssue({ title: '关掉的', state: 'closed', body: '正文' });
    fake.addPull({ head: { ref: 'fleet/9-a', sha: 'b'.repeat(40) }, state: 'closed' });
    const got = await gh.listClosedIssues({ repo, since: new Date('2026-09-01T00:00:00Z') });
    expect(got.map((g) => [g.number, g.title, g.body])).toEqual([[closed.number, '关掉的', '正文']]);
  });

  it('关得比 since 还早的不给', async () => {
    const { gh, fake } = setup();
    fake.addIssue({ title: '关掉的', state: 'closed' });
    const got = await gh.listClosedIssues({ repo, since: new Date('2026-10-01T00:00:00Z') });
    expect(got).toEqual([]);
  });

  it('【故意造出的失败】读回来的形状认不出 → 抛错，不拿空列表冒充没有', async () => {
    const { gh, fake } = setup();
    fake.before.push((req) => {
      if (req.method === 'GET' && /\/issues$/.test(req.path)) {
        return new Response(JSON.stringify([{ number: 'x' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return undefined;
    });
    await expect(gh.listClosedIssues({ repo, since: new Date('2026-09-01T00:00:00Z') })).rejects.toThrow();
  });
});
