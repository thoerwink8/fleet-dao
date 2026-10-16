// 全程模式记账（#2823）：task_flow_assignments 每张单最多一行（写一次、读）、tasks.flow_mode、task_rounds 的 flow_mode 和
// verify_reject_class。PGlite 跑真迁移。
import { FlowAssignmentExistsError } from '@fleet-dao/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getFlowAssignment, recordFlowAssignment } from '../src/queries/flow-assignments.ts';
import { recordTaskRound } from '../src/queries/pipeline-health.ts';
import { taskFlowAssignments, taskRounds, tasks } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addTask, expectViolation } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(() => resetTestDb(t));

const AT = new Date('2026-10-16T12:00:00.000Z');

describe('task_flow_assignments：每张单一行，写一次', () => {
  it('没分过组：读回 null', async () => {
    const r = await addRepo(t.db);
    const task = await addTask(t.db, r.id);
    expect(await getFlowAssignment(t.db, task.id)).toBeNull();
    expect(await getFlowAssignment(t.db, 'not-a-uuid')).toBeNull();
  });

  it('写进去再读回，字段原样（reason 可空）', async () => {
    const r = await addRepo(t.db);
    const task = await addTask(t.db, r.id);
    const written = await recordFlowAssignment(t.db, {
      taskId: task.id,
      mode: 'full',
      source: 'hash',
      stratum: 'medium',
      assignedAt: AT,
    });
    expect(written).toEqual({
      taskId: task.id,
      mode: 'full',
      source: 'hash',
      stratum: 'medium',
      assignedAt: AT.toISOString(),
      reason: null,
    });
    expect(await getFlowAssignment(t.db, task.id)).toEqual(written);
  });

  it('不合格退回三段：带原因', async () => {
    const r = await addRepo(t.db);
    const task = await addTask(t.db, r.id);
    const written = await recordFlowAssignment(t.db, {
      taskId: task.id,
      mode: 'three',
      source: 'ineligible',
      stratum: 'heavyweight',
      reason: '改到标准路径',
    });
    expect(written.reason).toBe('改到标准路径');
    expect(written.mode).toBe('three');
  });

  it('同一张单写第二次直接报错，不覆盖', async () => {
    const r = await addRepo(t.db);
    const task = await addTask(t.db, r.id);
    await recordFlowAssignment(t.db, { taskId: task.id, mode: 'full', source: 'label', stratum: 'fast' });
    await expect(
      recordFlowAssignment(t.db, { taskId: task.id, mode: 'three', source: 'hash', stratum: 'fast' }),
    ).rejects.toBeInstanceOf(FlowAssignmentExistsError);
    const kept = await getFlowAssignment(t.db, task.id);
    expect(kept?.mode).toBe('full');
    expect(kept?.source).toBe('label');
    expect(await t.db.select().from(taskFlowAssignments)).toHaveLength(1);
  });

  it('库里的约束：模式、来源只收名单内的；task_id 唯一；单要存在', async () => {
    const r = await addRepo(t.db);
    const task = await addTask(t.db, r.id);
    const base = { taskId: task.id, mode: 'full', source: 'label', stratum: 'fast' } as const;
    await expectViolation(
      t.db.insert(taskFlowAssignments).values({ ...base, mode: 'half' as never }),
      'task_flow_assignments_mode_known',
    );
    await expectViolation(
      t.db.insert(taskFlowAssignments).values({ ...base, source: 'dice' as never }),
      'task_flow_assignments_source_known',
    );
    await t.db.insert(taskFlowAssignments).values(base);
    await expectViolation(t.db.insert(taskFlowAssignments).values(base), 'task_flow_assignments_pkey');
    await expectViolation(
      t.db.insert(taskFlowAssignments).values({ ...base, taskId: '00000000-0000-4000-8000-000000000000' }),
      'task_flow_assignments_task_id_tasks_id_fk',
    );
  });
});

describe('tasks.flow_mode', () => {
  it('老单为空；只收 three / full', async () => {
    const r = await addRepo(t.db);
    const task = await addTask(t.db, r.id);
    expect(task.flowMode).toBeNull();
    await t.db.update(tasks).set({ flowMode: 'full' }).where(eq(tasks.id, task.id));
    expect((await t.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]?.flowMode).toBe('full');
    await expectViolation(
      t.db
        .update(tasks)
        .set({ flowMode: 'split' as never })
        .where(eq(tasks.id, task.id)),
      'tasks_flow_mode_known',
    );
  });
});

describe('task_rounds：flow_mode、verify_reject_class', () => {
  it('不带就是空（老行、老写法不变）', async () => {
    const r = await addRepo(t.db);
    const task = await addTask(t.db, r.id);
    await recordTaskRound(t.db, { taskId: task.id, workflowId: 'wf-1', seq: 1, round: 1, outcome: 'ci_red' });
    const [row] = await t.db.select().from(taskRounds);
    expect(row?.flowMode).toBeNull();
    expect(row?.verifyRejectClass).toBeNull();
  });

  it('recordTaskRound 带上就写进去；四种拒绝分类都写得进', async () => {
    const r = await addRepo(t.db);
    const task = await addTask(t.db, r.id);
    const classes = ['real_defect', 'verifier_false_reject', 'incomplete_spec', 'infra'] as const;
    for (const [i, verifyRejectClass] of classes.entries()) {
      await recordTaskRound(t.db, {
        taskId: task.id,
        workflowId: 'wf-1',
        seq: i + 1,
        round: i + 1,
        outcome: 'verify_rejected',
        flowMode: 'full',
        verifyRejectClass,
      });
    }
    const rows = await t.db.select().from(taskRounds).orderBy(taskRounds.seq);
    expect(rows.map((x) => x.verifyRejectClass)).toEqual([...classes]);
    expect(rows.every((x) => x.flowMode === 'full')).toBe(true);
  });

  it('库里的约束挡名单外的值；认不出的拒绝分类在写之前就拒', async () => {
    const r = await addRepo(t.db);
    const task = await addTask(t.db, r.id);
    const row = { taskId: task.id, workflowId: 'wf-1', seq: 1, round: 1, outcome: 'merged' as const };
    await expectViolation(
      t.db.insert(taskRounds).values({ ...row, flowMode: 'half' as never }),
      'task_rounds_flow_mode_known',
    );
    await expectViolation(
      t.db.insert(taskRounds).values({ ...row, verifyRejectClass: 'bad' as never }),
      'task_rounds_verify_reject_class_known',
    );
    await expect(recordTaskRound(t.db, { ...row, verifyRejectClass: 'bad' as never })).rejects.toThrow(
      '认不出',
    );
    await expect(recordTaskRound(t.db, { ...row, flowMode: 'half' as never })).rejects.toThrow('认不出');
  });
});
