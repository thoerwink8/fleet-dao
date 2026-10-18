// 真 Temporal 开发服务端（不能跳时间）：git 档的挂合并不心跳，scheduleToClose 到了工作流会收到超时，
// 进程里的活动还会往下走。可跳时间的测试服务端不等这种活动自己超时。这里用生产的活动实现和 1 秒总期限，
// 读 PR 故意睡 2.3 秒，确认醒来之后不会再调用 enableAutoMerge。
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import type { EngineTasks } from '../src/activities.ts';
import { createFakeWorld } from '../src/fakes.ts';
import { localExec } from '../src/real/exec.ts';
import { createTaskActivities, type TaskActivitiesDeps } from '../src/real/task-activities.ts';
import type { ArmAutoMergeInput } from '../src/task-contract.ts';
import { createRealEnv, freshRepo, waitUntil, withWorker } from './support.ts';

const CLI = '/opt/fleet-dao/temporal/bin/temporal';
const HEAD = 'a'.repeat(40);
const silent = { trace() {}, debug() {}, info() {}, warn() {}, error: console.error, log() {} };

describe('挂合并写请求在期限之后不能迟到启动', { timeout: 180_000 }, () => {
  it('真服务端：无心跳活动超过 1 秒总期限后继续跑，不再调用 enableAutoMerge', async () => {
    if (!process.env.FLEET_TEST_TEMPORAL_CLI?.trim() && existsSync(CLI)) {
      process.env.FLEET_TEST_TEMPORAL_CLI = CLI;
    }
    const bundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('./fixtures/arm-deadline-probe.ts', import.meta.url)),
      logger: silent as never,
    });
    const real = await createRealEnv();
    try {
      const repo = freshRepo();
      let enabled = false;
      let merged = false;
      let readFinishedAt = 0;
      let settledAt = 0;
      const gh = {
        claims: {
          readPull: async () => {
            await new Promise((resolve) => setTimeout(resolve, 2_300));
            readFinishedAt = Date.now();
            return {
              number: 7,
              nodeId: 'PR_7',
              state: 'open',
              merged: false,
              draft: false,
              title: 't',
              body: '',
              headSha: HEAD,
              headRef: 'fleet/12-t1a2b3c4d',
              fromFork: false,
              author: null,
              autoMerge: false,
              mergeable: true,
              mergeableState: 'clean',
            };
          },
          enableAutoMerge: async () => {
            enabled = true;
          },
        },
        mergePr: async () => {
          merged = true;
          return { merged: true, mergeCommit: 'c'.repeat(40) };
        },
      } as unknown as TaskActivitiesDeps['gh'];
      const acts = createTaskActivities({
        gh,
        trees: { ownerOf: async () => 'fleet-agent-carpool' },
        exec: localExec(),
        gitBin: 'git',
        shBin: 'sh',
        readChecks: async () => ({ overall: 'pending', failed: [] }),
      });
      const impl = acts.armAutoMerge;
      const tasks: EngineTasks = {
        armAutoMerge: async (input, ctx) => {
          try {
            return await impl(input, ctx);
          } finally {
            settledAt = Date.now();
          }
        },
      };
      const world = createFakeWorld();
      const input: ArmAutoMergeInput = {
        schemaVersion: 1,
        repo,
        prNumber: 7,
        expectedHead: HEAD,
      };
      const code = await withWorker(
        real,
        world,
        async (q) => {
          const handle = await real.client.workflow.start('armDeadlineProbe', {
            taskQueue: q,
            workflowId: `arm-deadline-${randomUUID()}`,
            args: [input],
          });
          const got = (await handle.result()) as string;
          const workflowDoneAt = Date.now();
          await waitUntil(() => settledAt > 0, '慢活动在超时后跑完', 20_000);
          expect(readFinishedAt).toBeGreaterThan(workflowDoneAt);
          expect(settledAt).toBeGreaterThan(workflowDoneAt);
          expect(enabled).toBe(false);
          expect(merged).toBe(false);
          return got;
        },
        { tasks, workflowBundle: bundle },
      );
      expect(code).toBe('TIMEOUT_SCHEDULE_TO_CLOSE');
    } finally {
      await real.teardown();
    }
  });
});
