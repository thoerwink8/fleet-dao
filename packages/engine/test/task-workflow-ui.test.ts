// 任务工作流动手段认界面活（#1264）：界面活按 ui 用途选路并带 uiWork，GPT 不派（含「别的家都派不出」时回「等」，不落到 GPT）；
// 非界面活照旧按 execute 选；判不出按界面活处理并在动手状态里写明。真 Temporal 测试服务端 + 假选路 + 脚本化的任务活动。

import { randomUUID } from 'node:crypto';
import { hardBanFor } from '@fleet-dao/shared';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld, type FakeScript, fakeHead } from '../src/fakes.ts';
import type { PickRouteInput, RouteChoice } from '../src/ports.ts';
import {
  type TaskRun,
  type TaskStatus,
  type TaskWorkflowInput,
  taskAbandonSignal,
  taskStatusQuery,
} from '../src/task-contract.ts';
import { freshRepo, pollQuery, useEnv, withWorker } from './helpers.ts';
import { goodBrief, scripted } from './task-script.ts';

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

const statusOf = (h: WorkflowHandle): Promise<TaskStatus> => h.query(taskStatusQuery);

// 假选路照真选路的样子：动手的顺序里 GPT 排第一（要证明非界面活没被误挡）；界面活（uiWork）按 ui 判，硬禁令 gpt-no-ui
// （shared 的 hardBanFor，和 routing/filter.ts 同一份）把 GPT 挡在外面；派不出就回「等」，不落到 GPT
const GPT: RouteChoice = {
  routeId: 'r-gpt',
  poolId: 'p-gpt',
  modelId: 'gpt-5.6-luna',
  family: 'gpt',
  hostId: 'cursor-agent',
};
const OPUS: RouteChoice = {
  routeId: 'r-opus',
  poolId: 'p-opus',
  modelId: 'claude-opus-5-5',
  family: 'claude',
  hostId: 'claude-code',
};
const subject = (r: RouteChoice) => ({ id: r.modelId, family: r.family, displayName: r.modelId });

function routing(available: RouteChoice[], picks: PickRouteInput[], extra: Partial<FakeScript> = {}) {
  return createFakeWorld({
    ...extra,
    route: (i) => {
      picks.push(i);
      const usable = [GPT, OPUS].filter(
        (r) => available.includes(r) && !hardBanFor(subject(r), i.uiWork ? 'ui' : i.stage),
      );
      const route = usable[0];
      return route
        ? { ok: true, route, why: '测试' }
        : { ok: false, waitFor: 'slot', detail: '能派的家都派不出，等', retryAfterSeconds: 60 };
    },
  });
}

const NO_PATH_BODY = '## 场景\n\n要改一个东西。\n';
const BACKEND_BODY = `${NO_PATH_BODY}\n改 \`packages/engine/src/a.ts\`。\n`;
const briefWith = (touches: string[], request: string) => () => ({
  ok: true as const,
  brief: { ...goodBrief(), touches, request },
});

describe('任务工作流 · 动手段认界面活（#1264）', { timeout: 60_000 }, () => {
  it('界面单（已知的模块写了页面目录）：按 ui 用途选路、带 uiWork，GPT 排第一也不派，会话落到别的家', async () => {
    const picks: PickRouteInput[] = [];
    const world = routing([GPT, OPUS], picks);
    const { tasks, calls } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(picks[0]).toMatchObject({ stage: 'ui', uiWork: true, reserve: { segment: 'manual' } });
    expect(calls.segment.map((s) => s.route.routeId)).toEqual(['r-opus']);
  });

  it('界面单：别的家都派不出、只剩 GPT 时回「等」，不起会话、不落到 GPT', async () => {
    const picks: PickRouteInput[] = [];
    const world = routing([GPT], picks);
    const { tasks, calls } = scripted();
    await withWorker(
      env,
      world,
      async (q) => {
        const h = await start(q, input());
        const s = await pollQuery(
          () => statusOf(h),
          (st) => st.waiting?.kind === 'slot',
          '界面单没有非 GPT 的路由，在等',
        );
        expect(s.waiting?.detail).toContain('派不出');
        await h.signal(taskAbandonSignal, { by: 'frank', reason: '测完了' });
        await h.result();
      },
      { tasks },
    );
    expect(calls.segment).toHaveLength(0);
    expect(picks.length).toBeGreaterThanOrEqual(1);
    expect(picks.every((p) => p.stage === 'ui' && p.uiWork === true)).toBe(true);
  });

  it('非界面单（只写了后端路径）：照旧按 execute 选、不带 uiWork，GPT 照常派，状态里没有「没认出」', async () => {
    const picks: PickRouteInput[] = [];
    const world = routing([GPT, OPUS], picks);
    const { tasks, calls } = scripted({
      brief: briefWith(['`packages/engine/src/real/store-ports.ts`：选路'], BACKEND_BODY),
      delivery: (n) => ({ head: fakeHead(100 + n), commits: 1, changedFiles: ['packages/engine/src/a.ts'] }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(picks[0]).toMatchObject({ stage: 'execute' });
    expect(picks[0]).not.toHaveProperty('uiWork');
    expect(calls.segment.map((s) => s.route.routeId)).toEqual(['r-gpt']);
    expect(world.states.map((s) => s.doing).join('\n')).not.toContain('没认出是不是界面活');
  });

  it('【故意造出的失败】判不出（已知的模块没写出路径、正文也没有）：按界面活处理，不派 GPT，动手状态里写明', async () => {
    const picks: PickRouteInput[] = [];
    const world = routing([GPT, OPUS], picks);
    const { tasks, calls } = scripted({ brief: briefWith(['驾驶舱页面'], NO_PATH_BODY) });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run.outcome).toBe('merged');
    expect(picks[0]).toMatchObject({ stage: 'ui', uiWork: true });
    expect(calls.segment.map((s) => s.route.routeId)).toEqual(['r-opus']);
    expect(world.states.some((s) => s.doing.includes('没认出是不是界面活，按界面活处理'))).toBe(true);
  });

  it('后端单第 1 轮派 GPT；上一轮改到了页面文件（CI 红了返工）：第 2 轮按界面活选，GPT 不派', async () => {
    const picks: PickRouteInput[] = [];
    const world = routing([GPT, OPUS], picks, {
      ci: (_i, n) => (n === 1 ? { state: 'red', failedChecks: ['test (web)'], digest: 'FAIL' } : undefined),
    });
    const { tasks, calls } = scripted({
      brief: briefWith(['`packages/engine/src/a.ts`：引擎'], BACKEND_BODY),
      delivery: (n) => ({
        head: fakeHead(100 + n),
        commits: 1,
        changedFiles:
          n === 1
            ? ['packages/engine/src/a.ts', 'packages/web/src/pages/x.tsx']
            : ['packages/engine/src/a.ts'],
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(calls.segment.map((s) => s.route.routeId)).toEqual(['r-gpt', 'r-opus']);
    expect(picks[0]).toMatchObject({ stage: 'execute' });
    expect(picks[1]).toMatchObject({ stage: 'ui', uiWork: true });
  });
});
