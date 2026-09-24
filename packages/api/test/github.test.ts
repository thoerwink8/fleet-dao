import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { devFixtures } from '../src/dev-fixtures.ts';
import { githubWhitelist, pollDeliveryId, screenGithubEvent, verifyGithubSignature } from '../src/github.ts';
import { errorCode, harness, T0 } from './harness.ts';

const SECRET = 'webhook-secret-for-tests';
const REPO = { full_name: 'example/canary' };
const founderA = { login: 'founder-a', id: 1001, type: 'User' };
const founderB = { login: 'Founder-B', id: 5555, type: 'User' }; // 白名单里只登记了登录名
const stranger = { login: 'stranger', id: 4242, type: 'User' };
const workerBot = { login: 'fleet-worker[bot]', id: 9001, type: 'Bot' };

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

let deliverySeq = 0;
function deliver(
  h: ReturnType<typeof harness>,
  event: string,
  payload: unknown,
  options: { delivery?: string; signature?: string | null } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': options.delivery ?? `d-${++deliverySeq}`,
  };
  if (options.signature !== null) headers['x-hub-signature-256'] = options.signature ?? sign(body);
  return h.cockpit.request('/github/webhook', { method: 'POST', headers, body });
}

const issueOpened = (user: object, sender: object = user) => ({
  action: 'opened',
  issue: { number: 12, user },
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

  it('交给引擎失败：500，并撤销登记，GitHub 重投时还能进来', async () => {
    let fail = true;
    const h = harness({
      github: async () => {
        if (fail) throw new Error('库连不上');
      },
    });
    expect((await deliver(h, 'issues', issueOpened(founderA), { delivery: 'retry-me' })).status).toBe(500);
    fail = false;
    const redelivered = await deliver(h, 'issues', issueOpened(founderA), { delivery: 'retry-me' });
    expect(await redelivered.json()).toMatchObject({ verdict: 'accepted' });
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

  it('ping 和 CI 事件：不看作者；不认识的事件：不收', async () => {
    const h = harness();
    expect(await (await deliver(h, 'ping', { zen: 'hi', hook_id: 1 })).json()).toMatchObject({
      verdict: 'accepted',
      wake: false,
    });
    const suite = {
      action: 'completed',
      check_suite: { conclusion: 'success' },
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
});
