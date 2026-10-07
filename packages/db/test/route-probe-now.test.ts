// 立即探测的操作记录（驾驶舱改版 2026-10-07）：引擎记接手、探完，读回只读 routing:probe 的、since 之后的。
// 故意造出的失败：没成的回执不带原因，库里约束挡（recordEngineAudit 先拒）。
import { ROUTE_PROBE_ACTION, ROUTE_PROBE_TARGET } from '@fleet-dao/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  recordRouteProbeDone,
  recordRouteProbeStart,
  routeProbeAuditRows,
} from '../src/queries/route-probe-now.ts';
import { auditLog } from '../src/schema/index.ts';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '../src/testing.ts';

const NOW = new Date('2026-10-07T07:00:00.000Z');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
});

describe('立即探测的操作记录', () => {
  it('点击、接手、探完都读得回；别的 target、since 之前的不读', async () => {
    await t.db.insert(auditLog).values([
      {
        at: NOW,
        actorKind: 'user',
        actorId: 'founder',
        action: ROUTE_PROBE_ACTION.request,
        target: ROUTE_PROBE_TARGET,
        after: { requestId: 'a', routeIds: null },
        via: 'cockpit',
        ok: true,
      },
      {
        at: new Date(NOW.getTime() - 3_600_000),
        actorKind: 'user',
        actorId: 'founder',
        action: ROUTE_PROBE_ACTION.request,
        target: ROUTE_PROBE_TARGET,
        after: { requestId: 'old', routeIds: null },
        via: 'cockpit',
        ok: true,
      },
      {
        at: NOW,
        actorKind: 'user',
        actorId: 'founder',
        action: 'setting.update',
        target: 'setting:x',
        via: 'cockpit',
        ok: true,
      },
    ]);
    await recordRouteProbeStart(t.db, 'a', new Date(NOW.getTime() + 1000));
    await recordRouteProbeDone(t.db, {
      requestId: 'a',
      at: new Date(NOW.getTime() + 5000),
      ok: true,
      results: [{ routeId: 'r1', outcome: 'ok', detail: '答上了', at: NOW.toISOString(), durationMs: 4000 }],
    });
    const rows = await routeProbeAuditRows(t.db, new Date(NOW.getTime() - 60_000));
    expect(rows.map((r) => [r.action, r.actorId, r.ok]).sort()).toEqual(
      [
        [ROUTE_PROBE_ACTION.request, 'founder', true],
        [ROUTE_PROBE_ACTION.start, 'engine:route-probe-now', true],
        [ROUTE_PROBE_ACTION.done, 'engine:route-probe-now', true],
      ].sort(),
    );
  });

  it('【故意造出的失败】没成的回执不带原因：拒', async () => {
    await expect(
      recordRouteProbeDone(t.db, { requestId: 'a', at: NOW, ok: false, error: '  ', results: [] }),
    ).rejects.toThrow('没写为什么');
  });
});
