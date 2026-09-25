// 演练代码升级（windsurf-dao#1633 的 A1）：一条停在「等信号」的在途任务，换上改过步序的新代码、换了工人：
// 用 patched() 包住的改法照样能查状态、收信号、按老步序走完，新起的走新步序；没包的，重放当场报 TMPRL1100。
// 真工作流的同一道检查在 replay.test.ts（录好的历史对现在的代码重放）。
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker, type WorkflowBundle } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as steps from './fixtures/evolution/steps.ts';
import { waitUntil } from './support.ts';

const silent = { trace() {}, debug() {}, info() {}, warn() {}, error: console.error, log() {} };
const bundleOf = (file: string) =>
  bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL(`./fixtures/evolution/${file}`, import.meta.url)),
    logger: silent as never,
  });

let env: TestWorkflowEnvironment;
let v1: WorkflowBundle;
let patchedV2: WorkflowBundle;
let unpatchedV2: WorkflowBundle;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  [v1, patchedV2, unpatchedV2] = await Promise.all([
    bundleOf('v1.ts'),
    bundleOf('v2-patched.ts'),
    bundleOf('v2-unpatched.ts'),
  ]);
}, 120_000);
afterAll(async () => {
  await env?.teardown();
});

/** 工人不缓存工作流：每个工作流任务都从历史重放——等于每一步都是「换了工人」。 */
const workerOn = (taskQueue: string, workflowBundle: WorkflowBundle) =>
  Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle,
    activities: { stepA: steps.stepA, stepB: steps.stepB, stepC: steps.stepC },
    maxCachedWorkflows: 0,
  });

describe('老历史进新代码', { timeout: 60_000 }, () => {
  it('停在等信号的在途任务：换上 patched() 包住的新代码照样走完，没包的重放当场红', async () => {
    const taskQueue = 'evolution';
    const handle = await env.client.workflow.start('evolving', { taskQueue, workflowId: 'evolving-old' });
    // 老代码跑到「a 做完、在等 go」（处理 a 结果的那个工作流任务已经交差），然后工人下线（部署新代码）。
    const oldWorker = await workerOn(taskQueue, v1);
    const before = await oldWorker.runUntil(async () => {
      await waitUntil(async () => {
        const events = (await handle.fetchHistory()).events ?? [];
        const lastCompleted = events.findLastIndex((e) => e.activityTaskCompletedEventAttributes);
        return (
          lastCompleted >= 0 &&
          events.slice(lastCompleted).some((e) => e.workflowTaskCompletedEventAttributes)
        );
      }, '老代码做完 a、停下等信号');
      return handle.query('steps');
    });
    expect(before).toEqual(['a']);
    // 下线期间「go」到了（#1633 里就是这时候到的 resume）。
    await handle.signal('go');
    const history = await handle.fetchHistory();

    // 没包 patched() 的改法：重放就对不上——线上就是读不了状态、收不了信号的僵尸。
    const broken = await Worker.runReplayHistory(
      { workflowBundle: unpatchedV2 },
      history,
      handle.workflowId,
    ).catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(DeterminismViolationError);
    expect(String((broken as Error).message)).toContain('TMPRL1100');

    // 包了的改法：重放得过；新工人接手在途任务，处理下线期间来的信号，按老步序（不做 b）走完、查得到状态。
    await Worker.runReplayHistory({ workflowBundle: patchedV2 }, history, handle.workflowId);
    const newWorker = await workerOn(taskQueue, patchedV2);
    const result = await newWorker.runUntil(async () => {
      const old = await handle.result();
      const seen = await handle.query('steps');
      // 新起的任务走新步序。
      const fresh = await env.client.workflow.start('evolving', { taskQueue, workflowId: 'evolving-new' });
      await fresh.signal('go');
      return { old, seen, fresh: await fresh.result() };
    });
    expect(result.old).toEqual(['a', 'c']);
    expect(result.seen).toEqual(['a', 'c']);
    expect(result.fresh).toEqual(['b', 'a', 'c']);
    expect(steps.ran).toEqual(['a', 'c', 'b', 'a', 'c']);
  });
});
