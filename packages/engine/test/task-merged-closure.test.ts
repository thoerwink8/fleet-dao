import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import {
  type MergedTaskReceipt,
  SEGMENT_DETACHED,
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskCloseClosedIssueUpdate,
  taskContinueSignal,
  taskPauseSignal,
  taskSettleMergedUpdate,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { OK_SEGMENT, scripted } from './task-script.ts';

const currentEnv = useEnv();
const commit = 'a'.repeat(40);
function input(): TaskWorkflowInput {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 12,
    title: '精确合并身份收尾',
  };
}
function receipt(status: TaskStatus): MergedTaskReceipt {
  const cap = status.mergedTaskClose;
  if (!cap?.prNumber || !cap.head) throw new Error('没有完整任务 PR');
  return { repo: cap.repo, prNumber: cap.prNumber, head: cap.head, mergeCommit: commit };
}
function hold(status: TaskStatus) {
  const token = status.mergedTaskClose?.token;
  if (!token) throw new Error('缺停法凭据');
  return token;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('已合 PR 在任务必经检查点安全结清（#3193）', { timeout: 60_000 }, () => {
  it.each(['merged', 'red', 'unknown'] as const)(
    'CI 先回 %s、既有并行验收已 detached：接回终态再按真实合并结清，晚到不通过不重派',
    async (ciState) => {
      const env = currentEnv();
      const world = createFakeWorld();
      const ciRelease = deferred();
      let merged = false;
      let detached = false;
      let probesWhileDetached = 0;
      world.ports.waitCi = async (request) => {
        await ciRelease.promise;
        return {
          state: ciState,
          head: request.head,
          failedChecks: ciState === 'red' ? ['check'] : [],
          ...(ciState === 'merged' ? { mergeCommit: commit } : {}),
          ...(ciState === 'unknown' ? { detail: '读不到 CI' } : {}),
        };
      };
      const attach = {
        runId: 'late-verify',
        startedAt: '2026-10-19T01:00:00.000Z',
        family: 'gpt' as const,
        modelId: 'gpt',
        routeId: 'route-gpt',
        poolId: 'pool-gpt',
        cwd: '/tmp/late',
      };
      const { tasks, calls } = scripted({
        verify: (request, n, signal) => {
          expect(signal.aborted).toBe(false);
          if (n === 1) {
            merged = true;
            detached = true;
            return { pass: false, problems: [], round: 1, detached: attach };
          }
          expect(request.attach).toEqual(attach);
          detached = false;
          return { pass: false, problems: ['晚到的旧头意见'], round: 1 };
        },
      });
      const i = input();
      await withWorker(
        env,
        world,
        async (q) => {
          const h = await env.client.workflow.start(WORKFLOW_TYPES.task, {
            workflowId: taskWorkflowId(i.repo, 12),
            taskQueue: q,
            args: [i],
          });
          await pollQuery(
            () => h.fetchHistory(),
            (history) => {
              const events = history.events ?? [];
              const scheduled = events.find(
                (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'coldVerify',
              );
              const completed = events.findIndex(
                (e) =>
                  scheduled &&
                  e.activityTaskCompletedEventAttributes?.scheduledEventId?.toString() ===
                    scheduled.eventId?.toString(),
              );
              return (
                completed >= 0 && events.slice(completed + 1).some((e) => !!e.timerStartedEventAttributes)
              );
            },
            '真实 history：并行验收已 detached，原 session 接回定时器已起',
          );
          ciRelease.resolve();
          expect(((await h.result()) as TaskRun).outcome).toBe('merged');
        },
        {
          tasks: {
            ...tasks,
            readMergedTask: async (read) => {
              if (detached && read.idle) {
                probesWhileDetached++;
                throw new Error('活验收不能收树');
              }
              return merged
                ? { repo: read.repo, prNumber: read.prNumber, head: read.expectedHead, mergeCommit: commit }
                : null;
            },
          },
        },
      );
      expect(calls.segment).toHaveLength(1);
      expect(calls.verify).toHaveLength(2);
      expect(calls.arm).toBe(0);
      expect(probesWhileDetached).toBe(0);
    },
  );
  it.each(['unknown', 'merged', 'open'] as const)(
    '正式 closed-issue Update 不能绕过合并核验：%s',
    async (state) => {
      const env = currentEnv();
      const world = createFakeWorld();
      const { tasks } = scripted();
      const i = input();
      let allowMerged = false;
      await withWorker(
        env,
        world,
        async (q) => {
          const h = await env.client.workflow.start(WORKFLOW_TYPES.task, {
            workflowId: taskWorkflowId(i.repo, 12),
            taskQueue: q,
            args: [i],
          });
          const parked = await pollQuery(
            () => h.query<TaskStatus>(taskStatusQuery),
            (s) => !!s.mergedTaskClose?.token,
            'PR 现读未知，原任务停下',
          );
          const request = { token: hold(parked), command: { by: 'closed-issue', reason: 'issue CLOSED' } };
          if (state === 'unknown') {
            await expect(h.executeUpdate(taskCloseClosedIssueUpdate, { args: [request] })).rejects.toThrow();
            expect(hold(await h.query<TaskStatus>(taskStatusQuery))).toEqual(request.token);
            allowMerged = true;
            expect(
              await h.executeUpdate(taskSettleMergedUpdate, {
                args: [{ token: request.token, receipt: receipt(parked) }],
              }),
            ).toBe('accepted');
            expect(((await h.result()) as TaskRun).outcome).toBe('merged');
          } else {
            expect(await h.executeUpdate(taskCloseClosedIssueUpdate, { args: [request] })).toBe(
              state === 'merged' ? 'busy' : 'accepted',
            );
            expect(((await h.result()) as TaskRun).outcome).toBe(state === 'merged' ? 'merged' : 'abandoned');
          }
        },
        {
          tasks: {
            ...tasks,
            readMergedTask: async (read) => {
              if (read.expectedMergeCommit || (read.idle?.includeOpen && state === 'merged') || allowMerged)
                return {
                  repo: read.repo,
                  prNumber: read.prNumber,
                  head: read.expectedHead,
                  mergeCommit: commit,
                };
              if (read.idle?.includeOpen && state === 'open') return null;
              throw new Error('GitHub 502 未知');
            },
          },
        },
      );
    },
  );

  it('已合时 detached 动手只接原 session，终态后再核 merged 并存档，不重派、不杀', async () => {
    const env = currentEnv();
    let merged = false;
    let detached = false;
    let probesWhileDetached = 0;
    let archives = 0;
    const world = createFakeWorld({
      ci: (_i, n) => (n === 1 ? { state: 'red', failedChecks: ['check'] } : undefined),
    });
    const originalRemove = world.ports.removeWorktree;
    world.ports.removeWorktree = async (input, ctx) => {
      if (input.archive) archives++;
      return originalRemove(input, ctx);
    };
    const attach = { runId: 'same-run', startedAt: '2026-10-19T01:00:00.000Z' };
    const { tasks, calls } = scripted({
      segment: async (input, n, signal) => {
        expect(signal.aborted).toBe(false);
        if (n === 2) {
          merged = true;
          detached = true;
          return {
            ok: false,
            runId: attach.runId,
            outcome: SEGMENT_DETACHED,
            evidence: { code: 'engine_stop', message: '会话仍活', quotaExhausted: false },
            detached: attach,
          };
        }
        if (n === 3) {
          expect(input.attach).toEqual(attach);
          detached = false;
        }
        return OK_SEGMENT;
      },
    });
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await env.client.workflow.start(WORKFLOW_TYPES.task, {
          workflowId: taskWorkflowId(i.repo, 12),
          taskQueue: q,
          args: [i],
        });
        return h.result() as Promise<TaskRun>;
      },
      {
        tasks: {
          ...tasks,
          readMergedTask: async (read) => {
            if (detached) {
              probesWhileDetached++;
              throw new Error('DB run 还活，不能收树');
            }
            return merged
              ? { repo: read.repo, prNumber: read.prNumber, head: read.expectedHead, mergeCommit: commit }
              : null;
          },
        },
      },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(3);
    expect(calls.segment.filter((r) => !r.attach)).toHaveLength(2);
    expect(probesWhileDetached).toBe(0);
    expect(calls.arm).toBe(0);
    expect(archives).toBe(1);
    expect(world.alerts).toEqual([]);
  });

  it('已合时 detached 冷验收只接原 session，终态后不挂自动合并', async () => {
    const env = currentEnv();
    let merged = false;
    let detached = false;
    let probesWhileDetached = 0;
    const world = createFakeWorld();
    const attach = {
      runId: 'same-verify',
      startedAt: '2026-10-19T01:00:00.000Z',
      family: 'gpt' as const,
      modelId: 'gpt',
      routeId: 'route-gpt',
      poolId: 'pool-gpt',
      cwd: '/tmp/existing',
    };
    const { tasks, calls } = scripted({
      verify: (input, n, signal) => {
        expect(signal.aborted).toBe(false);
        if (n === 1) {
          merged = true;
          detached = true;
          return { pass: false, problems: [], round: 1, detached: attach };
        }
        expect(input.attach).toEqual(attach);
        detached = false;
        return { pass: true, problems: [], round: 1 };
      },
    });
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await env.client.workflow.start(WORKFLOW_TYPES.task, {
          workflowId: taskWorkflowId(i.repo, 12),
          taskQueue: q,
          args: [i],
        });
        return h.result() as Promise<TaskRun>;
      },
      {
        tasks: {
          ...tasks,
          readMergedTask: async (read) => {
            if (detached) {
              probesWhileDetached++;
              throw new Error('验收 run 仍活');
            }
            return merged
              ? { repo: read.repo, prNumber: read.prNumber, head: read.expectedHead, mergeCommit: commit }
              : null;
          },
        },
      },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(1);
    expect(calls.verify).toHaveLength(2);
    expect(calls.arm).toBe(0);
    expect(probesWhileDetached).toBe(0);
    expect(world.alerts).toEqual([]);
  });
  it('软暂停在安全检查点同样可按精确停法结清，不发继续信号', async () => {
    const env = currentEnv();
    const world = createFakeWorld();
    const { tasks, calls } = scripted();
    const i = input();
    const reached = deferred();
    const release = deferred();
    let first = true;
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await env.client.workflow.start(WORKFLOW_TYPES.task, {
          workflowId: taskWorkflowId(i.repo, 12),
          taskQueue: q,
          args: [i],
        });
        await reached.promise;
        await h.signal(taskPauseSignal, { mode: 'soft', by: '测试', reason: '核实外部合并' });
        release.resolve();
        const paused = await pollQuery(
          () => h.query<TaskStatus>(taskStatusQuery),
          (s) => s.phase === 'paused' && !!s.mergedTaskClose?.token,
          '安全检查点软暂停',
        );
        expect(hold(paused).kind).toBe('paused');
        expect(
          await h.executeUpdate(taskSettleMergedUpdate, {
            args: [{ token: hold(paused), receipt: receipt(paused) }],
          }),
        ).toBe('accepted');
        expect(((await h.result()) as TaskRun).outcome).toBe('merged');
      },
      {
        tasks: {
          ...tasks,
          readMergedTask: async (read) => {
            if (read.expectedMergeCommit)
              return {
                repo: read.repo,
                prNumber: read.prNumber,
                head: read.expectedHead,
                mergeCommit: commit,
              };
            if (first) {
              first = false;
              reached.resolve();
              await release.promise;
            }
            return null;
          },
        },
      },
    );
    expect(calls.segment).toHaveLength(1);
    expect(calls.arm).toBe(0);
  });
  it('OPEN 单有未结验收：精确 Update 结清原任务，不继续动手、不关单', async () => {
    const env = currentEnv();
    const world = createFakeWorld();
    const { tasks, calls } = scripted();
    const i = input();
    let closes = 0;
    const originalClose = world.ports.closeIssue;
    world.ports.closeIssue = async (...args) => {
      closes++;
      return originalClose(...args);
    };
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await env.client.workflow.start(WORKFLOW_TYPES.task, {
          workflowId: taskWorkflowId(i.repo, 12),
          taskQueue: q,
          args: [i],
        });
        const s = await pollQuery(
          () => h.query<TaskStatus>(taskStatusQuery),
          (s) => s.phase === 'parked' && !!s.mergedTaskClose?.token,
          '现读失败停在原任务',
        );
        const r = receipt(s);
        const token = hold(s);
        expect(
          await h.executeUpdate(taskSettleMergedUpdate, {
            args: [{ token, receipt: { ...r, repo: { owner: 'wrong', name: 'repo' } } }],
          }),
        ).toBe('stale');
        expect(
          await h.executeUpdate(taskSettleMergedUpdate, {
            args: [{ token, receipt: { ...r, head: 'f'.repeat(40) } }],
          }),
        ).toBe('stale');
        expect(await h.executeUpdate(taskSettleMergedUpdate, { args: [{ token, receipt: r }] })).toBe(
          'accepted',
        );
        return h.result() as Promise<TaskRun>;
      },
      {
        tasks: {
          ...tasks,
          readMergedTask: async (read) => {
            if (!read.expectedMergeCommit) throw new Error('读 GitHub 失败，不能猜');
            return { repo: read.repo, prNumber: read.prNumber, head: read.expectedHead, mergeCommit: commit };
          },
        },
        wrapActivities: (acts) => ({
          ...acts,
          acceptanceDuties: async () => ({
            open: [
              {
                repo: `${i.repo.owner}/${i.repo.name}`,
                issueNumber: 12,
                prNumber: 100,
                head: 'b'.repeat(40),
                items: ['上线后现场验收'],
                source: 'cold_verify',
                mergeCommit: commit,
              },
            ],
          }),
        }),
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', acceptanceOpen: 1 });
    expect(closes).toBe(0);
    expect(calls.segment).toHaveLength(1);
    expect(calls.arm).toBe(0);
    expect(calls.merge).toBe(0);
    expect(world.states.at(-1)).toMatchObject({ state: 'done' });
  });

  it('异步现读期间点继续：旧停法回执失效，不能消费新一代停法', async () => {
    const env = currentEnv();
    const world = createFakeWorld();
    const { tasks } = scripted();
    const i = input();
    const started = deferred();
    const release = deferred();
    let block = true;
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await env.client.workflow.start(WORKFLOW_TYPES.task, {
          workflowId: taskWorkflowId(i.repo, 12),
          taskQueue: q,
          args: [i],
        });
        const first = await pollQuery(
          () => h.query<TaskStatus>(taskStatusQuery),
          (s) => !!s.mergedTaskClose?.token,
          '第一代停法',
        );
        const settling = h.executeUpdate(taskSettleMergedUpdate, {
          args: [{ token: hold(first), receipt: receipt(first) }],
        });
        await started.promise;
        await h.signal(taskContinueSignal, { by: '测试' });
        await pollQuery(
          () => h.query<TaskStatus>(taskStatusQuery),
          (s) => (s.mergedTaskClose?.token?.generation ?? 0) > hold(first).generation,
          '继续后新停法',
        );
        release.resolve();
        expect(await settling).toBe('stale');
        block = false;
        const second = await h.query<TaskStatus>(taskStatusQuery);
        expect(
          await h.executeUpdate(taskSettleMergedUpdate, {
            args: [{ token: hold(second), receipt: receipt(second) }],
          }),
        ).toBe('accepted');
        expect(((await h.result()) as TaskRun).outcome).toBe('merged');
      },
      {
        tasks: {
          ...tasks,
          readMergedTask: async (read) => {
            if (!read.expectedMergeCommit) throw new Error('读 PR 暂不可用');
            if (block) {
              started.resolve();
              await release.promise;
            }
            return { repo: read.repo, prNumber: read.prNumber, head: read.expectedHead, mergeCommit: commit };
          },
        },
      },
    );
  });

  it('活工人不取消：自然返回后的检查点发现已合，不再推分支或起新实现', async () => {
    const env = currentEnv();
    let merged = false;
    let pushed = 0;
    const world = createFakeWorld({
      ci: (_i, n) => (n === 1 ? { state: 'red', failedChecks: ['check'] } : undefined),
      push: () => {
        pushed++;
        return undefined;
      },
    });
    const { tasks, calls } = scripted({
      segment: async (_i, n, signal) => {
        if (n === 2) {
          expect(signal.aborted).toBe(false);
          merged = true;
        }
        return OK_SEGMENT;
      },
    });
    const i = input();
    const run = await withWorker(
      env,
      world,
      async (q) => {
        const h = await env.client.workflow.start(WORKFLOW_TYPES.task, {
          workflowId: taskWorkflowId(i.repo, 12),
          taskQueue: q,
          args: [i],
        });
        return h.result() as Promise<TaskRun>;
      },
      {
        tasks: {
          ...tasks,
          readMergedTask: async (read) =>
            merged
              ? { repo: read.repo, prNumber: read.prNumber, head: read.expectedHead, mergeCommit: commit }
              : null,
        },
      },
    );
    expect(run.outcome).toBe('merged');
    expect(calls.segment).toHaveLength(2);
    expect(pushed).toBe(1);
    expect(calls.arm).toBe(0);
    expect(calls.merge).toBe(0);
  });
});
