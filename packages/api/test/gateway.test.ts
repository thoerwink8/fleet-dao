import { FEISHU_ACTING_HEADER, requirementWorkflowId, TaskDetailResponse } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  agentRequest,
  DEV_USER_ID,
  errorCode,
  GATEWAY_PASS,
  harness,
  IDS,
  viaGateway,
  write,
} from './harness.ts';

const FOUNDER_A = 'ou_dev_founder_a';

describe('飞书网关通行证', () => {
  it('网关代创始人操作：认 open_id，不要 CSRF，操作记录 via=feishu、记在这位创始人名下', async () => {
    const h = harness();
    const detail = TaskDetailResponse.parse(
      await (await h.cockpit.request(`/api/tasks/${IDS.task12}`, viaGateway('GET', FOUNDER_A))).json(),
    );
    expect(detail.task.id).toBe(IDS.task12);

    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      viaGateway('POST', FOUNDER_A, { action: 'stop', reason: '飞书里点的叫停' }),
    );
    expect(res.status).toBe(200);
    expect(h.signals).toEqual([
      {
        workflowId: requirementWorkflowId({ owner: 'example', name: 'canary' }, 12),
        signal: { name: 'stop', by: DEV_USER_ID, reason: '飞书里点的叫停' },
      },
    ]);
    expect(h.store.data.audit.at(-1)).toMatchObject({
      actor: { kind: 'user', id: DEV_USER_ID },
      action: 'task.stop',
      via: 'feishu',
      ok: true,
    });
  });

  it('网关对需求只能叫停：暂停、继续、换路由一律 403，什么都不做；驾驶舱里照常能暂停', async () => {
    const h = harness();
    for (const body of [
      { action: 'pause', reason: '飞书里点的暂停' },
      { action: 'resume' },
      { action: 'reroute', routeId: 'route-x' },
    ]) {
      const res = await h.cockpit.request(
        `/api/tasks/${IDS.task12}/actions`,
        viaGateway('POST', FOUNDER_A, body),
      );
      expect({ action: body.action, status: res.status, code: await errorCode(res) }).toEqual({
        action: body.action,
        status: 403,
        code: 'gateway_action_not_allowed',
      });
    }
    expect(h.signals).toEqual([]);
    expect(h.store.data.audit).toEqual([]);
    const session = await h.login();
    const res = await h.cockpit.request(
      `/api/tasks/${IDS.task12}/actions`,
      write('POST', session, { action: 'pause', reason: '驾驶舱里点的暂停' }),
    );
    expect(res.status).toBe(200);
    expect(h.signals.map((s) => s.signal.name)).toEqual(['pause']);
  });

  it('通行证不对、格式不对、没配通行证：401；不会退回去认 Cookie', async () => {
    const h = harness();
    const { cookie } = await h.login();
    for (const init of [
      viaGateway('GET', FOUNDER_A, undefined, 'wrong-pass'),
      viaGateway('GET', FOUNDER_A, undefined, `${GATEWAY_PASS}x`),
      viaGateway('GET', FOUNDER_A, undefined, GATEWAY_PASS.slice(0, -1)),
      { headers: { authorization: `Basic ${GATEWAY_PASS}`, [FEISHU_ACTING_HEADER]: FOUNDER_A } },
      { headers: { authorization: `Bearer wrong-pass`, [FEISHU_ACTING_HEADER]: FOUNDER_A, cookie } },
    ]) {
      const res = await h.cockpit.request('/api/me', init);
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('bearer_not_allowed');
    }
    const off = harness({ config: { feishuGatewayToken: null } });
    expect(await errorCode(await off.cockpit.request('/api/me', viaGateway('GET', FOUNDER_A)))).toBe(
      'bearer_not_allowed',
    );
  });

  it('没说代表谁、open_id 查不到、不是创始人（停用、协作者、机器人）：403，什么都不做', async () => {
    const h = harness();
    const noActing = viaGateway('POST', FOUNDER_A, { action: 'stop' });
    delete (noActing.headers as Record<string, string>)['x-fleet-acting-feishu'];
    const res = await h.cockpit.request(`/api/tasks/${IDS.task12}/actions`, noActing);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('acting_missing');

    const stop = (openId: string) =>
      h.cockpit.request(`/api/tasks/${IDS.task12}/actions`, viaGateway('POST', openId, { action: 'stop' }));
    expect(await errorCode(await stop('ou_nobody'))).toBe('not_whitelisted');
    expect(await errorCode(await stop('  '))).toBe('acting_missing');

    const founder = h.store.data.users.find((u) => u.id === DEV_USER_ID);
    if (!founder) throw new Error('样例数据里没有创始人甲');
    founder.active = false;
    expect(await errorCode(await stop(FOUNDER_A))).toBe('not_whitelisted');
    founder.active = true;
    for (const role of ['collaborator', 'bot'] as const) {
      founder.role = role;
      expect(await errorCode(await stop(FOUNDER_A)), role).toBe('not_whitelisted');
    }
    expect(h.signals).toHaveLength(0);
  });

  it('通行证只放行约定里的驾驶舱接口（查任务、叫停、回答追问）：别的一律 403，什么都不做', async () => {
    const h = harness();
    const cases: Array<[string, RequestInit]> = [
      ['/api/me', viaGateway('GET', FOUNDER_A)],
      ['/api/events', viaGateway('GET', FOUNDER_A)],
      ['/api/audit', viaGateway('GET', FOUNDER_A)],
      [`/api/tasks/${IDS.task12}/timeline`, viaGateway('GET', FOUNDER_A)],
      ['/api/settings/sessions.maxConcurrent', viaGateway('PUT', FOUNDER_A, { value: 3, version: 1 })],
      ['/api/routing/channels/ch-claude', viaGateway('PATCH', FOUNDER_A, { enabled: false })],
      [`/api/notifications/${IDS.notification1}/resolve`, viaGateway('POST', FOUNDER_A)],
      // 飞书接口表里没有的路径也一样。
      ['/api/feishu/nope', viaGateway('GET', FOUNDER_A)],
      ['/api/feishu/board', viaGateway('POST', FOUNDER_A)],
    ];
    for (const [path, init] of cases) {
      const res = await h.cockpit.request(path, init);
      expect({ path, method: init.method, status: res.status, code: await errorCode(res) }).toEqual({
        path,
        method: init.method,
        status: 403,
        code: 'gateway_route_not_allowed',
      });
    }
    expect(h.store.data.settings.find((s) => s.key === 'sessions.maxConcurrent')?.value).toBe(6);
    expect(h.store.data.channels.find((ch) => ch.id === 'ch-claude')?.enabled).toBe(true);
    expect(h.store.data.notifications.find((n) => n.id === IDS.notification1)?.resolvedAt).toBeUndefined();
    expect(h.store.data.audit).toHaveLength(0);
  });

  it('网关请求没有浏览器会话：退出登录不适用（400）', async () => {
    const h = harness();
    const res = await h.cockpit.request('/auth/logout', viaGateway('POST', FOUNDER_A));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('not_a_browser_session');
  });

  it('通行证只管驾驶舱接口：拿去调 fleet 接口不认', async () => {
    const h = harness();
    const res = await h.agent.request('/agent/v1/task', agentRequest(GATEWAY_PASS));
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('agent_token_invalid');
  });

  it('通行证不进日志、不进响应、不进操作记录', async () => {
    const h = harness();
    const session = await h.login();
    await h.cockpit.request('/api/me', viaGateway('GET', FOUNDER_A));
    await h.cockpit.request('/api/me', viaGateway('GET', 'ou_nobody'));
    await h.cockpit.request('/api/me', viaGateway('GET', FOUNDER_A, undefined, `${GATEWAY_PASS}x`));
    const bodies = await Promise.all([
      h.cockpit.request(
        `/api/tasks/${IDS.task12}/actions`,
        viaGateway('POST', FOUNDER_A, { action: 'stop' }),
      ),
      h.cockpit.request('/api/audit', { headers: { cookie: session.cookie } }),
      h.cockpit.request(`/api/tasks/${IDS.task12}/actions`, write('POST', session, { action: 'resume' })),
    ]).then((all) => Promise.all(all.map((r) => r.text())));
    const everything = JSON.stringify([h.logs, h.store.data.audit, bodies]);
    expect(everything).not.toContain(GATEWAY_PASS);
    expect(everything).not.toContain(GATEWAY_PASS.slice(0, 16));
  });
});
