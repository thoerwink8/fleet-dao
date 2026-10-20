// 法国指挥官会话的真装配（real/park-triage.ts，#3294 第 2 片）在库上的几样：设置开关怎么读、用途没配模型怎么认、
// 认领和执行的操作记录记在 engine:commander 名下、提醒带诊断文字、回合怎么读给空转判断。会话和 Temporal 不真连（另有 jobs 的假依赖测试）。
import {
  auditLog,
  families,
  models,
  notifications,
  registerScheduledJobs,
  repos,
  routingPurposeModels,
  settings,
  taskRounds,
  tasks,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { WorkflowNotFoundError } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMMANDER_ACTOR } from '../../src/commander-contract.ts';
import { judgeSpin } from '../../src/decisions/spin.ts';
import {
  COMMANDER_AUDIT_ACT,
  COMMANDER_AUDIT_CLAIM,
  PARK_TRIAGE_JOB,
  type ParkTriageItem,
  runParkTriageJob,
} from '../../src/jobs/park-triage.ts';
import { COMMANDER_SETTING, parkTriageJob } from '../../src/real/park-triage.ts';
import type { TaskParkInfo } from '../../src/task-contract.ts';

const NOW = new Date('2026-10-19T12:00:00Z');
const PARK: TaskParkInfo = {
  kind: 'quota',
  seq: 3,
  at: NOW.toISOString(),
  title: 'token 额度超预算',
  head: null,
  retriedBefore: false,
};

describe('real/park-triage', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, TEST_DB_TIMEOUT_MS);
  afterAll(() => t.close());
  beforeEach(async () => {
    await resetTestDb(t);
    await registerScheduledJobs(t.db, [PARK_TRIAGE_JOB]);
  });

  const deps = () =>
    parkTriageJob({
      db: t.db,
      gh: {} as never,
      trees: {} as never,
      exec: {} as never,
      tmpDir: '/tmp/none',
      spawner: {} as never,
      pickRoute: (async () => ({ ok: false, detail: '测试里不选路' })) as never,
      sessions: {} as never,
      temporal: { use: async () => Promise.reject(new Error('测试里不连 Temporal')) },
      taskQueue: 'fleet',
      now: () => NOW,
      log: () => {},
    })();

  async function seedTask() {
    const [repo] = await t.db
      .insert(repos)
      .values({ owner: 'acme', name: 'app', testCommand: 'pnpm check' })
      .returning();
    if (!repo) throw new Error('仓没写进去');
    const [task] = await t.db
      .insert(tasks)
      .values({
        repoId: repo.id,
        issueNumber: 7,
        title: '给登录页加验证码',
        rawRequest: '加验证码',
        requestedBy: 'founder-a',
        priority: 10,
        state: 'stalled',
      })
      .returning();
    if (!task) throw new Error('任务没写进去');
    return task;
  }

  const itemOf = (taskId: string): ParkTriageItem => ({
    row: { taskId, owner: 'acme', name: 'app', issueNumber: 7, workflowId: 'task-acme-app-7' },
    workflowId: 'task-acme-app-7',
    park: PARK,
    handoff: false,
    detail: null,
    rounds: [],
    spin: null,
  });

  it('开关：没设过算开；false 关；认不出的值按关并说明', async () => {
    expect(await deps().enabled()).toEqual({ on: true });
    await t.db.insert(settings).values({ key: COMMANDER_SETTING, value: false });
    expect(await deps().enabled()).toMatchObject({ on: false });
    await t.db.delete(settings);
    await t.db.insert(settings).values({ key: COMMANDER_SETTING, value: true });
    expect(await deps().enabled()).toEqual({ on: true });
    await t.db.delete(settings);
    await t.db.insert(settings).values({ key: COMMANDER_SETTING, value: 'maybe' });
    const unknown = await deps().enabled();
    expect(unknown.on).toBe(false);
    expect(!unknown.on && unknown.why).toContain('认不出');
  });

  it('用途 commander 下一个模型都没有：认成没配模型', async () => {
    expect(await deps().purposeConfigured()).toBe(false);
  });

  async function configureModelWithoutRoute() {
    await t.db.insert(families).values({ id: 'test-family', displayName: '测试', vendor: 'test' });
    await t.db.insert(models).values({ id: 'test-model', family: 'test-family', displayName: '测试模型' });
    await t.db
      .insert(routingPurposeModels)
      .values({ purpose: 'commander', modelId: 'test-model', position: 0 });
  }

  it('任务入口空→非空→重复：只撤缺模型卡、保留原文，审计幂等；没有活路由也只证明配置恢复', async () => {
    const d = deps();
    expect((await runParkTriageJob(d)).outcome).toBe('partial');
    await d.notify({
      level: 'alert',
      key: 'commander:other',
      title: '其它故障',
      body: '原故障证据',
      taskId: null,
    });
    const before = await t.db.select().from(notifications);
    const oldCard = before.find((n) => n.dedupeKey === 'commander:no-model');
    expect(oldCard?.resolvedAt).toBeNull();
    await configureModelWithoutRoute();
    expect(await d.purposeConfigured()).toBe(true);
    expect((await runParkTriageJob(d)).outcome).toBe('ok');
    const once = await t.db.select().from(notifications);
    const resolved = once.find((n) => n.dedupeKey === 'commander:no-model');
    expect(resolved).toMatchObject({ id: oldCard?.id, resolvedAt: NOW, resolvedBy: COMMANDER_ACTOR });
    expect(resolved?.body).toContain(oldCard?.body ?? '旧正文丢失');
    expect(resolved?.body).toContain('调用是否恢复仍待验证');
    expect(once.find((n) => n.dedupeKey === 'commander:other')).toEqual(
      before.find((n) => n.dedupeKey === 'commander:other'),
    );
    expect((await runParkTriageJob(d)).outcome).toBe('ok');
    expect(await t.db.select().from(notifications)).toEqual(once);
    const audits = (await t.db.select().from(auditLog)).filter((a) => a.action === 'notification.resolve');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      target: `notification:${oldCard?.id}`,
      actorKind: 'engine',
      actorId: COMMANDER_ACTOR,
      at: NOW,
      reason: expect.stringContaining('调用是否恢复仍待验证'),
    });
  });

  it('用途已配但没有旧卡：不创建故障卡、不补造解除审计', async () => {
    await configureModelWithoutRoute();
    expect((await runParkTriageJob(deps())).outcome).toBe('ok');
    expect(await t.db.select().from(notifications)).toHaveLength(0);
    expect(
      (await t.db.select().from(auditLog)).filter((a) => a.action === 'notification.resolve'),
    ).toHaveLength(0);
  });

  it('认领和执行的操作记录都记在 engine:commander 名下；认领带工作流编号和停下编号', async () => {
    const task = await seedTask();
    const item = itemOf(task.id);
    const d = deps();
    await d.claim({
      row: item.row,
      workflowId: item.workflowId,
      park: PARK,
      requestId: 'park-triage:acme/app:1',
    });
    await d.audit({ item, action: 'continue', reason: '指挥官判继续（引擎核对放行）', ok: true });
    await d.audit({ item, action: 'redo', reason: '重做', ok: false, error: '上一代还在跑' });
    const rows = (await t.db.select().from(auditLog)).filter((r) => r.target === 'commander');
    expect(rows.map((r) => [r.action, r.actorId, r.actorKind, r.ok])).toEqual([
      [COMMANDER_AUDIT_CLAIM, COMMANDER_ACTOR, 'engine', true],
      [COMMANDER_AUDIT_ACT, COMMANDER_ACTOR, 'engine', true],
      [COMMANDER_AUDIT_ACT, COMMANDER_ACTOR, 'engine', false],
    ]);
    expect(rows[0]?.after).toMatchObject({ workflowId: 'task-acme-app-7', parkSeq: 3, kind: 'quota' });
    expect(rows[1]?.after).toMatchObject({ action: 'continue', parkSeq: 3 });
    // 认领读得回来（jobs 靠它判同一次停下处理过没有）
    const back = await d.audits(new Date(NOW.getTime() - 3_600_000));
    expect(back.filter((a) => a.action === COMMANDER_AUDIT_CLAIM)).toHaveLength(1);
  });

  it('提醒经 upsertAlert 落库：诊断文字在正文里，挂在这张任务上', async () => {
    const task = await seedTask();
    await deps().notify({
      level: 'alert',
      key: 'commander:task-acme-app-7:park:3',
      title: '指挥官看了 acme/app#7，留给人处理',
      body: '指挥官（grok-4.7）看了 acme/app#7。\n理由：同一个命令反复失败',
      taskId: task.id,
    });
    const [row] = await t.db.select().from(notifications);
    expect(row?.body).toContain('同一个命令反复失败');
    expect(row?.taskId).toBe(task.id);
  });

  it('回合读给空转判断：旧的在前，没有收场的回合回空数组', async () => {
    const task = await seedTask();
    expect(await deps().rounds(task.id)).toEqual([]);
    for (const [seq, outcome] of [
      [1, 'ci_red'],
      [2, 'ci_red'],
      [3, 'ci_red'],
    ] as const) {
      await t.db.insert(taskRounds).values({
        taskId: task.id,
        workflowId: 'task-acme-app-7',
        seq,
        round: seq,
        outcome,
        addedLines: 50,
        endedAt: new Date(NOW.getTime() + seq * 60_000),
      });
    }
    const rounds = await deps().rounds(task.id);
    expect(rounds).toHaveLength(3);
    expect(judgeSpin(rounds ?? []).spinning).toBe(true);
  });

  /** 替身 Temporal：第一代已结束；start 按 startFails 抛错或起成。 */
  function redoDeps(startFails?: Error) {
    const starts: string[] = [];
    const existing = new Set(['task:acme/app#7']);
    const client = {
      connection: { withDeadline: async (_at: number, fn: () => Promise<unknown>) => fn() },
      workflow: {
        getHandle(id: string) {
          return {
            async describe() {
              if (!existing.has(id)) throw new WorkflowNotFoundError('not found', id, undefined);
              return { status: { name: 'COMPLETED' } };
            },
          };
        },
        async start(_type: string, options: { workflowId: string }) {
          starts.push(options.workflowId);
          if (startFails) throw startFails;
          existing.add(options.workflowId);
          return {};
        },
      },
    };
    const job = parkTriageJob({
      db: t.db,
      gh: {} as never,
      trees: {} as never,
      exec: {} as never,
      tmpDir: '/tmp/none',
      spawner: {} as never,
      pickRoute: (async () => ({ ok: false, detail: '测试里不选路' })) as never,
      sessions: {} as never,
      temporal: { use: async (fn) => fn(client as never) },
      taskQueue: 'fleet',
      now: () => NOW,
      log: () => {},
    })();
    return { job, starts };
  }

  const startActions = async (taskId: string) =>
    (await t.db.select().from(auditLog))
      .filter((a) => a.target === `task:${taskId}` && a.action.startsWith('task.start-'))
      .sort((a, b) => a.id - b.id)
      .map((a) => [a.action, a.actorId]);

  it('指挥官重做走受管起代栅栏：落意图、绑目标、起成再结算；已被纠正成 done 的不起', async () => {
    const task = await seedTask();
    const ok = redoDeps();
    expect(await ok.job.redoTask(itemOf(task.id).row, 'task:acme/app#7')).toEqual({
      ok: true,
      workflowId: 'task:acme/app#7:r2',
      generation: 2,
    });
    expect(ok.starts).toEqual(['task:acme/app#7:r2']);
    expect(await startActions(task.id)).toEqual([
      ['task.start-intent', COMMANDER_ACTOR],
      ['task.start-target', COMMANDER_ACTOR],
      ['task.start-settled', COMMANDER_ACTOR],
    ]);

    await t.db.update(tasks).set({ state: 'done' });
    const done = redoDeps();
    const refused = await done.job.redoTask(itemOf(task.id).row, 'task:acme/app#7');
    expect(refused.ok).toBe(false);
    expect(done.starts).toEqual([]);
  });

  it('指挥官重做起代超时：结果未知，意图挂着不结算（受管纠正一直拒绝）', async () => {
    const task = await seedTask();
    const timeout = redoDeps(Object.assign(new Error('4 DEADLINE_EXCEEDED'), { code: 4 }));
    await expect(timeout.job.redoTask(itemOf(task.id).row, 'task:acme/app#7')).rejects.toThrow(
      'DEADLINE_EXCEEDED',
    );
    expect((await startActions(task.id)).map(([action]) => action)).toEqual([
      'task.start-intent',
      'task.start-target',
    ]);
  });
});
