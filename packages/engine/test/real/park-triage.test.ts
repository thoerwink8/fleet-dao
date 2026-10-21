// 法国指挥官会话的真装配（real/park-triage.ts，#3294 第 2 片）在库上的几样：设置开关怎么读、用途没配模型怎么认、
// 认领和执行的操作记录记在 engine:commander 名下、提醒带诊断文字、回合怎么读给空转判断。会话和 Temporal 不真连（另有 jobs 的假依赖测试）。
import {
  acceptanceDuties,
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
import { noteOnlyOptions } from '@fleet-dao/shared';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMMANDER_ACTOR } from '../../src/commander-contract.ts';
import { judgeSpin } from '../../src/decisions/spin.ts';
import {
  COMMANDER_AUDIT_ACT,
  COMMANDER_AUDIT_CLAIM,
  COMMANDER_AUDIT_RETRY,
  PARK_TRIAGE_JOB,
  type ParkTriageDeps,
  type ParkTriageItem,
  runParkTriageJob,
  triageParkedTasks,
} from '../../src/jobs/park-triage.ts';
import { ABANDON_WAIT_MS, COMMANDER_SETTING, parkTriageJob } from '../../src/real/park-triage.ts';
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

  it('commander:daily-cap：回到上限以下撤掉，没有这张卡时撤也不报错；执行记录带原文指纹', async () => {
    const d = deps();
    await d.resolveCapAlert();
    await d.notify({
      level: 'alert',
      key: 'commander:daily-cap',
      title: '到了上限',
      body: '等着的单……',
      taskId: null,
    });
    await d.resolveCapAlert();
    const card = (await t.db.select().from(notifications)).find((n) => n.dedupeKey === 'commander:daily-cap');
    expect(card).toMatchObject({ resolvedAt: NOW, resolvedBy: COMMANDER_ACTOR });
    const task = await seedTask();
    await d.audit({
      item: { ...itemOf(task.id), detailHash: 'abc123' },
      action: 'continue',
      reason: '测试',
      ok: true,
    });
    const act = (await t.db.select().from(auditLog)).find((a) => a.action === COMMANDER_AUDIT_ACT);
    expect(act?.after).toMatchObject({ ref: 'acme/app#7', detailHash: 'abc123' });
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

  it('留给人·掏新钱写成「要你拍」：选项和原因一起落库；会话没起成记 commander.retry（ok=false）', async () => {
    const task = await seedTask();
    const d = deps();
    await d.notify({
      level: 'decision',
      key: 'commander:task-acme-app-7:park:3',
      title: '要你拍：acme/app#7',
      body: '要掏新钱',
      taskId: task.id,
      options: noteOnlyOptions(),
      reason: 'new-money',
    });
    const [card] = await t.db.select().from(notifications);
    expect(card).toMatchObject({ level: 'decision', decisionReason: 'new-money' });
    expect(card?.decisionOptions).toHaveLength(2);
    const item = itemOf(task.id);
    await d.retry({ row: item.row, workflowId: item.workflowId, park: PARK, attempt: 1, why: '选不到路由' });
    const rows = (await t.db.select().from(auditLog)).filter((r) => r.action === COMMANDER_AUDIT_RETRY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: COMMANDER_ACTOR, ok: false });
    expect(rows[0]?.after).toMatchObject({ workflowId: 'task-acme-app-7', parkSeq: 3, attempt: 1 });
  });

  it('老历史认停在哪一次：读开着的、编号最大的停下提醒', async () => {
    const task = await seedTask();
    await deps().notify({
      level: 'alert',
      key: 'task-acme-app-7:park:2',
      title: '动手 3 轮都没过',
      body: '原文',
      taskId: task.id,
    });
    expect(await deps().openPark('task-acme-app-7')).toMatchObject({ seq: 2, title: '动手 3 轮都没过' });
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

  it('验收结清和 supersede 复用受管 store 的精确身份与代次核验', async () => {
    const task = await seedTask();
    const sourceHead = 'a'.repeat(40);
    const finalHead = 'b'.repeat(40);
    const [source] = await t.db
      .insert(acceptanceDuties)
      .values({
        taskId: task.id,
        repo: 'acme/app',
        issueNumber: 7,
        prNumber: 8,
        head: sourceHead,
        items: ['现场审计'],
        source: 'cold_verify',
        mergeCommit: null,
      })
      .returning();
    const [target] = await t.db
      .insert(acceptanceDuties)
      .values({
        taskId: task.id,
        repo: 'acme/app',
        issueNumber: 7,
        prNumber: 8,
        head: finalHead,
        items: ['现场审计'],
        source: 'cold_verify',
        mergeCommit: 'c'.repeat(40),
        settledAt: new Date(NOW.getTime() - 1_000),
        settledBy: 'cold-verify',
        settleEvidence: '最终头已验收',
      })
      .returning();
    if (!source || !target) throw new Error('验收责任没写进去');
    const d = deps();
    await expect(
      d.settleAcceptance?.({ task: {} as never, duty: source, evidence: '未合并' }),
    ).rejects.toThrow();
    await d.supersedeAcceptance?.({
      task: {} as never,
      source,
      target,
      evidence: '最终头覆盖旧头',
      coverage: [{ source: '现场审计', target: '现场审计', basis: '同一条责任' }],
    });
    const rows = await t.db.select().from(acceptanceDuties);
    expect(rows.find((row) => row.id === source.id)).toMatchObject({
      supersededBy: COMMANDER_ACTOR,
      successorId: target.id,
    });
  });

  const GEN1 = 'task:acme/app#7';
  const GEN2 = 'task:acme/app#7:r2';
  const TIMEOUT_WHY = `叫停 ${GEN1} 后还没停，没有另起`;
  const REDO_ANSWER = [
    '```json',
    JSON.stringify({
      summary: '看完了',
      verdicts: [{ issue: 7, parkSeq: 2, action: 'redo', reason: '理由：迟到终态之后再接续' }],
    }),
    '```',
  ].join('\n');

  function clockedTemporal() {
    let millis = NOW.getTime();
    let slept = 0;
    let onSleep: (() => Promise<void>) | null = null;
    const execs = new Map<string, { runId: string; status: string }>();
    execs.set(GEN1, { runId: 'run-1', status: 'RUNNING' });
    const signals: { id: string; reason: string }[] = [];
    const starts: Record<string, unknown>[] = [];
    const failDescribe = new Set<string>();
    let gen1Describes = 0;
    let terminalAfter = 0;
    let swapRunAfter = 0;
    let failGen1After = 0;
    let confirmFails = false;
    let confirmProbes = 0;
    const client = {
      connection: {
        withDeadline: async (_deadline: number, fn: () => Promise<unknown>) => fn(),
      },
      workflow: {
        async start(_type: string, options: Record<string, unknown>) {
          const workflowId = options.workflowId;
          if (typeof workflowId !== 'string') throw new Error('起工作流没有编号');
          if (execs.has(workflowId)) {
            throw new WorkflowExecutionAlreadyStartedError('already', workflowId, 'taskWorkflow');
          }
          starts.push(options);
          execs.set(workflowId, { runId: 'run-new', status: 'RUNNING' });
        },
        getHandle(id: string) {
          return {
            async describe() {
              if (failDescribe.has(id)) throw new Error('describe 失败');
              if (id === GEN1) {
                gen1Describes += 1;
                const row = execs.get(id);
                if (!row) throw new WorkflowNotFoundError('not found', id, undefined);
                if (swapRunAfter > 0 && gen1Describes >= swapRunAfter) {
                  row.runId = 'run-other';
                  row.status = 'TERMINATED';
                } else if (terminalAfter > 0 && gen1Describes >= terminalAfter) {
                  row.status = 'TERMINATED';
                }
                if (failGen1After > 0 && gen1Describes >= failGen1After) throw new Error('describe 失败');
                return { workflowId: id, runId: row.runId, status: { name: row.status } };
              }
              const row = execs.get(id);
              if (!row) throw new WorkflowNotFoundError('not found', id, undefined);
              if (confirmFails && id === GEN2) {
                confirmProbes += 1;
                if (confirmProbes === 1) throw new Error('describe 失败');
              }
              return { workflowId: id, runId: row.runId, status: { name: row.status } };
            },
            async signal(_definition: unknown, arg: { reason?: string }) {
              signals.push({ id, reason: arg.reason ?? '' });
            },
            async query() {
              return { phase: 'parked', prNumber: null };
            },
          };
        },
      },
    };
    return {
      now: () => new Date(millis),
      sleep: async (ms: number) => {
        await onSleep?.();
        slept += ms;
        millis += ms;
      },
      slept: () => slept,
      resetSlept: () => {
        slept = 0;
      },
      setOnSleep: (fn: (() => Promise<void>) | null) => {
        onSleep = fn;
      },
      execs,
      signals,
      starts,
      failDescribe,
      setTerminalAfter: (n: number) => {
        terminalAfter = n;
      },
      setSwapRunAfter: (n: number) => {
        swapRunAfter = n;
      },
      setFailGen1After: (n: number) => {
        failGen1After = n;
      },
      setConfirmFails: (on: boolean) => {
        confirmFails = on;
      },
      client,
    };
  }

  async function redoFollows() {
    const rows = await t.db.select().from(auditLog);
    return rows
      .flatMap((row) => {
        const follow = (
          row.after as {
            redoFollow?: { phase?: string; seq?: number; why?: string; identities?: { runId?: string }[] };
          } | null
        )?.redoFollow;
        if (!follow || typeof follow.seq !== 'number') return [];
        return [
          {
            phase: follow.phase,
            seq: follow.seq,
            why: follow.why,
            ok: row.ok,
            runId: follow.identities?.[0]?.runId,
          },
        ];
      })
      .sort((a, b) => a.seq - b.seq);
  }

  async function commanderNotice() {
    const rows = await t.db.select().from(notifications);
    return rows.find((n) => n.dedupeKey === `commander:${GEN1}:park:2`);
  }

  function schedule(
    world: ReturnType<typeof clockedTemporal>,
    taskId: string,
    sessions: unknown[],
    listed: boolean,
  ): ParkTriageDeps {
    const real = parkTriageJob({
      db: t.db,
      gh: {} as never,
      trees: {} as never,
      exec: {} as never,
      tmpDir: '/tmp/none',
      spawner: {} as never,
      pickRoute: (async () => ({ ok: false, detail: '测试里不选路' })) as never,
      sessions: {} as never,
      temporal: { use: async (fn) => fn(world.client as never) },
      taskQueue: 'fleet',
      now: world.now,
      sleep: world.sleep,
      log: () => {},
    })();
    return {
      ...real,
      purposeConfigured: async () => true,
      acceptanceTasks: async () => [],
      tasks: async () =>
        listed ? [{ taskId, owner: 'acme', name: 'app', issueNumber: 7, workflowId: GEN1 }] : [],
      status: async () => ({
        phase: 'parked',
        prNumber: null,
        park: {
          kind: 'rounds',
          seq: 2,
          at: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
          title: '轮数用尽',
          head: null,
          retriedBefore: false,
        },
      }),
      mainHead: async () => 'f'.repeat(40),
      runSession: async () => {
        sessions.push(REDO_ANSWER);
        return { ok: true, answer: REDO_ANSWER, model: 'grok-4.7' };
      },
      log: () => {},
    };
  }

  it(
    '叫停在现有 60 秒窗口内未终态：先记下未确认，标准调度在迟到终态后续起恰好一个新代',
    async () => {
      const task = await seedTask();
      const before = await t.db.select().from(tasks);
      const world = clockedTemporal();
      let firstSleep: { signals: number; starts: number; why: string | undefined } | null = null;
      world.setOnSleep(async () => {
        if (firstSleep) return;
        const rows = await redoFollows();
        firstSleep = { signals: world.signals.length, starts: world.starts.length, why: rows.at(-1)?.why };
      });
      const sessions: unknown[] = [];
      const began = world.now().getTime();
      const first = await triageParkedTasks(schedule(world, task.id, sessions, true));
      expect(ABANDON_WAIT_MS).toBe(60_000);
      expect(world.now().getTime() - began).toBe(60_000);
      expect(world.slept()).toBe(60_000);
      expect(firstSleep).toEqual({
        signals: 1,
        starts: 0,
        why: `叫停 ${GEN1} 已发送，终态未确认`,
      });
      expect(world.signals).toEqual([{ id: GEN1, reason: '指挥官判重做：先叫停停住的上一代' }]);
      expect(world.starts).toHaveLength(0);
      expect(sessions).toHaveLength(1);
      expect(first.acted).toEqual([]);
      const waiting = await commanderNotice();
      expect(waiting?.body).toContain('叫停已发送、终态未确认');
      expect(waiting?.body).toContain(TIMEOUT_WHY);
      expect(waiting?.body).not.toContain('任务没动');
      expect(waiting?.body).not.toContain('新代已确认启动');
      expect((await redoFollows()).at(-1)).toMatchObject({
        phase: 'stop_sent_unconfirmed',
        why: TIMEOUT_WHY,
        runId: 'run-1',
      });

      world.resetSlept();
      const duplicateSessions: unknown[] = [];
      const still = await triageParkedTasks(schedule(world, task.id, duplicateSessions, true));
      expect(world.slept()).toBe(0);
      expect(world.starts).toHaveLength(0);
      expect(world.signals).toHaveLength(1);
      expect(duplicateSessions).toHaveLength(0);
      expect(still.acted).toEqual([]);
      expect((await commanderNotice())?.body).toContain(TIMEOUT_WHY);
      expect((await commanderNotice())?.body).not.toContain('任务没动');

      const restartedSessions: unknown[] = [];
      const gen1 = world.execs.get(GEN1);
      if (!gen1) throw new Error('上一代不在假 Temporal 里');
      gen1.status = 'TERMINATED';
      const restarted = await triageParkedTasks(schedule(world, task.id, restartedSessions, false));
      expect(restartedSessions).toHaveLength(0);
      expect(world.slept()).toBe(0);
      expect(world.signals).toHaveLength(1);
      expect(world.starts).toHaveLength(1);
      expect(world.starts[0]).toMatchObject({
        workflowId: GEN2,
        workflowIdConflictPolicy: 'FAIL',
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        args: [expect.objectContaining({ issueNumber: 7, title: '给登录页加验证码', taskId: task.id })],
      });
      expect(restarted.acted).toEqual([{ ref: 'acme/app#7', action: 'redo', source: 'verdict' }]);
      const follows = await redoFollows();
      expect(follows.some((row) => row.phase === 'old_terminal_pending_start')).toBe(true);
      expect(follows.at(-1)).toMatchObject({ phase: 'started', why: TIMEOUT_WHY, ok: true, runId: 'run-1' });
      const done = await commanderNotice();
      expect(done?.level).toBe('daily');
      expect(done?.body).toContain('新代已确认启动');
      expect(done?.body).toContain(GEN2);
      expect(done?.body).toContain(`先前的失败仍在：${TIMEOUT_WHY}`);
      expect(done?.body).not.toContain('任务没动');

      const thirdSessions: unknown[] = [];
      const third = await triageParkedTasks(schedule(world, task.id, thirdSessions, false));
      expect(third.acted).toEqual([]);
      expect(thirdSessions).toHaveLength(0);
      expect(world.starts).toHaveLength(1);
      expect(world.signals).toHaveLength(1);
      expect(await t.db.select().from(tasks)).toEqual(before);
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '窗口内旧代先到终态：同一次调用就另起，虚拟时间远小于 60 秒',
    async () => {
      const task = await seedTask();
      const world = clockedTemporal();
      world.setTerminalAfter(3);
      const sessions: unknown[] = [];
      const began = world.now().getTime();
      const out = await triageParkedTasks(schedule(world, task.id, sessions, true));
      expect(world.now().getTime() - began).toBe(200);
      expect(world.slept()).toBe(200);
      expect(world.signals).toHaveLength(1);
      expect(world.starts).toHaveLength(1);
      expect(out.acted).toEqual([{ ref: 'acme/app#7', action: 'redo', source: 'verdict' }]);
      expect((await commanderNotice())?.body).toContain('新代已确认启动');
      expect((await commanderNotice())?.body).not.toContain('任务没动');
      const again: unknown[] = [];
      await triageParkedTasks(schedule(world, task.id, again, false));
      expect(world.starts).toHaveLength(1);
      expect(again).toHaveLength(0);
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '等待中执行身份变了，或 describe 失败：不把未知当成终态，不另起',
    async () => {
      const swappedTask = await seedTask();
      const swapped = clockedTemporal();
      swapped.setSwapRunAfter(3);
      const swappedSessions: unknown[] = [];
      await triageParkedTasks(schedule(swapped, swappedTask.id, swappedSessions, true));
      expect(swapped.slept()).toBe(200);
      expect(swapped.starts).toHaveLength(0);
      expect(swapped.signals).toHaveLength(1);
      const swappedNotice = await commanderNotice();
      expect(swappedNotice?.body).toContain('执行身份变了');
      expect(swappedNotice?.body).toContain('run-1');
      expect(swappedNotice?.body).toContain('run-other');
      expect(swappedNotice?.body).toContain('叫停已发送、终态未确认');
      expect(swappedNotice?.body).not.toContain('新代已确认启动');
      expect(swappedNotice?.body).not.toContain('任务没动');

      await resetTestDb(t);
      await registerScheduledJobs(t.db, [PARK_TRIAGE_JOB]);
      const unknownTask = await seedTask();
      const unknown = clockedTemporal();
      unknown.setFailGen1After(2);
      const began = unknown.now().getTime();
      const unknownSessions: unknown[] = [];
      const missed = await triageParkedTasks(schedule(unknown, unknownTask.id, unknownSessions, true));
      expect(unknown.now().getTime() - began).toBe(60_000);
      expect(unknown.starts).toHaveLength(0);
      expect(unknown.signals).toHaveLength(1);
      expect(missed.acted).toEqual([]);
      const unknownNotice = await commanderNotice();
      expect(unknownNotice?.body).toContain(TIMEOUT_WHY);
      expect(unknownNotice?.body).toContain('叫停已发送、终态未确认');
      expect(unknownNotice?.body).not.toContain('新代已确认启动');
      expect(unknownNotice?.body).not.toContain('任务没动');
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '迟到之后仍在跑、查不到、身份变了或新代已在：接续拒绝且不再叫停',
    async () => {
      const task = await seedTask();
      const world = clockedTemporal();
      const sessions: unknown[] = [];
      await triageParkedTasks(schedule(world, task.id, sessions, true));
      expect(world.slept()).toBe(60_000);
      world.resetSlept();

      const runningSessions: unknown[] = [];
      const running = await triageParkedTasks(schedule(world, task.id, runningSessions, false));
      expect(world.slept()).toBe(0);
      expect(world.starts).toHaveLength(0);
      expect(world.signals).toHaveLength(1);
      expect(running.left[0]?.why).toContain('叫停已发送、终态未确认');
      expect(running.left[0]?.why).toContain(TIMEOUT_WHY);
      expect(running.acted).toEqual([]);

      world.failDescribe.add(GEN1);
      const missedSessions: unknown[] = [];
      const missed = await triageParkedTasks(schedule(world, task.id, missedSessions, false));
      expect(missed.problems.join('\n')).toContain('查不到上一代是不是还在跑');
      expect(missed.left[0]?.why).not.toContain('新代已确认启动');
      expect(world.starts).toHaveLength(0);
      expect(world.signals).toHaveLength(1);
      world.failDescribe.delete(GEN1);

      const gen1 = world.execs.get(GEN1);
      if (!gen1) throw new Error('上一代不在假 Temporal 里');
      gen1.runId = 'run-other';
      gen1.status = 'TERMINATED';
      const changedSessions: unknown[] = [];
      const changed = await triageParkedTasks(schedule(world, task.id, changedSessions, false));
      expect(changed.left[0]?.why).toContain('执行身份变了');
      expect(changed.left[0]?.why).toContain('run-1');
      expect(changed.left[0]?.why).toContain('run-other');
      expect(changed.left[0]?.why).toContain(`原失败：${TIMEOUT_WHY}`);
      expect(world.starts).toHaveLength(0);
      expect(world.signals).toHaveLength(1);
      // 身份变了不会再变回来：下一轮不再沿这条意图另起，提醒留着。
      gen1.runId = 'run-1';
      const afterChangedSessions: unknown[] = [];
      const afterChanged = await triageParkedTasks(schedule(world, task.id, afterChangedSessions, false));
      expect(afterChanged.acted).toEqual([]);
      expect(afterChangedSessions).toHaveLength(0);
      expect(world.starts).toHaveLength(0);
      expect(world.signals).toHaveLength(1);
      expect((await commanderNotice())?.body).toContain('执行身份变了');

      await resetTestDb(t);
      await registerScheduledJobs(t.db, [PARK_TRIAGE_JOB]);
      const occupiedTask = await seedTask();
      const occupiedWorld = clockedTemporal();
      await triageParkedTasks(schedule(occupiedWorld, occupiedTask.id, [], true));
      const occupiedGen1 = occupiedWorld.execs.get(GEN1);
      if (!occupiedGen1) throw new Error('上一代不在假 Temporal 里');
      occupiedGen1.status = 'TERMINATED';
      occupiedWorld.execs.set(GEN2, { runId: 'run-x', status: 'RUNNING' });
      const occupiedSessions: unknown[] = [];
      const occupied = await triageParkedTasks(
        schedule(occupiedWorld, occupiedTask.id, occupiedSessions, false),
      );
      expect(occupied.left[0]?.why).toContain('旧代已终态、新代启动失败');
      expect(occupied.left[0]?.why).toContain('已经有记录');
      expect(occupied.left[0]?.why).toContain(`原失败：${TIMEOUT_WHY}`);
      expect(occupied.left[0]?.why).not.toContain('新代已确认启动');
      expect(occupiedWorld.starts).toHaveLength(0);
      expect(occupiedWorld.signals).toHaveLength(1);
      expect(runningSessions).toHaveLength(0);
      expect(missedSessions).toHaveLength(0);
      expect(changedSessions).toHaveLength(0);
      expect(occupiedSessions).toHaveLength(0);
    },
    TEST_DB_TIMEOUT_MS,
  );

  it(
    '新代请求已提交但 describe 没确认到执行：不算重做完成，下一轮也不再起一次',
    async () => {
      const task = await seedTask();
      const world = clockedTemporal();
      world.setTerminalAfter(3);
      world.setConfirmFails(true);
      const sessions: unknown[] = [];
      const first = await triageParkedTasks(schedule(world, task.id, sessions, true));
      expect(world.starts).toHaveLength(1);
      expect(first.acted).toEqual([]);
      const notice = await commanderNotice();
      expect(notice?.body).toContain('旧代已终态、新代启动失败');
      expect(notice?.body).toContain(`新代 ${GEN2} 没有确认到执行，不算重做完成`);
      expect(notice?.body).not.toContain('新代已确认启动');
      expect(notice?.body).not.toContain('任务没动');
      expect((await redoFollows()).some((row) => row.phase === 'old_terminal_pending_start')).toBe(true);

      const again: unknown[] = [];
      const second = await triageParkedTasks(schedule(world, task.id, again, false));
      expect(world.starts).toHaveLength(1);
      expect(world.signals).toHaveLength(1);
      expect(second.acted).toEqual([]);
      expect(again).toHaveLength(0);
      expect((await commanderNotice())?.body).toContain('已经有记录');
      expect((await commanderNotice())?.body).not.toContain('新代已确认启动');
    },
    TEST_DB_TIMEOUT_MS,
  );
});
