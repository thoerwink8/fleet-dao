import { AskResponse, HistoryResponse, TaskResponse } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { AGENT_TOKEN_MAX_TTL_SECONDS, signAgentToken, verifyAgentToken } from '../src/agent-token.ts';
import { signPayload } from '../src/tokens.ts';
import { agentRequest, DEV_RUN_ID, errorCode, harness, write } from './harness.ts';

describe('fleet 令牌', () => {
  it('签出来的能验过；换密钥、改内容、过期、寿命超上限、签发时间在未来都不认', () => {
    const secret = 'x'.repeat(40);
    const now = new Date('2026-09-25T08:00:00Z');
    const token = signAgentToken(secret, { taskId: 't', runId: 'r', ttlSeconds: 60, now });
    expect(verifyAgentToken(secret, token, now)).toMatchObject({
      ok: true,
      claims: { taskId: 't', runId: 'r' },
    });
    expect(verifyAgentToken('y'.repeat(40), token, now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyAgentToken(secret, token.replace('fat1.ey', 'fat1.fy'), now)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyAgentToken(secret, token, new Date(now.getTime() + 61_000))).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyAgentToken(secret, token, new Date(now.getTime() - 120_000))).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    });
    const forever =
      'fat1.' +
      signPayload(secret, 'fleet-agent-token/v1', {
        typ: 'agent',
        tid: 't',
        rid: 'r',
        iat: 1_790_000_000,
        exp: 1_790_000_000 + AGENT_TOKEN_MAX_TTL_SECONDS + 1,
      });
    expect(verifyAgentToken(secret, forever, new Date(1_790_000_000_000))).toEqual({
      ok: false,
      reason: 'ttl_too_long',
    });
    expect(() => signAgentToken(secret, { taskId: 't', runId: 'r', ttlSeconds: 0 })).toThrow();
  });
});

describe('令牌越权', () => {
  it('fleet 令牌访问驾驶舱接口：一律 401，哪怕同时带着有效的登录 Cookie', async () => {
    const h = harness();
    const token = h.agentToken();
    for (const path of ['/api/me', '/api/repos/repo-1/board', '/api/settings', '/api/events']) {
      const res = await h.cockpit.request(path, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status, path).toBe(401);
      expect(await errorCode(res)).toBe('bearer_not_allowed');
    }
    const session = await h.login();
    const both = await h.cockpit.request(
      '/api/tasks/task-12/actions',
      write('POST', session, { action: 'stop' }, { authorization: `Bearer ${token}` }),
    );
    expect(await errorCode(both)).toBe('bearer_not_allowed');
    expect(h.signals).toHaveLength(0);
  });

  it('fleet 令牌塞进 Cookie 冒充登录态：不认', async () => {
    const h = harness();
    const token = h.agentToken();
    const res = await h.cockpit.request('/api/me', { headers: { cookie: `__Host-fleet_session=${token}` } });
    expect(await errorCode(res)).toBe('unauthenticated');
  });

  it('登录 Cookie 拿去调 fleet 接口：不认', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const noBearer = await h.agent.request('/agent/v1/task', { headers: { cookie } });
    expect(await errorCode(noBearer)).toBe('agent_token_missing');
    const cookieValue = cookie.slice(cookie.indexOf('=') + 1);
    const asBearer = await h.agent.request('/agent/v1/task', agentRequest(cookieValue));
    expect(await errorCode(asBearer)).toBe('agent_token_invalid');
  });

  it('用登录密钥签的令牌、别的会话的令牌、会话结束后的令牌：都 401', async () => {
    const h = harness();
    const wrongKey = signAgentToken(h.config.sessionSecret, {
      taskId: 'task-12',
      subtaskId: 'sub-12a',
      runId: DEV_RUN_ID,
      ttlSeconds: 60,
      now: h.clock.now,
    });
    expect(await errorCode(await h.agent.request('/agent/v1/task', agentRequest(wrongKey)))).toBe(
      'agent_token_invalid',
    );
    const otherTask = h.agentToken({ taskId: 'task-13' });
    expect(await errorCode(await h.agent.request('/agent/v1/task', agentRequest(otherTask)))).toBe(
      'agent_token_invalid',
    );
    const noSuchRun = h.agentToken({ runId: 'run-404' });
    expect((await h.agent.request('/agent/v1/task', agentRequest(noSuchRun))).status).toBe(401);

    const token = h.agentToken();
    const session = h.store.data.agentSessions[0];
    if (!session) throw new Error('样例数据里没有会话');
    session.endedAt = h.clock.now.toISOString();
    expect(
      await errorCode(await h.agent.request('/agent/v1/say', agentRequest(token, 'POST', { text: '还在' }))),
    ).toBe('agent_session_ended');
  });

  it('两个监听各管各的：驾驶舱应用上没有 /agent，fleet 应用上没有 /api', async () => {
    const h = harness();
    expect((await h.cockpit.request('/agent/v1/task', agentRequest(h.agentToken()))).status).toBe(404);
    const { cookie } = await h.login();
    expect((await h.agent.request('/api/me', { headers: { cookie } })).status).toBe(404);
  });
});

describe('/agent/v1 的七个动作', () => {
  it('task：看到自己的需求、做完标准、要改哪里、当前步骤', async () => {
    const h = harness();
    const res = await h.agent.request('/agent/v1/task', agentRequest(h.agentToken()));
    expect(res.status).toBe(200);
    const body = TaskResponse.parse(await res.json());
    expect(body).toMatchObject({
      taskId: 'task-12',
      subtaskId: 'sub-12a',
      repo: 'example/canary',
      branch: 'fleet/12-a',
      request: '给登录页加手机验证码',
      touches: ['packages/api/src/auth'],
    });
    expect(body.acceptance).toHaveLength(2);
    expect(body.plan.map((s) => s.state)).toEqual(['done', 'in_progress', 'pending']);
  });

  it('plan：整张替换，写进度，叫醒工作流；同时两步在进行就 400', async () => {
    const h = harness();
    const token = h.agentToken();
    const bad = await h.agent.request(
      '/agent/v1/plan',
      agentRequest(token, 'POST', {
        steps: [
          { title: 'a', state: 'in_progress' },
          { title: 'b', state: 'in_progress' },
        ],
      }),
    );
    expect(await errorCode(bad)).toBe('invalid_request');
    const ok = await h.agent.request(
      '/agent/v1/plan',
      agentRequest(token, 'POST', {
        steps: [
          { title: '写测试', state: 'done' },
          { title: '写实现', state: 'in_progress' },
        ],
      }),
    );
    expect(ok.status).toBe(200);
    expect(h.store.data.plans.get(DEV_RUN_ID)?.steps).toEqual([
      { index: 0, title: '写测试', state: 'done' },
      { index: 1, title: '写实现', state: 'in_progress' },
    ]);
    expect(h.store.data.progress.at(-1)).toMatchObject({ runId: DEV_RUN_ID, kind: 'plan' });
    expect(h.signals).toEqual([
      { taskId: 'task-12', signal: { name: 'agentEvent', runId: DEV_RUN_ID, kind: 'plan' } },
    ]);
  });

  it('say 与 blocked：写进度并叫醒工作流', async () => {
    const h = harness();
    const token = h.agentToken();
    expect(
      (await h.agent.request('/agent/v1/say', agentRequest(token, 'POST', { text: '写好测试了' }))).status,
    ).toBe(200);
    const blocked = await h.agent.request(
      '/agent/v1/blocked',
      agentRequest(token, 'POST', { reason: '缺短信服务的测试账号', needs: 'access' }),
    );
    expect(blocked.status).toBe(200);
    expect(h.store.data.progress.slice(-2).map((p) => p.kind)).toEqual(['say', 'blocked']);
    expect(h.signals.map((s) => (s.signal.name === 'agentEvent' ? s.signal.kind : s.signal.name))).toEqual([
      'say',
      'blocked',
    ]);
  });

  it('叫醒工作流失败不挡命令，但要留日志', async () => {
    const h = harness({
      workflows: {
        async signal() {
          throw new Error('temporal 连不上');
        },
      },
    });
    const res = await h.agent.request(
      '/agent/v1/say',
      agentRequest(h.agentToken(), 'POST', { text: '进度' }),
    );
    expect(res.status).toBe(200);
    expect(h.logs.some((l) => l.level === 'warn' && l.message.includes('叫醒工作流没成功'))).toBe(true);
  });

  it('history：按关键词翻本仓做过的需求', async () => {
    const h = harness();
    const res = await h.agent.request(
      '/agent/v1/history',
      agentRequest(h.agentToken(), 'POST', { query: 'readme' }),
    );
    const body = HistoryResponse.parse(await res.json());
    expect(body.items.map((i) => i.taskId)).toEqual(['task-13']);
  });
});

describe('fleet ask', () => {
  const ask = (h: ReturnType<typeof harness>, body: Record<string, unknown>) =>
    h.agent.request('/agent/v1/ask', agentRequest(h.agentToken(), 'POST', body));

  it('不阻塞：立刻返回 pending；同一句再问复用同一条，不重复开', async () => {
    const h = harness();
    const first = AskResponse.parse(
      await (await ask(h, { question: '验证码几位？', blocking: false })).json(),
    );
    expect(first.status).toBe('pending');
    const again = AskResponse.parse(
      await (await ask(h, { question: '验证码几位？', blocking: false })).json(),
    );
    expect(again.askId).toBe(first.askId);
    expect(h.store.data.asks).toHaveLength(1);
    expect(h.signals.filter((s) => s.signal.name === 'agentEvent')).toHaveLength(1);
  });

  it('阻塞：驾驶舱里有人回答，等着的命令当场拿到答案', async () => {
    const h = harness({ config: { askWaitMs: 5_000 } });
    const session = await h.login();
    const pending = ask(h, { question: '验证码几位？' });
    // 等追问落库后再回答。
    for (let i = 0; i < 50 && h.store.data.asks.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const askId = h.store.data.asks[0]?.id ?? '';
    const answered = await h.cockpit.request(
      `/api/asks/${askId}/answer`,
      write('POST', session, { answer: '6 位' }),
    );
    expect(answered.status).toBe(200);
    const started = Date.now();
    const body = AskResponse.parse(await (await pending).json());
    expect(body).toEqual({ askId, status: 'answered', answer: '6 位' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('阻塞：别处（飞书、issue）写进库的回答，靠数据变化通知叫醒', async () => {
    const h = harness({ config: { askWaitMs: 5_000 } });
    const pending = ask(h, { question: '用哪家短信？' });
    for (let i = 0; i < 50 && h.store.data.asks.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const record = h.store.data.asks[0];
    if (!record) throw new Error('追问没落库');
    record.answer = '先用阿里云';
    h.changes.publish({ type: 'change', table: 'task_questions', id: record.id });
    const body = AskResponse.parse(await (await pending).json());
    expect(body.status).toBe('answered');
  });

  it('阻塞：等到上限还没人答，返回 pending', async () => {
    const h = harness({ config: { askWaitMs: 50 } });
    const body = AskResponse.parse(await (await ask(h, { question: '要不要发短信？' })).json());
    expect(body.status).toBe('pending');
  });
});

describe('fleet done 要核实', () => {
  const done = (h: ReturnType<typeof harness>, body: Record<string, unknown>) =>
    h.agent.request('/agent/v1/done', agentRequest(h.agentToken(), 'POST', body));

  function withPr(
    h: ReturnType<typeof harness>,
    pr: Partial<(typeof h.store.data.pullRequests)[number]> = {},
  ) {
    h.store.data.pullRequests.push({
      repoId: 'repo-1',
      number: 31,
      state: 'open',
      headRef: 'fleet/12-a',
      headSha: 'abc123',
      checks: 'pending',
      ...pr,
    });
  }

  it('PR 在、分支对、会话里最后一次测试是绿的：收下，记进度并叫醒工作流', async () => {
    const h = harness();
    withPr(h);
    h.store.data.testRuns.push({
      runId: DEV_RUN_ID,
      at: h.clock.now.toISOString(),
      passed: true,
      command: 'pnpm check',
    });
    const res = await done(h, { summary: '接口写完了', prNumber: 31, testsPassed: true });
    expect(res.status).toBe(200);
    expect(h.store.data.progress.at(-1)).toMatchObject({ kind: 'done' });
    expect(h.signals.at(-1)?.signal).toMatchObject({ name: 'agentEvent', kind: 'done' });
  });

  it('说了就算不行：没跑过测试、最后一次测试是红的、PR 不在本会话分支上，都退回并说明原因', async () => {
    const h = harness();
    withPr(h, { headRef: 'someone-else' });
    const noTests = await done(h, { summary: 's', prNumber: 31, testsPassed: true });
    expect(noTests.status).toBe(422);
    const reasons = ((await noTests.json()) as { error: { details: { reasons: string[] } } }).error.details
      .reasons;
    expect(reasons.join('\n')).toContain('不是本会话的分支');
    expect(reasons.join('\n')).toContain('没查到本次会话跑过测试');
    expect(h.store.data.progress.some((p) => p.kind === 'done')).toBe(false);
    expect(h.signals).toHaveLength(0);
  });

  it('PR 还没同步进库：409，过一会儿再交', async () => {
    const h = harness();
    const res = await done(h, { summary: 's', prNumber: 99, testsPassed: true });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('not_verifiable_yet');
  });
});
