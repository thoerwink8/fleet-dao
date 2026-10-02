// 拉单的工作流（workflows/intake.ts，#632 S2-4b-3）：真 Temporal 测试服务端上跑一轮。工作流只调一个活动，活动按工人装的拉单跑；
// 这一轮的结局原样交回；没跑成报不重试的 INTAKE_FAILED；假端口的工人（没装拉单）明确报 JOB_NOT_CONFIGURED。
import { randomUUID } from 'node:crypto';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { describe, expect, it } from 'vitest';
import type { EngineJobs } from '../src/activities.ts';
import { type IntakeRun, WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { useEnv, withWorker } from './helpers.ts';
import { idleDeps } from './intake-script.ts';

const env = useEnv();

async function runOnce(jobs: EngineJobs | undefined): Promise<IntakeRun> {
  return withWorker(
    env(),
    createFakeWorld(),
    (taskQueue) =>
      env().client.workflow.execute(WORKFLOW_TYPES.intake, {
        taskQueue,
        workflowId: `intake-${randomUUID()}`,
        args: [{ schemaVersion: 1 }],
      }),
    jobs ? { jobs } : {},
  );
}

async function failureOf(jobs: EngineJobs | undefined): Promise<ApplicationFailure> {
  const err = await runOnce(jobs).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WorkflowFailedError);
  let cause = (err as WorkflowFailedError).cause;
  while (cause && !(cause instanceof ApplicationFailure)) cause = (cause as { cause?: Error }).cause;
  expect(cause).toBeInstanceOf(ApplicationFailure);
  return cause as ApplicationFailure;
}

describe('拉单的工作流（真 Temporal 测试服务端）', { timeout: 60_000 }, () => {
  it('一轮跑完：工作流交回这一轮的结局；开关全关是正常的空闲，记 ok、scanned 算上受管的仓', async () => {
    const got = await runOnce({ intake: () => idleDeps() });
    expect(got).toMatchObject({ runId: 1, outcome: 'ok', scanned: 1, found: 0 });
  });

  it('【故意造出的失败】这一轮没跑成（受管的仓读不到）：活动报 INTAKE_FAILED（不重试，下一轮 5 分钟后照来）', async () => {
    const failure = await failureOf({
      intake: () =>
        idleDeps({
          repos: async () => {
            throw new Error('库连不上');
          },
        }),
    });
    expect(failure.type).toBe('INTAKE_FAILED');
    expect(failure.nonRetryable).toBe(true);
    expect(failure.message).toContain('库连不上');
  });

  it('假端口的工人（没装拉单）接到这一轮：明确报 JOB_NOT_CONFIGURED，不回一个空的 ok', async () => {
    const failure = await failureOf(undefined);
    expect(failure.type).toBe('JOB_NOT_CONFIGURED');
    expect(failure.nonRetryable).toBe(true);
  });
});
