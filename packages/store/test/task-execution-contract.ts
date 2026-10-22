import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import type { MemoryData } from '../src/memory-store.ts';
import type { Store } from '../src/ports.ts';
import type {
  ExecutionAudit,
  ExecutionControl,
  ExecutionIdentity,
  ExecutionOperation,
  ReserveExecutionInput,
} from '../src/task-execution.ts';

export const EXECUTION_TIME = new Date('2026-10-19T09:00:00.000Z');
export const EPOCH = '30000000-0000-4000-8000-000000000001';
export const executionAudit: ExecutionAudit = {
  actor: { kind: 'user', id: IDS.founderA },
  via: 'agent',
  reason: '执行资格契约测试',
};
export const executionControl = (over: Partial<ExecutionControl> = {}): ExecutionControl => ({
  taskId: IDS.task12,
  protocolVersion: 1,
  coverageEpoch: EPOCH,
  revision: 0,
  currentOperationId: null,
  ...over,
});
export const executionInput = (over: Partial<ReserveExecutionInput> = {}): ReserveExecutionInput => ({
  taskId: IDS.task12,
  operationId: randomUUID(),
  requestId: randomUUID(),
  coverageEpoch: EPOCH,
  revision: 1,
  expectedRevision: 0,
  nodeId: 'test-node',
  kind: 'start',
  namespace: 'test',
  workflowId: 'task:test',
  generation: 1,
  workflowType: 'task-v2',
  inputHash: 'sha256:test',
  ...over,
});
export function executionSeed(control: ExecutionControl | null): Partial<MemoryData> {
  const fixtures = devFixtures(EXECUTION_TIME);
  return {
    repos: fixtures.repos ?? [],
    tasks: (fixtures.tasks ?? []).map((task) => ({
      ...task,
      state: 'done',
      executor: 'local',
      claimedBy: 'old-node',
      leaseUntil: '2020-01-01T00:00:00.000Z',
    })),
    executionControls: new Map(
      control
        ? [
            [control.taskId, control],
            [IDS.task13, executionControl({ taskId: IDS.task13 })],
          ]
        : [],
    ),
  };
}
export interface ExecutionFixture {
  store: Store;
  rebuild(now: Date): Store;
  operations(): Promise<ExecutionOperation[]>;
  audits(): Promise<unknown[]>;
}
export type MakeExecutionFixture = (control: ExecutionControl | null) => Promise<ExecutionFixture>;

export function describeExecutionContract(name: string, make: MakeExecutionFixture): void {
  describe(name, () => {
    let f: ExecutionFixture;
    let input: ReserveExecutionInput;
    beforeEach(async () => {
      f = await make(executionControl());
      input = executionInput();
    });
    it('旧任务done、租约过期、无runs仍未受管，不自动建立资格', async () => {
      f = await make(null);
      expect(await f.store.getExecutionControl('bad')).toEqual({ kind: 'not_found' });
      expect(await f.store.getExecutionControl(randomUUID())).toEqual({ kind: 'not_found' });
      expect(await f.store.getExecutionControl(IDS.task12)).toEqual({ kind: 'unmanaged' });
      expect(await f.store.reserveExecution(input, executionAudit)).toEqual({
        kind: 'rejected',
        reason: 'unmanaged',
      });
      expect(await f.operations()).toEqual([]);
    });
    it('同请求幂等、快照隔离、审计只一次且action/target固定', async () => {
      const forgedAudit = { ...executionAudit, action: 'forged.success', target: 'other-task', ok: true };
      const first = await f.store.reserveExecution(input, forgedAudit);
      expect(first).toMatchObject({ kind: 'applied', operation: { phase: 'reserved', revision: 1 } });
      expect(await f.store.reserveExecution(input, executionAudit)).toEqual({ ...first, kind: 'replayed' });
      if (first.kind !== 'rejected') first.operation.nodeId = 'tampered';
      expect(await f.store.getExecutionControl(IDS.task12)).toMatchObject({
        kind: 'managed',
        current: { nodeId: input.nodeId },
      });
      const audits = await f.audits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'task_execution.reserve',
        target: `task:${input.taskId}`,
        ok: true,
      });
    });
    const changed: Partial<ExecutionIdentity>[] = [
      { operationId: randomUUID() },
      { requestId: randomUUID() },
      { nodeId: 'other' },
      { coverageEpoch: randomUUID() },
      { revision: 2 },
      { namespace: 'other' },
      { workflowId: 'other' },
      { generation: 2 },
      { workflowType: 'other' },
      { inputHash: 'other' },
      { kind: 'redo' },
    ];
    for (const change of changed)
      it(`同请求改${Object.keys(change)[0]}拒绝`, async () => {
        await f.store.reserveExecution(input, executionAudit);
        const modified = {
          ...input,
          ...change,
          ...(change.revision ? { expectedRevision: change.revision - 1 } : {}),
        };
        expect(await f.store.reserveExecution(modified, executionAudit)).toMatchObject({
          kind: 'rejected',
          reason: 'identity_conflict',
        });
        expect(await f.operations()).toHaveLength(1);
        expect(await f.audits()).toHaveLength(1);
      });
    it('同一operationId不可跨任务复用', async () => {
      await f.store.reserveExecution(input, executionAudit);
      expect(await f.store.reserveExecution({ ...input, taskId: IDS.task13 }, executionAudit)).toEqual({
        kind: 'rejected',
        reason: 'identity_conflict',
      });
      expect(await f.store.getExecutionControl(IDS.task13)).toMatchObject({
        kind: 'managed',
        control: { revision: 0, currentOperationId: null },
      });
    });
    it('撤销留墓碑，下一revision赢家不受旧请求重放影响', async () => {
      await f.store.reserveExecution(input, executionAudit);
      expect(
        await f.store.resolveExecution({ ...input, reason: 'cancelled_before_dispatch' }, executionAudit),
      ).toMatchObject({ kind: 'applied', operation: { phase: 'resolved' } });
      const next = executionInput({ revision: 2, expectedRevision: 1 });
      await f.store.reserveExecution(next, executionAudit);
      expect(await f.store.reserveExecution(input, executionAudit)).toMatchObject({
        kind: 'replayed',
        operation: { phase: 'resolved', revision: 1 },
      });
      expect(
        await f.store.resolveExecution({ ...input, reason: 'cancelled_before_dispatch' }, executionAudit),
      ).toMatchObject({ kind: 'replayed', operation: { phase: 'resolved' } });
      expect(await f.store.dispatchExecution(input, executionAudit)).toMatchObject({ kind: 'rejected' });
      expect(await f.store.admitExecution({ ...input, runId: 'late' }, executionAudit)).toMatchObject({
        kind: 'rejected',
      });
      expect(await f.store.getExecutionControl(input.taskId)).toMatchObject({
        kind: 'managed',
        control: { revision: 2, currentOperationId: next.operationId },
        current: { phase: 'reserved' },
      });
      expect(await f.audits()).toHaveLength(3);
    });
    it('dispatch后不得撤销或用时钟/重建Store释放责任', async () => {
      await f.store.reserveExecution(input, executionAudit);
      expect(await f.store.admitExecution({ ...input, runId: 'early' }, executionAudit)).toMatchObject({
        kind: 'rejected',
        reason: 'phase_conflict',
      });
      await f.store.dispatchExecution(input, executionAudit);
      expect(await f.store.dispatchExecution(input, executionAudit)).toMatchObject({ kind: 'replayed' });
      const rebuilt = f.rebuild(new Date('2099-01-01T00:00:00Z'));
      expect(
        await rebuilt.resolveExecution({ ...input, reason: 'cancelled_before_dispatch' }, executionAudit),
      ).toEqual({ kind: 'rejected', reason: 'proof_required' });
      expect(await rebuilt.reserveExecution(executionInput(), executionAudit)).toMatchObject({
        kind: 'rejected',
      });
      expect(await rebuilt.getExecutionControl(input.taskId)).toMatchObject({
        kind: 'managed',
        current: { phase: 'dispatching' },
      });
      expect(await f.audits()).toHaveLength(2);
    });
    it('只绑定一个run，改run/身份不能抢资格，admitted永不自动释放', async () => {
      await f.store.reserveExecution(input, executionAudit);
      await f.store.dispatchExecution(input, executionAudit);
      expect(await f.store.admitExecution({ ...input, runId: 'run-a' }, executionAudit)).toMatchObject({
        kind: 'applied',
        operation: { admittedRunId: 'run-a' },
      });
      expect(await f.store.admitExecution({ ...input, runId: 'run-a' }, executionAudit)).toMatchObject({
        kind: 'replayed',
      });
      expect(await f.store.admitExecution({ ...input, runId: 'run-b' }, executionAudit)).toEqual({
        kind: 'rejected',
        reason: 'identity_conflict',
      });
      expect(
        await f.store.admitExecution({ ...input, nodeId: 'other', runId: 'run-a' }, executionAudit),
      ).toMatchObject({ kind: 'rejected' });
      const rebuilt = f.rebuild(new Date('2099-01-01T00:00:00Z'));
      expect(
        await rebuilt.resolveExecution({ ...input, reason: 'cancelled_before_dispatch' }, executionAudit),
      ).toEqual({ kind: 'rejected', reason: 'proof_required' });
      expect(await rebuilt.getExecutionControl(input.taskId)).toMatchObject({
        kind: 'managed',
        current: { phase: 'admitted', admittedRunId: 'run-a' },
      });
      expect(await f.audits()).toHaveLength(3);
    });
    it('精确 run 的真实终态释放 admitted：CAS+审计同事务，幂等，错 run/错终态/dispatching/时钟都不释放', async () => {
      await f.store.reserveExecution(input, executionAudit);
      await f.store.dispatchExecution(input, executionAudit);
      // dispatching 没有 run 绑定：任何终态证明都不能释放。
      expect(
        await f.store.closeExecutionRun({ ...input, runId: 'run-a', terminal: 'completed' }, executionAudit),
      ).toEqual({ kind: 'rejected', reason: 'proof_required' });
      await f.store.admitExecution({ ...input, runId: 'run-a' }, executionAudit);
      for (const bad of [
        { ...input, runId: 'run-b', terminal: 'completed' },
        { ...input, runId: '  ', terminal: 'completed' },
        { ...input, runId: 'run-a', terminal: 'running' },
        { ...input, runId: 'run-a', terminal: 'continued_as_new' },
        { ...input, runId: 'run-a' },
      ] as const)
        expect(await f.store.closeExecutionRun(bad as never, executionAudit).then((r) => r.kind)).toBe(
          'rejected',
        );
      expect(
        await f.store.closeExecutionRun(
          { ...input, nodeId: 'other', runId: 'run-a', terminal: 'failed' },
          executionAudit,
        ),
      ).toMatchObject({ kind: 'rejected' });
      // 时钟和重建 Store 不释放。
      const rebuilt = f.rebuild(new Date('2099-01-01T00:00:00Z'));
      expect(await rebuilt.getExecutionControl(input.taskId)).toMatchObject({
        current: { phase: 'admitted', admittedRunId: 'run-a' },
      });
      expect(await f.audits()).toHaveLength(3);
      expect(
        await f.store.closeExecutionRun({ ...input, runId: 'run-a', terminal: 'timed_out' }, executionAudit),
      ).toMatchObject({
        kind: 'applied',
        operation: { phase: 'resolved', resolvedReason: 'run_timed_out', admittedRunId: 'run-a' },
      });
      expect(await f.audits()).toHaveLength(4);
      expect(await f.store.getExecutionControl(input.taskId)).toMatchObject({
        kind: 'managed',
        control: { revision: 1, currentOperationId: null },
        current: null,
      });
      // 同终态重放幂等不再写审计；换终态/换 run 是冲突，不改写已落的释放事实。
      expect(
        await f.store.closeExecutionRun({ ...input, runId: 'run-a', terminal: 'timed_out' }, executionAudit),
      ).toMatchObject({ kind: 'replayed' });
      for (const [runId, terminal] of [
        ['run-a', 'completed'],
        ['run-b', 'timed_out'],
      ] as const)
        expect(await f.store.closeExecutionRun({ ...input, runId, terminal }, executionAudit)).toEqual({
          kind: 'rejected',
          reason: 'identity_conflict',
        });
      expect(await f.audits()).toHaveLength(4);
      // 释放后下一 revision 才能再预留；旧请求重放不复活旧资格。
      expect(
        await f.store.reserveExecution(executionInput({ revision: 2, expectedRevision: 1 }), executionAudit),
      ).toMatchObject({
        kind: 'applied',
      });
      expect((await f.operations()).map((o) => o.resolvedReason).sort()).toEqual([null, 'run_timed_out']);
    });
    it('每种真实终态都对应固定原因；reserved 与已撤销操作不能被终态证明改写', async () => {
      await f.store.reserveExecution(input, executionAudit);
      expect(
        await f.store.closeExecutionRun({ ...input, runId: 'run-a', terminal: 'completed' }, executionAudit),
      ).toEqual({ kind: 'rejected', reason: 'phase_conflict' });
      await f.store.resolveExecution({ ...input, reason: 'cancelled_before_dispatch' }, executionAudit);
      expect(
        await f.store.closeExecutionRun({ ...input, runId: 'run-a', terminal: 'completed' }, executionAudit),
      ).toMatchObject({ kind: 'rejected' });
      for (const [i, terminal] of (['completed', 'failed', 'cancelled', 'terminated'] as const).entries()) {
        const next = executionInput({ revision: 2 + i, expectedRevision: 1 + i });
        // 每轮：预留→派发→接纳→终态；revision 只在预留时 +1，resolved 不回退。
        await f.store.reserveExecution(next, executionAudit);
        await f.store.dispatchExecution(next, executionAudit);
        await f.store.admitExecution({ ...next, runId: `run-${terminal}` }, executionAudit);
        expect(
          await f.store.closeExecutionRun({ ...next, runId: `run-${terminal}`, terminal }, executionAudit),
        ).toMatchObject({ operation: { resolvedReason: `run_${terminal}` } });
      }
    });
    it('非法身份与非法审计都在修改前拒绝', async () => {
      for (const revision of [NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
        expect(await f.store.reserveExecution({ ...input, revision }, executionAudit)).toMatchObject({
          kind: 'rejected',
          reason: 'invalid_identity',
        });
      for (const generation of [NaN, 0, -1, 1.5, 21, Number.MAX_SAFE_INTEGER, 'uuid-value'])
        expect(
          await f.store.reserveExecution({ ...input, generation } as ReserveExecutionInput, executionAudit),
        ).toMatchObject({ kind: 'rejected', reason: 'invalid_identity' });
      expect(await f.store.reserveExecution({ ...input, nodeId: ' ' }, executionAudit)).toMatchObject({
        kind: 'rejected',
        reason: 'invalid_identity',
      });
      expect(await f.store.reserveExecution({ ...input, expectedRevision: 1 }, executionAudit)).toMatchObject(
        { kind: 'rejected', reason: 'invalid_identity' },
      );
      await expect(
        f.store.reserveExecution(input, { ...executionAudit, via: 'invalid' } as unknown as ExecutionAudit),
      ).rejects.toThrow();
      expect(await f.operations()).toEqual([]);
      expect(await f.audits()).toEqual([]);
      expect(await f.store.getExecutionControl(input.taskId)).toMatchObject({
        kind: 'managed',
        control: { revision: 0, currentOperationId: null },
      });
    });
    it('最大安全revision明确耗尽而非溢出', async () => {
      f = await make(executionControl({ revision: Number.MAX_SAFE_INTEGER }));
      const last = executionInput({
        revision: Number.MAX_SAFE_INTEGER,
        expectedRevision: Number.MAX_SAFE_INTEGER - 1,
      });
      expect(await f.store.reserveExecution(last, executionAudit)).toEqual({
        kind: 'rejected',
        reason: 'revision_exhausted',
      });
      expect(await f.operations()).toEqual([]);
    });
    it('redo沿用真实数值第2代', async () => {
      const redo = executionInput({ kind: 'redo', generation: 2, workflowId: 'task:test:r2' });
      expect(await f.store.reserveExecution(redo, executionAudit)).toMatchObject({
        kind: 'applied',
        operation: { generation: 2, kind: 'redo' },
      });
    });
    it('所有UUID只接受规范小写，读取与写入两实现一致', async () => {
      expect(await f.store.getExecutionControl(IDS.task12.toUpperCase())).toEqual({ kind: 'not_found' });
      for (const key of ['taskId', 'operationId', 'requestId', 'coverageEpoch']) {
        expect(
          await f.store.reserveExecution(
            { ...input, [key]: 'ABCDEF00-0000-4000-8000-000000000001' },
            executionAudit,
          ),
        ).toEqual({ kind: 'rejected', reason: 'invalid_identity' });
      }
      expect(await f.operations()).toEqual([]);
    });
    it('非法audit在每种修改路径都不改变状态', async () => {
      await f.store.reserveExecution(input, executionAudit);
      const invalid = { ...executionAudit, actor: { kind: 'invalid', id: 'x' } } as unknown as ExecutionAudit;
      const reserved = await f.store.getExecutionControl(input.taskId);
      await expect(f.store.dispatchExecution(input, invalid)).rejects.toThrow();
      await expect(
        f.store.resolveExecution({ ...input, reason: 'cancelled_before_dispatch' }, invalid),
      ).rejects.toThrow();
      expect(await f.store.getExecutionControl(input.taskId)).toEqual(reserved);
      await f.store.dispatchExecution(input, executionAudit);
      const dispatched = await f.store.getExecutionControl(input.taskId);
      await expect(f.store.admitExecution({ ...input, runId: 'run-a' }, invalid)).rejects.toThrow();
      expect(await f.store.getExecutionControl(input.taskId)).toEqual(dispatched);
      expect(await f.audits()).toHaveLength(2);
    });
  });
}
