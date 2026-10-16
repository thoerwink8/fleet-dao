// 验收的能力下限（#2725）：工作流不带派工档，验收这一段选路时按这张单最近一次动手记下的档（runs.tier）从库里读；
// 主力档、中档单的冷验收不派轻档。没记过档的照旧不设下限。
import { setTaskRoutePin, startRun } from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PickRouteInput } from '../../src/ports.ts';
import type { SessionOrgReader } from '../../src/real/session-org.ts';
import { createStorePorts } from '../../src/real/store-ports.ts';
import { addCursorRoute, addTask, MIN, NOW, world } from './fixtures.ts';

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
let flashRoute: string;
beforeEach(async () => {
  await resetTestDb(t);
  // 验收用途：opus-5.5（强档）两条，经 Cursor 的 deepseek-flash（轻档）一条
  await world(t.db, { stages: ['verify'] });
  flashRoute = (
    await addCursorRoute(t.db, {
      modelId: 'deepseek-flash',
      upstreamModel: 'deepseek-flash',
      stages: ['verify'],
    })
  ).routeId;
  await t.client.exec(`update models set strength = 'strong' where id = 'opus-5.5'`);
  await t.client.exec(`update models set strength = 'light' where id = 'deepseek-flash'`);
  taskId = (await addTask(t.db)).task.id;
});

/** 冷验收按族问：只问 deepseek 那一族（claude 族避开，写这张单的就是 claude）。 */
const askFlash = (over: Partial<PickRouteInput> = {}) =>
  ports().pickRoute(
    {
      taskId,
      stage: 'verify',
      avoidRouteIds: [],
      avoidPoolIds: [],
      avoidModelIds: [],
      avoidFamilies: ['claude'],
      reserve: { segment: 'verify' },
      ...over,
    },
    ctx,
  );

const manualRun = (tier: 'fast' | 'medium' | 'heavyweight') =>
  startRun(t.db, {
    segment: 'manual',
    taskId,
    model: 'opus-5.5',
    tier,
    startedAt: new Date(NOW.getTime() - 30 * MIN),
  });

describe('验收按库里的派工档定下限', () => {
  it('没记过档：不设下限，照常派轻档', async () => {
    const got = await askFlash();
    expect(got.ok ? got.route.routeId : got.detail).toBe(flashRoute);
  });

  it('主力档、中档单：冷验收不派轻档，原因写够不上能力下限', async () => {
    for (const tier of ['heavyweight', 'medium'] as const) {
      await manualRun(tier);
      const got = await askFlash();
      expect(got.ok).toBe(false);
      expect(!got.ok && got.detail).toContain('够不上能力下限');
      expect(!got.ok && got.detail).toContain('的验收要强档');
    }
  });

  it('快档单：轻档也行', async () => {
    await manualRun('fast');
    expect(await askFlash()).toMatchObject({ ok: true, route: { routeId: flashRoute } });
  });

  it('人给验收这一段指定了轻档模型：照人的派，不拿下限驳', async () => {
    await manualRun('heavyweight');
    await setTaskRoutePin(t.db, {
      taskId,
      segment: 'verify',
      modelId: 'deepseek-flash',
      routeId: null,
      setBy: 'u-founder',
      setAt: NOW,
    });
    expect(await askFlash()).toMatchObject({ ok: true, route: { routeId: flashRoute } });
  });
});
