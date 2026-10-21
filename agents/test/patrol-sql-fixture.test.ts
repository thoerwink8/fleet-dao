// patrol-sql-fixture.ts 的故障路径（#3524）：装载、构造、就绪、建表、读回、关库各段的失败和超时必须认得出是哪一段，
// 失败和超时后库必须被关掉，迟到的装载或就绪不能再建库、建表，建完读回不对不能当空库放行。
// 用假的库和假定时器：期限由测试自己推进，不等真实的几十秒，也不碰 PGlite。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_CLOSE_MS,
  FIXTURE_DEADLINE_MS,
  FIXTURE_HOOK_MS,
  type FixtureDb,
  openPatrolSqlFixture,
  PATROL_SCHEMA_SQL,
  type PatrolSqlFixtureError,
} from './patrol-sql-fixture.ts';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const GOOD_PROBE = [[true, true, true]];

/** 一个假库：每一段的快慢、成败由测试掌握，调用都记下来。 */
function fakeDb(
  o: {
    ready?: Promise<unknown>;
    exec?: () => Promise<unknown>;
    probe?: () => Promise<{ rows: unknown[][] }>;
    close?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const db: FixtureDb = {
    waitReady: o.ready ?? Promise.resolve(),
    exec: async (sql) => {
      calls.push(`exec:${sql === PATROL_SCHEMA_SQL ? 'schema' : 'other'}`);
      return o.exec ? o.exec() : undefined;
    },
    query: async () => {
      calls.push('query');
      return o.probe ? o.probe() : { rows: GOOD_PROBE };
    },
    close: async () => {
      calls.push('close');
      if (o.close) await o.close();
    },
  };
  // 防止测试里故意不兑现的 ready 在结束时变成没人接的 rejection
  db.waitReady.catch(() => {});
  return { db, calls };
}

const loadOf = (db: FixtureDb) => async () =>
  function Fake() {
    return db;
  } as unknown as new () => FixtureDb;

/** 开夹具并把结果（成功的夹具或抛出的错）收进一个 promise，供推进定时器后再读。 */
function start(load: () => Promise<new () => FixtureDb>) {
  const settled = openPatrolSqlFixture({ load }).then(
    (fixture) => ({ fixture, error: undefined as PatrolSqlFixtureError | undefined }),
    (error: unknown) => ({ fixture: undefined, error: error as PatrolSqlFixtureError }),
  );
  return settled;
}

describe('巡查 SQL 夹具：初始化各段失败、超时、清理（#3524）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hook 窗比初始化期限加关库期限长：夹具自己的错先出来，不让 vitest 的通用「Hook timed out」抢先', () => {
    expect(FIXTURE_DEADLINE_MS + FIXTURE_CLOSE_MS).toBeLessThan(FIXTURE_HOOK_MS);
    expect(FIXTURE_HOOK_MS).toBeGreaterThan(10_000); // 不是原来的 vitest 默认窗
  });

  it('正常就绪：建了表、读回两张表和枚举都在，才交出库；关库只关一次', async () => {
    const { db, calls } = fakeDb();
    const { fixture, error } = await start(loadOf(db));
    expect(error).toBeUndefined();
    expect(fixture?.db).toBe(db);
    expect(calls).toEqual(['exec:schema', 'query']);
    await fixture?.close();
    await fixture?.close();
    expect(calls.filter((c) => c === 'close')).toHaveLength(1);
  });

  it('装载失败：报 load 段，没有库可回收', async () => {
    const { error } = await start(async () => {
      throw new Error('找不到 @electric-sql/pglite');
    });
    expect(error?.stage).toBe('load');
    expect(error?.message).toContain('找不到 @electric-sql/pglite');
    expect(error?.cleanup).toBeUndefined();
  });

  it('装载一直不回：到期限报 load 段；装载之后才到，不再建库', async () => {
    const load = deferred<new () => FixtureDb>();
    const constructed = vi.fn();
    const settled = start(() => load.promise);
    await vi.advanceTimersByTimeAsync(FIXTURE_DEADLINE_MS);
    const { error } = await settled;
    expect(error?.stage).toBe('load');
    expect(error?.message).toContain(`${FIXTURE_DEADLINE_MS}ms`);
    load.resolve(
      class {
        constructor() {
          constructed();
        }
      } as unknown as new () => FixtureDb,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(constructed).not.toHaveBeenCalled();
  });

  it('构造抛错：报 construct 段', async () => {
    const { error } = await start(async () => {
      return class {
        constructor() {
          throw new Error('WASM 编译失败');
        }
      } as unknown as new () => FixtureDb;
    });
    expect(error?.stage).toBe('construct');
    expect(error?.message).toContain('WASM 编译失败');
  });

  it('就绪失败：报 ready 段，库被关掉，没有走到建表', async () => {
    const { db, calls } = fakeDb({ ready: Promise.reject(new Error('initdb 失败')) });
    const { error } = await start(loadOf(db));
    expect(error?.stage).toBe('ready');
    expect(error?.cleanup).toBe('closed');
    expect(calls).toEqual(['close']);
  });

  it('就绪一直不回：到期限报 ready 段并关库；就绪迟到之后不建表、不再关第二次', async () => {
    const ready = deferred<void>();
    const { db, calls } = fakeDb({ ready: ready.promise });
    const settled = start(loadOf(db));
    await vi.advanceTimersByTimeAsync(FIXTURE_DEADLINE_MS);
    const { error } = await settled;
    expect(error?.stage).toBe('ready');
    expect(error?.cleanup).toBe('closed');
    expect(calls).toEqual(['close']);
    ready.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['close']); // 迟到的就绪没有去建表、读回
  });

  it('就绪迟到的失败也不变成没人接的 rejection', async () => {
    const ready = deferred<void>();
    const { db } = fakeDb({ ready: ready.promise });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const settled = start(loadOf(db));
      await vi.advanceTimersByTimeAsync(FIXTURE_DEADLINE_MS);
      await settled;
      ready.reject(new Error('迟到的失败'));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('建表失败：报 schema 段并关库', async () => {
    const { db, calls } = fakeDb({
      exec: async () => {
        throw new Error('type "schedule_outcome" already exists');
      },
    });
    const { error } = await start(loadOf(db));
    expect(error?.stage).toBe('schema');
    expect(error?.message).toContain('already exists');
    expect(error?.cleanup).toBe('closed');
    expect(calls).toEqual(['exec:schema', 'close']);
  });

  it('建表卡住：到期限报 schema 段并关库，读回不再执行', async () => {
    const exec = deferred<void>();
    const { db, calls } = fakeDb({ exec: () => exec.promise });
    const settled = start(loadOf(db));
    await vi.advanceTimersByTimeAsync(FIXTURE_DEADLINE_MS);
    const { error } = await settled;
    expect(error?.stage).toBe('schema');
    expect(error?.cleanup).toBe('closed');
    exec.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['exec:schema', 'close']);
  });

  it.each([
    ['表没建出来', [[true, false, true]]],
    ['枚举没建出来', [[true, true, false]]],
    ['读回是空的', []],
    ['读回是 null（空库）', [[null, null, null]]],
  ])('建完读回不对（%s）：报 schema 段，不当成可用的库，库被关掉', async (_name, rows) => {
    const { db, calls } = fakeDb({ probe: async () => ({ rows: rows as unknown[][] }) });
    const { fixture, error } = await start(loadOf(db));
    expect(fixture).toBeUndefined();
    expect(error?.stage).toBe('schema');
    expect(error?.cleanup).toBe('closed');
    expect(calls).toEqual(['exec:schema', 'query', 'close']);
  });

  it('失败后回收也失败：原失败照报，cleanup 写明关库失败，不吞', async () => {
    const { db } = fakeDb({
      exec: async () => {
        throw new Error('建表失败');
      },
      close: async () => {
        throw new Error('已被占用');
      },
    });
    const { error } = await start(loadOf(db));
    expect(error?.stage).toBe('schema');
    expect(error?.cleanup).toContain('关库失败');
    expect(error?.cleanup).toContain('已被占用');
  });

  it('失败后回收卡住：关库也有期限，到点写进 cleanup，不无限等', async () => {
    const closing = deferred<void>();
    const { db } = fakeDb({
      exec: async () => {
        throw new Error('建表失败');
      },
      close: () => closing.promise,
    });
    const settled = start(loadOf(db));
    await vi.advanceTimersByTimeAsync(FIXTURE_CLOSE_MS);
    const { error } = await settled;
    expect(error?.stage).toBe('schema');
    expect(error?.cleanup).toContain('close');
    expect(error?.cleanup).toContain(`${FIXTURE_CLOSE_MS}ms`);
  });

  it('收尾关库失败：afterAll 看到的是 close 段的错', async () => {
    const { db } = fakeDb({
      close: async () => {
        throw new Error('关不掉');
      },
    });
    const { fixture } = await start(loadOf(db));
    await expect(fixture?.close()).rejects.toMatchObject({ stage: 'close' });
  });

  it('收尾关库卡住：到关库期限报 close 段', async () => {
    const closing = deferred<void>();
    const { db } = fakeDb({ close: () => closing.promise });
    const { fixture } = await start(loadOf(db));
    const closed = fixture?.close().then(
      () => undefined,
      (e: unknown) => e as PatrolSqlFixtureError,
    );
    await vi.advanceTimersByTimeAsync(FIXTURE_CLOSE_MS);
    const error = await closed;
    expect(error?.stage).toBe('close');
    expect(error?.message).toContain(`${FIXTURE_CLOSE_MS}ms`);
  });
});
