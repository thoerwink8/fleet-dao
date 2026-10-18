// 已关单、停在检查点、没有开着会话：真工作流 + 真口子发 taskAbandon，镜像写到终态（#3002）。
// 不发 taskContinue，不起写码会话，不另建任务，也不直接改运行中的任务行。
// 已经记过「放弃了 0 条」的旧投递由每小时对账用同一套判定收尾。

import {
  alertByKey,
  type ClosedIssueDelivery,
  listRunningEngineTasks,
  openAlertsByPrefix,
  repos,
  resolveAlertWithReason,
  runs,
  saveTaskSnapshot,
  tasks,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, type TestDb } from '@fleet-dao/db/testing';
import type { Repo } from '@fleet-dao/shared';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { Client, WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineActivities } from '../src/activity-options.ts';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import {
  CLOSED_ISSUE_EVENT_BY,
  type ClosedIssueEventDeps,
  runClosedIssueEvents,
} from '../src/jobs/closed-issue-events.ts';
import {
  abandonClosedIssueTasks,
  CLOSED_ISSUE_ABANDON_BY,
  CLOSED_ISSUE_ABANDON_REASON,
  CLOSED_ISSUE_IDLE_STOP_REASON,
  type ClosedIssueTaskDeps,
} from '../src/jobs/closed-issue-tasks.ts';
import { idleRunningAlertKey, watchIdleRunning } from '../src/jobs/idle-running.ts';
import { WATCHDOG_ACTOR } from '../src/jobs/watchdog.ts';
import { temporalClosedIssueTasks } from '../src/real/hourly-reconcile.ts';
import {
  type RunSegmentResult,
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskContinueSignal,
  taskPauseSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { createRealEnv, engineBundle, pollQuery, waitUntil, withWorker } from './helpers.ts';
import { OK_SEGMENT, scripted } from './task-script.ts';

// 时间跳跃测试服务端没实现 ListWorkflowExecutions，关单收尾的真口子要列在跑的任务，所以用真开发服务端。
let env: TestWorkflowEnvironment;
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  await engineBundle();
}, 120_000);
afterAll(() => t.close());
beforeEach(async () => {
  env = await createRealEnv();
  await resetTestDb(t);
}, 60_000);
afterEach(async () => {
  await env.teardown();
}, 60_000);

const ISSUE = 2928;
const OWNER = 'thoerwink8';
const NAME = 'fleet-dao';
const OLD_DELIVERY = '388d1990-ca7d-11f1-88a0-ab3b1f9cde3d';
const ZERO_NOTE = '单关了：放弃了 0 条停着等人的任务';
const STARTED = new Date('2026-10-17T20:00:00.000Z');
const ENDED = new Date('2026-10-17T20:30:00.000Z');

async function seed(openRun: boolean): Promise<{ taskId: string; repo: Repo; workflowId: string }> {
  const [repoRow] = await t.db
    .insert(repos)
    .values({ owner: OWNER, name: NAME, testCommand: 'pnpm check' })
    .returning();
  if (!repoRow) throw new Error('repo 没写进去');
  const [task] = await t.db
    .insert(tasks)
    .values({
      repoId: repoRow.id,
      issueNumber: ISSUE,
      title: '已关单的软暂停',
      rawRequest: '已关单的软暂停',
      requestedBy: 'founder-a',
      priority: 10,
      state: 'running',
      executor: 'engine',
      phase: 'paused',
      doing: '已暂停',
    })
    .returning();
  if (!task) throw new Error('task 没写进去');
  const repo: Repo = {
    id: repoRow.id,
    owner: OWNER,
    name: NAME,
    defaultBranch: 'main',
    testCommand: 'pnpm check',
  };
  const workflowId = taskWorkflowId(repo, ISSUE);
  await t.db.insert(runs).values([
    {
      segment: 'manual',
      model: 'm1',
      taskId: task.id,
      workflowId,
      startedAt: STARTED,
      endedAt: ENDED,
      outcome: 'done',
    },
    {
      segment: 'verify',
      model: 'm1',
      taskId: task.id,
      workflowId,
      startedAt: STARTED,
      endedAt: ENDED,
      outcome: 'done',
    },
  ]);
  if (openRun) {
    await t.db.insert(runs).values({
      segment: 'manual',
      model: 'm1',
      taskId: task.id,
      workflowId,
      startedAt: STARTED,
    });
  }
  await upsertAlert(t.db, {
    dedupeKey: `${workflowId}:park:1`,
    level: 'alert',
    taskId: task.id,
    title: '挂起',
    body: '停下等人',
  });
  await upsertAlert(t.db, {
    dedupeKey: idleRunningAlertKey(task.id),
    level: 'alert',
    taskId: task.id,
    title: '在干活但没有开着的会话',
    body: '正文明确已暂停',
  });
  return { taskId: task.id, repo, workflowId };
}

function input(taskId: string, repo: Repo): TaskWorkflowInput {
  return { schemaVersion: 1, taskId, repo, issueNumber: ISSUE, title: '已关单的软暂停' };
}

function watching() {
  const signals: { name: string; arg: unknown }[] = [];
  const raw = env.client;
  const client = {
    connection: raw.connection,
    workflow: {
      list: (query: { query: string }) => raw.workflow.list(query),
      getHandle: (workflowId: string, runId?: string) => {
        const handle = raw.workflow.getHandle(workflowId, runId);
        return {
          query: handle.query.bind(handle),
          signal: async (def: { name: string }, arg: unknown) => {
            signals.push({ name: def.name, arg });
            await handle.signal(def as never, arg as never);
          },
        };
      },
    },
  };
  return { client: client as unknown as Pick<Client, 'workflow' | 'connection'>, signals };
}

function portOf(
  client: Pick<Client, 'workflow' | 'connection'>,
  readIssueState: () => Promise<{ state: 'open' | 'closed'; stateReason: null }>,
) {
  return temporalClosedIssueTasks(
    client,
    { readIssueState },
    t.db,
    () => new Date('2026-10-18T00:00:00.000Z'),
  );
}

function eventDeps(tasksDeps: ClosedIssueTaskDeps, pending: ClosedIssueDelivery[]): ClosedIssueEventDeps {
  return {
    pending: async () => pending,
    markHandled: async () => true,
    tasks: () => tasksDeps,
    now: () => new Date('2026-10-18T00:00:00.000Z'),
    log: () => {},
  };
}

const delivery = (deliveryId: string): ClosedIssueDelivery => ({
  deliveryId,
  repo: `${OWNER}/${NAME}`,
  payload: {
    action: 'closed',
    issue: { number: ISSUE, state: 'closed' },
    repository: { full_name: `${OWNER}/${NAME}` },
  },
  receivedAt: new Date('2026-10-17T22:51:01.000Z'),
});

async function start(q: string, i: TaskWorkflowInput): Promise<WorkflowHandle> {
  return env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(i.repo, i.issueNumber),
    args: [i],
  });
}

const statusUntil = (h: WorkflowHandle, check: (s: TaskStatus) => boolean, what: string) =>
  pollQuery(() => h.query(taskStatusQuery), check, what);

async function waitListed(workflowId: string): Promise<void> {
  await waitUntil(async () => {
    for await (const info of env.client.workflow.list({
      query: `WorkflowType = '${WORKFLOW_TYPES.task}' AND ExecutionStatus = 'Running'`,
    })) {
      if (info.workflowId === workflowId) return true;
    }
    return false;
  }, `${workflowId} 出现在在跑的任务里`);
}

function mirror(acts: EngineActivities): EngineActivities {
  return {
    ...acts,
    async saveTaskState(snapshot) {
      const saved = await saveTaskSnapshot(t.db, {
        taskId: snapshot.taskId,
        state: snapshot.state,
        phase: snapshot.phase,
        doing: snapshot.doing,
        lastProblem: snapshot.lastProblem,
        subtasks: snapshot.subtasks,
      });
      if (saved !== 'saved') throw new Error(`任务快照没写上（${saved}），不当成收尾成功`);
      return acts.saveTaskState(snapshot);
    },
  };
}

async function clearIdle(taskId: string): Promise<void> {
  await watchIdleRunning(
    {
      tasks: async () =>
        (await listRunningEngineTasks(t.db)).map((row) => ({ ...row, state: 'running', executor: 'engine' })),
      alerts: {
        openByPrefix: async (prefix) =>
          (await openAlertsByPrefix(t.db, prefix)).map((row) => ({
            dedupeKey: row.dedupeKey,
            title: row.title,
            body: row.body,
          })),
        raise: async () => {
          throw new Error('收尾之后不该再报没有会话');
        },
        resolve: (x) =>
          resolveAlertWithReason(t.db, {
            dedupeKey: x.dedupeKey,
            by: WATCHDOG_ACTOR,
            why: x.why,
            at: new Date('2026-10-18T00:10:00.000Z'),
          }),
      },
      log: () => {},
    },
    new Date('2026-10-18T00:10:00.000Z'),
  );
  const idle = await alertByKey(t.db, idleRunningAlertKey(taskId));
  expect(idle?.resolvedBy).toBe(WATCHDOG_ACTOR);
  expect(idle?.body).toContain('状态变了');
}

describe('已关单的检查点软暂停沿标准放弃收尾（#3002）', { timeout: 90_000 }, () => {
  it('issues.closed：无活跃会话的暂停任务收到 taskAbandon，工作流和任务镜像都到终态，自己的两条提醒撤掉', async () => {
    const { taskId, repo, workflowId } = await seed(false);
    const world = createFakeWorld();
    const { tasks: activities, calls } = scripted();
    const { client, signals } = watching();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input(taskId, repo));
        await h.signal(taskPauseSignal, { by: 'frank', reason: '先别重复做前端' });
        const status = await statusUntil(
          h,
          (s) => s.phase === 'paused' && s.waiting?.kind === 'paused',
          '停进检查点',
        );
        expect(status.waiting?.kind).toBe('paused');
        expect(calls.segment).toHaveLength(0);
        await waitListed(workflowId);
        const deps: ClosedIssueTaskDeps = {
          closedIssueTasks: portOf(client, async () => ({ state: 'closed', stateReason: null })),
          now: () => new Date('2026-10-18T00:00:00.000Z'),
          log: () => {},
        };
        expect(await runClosedIssueEvents(eventDeps(deps, [delivery('fresh-closed')]))).toBe(1);
        expect(signals.map((s) => s.name)).toEqual(['taskAbandon']);
        expect(signals[0]?.arg).toEqual({ by: CLOSED_ISSUE_EVENT_BY, reason: CLOSED_ISSUE_ABANDON_REASON });
        return h.result() as Promise<TaskRun>;
      },
      { tasks: activities, wrapActivities: (acts) => mirror(acts) },
    );
    expect(run.outcome).toBe('abandoned');
    expect(calls.segment).toHaveLength(0);
    expect(world.states.at(-1)).toMatchObject({ state: 'stopped', phase: 'abandoned', lastProblem: null });
    const rows = await t.db.select().from(tasks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: taskId, state: 'stopped', phase: 'abandoned', lastProblem: null });
    expect(rows[0]?.lastProblem).not.toBe(CLOSED_ISSUE_IDLE_STOP_REASON);
    const park = await alertByKey(t.db, `${workflowId}:park:1`);
    expect(park?.resolvedBy).toBe(CLOSED_ISSUE_EVENT_BY);
    expect(park?.body).toContain(CLOSED_ISSUE_ABANDON_REASON);
    await clearIdle(taskId);
  });

  it('已记 handled、放弃了 0 条的旧投递不再捞；每小时对账仍发 taskAbandon 把同一条工作流收掉', async () => {
    const { taskId, repo, workflowId } = await seed(false);
    const world = createFakeWorld();
    const { tasks: activities, calls } = scripted();
    const { client, signals } = watching();
    const handled = delivery(OLD_DELIVERY);
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input(taskId, repo));
        await h.signal(taskPauseSignal, { by: 'frank' });
        await statusUntil(h, (s) => s.phase === 'paused' && s.waiting?.kind === 'paused', '停进检查点');
        await waitListed(workflowId);
        const deps: ClosedIssueTaskDeps = {
          closedIssueTasks: portOf(client, async () => ({ state: 'closed', stateReason: null })),
          now: () => new Date('2026-10-18T00:00:00.000Z'),
          log: () => {},
        };
        const ledger = new Map<string, string | null>([[OLD_DELIVERY, ZERO_NOTE]]);
        expect(
          await runClosedIssueEvents({
            ...eventDeps(deps, []),
            pending: async () => (ledger.get(handled.deliveryId) === null ? [handled] : []),
          }),
        ).toBe(0);
        expect(signals).toEqual([]);
        expect(ledger.get(OLD_DELIVERY)).toBe(ZERO_NOTE);
        const part = await abandonClosedIssueTasks(deps);
        expect(part).toMatchObject({ found: 1, unchecked: [] });
        expect(signals.map((s) => s.name)).toEqual(['taskAbandon']);
        expect(signals[0]?.arg).toEqual({ by: CLOSED_ISSUE_ABANDON_BY, reason: CLOSED_ISSUE_ABANDON_REASON });
        return h.result() as Promise<TaskRun>;
      },
      { tasks: activities, wrapActivities: (acts) => mirror(acts) },
    );
    expect(run.outcome).toBe('abandoned');
    expect(calls.segment).toHaveLength(0);
    const rows = await t.db.select().from(tasks);
    expect(rows).toEqual([expect.objectContaining({ id: taskId, state: 'stopped', phase: 'abandoned' })]);
    expect((await alertByKey(t.db, `${workflowId}:park:1`))?.resolvedBy).toBe(CLOSED_ISSUE_ABANDON_BY);
    await clearIdle(taskId);
  });

  it('关单读到一半人点了继续：再确认后不发放弃，会话照常做完', async () => {
    const { taskId, repo, workflowId } = await seed(false);
    const world = createFakeWorld();
    const { tasks: activities, calls } = scripted();
    const { client, signals } = watching();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input(taskId, repo));
        await h.signal(taskPauseSignal, { by: 'frank' });
        await statusUntil(h, (s) => s.phase === 'paused', '停进检查点');
        await waitListed(workflowId);
        let reads = 0;
        const deps: ClosedIssueTaskDeps = {
          closedIssueTasks: portOf(client, async () => {
            reads += 1;
            if (reads === 1) {
              await h.signal(taskContinueSignal, { by: 'frank' });
              await statusUntil(h, (s) => s.phase !== 'paused', '已经继续');
            }
            return { state: 'closed', stateReason: null };
          }),
          now: () => new Date('2026-10-18T00:00:00.000Z'),
          log: () => {},
        };
        const part = await runClosedIssueEvents(eventDeps(deps, [delivery('fresh-closed')]));
        expect(part).toBe(1);
        expect(signals).toEqual([]);
        return h.result() as Promise<TaskRun>;
      },
      { tasks: activities, wrapActivities: (acts) => mirror(acts) },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment.length).toBeGreaterThan(0);
    expect(signals).toEqual([]);
  });

  it('软暂停还没到检查点、会话仍开着：不发放弃', async () => {
    const { taskId, repo, workflowId } = await seed(true);
    const world = createFakeWorld();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const segment = (_input: unknown, n: number, signal: AbortSignal): Promise<RunSegmentResult> => {
      if (n !== 1) return Promise.resolve(OK_SEGMENT);
      return new Promise((resolve) => {
        const finish = () => resolve(OK_SEGMENT);
        void gate.then(finish);
        signal.addEventListener('abort', () =>
          resolve({
            ok: false,
            runId: 'r',
            outcome: 'killed',
            evidence: { code: 'aborted', message: '被取消', quotaExhausted: false },
          }),
        );
      });
    };
    const { tasks: activities, calls } = scripted({ segment });
    const { client, signals } = watching();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input(taskId, repo));
        await waitUntil(() => calls.segment.length > 0, '会话在跑');
        await h.signal(taskPauseSignal, { by: 'frank', mode: 'soft' });
        await waitListed(workflowId);
        const status = await h.query(taskStatusQuery);
        expect(status.phase).not.toBe('paused');
        const deps: ClosedIssueTaskDeps = {
          closedIssueTasks: portOf(client, async () => ({ state: 'closed', stateReason: null })),
          now: () => new Date('2026-10-18T00:00:00.000Z'),
          log: () => {},
        };
        expect(await runClosedIssueEvents(eventDeps(deps, [delivery('fresh-closed')]))).toBe(1);
        expect(signals).toEqual([]);
        expect((await alertByKey(t.db, `${workflowId}:park:1`))?.resolvedAt).toBeNull();
        expect((await alertByKey(t.db, idleRunningAlertKey(taskId)))?.resolvedAt).toBeNull();
        release();
        await statusUntil(h, (s) => s.phase === 'paused', '这一段做完才停');
        expect(signals).toEqual([]);
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '收工' });
        await h.result();
      },
      { tasks: activities, wrapActivities: (acts) => mirror(acts) },
    );
    expect(signals).toEqual([]);
  });

  it('已经停在检查点但仍有开着的会话：不发放弃', async () => {
    const { taskId, repo, workflowId } = await seed(true);
    const world = createFakeWorld();
    const { tasks: activities } = scripted();
    const { client, signals } = watching();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input(taskId, repo));
        await h.signal(taskPauseSignal, { by: 'frank' });
        const status = await statusUntil(
          h,
          (s) => s.phase === 'paused' && s.waiting?.kind === 'paused',
          '停进检查点',
        );
        expect(status.waiting?.kind).toBe('paused');
        await waitListed(workflowId);
        const deps: ClosedIssueTaskDeps = {
          closedIssueTasks: portOf(client, async () => ({ state: 'closed', stateReason: null })),
          now: () => new Date('2026-10-18T00:00:00.000Z'),
          log: () => {},
        };
        expect(await runClosedIssueEvents(eventDeps(deps, [delivery('fresh-closed')]))).toBe(1);
        expect(signals).toEqual([]);
        expect((await h.query(taskStatusQuery)).phase).toBe('paused');
        expect((await alertByKey(t.db, idleRunningAlertKey(taskId)))?.resolvedAt).toBeNull();
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '收工' });
        expect((await h.result()) as TaskRun).toMatchObject({ outcome: 'abandoned' });
      },
      { tasks: activities, wrapActivities: (acts) => mirror(acts) },
    );
    expect(signals).toEqual([]);
  });
});
