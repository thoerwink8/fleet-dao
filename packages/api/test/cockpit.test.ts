import {
  AuditResponse,
  BoardResponse,
  JobsResponse,
  NotificationsResponse,
  PoolsResponse,
  RoutingResponse,
  RunStepsResponse,
  SettingsResponse,
  StageKindSchema,
  TaskDetailResponse,
  TimelineResponse,
  UpdateSettingResponse,
  UpdateStagePolicyResponse,
  WEB_API_PREFIX,
  WebRoutes,
} from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { devFixtures } from '../src/dev-fixtures.ts';
import { WorkflowGoneError } from '../src/ports.ts';
import { DEV_RUN_ID, DEV_USER_ID, errorCode, harness, T0, write } from './harness.ts';

const PARAMS: Record<string, string> = {
  repoId: 'repo-1',
  taskId: 'task-12',
  runId: DEV_RUN_ID,
  askId: 'ask-none',
  stage: 'execute',
  channelId: 'ch-cursor',
  notificationId: 'n-1',
  key: 'sessions.maxConcurrent',
};

function fill(path: string): string {
  return WEB_API_PREFIX + path.replace(/:(\w+)/g, (_, name: string) => PARAMS[name] ?? name);
}

describe('约定与实现对得上', () => {
  it('WebRoutes 里每个接口后端都有（不会落到「没有这个接口」）', async () => {
    const h = harness();
    const session = await h.login();
    for (const [name, route] of Object.entries(WebRoutes)) {
      if (name === 'events') continue; // SSE 另测
      const init =
        route.method === 'GET' ? { headers: { cookie: session.cookie } } : write(route.method, session, {});
      const res = await h.cockpit.request(fill(route.path), init);
      if (res.status === 404) expect(await errorCode(res), name).not.toBe('not_found');
    }
  });

  it('每个读接口的返回都符合 shared/web-api.ts 的形状', async () => {
    const h = harness();
    const { cookie } = await h.login();
    for (const [name, route] of Object.entries(WebRoutes)) {
      if (route.method !== 'GET' || !('response' in route)) continue;
      const res = await h.cockpit.request(fill(route.path), { headers: { cookie } });
      expect(res.status, name).toBe(200);
      const parsed = route.response.safeParse(await res.json());
      expect(parsed.success, `${name}: ${parsed.error?.message}`).toBe(true);
    }
  });

  it('库里多出来的字段不会漏给前端（例如仓的测试命令、用户的飞书编号）', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const board = await (await h.cockpit.request('/api/repos/repo-1/board', { headers: { cookie } })).text();
    expect(board).not.toContain('pnpm check');
    const me = await (await h.cockpit.request('/api/me', { headers: { cookie } })).text();
    expect(me).not.toContain('ou_dev_founder_a');
  });

  it('库返回的数据缺字段：当场 500，不把坏数据交给前端', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const task = h.store.data.tasks[0];
    if (!task) throw new Error('样例数据里没有任务');
    Reflect.deleteProperty(task, 'title');
    const res = await h.cockpit.request('/api/repos/repo-1/board', { headers: { cookie } });
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('bad_response_shape');
  });
});

describe('看板与任务', () => {
  it('卡片上一句白话状态、步骤进度、「此刻」面板', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const board = BoardResponse.parse(
      await (await h.cockpit.request('/api/repos/repo-1/board', { headers: { cookie } })).json(),
    );
    const task = board.tasks.find((t) => t.id === 'task-12');
    const sub = task?.subtasks.find((s) => s.id === 'sub-12a');
    expect(sub?.activity?.text).toBe('Opus 5.5 正在写验证码过期的测试');
    expect(sub?.progress).toEqual({ done: 1, total: 3 });
    expect(task?.progress).toEqual({ done: 0, total: 2 });
    expect(board.now.map((n) => [n.taskId, n.runId])).toEqual([['task-12', DEV_RUN_ID]]);
    expect((await h.cockpit.request('/api/repos/nope/board', { headers: { cookie } })).status).toBe(404);
  });

  it('任务详情带全部会话（含已结束的）与追问', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const detail = TaskDetailResponse.parse(
      await (await h.cockpit.request('/api/tasks/task-12', { headers: { cookie } })).json(),
    );
    expect(detail.runs.map((r) => r.id).sort()).toEqual(['run-0', DEV_RUN_ID]);
    expect(detail.runs.find((r) => r.id === 'run-0')?.modelName).toBe('Opus 5.5');
  });

  it('时间线：会话报的、人做的都在，按时间倒序，翻页不重不漏', async () => {
    const h = harness();
    const session = await h.login();
    const token = h.agentToken();
    for (let i = 0; i < 5; i++) {
      h.clock.now = new Date(h.clock.now.getTime() + 1000);
      await h.agent.request('/agent/v1/say', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: `第 ${i} 句` }),
      });
    }
    h.clock.now = new Date(h.clock.now.getTime() + 1000);
    await h.cockpit.request(
      '/api/tasks/task-12/actions',
      write('POST', session, { action: 'pause', reason: '先停一下' }),
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({ limit: '2', ...(cursor ? { cursor } : {}) });
      const body = TimelineResponse.parse(
        await (
          await h.cockpit.request(`/api/tasks/task-12/timeline?${qs}`, {
            headers: { cookie: session.cookie },
          })
        ).json(),
      );
      seen.push(...body.items.map((i) => i.text));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen[0]).toBe('暂停：先停一下');
    expect(seen.slice(1, 6)).toEqual(['第 4 句', '第 3 句', '第 2 句', '第 1 句', '第 0 句']);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain('正在写验证码过期的测试');
  });

  it('会话步骤清单与最近一句进度', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const body = RunStepsResponse.parse(
      await (await h.cockpit.request(`/api/runs/${DEV_RUN_ID}/steps`, { headers: { cookie } })).json(),
    );
    expect(body.steps).toHaveLength(3);
    expect(body.lastSay?.text).toBe('正在写验证码过期的测试');
  });
});

describe('发给工作流的信号', () => {
  it('暂停、继续、叫停：发给这个任务的工作流，并写操作记录', async () => {
    const h = harness();
    const s = await h.login();
    for (const action of ['pause', 'resume', 'stop'] as const) {
      const res = await h.cockpit.request('/api/tasks/task-12/actions', write('POST', s, { action }));
      expect(res.status, action).toBe(200);
    }
    expect(h.signals.map((x) => [x.taskId, x.signal.name])).toEqual([
      ['task-12', 'pause'],
      ['task-12', 'resume'],
      ['task-12', 'stop'],
    ]);
    expect(h.signals[0]?.signal).toMatchObject({ by: DEV_USER_ID });
    expect(h.store.data.audit.slice(-3).map((a) => a.action)).toEqual([
      'task.pause',
      'task.resume',
      'task.stop',
    ]);
  });

  it('换路由：只许换到在线、不犯禁令的路由；目标是在跑的那次会话', async () => {
    const h = harness();
    const s = await h.login();
    const post = (body: unknown) => h.cockpit.request('/api/tasks/task-12/actions', write('POST', s, body));
    const fable = await post({ action: 'reroute', routeId: 'rt-mirasim-fable' });
    expect(await errorCode(fable)).toBe('route_not_allowed');
    const offline = h.store.data.routes.find((r) => r.id === 'rt-mirasim-kimi');
    if (!offline) throw new Error('样例数据里没有这条路由');
    offline.alive = false;
    expect(await errorCode(await post({ action: 'reroute', routeId: 'rt-mirasim-kimi' }))).toBe(
      'route_offline',
    );
    offline.alive = true;
    const ok = await post({ action: 'reroute', routeId: 'rt-mirasim-kimi', reason: '试试 Kimi' });
    expect(ok.status).toBe(200);
    expect(h.signals.at(-1)?.signal).toEqual({
      name: 'reroute',
      by: DEV_USER_ID,
      routeId: 'rt-mirasim-kimi',
      subtaskId: 'sub-12a',
      reason: '试试 Kimi',
    });
  });

  it('任务已结束、工作流不在了：409；先记后做——发起那条在前，没做成再追加一条 ok=false', async () => {
    const h = harness({
      workflows: {
        async signal(taskId) {
          throw new WorkflowGoneError(taskId);
        },
      },
    });
    const s = await h.login();
    const done = await h.cockpit.request('/api/tasks/task-13/actions', write('POST', s, { action: 'stop' }));
    expect(await errorCode(done)).toBe('task_finished');
    const gone = await h.cockpit.request('/api/tasks/task-12/actions', write('POST', s, { action: 'pause' }));
    expect(await errorCode(gone)).toBe('workflow_gone');
    expect(h.store.data.audit.slice(-2)).toMatchObject([
      { action: 'task.pause', target: 'task:task-12', ok: true },
      { action: 'task.pause', target: 'task:task-12', ok: false, error: 'workflow_gone' },
    ]);
    const timeline = TimelineResponse.parse(
      await (
        await h.cockpit.request('/api/tasks/task-12/timeline', { headers: { cookie: s.cookie } })
      ).json(),
    );
    expect(timeline.items.map((i) => i.text)).toContain('暂停没做成：workflow_gone');
  });

  it('操作记录写不进：信号不发（故障注入）', async () => {
    const h = harness();
    const s = await h.login();
    h.store.appendAudit = async () => {
      throw new Error('库写不进');
    };
    for (const action of ['pause', 'resume', 'stop']) {
      const res = await h.cockpit.request('/api/tasks/task-12/actions', write('POST', s, { action }));
      expect(res.status, action).toBe(500);
    }
    const reroute = await h.cockpit.request(
      '/api/tasks/task-12/actions',
      write('POST', s, { action: 'reroute', routeId: 'rt-mirasim-kimi' }),
    );
    expect(reroute.status).toBe(500);
    expect(h.signals).toHaveLength(0);
  });

  it('回答追问：写库、发 answer 信号、留记录；第二次回答 409', async () => {
    const h = harness();
    const s = await h.login();
    h.store.data.asks.push({
      id: 'ask-1',
      taskId: 'task-12',
      runId: DEV_RUN_ID,
      question: '几位？',
      options: ['4', '6'],
      askedAt: h.clock.now.toISOString(),
    });
    const res = await h.cockpit.request('/api/asks/ask-1/answer', write('POST', s, { answer: '6' }));
    expect(res.status).toBe(200);
    expect(h.store.data.asks[0]).toMatchObject({ answer: '6', answeredBy: DEV_USER_ID });
    expect(h.signals.at(-1)).toEqual({
      taskId: 'task-12',
      signal: { name: 'answer', by: DEV_USER_ID, askId: 'ask-1', answer: '6' },
    });
    expect(h.store.data.audit.at(-1)).toMatchObject({ action: 'ask.answer', target: 'task:task-12' });
    const again = await h.cockpit.request('/api/asks/ask-1/answer', write('POST', s, { answer: '4' }));
    expect(await errorCode(again)).toBe('already_answered');
  });
});

describe('调度台', () => {
  it('读：每个阶段类型都有一行（没配过的是空列表）', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const body = RoutingResponse.parse(
      await (await h.cockpit.request('/api/routing', { headers: { cookie } })).json(),
    );
    expect(body.stages.map((s) => s.stage)).toEqual(StageKindSchema.options);
    expect(body.stages.find((s) => s.stage === 'triage')).toEqual({
      stage: 'triage',
      routeIds: [],
      pinned: false,
    });
  });

  it('改路由顺序：写操作记录（改前、改后、理由）', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request(
      '/api/routing/stages/execute',
      write('PUT', s, {
        routeIds: ['rt-mirasim-kimi', 'rt-claude-opus'],
        pinned: true,
        expected: { routeIds: ['rt-claude-opus', 'rt-mirasim-kimi'], pinned: false },
        reason: 'Kimi 这周额度多',
      }),
    );
    expect(res.status).toBe(200);
    expect(UpdateStagePolicyResponse.parse(await res.json()).stage.routeIds).toEqual([
      'rt-mirasim-kimi',
      'rt-claude-opus',
    ]);
    expect(h.store.data.audit.at(-1)).toMatchObject({
      actor: { kind: 'user', id: DEV_USER_ID },
      action: 'stage_policy.update',
      target: 'stage:execute',
      before: { routeIds: ['rt-claude-opus', 'rt-mirasim-kimi'], pinned: false },
      after: { routeIds: ['rt-mirasim-kimi', 'rt-claude-opus'], pinned: true },
      reason: 'Kimi 这周额度多',
      via: 'cockpit',
    });
  });

  it('别人先改了：409，不悄悄盖掉', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request(
      '/api/routing/stages/execute',
      write('PUT', s, {
        routeIds: ['rt-claude-opus'],
        pinned: false,
        expected: { routeIds: [], pinned: false },
      }),
    );
    expect(res.status).toBe(409);
    expect(h.store.data.stagePolicies.find((p) => p.stage === 'execute')?.routeIds).toEqual([
      'rt-claude-opus',
      'rt-mirasim-kimi',
    ]);
  });

  it('硬禁令写死在代码里：库里的 bans 表空了，GPT 照样进不了 UI，Fable（claude 族）哪个阶段都进不了', async () => {
    const data = devFixtures(T0);
    data.bans = [];
    const h = harness({ data });
    const s = await h.login();
    const put = (stage: string, routeIds: string[]) =>
      h.cockpit.request(
        `/api/routing/stages/${stage}`,
        write('PUT', s, {
          routeIds,
          pinned: false,
          expected: { routeIds: ['rt-claude-opus'], pinned: true },
        }),
      );
    const gpt = await put('ui', ['rt-mirasim-gpt']);
    expect(gpt.status).toBe(422);
    expect(((await gpt.json()) as { error: { message: string } }).error.message).toContain('GPT 不做 UI');
    for (const stage of ['execute', 'review', 'triage']) {
      const fable = await put(stage, ['rt-mirasim-fable']);
      expect(fable.status, stage).toBe(422);
      expect(((await fable.json()) as { error: { message: string } }).error.message).toContain('不用 Fable');
    }
    expect(h.store.data.stagePolicies.find((p) => p.stage === 'ui')?.routeIds).toEqual(['rt-claude-opus']);

    const routing = RoutingResponse.parse(
      await (await h.cockpit.request('/api/routing', { headers: { cookie: s.cookie } })).json(),
    );
    expect(routing.hardBans.map((b) => b.id)).toEqual(['gpt-no-ui', 'no-fable']);
    expect(routing.bans).toEqual([]);
  });

  it('库里另配的禁令和硬禁令一起生效；不存在的路由、重复的路由、不存在的阶段都拒', async () => {
    const h = harness();
    const s = await h.login();
    const put = (stage: string, routeIds: string[]) =>
      h.cockpit.request(
        `/api/routing/stages/${stage}`,
        write('PUT', s, {
          routeIds,
          pinned: false,
          expected: { routeIds: ['rt-claude-opus'], pinned: true },
        }),
      );
    const kimi = await put('ui', ['rt-mirasim-kimi']);
    expect(((await kimi.json()) as { error: { message: string } }).error.message).toContain('Kimi 暂不进 UI');
    expect(await errorCode(await put('ui', ['rt-nope']))).toBe('route_not_allowed');
    expect(await errorCode(await put('ui', ['rt-claude-opus', 'rt-claude-opus']))).toBe('invalid_request');
    expect(await errorCode(await put('cooking', ['rt-claude-opus']))).toBe('stage_not_found');
  });

  it('下架渠道：写操作记录；不存在的渠道 404', async () => {
    const h = harness();
    const s = await h.login();
    const res = await h.cockpit.request(
      '/api/routing/channels/ch-cursor',
      write('PATCH', s, { enabled: false }),
    );
    expect(res.status).toBe(200);
    expect(h.store.data.channels.find((c) => c.id === 'ch-cursor')?.enabled).toBe(false);
    expect(h.store.data.audit.at(-1)).toMatchObject({
      action: 'channel.disable',
      target: 'channel:ch-cursor',
    });
    expect(
      (await h.cockpit.request('/api/routing/channels/nope', write('PATCH', s, { enabled: true }))).status,
    ).toBe(404);
  });
});

describe('账号池、定时任务、通知、操作记录、设置', () => {
  it('额度：过期的读数标出来，一条读数都没有的标「没查成」，在跑的会话按池数', async () => {
    const h = harness();
    const { cookie } = await h.login();
    const body = PoolsResponse.parse(
      await (await h.cockpit.request('/api/pools', { headers: { cookie } })).json(),
    );
    const byId = new Map(body.pools.map((p) => [p.id, p]));
    expect(byId.get('pool-claude-a')).toMatchObject({
      quotaStatus: 'fresh',
      running: 1,
      channelName: 'Claude 订阅',
    });
    expect(byId.get('pool-cursor')?.quotaStatus).toBe('stale');
    expect(byId.get('pool-mirasim')).toMatchObject({ quotaStatus: 'unread', windows: [] });
    expect(body.staleAfterMinutes).toBe(30);
  });

  it('定时任务：按期成功 / 超期 / 从没成功，分得开', async () => {
    const h = harness();
    const { cookie } = await h.login();
    h.store.data.jobs.push({ id: 'job-new', name: '新模型考试', schedule: '每天', expectEveryMinutes: 1440 });
    const body = JobsResponse.parse(
      await (await h.cockpit.request('/api/jobs', { headers: { cookie } })).json(),
    );
    const status = Object.fromEntries(body.jobs.map((j) => [j.id, j.status]));
    expect(status).toEqual({ 'job-quota': 'fresh', 'job-reconcile': 'overdue', 'job-new': 'never' });
    expect(body.jobs.find((j) => j.id === 'job-reconcile')?.lastRun?.outcome).toBe('unscanned');
  });

  it('通知：没拿到消息编号就算没送到；处理掉之后不在「未处理」里', async () => {
    const h = harness();
    const s = await h.login();
    h.store.data.notifications.push({
      id: 'n-2',
      level: 'decision',
      title: '要不要买域名',
      body: '花钱，等你们拍',
      createdAt: h.clock.now.toISOString(),
      deliveries: [{ channel: 'feishu', attempts: 3, error: '230013' }],
    });
    const list = NotificationsResponse.parse(
      await (await h.cockpit.request('/api/notifications', { headers: { cookie: s.cookie } })).json(),
    );
    expect(list.items.map((n) => [n.id, n.deliveries[0]?.delivered])).toEqual([
      ['n-2', false],
      ['n-1', true],
    ]);
    expect((await h.cockpit.request('/api/notifications/n-2/resolve', write('POST', s))).status).toBe(200);
    const open = NotificationsResponse.parse(
      await (
        await h.cockpit.request('/api/notifications?status=open', { headers: { cookie: s.cookie } })
      ).json(),
    );
    expect(open.items.map((n) => n.id)).toEqual(['n-1']);
    const audit = AuditResponse.parse(
      await (
        await h.cockpit.request('/api/audit?target=notification:n-2', { headers: { cookie: s.cookie } })
      ).json(),
    );
    expect(audit.items.map((a) => a.action)).toEqual(['notification.resolve']);
  });

  it('设置：只收表里有的键、值要合规、版本对不上 409；改了留记录', async () => {
    const h = harness();
    const s = await h.login();
    const list = SettingsResponse.parse(
      await (await h.cockpit.request('/api/settings', { headers: { cookie: s.cookie } })).json(),
    );
    expect(list.settings.find((x) => x.key === 'notify.quietHours')).toMatchObject({
      value: null,
      version: 0,
    });

    const put = (key: string, body: unknown) =>
      h.cockpit.request(`/api/settings/${key}`, write('PUT', s, body));
    expect(await errorCode(await put('nope', { value: 1, version: 0 }))).toBe('setting_not_found');
    expect(await errorCode(await put('sessions.maxConcurrent', { value: 99, version: 1 }))).toBe(
      'invalid_request',
    );
    expect(await errorCode(await put('sessions.maxConcurrent', { value: 8, version: 0 }))).toBe('conflict');
    const ok = await put('sessions.maxConcurrent', { value: 8, version: 1, reason: '实测压力不大' });
    expect(UpdateSettingResponse.parse(await ok.json()).setting).toMatchObject({
      value: 8,
      version: 2,
      updatedBy: DEV_USER_ID,
    });
    expect(h.store.data.audit.at(-1)).toMatchObject({ action: 'setting.update', before: 6, after: 8 });
    const quiet = await put('notify.quietHours', { value: { start: '23:00', end: '08:00' }, version: 0 });
    expect(quiet.status).toBe(200);
  });
});
