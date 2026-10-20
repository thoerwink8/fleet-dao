import { randomUUID } from 'node:crypto';
import type { Task } from '@fleet-dao/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDS } from '../src/dev-fixtures.ts';
import type { Store } from '../src/ports.ts';
import { canonicalExecutionInput, executionInputHash } from '../src/task-admission-logic.ts';
import type { LegacyExecutionIdentityV1, ManagedTaskBirthV1 } from '../src/task-execution.ts';
import { executionAudit, executionSeed } from './task-execution-contract.ts';

export const admissionSeed = () => executionSeed(null);
export function requiredAdmissionTask(task: Task | null | undefined): Task {
  if (!task) throw new Error('缺少准入测试任务夹具');
  return task;
}
export const birthInput = (over: Partial<ManagedTaskBirthV1> = {}): ManagedTaskBirthV1 => ({
  protocolVersion: 1,
  birthRequestId: randomUUID(),
  coverageEpoch: randomUUID(),
  task: {
    id: randomUUID(),
    repoId: IDS.repo,
    issueNumber: 900,
    title: '出生',
    rawRequest: '  私有原文\n',
    requestedBy: IDS.founderA,
  },
  namespace: 'test',
  workflowType: 'taskWorkflow',
  taskQueue: 'test-execution-v1',
  ...over,
});
export function legacyInput(
  task: Pick<Task, 'id' | 'repoId' | 'issueNumber'>,
  over: Partial<LegacyExecutionIdentityV1> = {},
  body: Record<string, unknown> = {},
): LegacyExecutionIdentityV1 {
  const generation = over.generation ?? 1;
  const inputCanonical = canonicalExecutionInput({
    schemaVersion: 1,
    taskId: task.id,
    repo: { id: task.repoId, owner: 'example', name: 'canary' },
    issueNumber: task.issueNumber,
    title: '原始 Start 标题',
    ...body,
  });
  return {
    schemaVersion: 1,
    taskId: task.id,
    namespace: 'test',
    workflowId: `task:example/canary#${task.issueNumber}${generation === 1 ? '' : `:r${generation}`}`,
    runId: randomUUID(),
    workflowType: 'taskWorkflow',
    taskQueue: 'legacy',
    generation,
    inputCanonical,
    inputHash: executionInputHash(inputCanonical),
    ...over,
  };
}
export interface AdmissionFixture {
  store: Store;
  rebuild(now: Date): Store;
  audits(): Promise<unknown[]>;
}
export function describeAdmissionContract(name: string, make: () => Promise<AdmissionFixture>): void {
  describe(name, () => {
    let f: AdmissionFixture;
    beforeEach(async () => {
      f = await make();
    });
    it('四份数据原子出生，原文完整保留且审计不复制正文/canonical/capability', async () => {
      const input = birthInput();
      const result = await f.store.createManagedTaskFromIssue(input, executionAudit);
      expect(result).toMatchObject({
        kind: 'created',
        task: { ...input.task, state: 'queued' },
        control: { revision: 0, currentOperationId: null, coverageEpoch: input.coverageEpoch },
        postCommitWarnings: [],
      });
      expect(await f.store.getExecutionBirth(input.task.id)).toMatchObject({
        birthInputCanonical: canonicalExecutionInput(input),
      });
      expect(await f.store.getExecutionControl(input.task.id)).toMatchObject({
        kind: 'managed',
        current: null,
      });
      const audits = await f.audits();
      expect(audits).toHaveLength(1);
      const text = JSON.stringify(audits);
      expect(text).not.toContain('私有原文');
      expect(text).not.toContain('birthInputCanonical');
      expect(text).not.toContain('rawRequest');
      expect(await f.store.createManagedTaskFromIssue(input, executionAudit)).toEqual({
        ...result,
        kind: 'replayed',
      });
      if (result.kind !== 'rejected') {
        result.task.title = 'tamper';
        result.control.coverageEpoch = randomUUID();
        result.birth.taskQueue = 'tamper';
      }
      expect(await f.store.createManagedTaskFromIssue(input, executionAudit)).toMatchObject({
        kind: 'replayed',
        task: { title: input.task.title },
        birth: { taskQueue: input.taskQueue },
        control: { coverageEpoch: input.coverageEpoch },
      });
      expect(await f.audits()).toHaveLength(1);
    });
    for (const change of [
      (i: ManagedTaskBirthV1) => ({ ...i, coverageEpoch: randomUUID() }),
      (i: ManagedTaskBirthV1) => ({ ...i, namespace: 'other' }),
      (i: ManagedTaskBirthV1) => ({ ...i, taskQueue: 'other' }),
      (i: ManagedTaskBirthV1) => ({ ...i, task: { ...i.task, title: 'other' } }),
      (i: ManagedTaskBirthV1) => ({ ...i, task: { ...i.task, rawRequest: i.task.rawRequest.trim() } }),
      (i: ManagedTaskBirthV1) => ({ ...i, task: { ...i.task, requestedBy: 'other' } }),
      (i: ManagedTaskBirthV1) => ({ ...i, task: { ...i.task, id: randomUUID(), issueNumber: 901 } }),
    ])
      it('同request改变任何完整出生身份不得幂等或留新行', async () => {
        const input = birthInput();
        await f.store.createManagedTaskFromIssue(input, executionAudit);
        const modified = change(input);
        expect(await f.store.createManagedTaskFromIssue(modified, executionAudit)).toEqual({
          kind: 'rejected',
          reason: 'identity_conflict',
        });
        expect(await f.store.findTaskByIssue(IDS.repo, 901)).toBeNull();
        expect(await f.audits()).toHaveLength(1);
      });
    it('不同request同issue及跨issue复用task.id均零写入', async () => {
      const input = birthInput();
      await f.store.createManagedTaskFromIssue(input, executionAudit);
      expect(
        await f.store.createManagedTaskFromIssue(
          { ...input, birthRequestId: randomUUID(), task: { ...input.task, id: randomUUID() } },
          executionAudit,
        ),
      ).toEqual({ kind: 'rejected', reason: 'existing_task_forbidden' });
      expect(
        await f.store.createManagedTaskFromIssue(
          { ...input, birthRequestId: randomUUID(), task: { ...input.task, issueNumber: 901 } },
          executionAudit,
        ),
      ).toEqual({ kind: 'rejected', reason: 'identity_conflict' });
      expect(await f.store.findTaskByIssue(IDS.repo, 901)).toBeNull();
      expect(await f.audits()).toHaveLength(1);
    });
    it('task.id和issue分别占在两个旧对象上时优先报告身份冲突', async () => {
      const input = birthInput({ task: { ...birthInput().task, id: IDS.task13, issueNumber: 12 } });
      expect(await f.store.createManagedTaskFromIssue(input, executionAudit)).toEqual({
        kind: 'rejected',
        reason: 'identity_conflict',
      });
      expect(await f.store.getExecutionBirth(IDS.task13)).toBeNull();
      expect(await f.audits()).toHaveLength(0);
    });
    it('出生后任务镜像变化，完整原出生请求仍幂等，改请求不能伪造重放', async () => {
      const input = birthInput();
      await f.store.createManagedTaskFromIssue(input, executionAudit);
      await f.store.updateTaskRequest(
        { taskId: input.task.id, title: '更新标题', rawRequest: '更新正文' },
        { ...executionAudit, action: 'fixture', target: `task:${input.task.id}`, ok: true },
      );
      expect(await f.store.createManagedTaskFromIssue(input, executionAudit)).toMatchObject({
        kind: 'replayed',
        task: { title: '更新标题' },
        birth: { birthInputCanonical: canonicalExecutionInput(input) },
      });
      expect(
        await f.store.createManagedTaskFromIssue(
          { ...input, task: { ...input.task, title: '更新标题', rawRequest: '更新正文' } },
          executionAudit,
        ),
      ).toEqual({ kind: 'rejected', reason: 'identity_conflict' });
      expect(await f.audits()).toHaveLength(2);
    });
    it('任意已有旧task永不初始化，伪造epoch/空legacy不构成覆盖', async () => {
      for (const state of ['queued', 'stopped', 'done'] as const) {
        const original = birthInput({
          task: { ...birthInput().task, issueNumber: 950 + ['queued', 'stopped', 'done'].indexOf(state) },
        });
        const made = await f.store.createTaskFromIssue(original.task, {
          ...executionAudit,
          action: 'fixture',
          target: `task:${original.task.id}`,
          ok: true,
        });
        if (state !== 'queued')
          await f.store.stopQueuedTask(made.task.id, {
            ...executionAudit,
            action: 'fixture',
            target: `task:${made.task.id}`,
            ok: true,
          });
        // 初始旧样本本来就是done；新样本覆盖queued/stopped。
        const task =
          state === 'done' ? requiredAdmissionTask(await f.store.findTaskByIssue(IDS.repo, 12)) : made.task;
        expect(
          await f.store.createManagedTaskFromIssue(
            {
              ...original,
              task: {
                id: task.id,
                repoId: task.repoId,
                issueNumber: task.issueNumber,
                title: task.title,
                rawRequest: task.rawRequest,
                requestedBy: task.requestedBy,
              },
            },
            executionAudit,
          ),
        ).toEqual({ kind: 'rejected', reason: 'existing_task_forbidden' });
        expect(await f.store.getExecutionControl(task.id)).toEqual({ kind: 'unmanaged' });
        expect(await f.store.getExecutionBirth(task.id)).toBeNull();
      }
    });
    it('非法出生身份、非法审计和不存在repo失败不留task', async () => {
      const input = birthInput();
      for (const invalid of [
        { ...input, protocolVersion: 2 },
        { ...input, coverageEpoch: 'ABCDEF00-0000-4000-8000-000000000001' },
        { ...input, taskQueue: ' ' },
        { ...input, task: { ...input.task, issueNumber: 1.5 } },
      ])
        expect(
          await f.store.createManagedTaskFromIssue(invalid as ManagedTaskBirthV1, executionAudit),
        ).toEqual({ kind: 'rejected', reason: 'invalid_identity' });
      await expect(
        f.store.createManagedTaskFromIssue(input, { ...executionAudit, via: 'invalid' } as never),
      ).rejects.toThrow();
      await expect(
        f.store.createManagedTaskFromIssue(
          { ...input, task: { ...input.task, repoId: randomUUID() } },
          executionAudit,
        ),
      ).rejects.toThrow();
      expect(await f.store.findTaskByIssue(IDS.repo, 900)).toBeNull();
      expect(await f.store.getExecutionBirth(input.task.id)).toBeNull();
      expect(await f.audits()).toHaveLength(0);
    });
    it('legacy按精确run和完整输入幂等，跨代责任并存，重建/未来时钟仍保留', async () => {
      const task = requiredAdmissionTask(await f.store.findTaskByIssue(IDS.repo, 12));
      const input = legacyInput(task, {}, { capability: 'private-capability', title: '  保留空白\n' });
      const first = await f.store.admitLegacyExecution(input, executionAudit);
      expect(first).toMatchObject({ kind: 'admitted', admission: input, postCommitWarnings: [] });
      expect(await f.store.admitLegacyExecution(input, executionAudit)).toEqual({
        ...first,
        kind: 'replayed',
      });
      if (first.kind !== 'rejected') first.admission.taskQueue = 'tamper';
      expect(
        await f.store.admitLegacyExecution(legacyInput(task, { generation: 2 }), executionAudit),
      ).toMatchObject({ kind: 'admitted' });
      const rebuilt = f.rebuild(new Date('2099-01-01'));
      const rows = await rebuilt.listLegacyExecutionAdmissions(task.id);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.runId === input.runId)).toMatchObject(input);
      expect(await rebuilt.getExecutionControl(task.id)).toEqual({ kind: 'unmanaged' });
      expect(
        await rebuilt.createManagedTaskFromIssue(
          birthInput({
            task: {
              id: task.id,
              repoId: task.repoId,
              issueNumber: task.issueNumber,
              title: task.title,
              rawRequest: task.rawRequest,
              requestedBy: task.requestedBy,
            },
          }),
          executionAudit,
        ),
      ).toEqual({ kind: 'rejected', reason: 'existing_task_forbidden' });
      expect(JSON.stringify(await f.audits())).not.toContain('private-capability');
      expect(JSON.stringify(await f.audits())).not.toContain('inputCanonical');
      expect(await f.audits()).toHaveLength(2);
    });
    it('namespace/run唯一，换workflow/task仍拒绝，不同namespace独立', async () => {
      const a = requiredAdmissionTask(await f.store.findTaskByIssue(IDS.repo, 12));
      const b = requiredAdmissionTask(await f.store.findTaskByIssue(IDS.repo, 13));
      const input = legacyInput(a);
      await f.store.admitLegacyExecution(input, executionAudit);
      expect(
        await f.store.admitLegacyExecution(legacyInput(b, { runId: input.runId }), executionAudit),
      ).toEqual({ kind: 'rejected', reason: 'identity_conflict' });
      expect(
        await f.store.admitLegacyExecution(
          legacyInput(b, { runId: input.runId, namespace: 'other' }),
          executionAudit,
        ),
      ).toMatchObject({ kind: 'admitted' });
      expect(await f.store.listLegacyExecutionAdmissions(a.id)).toHaveLength(1);
      expect(await f.store.listLegacyExecutionAdmissions(b.id)).toHaveLength(1);
      expect(await f.audits()).toHaveLength(2);
    });
    it('历史改名/转主候选按repoId绑定，不用当前owner/name/title/profile重算；历史身份冲突仍拒绝', async () => {
      const task = requiredAdmissionTask(await f.store.findTaskByIssue(IDS.repo, 12));
      expect(await f.store.findRepoByName('example', 'canary')).toMatchObject({ id: task.repoId });
      const historicalRepo = {
        id: task.repoId,
        owner: 'previous-owner',
        name: 'previous-name',
        profile: { prior: true },
      };
      const input = legacyInput(
        task,
        { workflowId: 'task:previous-owner/previous-name#12' },
        { repo: historicalRepo, title: '旧标题' },
      );
      expect(await f.store.admitLegacyExecution(input, executionAudit)).toMatchObject({ kind: 'admitted' });
      for (const body of [
        { repo: { ...historicalRepo, id: randomUUID() } },
        { issueNumber: 13 },
        { generation: 2 },
        { repo: { ...historicalRepo, owner: 'different-history-owner' } },
        { repo: { ...historicalRepo, name: 'different-history-name' } },
      ]) {
        const conflicting = legacyInput(
          task,
          { workflowId: input.workflowId },
          { repo: historicalRepo, ...body },
        );
        expect(await f.store.admitLegacyExecution(conflicting, executionAudit)).toEqual({
          kind: 'rejected',
          reason: 'identity_conflict',
        });
      }
      expect(await f.store.listLegacyExecutionAdmissions(task.id)).toHaveLength(1);
      expect(await f.audits()).toHaveLength(1);
    });
    it('legacy任一身份改写或同hash非完整canonical都拒绝', async () => {
      const task = requiredAdmissionTask(await f.store.findTaskByIssue(IDS.repo, 12));
      const input = legacyInput(task);
      await f.store.admitLegacyExecution(input, executionAudit);
      for (const changed of [
        { ...input, taskQueue: 'other' },
        { ...input, workflowId: `${input.workflowId}:r2` },
        legacyInput(task, { runId: input.runId }, { title: 'other' }),
      ])
        expect(await f.store.admitLegacyExecution(changed, executionAudit)).toEqual({
          kind: 'rejected',
          reason: 'identity_conflict',
        });
      for (const invalid of [
        { ...input, inputHash: '0'.repeat(64) },
        { ...input, inputCanonical: `${input.inputCanonical} ` },
        { ...input, generation: 0 },
        { ...input, generation: 21 },
        { ...input, runId: 'bad' },
        { ...input, schemaVersion: 2 },
      ])
        expect(
          await f.store.admitLegacyExecution(invalid as LegacyExecutionIdentityV1, executionAudit),
        ).toEqual({ kind: 'rejected', reason: 'invalid_identity' });
      const mismatched = legacyInput(
        task,
        { runId: randomUUID() },
        { repo: { id: randomUUID(), owner: 'example', name: 'canary' } },
      );
      expect(await f.store.admitLegacyExecution(mismatched, executionAudit)).toEqual({
        kind: 'rejected',
        reason: 'identity_conflict',
      });
      expect(await f.store.listLegacyExecutionAdmissions(task.id)).toHaveLength(1);
      expect(await f.audits()).toHaveLength(1);
    });
    it('managed禁止legacy；不存在task和非法audit不留责任', async () => {
      const result = await f.store.createManagedTaskFromIssue(birthInput(), executionAudit);
      if (result.kind === 'rejected') throw new Error('出生失败');
      expect(await f.store.admitLegacyExecution(legacyInput(result.task), executionAudit)).toEqual({
        kind: 'rejected',
        reason: 'managed_requires_operation',
      });
      expect(
        await f.store.admitLegacyExecution(legacyInput({ ...result.task, id: randomUUID() }), executionAudit),
      ).toEqual({ kind: 'rejected', reason: 'not_found' });
      const task = requiredAdmissionTask(await f.store.findTaskByIssue(IDS.repo, 12));
      await expect(
        f.store.admitLegacyExecution(legacyInput(task), { ...executionAudit, via: 'invalid' } as never),
      ).rejects.toThrow();
      expect(await f.store.listLegacyExecutionAdmissions(task.id)).toEqual([]);
      expect(await f.audits()).toHaveLength(1);
    });
    it('无效读取不伪造出生', async () => {
      expect(await f.store.getExecutionBirth('bad')).toBeNull();
      expect(await f.store.getExecutionBirth(IDS.task12)).toBeNull();
      expect(await f.store.listLegacyExecutionAdmissions('bad')).toEqual([]);
      expect(await f.store.getExecutionControl(IDS.task12)).toEqual({ kind: 'unmanaged' });
    });
  });
}
