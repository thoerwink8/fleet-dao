// 开单服务（决定 0122，母单 #3739 第 1 片）：POST /api/nodes/issues 开单 / 查重 / 并单 / 幂等，GET /api/nodes/events 读账本。
// GitHub 用假端口（内存里记开了哪些单），不连真 GitHub。
import { NODE_REPORT_HEADER } from '@fleet-dao/shared';
import { describe, expect, it, vi } from 'vitest';
import type { IntakeIssuesPort } from '../src/intake.ts';
import { nodeKeyHash } from '../src/node-report.ts';
import { harness } from './harness.ts';

const TOKEN = 'token-of-founder-pc-0123456789abcdefghijk';
const KEYS = { 'founder-pc': nodeKeyHash(TOKEN) };
const REPO = 'example/canary';

const GOOD_BODY = [
  '## 场景',
  '本机开单要经法国的开单服务，别各开各的。',
  '',
  '## 原话',
  '无（AI 发现）',
  '',
  '## 已知的模块',
  '暂无',
  '',
  '## 怎么算做完',
  '- `npx vitest run packages/api/test/intake.test.ts` 全绿',
].join('\n');

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  milestone: '当前' | '未排期';
}

/** 假 GitHub：记开出来的单和评论；同一个 key 第二次开回原来那张（created:false），和真的 openIssue 一样。 */
function fakeGitHub(seed: { number: number; title: string; body?: string }[] = []) {
  const issues: FakeIssue[] = seed.map((s) => ({
    number: s.number,
    title: s.title,
    body: s.body ?? '',
    labels: [],
    milestone: '未排期',
  }));
  const byKey = new Map<string, { number: number; url: string }>();
  const comments: { issueNumber: number; key: string; body: string }[] = [];
  const commentByKey = new Map<string, { commentId: number; url: string }>();
  let next = 100;
  const port: IntakeIssuesPort = {
    async listOpenIssues() {
      return issues.map((i) => ({ number: i.number, title: i.title, body: i.body }));
    },
    async openIssue(input) {
      const old = byKey.get(input.key);
      if (old) return { ...old, created: false };
      const number = next++;
      const got = { number, url: `https://github.com/${REPO}/issues/${number}` };
      byKey.set(input.key, got);
      issues.push({
        number,
        title: input.title,
        body: input.body,
        labels: input.labels,
        milestone: input.milestone,
      });
      return { ...got, created: true };
    },
    async commentIssue(input) {
      const old = commentByKey.get(input.key);
      if (old) return { ...old, created: false };
      comments.push({ issueNumber: input.issueNumber, key: input.key, body: input.body });
      const got = {
        commentId: comments.length,
        url: `https://github.com/${REPO}/issues/${input.issueNumber}#c${comments.length}`,
      };
      commentByKey.set(input.key, got);
      return { ...got, created: true };
    },
  };
  return { port, issues, comments };
}

const request = (over: Record<string, unknown> = {}) => ({
  repo: REPO,
  kind: '需求',
  domain: 'api',
  nature: 'process',
  milestone: '当前',
  title: '开单服务第一片',
  body: GOOD_BODY,
  local: false,
  source: { kind: 'local-session', ref: 'sess-42' },
  idempotencyKey: 'key-0001-aaaa',
  ...over,
});

function post(
  h: ReturnType<typeof harness>,
  body: unknown,
  headers: Record<string, string> = { [NODE_REPORT_HEADER]: TOKEN },
) {
  return h.cockpit.request('/api/nodes/issues', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const get = (
  h: ReturnType<typeof harness>,
  query = '',
  headers: Record<string, string> = { [NODE_REPORT_HEADER]: TOKEN },
) => h.cockpit.request(`/api/nodes/events${query}`, { headers });
interface ErrDetails {
  problems: { field: string }[];
  candidates: unknown[];
}
const errOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string; details: ErrDetails } }).error;
const issueAudit = (h: ReturnType<typeof harness>) =>
  h.store.data.audit.filter((a) => a.target.startsWith('issue:'));

describe('POST /api/nodes/issues：认人', () => {
  it('【故意造出的失败】没带通行证、带错通行证都是 401，不开单、不记账', async () => {
    const gh = fakeGitHub();
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    expect((await post(h, request(), {})).status).toBe(401);
    expect((await post(h, request(), { [NODE_REPORT_HEADER]: 'not-the-token' })).status).toBe(401);
    expect(gh.issues).toEqual([]);
    expect(issueAudit(h)).toEqual([]);
  });

  it('凭据没读到（没装配 GitHub 端口）回 503，不假装开了', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    const res = await post(h, request());
    expect(res.status).toBe(503);
    expect((await errOf(res)).code).toBe('intake_not_wired');
    expect(issueAudit(h)).toEqual([]);
  });

  it('多一个字段 400；仓不归法国管 404', async () => {
    const gh = fakeGitHub();
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    expect((await post(h, request({ extra: 1 }))).status).toBe(400);
    const res = await post(h, request({ repo: 'someone/else' }));
    expect(res.status).toBe(404);
    expect((await errOf(res)).code).toBe('unknown_repo');
    expect(gh.issues).toEqual([]);
  });
});

describe('POST /api/nodes/issues：开单', () => {
  it('正文齐了就开：标签、里程碑、来源行都在，回 {number,url,created}，记一条 issue.open', async () => {
    const gh = fakeGitHub();
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    const res = await post(h, request({ local: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      number: 100,
      url: `https://github.com/${REPO}/issues/100`,
      created: true,
    });
    const opened = gh.issues[0];
    expect(opened?.labels).toEqual(['需求', '域:api', '性质:process', '本机做']);
    expect(opened?.milestone).toBe('当前');
    expect(opened?.body).toContain(GOOD_BODY);
    expect(opened?.body).toContain('来源：local-session sess-42（单键 key-0001-aaaa）');
    const [row, ...rest] = issueAudit(h);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      action: 'issue.open',
      target: `issue:${REPO}#100`,
      via: 'agent',
      actor: { kind: 'agent', id: 'node:founder-pc' },
      ok: true,
      after: {
        nodeId: 'founder-pc',
        number: 100,
        title: '开单服务第一片',
        source: { kind: 'local-session', ref: 'sess-42' },
      },
    });
  });

  it('未排期不挂里程碑；不带 local 不贴「本机做」', async () => {
    const gh = fakeGitHub();
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    await post(h, request({ milestone: '未排期' }));
    expect(gh.issues[0]?.milestone).toBe('未排期');
    expect(gh.issues[0]?.labels).not.toContain('本机做');
  });

  it('【故意造出的失败】正文缺节：422，一次列出所有问题，不开单、不记账', async () => {
    const gh = fakeGitHub();
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    const res = await post(h, request({ body: '## 场景\n只写了场景。' }));
    expect(res.status).toBe(422);
    const e = await errOf(res);
    expect(e.code).toBe('invalid_issue_body');
    const fields = (e.details.problems as { field: string }[]).map((p) => p.field);
    expect(fields).toEqual(expect.arrayContaining(['原话', '已知的模块', '怎么算做完']));
    expect(gh.issues).toEqual([]);
    expect(issueAudit(h)).toEqual([]);
  });

  it('【故意造出的失败】缺陷没有「## 影响」：422；写上就开', async () => {
    const gh = fakeGitHub();
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    const res = await post(h, request({ kind: '缺陷' }));
    expect(res.status).toBe(422);
    const e = await errOf(res);
    expect((e.details.problems as { field: string }[]).map((p) => p.field)).toContain('影响');
    const ok = await post(h, request({ kind: '缺陷', body: `${GOOD_BODY}\n\n## 影响\n一轮做成率变差。` }));
    expect(ok.status).toBe(200);
    expect(gh.issues[0]?.labels[0]).toBe('缺陷');
  });
});

describe('POST /api/nodes/issues：查重', () => {
  const twin = { number: 7, title: '开单服务第一片' };

  it('【故意造出的失败】和开着的单强命中：409 带候选，不开单，记 issue.duplicate_refused（target 用分最高的那张）', async () => {
    const gh = fakeGitHub([twin, { number: 8, title: '飞书消息排版' }]);
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    const res = await post(h, request());
    expect(res.status).toBe(409);
    const e = await errOf(res);
    expect(e.code).toBe('duplicate_suspected');
    expect(e.details.candidates).toEqual([
      expect.objectContaining({
        number: 7,
        title: '开单服务第一片',
        score: expect.any(Number),
        why: expect.stringContaining('标题里都有'),
      }),
    ]);
    expect(gh.issues).toHaveLength(2);
    const [row] = issueAudit(h);
    expect(row).toMatchObject({ action: 'issue.duplicate_refused', target: `issue:${REPO}#7`, via: 'agent' });
  });

  it('force 照开', async () => {
    const gh = fakeGitHub([twin]);
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    const res = await post(h, request({ force: true }));
    expect(res.status).toBe(200);
    expect(gh.issues).toHaveLength(2);
    expect(issueAudit(h).map((a) => a.action)).toEqual(['issue.open']);
  });

  it('不像的单不拦', async () => {
    const gh = fakeGitHub([{ number: 9, title: '登录页加验证码' }]);
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    expect((await post(h, request())).status).toBe(200);
  });

  it('读不到开着的单：503，不当成没有重复', async () => {
    const gh = fakeGitHub();
    gh.port.listOpenIssues = async () => {
      throw new Error('boom');
    };
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    const res = await post(h, request());
    expect(res.status).toBe(503);
    expect((await errOf(res)).code).toBe('duplicate_check_unavailable');
    expect(gh.issues).toEqual([]);
  });

  it('同一个 idempotencyKey 第二次：不再开新单，也不被自己拦成重复；回 created:false', async () => {
    const gh = fakeGitHub();
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    const first = await post(h, request());
    const second = await post(h, request());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      number: 100,
      url: `https://github.com/${REPO}/issues/100`,
      created: false,
    });
    expect(gh.issues).toHaveLength(1);
    expect(issueAudit(h).map((a) => a.action)).toEqual(['issue.open', 'issue.open']);
    expect(issueAudit(h)[1]?.after).toMatchObject({ created: false });
  });
});

describe('POST /api/nodes/issues：mergeInto', () => {
  it('不开新单，在那张单上留一条评论（标题、正文、来源），幂等，记 issue.merge', async () => {
    const gh = fakeGitHub([{ number: 7, title: '开单服务第一片' }]);
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    const res = await post(h, request({ mergeInto: 7 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      number: 7,
      url: expect.stringContaining('/issues/7#c1'),
      created: true,
      merged: true,
    });
    expect(gh.issues).toHaveLength(1);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toMatchObject({ issueNumber: 7, key: 'key-0001-aaaa' });
    expect(gh.comments[0]?.body).toContain('开单服务第一片');
    expect(gh.comments[0]?.body).toContain('本机开单要经法国的开单服务');
    expect(gh.comments[0]?.body).toContain('local-session sess-42');
    const [row] = issueAudit(h);
    expect(row).toMatchObject({ action: 'issue.merge', target: `issue:${REPO}#7` });
    const again = await post(h, request({ mergeInto: 7 }));
    expect(((await again.json()) as { created: boolean }).created).toBe(false);
    expect(gh.comments).toHaveLength(1);
  });
});

describe('GET /api/nodes/events：读账本', () => {
  it('【故意造出的失败】没带或带错通行证 401', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    expect((await get(h, '', {})).status).toBe(401);
    expect((await get(h, '', { [NODE_REPORT_HEADER]: 'nope' })).status).toBe(401);
  });

  async function seeded() {
    const gh = fakeGitHub();
    const h = harness({ config: { nodeKeys: KEYS }, intakeIssues: gh.port });
    // 夹两条不相干的操作记录进来：账本只给 issue: 开头的
    await post(h, request({ idempotencyKey: 'key-0001-aaaa', title: '第一张' }));
    await h.store.appendAudit({
      actor: { kind: 'ops', id: 'x' },
      action: 'task.pause',
      target: 'task:1',
      via: 'ops',
      ok: true,
    });
    await post(h, request({ idempotencyKey: 'key-0002-bbbb', title: '第二张完全不同的话题', force: true }));
    await h.store.appendAudit({
      actor: { kind: 'ops', id: 'x' },
      action: 'login',
      target: 'issuer:1',
      via: 'ops',
      ok: true,
    });
    await post(h, request({ idempotencyKey: 'key-0003-cccc', title: '第三张另一个说法', force: true }));
    return h;
  }

  it('只给 issue: 开头的行，按 id 升序，next 是最后一条的 id', async () => {
    const h = await seeded();
    const body = (await (await get(h)).json()) as {
      events: { id: number; action: string; target: string; actorId: string; after: { title: string } }[];
      next: number;
    };
    expect(body.events.map((e) => e.target)).toEqual([
      `issue:${REPO}#100`,
      `issue:${REPO}#101`,
      `issue:${REPO}#102`,
    ]);
    expect(body.events.map((e) => e.after.title)).toEqual([
      '第一张',
      '第二张完全不同的话题',
      '第三张另一个说法',
    ]);
    expect(body.events[0]).toMatchObject({
      action: 'issue.open',
      actorKind: 'agent',
      actorId: 'node:founder-pc',
      ok: true,
    });
    const ids = body.events.map((e) => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(body.next).toBe(ids.at(-1));
  });

  it('按 after 翻页：一页一条，翻到头 next 原样不动', async () => {
    const h = await seeded();
    const seen: string[] = [];
    let after = 0;
    for (let i = 0; i < 5; i++) {
      const page = (await (await get(h, `?after=${after}&limit=1`)).json()) as {
        events: { target: string }[];
        next: number;
      };
      if (page.events.length === 0) {
        expect(page.next).toBe(after);
        break;
      }
      expect(page.events).toHaveLength(1);
      seen.push(page.events[0]?.target ?? '');
      after = page.next;
    }
    expect(seen).toEqual([`issue:${REPO}#100`, `issue:${REPO}#101`, `issue:${REPO}#102`]);
  });

  it('limit 默认 100、最多 500（超了按 500 给），坏参数 400', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    const spy = vi.spyOn(h.store, 'listIssueEvents');
    await get(h);
    await get(h, '?limit=100000');
    await get(h, '?limit=7&after=3');
    expect(spy.mock.calls.map(([q]) => q)).toEqual([
      { after: 0, limit: 100 },
      { after: 0, limit: 500 },
      { after: 3, limit: 7 },
    ]);
    expect((await get(h, '?limit=0')).status).toBe(400);
    expect((await get(h, '?after=-1')).status).toBe(400);
    expect((await get(h, '?after=abc')).status).toBe(400);
  });

  it('库读失败 503，不拿空列表冒充没有新事件', async () => {
    const h = harness({ config: { nodeKeys: KEYS } });
    vi.spyOn(h.store, 'listIssueEvents').mockRejectedValue(new Error('db down'));
    const res = await get(h);
    expect(res.status).toBe(503);
    expect((await errOf(res)).code).toBe('issue_events_unreadable');
  });
});
