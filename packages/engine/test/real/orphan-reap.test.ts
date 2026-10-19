// 工人起来接活之前收上一轮留下的东西（real/orphan-reap.ts）：在册的会话 scope、会话临时目录、runs 里没收场的一次性会话、
// 选路预占的名额。原来在老会话端口的测试文件里（sessions-failures.test.ts「收孤儿」「会话自己的临时目录」两组），老端口删了
// （#901），这几条断言原样搬过来：收 scope、清临时目录、收 runs 行、清预占，每条失败路径照旧故意造一次。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { TEST_DB_TIMEOUT_MS } from '@fleet-dao/db/testing';
import { afterEach, beforeEach, describe, expect, it, type TestContext, vi } from 'vitest';
import {
  ORPHAN_RUN_REASON,
  RETIRED_IO_ROOT_ALERT_KEY,
  UNCLAIMED_RUN_REASON,
} from '../../src/real/orphan-reap.ts';
import {
  DETACHED_MARK,
  HANDOFF_TTL_MS,
  type MirasimHandle,
  writeMirasimHandle,
} from '../../src/real/session-handoff.ts';
import { fakeTrees, NOW } from './fixtures.ts';
import { createOrphanOwner, type OrphanOwner } from './orphan-owner.ts';

const owners = new WeakMap<TestContext, Promise<OrphanOwner>>();
beforeEach(async (context) => {
  const pending = createOrphanOwner();
  owners.set(context, pending);
  await pending;
}, TEST_DB_TIMEOUT_MS);
afterEach(async (context) => {
  const pending = owners.get(context);
  try {
    if (pending) await (await pending).close();
  } finally {
    if (owners.get(context) === pending) owners.delete(context);
  }
});

function ownerFor(context: TestContext): Promise<OrphanOwner> {
  const owner = owners.get(context);
  if (!owner) throw new Error('孤儿测试 owner 尚未准备');
  return owner;
}

type Logged = { message: string; fields: Record<string, unknown> | undefined };

function setup(owner: OrphanOwner) {
  const trees = fakeTrees(join(owner.root, 'work'));
  const scope = owner.scope();
  const logs: Logged[] = [];
  const reap = owner.reaper({
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
  it('列出来的在册会话逐个收掉（已经停了的不算）；列不出来明确报错，不当成一个都没有', async (context) => {
    const owner = await ownerFor(context);
    const { reap, scope } = setup(owner);
    scope.set({ list: `${randomUUID()} active\npush-x-g1 failed\nold-1 inactive\n` });
    expect(await reap()).toBe(2);
    expect(scope.calls().filter((c) => c.action === 'stop')).toHaveLength(2);
    scope.set({ listExit: 1 });
    await expect(reap()).rejects.toThrow('查不了上一轮留下的会话');
  });

  it('【故意造出的失败】收不掉的 scope：明确抛错，不当成收掉了', async (context) => {
    const owner = await ownerFor(context);
    const { reap, scope } = setup(owner);
    scope.set({ list: `${randomUUID()} active\n` });
    scope.set({ stopExit: 1 });
    await expect(reap()).rejects.toThrow('收不掉上一轮留下的会话');
  });

  it('【故意造出的失败】上一轮引擎起的一次性会话没收场（runs 里还开着）：起来时收成没跑完、写明为什么，切号不再当它在跑（#157）', async (context) => {
    const owner = await ownerFor(context);
    const { reap, scope } = setup(owner);
    scope.set({ list: '' });
    const left = randomUUID();
    const finished = randomUUID();
    await startRun(owner.t.db, {
      id: left,
      segment: 'manual',
      model: 'opus-5.5',
      routeId: 'carpool',
      startedAt: NOW,
    });
    await startRun(owner.t.db, {
      id: finished,
      segment: 'verify',
      model: 'opus-5.5',
      routeId: 'carpool',
      startedAt: NOW,
      endedAt: NOW,
      outcome: 'done',
    });
    expect((await openOrgRuns(owner.t.db)).map((r) => r.runId)).toEqual([left]);
    await reap();
    expect(await getRun(owner.t.db, left)).toMatchObject({
      outcome: 'killed',
      failureReason: ORPHAN_RUN_REASON,
    });
    expect(await getRun(owner.t.db, finished)).toMatchObject({ outcome: 'done', failureReason: null });
    expect(await openOrgRuns(owner.t.db)).toEqual([]);
  });

  it('【故意造出的失败】上一轮选路时给三段的一段预占、还没开跑的名额（#757）：起来时整表清掉，选路、切号不再当池占着', async (context) => {
    const owner = await ownerFor(context);
    const { reap, scope } = setup(owner);
    scope.set({ list: '' });
    const held = await reservePoolSlot(owner.t.db, {
      taskId: owner.taskId,
      segment: 'manual',
      routeId: 'carpool',
      reservedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 20 * 60_000),
    });
    expect(held).toMatchObject({ reserved: true });
    expect((await openOrgRuns(owner.t.db, NOW)).map((r) => [r.kind, r.startedAt])).toEqual([
      ['oneShot', null],
    ]);
    await reap();
    expect(await owner.t.db.select().from(poolReservations)).toEqual([]);
    expect(await openOrgRuns(owner.t.db, NOW)).toEqual([]);
  });

  it('退役的「收发目录不能用」提醒：库里还开着的在起来时撤掉，没有的不报错', async (context) => {
    const owner = await ownerFor(context);
    const { reap, scope } = setup(owner);
    scope.set({ list: '' });
    await reap();
    expect(await alertByKey(owner.t.db, RETIRED_IO_ROOT_ALERT_KEY)).toBeNull();
    await upsertAlert(owner.t.db, {
      dedupeKey: RETIRED_IO_ROOT_ALERT_KEY,
      level: 'alert',
      taskId: null,
      title: '法国的引擎会话没脱开跑',
      body: '收发目录的根不在',
    });
    await reap();
    expect(await alertByKey(owner.t.db, RETIRED_IO_ROOT_ALERT_KEY)).toMatchObject({
      resolvedBy: 'engine:sessions',
      body: expect.stringContaining('已撤：'),
    });
  });
});

describe('会话临时目录：工人起来时清掉上一轮留下的；删不掉、列不出来都明说没清成，不挡工人接活', () => {
  it('清掉上一轮留下的临时目录', async (context) => {
    const owner = await ownerFor(context);
    const { reap, trees, logs, scope } = setup(owner);
    scope.set({ list: '' });
    const left = [randomUUID(), randomUUID()].map((id) => tmpOf(trees, id));
    for (const dir of left) {
      mkdirSync(join(dir, 'ssr'), { recursive: true });
      writeFileSync(join(dir, 'ssr', 'cache'), 'x');
    }
    expect(await reap()).toBe(0);
    for (const dir of left) expect(existsSync(dir)).toBe(false);
    expect(logs.map((l) => l.message)).toContain('删掉上一轮会话留下的临时目录 2 个');
  });

  it('【故意造出的失败】删不掉的目录留着、日志明说是哪个；列不出来也只记日志、不抛', async (context) => {
    const owner = await ownerFor(context);
    const { reap, trees, logs, scope } = setup(owner);
    scope.set({ list: '' });
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

  function handoffSetup(owner: OrphanOwner) {
    const trees = fakeTrees(join(owner.root, 'work'));
    const scope = owner.scope();
    const logs: Logged[] = [];
    const ioRoot = join(owner.root, 'io');
    const delayed: { fn: () => void; ms: number }[] = [];
    const mirasimStops: MirasimHandle[] = [];
    let clock = NOW;
    const reap = owner.reaper({
      trees: trees.trees,
      helper: scope.helper,
      sudo: scope.sudo,
      ioRoot,
      later: (fn, ms) => void delayed.push({ fn: owner.delayed(fn), ms }),
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

  const open = (owner: OrphanOwner, id: string) =>
    startRun(owner.t.db, { id, segment: 'manual', model: 'grok-4.7', routeId: 'carpool', startedAt: NOW });

  it('冷验收的独立 verify 目录在重启清扫后仍留给同一次会话接回', async (context) => {
    const owner = await ownerFor(context);
    const { reap, trees, ioRoot } = handoffSetup(owner);
    const runId = randomUUID();
    const cwd = tmpOf(trees, `verify-${randomUUID()}`);
    await startRun(owner.t.db, {
      id: runId,
      segment: 'verify',
      model: 'gpt-model',
      startedAt: NOW,
      worktreePath: cwd,
    });
    ioCell(ioRoot, runId, NOW);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'checkout'), 'PR head');
    expect(await reap()).toBe(0);
    expect(existsSync(join(cwd, 'checkout'))).toBe(true);
    expect(await getRun(owner.t.db, runId)).toMatchObject({ endedAt: null, worktreePath: cwd });
  });

  it.for(['cli', 'mirasim'])('独立验收目录只在 %s 会话过 TTL 且尚未接回时回收', async (host, context) => {
    const owner = await ownerFor(context);
    const { reap, trees, ioRoot, delayed, setNow } = handoffSetup(owner);
    const runId = randomUUID();
    const cwd = tmpOf(trees, `verify-${randomUUID()}`);
    await startRun(owner.t.db, {
      id: runId,
      segment: 'verify',
      model: 'test',
      startedAt: NOW,
      worktreePath: cwd,
    });
    if (host === 'mirasim') mirasimCell(ioRoot, runId, NOW);
    else ioCell(ioRoot, runId, NOW);
    mkdirSync(cwd, { recursive: true });
    await reap();
    expect(existsSync(cwd)).toBe(true);
    setNow(new Date(NOW.getTime() + HANDOFF_TTL_MS));
    for (const timer of delayed) timer.fn();
    await vi.waitFor(async () => expect((await getRun(owner.t.db, runId))?.outcome).toBe('killed'));
    expect(existsSync(cwd)).toBe(false);
  });

  it('验收已经接回时旧清扫器不删真实 cwd；重新放手的标记不能被旧计时器提前收', async (context) => {
    const owner = await ownerFor(context);
    const { reap, trees, ioRoot, delayed, setNow } = handoffSetup(owner);
    const claimed = randomUUID();
    const detachedAgain = randomUUID();
    const dirs = new Map<string, string>();
    for (const id of [claimed, detachedAgain]) {
      const cwd = tmpOf(trees, `verify-${randomUUID()}`);
      dirs.set(id, cwd);
      await startRun(owner.t.db, { id, segment: 'verify', model: 'test', startedAt: NOW, worktreePath: cwd });
      ioCell(ioRoot, id, NOW);
      mkdirSync(cwd, { recursive: true });
    }
    await reap();
    rmSync(join(ioRoot, claimed, DETACHED_MARK));
    writeFileSync(
      join(ioRoot, detachedAgain, DETACHED_MARK),
      new Date(NOW.getTime() + HANDOFF_TTL_MS - 1).toISOString(),
    );
    setNow(new Date(NOW.getTime() + HANDOFF_TTL_MS));
    for (const timer of [...delayed]) timer.fn();
    await vi.waitFor(() => expect(delayed).toHaveLength(2));
    for (const cwd of dirs.values()) expect(existsSync(cwd)).toBe(true);
    expect((await getRun(owner.t.db, detachedAgain))?.endedAt).toBeNull();
    setNow(new Date(NOW.getTime() + 2 * HANDOFF_TTL_MS));
    delayed[1]?.fn();
    await vi.waitFor(async () => expect((await getRun(owner.t.db, detachedAgain))?.outcome).toBe('killed'));
    expect(existsSync(dirs.get(claimed) ?? '')).toBe(true);
    expect(existsSync(dirs.get(detachedAgain) ?? '')).toBe(false);
  });

  it.for(['missing-run', 'missing-cwd', 'outside-root', 'bad-marker', 'bad-handle'])(
    '交接证据 %s 不明时先失败，不收 scope 或目录',
    async (problem, context) => {
      const owner = await ownerFor(context);
      const { reap, trees, ioRoot, scope } = handoffSetup(owner);
      const id = randomUUID();
      const cwd =
        problem === 'outside-root' ? join(owner.root, 'user-files') : tmpOf(trees, `verify-${randomUUID()}`);
      mkdirSync(cwd, { recursive: true });
      if (problem !== 'missing-run')
        await startRun(owner.t.db, {
          id,
          segment: 'verify',
          model: 'test',
          startedAt: NOW,
          ...(problem === 'missing-cwd' ? {} : { worktreePath: cwd }),
        });
      const io = ioCell(ioRoot, id, NOW);
      if (problem === 'bad-marker') {
        rmSync(join(io, DETACHED_MARK));
        mkdirSync(join(io, DETACHED_MARK));
      }
      if (problem === 'bad-handle') writeFileSync(join(io, 'mirasim.json'), '{broken');
      scope.set({ list: `${id} active\n` });
      await expect(reap()).rejects.toThrow();
      expect(scope.calls().filter((c) => c.action === 'stop')).toEqual([]);
      expect(existsSync(cwd)).toBe(true);
    },
  );

  it('终态验收的残留标记不使独立 cwd 永久保留', async (context) => {
    const owner = await ownerFor(context);
    const { reap, trees, ioRoot } = handoffSetup(owner);
    const id = randomUUID();
    const cwd = tmpOf(trees, `verify-${randomUUID()}`);
    await startRun(owner.t.db, {
      id,
      segment: 'verify',
      model: 'test',
      startedAt: NOW,
      endedAt: NOW,
      outcome: 'done',
      worktreePath: cwd,
    });
    ioCell(ioRoot, id, NOW);
    mkdirSync(cwd, { recursive: true });
    await reap();
    expect(existsSync(cwd)).toBe(false);
    expect((await getRun(owner.t.db, id))?.outcome).toBe('done');
  });

  it('上一个引擎刚放手的：scope 不收、临时目录不删、runs 那一行不收、收发目录留着；同一轮别的照孤儿收', async (context) => {
    const owner = await ownerFor(context);
    const { reap, trees, scope, ioRoot, delayed } = handoffSetup(owner);
    const kept = randomUUID();
    const orphan = randomUUID();
    scope.set({ list: `${kept} active\n${orphan} active\n` });
    await open(owner, kept);
    await open(owner, orphan);
    const keptIo = ioCell(ioRoot, kept, new Date(NOW.getTime() - 60_000));
    const doneIo = ioCell(ioRoot, randomUUID());
    for (const id of [kept, orphan]) mkdirSync(tmpOf(trees, id), { recursive: true });

    expect(await reap()).toBe(1);
    const stopped = scope.calls().filter((c) => c.action === 'stop');
    expect(stopped.map((c) => c.args[0])).toEqual([orphan]);
    expect(existsSync(tmpOf(trees, kept))).toBe(true);
    expect(existsSync(tmpOf(trees, orphan))).toBe(false);
    expect(await getRun(owner.t.db, kept)).toMatchObject({ endedAt: null, outcome: null });
    expect(await getRun(owner.t.db, orphan)).toMatchObject({
      outcome: 'killed',
      failureReason: ORPHAN_RUN_REASON,
    });
    // 没有放手标记的收发目录（收过场、被叫停的）删掉；等人接回的留着
    expect(existsSync(keptIo)).toBe(true);
    expect(existsSync(doneIo)).toBe(false);
    // 过了时限还没人接回的，起来以后再清一次
    expect(delayed.map((d) => d.ms)).toEqual([HANDOFF_TTL_MS]);
  });

  it('【故意造出的失败】放手以后过了时限没人接回：延迟清扫把 scope、收发目录、临时目录、runs 那一行照孤儿收掉；已经接回的（标记删了）不碰', async (context) => {
    const owner = await ownerFor(context);
    const { reap, trees, scope, ioRoot, delayed, setNow } = handoffSetup(owner);
    const lost = randomUUID();
    const claimed = randomUUID();
    scope.set({ list: `${lost} active\n${claimed} active\n` });
    for (const id of [lost, claimed]) {
      await open(owner, id);
      ioCell(ioRoot, id, NOW);
      mkdirSync(tmpOf(trees, id), { recursive: true });
    }
    expect(await reap()).toBe(0);
    // claimed 这时被工作流接回了：Spawner 删了标记
    rmSync(join(ioRoot, claimed, DETACHED_MARK));
    setNow(new Date(NOW.getTime() + HANDOFF_TTL_MS));
    for (const d of delayed) d.fn();
    await vi.waitFor(async () => expect((await getRun(owner.t.db, lost))?.outcome).toBe('killed'));
    expect(await getRun(owner.t.db, lost)).toMatchObject({ failureReason: UNCLAIMED_RUN_REASON });
    expect(await getRun(owner.t.db, claimed)).toMatchObject({ endedAt: null });
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

  it('【故意造出的失败】标记早就过了时限（引擎停了很久才起来）：起来那一下就照孤儿收，不等', async (context) => {
    const owner = await ownerFor(context);
    const { reap, scope, ioRoot, delayed } = handoffSetup(owner);
    const stale = randomUUID();
    scope.set({
      list: `${stale} active
`,
    });
    await open(owner, stale);
    ioCell(ioRoot, stale, new Date(NOW.getTime() - HANDOFF_TTL_MS - 1));
    expect(await reap()).toBe(1);
    expect(
      scope
        .calls()
        .filter((c) => c.action === 'stop')
        .map((c) => c.args[0]),
    ).toEqual([stale]);
    expect(await getRun(owner.t.db, stale)).toMatchObject({
      outcome: 'killed',
      failureReason: ORPHAN_RUN_REASON,
    });
    expect(existsSync(join(ioRoot, stale))).toBe(false);
    expect(delayed).toEqual([]);
  });

  it('Mirasim（#2815）：刚放手的不收、不给服务端发 stop，runs 那一行和临时目录、交接目录都留着等接回', async (context) => {
    const owner = await ownerFor(context);
    const { reap, trees, scope, ioRoot, delayed, mirasimStops } = handoffSetup(owner);
    const kept = randomUUID();
    // Mirasim 没有本机 scope：列出来是空的
    scope.set({ list: '' });
    await open(owner, kept);
    const dir = mirasimCell(ioRoot, kept, new Date(NOW.getTime() - 60_000));
    mkdirSync(tmpOf(trees, kept), { recursive: true });
    expect(await reap()).toBe(0);
    expect(mirasimStops).toEqual([]);
    expect(scope.calls().filter((c) => c.action === 'stop')).toEqual([]);
    expect(await getRun(owner.t.db, kept)).toMatchObject({ endedAt: null, outcome: null });
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(tmpOf(trees, kept))).toBe(true);
    expect(delayed.map((d) => d.ms)).toEqual([HANDOFF_TTL_MS]);
  });

  it('【故意造出的失败】Mirasim 放手以后过了时限没人接回：延迟清扫这时才给服务端发 stop，再收 runs 那一行、交接目录、临时目录；已经接回的（标记删了）不碰', async (context) => {
    const owner = await ownerFor(context);
    const { reap, trees, scope, ioRoot, delayed, mirasimStops, setNow } = handoffSetup(owner);
    const lost = randomUUID();
    const claimed = randomUUID();
    scope.set({ list: '' });
    for (const id of [lost, claimed]) {
      await open(owner, id);
      mirasimCell(ioRoot, id, NOW);
      mkdirSync(tmpOf(trees, id), { recursive: true });
    }
    expect(await reap()).toBe(0);
    expect(mirasimStops).toEqual([]);
    rmSync(join(ioRoot, claimed, DETACHED_MARK));
    setNow(new Date(NOW.getTime() + HANDOFF_TTL_MS));
    for (const d of delayed) d.fn();
    await vi.waitFor(async () => expect((await getRun(owner.t.db, lost))?.outcome).toBe('killed'));
    expect(mirasimStops).toEqual([expect.objectContaining({ runId: lost, sessionKey: `claude:${lost}` })]);
    expect(await getRun(owner.t.db, lost)).toMatchObject({ failureReason: UNCLAIMED_RUN_REASON });
    expect(await getRun(owner.t.db, claimed)).toMatchObject({ endedAt: null });
    // Mirasim 的会话不在本机 scope 里：不去收 scope
    expect(scope.calls().filter((c) => c.action === 'stop')).toEqual([]);
    expect(existsSync(join(ioRoot, lost))).toBe(false);
    expect(existsSync(tmpOf(trees, lost))).toBe(false);
    expect(existsSync(join(ioRoot, claimed))).toBe(true);
  });

  it('【故意造出的失败】Mirasim 标记早就过了时限（引擎停了很久才起来）：起来那一下就发 stop 收掉，不等', async (context) => {
    const owner = await ownerFor(context);
    const { reap, ioRoot, delayed, mirasimStops, scope } = handoffSetup(owner);
    const stale = randomUUID();
    scope.set({ list: '' });
    await open(owner, stale);
    mirasimCell(ioRoot, stale, new Date(NOW.getTime() - HANDOFF_TTL_MS - 1));
    await reap();
    expect(mirasimStops).toEqual([expect.objectContaining({ runId: stale })]);
    expect(await getRun(owner.t.db, stale)).toMatchObject({
      outcome: 'killed',
      failureReason: ORPHAN_RUN_REASON,
    });
    expect(existsSync(join(ioRoot, stale))).toBe(false);
    expect(delayed).toEqual([]);
  });

  it('Mirasim 的 stop 没发成：只记日志，照样收本机的东西、不挡工人接活', async (context) => {
    const owner = await ownerFor(context);
    const { ioRoot, trees, scope, logs } = handoffSetup(owner);
    const stale = randomUUID();
    scope.set({ list: '' });
    await open(owner, stale);
    mirasimCell(ioRoot, stale, new Date(NOW.getTime() - HANDOFF_TTL_MS - 1));
    const reap = owner.reaper({
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
