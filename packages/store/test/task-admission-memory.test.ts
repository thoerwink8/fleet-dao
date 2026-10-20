import { describe, expect, it } from 'vitest';
import { IDS } from '../src/dev-fixtures.ts';
import { createMemoryStore, emptyData } from '../src/memory-store.ts';
import { memoryTaskAdmission } from '../src/task-admission-memory.ts';
import { admissionSeed, birthInput, legacyInput, requiredAdmissionTask } from './task-admission-contract.ts';
import { EXECUTION_TIME, executionAudit } from './task-execution-contract.ts';

describe('准入Memory提交与通知边界', () => {
  for (const failures of [['tasks'], ['audit_log'], ['tasks', 'audit_log']])
    it(`出生通知${failures.join('+')}失败保留真实提交且继续其它通知`, async () => {
      const seen: { table: string; id: string }[] = [];
      const store = createMemoryStore(admissionSeed(), {
        now: () => EXECUTION_TIME,
        onChange: (table, id) => {
          seen.push({ table, id });
          if (failures.includes(table)) throw new Error('private observer error');
        },
      });
      const input = birthInput();
      const result = await store.createManagedTaskFromIssue(input, executionAudit);
      if (result.kind !== 'created') throw new Error('出生失败');
      expect(seen.map((s) => s.table)).toEqual(['tasks', 'audit_log']);
      expect(result.postCommitWarnings).toEqual(
        seen.filter((s) => failures.includes(s.table)).map((s) => ({ code: 'notification_failed', ...s })),
      );
      expect(JSON.stringify(result.postCommitWarnings)).not.toContain('private observer');
      expect(store.data.tasks.filter((t) => t.id === input.task.id)).toHaveLength(1);
      expect(store.data.executionControls.size).toBe(1);
      expect(store.data.executionBirths.size).toBe(1);
      expect(store.data.audit).toHaveLength(1);
      expect(await store.createManagedTaskFromIssue(input, executionAudit)).toMatchObject({
        kind: 'replayed',
        postCommitWarnings: [],
      });
      expect(seen).toHaveLength(2);
      expect(store.data.audit).toHaveLength(1);
    });
  it('legacy通知失败保留责任，重送不重通知/审计', async () => {
    const seen: string[] = [];
    const store = createMemoryStore(admissionSeed(), {
      now: () => EXECUTION_TIME,
      onChange: (table) => {
        seen.push(table);
        throw new Error('observer');
      },
    });
    const input = legacyInput(requiredAdmissionTask(store.data.tasks.find((t) => t.id === IDS.task12)));
    expect(await store.admitLegacyExecution(input, executionAudit)).toMatchObject({
      kind: 'admitted',
      postCommitWarnings: [{ code: 'notification_failed', table: 'audit_log' }],
    });
    expect(await store.admitLegacyExecution(input, executionAudit)).toMatchObject({
      kind: 'replayed',
      postCommitWarnings: [],
    });
    expect(store.data.legacyExecutionAdmissions.size).toBe(1);
    expect(store.data.audit).toHaveLength(1);
    expect(seen).toEqual(['audit_log']);
  });
  for (const failure of ['clock', 'state_id', 'audit_id', 'audit'] as const)
    it(`出生提交前${failure}失败全无变更`, async () => {
      const data = { ...emptyData(), ...admissionSeed() };
      const before = structuredClone(data);
      let ids = 0;
      const store = memoryTaskAdmission(
        data,
        () => {
          if (failure === 'clock') throw new Error('clock');
          return EXECUTION_TIME;
        },
        () => {
          ids++;
          if ((failure === 'state_id' && ids === 1) || (failure === 'audit_id' && ids === 2))
            throw new Error('id');
          return String(ids);
        },
        () => {
          throw new Error('must not notify');
        },
      );
      await expect(
        store.createManagedTaskFromIssue(
          birthInput(),
          failure === 'audit' ? ({ ...executionAudit, via: 'invalid' } as never) : executionAudit,
        ),
      ).rejects.toThrow();
      expect(data).toEqual(before);
    });
  it('legacy提交前audit id失败无责任行/审计', async () => {
    const data = { ...emptyData(), ...admissionSeed() };
    const before = structuredClone(data);
    const store = memoryTaskAdmission(
      data,
      () => EXECUTION_TIME,
      () => {
        throw new Error('id');
      },
      () => {
        throw new Error('must not notify');
      },
    );
    await expect(
      store.admitLegacyExecution(
        legacyInput(requiredAdmissionTask(data.tasks.find((t) => t.id === IDS.task12))),
        executionAudit,
      ),
    ).rejects.toThrow('id');
    expect(data).toEqual(before);
  });
});
