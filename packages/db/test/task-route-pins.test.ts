// 按单指定模型（task_route_pins）：写之前核对单子、模型、路由；覆盖写；清掉不删行；库里的约束兜底。
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listTaskRoutePins, readTaskRoutePin, setTaskRoutePin } from '../src/queries/task-route-pins.ts';
import { models, taskRoutePins } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';
import { addRepo, addRoute, addTask, catalog, expectViolation, NOW } from './helpers.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let taskId: string;
beforeEach(async () => {
  await resetTestDb(t);
  await catalog(t.db);
  await addRoute(t.db, { id: 'r-opus', poolId: 'relay-a', modelId: 'opus-5.5' });
  await addRoute(t.db, { id: 'r-49', poolId: 'relay-b', modelId: 'opus-4.9' });
  const repo = await addRepo(t.db);
  taskId = (await addTask(t.db, repo.id)).id;
});

const base = () => ({
  taskId,
  segment: 'manual' as const,
  modelId: 'opus-5.5' as string | null,
  routeId: null as string | null,
  setBy: 'u-1',
  setAt: NOW,
});

describe('指定、改、清掉', () => {
  it('没指定过读出 null；指定后读得到；再指定覆盖写、交回改之前的；清掉是写空、行还在', async () => {
    expect(await readTaskRoutePin(t.db, taskId, 'manual')).toBeNull();
    const first = await setTaskRoutePin(t.db, { ...base(), reason: '  想试试 Opus ' });
    expect(first).toMatchObject({
      ok: true,
      before: null,
      after: { modelId: 'opus-5.5', reason: '想试试 Opus' },
    });

    const second = await setTaskRoutePin(t.db, { ...base(), modelId: 'opus-4.9', routeId: 'r-49' });
    expect(second).toMatchObject({
      ok: true,
      before: { modelId: 'opus-5.5' },
      after: { modelId: 'opus-4.9', routeId: 'r-49', reason: null },
    });

    const cleared = await setTaskRoutePin(t.db, { ...base(), modelId: null });
    expect(cleared).toMatchObject({ ok: true, after: { modelId: null, routeId: null } });
    expect(await listTaskRoutePins(t.db, taskId)).toHaveLength(1);
    // 动手、验收各一行，互不影响
    await setTaskRoutePin(t.db, { ...base(), segment: 'verify' });
    expect((await listTaskRoutePins(t.db, taskId)).map((p) => [p.segment, p.modelId])).toEqual([
      ['manual', null],
      ['verify', 'opus-5.5'],
    ]);
  });

  it('核对不过的一行不动：没有的单、目录里没有的模型、下架的模型、别的模型的路由、清掉时只留路由', async () => {
    const no = (r: Awaited<ReturnType<typeof setTaskRoutePin>>) => (r.ok ? 'ok' : r.kind);
    expect(
      no(await setTaskRoutePin(t.db, { ...base(), taskId: '00000000-0000-4000-8000-000000000000' })),
    ).toBe('not_found');
    expect(no(await setTaskRoutePin(t.db, { ...base(), taskId: 'not-a-uuid' }))).toBe('not_found');
    expect(no(await setTaskRoutePin(t.db, { ...base(), modelId: 'no-such-model' }))).toBe('invalid');
    await t.db.update(models).set({ retiredAt: NOW }).where(eq(models.id, 'opus-4.9'));
    expect(no(await setTaskRoutePin(t.db, { ...base(), modelId: 'opus-4.9' }))).toBe('invalid');
    const wrong = await setTaskRoutePin(t.db, { ...base(), routeId: 'r-49' });
    expect(wrong).toMatchObject({ ok: false, kind: 'invalid' });
    expect(wrong.ok ? '' : wrong.why).toContain('不是指定的 opus-5.5');
    expect(no(await setTaskRoutePin(t.db, { ...base(), modelId: null, routeId: 'r-opus' }))).toBe('invalid');
    expect(await t.db.select().from(taskRoutePins)).toEqual([]);
  });

  it('库里的约束兜底：对题段写不进、钉别的模型的路由写不进（绕过核对直接写）', async () => {
    await expectViolation(
      t.db.insert(taskRoutePins).values({ ...base(), segment: 'scope' as never }),
      'task_route_pins_segment_routed',
    );
    await expectViolation(
      t.db.insert(taskRoutePins).values({ ...base(), routeId: 'r-49' }),
      'task_route_pins_route_of_model_fk',
    );
  });
});
