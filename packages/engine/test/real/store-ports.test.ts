// 选路、报警、提问、人闸、计时、快照接真库（PGlite）：三种结果原样换成端口的；点名、续会话、被暂停的账号池、
// 没接上的执行方式各有去处；库里对不上的明确报错，不当成「没有路由」「记上了」。
import { randomUUID } from 'node:crypto';
import {
  asks,
  finishSessionRun,
  getSessionRun,
  markSessionRunStarted,
  notifications,
  openSessionRun,
  sessionRuns,
  stepTimings,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PickRouteInput } from '../../src/ports.ts';
import { createStorePorts, poolHoldKey } from '../../src/real/store-ports.ts';
import { addTask, MIN, NOW, world } from './fixtures.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

const ctx = { signal: new AbortController().signal, heartbeat() {}, attempt: 1, lastHeartbeat: undefined };
const ports = () => createStorePorts({ db: t.db, now: () => NOW, draw: () => 0.5, log: () => {} });
const pick = (over: Partial<PickRouteInput> = {}) =>
  ports().pickRoute(
    {
      taskId: randomUUID(),
      stage: 'triage',
      avoidRouteIds: [],
      avoidPoolIds: [],
      avoidModelIds: [],
      ...over,
    },
    ctx,
  );

describe('选路', () => {
  it('按调度台的顺序派；两个 Claude 池是同一个会话用户，不再分主池、备池', async () => {
    await world(t.db);
    const r = await pick();
    expect(r).toMatchObject({
      ok: true,
      route: { routeId: 'solo', poolId: 'claude-solo', poolRole: 'primary' },
    });
    const carpool = await pick({ avoidRouteIds: ['solo'] });
    expect(carpool).toMatchObject({ ok: true, route: { routeId: 'carpool', poolRole: 'primary' } });
    // 写码这种重活照样派得出去：平时挂着的拼车池要接全部的活
    expect(await pick({ stage: 'execute', avoidRouteIds: ['solo'] })).toMatchObject({
      ok: true,
      route: { routeId: 'carpool' },
    });
  });

  it('会话用户挂着拼车组织：独享池挡着不派（写明为什么），拼车池照派；池名按组织类型分', async () => {
    await world(t.db);
    await t.client.query(`update pools set org_kind = 'solo' where id = 'claude-solo'`);
    expect(await pick({ stage: 'execute' })).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    const none = await pick({ stage: 'execute', avoidRouteIds: ['carpool'] });
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toContain(
      '会话用户现在挂的是拼车组织，Claude 订阅 · 独享要等切过去才能派',
    );
  });

  it('执行方式还没接上的路由不派；只剩它时派不出，理由里写明', async () => {
    await world(t.db, { order: ['luna', 'solo'] });
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    const none = await pick({ avoidRouteIds: ['solo'] });
    expect(none).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!none.ok && none.detail).toContain('执行方式引擎还没接上');
  });

  it('被暂停的账号池（pool-hold:<池>）整池避开；续会话的那一单照样放过去，当试探', async () => {
    await world(t.db);
    await upsertAlert(t.db, {
      dedupeKey: poolHoldKey('claude-solo'),
      level: 'decision',
      taskId: null,
      title: '账号池 claude-solo 整池暂停',
      body: '在「法国」上以会话用户 fleet-agent-carpool 重跑 reclaude login',
    });
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    const probe = await pick({ stickRouteId: 'solo' });
    expect(probe).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    expect(probe.ok && probe.why).toContain('看修好了没有');
  });

  it('续同一个会话：暂时派不了就等它，不换到别的路由', async () => {
    await world(t.db);
    // 独享池的空位占满：三个已开工、没结束的会话。
    const { task } = await addTask(t.db);
    for (let i = 0; i < 3; i++) {
      await openSessionRun(t.db, {
        id: randomUUID(),
        taskId: task.id,
        subtaskId: null,
        stage: 'triage',
        routeId: 'solo',
        whyRoute: '占位',
        branch: null,
        queuedAt: new Date(NOW.getTime() - 10 * MIN),
        workflowId: null,
        runAsUser: 'fleet-agent-carpool',
        worktreePath: null,
      });
    }
    await t.db.update(sessionRuns).set({ startedAt: new Date(NOW.getTime() - 5 * MIN) });
    const r = await pick({ stickRouteId: 'solo' });
    expect(r).toMatchObject({ ok: false, waitFor: 'slot' });
    expect(!r.ok && r.detail).toContain('续同一个会话');
    // 不续会话就照常换到还有空位的拼车号。
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
  });

  it('点名的路由用不了（被避开）：照常选，并写明点名的为什么没用上', async () => {
    await world(t.db);
    const r = await pick({ preferRouteId: 'solo', avoidPoolIds: ['claude-solo'] });
    expect(r).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
    expect(r.ok && r.why).toContain('点名的路由这次用不了');
    const unknown = await pick({ preferRouteId: 'nope' });
    expect(unknown.ok && unknown.why).toContain('不在这个阶段的调度台顺序里');
  });

  it('阶段没排顺序：派不出（不按编号乱挑）', async () => {
    await world(t.db, { stages: [] });
    const r = await pick({ stage: 'plan' });
    expect(r).toMatchObject({ ok: false, waitFor: 'none' });
  });

  it('近 7 天的会话结局喂熔断：连着失败三次，这条路由熔断，派给下一条', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      await openSessionRun(t.db, {
        id,
        taskId: task.id,
        subtaskId: null,
        stage: 'execute',
        routeId: 'solo',
        whyRoute: 'x',
        branch: null,
        queuedAt: new Date(NOW.getTime() - (10 - i) * MIN),
        workflowId: null,
        runAsUser: 'fleet-agent-carpool',
        worktreePath: null,
      });
      await markSessionRunStarted(t.db, {
        id,
        startedAt: new Date(NOW.getTime() - (9 - i) * MIN),
        sessionId: randomUUID(),
        handle: null,
      });
      // 最后一次失败在一分钟前：还在冷却里（第一次熔断冷却 10 分钟），不是半开。
      await finishSessionRun(t.db, {
        id,
        outcome: 'failed',
        endedAt: new Date(NOW.getTime() - (3 - i) * MIN),
        routeOutcome: 'fail',
      });
    }
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
  });

  it('选路的输入认不出（这里是越界的调度策略）：抛 ROUTING_INPUT，不当成「没有路由」', async () => {
    await world(t.db);
    const bad = createStorePorts({
      db: t.db,
      now: () => NOW,
      routingPolicy: { trialRatio: 5 },
      log: () => {},
    });
    await expect(
      bad.pickRoute(
        { taskId: randomUUID(), stage: 'execute', avoidRouteIds: [], avoidPoolIds: [], avoidModelIds: [] },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'ROUTING_INPUT' });
  });

  it('关掉的路由（调度台上单条开关）不派', async () => {
    await world(t.db);
    await t.client.query(
      "update stage_policy_routes set enabled = false where stage = 'triage' and route_id = 'solo'",
    );
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });
  });
});

describe('报警、提问、人闸', () => {
  it('报警按 dedupe_key 一张卡；合并队列这类没有任务的不挂任务', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    const p = ports();
    const first = await p.raiseAlert(
      { taskId: task.id, level: 'stuck', title: '卡住了', detail: '第一次', dedupeKey: 'wf:park:1' },
      ctx,
    );
    const again = await p.raiseAlert(
      { taskId: task.id, level: 'stuck', title: '还卡着', detail: '第二次', dedupeKey: 'wf:park:1' },
      ctx,
    );
    expect(again.alertId).toBe(first.alertId);
    await p.raiseAlert(
      { taskId: '', level: 'info', title: '合并队列判断出错', detail: 'x', dedupeKey: 'mq:decide' },
      ctx,
    );
    const rows = await t.db.select().from(notifications);
    expect(rows.map((r) => [r.dedupeKey, r.level, r.taskId]).sort()).toEqual(
      [
        ['mq:decide', 'alert', null],
        ['wf:park:1', 'alert', task.id],
      ].sort(),
    );
  });

  it('提问按 askId 只发一张；人闸按 approvalId 只开一张、同时开一条要人拍的提醒', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    const p = ports();
    const askId = randomUUID();
    await p.askHuman(
      { taskId: task.id, askId, question: '要不要兼容旧接口？', options: ['要', '不要'] },
      ctx,
    );
    await p.askHuman({ taskId: task.id, askId, question: '要不要兼容旧接口？' }, ctx);
    expect(await t.db.select().from(asks)).toHaveLength(1);
    const approvalId = randomUUID();
    const approval = {
      taskId: task.id,
      approvalId,
      holds: ['release'],
      repo: { owner: 'acme', name: 'widgets', defaultBranch: 'main', testCommand: 'pnpm check' },
      prNumber: 7,
      head: 'a'.repeat(40),
      title: '发版',
      summary: '合并即上线',
    };
    await p.requestApproval(approval as never, ctx);
    await p.requestApproval(approval as never, ctx);
    const cards = (await t.db.select().from(notifications)).filter(
      (n) => n.dedupeKey === `approval:${approvalId}`,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.level).toBe('decision');
  });

  it('提问的任务不在库里：照常抛（不假装发出去了）', async () => {
    await world(t.db);
    await expect(
      ports().askHuman({ taskId: randomUUID(), askId: randomUUID(), question: '？' }, ctx),
    ).rejects.toThrow();
  });
});

describe('计时、快照', () => {
  it('活动、等待各记一行，重试重写同一笔不重复', async () => {
    await world(t.db);
    const p = ports();
    const activity = {
      kind: 'activity' as const,
      workflowId: 'req:acme/widgets#12',
      runId: 'temporal-run-1',
      workflowType: 'requirementWorkflow',
      activity: 'pickRoute',
      attempt: 1,
      scheduledAt: NOW.toISOString(),
      startedAt: NOW.toISOString(),
      endedAt: new Date(NOW.getTime() + 20).toISOString(),
      queueMs: 0,
      runMs: 20,
      outcome: 'ok' as const,
    };
    await p.recordTiming(activity, ctx);
    await p.recordTiming(activity, ctx);
    await p.recordTiming(
      {
        kind: 'wait',
        workflowId: 'req:acme/widgets#12',
        runId: 'temporal-run-1',
        workflowType: 'requirementWorkflow',
        waitFor: 'slot',
        detail: '等空位',
        startedAt: NOW.toISOString(),
        endedAt: new Date(NOW.getTime() + MIN).toISOString(),
        waitMs: MIN,
      },
      ctx,
    );
    const rows = await t.db.select().from(stepTimings);
    expect(rows.map((r) => r.kind).sort()).toEqual(['activity', 'wait']);
  });

  it('会话那一笔：看守没写过的由它收尾；看守写过的不改；库里没有这次会话明确报错', async () => {
    await world(t.db);
    const { task } = await addTask(t.db);
    const runId = randomUUID();
    await openSessionRun(t.db, {
      id: runId,
      taskId: task.id,
      subtaskId: null,
      stage: 'execute',
      routeId: 'solo',
      whyRoute: 'x',
      branch: null,
      queuedAt: NOW,
      workflowId: null,
      runAsUser: 'fleet-agent-carpool',
      worktreePath: null,
    });
    const record = {
      kind: 'session' as const,
      workflowId: 'sub:x',
      runId,
      taskId: task.id,
      sessionId: '',
      stage: 'execute' as const,
      routeId: 'solo',
      outcome: 'failed' as const,
      endedAt: new Date(NOW.getTime() + MIN).toISOString(),
      usage: {},
      failureCode: 'SPAWN_FAILED',
    };
    await ports().recordTiming(record, ctx);
    expect(await getSessionRun(t.db, runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'SPAWN_FAILED',
    });
    await ports().recordTiming({ ...record, outcome: 'ok', failureCode: 'SHOULD_NOT_LAND' }, ctx);
    expect(await getSessionRun(t.db, runId)).toMatchObject({
      outcome: 'failed',
      failureCode: 'SPAWN_FAILED',
    });
    await expect(ports().recordTiming({ ...record, runId: randomUUID() }, ctx)).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
  });

  it('任务快照：任务不在库里明确报错', async () => {
    await world(t.db);
    await expect(
      ports().saveTaskState(
        {
          taskId: randomUUID(),
          repoId: randomUUID(),
          issueNumber: 1,
          state: 'running' as never,
          phase: 'x',
          doing: 'x',
          specDir: 'specs/1-x',
          docs: {},
          lastProblem: null,
          subtasks: [],
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });
});
