import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  enqueueSignal,
  type MergeItem,
  type MergeQueueStatus,
  mergeQueueWorkflowId,
  type SubtaskResult,
  type SubtaskStatus,
  stopSignal,
  WORKFLOW_TYPES,
} from '../src/contract.ts';
import { createFakeWorld, type FakeCall } from '../src/fakes.ts';
import {
  freshRepo,
  overlaps,
  queryUntil,
  spec,
  subtaskInput,
  useEnv,
  waitUntil,
  withWorker,
} from './helpers.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

/**
 * 一个一个等结果。别用 Promise.all 同时等好几个：测试服务端每等一个结果就放开一次跳时间，
 * 同时等几个会把「有活动在跑时不跳」的锁放穿，活动的限时在跳过去的时间里超了，服务端就重试它（实测合并被调了两次）。
 */
async function resultsInOrder(handles: { result(): Promise<unknown> }[]): Promise<SubtaskResult[]> {
  const out: SubtaskResult[] = [];
  for (const handle of handles) out.push((await handle.result()) as SubtaskResult);
  return out;
}

/** 合并队列处理一个条目的时间段：从同步主线开始到合并结束。 */
function itemSpan(calls: FakeCall[], prNumber: number) {
  const mine = calls.filter(
    (c) =>
      (c.port === 'syncMainline' || c.port === 'runTests' || c.port === 'mergePr') &&
      (c.input as { prNumber: number; worktreePath?: string }).prNumber === prNumber &&
      // 子任务验证时的同步带工作树；合并队列里的不带。
      (c.input as { worktreePath?: string }).worktreePath === undefined,
  );
  return {
    at: Math.min(...mine.map((c) => c.at)),
    end: Math.max(...mine.map((c) => c.end ?? Number.POSITIVE_INFINITY)),
  };
}

describe('合并队列', { timeout: 60_000 }, () => {
  it('同一个仓一次只合一个：同步主线 → 重跑测试 → 合并，整段不交叠，先来先合', async () => {
    const repo = freshRepo();
    const world = createFakeWorld({ delayMs: { syncMainline: 100, runTests: 150, mergePr: 200 } });
    const results = await withWorker(env, world, async (q) => {
      const inputs = [subtaskInput(spec('a'), { repo }), subtaskInput(spec('b'), { repo })];
      const handles = await Promise.all(
        inputs.map((input) =>
          env.client.workflow.start(WORKFLOW_TYPES.subtask, {
            taskQueue: q,
            workflowId: `sub-${input.subtaskId}`,
            args: [input],
          }),
        ),
      );
      return resultsInOrder(handles);
    });
    expect(results.map((r) => r.state)).toEqual(['merged', 'merged']);
    const merges = world.callsOf('mergePr');
    // 每次合并都是第一次尝试：没有哪次因为超时被服务端重试（重试的合并会撞上前一次）。
    expect(merges.map((m) => m.attempt)).toEqual([1, 1]);
    const [first, second] = results.map((r) => itemSpan(world.calls, r.prNumber ?? -1));
    expect(first && second && overlaps(first, second)).toBe(false);
    // 合并都带着「只合这个头」的约束。
    for (const m of merges) expect(m.input.expectedHead).toBeTruthy();
  });

  it('子任务叫停时从队里撤出，轮到它也不合', async () => {
    const repo = freshRepo();
    const world = createFakeWorld({ delayMs: { mergePr: 1_500 } });
    const [a, b] = [subtaskInput(spec('a'), { repo }), subtaskInput(spec('b'), { repo })];
    const outcome = await withWorker(env, world, async (q) => {
      const ha = await env.client.workflow.start(WORKFLOW_TYPES.subtask, {
        taskQueue: q,
        workflowId: `sub-${a.subtaskId}`,
        args: [a],
      });
      await waitUntil(() => world.count('mergePr') === 1, 'a 开始合并');
      const hb = await env.client.workflow.start(WORKFLOW_TYPES.subtask, {
        taskQueue: q,
        workflowId: `sub-${b.subtaskId}`,
        args: [b],
      });
      await queryUntil<SubtaskStatus>(hb, (s) => s.state === 'in_merge_queue', 'b 排进队');
      const mq = env.client.workflow.getHandle(mergeQueueWorkflowId(repo));
      await queryUntil<MergeQueueStatus>(mq, (s) => s.queue.length === 1, 'b 在队里等');
      await hb.signal(stopSignal, { by: 'founder' });
      const rb = (await hb.result()) as SubtaskResult;
      const ra = (await ha.result()) as SubtaskResult;
      const queue = await queryUntil<MergeQueueStatus>(
        mq,
        (s) => s.queue.length === 0 && !s.current,
        '队空了',
      );
      return { ra, rb, queue };
    });
    expect(outcome.ra.state).toBe('merged');
    expect(outcome.rb.state).toBe('stopped');
    expect(world.count('mergePr')).toBe(1);
    expect(outcome.queue.processed).toBe(1);
  });

  it('合并回读不是已合并：退回主会话，修完重新排队', async () => {
    const world = createFakeWorld({
      merge: (_input, n) => (n === 1 ? { merged: false, reason: '头变了，没合' } : undefined),
    });
    const input = subtaskInput(spec('a'));
    const result = (await withWorker(env, world, async (q) =>
      (
        await env.client.workflow.start(WORKFLOW_TYPES.subtask, {
          taskQueue: q,
          workflowId: `sub-${input.subtaskId}`,
          args: [input],
        })
      ).result(),
    )) as SubtaskResult;
    expect(result.state).toBe('merged');
    expect(result.rounds.mergeReturn).toBe(1);
    expect(world.count('mergePr')).toBe(2);
  });

  it('同一个条目排两次只合一次（子任务等太久会重排）', async () => {
    const repo = freshRepo();
    const world = createFakeWorld();
    const item: MergeItem = {
      itemId: 'sub:acme/x#1/a~1#1',
      subtaskWorkflowId: 'sub:acme/x#1/a~1',
      taskId: 't',
      subtaskId: 's',
      subtaskKey: 'a',
      repo,
      prNumber: 7,
      branch: 'fleet/1-a',
      head: 'h1',
      enqueuedAt: new Date(0).toISOString(),
    };
    const status = await withWorker(env, world, async (q) => {
      const start = () =>
        env.client.workflow.signalWithStart(WORKFLOW_TYPES.mergeQueue, {
          taskQueue: q,
          workflowId: mergeQueueWorkflowId(repo),
          args: [{ schemaVersion: 1, repo }],
          signal: enqueueSignal,
          signalArgs: [item],
        });
      const mq = await start();
      await queryUntil<MergeQueueStatus>(mq, (s) => s.processed === 1, '合完第一次');
      await start();
      await new Promise((r) => setTimeout(r, 500));
      return (await mq.query('status')) as MergeQueueStatus;
    });
    expect(world.count('mergePr')).toBe(1);
    expect(status.processed).toBe(1);
  });

  it('攒够一批换一次历史（continue-as-new），排着的条目带过去接着合', async () => {
    const repo = freshRepo();
    const world = createFakeWorld({ delayMs: { mergePr: 300 } });
    const inputs = ['a', 'b', 'c'].map((k) =>
      subtaskInput(spec(k), { repo, limits: { mergeQueueBatch: 1 } }),
    );
    const { results, runs } = await withWorker(env, world, async (q) => {
      const handles = await Promise.all(
        inputs.map((input) =>
          env.client.workflow.start(WORKFLOW_TYPES.subtask, {
            taskQueue: q,
            workflowId: `sub-${input.subtaskId}`,
            args: [input],
          }),
        ),
      );
      const done = await resultsInOrder(handles);
      const mq = env.client.workflow.getHandle(mergeQueueWorkflowId(repo));
      const status = await queryUntil<MergeQueueStatus>(mq, (s) => s.processed === 3, '三条都处理了');
      const history = await mq.fetchHistory();
      const started = history.events?.[0]?.workflowExecutionStartedEventAttributes;
      return { results: done, runs: { status, continuedFrom: started?.continuedExecutionRunId ?? '' } };
    });
    expect(results.map((r) => r.state)).toEqual(['merged', 'merged', 'merged']);
    expect(world.count('mergePr')).toBe(3);
    expect(runs.status.processed).toBe(3);
    // 现在这一轮是接着上一轮换过来的。
    expect(runs.continuedFrom).not.toBe('');
  });
});
