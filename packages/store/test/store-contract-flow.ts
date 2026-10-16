// Store 契约：全程模式的分组记录（#2823，task_flow_assignments）。每张单最多一行，写一次、读。内存版和 Postgres 版过同一套。
import { FlowAssignmentExistsError } from '@fleet-dao/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import type { Store } from '../src/ports.ts';
import { type MakeStore, T0 } from './store-contract.ts';

export function describeFlowStoreContract(name: string, make: MakeStore): void {
  describe(`Store 契约（全程模式分组记录）：${name}`, () => {
    let store: Store;
    const clock = { now: new Date(T0) };
    beforeEach(async () => {
      clock.now = new Date(T0);
      store = (await make(devFixtures(T0), clock)).store;
    });

    it('没分过组：读回 null', async () => {
      expect(await store.getFlowAssignment(IDS.task12)).toBeNull();
    });

    it('写一次再读回；分组时刻用 Store 的钟；reason 不给就是 null', async () => {
      const written = await store.writeFlowAssignmentOnce({
        taskId: IDS.task12,
        mode: 'full',
        source: 'hash',
        stratum: 'medium',
      });
      expect(written).toEqual({
        taskId: IDS.task12,
        mode: 'full',
        source: 'hash',
        stratum: 'medium',
        assignedAt: T0.toISOString(),
        reason: null,
      });
      expect(await store.getFlowAssignment(IDS.task12)).toEqual(written);
      expect(await store.getFlowAssignment(IDS.task13)).toBeNull();
    });

    it('分组时顺带写任务行的 flowMode（#2826）；没分组的单没有这个键', async () => {
      expect(await store.getTask(IDS.task12)).not.toHaveProperty('flowMode');
      await store.writeFlowAssignmentOnce({
        taskId: IDS.task12,
        mode: 'full',
        source: 'label',
        stratum: 'x',
      });
      expect((await store.getTask(IDS.task12))?.flowMode).toBe('full');
      expect(await store.getTask(IDS.task13)).not.toHaveProperty('flowMode');
    });

    it('不合格退回三段：reason 原样留着', async () => {
      const written = await store.writeFlowAssignmentOnce({
        taskId: IDS.task13,
        mode: 'three',
        source: 'ineligible',
        stratum: 'heavyweight',
        reason: '改到标准路径',
      });
      expect(written.reason).toBe('改到标准路径');
    });

    it('同一张单写第二次直接报错，第一次的记录不动', async () => {
      await store.writeFlowAssignmentOnce({
        taskId: IDS.task12,
        mode: 'full',
        source: 'label',
        stratum: 'fast',
      });
      clock.now = new Date(T0.getTime() + 60_000);
      await expect(
        store.writeFlowAssignmentOnce({ taskId: IDS.task12, mode: 'three', source: 'hash', stratum: 'fast' }),
      ).rejects.toBeInstanceOf(FlowAssignmentExistsError);
      expect(await store.getFlowAssignment(IDS.task12)).toMatchObject({
        mode: 'full',
        source: 'label',
        assignedAt: T0.toISOString(),
      });
    });

    it('没有这张单：报错，不写；不是 uuid 的编号读回 null', async () => {
      await expect(
        store.writeFlowAssignmentOnce({
          taskId: 'e0000000-0000-4000-8000-0000000000ff',
          mode: 'three',
          source: 'hash',
          stratum: 'fast',
        }),
      ).rejects.toThrow('没有这张单');
      expect(await store.getFlowAssignment('not-a-uuid')).toBeNull();
    });
  });
}
