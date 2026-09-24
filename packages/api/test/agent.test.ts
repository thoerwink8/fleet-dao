import { AskResponse, HistoryResponse, TaskResponse, TimelineResponse } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { AGENT_TOKEN_MAX_TTL_SECONDS, signAgentToken, verifyAgentToken } from '../src/agent-token.ts';
import { signPayload } from '../src/tokens.ts';
import { agentRequest, DEV_RUN_ID, errorCode, harness, IDS, write } from './harness.ts';

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
    for (const path of ['/api/me', `/api/repos/${IDS.repo}/board`, '/api/settings', '/api/events']) {
      const res = await h.cockpit.request(path, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status, path).toBe(401);
      expect(await errorCode(res)).toBe('bearer_not_allowed');
    }
    const session = await h.login();
    const both = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
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
      taskId: IDS.task12,
      subtaskId: IDS.sub12a,
      runId: DEV_RUN_ID,
      ttlSeconds: 60,
      now: h.clock.now,
    });
    expect(await errorCode(await h.agent.request('/agent/v1/task', agentRequest(wrongKey)))).toBe(
      'agent_token_invalid',
    );
    const otherTask = h.agentToken({ taskId: IDS.task13 });
    expect(await errorCode(await h.agent.request('/agent/v1/task', agentRequest(otherTask)))).toBe(
      'agent_token_invalid',
    );
    const noSuchRun = h.agentToken({ runId: 'run-404' });
    expect((await h.agent.request('/agent/v1/task', agentRequest(noSuchRun))).status).toBe(401);

    const token = h.agentToken();
    const run = h.store.data.runs.find((r) => r.id === DEV_RUN_ID);
    if (!run) throw new Error('样例数据里没有会话');
    run.endedAt = h.clock.now.toISOString();
    run.outcome = 'ok';
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
      taskId: IDS.task12,
      subtaskId: IDS.sub12a,
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
    expect((await h.store.getPlans([DEV_RUN_ID])).get(DEV_RUN_ID)?.steps).toEqual([
      { index: 0, title: '写测试', state: 'done' },
      { index: 1, title: '写实现', state: 'in_progress' },
    ]);
    expect(h.store.data.progress.at(-1)).toMatchObject({ runId: DEV_RUN_ID, kind: 'plan' });
    expect(h.signals).toEqual([
      { taskId: IDS.task12, signal: { name: 'agentEvent', runId: DEV_RUN_ID, kind: 'plan' } },
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
    expect(body.items.map((i) => i.taskId)).toEqual([IDS.task13]);
  });
});

describe('幂等键（插头重试同一条命令用同一个键）', () => {
  const post = (h: ReturnType<typeof harness>, path: string, body: unknown, key?: string) =>
    h.agent.request(
      `/agent/v1/${path}`,
      agentRequest(h.agentToken(), 'POST', body, key === undefined ? {} : { 'idempotency-key': key }),
    );
  const passingTest = (h: ReturnType<typeof harness>) =>
    h.store.data.progress.push({
      id: '900',
      runId: DEV_RUN_ID,
      at: h.clock.now.toISOString(),
      kind: 'test',
      payload: { passed: true, command: 'pnpm check' },
    });

  it('say / plan / blocked / done 重试：直接回第一次的结果，只记一条、只叫醒一次；ask 同一句也只开一条', async () => {
    const h = harness();
    passingTest(h);
    const before = h.store.data.progress.length;
    const commands: [string, unknown][] = [
      ['say', { text: '写好测试了' }],
      ['plan', { steps: [{ title: '写实现', state: 'in_progress' }] }],
      ['blocked', { reason: '缺短信服务的测试账号', needs: 'access' }],
      ['done', { summary: '写完了', testsPassed: true }],
    ];
    for (const [path, body] of commands) {
      const first = await post(h, path, body, `key-${path}`);
      const retry = await post(h, path, body, `key-${path}`);
      expect([first.status, retry.status], path).toEqual([200, 200]);
      expect(await retry.json(), path).toEqual(await first.json());
    }
    expect(h.store.data.progress.slice(before).map((p) => p.kind)).toEqual([
      'say',
      'plan',
      'blocked',
      'done',
    ]);
    expect(h.signals).toHaveLength(4);

    const asked = [await post(h, 'ask', { question: '几位？', blocking: false }, 'key-ask')];
    asked.push(await post(h, 'ask', { question: '几位？', blocking: false }, 'key-ask'));
    const [a, b] = await Promise.all(asked.map(async (r) => AskResponse.parse(await r.json())));
    expect(b?.askId).toBe(a?.askId);
    expect(h.store.data.asks).toHaveLength(1);
  });

  it('没带键照常执行（老插头）：两次就是两条', async () => {
    const h = harness();
    await post(h, 'say', { text: '一' });
    await post(h, 'say', { text: '一' });
    expect(
      h.store.data.progress.filter((p) => p.kind === 'say' && p.at === h.clock.now.toISOString()),
    ).toHaveLength(2);
  });

  it('被退回（422）不占键：补跑测试后用同一个键再交，照常核实、收下', async () => {
    const h = harness();
    const rejected = await post(h, 'done', { summary: '写完了', testsPassed: true }, 'key-done');
    expect(rejected.status).toBe(422);
    passingTest(h);
    const accepted = await post(h, 'done', { summary: '写完了', testsPassed: true }, 'key-done');
    expect(accepted.status).toBe(200);
    expect(h.store.data.progress.filter((p) => p.kind === 'done')).toHaveLength(1);
  });

  it('同一个键的上一次还在处理：503 + Retry-After，这次不执行', async () => {
    const h = harness();
    await h.store.claimCommand({
      runId: DEV_RUN_ID,
      key: 'key-busy',
      action: 'agent.say',
      takeOverBefore: new Date(0).toISOString(),
    });
    h.clock.now = new Date(h.clock.now.getTime() + 30_000);
    const before = h.store.data.progress.length;
    const res = await post(h, 'say', { text: '在写' }, 'key-busy');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await errorCode(res)).toBe('in_flight');
    expect(h.store.data.progress).toHaveLength(before);
    expect(h.signals).toHaveLength(0);
  });

  it('占着没做完的键，是本进程启动前占的（发版重启）或占了超过 60 秒：重试接过来执行，留日志', async () => {
    const h = harness();
    const booted = h.clock.now.getTime();
    const claimAt = async (key: string, at: number) => {
      h.clock.now = new Date(at);
      await h.store.claimCommand({
        runId: DEV_RUN_ID,
        key,
        action: 'agent.say',
        takeOverBefore: new Date(0).toISOString(),
      });
    };
    await claimAt('key-before-boot', booted - 1_000);
    await claimAt('key-stuck', booted + 1_000);
    h.clock.now = new Date(booted + 2_000);
    expect((await post(h, 'say', { text: '重启前那句' }, 'key-before-boot')).status).toBe(200);
    expect((await post(h, 'say', { text: '卡住那句' }, 'key-stuck')).status).toBe(503);
    h.clock.now = new Date(booted + 62_000);
    expect((await post(h, 'say', { text: '卡住那句' }, 'key-stuck')).status).toBe(200);
    expect(h.logs.filter((l) => l.message.includes('接过来重新执行'))).toHaveLength(2);
  });

  it('键太长：400', async () => {
    const h = harness();
    expect(await errorCode(await post(h, 'say', { text: 'x' }, 'k'.repeat(201)))).toBe(
      'invalid_idempotency_key',
    );
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
    h.changes.publish({ type: 'change', table: 'asks', id: record.id });
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
      repoId: IDS.repo,
      number: 31,
      state: 'open',
      headRef: 'fleet/12-a',
      headSha: 'abc123',
      checks: 'pending',
      ...pr,
    });
  }

  /** 插头读出来的测试结果：kind=test 的进度，载荷带 passed。 */
  let seq = 1000;
  function testRun(h: ReturnType<typeof harness>, passed: boolean, minutesLater = 0) {
    h.store.data.progress.push({
      id: String(++seq),
      runId: DEV_RUN_ID,
      at: new Date(h.clock.now.getTime() + minutesLater * 60_000).toISOString(),
      kind: 'test',
      payload: { passed, command: 'pnpm check' },
    });
  }

  async function reasonsOf(res: Response): Promise<string> {
    const body = (await res.json()) as { error: { details: { reasons: string[] } } };
    return body.error.details.reasons.join('\n');
  }

  it('会话里最后一次测试是绿的：收下（PR 由引擎在会话后开，不要求带），记进度并叫醒工作流', async () => {
    const h = harness();
    testRun(h, true);
    const res = await done(h, { summary: '接口写完了', testsPassed: true });
    expect(res.status).toBe(200);
    expect(h.store.data.progress.at(-1)).toMatchObject({ kind: 'done' });
    expect(h.signals.at(-1)?.signal).toMatchObject({ name: 'agentEvent', kind: 'done' });
  });

  it('返工轮次带着已有的 PR 编号：PR 在、分支对也收下', async () => {
    const h = harness();
    withPr(h);
    testRun(h, true);
    expect((await done(h, { summary: '按审查意见改了', prNumber: 31, testsPassed: true })).status).toBe(200);
  });

  it('说了就算不行：没跑过测试、最后一次测试是红的、PR 不在本会话分支上，逐条退回并说明原因', async () => {
    const h = harness();
    const noTests = await done(h, { summary: 's', testsPassed: true });
    expect(noTests.status).toBe(422);
    expect(await reasonsOf(noTests)).toContain('没查到本次会话跑过测试');

    testRun(h, true);
    testRun(h, false, 5);
    const lastRed = await done(h, { summary: 's', testsPassed: true });
    expect(lastRed.status).toBe(422);
    expect(await reasonsOf(lastRed)).toContain('最后一次跑测试没过');

    testRun(h, true, 10);
    withPr(h, { headRef: 'someone-else' });
    const wrongBranch = await done(h, { summary: 's', prNumber: 31, testsPassed: true });
    expect(wrongBranch.status).toBe(422);
    expect(await reasonsOf(wrongBranch)).toContain('不是本会话的分支');

    expect(h.store.data.progress.some((p) => p.kind === 'done')).toBe(false);
    expect(h.signals).toHaveLength(0);
  });

  it('退回要落库：操作记录里有，任务时间线上看得到，不只打日志', async () => {
    const h = harness();
    const session = await h.login();
    const res = await done(h, { summary: '写完了', testsPassed: true });
    expect(res.status).toBe(422);
    expect(h.store.data.audit.at(-1)).toMatchObject({
      actor: { kind: 'agent', id: DEV_RUN_ID },
      action: 'agent.done_rejected',
      target: `task:${IDS.task12}`,
      via: 'agent',
      ok: false,
      error: 'done_rejected',
    });
    const timeline = TimelineResponse.parse(
      await (
        await h.cockpit.request(`/api/tasks/${IDS.task12}/timeline`, { headers: { cookie: session.cookie } })
      ).json(),
    );
    expect(timeline.items[0]).toMatchObject({ source: 'session', kind: 'done_rejected' });
    expect(timeline.items[0]?.text).toContain('交活被退回：没查到本次会话跑过测试');
  });

  it('带的 PR 还没同步进库：409，过一会儿再交（也落库）', async () => {
    const h = harness();
    testRun(h, true);
    const res = await done(h, { summary: 's', prNumber: 99, testsPassed: true });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('not_verifiable_yet');
    expect(h.store.data.audit.at(-1)).toMatchObject({
      action: 'agent.done_rejected',
      error: 'not_verifiable_yet',
    });
  });
});
