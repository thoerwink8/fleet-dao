import { REALTIME_TABLES } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';
import { ApiError } from '../client';
import type { LiveEvent } from '../types';
import { createMockApi } from './server';

// 假后端是页面在没有真后端时的「对手」：返回都按 shared/web-api.ts 校验，报错的 code 照真后端。
// 这里钉住页面依赖的几条行为。
const NOW = Date.parse('2026-09-25T10:00:00Z');
const fresh = () => createMockApi({ live: false, now: () => NOW });

async function rejects(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('本该报错，却成功了');
}

describe('假后端：发给工作流的信号', () => {
  test('换子任务的路由：旧会话停下，新会话写明是谁手动换的', async () => {
    const api = fresh();
    await api.taskAction('t-12', { action: 'reroute', routeId: 'r-rl-opus', subtaskId: 't-12-b' });
    const d = await api.task('t-12');
    const runs = d.runs.filter((r) => r.subtaskId === 't-12-b');
    const active = runs.filter((r) => !r.endedAt);
    expect(active.map((r) => r.routeId)).toEqual(['r-rl-opus']);
    expect(active[0]?.whyRoute).toBe('阿岚手动换成 Opus 5.5');
    expect(runs.find((r) => r.routeId === 'r-cb-opus')?.outcome).toBe('stopped');
  });

  test('换到犯禁令的路由：422 route_not_allowed，白话写明原因', async () => {
    const api = fresh();
    const e = await rejects(
      api.taskAction('t-12', { action: 'reroute', routeId: 'r-rl-fable', subtaskId: 't-12-b' }),
    );
    expect(e.status).toBe(422);
    expect(e.code).toBe('route_not_allowed');
    expect(e.message).toContain('不用 Fable');
  });

  test('结束了的任务不再接信号：409 task_finished', async () => {
    const e = await rejects(fresh().taskAction('t-11', { action: 'pause' }));
    expect(e.status).toBe(409);
    expect(e.code).toBe('task_finished');
  });

  test('没有在跑的会话就换不了：409 no_active_run', async () => {
    const e = await rejects(fresh().taskAction('t-18', { action: 'reroute', routeId: 'r-ca-opus' }));
    expect(e.code).toBe('no_active_run');
  });

  test('每个操作都先留操作记录：谁、做了什么、对哪个需求', async () => {
    const api = fresh();
    await api.taskAction('t-12', { action: 'pause', reason: '先看一下' });
    const { items } = await api.audit();
    expect(items[0]).toMatchObject({
      action: 'task.pause',
      target: 'task:t-12',
      actor: { kind: 'user', id: 'u-lan' },
      reason: '先看一下',
      via: 'cockpit',
      ok: true,
    });
  });
});

describe('假后端：追问', () => {
  test('回答后追问变成已回答，需求接着写方案；同一条不能答两次', async () => {
    const api = fresh();
    const before = await api.task('t-15');
    const ask = before.asks.find((a) => a.status === 'pending');
    if (!ask) throw new Error('t-15 没有待回答的追问');
    await api.answerAsk(ask.id, '只取消置顶');
    const after = await api.task('t-15');
    expect(after.asks.find((a) => a.id === ask.id)).toMatchObject({
      status: 'answered',
      answer: '只取消置顶',
      answeredBy: 'u-lan',
    });
    expect(after.task.state).toBe('planning');
    const again = await rejects(api.answerAsk(ask.id, '再答一次'));
    expect(again.code).toBe('already_answered');
  });
});

describe('假后端：调度台', () => {
  test('按「改之前看到的样子」保存；别人先改了就 409，不悄悄盖掉', async () => {
    const api = fresh();
    const seen = (await api.routing()).stages.find((s) => s.stage === 'review');
    if (!seen) throw new Error('没有 review 阶段');
    const reversed = [...seen.routeIds].reverse();
    await api.updateStagePolicy('review', {
      routeIds: reversed,
      pinned: seen.pinned,
      expected: { routeIds: seen.routeIds, pinned: seen.pinned },
    });
    const stale = await rejects(
      api.updateStagePolicy('review', {
        routeIds: seen.routeIds,
        pinned: true,
        expected: { routeIds: seen.routeIds, pinned: seen.pinned },
      }),
    );
    expect(stale.status).toBe(409);
    expect(stale.code).toBe('conflict');
    const now = (await api.routing()).stages.find((s) => s.stage === 'review');
    expect(now?.routeIds).toEqual(reversed);
    const { items } = await api.audit({ target: 'stage:review' });
    expect(items[0]).toMatchObject({
      action: 'stage_policy.update',
      before: { routeIds: seen.routeIds, pinned: seen.pinned },
      after: { routeIds: reversed, pinned: seen.pinned },
    });
  });

  test('UI 阶段放不进 GPT：写死的禁令，422', async () => {
    const api = fresh();
    const ui = (await api.routing()).stages.find((s) => s.stage === 'ui');
    if (!ui) throw new Error('没有 ui 阶段');
    const e = await rejects(
      api.updateStagePolicy('ui', {
        routeIds: [...ui.routeIds, 'r-rl-gpt'],
        pinned: ui.pinned,
        expected: { routeIds: ui.routeIds, pinned: ui.pinned },
      }),
    );
    expect(e.code).toBe('route_not_allowed');
    expect(e.message).toContain('GPT 不做 UI 类活');
  });
});

describe('假后端：设置', () => {
  test('带版本号保存；版本对不上就 409', async () => {
    const api = fresh();
    const s = (await api.settings()).settings.find((x) => x.key === 'sessions.maxConcurrent');
    if (!s) throw new Error('没有 sessions.maxConcurrent');
    const saved = await api.updateSetting('sessions.maxConcurrent', { value: 8, version: s.version });
    expect(saved).toMatchObject({ value: 8, version: s.version + 1, updatedBy: 'u-lan' });
    const e = await rejects(api.updateSetting('sessions.maxConcurrent', { value: 9, version: s.version }));
    expect(e.code).toBe('conflict');
  });

  test('值不符合约定就拒收', async () => {
    const e = await rejects(fresh().updateSetting('sessions.maxConcurrent', { value: 99, version: 3 }));
    expect(e.code).toBe('invalid_request');
  });
});

describe('假后端：实时推送', () => {
  test('只推 shared/realtime.ts 名单里的表（和真后端一样），操作会推对应的表', async () => {
    let clock = NOW;
    const api = createMockApi({ live: false, now: () => clock });
    const tables = new Set<string>();
    api.subscribe((e: LiveEvent) => {
      if (e.type === 'change') tables.add(e.table);
    });
    await api.taskAction('t-12', { action: 'pause' });
    expect(tables.has('tasks')).toBe(true);
    expect(tables.has('audit_log')).toBe(true);
    for (let i = 0; i < 200; i++) {
      clock += 2600;
      api.tick();
    }
    const allowed: readonly string[] = REALTIME_TABLES;
    expect([...tables].filter((t) => !allowed.includes(t))).toEqual([]);
  });

  test('模拟器连跑 300 拍不出错，返回照样过校验，而且盘面真的在往前走', async () => {
    let clock = NOW;
    const api = createMockApi({ live: false, now: () => clock });
    const before = await api.board('r-orbit');
    for (let i = 0; i < 300; i++) {
      clock += 2600;
      api.tick();
    }
    const after = await api.board('r-orbit');
    expect(JSON.stringify(after.tasks)).not.toBe(JSON.stringify(before.tasks));
    const merged = (b: typeof before) =>
      b.tasks.flatMap((t) => t.subtasks).filter((s) => s.state === 'merged').length;
    expect(merged(after)).toBeGreaterThan(merged(before));
    await expect(api.pools()).resolves.toBeTruthy();
    await expect(api.jobs()).resolves.toBeTruthy();
  });
});
