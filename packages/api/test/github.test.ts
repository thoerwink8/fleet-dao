import { describe, expect, it } from 'vitest';
import { devFixtures } from '../src/dev-fixtures.ts';
import {
  createGitHubIntake,
  githubAppMissing,
  githubEventsCheck,
  githubWhitelist,
  objectKey,
  pollDeliveryId,
  screenGithubEvent,
  verifyGithubSignature,
  versionsOf,
} from '../src/github.ts';
import type { GitHubDelivery } from '../src/ports.ts';
import {
  deliverGithub as deliver,
  errorCode,
  harness,
  WEBHOOK_SECRET as SECRET,
  signGithub as sign,
  T0,
} from './harness.ts';

const REPO = { full_name: 'example/canary' };
const founderA = { login: 'founder-a', id: 1001, type: 'User' };
const founderB = { login: 'Founder-B', id: 5555, type: 'User' }; // 白名单里只登记了登录名
const stranger = { login: 'stranger', id: 4242, type: 'User' };
const workerBot = { login: 'fleet-worker[bot]', id: 9001, type: 'Bot' };

const issueOpened = (user: object, sender: object = user) => ({
  action: 'opened',
  issue: {
    number: 12,
    title: '登录页加验证码',
    body: '给登录页加手机验证码',
    state: 'open',
    user,
    created_at: '2026-09-25T07:59:00Z',
    updated_at: '2026-09-25T07:59:00Z',
  },
  sender,
  repository: REPO,
});

describe('GitHub 事件签名', () => {
  it('签名对才收；不对、缺签名、用别的密钥签：401 并留日志，不交给引擎', async () => {
    const h = harness();
    expect((await deliver(h, 'issues', issueOpened(founderA))).status).toBe(200);
    expect(await errorCode(await deliver(h, 'issues', issueOpened(founderA), { signature: null }))).toBe(
      'bad_signature',
    );
    expect(
      await errorCode(await deliver(h, 'issues', issueOpened(founderA), { signature: 'sha256=00' })),
    ).toBe('bad_signature');
    const forged = JSON.stringify(issueOpened(founderA));
    expect(
      (await deliver(h, 'issues', issueOpened(founderA), { signature: sign(forged, 'guess') })).status,
    ).toBe(401);
    expect(h.accepted).toHaveLength(1);
    expect(h.logs.filter((l) => l.message.includes('签名不对'))).toHaveLength(3);
  });

  it('按原始字节验：改一个字节就不认', () => {
    const body = new TextEncoder().encode('{"a":1}');
    const header = sign('{"a":1}');
    expect(verifyGithubSignature(SECRET, body, header)).toBe(true);
    expect(verifyGithubSignature(SECRET, new TextEncoder().encode('{"a":2}'), header)).toBe(false);
    expect(verifyGithubSignature(SECRET, body, header.toUpperCase().replace('SHA256', 'sha256'))).toBe(true);
    expect(verifyGithubSignature(SECRET, body, `sha1=${'0'.repeat(40)}`)).toBe(false);
  });

  it('没配密钥：503（不会无签名放行）', async () => {
    const h = harness({ config: { githubWebhookSecret: null } });
    expect((await deliver(h, 'issues', issueOpened(founderA))).status).toBe(503);
  });

  it('香港原样透传：按收到的原始字节验，带缩进、键序随意的原文验得过；被重新序列化过（空格、键序变了）就验不过', async () => {
    const h = harness();
    // GitHub 发来的原文：两格缩进、repository 排在前面。签名是对这份字节算的
    const original = `{\n  "repository": ${JSON.stringify(REPO)},\n  "action": "opened",\n  "sender": ${JSON.stringify(founderA)},\n  "issue": ${JSON.stringify(issueOpened(founderA).issue)}\n}`;
    const signature = sign(original);
    const ok = await deliver(h, 'issues', null, { body: original, signature });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ verdict: 'accepted' });
    // 内容一模一样，只是被中间谁解析再序列化了一遍：字节变了，签名就对不上
    const reserialized = JSON.stringify(JSON.parse(original));
    expect(reserialized).not.toBe(original);
    const bad = await deliver(h, 'issues', null, { body: reserialized, signature, delivery: 'reserialized' });
    expect(bad.status).toBe(401);
    expect(await errorCode(bad)).toBe('bad_signature');
    const { action, sender, issue, repository } = JSON.parse(original);
    const reordered = JSON.stringify({ issue, sender, action, repository });
    expect(
      (
        await deliver(h, 'issues', null, {
          body: reordered,
          signature: sign(original),
          delivery: 'reordered',
        })
      ).status,
    ).toBe(401);
    // 验签不过的一律不落库：没认证的请求不许往库里写
    expect(await h.store.getDelivery('reserialized')).toBeNull();
    expect(await h.store.getDelivery('reordered')).toBeNull();
  });
});

describe('读不到的请求：明确失败、留日志，不当成「没事件」', () => {
  it('缺投递编号或事件名：400，留日志，不落库', async () => {
    const h = harness();
    const body = JSON.stringify(issueOpened(founderA));
    const res = await h.cockpit.request('/github/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      body,
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('missing_headers');
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('缺投递编号'))).toBe(true);
    expect(h.store.data.githubEvents.size).toBe(0);
  });

  it('签名对、请求体却不是 JSON（Content type 选成了表单）：400，留日志，不落库', async () => {
    const h = harness();
    const body = 'payload=%7B%22action%22%3A%22opened%22%7D';
    const res = await deliver(h, 'issues', null, { body, delivery: 'form-encoded' });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('invalid_json');
    expect(h.logs.some((l) => l.level === 'warn' && l.fields?.deliveryId === 'form-encoded')).toBe(true);
    expect(await h.store.getDelivery('form-encoded')).toBeNull();
  });

  it('认得的事件、形状认不出：不收，原因记进库、告警，不交给后面', async () => {
    const h = harness();
    const broken = { ...issueOpened(founderA), issue: { number: 12, user: founderA } };
    const res = await deliver(h, 'issues', broken, { delivery: 'broken' });
    expect(await res.json()).toMatchObject({ verdict: 'ignored', reason: 'payload_unreadable' });
    expect(await h.store.getDelivery('broken')).toMatchObject({
      status: 'ignored',
      reason: 'payload_unreadable',
      payload: broken,
    });
    expect(h.logs.some((l) => l.level === 'warn' && l.fields?.reason === 'payload_unreadable')).toBe(true);
    expect(h.accepted).toEqual([]);
  });
});

describe('原文落库', () => {
  it('放进来的、不收的都记一行：原文、事件、仓、结局和原因；处理完的带上做了什么', async () => {
    const h = harness();
    await deliver(h, 'issues', issueOpened(founderA), { delivery: 'kept' });
    await deliver(h, 'issues', issueOpened(stranger), { delivery: 'stranger' });
    expect(await h.store.getDelivery('kept')).toMatchObject({
      event: 'issues',
      action: 'opened',
      source: 'webhook',
      repo: 'example/canary',
      versions: [{ object: 'example/canary:issue:12', version: '2026-09-25T07:59:00.000Z', state: 'open' }],
      payload: issueOpened(founderA),
      status: 'accepted',
      note: 'task=exists, workflow=dispatch_off',
      attempts: 1,
    });
    expect(await h.store.getDelivery('stranger')).toMatchObject({
      status: 'ignored',
      reason: 'author_not_whitelisted',
    });
  });

  it('重放：按库里的原文再走一遍门（改了名单之后，当初不收的现在收）', async () => {
    const h = harness();
    await deliver(h, 'issues', issueOpened(stranger), { delivery: 'late' });
    expect((await h.store.getDelivery('late'))?.status).toBe('ignored');
    h.store.data.users.push({
      id: 'e0000000-0000-4000-8000-00000000000c',
      displayName: '新协作者',
      role: 'collaborator',
      active: true,
      githubId: stranger.id,
    });
    const intake = createGitHubIntake(h.deps);
    expect(await intake.replay('late')).toEqual({ verdict: 'finished' });
    expect(await intake.replay('late', { force: true })).toMatchObject({ verdict: 'accepted' });
    expect(await h.store.getDelivery('late')).toMatchObject({ status: 'accepted', attempts: 2 });
    expect(await intake.replay('never-seen')).toEqual({ verdict: 'not_found' });
  });
});

describe('GitHub 事件白名单与去重', () => {
  it('白名单作者开的单：收下并叫醒；陌生人开的单、评论：不收', async () => {
    const h = harness();
    const ok = await deliver(h, 'issues', issueOpened(founderA));
    expect(await ok.json()).toMatchObject({ verdict: 'accepted', wake: true });
    expect(h.accepted[0]).toMatchObject({
      event: 'issues',
      action: 'opened',
      repo: 'example/canary',
      wake: true,
    });

    expect(await (await deliver(h, 'issues', issueOpened(stranger))).json()).toMatchObject({
      verdict: 'ignored',
      reason: 'author_not_whitelisted',
    });
    const strangerComment = {
      action: 'created',
      issue: { number: 12, user: founderA },
      comment: { id: 1, user: stranger },
      sender: stranger,
      repository: REPO,
    };
    expect(await (await deliver(h, 'issue_comment', strangerComment)).json()).toMatchObject({
      verdict: 'ignored',
    });
    expect(h.accepted).toHaveLength(1);
  });

  it('同一个投递编号来两次：只处理一次', async () => {
    const h = harness();
    await deliver(h, 'issues', issueOpened(founderA), { delivery: 'same' });
    const again = await deliver(h, 'issues', issueOpened(founderA), { delivery: 'same' });
    expect(await again.json()).toMatchObject({ verdict: 'duplicate' });
    expect(h.accepted).toHaveLength(1);
  });

  it('交给后面处理失败：500，这条记成出错（原因、原文都在）；GitHub 重投时照样能进来，次数加一', async () => {
    let fail = true;
    const h = harness({
      github: async () => {
        if (fail) throw new Error('库连不上');
      },
    });
    expect((await deliver(h, 'issues', issueOpened(founderA), { delivery: 'retry-me' })).status).toBe(500);
    expect(await h.store.getDelivery('retry-me')).toMatchObject({
      status: 'failed',
      reason: '库连不上',
      payload: issueOpened(founderA),
      attempts: 1,
    });
    fail = false;
    const redelivered = await deliver(h, 'issues', issueOpened(founderA), { delivery: 'retry-me' });
    expect(await redelivered.json()).toMatchObject({ verdict: 'accepted' });
    expect(await h.store.getDelivery('retry-me')).toMatchObject({ status: 'accepted', attempts: 2 });
  });

  it('白名单作者的单被外人编辑：不收并告警；自家机器人的动作只同步镜像不叫醒', async () => {
    const h = harness();
    const edited = { ...issueOpened(founderA, stranger), action: 'edited' };
    expect(await (await deliver(h, 'issues', edited)).json()).toMatchObject({ reason: 'edited_by_outsider' });
    expect(h.logs.some((l) => l.level === 'warn' && l.fields?.reason === 'edited_by_outsider')).toBe(true);

    const botEdit = { ...issueOpened(founderA, workerBot), action: 'edited' };
    expect(await (await deliver(h, 'issues', botEdit)).json()).toMatchObject({
      verdict: 'accepted',
      wake: false,
    });
  });

  it('不是本系统管的仓、从 fork 来的 PR：不收', async () => {
    const h = harness();
    const otherRepo = { ...issueOpened(founderA), repository: { full_name: 'someone/else' } };
    expect(await (await deliver(h, 'issues', otherRepo)).json()).toMatchObject({
      reason: 'repo_not_managed',
    });
    const forkPr = {
      action: 'opened',
      pull_request: {
        number: 5,
        user: founderA,
        head: { repo: { full_name: 'founder-a/canary' } },
        base: { repo: REPO },
      },
      sender: founderA,
      repository: REPO,
    };
    expect(await (await deliver(h, 'pull_request', forkPr)).json()).toMatchObject({ reason: 'from_fork' });
  });

  it('ping 和本仓的 CI 事件：不看作者；不认识的事件：不收', async () => {
    const h = harness();
    expect(await (await deliver(h, 'ping', { zen: 'hi', hook_id: 1 })).json()).toMatchObject({
      verdict: 'accepted',
      wake: false,
    });
    const suite = {
      action: 'completed',
      check_suite: { head_branch: 'fleet/12-a', conclusion: 'success' },
      sender: stranger,
      repository: REPO,
    };
    expect(await (await deliver(h, 'check_suite', suite)).json()).toMatchObject({
      verdict: 'accepted',
      wake: true,
    });
    expect(
      await (await deliver(h, 'star', { action: 'created', sender: stranger, repository: REPO })).json(),
    ).toMatchObject({
      reason: 'event_not_handled',
    });
  });

  it('从 fork 来的 CI 事件也不收（四种事件各有认法），看不懂的也不收', async () => {
    const h = harness();
    const base = { action: 'completed', sender: stranger, repository: REPO };
    const forks: [string, object][] = [
      // GitHub 文档：fork 的分支推送认不出来，head_branch 为 null、pull_requests 为空。
      ['check_suite', { ...base, check_suite: { head_branch: null, pull_requests: [] } }],
      ['check_run', { ...base, check_run: { check_suite: { head_branch: null }, pull_requests: [] } }],
      ['workflow_run', { ...base, workflow_run: { head_repository: { full_name: 'stranger/canary' } } }],
      ['status', { sender: stranger, repository: REPO, state: 'success', branches: [] }],
    ];
    for (const [event, payload] of forks) {
      expect(await (await deliver(h, event, payload)).json(), event).toMatchObject({
        verdict: 'ignored',
        reason: 'from_fork',
      });
    }
    const sameRepo: [string, object][] = [
      ['check_run', { ...base, check_run: { check_suite: { head_branch: 'fleet/12-a' } } }],
      ['workflow_run', { ...base, workflow_run: { head_repository: REPO } }],
      [
        'status',
        { sender: stranger, repository: REPO, state: 'success', branches: [{ name: 'fleet/12-a' }] },
      ],
    ];
    for (const [event, payload] of sameRepo) {
      expect(await (await deliver(h, event, payload)).json(), event).toMatchObject({ verdict: 'accepted' });
    }
    expect(await (await deliver(h, 'check_suite', { ...base, check_suite: {} })).json()).toMatchObject({
      reason: 'payload_unreadable',
    });
    expect(h.accepted.map((e) => e.event)).toEqual(['check_run', 'workflow_run', 'status']);
  });
});
describe('白名单判定', () => {
  const whitelist = githubWhitelist(devFixtures(T0).users ?? []);
  const repos = new Set(['example/canary']);
  const screen = (event: string, payload: unknown) => screenGithubEvent(event, payload, { repos, whitelist });

  it('有数字编号的人只按编号认：同名不同号的冒充者不认', () => {
    expect(screen('issues', issueOpened(founderA)).accept).toBe(true);
    expect(screen('issues', issueOpened({ ...founderA, id: 1 })).accept).toBe(false);
  });

  it('只登记了登录名的人按登录名认（不分大小写）', () => {
    expect(screen('issues', issueOpened(founderB)).accept).toBe(true);
  });

  it('协作者进不了驾驶舱，但开的单、写的评论照样算白名单作者', () => {
    const withCollaborator = githubWhitelist([
      ...(devFixtures(T0).users ?? []),
      { id: 'u-collab', displayName: '协作者', role: 'collaborator', active: true, githubId: 3003 },
    ]);
    const collaborator = { login: 'collab', id: 3003, type: 'User' };
    expect(
      screenGithubEvent('issues', issueOpened(collaborator), { repos, whitelist: withCollaborator }).accept,
    ).toBe(true);
  });

  it('机器人只按编号认，而且 type 必须是 Bot：普通账号起个机器人的名字不行', () => {
    expect(screen('issues', issueOpened(workerBot)).accept).toBe(true);
    expect(screen('issues', issueOpened({ ...workerBot, type: 'User' })).accept).toBe(false);
    expect(screen('issues', issueOpened({ ...workerBot, id: 1 })).accept).toBe(false);
  });

  it('补收用的投递编号：同一版本只收一次', () => {
    expect(pollDeliveryId('Example/Canary', 'issue', 12, '2026-09-25T08:00:00Z')).toBe(
      'poll:example/canary:issue:12:2026-09-25T08:00:00Z',
    );
  });

  it('事件带着的对象版本：issue；评论和它顶新的 issue（PR 上的评论记成 PR）；PR 和它的审查、审查评论', () => {
    const at = '2026-09-25T08:00:00Z';
    const iso = '2026-09-25T08:00:00.000Z';
    const later = '2026-09-25T08:01:00Z';
    expect(
      versionsOf('issues', { issue: { number: 12, updated_at: at, state: 'open' } }, 'Example/Canary'),
    ).toEqual([{ object: 'example/canary:issue:12', version: iso, state: 'open' }]);
    expect(
      versionsOf(
        'issue_comment',
        { comment: { id: 7, updated_at: at }, issue: { number: 12, updated_at: later, state: 'closed' } },
        'example/canary',
      ),
    ).toEqual([
      { object: 'example/canary:comment:7', version: iso },
      { object: 'example/canary:issue:12', version: '2026-09-25T08:01:00.000Z', state: 'closed' },
    ]);
    const onPr = {
      comment: { id: 8, updated_at: at },
      issue: { number: 5, updated_at: at, pull_request: {} },
    };
    expect(versionsOf('issue_comment', onPr, 'example/canary').map((v) => v.object)).toEqual([
      'example/canary:comment:8',
      'example/canary:pull:5',
    ]);
    // 补收拼出来的评论只带 issue 号：只记评论
    expect(
      versionsOf(
        'issue_comment',
        { comment: { id: 9, updated_at: at }, issue: { number: 12 } },
        'example/canary',
      ),
    ).toEqual([{ object: 'example/canary:comment:9', version: iso }]);
    for (const event of ['pull_request', 'pull_request_review', 'pull_request_review_comment']) {
      expect(
        versionsOf(event, { pull_request: { number: 5, updated_at: at, state: 'closed' } }, 'example/canary'),
        event,
      ).toEqual([{ object: 'example/canary:pull:5', version: iso, state: 'closed' }]);
    }
    expect(objectKey('Example/Canary', 'issue', 12)).toBe('example/canary:issue:12');
  });

  it('认不出版本的不记：别的事件、缺 updated_at、时刻读不出、没有仓', () => {
    const at = '2026-09-25T08:00:00Z';
    expect(versionsOf('check_suite', { check_suite: {} }, 'example/canary')).toEqual([]);
    expect(versionsOf('issues', { issue: { number: 12 } }, 'example/canary')).toEqual([]);
    expect(
      versionsOf('issues', { issue: { number: 12, updated_at: 'yesterday' } }, 'example/canary'),
    ).toEqual([]);
    expect(versionsOf('issues', { issue: { number: 12, updated_at: at } }, undefined)).toEqual([]);
    expect(versionsOf('issues', null, 'example/canary')).toEqual([]);
  });
});

describe('健康检查的 github_events 一项', () => {
  const minutesAgo = (m: number) => new Date(T0.getTime() - m * 60_000).toISOString();
  /** 收件人看不到的东西：投递编号、原文里的字。 */
  const SECRET_ID = 'delivery-that-must-not-leak';
  const SECRET_TEXT = '原文里的一句话不能上公网';
  const stuck = (id: string, over: Partial<GitHubDelivery>): GitHubDelivery => ({
    id,
    event: 'issues',
    source: 'webhook',
    repo: 'example/canary',
    versions: [],
    payload: { issue: { title: SECRET_TEXT } },
    status: 'failed',
    reason: `Temporal 连不上：${SECRET_TEXT}`,
    attempts: 1,
    receivedAt: minutesAgo(60),
    claimedAt: minutesAgo(60),
    finishedAt: minutesAgo(60),
    ...over,
  });
  async function healthOf(
    deliveries: GitHubDelivery[],
    options: { credentialsMissing?: () => Promise<void>; breakStore?: boolean } = {},
  ) {
    const data = devFixtures(T0);
    data.githubEvents = new Map(deliveries.map((d) => [d.id, d]));
    const h = harness({ data });
    if (options.breakStore) {
      h.store.countStuckDeliveries = async () => {
        throw new Error('库连不上：10.0.0.1:5432');
      };
    }
    const check = githubEventsCheck({
      store: h.store,
      now: h.deps.now,
      credentialsMissing: options.credentialsMissing,
    });
    const app = harness({ data: devFixtures(T0), health: [{ name: 'github_events', check }] });
    const res = await app.cockpit.request('/healthz');
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as { checks: Record<string, unknown> } };
  }

  it('重放到上限还出错的、处理中超过 5 分钟的：报红，只报条数，不带投递编号和原文', async () => {
    const r = await healthOf([
      stuck(SECRET_ID, { attempts: 5 }),
      stuck('dead', {
        status: 'processing',
        reason: undefined,
        claimedAt: minutesAgo(6),
        finishedAt: undefined,
      }),
    ]);
    expect(r.status).toBe(503);
    expect(r.body.checks.github_events).toEqual({
      ok: false,
      code: 'stuck_deliveries',
      message: '有 GitHub 投递没处理成：重放 5 次还出错的 1 条、处理中超过 5 分钟没收尾的 1 条',
    });
    expect(r.text).not.toContain(SECRET_ID);
    expect(r.text).not.toContain(SECRET_TEXT);
  });

  it('还能重放的、刚占上的、处理完的：不算卡住，绿', async () => {
    const r = await healthOf([
      stuck('retryable', { attempts: 4 }),
      stuck('busy', {
        status: 'processing',
        reason: undefined,
        claimedAt: minutesAgo(1),
        finishedAt: undefined,
      }),
      stuck('done', { status: 'accepted', reason: undefined, attempts: 7 }),
    ]);
    expect(r.status).toBe(200);
    expect(r.body.checks.github_events).toEqual({ ok: true });
  });

  it('机器人凭据没读到：报红（先于卡住的投递报）', async () => {
    const r = await healthOf([], {
      credentialsMissing: githubAppMissing('没有 /etc/fleet-dao/github/gh-app-fleet-dao-engine.json').check,
    });
    expect(r.body.checks.github_events).toMatchObject({ ok: false, code: 'app_credentials_missing' });
  });

  it('查库失败：报红（对外只说连不上，不当成没有卡住的，也不漏出库的地址）', async () => {
    const r = await healthOf([], { breakStore: true });
    expect(r.status).toBe(503);
    expect(r.body.checks.github_events).toEqual({ ok: false, code: 'unreachable', message: '连不上' });
    expect(r.text).not.toContain('10.0.0.1');
  });
});
