import { REALTIME_TABLES, type SessionRun } from '@fleet-dao/shared';
import { describe, expect, test } from 'vitest';
import { ApiError } from '../client';
import type { LiveEvent } from '../types';
import { fakeUsage } from './seed';
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

describe('假后端：任务详情的用量汇总', () => {
  test('和真后端同一个算法：结束的会话进 runs、在跑的进 running，按模型、按阶段各数一遍都对得上', async () => {
    const d = await fresh().task('t-12');
    const { total, byModel, byStage } = d.usage;
    // t-12 也有三段流水（主页流水线图的演示数据）：合计 = 老式会话 + 三段各一笔
    const all = d.runs.length + d.segmentRuns.length;
    expect(total.runs + total.running).toBe(all);
    expect(total.running).toBe(
      d.runs.filter((r) => !r.endedAt).length + d.segmentRuns.filter((r) => r.running).length,
    );
    expect(byModel.reduce((n, m) => n + m.runs + m.running, 0)).toBe(all);
    expect(byStage.reduce((n, s) => n + s.runs + s.running, 0)).toBe(d.runs.length);
    expect(byModel.every((m) => m.modelName !== '')).toBe(true);
  });

  test('演示数据看得到「没读到」长什么样：没交终帧的会话、缓存没存下来的会话、不报花费的 Grok；花费分得出按量和套餐内', async () => {
    const d = await fresh().task('t-12');
    const { total } = d.usage;
    expect(total).toMatchObject({
      runs: 7,
      running: 2,
      missingTokens: 1,
      missingCache: 2,
      missingEquivalent: 2,
    });
    expect(total.cost).toEqual({
      metered: expect.objectContaining({ runs: 1, missing: 0 }),
      subscription: expect.objectContaining({ runs: 6, missing: 2 }),
      unknown: { runs: 0, usd: 0, missing: 0 },
    });
    // 会话也带着计费方式（和真后端一样从渠道表读）
    expect(d.runs.find((r) => r.routeId === 'r-ds')?.billing).toBe('metered');
    expect(d.runs.find((r) => r.routeId === 'r-grok')?.billing).toBe('subscription');
  });

  test('三段的演示单 t-c9：每一笔过 readSegmentRun，按单号兜底的、没记缓存和花费的都看得到', async () => {
    const d = await fresh().task('t-c9');
    expect(d.runs).toEqual([]);
    expect(d.segmentRuns.map((r) => [r.id, r.segment, r.matchedBy])).toEqual([
      ['seg-c9-1', 'scope', 'task'],
      ['seg-c9-2', 'manual', 'task'],
      ['seg-c9-3', 'manual', 'task'],
      ['seg-c9-4', 'verify', 'issueNumber'],
    ]);
    expect(d.segmentRuns.find((r) => r.id === 'seg-c9-2')?.unread.map((n) => n.item)).toEqual([
      'tokens',
      'cost',
    ]);
    expect(d.usage.total).toMatchObject({
      runs: 4,
      running: 0,
      missingTokens: 0,
      missingCache: 1,
      noQueue: 4,
    });
    expect(d.usage.total.cost.subscription).toMatchObject({ runs: 4, missing: 2 });
    expect(d.usage.bySegment.map((s) => [s.segment, s.byModel.map((m) => m.model)])).toEqual([
      ['scope', ['opus-5.5']],
      ['manual', ['kimi-k3', 'opus-5.5']],
      ['verify', ['gpt-5.6-luna']],
    ]);
  });

  test('别的演示单结束了的会话用量都读得到：「没读到」只在专门演示的两张单上（t-12 老会话、t-c9 三段）', async () => {
    const api = fresh();
    for (const t of api.state().tasks.filter((x) => x.task.id !== 't-12' && x.task.id !== 't-c9')) {
      const { total } = (await api.task(t.task.id)).usage;
      expect([t.task.id, total.missingTokens, total.missingCache], t.task.id).toEqual([t.task.id, 0, 0]);
    }
  });
});

describe('假数据的用量：照各家终帧实际报什么编', () => {
  const ended = (): SessionRun => ({
    id: 'r',
    stage: 'execute',
    routeId: 'x',
    whyRoute: '',
    queuedAt: '2026-09-27T01:00:00.000Z',
    startedAt: '2026-09-27T01:01:00.000Z',
    endedAt: '2026-09-27T01:11:00.000Z',
    inputTokens: 10_000,
    outputTokens: 1000,
  });

  test('Claude Code 补缓存读写和花费（套餐内也报，是折合价）；按量的接口报花费', () => {
    const claude = ended();
    fakeUsage(claude, { hostId: 'claude-code', modelId: 'opus-5.5', billing: 'subscription' });
    expect(claude).toMatchObject({ cacheReadTokens: 90_000, cacheWriteTokens: 4500 });
    expect(claude.costUsd).toBeGreaterThan(0);
    const metered = ended();
    fakeUsage(metered, { hostId: 'api-shell', modelId: 'deepseek-v4.1-flash', billing: 'metered' });
    expect(metered.costUsd).toBeGreaterThan(0);
  });

  test('cursor、Grok、中转站只报 token 不报花费；没读到 token 的什么都不补；点名没读到的那几样留空', () => {
    for (const hostId of ['cursor-agent', 'grok', 'mirasim'] as const) {
      const r = ended();
      fakeUsage(r, { hostId, billing: 'subscription' });
      expect(r.cacheReadTokens, hostId).toBeGreaterThan(0);
      expect(r.costUsd, hostId).toBeUndefined();
    }
    const { inputTokens: _in, outputTokens: _out, ...blank }: SessionRun = ended();
    fakeUsage(blank, { hostId: 'claude-code', billing: 'subscription' });
    expect([blank.cacheReadTokens, blank.cacheWriteTokens, blank.costUsd]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const old = ended();
    fakeUsage(old, { hostId: 'claude-code', billing: 'subscription' }, ['cache']);
    expect([old.cacheReadTokens, old.cacheWriteTokens]).toEqual([undefined, undefined]);
    expect(old.costUsd).toBeGreaterThan(0);
  });
});

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

  test('现在就换（#1216）：动手在跑的 t-12 能换并记 task.repin；【故意造出的失败】验收段、没在跑动手的 t-14 都 409 且指定不动', async () => {
    const api = fresh();
    const ok = await api.updateTaskRoutePin('t-12', { segment: 'manual', modelId: 'kimi-k3', now: true });
    expect(ok).toMatchObject({ segment: 'manual', modelId: 'kimi-k3' });
    expect((await api.audit()).items.map((i) => i.action)).toContain('task.repin');

    const verify = await rejects(
      api.updateTaskRoutePin('t-12', { segment: 'verify', modelId: 'grok-4.7', now: true }),
    );
    expect([verify.status, verify.code]).toEqual([409, 'repin_segment_unsupported']);
    const notRunning = await rejects(
      api.updateTaskRoutePin('t-14', { segment: 'manual', modelId: 'kimi-k3', now: true }),
    );
    expect([notRunning.status, notRunning.code]).toEqual([409, 'segment_not_running']);
    const pins = (await api.task('t-14')).routePins.pins;
    expect(pins.find((p) => p.segment === 'manual')?.modelId).toBe('kimi-k3'); // 种子里本来就是 Kimi，没被这次改动
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

describe('假后端：路由两层', () => {
  // 改阶段顺序那个接口整条删了（#754）：旧的按阶段平铺表没人读，先后看路由两层（routingLayers()）。
  // 这里钉住「选路照路由两层走」，包括其中一条：UI 用途的模型顺序里没有 GPT，写死的禁令挡着。
  test('UI 用途的模型顺序里没有 GPT：这条禁令写死在代码里，路由两层里也看不到它', async () => {
    const api = fresh();
    const layers = await api.routingLayers();
    const ui = layers.purposes.find((p) => p.purpose === 'ui');
    if (!ui) throw new Error('没有 ui 用途');
    expect(ui.models.map((m) => m.family)).not.toContain('gpt');
  });
});

describe('假后端：指挥官整理待办', () => {
  test('orbit 有一次做成、一次没做成，今日剩余 1/3，没有正在做的', async () => {
    const s = await fresh().groomStatus('r-orbit');
    expect(s.repo).toBe('acme/orbit');
    expect(s.quota).toMatchObject({ used: 2, remaining: 1, max: 3 });
    expect(s.busy).toBe(false);
    expect(s.recent.map((r) => r.state)).toEqual(['done', 'failed']);
    expect(s.recent[0]?.result?.opened.map((o) => o.number)).toEqual([1402]);
    expect(s.recent[1]?.why).toContain('选不到路由');
  });

  test('别的仓还没整理过，剩余是满的', async () => {
    const s = await fresh().groomStatus('r-canary');
    expect(s.recent).toEqual([]);
    expect(s.quota).toMatchObject({ used: 0, remaining: 3, max: 3 });
    expect(s.busy).toBe(false);
  });

  test('总开关关着点整理：409，不记成点过', async () => {
    const api = fresh();
    const err = await rejects(api.groomNow('r-orbit', {}));
    expect(err.status).toBe(409);
    expect(err.code).toBe('engine_off');
    expect(err.message).toContain('引擎总开关关着');
    expect((await api.groomStatus('r-orbit')).busy).toBe(false);
  });

  test('总开关开着点一下就排队；再点说已经有一次在做', async () => {
    const api = fresh();
    const version = (await api.settings()).settings.find((s) => s.key === 'engine.master')?.version ?? 0;
    await api.updateSetting('engine.master', { value: true, version });
    const first = await api.groomNow('r-orbit', { reason: '老单堆了' });
    expect(first.request).toMatchObject({ repo: 'acme/orbit', source: 'http', state: 'queued' });
    expect(first.remainingAfter).toBe(0);
    const status = await api.groomStatus('r-orbit');
    expect(status.busy).toBe(true);
    expect(status.recent[0]?.requestId).toBe(first.request.requestId);
    const again = await rejects(api.groomNow('r-canary', {}));
    expect(again.status).toBe(409);
    expect(again.code).toBe('groom_busy');
    expect(again.message).toContain('已经有一次整理在');
  });

  test('没有这个仓：404', async () => {
    const err = await rejects(fresh().groomStatus('no-such'));
    expect(err).toMatchObject({ status: 404, code: 'repo_not_found' });
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
