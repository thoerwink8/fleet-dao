// 已结束且误记 abandoned 的真实已合任务：受管纠正的 Store 契约。内存版和 Postgres 版过同一套（由 store-contract.ts 挂进来）。
// 只改任务账并和操作记录同一事务；不改旧 run、不动 Temporal、不碰验收责任。
import { describe, expect, it } from 'vitest';
import { devFixtures, IDS } from '../src/dev-fixtures.ts';
import type { MemoryData } from '../src/memory-store.ts';
import {
  MERGED_CORRECTION_ACTION,
  type MergedCorrectionInput,
  mergedCorrectionTarget,
  type NewAuditEntry,
} from '../src/ports.ts';
import type { MakeStore } from './store-contract.ts';

const NOW = new Date('2026-10-19T05:00:00.000Z');
const TASK = IDS.task13;
const WF = 'task:example/canary#13';
const TEMPORAL_RUN = '01a14fd8-fb57-741a-8c14-42e3fdba87d6';
const RUN_ID = 'd1000000-0000-4000-8000-000000013101';
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const UPDATED_AT = '2026-10-19T01:52:06.446Z';
const DOING = '被 root 放弃：issue 已关闭';

interface Options {
  state?: 'stopped' | 'running' | 'done';
  phase?: string;
  executor?: 'engine' | 'local';
  extraRuns?: Record<string, unknown>[];
  runOverride?: Record<string, unknown>;
}

function data(opts: Options = {}): Partial<MemoryData> {
  const d = devFixtures(NOW);
  d.tasks = (d.tasks ?? []).map((t) =>
    t.id === TASK
      ? {
          ...t,
          state: opts.state ?? 'stopped',
          ...(opts.executor === 'local'
            ? { executor: 'local' as const, claimedBy: 'laptop', leaseUntil: '2026-10-19T09:00:00.000Z' }
            : {}),
        }
      : t,
  );
  d.taskLedgers = new Map([
    [TASK, { phase: opts.phase ?? 'abandoned', doing: DOING, lastProblem: '放弃', updatedAt: UPDATED_AT }],
  ]);
  // 只留这张任务自己的 run（样例里 #13 的别的 run 会干扰「无活 run」）
  d.segmentRuns = [
    ...(d.segmentRuns ?? []).filter((r) => r.taskId !== TASK && r.issueNumber !== 13),
    {
      id: RUN_ID,
      segment: 'manual',
      taskId: TASK,
      issueNumber: 13,
      model: 'opus-5.5',
      startedAt: '2026-10-19T00:00:00.000Z',
      endedAt: '2026-10-19T01:50:00.000Z',
      outcome: 'done',
      prNumber: 3137,
      workflowId: WF,
      temporalRunId: TEMPORAL_RUN,
      ...opts.runOverride,
    } as unknown as NonNullable<MemoryData['segmentRuns']>[number],
    ...((opts.extraRuns ?? []) as unknown as NonNullable<MemoryData['segmentRuns']>),
  ];
  return d;
}

function input(over: Partial<MergedCorrectionInput> = {}): MergedCorrectionInput {
  return {
    repoId: IDS.repo,
    taskId: TASK,
    issueNumber: 13,
    workflowId: WF,
    temporalRunId: TEMPORAL_RUN,
    pr: 3137,
    head: HEAD,
    mergeCommit: MERGE,
    expected: { phase: 'abandoned', doing: DOING, updatedAt: UPDATED_AT, runIds: [RUN_ID] },
    doing: `PR #3137 已合并（${MERGE.slice(0, 7)}）；运行账经受管纠正`,
    evidenceKey: 'evidence-1',
    ...over,
  };
}

function entry(over: Partial<NewAuditEntry> = {}, key = input()): NewAuditEntry {
  return {
    actor: { kind: 'ops', id: 'ops:task' },
    action: MERGED_CORRECTION_ACTION,
    target: mergedCorrectionTarget(TASK),
    via: 'ops',
    ok: true,
    reason: '真实已合，纠正误记',
    before: { state: 'stopped', phase: 'abandoned', doing: DOING, updatedAt: UPDATED_AT },
    after: {
      taskId: TASK,
      pr: key.pr,
      head: key.head,
      mergeCommit: key.mergeCommit,
      temporalRunId: key.temporalRunId,
      evidenceKey: key.evidenceKey,
      state: 'done',
    },
    ...over,
  };
}

export function describeCorrectMergedContract(make: MakeStore): void {
  describe('已合任务误记 abandoned 的受管纠正', () => {
    const open = async (opts: Options = {}) => (await make(data(opts), { now: new Date(NOW) })).store;
    const auditsOf = async (store: Awaited<ReturnType<typeof open>>) =>
      (await store.listAudit({ target: mergedCorrectionTarget(TASK), limit: 50 })).items.filter(
        (a) => a.action === MERGED_CORRECTION_ACTION,
      );

    it('只读现查：任务账、run、没有活会话、还没有纠正记录', async () => {
      const store = await open();
      const facts = await store.readMergedCorrection({ repoId: IDS.repo, taskId: TASK, issueNumber: 13 });
      expect(facts?.task.state).toBe('stopped');
      expect(facts?.ledger).toEqual({
        phase: 'abandoned',
        doing: DOING,
        lastProblem: '放弃',
        updatedAt: UPDATED_AT,
      });
      expect(facts?.runs.map((r) => r.id)).toEqual([RUN_ID]);
      expect(facts?.runs[0]?.temporalRunId).toBe(TEMPORAL_RUN);
      expect(facts?.activeRunIds).toEqual([]);
      expect(facts?.prior).toBeUndefined();
      expect(await auditsOf(store)).toEqual([]);
    });

    it('读不到任务：不存在的编号、不是 uuid 的编号都回 null，不抛库错', async () => {
      const store = await open();
      const other = '99999999-0000-4000-8000-000000000000';
      expect(
        await store.readMergedCorrection({ repoId: IDS.repo, taskId: other, issueNumber: 13 }),
      ).toBeNull();
      expect(
        await store.readMergedCorrection({ repoId: IDS.repo, taskId: 'nope', issueNumber: 13 }),
      ).toBeNull();
      expect(
        await store.correctMergedAbandoned(
          input({ taskId: other }),
          entry({ target: mergedCorrectionTarget(other) }),
        ),
      ).toMatchObject({ result: 'not_found' });
      expect(await store.correctMergedAbandoned(input({ taskId: 'nope' }), entry())).toMatchObject({
        result: 'not_found',
      });
    });

    it('正常纠正：任务改成 done、旧 run 原样保留、操作记录带前后状态，同一事务', async () => {
      const store = await open();
      const before = await store.readMergedCorrection({ repoId: IDS.repo, taskId: TASK, issueNumber: 13 });
      expect(await store.correctMergedAbandoned(input(), entry())).toEqual({ result: 'ok' });
      const after = await store.readMergedCorrection({ repoId: IDS.repo, taskId: TASK, issueNumber: 13 });
      expect(after?.task.state).toBe('done');
      expect(after?.ledger.phase).toBe('done');
      expect(after?.ledger.doing).toContain('PR #3137 已合并');
      expect(after?.ledger.lastProblem).toBeNull();
      expect(after?.runs).toEqual(before?.runs);
      expect(after?.prior).toMatchObject({
        pr: 3137,
        head: HEAD,
        mergeCommit: MERGE,
        temporalRunId: TEMPORAL_RUN,
        evidenceKey: 'evidence-1',
      });
      const audits = await auditsOf(store);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        ok: true,
        via: 'ops',
        before: { state: 'stopped', phase: 'abandoned' },
        after: { state: 'done', pr: 3137 },
      });
    });

    it('同一请求重复：幂等，不再改、不再记', async () => {
      const store = await open();
      expect(await store.correctMergedAbandoned(input(), entry())).toEqual({ result: 'ok' });
      const first = await store.readMergedCorrection({ repoId: IDS.repo, taskId: TASK, issueNumber: 13 });
      expect(await store.correctMergedAbandoned(input(), entry())).toEqual({ result: 'already_corrected' });
      expect(await store.readMergedCorrection({ repoId: IDS.repo, taskId: TASK, issueNumber: 13 })).toEqual(
        first,
      );
      expect(await auditsOf(store)).toHaveLength(1);
    });

    it('纠正过之后换 head / 合并提交 / run / PR / 证据：拒绝，不冒充成功，也不再记', async () => {
      const store = await open();
      await store.correctMergedAbandoned(input(), entry());
      const variants: Partial<MergedCorrectionInput>[] = [
        { head: 'c'.repeat(40) },
        { mergeCommit: 'c'.repeat(40) },
        { temporalRunId: '01a14fd8-fb57-741a-8c14-42e3fdba8888' },
        { pr: 3138 },
        { evidenceKey: 'evidence-2' },
      ];
      for (const over of variants) {
        const key = input(over);
        expect(await store.correctMergedAbandoned(key, entry({}, key))).toMatchObject({ result: 'conflict' });
      }
      expect(await auditsOf(store)).toHaveLength(1);
    });

    it('不是已结束的 stopped/abandoned：运行中、已完成、phase 不是 abandoned 都拒绝，不改', async () => {
      for (const opts of [
        { state: 'running' as const },
        { state: 'done' as const },
        { phase: 'paused' },
        { phase: 'done' },
      ]) {
        const store = await open(opts);
        expect(await store.correctMergedAbandoned(input(), entry())).toMatchObject({ result: 'conflict' });
        expect(await auditsOf(store)).toEqual([]);
        const facts = await store.readMergedCorrection({ repoId: IDS.repo, taskId: TASK, issueNumber: 13 });
        expect(facts?.task.state).toBe(opts.state ?? 'stopped');
      }
    });

    it('活会话：任务还有没结束的 run 就拒绝', async () => {
      const store = await open({
        extraRuns: [
          {
            id: 'd1000000-0000-4000-8000-000000013102',
            segment: 'manual',
            taskId: TASK,
            issueNumber: 13,
            model: 'opus-5.5',
            startedAt: '2026-10-19T04:00:00.000Z',
            workflowId: WF,
          },
        ],
      });
      const facts = await store.readMergedCorrection({ repoId: IDS.repo, taskId: TASK, issueNumber: 13 });
      expect(facts?.activeRunIds).toEqual(['d1000000-0000-4000-8000-000000013102']);
      const key = input({
        expected: {
          phase: 'abandoned',
          doing: DOING,
          updatedAt: UPDATED_AT,
          runIds: [RUN_ID, 'd1000000-0000-4000-8000-000000013102'],
        },
      });
      expect(await store.correctMergedAbandoned(key, entry())).toMatchObject({
        result: 'conflict',
        why: expect.stringContaining('未结束'),
      });
      expect(await auditsOf(store)).toEqual([]);
    });

    it('本机领着的任务：拒绝', async () => {
      const store = await open({ executor: 'local' });
      expect(await store.correctMergedAbandoned(input(), entry())).toMatchObject({ result: 'conflict' });
      expect(await auditsOf(store)).toEqual([]);
    });

    it('并发变化：预检之后任务账变了、出现了新 run、换代、别的 Temporal run，都拒绝陈旧请求', async () => {
      const stale = [
        input({
          expected: {
            phase: 'abandoned',
            doing: DOING,
            updatedAt: '2026-10-19T02:00:00.000Z',
            runIds: [RUN_ID],
          },
        }),
        input({ expected: { phase: 'abandoned', doing: '别的话', updatedAt: UPDATED_AT, runIds: [RUN_ID] } }),
        input({ expected: { phase: 'abandoned', doing: DOING, updatedAt: UPDATED_AT, runIds: [] } }),
        input({ workflowId: 'task:example/canary#13:r2' }),
        input({ temporalRunId: '01a14fd8-fb57-741a-8c14-42e3fdba8888' }),
        input({ issueNumber: 14 }),
        input({ repoId: '99999999-0000-4000-8000-000000000000' }),
      ];
      for (const key of stale) {
        const store = await open();
        expect(await store.correctMergedAbandoned(key, entry())).toMatchObject({ result: 'conflict' });
        const facts = await store.readMergedCorrection({ repoId: IDS.repo, taskId: TASK, issueNumber: 13 });
        expect(facts?.task.state).toBe('stopped');
        expect(await auditsOf(store)).toEqual([]);
      }
    });

    it('换代：任务还有记在别的工作流编号下的 run，拒绝', async () => {
      const store = await open({ runOverride: { workflowId: 'task:example/canary#13:r2' } });
      expect(await store.correctMergedAbandoned(input(), entry())).toMatchObject({
        result: 'conflict',
        why: expect.stringContaining('换代'),
      });
    });

    it('操作记录不是这张任务的受管纠正成功记录：拒绝，任务不动', async () => {
      const store = await open();
      for (const bad of [
        entry({ action: 'task.abandon' }),
        entry({ target: `task:${IDS.task12}` }),
        entry({ ok: false, error: '假装失败' }),
      ]) {
        expect(await store.correctMergedAbandoned(input(), bad)).toMatchObject({ result: 'conflict' });
      }
      const facts = await store.readMergedCorrection({ repoId: IDS.repo, taskId: TASK, issueNumber: 13 });
      expect(facts?.task.state).toBe('stopped');
    });

    it('操作记录写不进（ok=false 没带原因）：任务一起回滚，仍是 stopped/abandoned，之后可正常纠正', async () => {
      const store = await open();
      await expect(store.correctMergedAbandoned(input(), entry({ ok: false }))).rejects.toThrow();
      const facts = await store.readMergedCorrection({ repoId: IDS.repo, taskId: TASK, issueNumber: 13 });
      expect(facts?.task.state).toBe('stopped');
      expect(facts?.ledger).toMatchObject({ phase: 'abandoned', doing: DOING, updatedAt: UPDATED_AT });
      expect(await auditsOf(store)).toEqual([]);
      expect(await store.correctMergedAbandoned(input(), entry())).toEqual({ result: 'ok' });
    });
  });
}
