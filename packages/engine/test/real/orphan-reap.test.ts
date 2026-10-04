// 工人起来接活之前收上一轮留下的东西（real/orphan-reap.ts）：在册的会话 scope、会话临时目录、runs 里没收场的一次性会话、
// 选路预占的名额。原来在老会话端口的测试文件里（sessions-failures.test.ts「收孤儿」「会话自己的临时目录」两组），老端口删了
// （#901），这几条断言原样搬过来：收 scope、清临时目录、收 runs 行、清预占，每条失败路径照旧故意造一次。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alertByKey,
  getRun,
  openOrgRuns,
  poolReservations,
  reservePoolSlot,
  startRun,
  upsertAlert,
} from '@fleet-dao/db';
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ORPHAN_RUN_REASON, orphanReaper, RETIRED_IO_ROOT_ALERT_KEY } from '../../src/real/orphan-reap.ts';
import { addTask, fakeScopeHelper, fakeTrees, NOW, world } from './fixtures.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());

let root: string;
let taskId: string;
beforeEach(async () => {
  await resetTestDb(t);
  await world(t.db);
  taskId = (await addTask(t.db)).task.id;
  root = mkdtempSync(join(tmpdir(), 'fleet-orphans-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const k of ['FAKE_SCOPE_LOG', 'FAKE_SCOPE_LIST', 'FAKE_SCOPE_LIST_EXIT', 'FAKE_SCOPE_STOP_EXIT']) {
    delete process.env[k];
  }
});

type Logged = { message: string; fields: Record<string, unknown> | undefined };

function setup() {
  const trees = fakeTrees(join(root, 'work'));
  const scope = fakeScopeHelper(root);
  const logs: Logged[] = [];
  const reap = orphanReaper({
    db: t.db,
    trees: trees.trees,
    helper: scope.helper,
    sudo: scope.sudo,
    now: () => NOW,
    log: (message, fields) => logs.push({ message, fields }),
  });
  return { reap, trees, scope, logs };
}

const tmpOf = (trees: ReturnType<typeof setup>['trees'], runId: string) => trees.trees.tmpFor(runId);

describe('收孤儿', () => {
  it('列出来的在册会话逐个收掉（已经停了的不算）；列不出来明确报错，不当成一个都没有', async () => {
    const { reap, scope } = setup();
    process.env.FAKE_SCOPE_LIST = `${randomUUID()} active\npush-x-g1 failed\nold-1 inactive\n`;
    expect(await reap()).toBe(2);
    expect(scope.calls().filter((c) => c.action === 'stop')).toHaveLength(2);
    process.env.FAKE_SCOPE_LIST_EXIT = '1';
    await expect(reap()).rejects.toThrow('查不了上一轮留下的会话');
  });

  it('【故意造出的失败】收不掉的 scope：明确抛错，不当成收掉了', async () => {
    const { reap } = setup();
    process.env.FAKE_SCOPE_LIST = `${randomUUID()} active\n`;
    process.env.FAKE_SCOPE_STOP_EXIT = '1';
    await expect(reap()).rejects.toThrow('收不掉上一轮留下的会话');
  });

  it('【故意造出的失败】上一轮引擎起的一次性会话没收场（runs 里还开着）：起来时收成没跑完、写明为什么，切号不再当它在跑（#157）', async () => {
    const { reap } = setup();
    process.env.FAKE_SCOPE_LIST = '';
    const left = randomUUID();
    const finished = randomUUID();
    await startRun(t.db, {
      id: left,
      segment: 'manual',
      model: 'opus-5.5',
      routeId: 'carpool',
      startedAt: NOW,
    });
    await startRun(t.db, {
      id: finished,
      segment: 'verify',
      model: 'opus-5.5',
      routeId: 'carpool',
      startedAt: NOW,
      endedAt: NOW,
      outcome: 'done',
    });
    expect((await openOrgRuns(t.db)).map((r) => r.runId)).toEqual([left]);
    await reap();
    expect(await getRun(t.db, left)).toMatchObject({ outcome: 'killed', failureReason: ORPHAN_RUN_REASON });
    expect(await getRun(t.db, finished)).toMatchObject({ outcome: 'done', failureReason: null });
    expect(await openOrgRuns(t.db)).toEqual([]);
  });

  it('【故意造出的失败】上一轮选路时给三段的一段预占、还没开跑的名额（#757）：起来时整表清掉，选路、切号不再当池占着', async () => {
    const { reap } = setup();
    process.env.FAKE_SCOPE_LIST = '';
    const held = await reservePoolSlot(t.db, {
      taskId,
      segment: 'manual',
      routeId: 'carpool',
      reservedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 20 * 60_000),
    });
    expect(held).toMatchObject({ reserved: true });
    expect((await openOrgRuns(t.db, NOW)).map((r) => [r.kind, r.startedAt])).toEqual([['oneShot', null]]);
    await reap();
    expect(await t.db.select().from(poolReservations)).toEqual([]);
    expect(await openOrgRuns(t.db, NOW)).toEqual([]);
  });

  it('退役的「收发目录不能用」提醒：库里还开着的在起来时撤掉，没有的不报错', async () => {
    const { reap } = setup();
    process.env.FAKE_SCOPE_LIST = '';
    await reap();
    expect(await alertByKey(t.db, RETIRED_IO_ROOT_ALERT_KEY)).toBeNull();
    await upsertAlert(t.db, {
      dedupeKey: RETIRED_IO_ROOT_ALERT_KEY,
      level: 'alert',
      taskId: null,
      title: '法国的引擎会话没脱开跑',
      body: '收发目录的根不在',
    });
    await reap();
    expect(await alertByKey(t.db, RETIRED_IO_ROOT_ALERT_KEY)).toMatchObject({
      resolvedBy: 'engine:sessions',
      body: expect.stringContaining('已撤：'),
    });
  });
});

describe('会话临时目录：工人起来时清掉上一轮留下的；删不掉、列不出来都明说没清成，不挡工人接活', () => {
  it('清掉上一轮留下的临时目录', async () => {
    const { reap, trees, logs } = setup();
    process.env.FAKE_SCOPE_LIST = '';
    const left = [randomUUID(), randomUUID()].map((id) => tmpOf(trees, id));
    for (const dir of left) {
      mkdirSync(join(dir, 'ssr'), { recursive: true });
      writeFileSync(join(dir, 'ssr', 'cache'), 'x');
    }
    expect(await reap()).toBe(0);
    for (const dir of left) expect(existsSync(dir)).toBe(false);
    expect(logs.map((l) => l.message)).toContain('删掉上一轮会话留下的临时目录 2 个');
  });

  it('【故意造出的失败】删不掉的目录留着、日志明说是哪个；列不出来也只记日志、不抛', async () => {
    const { reap, trees, logs } = setup();
    process.env.FAKE_SCOPE_LIST = '';
    const stuck = tmpOf(trees, randomUUID());
    mkdirSync(stuck, { recursive: true });
    trees.fail.remove.add(stuck);
    expect(await reap()).toBe(0);
    expect(existsSync(stuck)).toBe(true);
    const notRemoved = logs.find((l) => l.message.includes('有 1 个没删掉'));
    expect(notRemoved?.fields?.failed).toEqual([expect.stringContaining(stuck)]);

    trees.fail.list = true;
    expect(await reap()).toBe(0);
    const unlisted = logs.find((l) => l.message.includes('没清成：列不出来'));
    expect(unlisted?.fields?.error).toContain('列不出会话临时目录');
  });
});
