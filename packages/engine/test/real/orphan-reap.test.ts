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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORPHAN_RUN_REASON,
  orphanReaper,
  RETIRED_IO_ROOT_ALERT_KEY,
  UNCLAIMED_RUN_REASON,
} from '../../src/real/orphan-reap.ts';
import {
  DETACHED_MARK,
  HANDOFF_TTL_MS,
  type MirasimHandle,
  writeMirasimHandle,
} from '../../src/real/session-handoff.ts';
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

describe('脱开引擎跑、等人接回的动手会话（#2238）', () => {
  /** 一格收发目录：detachedAt 给了就写放手标记。 */
  function ioCell(ioRoot: string, runId: string, detachedAt?: Date): string {
    const dir = join(ioRoot, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'out'), '{"type":"system"}\n');
    if (detachedAt) writeFileSync(join(dir, DETACHED_MARK), `${detachedAt.toISOString()}\n`);
    return dir;
  }

  function handoffSetup() {
    const trees = fakeTrees(join(root, 'work'));
    const scope = fakeScopeHelper(root);
    const logs: Logged[] = [];
    const ioRoot = join(root, 'io');
    const delayed: { fn: () => void; ms: number }[] = [];
    const mirasimStops: MirasimHandle[] = [];
    let clock = NOW;
    const reap = orphanReaper({
      db: t.db,
      trees: trees.trees,
      helper: scope.helper,
      sudo: scope.sudo,
      ioRoot,
      later: (fn, ms) => void delayed.push({ fn, ms }),
      stopMirasim: async (handle) => {
        mirasimStops.push(handle);
        return { confirmed: true, detail: 'stopped' };
      },
      now: () => clock,
      log: (message, fields) => logs.push({ message, fields }),
    });
    return { reap, trees, scope, logs, ioRoot, delayed, mirasimStops, setNow: (d: Date) => (clock = d) };
  }

  /** Mirasim 的一格：会话在服务端，没有本机 scope；交接目录里有会话号，detachedAt 给了就写放手标记。 */
  function mirasimCell(ioRoot: string, runId: string, detachedAt?: Date): string {
    const dir = ioCell(ioRoot, runId, detachedAt);
    writeMirasimHandle(dir, {
      runId,
      sessionKey: `claude:${runId}`,
      taskId: 'task-1',
      acceptedAt: NOW.toISOString(),
    });
    return dir;
  }

  const open = (id: string) =>
    startRun(t.db, { id, segment: 'manual', model: 'grok-4.7', routeId: 'carpool', startedAt: NOW });

  it('上一个引擎刚放手的：scope 不收、临时目录不删、runs 那一行不收、收发目录留着；同一轮别的照孤儿收', async () => {
    const { reap, trees, scope, ioRoot, delayed } = handoffSetup();
    const kept = randomUUID();
    const orphan = randomUUID();
    process.env.FAKE_SCOPE_LIST = `${kept} active\n${orphan} active\n`;
    await open(kept);
    await open(orphan);
    const keptIo = ioCell(ioRoot, kept, new Date(NOW.getTime() - 60_000));
    const doneIo = ioCell(ioRoot, randomUUID());
    for (const id of [kept, orphan]) mkdirSync(tmpOf(trees, id), { recursive: true });

    expect(await reap()).toBe(1);
    const stopped = scope.calls().filter((c) => c.action === 'stop');
    expect(stopped.map((c) => c.args[0])).toEqual([orphan]);
    expect(existsSync(tmpOf(trees, kept))).toBe(true);
    expect(existsSync(tmpOf(trees, orphan))).toBe(false);
    expect(await getRun(t.db, kept)).toMatchObject({ endedAt: null, outcome: null });
    expect(await getRun(t.db, orphan)).toMatchObject({ outcome: 'killed', failureReason: ORPHAN_RUN_REASON });
    // 没有放手标记的收发目录（收过场、被叫停的）删掉；等人接回的留着
    expect(existsSync(keptIo)).toBe(true);
    expect(existsSync(doneIo)).toBe(false);
    // 过了时限还没人接回的，起来以后再清一次
    expect(delayed.map((d) => d.ms)).toEqual([HANDOFF_TTL_MS]);
  });

  it('【故意造出的失败】放手以后过了时限没人接回：延迟清扫把 scope、收发目录、临时目录、runs 那一行照孤儿收掉；已经接回的（标记删了）不碰', async () => {
    const { reap, trees, scope, ioRoot, delayed, setNow } = handoffSetup();
    const lost = randomUUID();
    const claimed = randomUUID();
    process.env.FAKE_SCOPE_LIST = `${lost} active\n${claimed} active\n`;
    for (const id of [lost, claimed]) {
      await open(id);
      ioCell(ioRoot, id, NOW);
      mkdirSync(tmpOf(trees, id), { recursive: true });
    }
    expect(await reap()).toBe(0);
    // claimed 这时被工作流接回了：Spawner 删了标记
    rmSync(join(ioRoot, claimed, DETACHED_MARK));
    setNow(new Date(NOW.getTime() + HANDOFF_TTL_MS));
    for (const d of delayed) d.fn();
    await vi.waitFor(async () => expect((await getRun(t.db, lost))?.outcome).toBe('killed'));
    expect(await getRun(t.db, lost)).toMatchObject({ failureReason: UNCLAIMED_RUN_REASON });
    expect(await getRun(t.db, claimed)).toMatchObject({ endedAt: null });
    expect(
      scope
        .calls()
        .filter((c) => c.action === 'stop')
        .map((c) => c.args[0]),
    ).toEqual([lost]);
    expect(existsSync(join(ioRoot, lost))).toBe(false);
    expect(existsSync(tmpOf(trees, lost))).toBe(false);
    expect(existsSync(join(ioRoot, claimed))).toBe(true);
    expect(existsSync(tmpOf(trees, claimed))).toBe(true);
  });

  it('【故意造出的失败】标记早就过了时限（引擎停了很久才起来）：起来那一下就照孤儿收，不等', async () => {
    const { reap, scope, ioRoot, delayed } = handoffSetup();
    const stale = randomUUID();
    process.env.FAKE_SCOPE_LIST = `${stale} active
`;
    await open(stale);
    ioCell(ioRoot, stale, new Date(NOW.getTime() - HANDOFF_TTL_MS - 1));
    expect(await reap()).toBe(1);
    expect(
      scope
        .calls()
        .filter((c) => c.action === 'stop')
        .map((c) => c.args[0]),
    ).toEqual([stale]);
    expect(await getRun(t.db, stale)).toMatchObject({ outcome: 'killed', failureReason: ORPHAN_RUN_REASON });
    expect(existsSync(join(ioRoot, stale))).toBe(false);
    expect(delayed).toEqual([]);
  });

  it('Mirasim（#2815）：刚放手的不收、不给服务端发 stop，runs 那一行和临时目录、交接目录都留着等接回', async () => {
    const { reap, trees, scope, ioRoot, delayed, mirasimStops } = handoffSetup();
    const kept = randomUUID();
    // Mirasim 没有本机 scope：列出来是空的
    process.env.FAKE_SCOPE_LIST = '';
    await open(kept);
    const dir = mirasimCell(ioRoot, kept, new Date(NOW.getTime() - 60_000));
    mkdirSync(tmpOf(trees, kept), { recursive: true });
    expect(await reap()).toBe(0);
    expect(mirasimStops).toEqual([]);
    expect(scope.calls().filter((c) => c.action === 'stop')).toEqual([]);
    expect(await getRun(t.db, kept)).toMatchObject({ endedAt: null, outcome: null });
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(tmpOf(trees, kept))).toBe(true);
    expect(delayed.map((d) => d.ms)).toEqual([HANDOFF_TTL_MS]);
  });

  it('【故意造出的失败】Mirasim 放手以后过了时限没人接回：延迟清扫这时才给服务端发 stop，再收 runs 那一行、交接目录、临时目录；已经接回的（标记删了）不碰', async () => {
    const { reap, trees, scope, ioRoot, delayed, mirasimStops, setNow } = handoffSetup();
    const lost = randomUUID();
    const claimed = randomUUID();
    process.env.FAKE_SCOPE_LIST = '';
    for (const id of [lost, claimed]) {
      await open(id);
      mirasimCell(ioRoot, id, NOW);
      mkdirSync(tmpOf(trees, id), { recursive: true });
    }
    expect(await reap()).toBe(0);
    expect(mirasimStops).toEqual([]);
    rmSync(join(ioRoot, claimed, DETACHED_MARK));
    setNow(new Date(NOW.getTime() + HANDOFF_TTL_MS));
    for (const d of delayed) d.fn();
    await vi.waitFor(async () => expect((await getRun(t.db, lost))?.outcome).toBe('killed'));
    expect(mirasimStops).toEqual([expect.objectContaining({ runId: lost, sessionKey: `claude:${lost}` })]);
    expect(await getRun(t.db, lost)).toMatchObject({ failureReason: UNCLAIMED_RUN_REASON });
    expect(await getRun(t.db, claimed)).toMatchObject({ endedAt: null });
    // Mirasim 的会话不在本机 scope 里：不去收 scope
    expect(scope.calls().filter((c) => c.action === 'stop')).toEqual([]);
    expect(existsSync(join(ioRoot, lost))).toBe(false);
    expect(existsSync(tmpOf(trees, lost))).toBe(false);
    expect(existsSync(join(ioRoot, claimed))).toBe(true);
  });

  it('【故意造出的失败】Mirasim 标记早就过了时限（引擎停了很久才起来）：起来那一下就发 stop 收掉，不等', async () => {
    const { reap, ioRoot, delayed, mirasimStops } = handoffSetup();
    const stale = randomUUID();
    process.env.FAKE_SCOPE_LIST = '';
    await open(stale);
    mirasimCell(ioRoot, stale, new Date(NOW.getTime() - HANDOFF_TTL_MS - 1));
    await reap();
    expect(mirasimStops).toEqual([expect.objectContaining({ runId: stale })]);
    expect(await getRun(t.db, stale)).toMatchObject({ outcome: 'killed', failureReason: ORPHAN_RUN_REASON });
    expect(existsSync(join(ioRoot, stale))).toBe(false);
    expect(delayed).toEqual([]);
  });

  it('Mirasim 的 stop 没发成：只记日志，照样收本机的东西、不挡工人接活', async () => {
    const { ioRoot, trees, scope, logs } = handoffSetup();
    const stale = randomUUID();
    process.env.FAKE_SCOPE_LIST = '';
    await open(stale);
    mirasimCell(ioRoot, stale, new Date(NOW.getTime() - HANDOFF_TTL_MS - 1));
    const reap = orphanReaper({
      db: t.db,
      trees: trees.trees,
      helper: scope.helper,
      sudo: scope.sudo,
      ioRoot,
      stopMirasim: async () => {
        throw new Error('连不上 Mirasim');
      },
      now: () => NOW,
      log: (message, fields) => logs.push({ message, fields }),
    });
    await reap();
    expect(
      logs.some((l) => l.message.includes('Mirasim') && JSON.stringify(l.fields).includes('连不上')),
    ).toBe(true);
    expect(existsSync(join(ioRoot, stale))).toBe(false);
  });
});
