// PR 说明的「做了什么」取动手会话最后一条回复（#2723）：开 PR 时写进去，第 2 轮起推上去后更新这一段；回复太长截断。
// 真 Temporal 测试服务端 + 假端口 + 脚本化的任务活动。

import { randomUUID } from 'node:crypto';
import { renderPrBody } from '@fleet-dao/github';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { WorkflowHandle } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES } from '../src/contract.ts';
import { createFakeWorld } from '../src/fakes.ts';
import type { TaskRun, TaskWorkflowInput } from '../src/task-contract.ts';
import {
  PR_DID_ANSWER_LINES,
  PR_DID_ANSWER_MAX,
  sessionDidLines,
  shotsPrLines,
  taskPrDid,
} from '../src/workflows/task-support.ts';
import { freshRepo, useEnv, withWorker } from './helpers.ts';
import { scripted } from './task-script.ts';

const currentEnv = useEnv();
let env: TestWorkflowEnvironment;
beforeEach(() => {
  env = currentEnv();
});

function input(over: Partial<TaskWorkflowInput> = {}): TaskWorkflowInput {
  return {
    schemaVersion: 1,
    taskId: randomUUID(),
    repo: freshRepo(),
    issueNumber: 12,
    title: '给驾驶舱加状态',
    ...over,
  };
}

async function start(q: string, i: TaskWorkflowInput): Promise<WorkflowHandle> {
  return env.client.workflow.start(WORKFLOW_TYPES.task, {
    taskQueue: q,
    workflowId: taskWorkflowId(i.repo, i.issueNumber, 1),
    args: [i],
  });
}

describe('会话最后一条回复进 PR 说明（#2723）', () => {
  it('回复按行进「做了什么」：列表记号去掉、空行不要；多出的行并进最后一条，不丢', () => {
    const lines = Array.from({ length: PR_DID_ANSWER_LINES + 3 }, (_v, i) => `- 第 ${i + 1} 条`);
    const did = sessionDidLines(`\n${lines.join('\n\n')}\n`);
    expect(did).toHaveLength(PR_DID_ANSWER_LINES);
    expect(did[0]).toBe('第 1 条');
    expect(did.at(-1)).toContain(`第 ${PR_DID_ANSWER_LINES + 3} 条`);
    expect(sessionDidLines('   ')).toEqual([]);
    expect(sessionDidLines(undefined)).toEqual([]);
  });

  it('【故意造出的失败】回复长得离谱：截断并写明后面还有多少字', () => {
    const did = sessionDidLines(`做了 ${'x'.repeat(PR_DID_ANSWER_MAX * 5)}`);
    expect(did.join('').length).toBeLessThan(PR_DID_ANSWER_MAX + 100);
    expect(did.join('')).toMatch(/还有 \d+ 个字，已截断/);
  });

  it('taskPrDid 带上回复：原来两句在前，回复跟在后面；没有回复照旧两句', () => {
    expect(taskPrDid(12, 1, 2, '验收条 1：做到了\n欠：无')).toEqual([
      '按 #12 的要求动手（第 1 轮）',
      '改了 2 个文件',
      '验收条 1：做到了',
      '欠：无',
    ]);
    expect(taskPrDid(12, 1, 2)).toEqual(['按 #12 的要求动手（第 1 轮）', '改了 2 个文件']);
  });
});

describe('开 PR、第 2 轮更新 PR 说明（#2723）', { timeout: 60_000 }, () => {
  it('第 1 轮开 PR 写第 1 轮会话的回复；CI 红返工，第 2 轮推上去后把说明换成第 2 轮的回复', async () => {
    const world = createFakeWorld({
      ci: (_i, n) =>
        n === 1 ? { state: 'red', failedChecks: ['test (engine)'], digest: 'FAIL x' } : undefined,
    });
    const { tasks } = scripted({
      segment: async (_i, n) => ({
        ok: true,
        runId: `run-${n}`,
        answer: n === 1 ? '验收条 1：页面上有「验收中」\n欠：无' : '修了 CI：x.test.ts 少的一行补上了',
      }),
    });
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    const opened = world.callsOf('openPr')[0]?.input.body.did ?? [];
    expect(opened).toContain('验收条 1：页面上有「验收中」');
    expect(opened).toContain('欠：无');
    const updates = world.callsOf('updatePrBody');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.input.prNumber).toBe(run.prNumber);
    expect(updates[0]?.input.body.requirement).toBe(12);
    expect(updates[0]?.input.body.did).toContain('按 #12 的要求动手（第 2 轮）');
    expect(updates[0]?.input.body.did).toContain('修了 CI：x.test.ts 少的一行补上了');
    expect(updates[0]?.input.body.did).not.toContain('欠：无');
  });

  it('【故意造出的失败】更新说明没写成：不挡原流程，照旧等 CI、合并', async () => {
    const world = createFakeWorld({
      ci: (_i, n) =>
        n === 1 ? { state: 'red', failedChecks: ['test (engine)'], digest: 'FAIL x' } : undefined,
      failFirst: { updatePrBody: 99 },
    });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 2 });
    expect(world.count('updatePrBody')).toBeGreaterThan(0);
    expect(world.alerts).toEqual([]);
  });
});

describe('合并收树后 PR 说明分开写代码和截图交付（#2983）', { timeout: 60_000 }, () => {
  const HEAD = 'a'.repeat(40);
  const file = {
    path: '2969/home.png',
    bytes: 10,
    sha256: 'c'.repeat(64),
    blob: 'd'.repeat(40),
    from: 'tree',
  };
  const base = { head: HEAD, branch: 'shots/2969', files: [file] };
  const render = (lines: { verified: string[]; owed: string[] }) =>
    renderPrBody({
      did: ['x'],
      verified: lines.verified,
      ...(lines.owed.length ? { owed: lines.owed } : {}),
    });

  it('已交付：进「怎么验证的」，按远端读到的写；「还欠什么」是无', () => {
    const lines = shotsPrLines(7, 'e'.repeat(40), {
      ...base,
      outcome: 'delivered',
      remoteHead: 'f'.repeat(40),
    });
    expect(lines?.verified[0]).toBe('代码：PR #7 已合并（eeeeeee），CI 和冷验收看这个 PR 的检查');
    expect(lines?.verified[1]).toContain('1 张在远端 shots/2969（fffffff）按 blob 号核对过，已交付');
    expect(lines?.owed).toEqual([]);
    expect(render(lines as { verified: string[]; owed: string[] })).toContain('**还欠什么**：无');
  });

  it('待交付（只在受限归档里）：代码一句照写，图片进「还欠什么」，不写「无」', () => {
    const lines = shotsPrLines(7, undefined, {
      ...base,
      outcome: 'archived',
      reason: '远端没有 shots/2969（404），图片没交付',
      archivedTo: '/state/archive/t/shots/x/manifest.json',
    });
    expect(lines?.verified).toEqual(['代码：PR #7 已合并，CI 和冷验收看这个 PR 的检查']);
    expect(lines?.owed[0]).toContain(
      '界面截图待交付：1 张没在远端 shots/2969 读到（远端没有 shots/2969（404）',
    );
    expect(lines?.owed[0]).toContain('/state/archive/t/shots/x/manifest.json');
    const body = render(lines as { verified: string[]; owed: string[] });
    expect(body).not.toContain('**还欠什么**：无');
    expect(body).toContain('界面截图待交付');
  });

  it('【故意造出的失败】失败（树留着）和不知道（没有核对记录）：都进「还欠什么」', () => {
    const failed = shotsPrLines(7, undefined, { ...base, outcome: 'failed', reason: '图片归档满了' });
    expect(failed?.owed[0]).toContain(
      '界面截图交付失败：1 张没交付也没存档成（图片归档满了），工作树留着没删',
    );
    const unknown = shotsPrLines(7, undefined, { ...base, files: [], outcome: 'unknown', reason: '没记录' });
    expect(unknown?.owed[0]).toContain('界面截图交没交付不知道：没记录');
    expect(shotsPrLines(7, undefined, { ...base, files: [], outcome: 'none' })).toBeNull();
  });

  it('合并后收树：截图待交付就改一次 PR 说明写进「还欠什么」；收树带着推上去的头', async () => {
    const world = createFakeWorld({
      shots: () => ({ outcome: 'archived', files: [file], reason: '远端没有 shots/12（404），图片没交付' }),
    });
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged', rounds: 1 });
    expect(world.callsOf('removeWorktree')[0]?.input.shots).toEqual({ issueNumber: 12, head: run.head });
    const updates = world.callsOf('updatePrBody');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.input.body.owed?.[0]).toContain('界面截图待交付');
    expect(updates[0]?.input.body.verified[0]).toContain(`代码：PR #${run.prNumber} 已合并`);
  });

  it('没有受管图片：不多改 PR 说明', async () => {
    const world = createFakeWorld();
    const { tasks } = scripted();
    const run = await withWorker(
      env,
      world,
      async (q) => (await start(q, input())).result() as Promise<TaskRun>,
      { tasks },
    );
    expect(run).toMatchObject({ outcome: 'merged' });
    expect(world.count('updatePrBody')).toBe(0);
  });
});
