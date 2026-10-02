import {
  AskResponse,
  HistoryResponse,
  requirementWorkflowId,
  subtaskWorkflowId,
  TaskResponse,
  TimelineResponse,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { AGENT_TOKEN_MAX_TTL_SECONDS, signAgentToken, verifyAgentToken } from '../src/agent-token.ts';
import { type TaskSignal, WorkflowGoneError, WorkflowUnavailableError } from '../src/ports.ts';
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

  it('plan：整张替换，写进度，不叫醒工作流（只有 ask/done/blocked 才叫醒）；同时两步在进行就 400', async () => {
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
    expect(h.signals).toHaveLength(0);
  });

  it('say 不叫醒工作流，blocked 叫醒（写进度都照常）', async () => {
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
      '/agent/v1/blocked',
      agentRequest(h.agentToken(), 'POST', { reason: '缺短信服务的测试账号', needs: 'access' }),
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

describe('叫醒目标：只有 ask/done/blocked 才发信号，且发给会话所属的工作流', () => {
  it('say、plan 不发任何信号', async () => {
    const h = harness();
    const token = h.agentToken();
    await h.agent.request('/agent/v1/say', agentRequest(token, 'POST', { text: '写好测试了' }));
    await h.agent.request(
      '/agent/v1/plan',
      agentRequest(token, 'POST', { steps: [{ title: '写实现', state: 'in_progress' }] }),
    );
    expect(h.signals).toHaveLength(0);
  });

  it('子任务会话（session.subtaskId 有值）的 done 直接拼子任务工作流编号 sub:<subtaskId>，不用查库', async () => {
    const h = harness();
    const token = h.agentToken(); // 默认样例会话就带 subtaskId: IDS.sub12a
    h.store.data.progress.push({
      id: 'wake-target-test-run',
      runId: DEV_RUN_ID,
      at: h.clock.now.toISOString(),
      kind: 'test',
      payload: { passed: true, command: 'pnpm check' },
    });
    const res = await h.agent.request(
      '/agent/v1/done',
      agentRequest(token, 'POST', { summary: '写完了', testsPassed: true }),
    );
    expect(res.status).toBe(200);
    expect(h.signals).toEqual([
      {
        workflowId: subtaskWorkflowId(IDS.sub12a),
        signal: { name: 'agentEvent', runId: DEV_RUN_ID, kind: 'done' },
      },
    ]);
  });

  it('需求自己的会话（session.subtaskId 没有值）的 ask 查库拼需求工作流编号 req:owner/name#issueNumber', async () => {
    const h = harness();
    const requirementRunId = 'run-requirement-triage';
    h.store.data.runs.push({
      id: requirementRunId,
      taskId: IDS.task12,
      stage: 'triage',
      routeId: 'rt-claude-opus',
      whyRoute: '分诊阶段排第一',
      queuedAt: h.clock.now.toISOString(),
      startedAt: h.clock.now.toISOString(),
    });
    // 故意不传 subtaskId：这次会话不属于任何子任务（分诊、需求文档、方案这几步都是这样）。
    const token = signAgentToken(h.config.agentTokenSecret, {
      taskId: IDS.task12,
      runId: requirementRunId,
      ttlSeconds: 3600,
      now: h.clock.now,
    });
    const res = await h.agent.request(
      '/agent/v1/ask',
      agentRequest(token, 'POST', {
        question: '要不要支持邮箱验证码？',
        options: ['要', '不要'],
        recommend: '不要',
      }),
    );
    expect(res.status).toBe(200);
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]?.workflowId).toBe(requirementWorkflowId({ owner: 'example', name: 'canary' }, 12));
    expect(h.signals[0]?.signal).toMatchObject({ name: 'agentEvent', runId: requirementRunId, kind: 'ask' });
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

  it('say / plan / blocked / done 重试：直接回第一次的结果，只记一条；blocked/done 只叫醒一次（say/plan 不叫醒）；ask 同一句也只开一条', async () => {
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
    // say、plan 各重试了一次也一个信号都不发；blocked、done 各只发一次（幂等键去重）。
    expect(h.signals.map((s) => (s.signal.name === 'agentEvent' ? s.signal.kind : s.signal.name))).toEqual([
      'blocked',
      'done',
    ]);

    const askBody = { question: '几位？', options: ['6 位', '4 位'], recommend: '6 位' };
    const asked = [await post(h, 'ask', askBody, 'key-ask')];
    asked.push(await post(h, 'ask', askBody, 'key-ask'));
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

  it('同一个键用在别的命令上：409，这次不执行，也不回上一条命令的结果', async () => {
    const h = harness();
    // say 不叫醒工作流：这里改用 blocked 起手，才能顺带证明「409 不执行」连信号也没多发一条。
    expect((await post(h, 'blocked', { reason: '一', needs: 'access' }, 'key-x')).status).toBe(200);
    const before = h.store.data.progress.length;
    const res = await post(h, 'done', { summary: '写完了', testsPassed: true }, 'key-x');
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('idempotency_key_reused');
    expect(h.store.data.progress).toHaveLength(before);
    expect(h.signals).toHaveLength(1);
  });

  it('上一次卡住、被接管以后才做完：它的回执记不上，第三次重试拿接管那次的结果、不再执行', async () => {
    let release: () => void = () => {};
    let calls = 0;
    const h = harness({
      workflows: {
        async signal() {
          calls += 1;
          if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
        },
      },
    });
    // 用 blocked（叫醒工作流的一类）：靠假 workflows.signal 卡住来模拟「上一次还没做完」，say 不叫醒、卡不住。
    const reasons = () =>
      h.store.data.progress
        .filter((p) => p.kind === 'blocked')
        .map((p) => (p.payload as { reason: string }).reason);
    const stuck = post(h, 'blocked', { reason: '卡住的那次', needs: 'access' }, 'key-slow');
    for (let i = 0; i < 100 && calls === 0; i++) await new Promise((r) => setTimeout(r, 5));
    h.clock.now = new Date(h.clock.now.getTime() + 61_000);
    expect((await post(h, 'blocked', { reason: '接管的那次', needs: 'access' }, 'key-slow')).status).toBe(
      200,
    );
    release();
    expect((await stuck).status).toBe(200);
    expect(h.logs.some((l) => l.message.includes('已被别的请求接管'))).toBe(true);
    expect((await post(h, 'blocked', { reason: '第三次', needs: 'access' }, 'key-slow')).status).toBe(200);
    expect(reasons()).toContain('接管的那次');
    expect(reasons()).not.toContain('第三次');
  });

  it('键太长：400', async () => {
    const h = harness();
    expect(await errorCode(await post(h, 'say', { text: 'x' }, 'k'.repeat(201)))).toBe(
      'invalid_idempotency_key',
    );
  });
});

describe('fleet ask：问他不挡路（#259）', () => {
  const ask = (h: ReturnType<typeof harness>, body: Record<string, unknown>) =>
    h.agent.request('/agent/v1/ask', agentRequest(h.agentToken(), 'POST', body));
  const sms = { question: '用哪家短信？', options: ['腾讯云', '阿里云'], recommend: '阿里云' };

  it('这张单范围内的岔路：当场回「已按推荐先做」，不等回答；推荐的排第一个落库；同一句再问复用同一条、只叫醒一次', async () => {
    const h = harness();
    const first = AskResponse.parse(await (await ask(h, sms)).json());
    expect(first).toMatchObject({ status: 'assumed', answer: '阿里云' });
    expect(h.store.data.asks).toHaveLength(1);
    expect(h.store.data.asks[0]).toMatchObject({
      question: '用哪家短信？',
      options: ['阿里云', '腾讯云'],
      scope: 'task',
      recommended: '阿里云',
    });
    const again = AskResponse.parse(await (await ask(h, sms)).json());
    expect(again).toEqual(first);
    expect(h.store.data.asks).toHaveLength(1);
    expect(h.signals.map((s) => s.signal.name)).toEqual(['agentEvent']);
  });

  it('超出这张单的范围：回 outside（另开单等他拍，这张单绕开接着做），不给工作流加人闸', async () => {
    const h = harness();
    const body = AskResponse.parse(
      await (await ask(h, { ...sms, question: '注册页也要验证码吗？', outside: true })).json(),
    );
    expect(body.status).toBe('outside');
    expect(body.answer).toBeUndefined();
    expect(h.store.data.asks[0]).toMatchObject({ scope: 'outside', recommended: '阿里云' });
    expect(h.signals.map((s) => s.signal.name)).toEqual(['agentEvent']);
  });

  it('碰了人闸：先按推荐做，给这张单的工作流加人闸（合并前等批）；重问同一句再加一次（工作流自己认「已经有了」）', async () => {
    const h = harness();
    const held = { ...sms, question: '短信要开按量付费，用哪家？', hold: 'spend' };
    const body = AskResponse.parse(await (await ask(h, held)).json());
    expect(body).toMatchObject({ status: 'held', answer: '阿里云' });
    expect(h.store.data.asks[0]).toMatchObject({ scope: 'hold', hold: 'spend' });
    const workflowId = requirementWorkflowId({ owner: 'example', name: 'canary' }, 12);
    const holds = () => h.signals.filter((s) => s.signal.name === 'requireApproval');
    expect(holds()).toHaveLength(1);
    expect(holds()[0]).toMatchObject({
      workflowId,
      signal: { name: 'requireApproval', holds: ['spend'], by: `session:${DEV_RUN_ID}` },
    });
    await ask(h, held);
    expect(holds()).toHaveLength(2);
  });

  it('【故意造出的失败】碰了人闸、引擎连不上：问题记下了，但明说人闸没加上（503），不回「合并前等批」装作拦住了；重试加上', async () => {
    let down = true;
    const signals: TaskSignal[] = [];
    const h = harness({
      workflows: {
        async signal(_id, signal) {
          if (down && signal.name === 'requireApproval')
            throw new WorkflowUnavailableError('Temporal 连不上');
          signals.push(signal);
        },
      },
    });
    const held = {
      ...sms,
      question: '要不要删掉旧表？',
      options: ['删', '留着'],
      recommend: '留着',
      hold: 'delete',
    };
    const res = await ask(h, held);
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('hold_not_set');
    expect(h.store.data.asks).toHaveLength(1);
    down = false;
    const retry = AskResponse.parse(await (await ask(h, held)).json());
    expect(retry).toMatchObject({ status: 'held', answer: '留着' });
    expect(signals.filter((s) => s.name === 'requireApproval')).toHaveLength(1);
    expect(h.store.data.asks).toHaveLength(1);
  });

  it('碰了人闸、工作流已经结束（这张单不会再合并）：照常回 held，只记日志', async () => {
    const h = harness({
      workflows: {
        async signal(id) {
          throw new WorkflowGoneError(id);
        },
      },
    });
    const body = AskResponse.parse(await (await ask(h, { ...sms, hold: 'spend' })).json());
    expect(body.status).toBe('held');
  });

  it('【故意造出的失败】没带选项、没带推荐、推荐不在选项里、选项太多、人闸认不出、既超范围又碰人闸：400 ask_incomplete，一条都不记', async () => {
    const h = harness();
    const bad: Record<string, unknown>[] = [
      { question: '用哪家短信？' },
      { question: '用哪家短信？', options: ['阿里云'], recommend: '阿里云' },
      { question: '用哪家短信？', options: ['阿里云', '腾讯云'] },
      { question: '用哪家短信？', options: ['阿里云', '腾讯云'], recommend: '华为云' },
      { question: '用哪家短信？', options: ['甲', '乙', '丙', '丁', '戊'], recommend: '甲' },
      { ...sms, hold: 'secret' },
      { ...sms, hold: 'spend', outside: true },
    ];
    for (const body of bad) {
      const res = await ask(h, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(res)).toBe('ask_incomplete');
    }
    expect(h.store.data.asks).toHaveLength(0);
    expect(h.signals).toHaveLength(0);
  });

  it('答过了的：再问同一句直接回答案（驾驶舱、飞书、issue 回的都算）', async () => {
    const h = harness();
    const session = await h.login();
    const first = AskResponse.parse(await (await ask(h, sms)).json());
    const answered = await h.cockpit.request(
      `/api/asks/${first.askId}/answer`,
      write('POST', session, { answer: '腾讯云' }),
    );
    expect(answered.status).toBe(200);
    expect(AskResponse.parse(await (await ask(h, sms)).json())).toEqual({
      askId: first.askId,
      status: 'answered',
      answer: '腾讯云',
    });
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

  it('返工轮次带着已有的 PR 编号、这张 PR 的 CI 全绿：PR 在、分支对也收下（554-2 起判 PR 的 CI，不看会话里跑测试）', async () => {
    const h = harness();
    withPr(h, { checks: 'success' });
    expect((await done(h, { summary: '按审查意见改了', prNumber: 31, testsPassed: true })).status).toBe(200);
  });

  it('带 PR 但 CI 还没跑完（pending）/ 还没起（none）：409 等，不能当绿', async () => {
    const h = harness();
    withPr(h, { checks: 'pending' });
    const pending = await done(h, { summary: 's', prNumber: 31, testsPassed: true });
    expect(pending.status).toBe(409);
    expect(await errorCode(pending)).toBe('not_verifiable_yet');
    const current = h.store.data.pullRequests[0];
    if (!current) throw new Error('withPr 没塞上 PR？');
    h.store.data.pullRequests[0] = { ...current, checks: 'none' };
    const none = await done(h, { summary: 's', prNumber: 31, testsPassed: true });
    expect(none.status).toBe(409);
    expect(await errorCode(none)).toBe('not_verifiable_yet');
  });

  it('带 PR 但 CI 是红的：422，必须修这条 PR 再交（不能用「会话里测试过了」顶）', async () => {
    const h = harness();
    withPr(h, { checks: 'failure' });
    testRun(h, true);
    const res = await done(h, { summary: 's', prNumber: 31, testsPassed: true });
    expect(res.status).toBe(422);
    expect(await reasonsOf(res)).toContain('PR #31 的 CI 是红的');
  });

  it('说了就算不行：没跑过测试、最后一次测试是红的、PR 不在本会话分支上，逐条退回并说明原因', async () => {
    const h = harness();
    const noTests = await done(h, { summary: 's', testsPassed: true });
    expect(noTests.status).toBe(422);
    expect(await reasonsOf(noTests)).toContain('没查到本次会话跑过 `pnpm test:changed` 的记录');

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

  it('先跑过一次绿的、最后一次接了管道（结果认不出）：退回，前面那次绿的顶不上', async () => {
    const h = harness();
    testRun(h, true);
    h.store.data.progress.push({
      id: String(++seq),
      runId: DEV_RUN_ID,
      at: new Date(h.clock.now.getTime() + 5 * 60_000).toISOString(),
      kind: 'test',
      payload: {
        command: 'pnpm check | tail',
        unknownBecause: '带管道又没开 pipefail，退出码是管道最后一段的',
      },
    });
    const res = await done(h, { summary: 's', testsPassed: true });
    expect(res.status).toBe(422);
    expect(await reasonsOf(res)).toContain('结果认不出：带管道又没开 pipefail');
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
    expect(timeline.items[0]?.text).toContain('交活被退回：没查到本次会话跑过 `pnpm test:changed`');
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
