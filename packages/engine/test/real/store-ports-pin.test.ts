// 按单指定模型（task_route_pins，驾驶舱单子页写）：三段的一段选路时现读，只派指定的模型（钉了路由的只派那条）；
// 指定的派不出就等或停下等人、写明原因，不悄悄换别的；清掉了回到自动；读不到照抛，不当成没指定。
import { setTaskRoutePin } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PickRouteInput } from '../../src/ports.ts';
import type { SessionOrgReader } from '../../src/real/session-org.ts';
import { createStorePorts } from '../../src/real/store-ports.ts';
import { addCursorRoute, addGrokRoute, addTask, NOW, world } from './fixtures.ts';

const LUNA = 'cursor:gpt-5.6-luna:cursor-agent';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

const ctx = { signal: new AbortController().signal, heartbeat() {}, attempt: 1, lastHeartbeat: undefined };
const onCarpool: SessionOrgReader = async () => ({ ok: true, org: 'carpool' });
const ports = () =>
  createStorePorts({ db: t.db, now: () => NOW, draw: () => 0.5, log: () => {}, sessionOrg: onCarpool });

let taskId: string;
beforeEach(async () => {
  await resetTestDb(t);
  // 写码用途：opus-5.5（solo、carpool 两条）排前面，经 Cursor 的 gpt-5.6-luna 排后面
  await world(t.db);
  await addCursorRoute(t.db, { modelId: 'gpt-5.6-luna', upstreamModel: 'gpt-5.6-luna', stages: ['execute'] });
  taskId = (await addTask(t.db)).task.id;
});

const pick = (over: Partial<PickRouteInput> = {}) =>
  ports().pickRoute(
    {
      taskId,
      stage: 'execute',
      avoidRouteIds: [],
      avoidPoolIds: [],
      avoidModelIds: [],
      reserve: { segment: 'manual' },
      ...over,
    },
    ctx,
  );
const pin = (
  modelId: string | null,
  routeId: string | null = null,
  segment: 'manual' | 'verify' = 'manual',
) => setTaskRoutePin(t.db, { taskId, segment, modelId, routeId, setBy: 'u-founder', setAt: NOW });

describe('按单指定模型', () => {
  it('没指定照路由两层派；指定了别的模型就派它、理由里写明；钉了路由只派那条；清掉回到自动', async () => {
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'solo' } });

    await pin('gpt-5.6-luna');
    const pinned = await pick();
    expect(pinned).toMatchObject({ ok: true, route: { routeId: LUNA, modelId: 'gpt-5.6-luna' } });
    expect(pinned.ok && pinned.why).toContain('按人指定的 gpt-5.6-luna');

    await pin('opus-5.5', 'carpool');
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'carpool' } });

    await pin(null);
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'solo' } });
  });

  it('只管指定的那一段：给验收指定的，动手照自动；不预占的选路（Fusion、对账）不读指定', async () => {
    await pin('gpt-5.6-luna', null, 'verify');
    expect(await pick()).toMatchObject({ ok: true, route: { routeId: 'solo' } });
    await pin('gpt-5.6-luna');
    const { reserve: _reserve, ...noReserve } = {
      taskId,
      stage: 'execute' as const,
      avoidRouteIds: [],
      avoidPoolIds: [],
      avoidModelIds: [],
      reserve: { segment: 'manual' as const },
    };
    expect(await ports().pickRoute(noReserve, ctx)).toMatchObject({ ok: true, route: { routeId: 'solo' } });
  });

  it('【故意造出的失败】指定的模型被失败分流避开了（换模型）：派不出、写明只等它，不悄悄派回 Opus', async () => {
    await pin('gpt-5.6-luna');
    const got = await pick({ avoidModelIds: ['gpt-5.6-luna'] });
    expect(got.ok).toBe(false);
    expect(!got.ok && got.detail).toContain('按人指定的 gpt-5.6-luna，只等它、不换别的模型');
  });

  it('【故意造出的失败】指定的模型不在这个用途的路由两层里：派不出（交人），写明去单子页换或清掉', async () => {
    await addGrokRoute(t.db, { stages: [] });
    await pin('grok-4.7');
    const got = await pick();
    expect(got).toMatchObject({ ok: false, waitFor: 'none' });
    expect(!got.ok && got.detail).toContain('指定了 grok-4.7');
    expect(!got.ok && got.detail).toContain('不换别的模型');
  });

  it('【故意造出的失败】指定读不了（表挪开）：选路抛错，不当成没指定照自动派', async () => {
    await pin('gpt-5.6-luna');
    await t.client.exec('alter table task_route_pins rename to task_route_pins_gone');
    try {
      const err = await pick().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).not.toBeNull();
    } finally {
      await t.client.exec('alter table task_route_pins_gone rename to task_route_pins');
    }
  });

  it('别的单不受这张单的指定影响', async () => {
    await pin('gpt-5.6-luna');
    const other = (await addTask(t.db)).task.id;
    expect(await pick({ taskId: other })).toMatchObject({ ok: true, route: { routeId: 'solo' } });
  });
});
