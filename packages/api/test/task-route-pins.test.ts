// 单子页「用哪个模型」的接口（驾驶舱改版 2026-10-07）：任务详情带每段的指定；改一段（指定 / 钉路由 / 清掉）写库并记操作记录；
// 结束了的单、目录里没有的模型、别的模型的路由都拒，库里不动；没接上（内存版）详情写 unavailable、改回 503，不冒充「没指定」。
import { auditLog, readTaskRoutePin } from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { TaskDetailResponse, UpdateTaskRoutePinResponse } from '@fleet-dao/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pgTaskRoutePins, TASK_ROUTE_PINS_NOT_HERE, type TaskRoutePinsPort } from '../src/task-route-pins.ts';
import { errorCode, type Harness, harness, IDS, pgHarness, T0, write } from './harness.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let current: Awaited<ReturnType<typeof pgHarness>> | undefined;
afterEach(async () => {
  await current?.stop();
  current = undefined;
});

const put = (
  h: Pick<Harness, 'cockpit'>,
  s: { cookie: string; csrf: string },
  taskId: string,
  body: unknown,
) => h.cockpit.request(`/api/tasks/${taskId}/route-pin`, write('PUT', s, body));

async function detail(h: Pick<Harness, 'cockpit'>, cookie: string, taskId: string) {
  const res = await h.cockpit.request(`/api/tasks/${taskId}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return TaskDetailResponse.parse(await res.json());
}

const audits = async () =>
  (await t.db.select().from(auditLog)).filter((a) => a.action.startsWith('task.routePin'));

describe('单子页指定模型：真库', () => {
  it('指定动手用 GPT、验收钉一条 Opus 路由，详情读得到；清掉动手的回到自动；每次都记操作记录', async () => {
    current = await pgHarness(t, { taskRoutePins: pgTaskRoutePins(t.db, () => T0) });
    const s = await current.login();
    expect((await detail(current, s.cookie, IDS.task12)).routePins).toEqual({ pins: [] });

    const set = await put(current, s, IDS.task12, {
      segment: 'manual',
      modelId: 'gpt-5.6',
      reason: '试试 GPT',
    });
    expect(set.status).toBe(200);
    expect(UpdateTaskRoutePinResponse.parse(await set.json())).toMatchObject({
      segment: 'manual',
      modelId: 'gpt-5.6',
      reason: '试试 GPT',
    });
    expect(
      (
        await put(current, s, IDS.task12, {
          segment: 'verify',
          modelId: 'opus-5.5',
          routeId: 'rt-claude-opus',
        })
      ).status,
    ).toBe(200);
    const pins = (await detail(current, s.cookie, IDS.task12)).routePins;
    expect(pins.unavailable).toBeUndefined();
    expect(pins.pins.map((p) => [p.segment, p.modelId, p.routeId])).toEqual([
      ['manual', 'gpt-5.6', undefined],
      ['verify', 'opus-5.5', 'rt-claude-opus'],
    ]);

    expect((await put(current, s, IDS.task12, { segment: 'manual', modelId: null })).status).toBe(200);
    expect(await readTaskRoutePin(t.db, IDS.task12, 'manual')).toMatchObject({ modelId: null });
    expect((await audits()).map((a) => [a.action, a.after])).toEqual([
      ['task.routePin.set', { segment: 'manual', pin: { modelId: 'gpt-5.6', routeId: null } }],
      ['task.routePin.set', { segment: 'verify', pin: { modelId: 'opus-5.5', routeId: 'rt-claude-opus' } }],
      ['task.routePin.clear', { segment: 'manual', pin: { modelId: null, routeId: null } }],
    ]);
  });

  it('【故意造出的失败】拒的都不动库、不记操作：结束了的单 409、目录里没有的模型 422、别的模型的路由 422、对题段 400', async () => {
    current = await pgHarness(t, { taskRoutePins: pgTaskRoutePins(t.db, () => T0) });
    const s = await current.login();
    const finished = await put(current, s, IDS.task13, { segment: 'manual', modelId: 'gpt-5.6' });
    expect([finished.status, await errorCode(finished)]).toEqual([409, 'task_finished']);
    const unknown = await put(current, s, IDS.task12, { segment: 'manual', modelId: 'no-such' });
    expect([unknown.status, await errorCode(unknown)]).toEqual([422, 'route_pin_invalid']);
    const wrongRoute = await put(current, s, IDS.task12, {
      segment: 'manual',
      modelId: 'gpt-5.6',
      routeId: 'rt-claude-opus',
    });
    expect(wrongRoute.status).toBe(422);
    expect((await put(current, s, IDS.task12, { segment: 'scope', modelId: 'gpt-5.6' })).status).toBe(400);
    expect(await readTaskRoutePin(t.db, IDS.task12, 'manual')).toBeNull();
    expect(await audits()).toEqual([]);
  });

  it('【故意造出的失败】读不了：详情照样回、routePins 写明没读成；写不进回 503', async () => {
    const broken: TaskRoutePinsPort = {
      list: async () => {
        throw new Error('relation "task_route_pins" does not exist');
      },
      set: async () => {
        throw new Error('库断了');
      },
    };
    current = await pgHarness(t, { taskRoutePins: broken });
    const s = await current.login();
    const pins = (await detail(current, s.cookie, IDS.task12)).routePins;
    expect(pins.pins).toEqual([]);
    expect(pins.unavailable).toContain('没读成');
    const res = await put(current, s, IDS.task12, { segment: 'manual', modelId: 'gpt-5.6' });
    expect([res.status, await errorCode(res)]).toEqual([503, 'task_route_pin_unwritable']);
  });
});

describe('单子页指定模型：没接上（内存版）', () => {
  it('详情写 unavailable，不拿空列表冒充没指定；改回 503', async () => {
    const h = harness();
    const s = await h.login();
    const pins = (await detail(h, s.cookie, IDS.task12)).routePins;
    expect(pins).toEqual({ pins: [], unavailable: TASK_ROUTE_PINS_NOT_HERE });
    const res = await put(h, s, IDS.task12, { segment: 'manual', modelId: 'gpt-5.6' });
    expect([res.status, await errorCode(res)]).toEqual([503, 'task_route_pins_not_wired']);
  });
});
