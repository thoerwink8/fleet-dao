// 任务接口的 flowMode（#2828）：详情、列表、首页在跑。有 tasks.flow_mode 才带 three / full；没有这个键不补、不猜。

import type { Task } from '@fleet-dao/shared';
import { HomeResponseSchema, TaskDetailResponse, TaskListResponse, TaskSchema } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { harness, IDS, T0 } from './harness.ts';

function extra(n: number, over: Partial<Task> = {}): Task {
  return {
    id: `b1000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    repoId: IDS.repo,
    issueNumber: n,
    title: `任务 ${n}`,
    rawRequest: `任务 ${n}`,
    requestedBy: IDS.founderA,
    state: 'running',
    priority: n,
    createdAt: new Date(T0.getTime() - n * 60_000).toISOString(),
    ...over,
  };
}

describe('任务接口的 flowMode', () => {
  it('详情、列表、首页在跑：有值才带 flowMode，老单没有这个键；只收 three / full', async () => {
    const h = harness();
    const task12 = h.store.data.tasks.find((t) => t.id === IDS.task12);
    const task13 = h.store.data.tasks.find((t) => t.id === IDS.task13);
    if (!task12 || !task13) throw new Error('样例数据里没有任务');
    task12.flowMode = 'full';
    task13.flowMode = 'three';
    h.store.data.tasks.push(extra(30));
    const { cookie } = await h.login();
    const headers = { cookie };

    const detailRes = await h.cockpit.request(`/api/tasks/${IDS.task12}`, { headers });
    expect(detailRes.status).toBe(200);
    const detail = TaskDetailResponse.parse(await detailRes.json());
    expect(detail.task.flowMode).toBe('full');

    const oldRes = await h.cockpit.request(
      `/api/tasks/${h.store.data.tasks.find((t) => t.issueNumber === 30)?.id}`,
      { headers },
    );
    expect(oldRes.status).toBe(200);
    const oldDetail = (await oldRes.json()) as { task: Record<string, unknown> };
    expect(TaskDetailResponse.parse(oldDetail).task).not.toHaveProperty('flowMode');
    expect(Object.hasOwn(oldDetail.task, 'flowMode')).toBe(false);

    const doneRes = await h.cockpit.request(`/api/tasks/${IDS.task13}`, { headers });
    expect(TaskDetailResponse.parse(await doneRes.json()).task.flowMode).toBe('three');

    const listRes = await h.cockpit.request('/api/tasks?limit=100', { headers });
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as { items: { issueNumber: number }[] };
    const list = TaskListResponse.parse(listJson);
    expect(list.items.find((i) => i.issueNumber === 12)?.flowMode).toBe('full');
    expect(list.items.find((i) => i.issueNumber === 13)?.flowMode).toBe('three');
    const oldRow = listJson.items.find((i) => i.issueNumber === 30);
    if (!oldRow) throw new Error('列表里没有 30');
    expect(Object.hasOwn(oldRow, 'flowMode')).toBe(false);

    const homeRes = await h.cockpit.request('/api/home', { headers });
    expect(homeRes.status).toBe(200);
    const homeJson = (await homeRes.json()) as { running: { issueNumber: number }[] };
    const home = HomeResponseSchema.parse(homeJson);
    expect(home.running.find((r) => r.issueNumber === 12)?.flowMode).toBe('full');
    expect(home.running.find((r) => r.issueNumber === 13)).toBeUndefined();
    const oldCard = homeJson.running.find((r) => r.issueNumber === 30);
    if (!oldCard) throw new Error('首页在跑里没有 30');
    expect(Object.hasOwn(oldCard, 'flowMode')).toBe(false);

    const base = TaskSchema.parse(detail.task);
    expect(TaskSchema.safeParse({ ...base, flowMode: 'split' }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...base, flowMode: null }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...base, flowMode: 'full' }).success).toBe(true);
    const without = { ...base };
    delete without.flowMode;
    expect(TaskSchema.parse(without)).not.toHaveProperty('flowMode');
  });

  it('不合格退回三段才带 flowFallback；开关就是三步法、没分组、走全程都不带', async () => {
    const h = harness();
    const reason = '选中的路由是 grok-4，第一期全程只走 Claude 5.5（Sonnet 或 Opus）';
    await h.store.writeFlowAssignmentOnce({
      taskId: IDS.task12,
      mode: 'three',
      source: 'ineligible',
      stratum: 'standard/grok-4',
      reason,
    });
    const bySetting = extra(31);
    const plain = extra(32, { flowMode: 'three' });
    const full = extra(33);
    h.store.data.tasks.push(bySetting, plain, full);
    await h.store.writeFlowAssignmentOnce({
      taskId: bySetting.id,
      mode: 'three',
      source: 'ineligible',
      stratum: 'x',
      reason: 'engine.flowMode 是 three：都走三段',
    });
    await h.store.writeFlowAssignmentOnce({
      taskId: full.id,
      mode: 'full',
      source: 'hash',
      stratum: 'x',
    });
    const { cookie } = await h.login();
    const headers = { cookie };
    const taskOf = async (id: string) =>
      TaskDetailResponse.parse(await (await h.cockpit.request(`/api/tasks/${id}`, { headers })).json()).task;

    const back = await taskOf(IDS.task12);
    expect(back.flowMode).toBe('three');
    expect(back.flowFallback).toBe(reason);
    const settingThree = await taskOf(bySetting.id);
    expect(settingThree.flowMode).toBe('three');
    expect(settingThree).not.toHaveProperty('flowFallback');
    const untouched = await taskOf(plain.id);
    expect(untouched.flowMode).toBe('three');
    expect(untouched).not.toHaveProperty('flowFallback');
    const wentFull = await taskOf(full.id);
    expect(wentFull.flowMode).toBe('full');
    expect(wentFull).not.toHaveProperty('flowFallback');

    const list = TaskListResponse.parse(
      await (await h.cockpit.request('/api/tasks?limit=100', { headers })).json(),
    );
    expect(list.items.find((i) => i.issueNumber === 12)?.flowFallback).toBe(reason);
    expect(list.items.find((i) => i.issueNumber === 31)).not.toHaveProperty('flowFallback');
    expect(list.items.find((i) => i.issueNumber === 32)).not.toHaveProperty('flowFallback');
    expect(list.items.find((i) => i.issueNumber === 33)?.flowMode).toBe('full');
    expect(list.items.find((i) => i.issueNumber === 33)).not.toHaveProperty('flowFallback');

    const home = HomeResponseSchema.parse(await (await h.cockpit.request('/api/home', { headers })).json());
    expect(home.running.find((r) => r.issueNumber === 12)?.flowFallback).toBe(reason);
    expect(home.running.find((r) => r.issueNumber === 31)).not.toHaveProperty('flowFallback');
    expect(home.running.find((r) => r.issueNumber === 33)?.flowMode).toBe('full');
    expect(home.running.find((r) => r.issueNumber === 33)).not.toHaveProperty('flowFallback');
  });
});
