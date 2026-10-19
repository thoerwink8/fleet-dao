// 只由 orphan-owner.test.ts 的独立 Vitest 子进程加载；A 的测试和清理超时都是刻意保留的红结果。
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listAgentScopes } from '@fleet-dao/adapters';
import { getRun, poolReservations, reservePoolSlot, startRun } from '@fleet-dao/db';
import { TEST_DB_TIMEOUT_MS } from '@fleet-dao/db/testing';
import { afterEach, beforeEach, expect, it, type TestContext } from 'vitest';
import { fakeTrees, NOW } from '../real/fixtures.ts';
import { createOrphanOwner, type OrphanOwner } from '../real/orphan-owner.ts';

if (process.env.FLEET_TEST_PG_URL) throw new Error('受控超时场景只用独立 PGlite');
const reportPath = process.env.FLEET_ORPHAN_OWNER_REPORT;
if (!reportPath) throw new Error('受控超时场景没有独立报告路径');
const events: { kind: string; details?: unknown }[] = [];
function record(kind: string, details?: unknown) {
  events.push({ kind, details });
  writeFileSync(reportPath as string, JSON.stringify(events));
}
const owners = new WeakMap<TestContext, Promise<OrphanOwner>>();
async function owned(context: TestContext) {
  const owner = owners.get(context);
  if (!owner) throw new Error('场景 owner 未登记');
  return owner;
}
beforeEach(async (context) => {
  const pending = createOrphanOwner();
  owners.set(context, pending);
  await pending;
}, TEST_DB_TIMEOUT_MS);
let first: {
  owner: OrphanOwner;
  scope: ReturnType<OrphanOwner['scope']>;
  signal: AbortSignal;
  reap: Promise<number>;
};
let firstCleanup: Promise<void>;
let entered = false;
let release: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
afterEach(async (context) => {
  const owner = await owned(context);
  const cleanup = owner.close();
  if (context.task.name === 'A: controlled test timeout') {
    firstCleanup = cleanup;
    record('A-cleanup-started');
    await cleanup;
    record('A-cleanup-finished');
  } else await cleanup;
  owners.delete(context);
}, 300);

it('A: controlled test timeout', async (context) => {
  const owner = await owned(context);
  const scope = owner.scope();
  const trees = fakeTrees(join(owner.root, 'work'));
  trees.trees.listTmp = async () => {
    entered = true;
    record('A-gate-entered');
    await gate;
    record('A-gate-resumed', { signalAborted: context.signal.aborted });
    return [];
  };
  context.signal.addEventListener('abort', () => record('A-aborted'), { once: true });
  const reap = owner.reaper({
    trees: trees.trees,
    helper: scope.helper,
    sudo: scope.sudo,
    now: () => NOW,
    log: () => {},
  })();
  first = { owner, scope, signal: context.signal, reap };
  await reap;
}, 1_000);

it('B: isolation survives both timeouts and the late real helper', async (context) => {
  const owner = await owned(context);
  record('B-began');
  expect(entered).toBe(true);
  expect(first.signal.aborted).toBe(true);
  expect(first.owner.t.db).not.toBe(owner.t.db);
  expect(first.owner.root).not.toBe(owner.root);
  const scope = owner.scope();
  scope.set({ list: 'b-1 active\n' });
  const beforeOldCalls = first.scope.calls().length;
  // 在 B 设好控制值以后才启动 A 的真 helper，不能读到 B 或宿主的 FAKE_SCOPE_*。
  expect(await listAgentScopes({ helper: first.scope.helper, sudo: first.scope.sudo })).toEqual({
    ok: true,
    scopes: [],
  });
  expect(first.scope.calls()).toHaveLength(beforeOldCalls + 1);
  expect(scope.calls()).toEqual([]);
  expect(await listAgentScopes({ helper: scope.helper, sudo: scope.sudo })).toEqual({
    ok: true,
    scopes: [{ id: 'b-1', state: 'active' }],
  });
  const id = randomUUID();
  await startRun(owner.t.db, {
    id,
    segment: 'manual',
    model: 'opus-5.5',
    routeId: 'carpool',
    startedAt: NOW,
  });
  expect(
    await reservePoolSlot(owner.t.db, {
      taskId: owner.taskId,
      segment: 'manual',
      routeId: 'carpool',
      reservedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 20 * 60_000),
    }),
  ).toMatchObject({ reserved: true });
  record('B-seeded');
  release();
  await first.reap;
  await firstCleanup;
  expect(existsSync(first.owner.root)).toBe(false);
  expect(existsSync(owner.root)).toBe(true);
  expect(await getRun(owner.t.db, id)).toMatchObject({ endedAt: null, outcome: null });
  expect(await owner.t.db.select().from(poolReservations)).toHaveLength(1);
  expect(scope.calls()).toEqual([{ action: 'list', args: [] }]);
  record('B-verified');
});
