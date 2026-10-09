// 每一轮动手前并最新主线（#1246，workflows/task-sync.ts）：真 Temporal 测试服务端 + 假端口（注入假的并主线端口）+ 脚本化的任务活动。
// 落后时第 2 轮前并上；已是最新不并；并出冲突文件进返工意见；读不到记没查成照旧往下走（故意造出失败的一条）；
// 第 1 轮不并、没推过不并、验收前不并。老历史重放在 replay.test.ts 的 task-reworked 夹具。

import { randomUUID } from 'node:crypto';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, type FakeScript, fakeHead } from '../src/fakes.ts';
import type { TaskRun, TaskWorkflowInput } from '../src/task-contract.ts';
import { SYNC_UNREAD } from '../src/workflows/task-sync.ts';
import { freshRepo, useEnv, withWorker } from './helpers.ts';
import { OK_SEGMENT, scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

function input(): TaskWorkflowInput {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 12,
    title: '给驾驶舱加状态',
  };
}

async function start(q: string, i: TaskWorkflowInput): Promise<WorkflowHandle> {
  return env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(i.repo, i.issueNumber),
    args: [i],
  });
}

const CI_RED_ONCE: Partial<FakeScript> = {
  ci: (_i, n) => (n === 1 ? { state: 'red', failedChecks: ['test (engine)'] } : undefined),
};

/** 跑一张单：第一轮 CI 红了回去动手第二轮；记下每次起动手会话、每次验收时并主线已经被调过几次。 */
async function runReworked(script: Partial<FakeScript>) {
  const world = createFakeWorld({ ...CI_RED_ONCE, ...script });
  const syncSeenBySegment: number[] = [];
  const syncSeenByVerify: number[] = [];
  const { tasks, calls } = scripted({
    segment: async () => {
      syncSeenBySegment.push(world.count('syncMainline'));
      return OK_SEGMENT;
    },
    verify: (_i, n) => {
      syncSeenByVerify.push(world.count('syncMainline'));
      return { pass: true, problems: [], round: n === 1 ? 1 : 2 };
    },
  });
  const run = await withWorker(
    env,
    world,
    async (q) => (await start(q, input())).result() as Promise<TaskRun>,
    {
      tasks,
    },
  );
  return { world, calls, run, syncSeenBySegment, syncSeenByVerify };
}

describe('动手前并最新主线（#1246）', { timeout: 60_000 }, () => {
  it('落后时第 2 轮动手前并上：以第一轮推上去的头为准，并完在起会话之前；第 1 轮不并；验收前不再并', async () => {
    const { world, calls, run, syncSeenBySegment, syncSeenByVerify } = await runReworked({
      sync: (_i, n) => (n === 1 ? { head: fakeHead(900) } : undefined),
    });
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.count('syncMainline')).toBe(1);
    const [sync] = world.callsOf('syncMainline');
    expect(sync?.input).toMatchObject({
      prNumber: run.prNumber,
      head: fakeHead(101),
      worktreePath: expect.stringContaining('/fake/worktrees/'),
    });
    // 第 1 轮会话起之前没并过（树刚从最新主线切出来）；第 2 轮会话起之前并过一次
    expect(syncSeenBySegment).toEqual([0, 1]);
    // 验收（冷调用）开始前不再并：验收看到的次数就是第 2 轮前的那一次，合并到收尾也只有一次
    expect(syncSeenByVerify).toEqual([1]);
    expect(calls.segment[1]?.feedback.join('\n')).not.toContain('冲突');
  });

  it('已是最新：端口回头没变，不算并过，不进返工意见、不停下', async () => {
    const { world, calls, run } = await runReworked({});
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.count('syncMainline')).toBe(1);
    expect(calls.segment[1]?.feedback?.filter((line) => !line.startsWith('派前探测：'))).toHaveLength(1);
    expect(calls.segment[1]?.feedback.join('\n')).toContain('test (engine)');
    expect(world.alerts).toEqual([]);
  });

  it('并出冲突：不自己解、不停下，冲突文件名写进这一轮的返工意见交给会话', async () => {
    const { world, calls, run } = await runReworked({
      sync: (_i, n) => (n === 1 ? { state: 'conflict', conflictFiles: ['a.ts', 'b/c.ts'] } : undefined),
    });
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    const feedback = calls.segment[1]?.feedback.join('\n') ?? '';
    expect(feedback).toContain('和最新主线有冲突，要解决：a.ts、b/c.ts');
    expect(feedback).toContain('test (engine)'); // CI 红的那条还在
    expect(world.alerts).toEqual([]);
    expect(world.count('syncMainline')).toBe(1);
  });

  it('并出冲突、新主线没能取进会话的树（#1249）：返工意见里写明「树里的主线是旧的」；取进去了就不写', async () => {
    const stale = await runReworked({
      sync: (_i, n) =>
        n === 1 ? { state: 'conflict', conflictFiles: ['a.ts'], mainlineStale: '镜像打包失败了' } : undefined,
    });
    const feedback = stale.calls.segment[1]?.feedback.join('\n') ?? '';
    expect(feedback).toContain('和最新主线有冲突，要解决：a.ts');
    expect(feedback).toContain('树里的主线是旧的');
    expect(feedback).toContain('镜像打包失败了');

    const fresh = await runReworked({
      sync: (_i, n) => (n === 1 ? { state: 'conflict', conflictFiles: ['a.ts'] } : undefined),
    });
    expect(fresh.calls.segment[1]?.feedback.join('\n')).not.toContain('旧的');
  });

  it('【故意造出失败】并主线读不到（端口一直抛错）：记没查成、照旧往下走，不停下报警、不当成已经是最新', async () => {
    const { world, calls, run } = await runReworked({ failFirst: { syncMainline: 3 } });
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.alerts).toEqual([]);
    expect(calls.segment).toHaveLength(2); // 第 2 轮会话照常起了
    expect(calls.segment[1]?.feedback.join('\n')).not.toContain('冲突');
    // 没查成写在状态里（驾驶舱看得到），不是默默当成并过了
    const noted = world.states.map((s) => s.lastProblem).filter((p) => p?.startsWith(SYNC_UNREAD));
    expect(noted.length).toBeGreaterThan(0);
    expect(noted[0]).toContain('照旧往下走');
  });

  it('第 1 轮没有提交、什么都没推过：第 2 轮前也没有可并的（分支不在远端），不调并主线', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted({
      delivery: (n) => ({
        head: fakeHead(100 + n),
        commits: n === 1 ? 0 : 1,
        changedFiles: n === 1 ? [] : ['packages/web/src/pages/a.tsx'],
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      {
        tasks,
      },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.count('syncMainline')).toBe(0);
  });
});
