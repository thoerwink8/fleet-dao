// patrol.test.ts 的真实 SQL 夹具（#3524）：一份隔离的 PGlite，按生产表结构建好，供 REMOTE_SCRIPT 里的真实 SQL 执行。
// 为什么单拆出来：完整 CI 的 lint job 里 biome、tsc、agents_test 等并行跑，PGlite 的 WASM 装载、起库比单跑慢得多，
// 原来 beforeAll 裸 `new PGlite()` 再建表，全吃 vitest 默认 10 秒的 hook 窗：超时只报「Hook timed out」，
// 分不出是装载、起库还是建表慢，库还在后台继续起，七条真实 SQL 用例整组被跳过（CI 39653171182、39654263648）。
// 这里的合同：
// - 整个初始化共用一个期限（FIXTURE_DEADLINE_MS），比 hook 窗（FIXTURE_HOOK_MS，和 packages/db/src/testing.ts 的
//   TEST_DB_TIMEOUT_MS 同一个 60 秒）短，所以超时由这里先报，错误里写明卡在哪一段（load / construct / ready / schema）；
// - 失败、超时一律先关库（有期限）再抛，迟到的装载或就绪不再往下建表、不再建库，不留后台资源；
// - 建完表要读回两张表和枚举确实在，读不到当场抛，不拿一个空库去跑 SQL 用例；
// - 关库也有期限，失败抛 close 段的错，不吞。
// 凭证、网络都不碰。
export type FixtureStage = 'load' | 'construct' | 'ready' | 'schema' | 'close';

export class PatrolSqlFixtureError extends Error {
  readonly stage: FixtureStage;
  /** 初始化失败后回收库的结果（没有库可回收时是 undefined）：'closed' 或关库失败的原因。 */
  cleanup: string | undefined;
  constructor(stage: FixtureStage, message: string, cause?: unknown) {
    super(`巡查 SQL 夹具【${stage}】${message}`, cause === undefined ? undefined : { cause });
    this.name = 'PatrolSqlFixtureError';
    this.stage = stage;
  }
}

/** 夹具用到的 PGlite 的最小形状。 */
export interface FixtureDb {
  readonly waitReady: Promise<unknown>;
  exec(sql: string): Promise<unknown>;
  query(sql: string, params: unknown[], opts: { rowMode: 'array' }): Promise<{ rows: unknown[][] }>;
  close(): Promise<void>;
}

/** 初始化整体期限、关库期限、hook 窗：期限 + 关库 < hook 窗，留出余量让夹具自己的错先出来。 */
export const FIXTURE_DEADLINE_MS = 45_000;
export const FIXTURE_CLOSE_MS = 5_000;
export const FIXTURE_HOOK_MS = 60_000;

/** 生产表结构（schedule_outcome 枚举、两张表的约束）；REMOTE_SCRIPT 的 `q jobs` 只读这两张表。 */
export const PATROL_SCHEMA_SQL = `
  create type schedule_outcome as enum ('ok', 'partial', 'unscanned', 'failed');
  create table scheduled_jobs (id text primary key, removed_at timestamptz);
  create table schedule_runs (
    id bigint generated always as identity primary key,
    job text not null references scheduled_jobs(id),
    started_at timestamptz not null default now(),
    ended_at timestamptz,
    outcome schedule_outcome,
    scanned int, found int, why text,
    check ((ended_at is null) = (outcome is null)),
    check (outcome is null or outcome = 'ok' or why is not null)
  );`;

const SCHEMA_PROBE = `select
  to_regclass('scheduled_jobs') is not null,
  to_regclass('schedule_runs') is not null,
  exists (select 1 from pg_type where typname = 'schedule_outcome')`;

export interface PatrolSqlFixtureOptions<Db extends FixtureDb> {
  /** 装载 PGlite 的构造函数（动态 import，慢也在期限内、失败也认得出是 load 段）。 */
  load: () => Promise<new () => Db>;
  schemaSql?: string;
  deadlineMs?: number;
  closeMs?: number;
}

export interface PatrolSqlFixture<Db extends FixtureDb> {
  readonly db: Db;
  /** 有期限地关库；重复调用只关一次，失败抛 close 段的错。 */
  close(): Promise<void>;
}

/** 给一个 promise 加期限；超时抛 onTimeout() 造的错，原 promise 之后的结果不再有人认领。 */
function within<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function closeWithin(db: FixtureDb, ms: number): Promise<void> {
  const closing = db.close().catch((err: unknown) => {
    throw new PatrolSqlFixtureError('close', err instanceof Error ? err.message : String(err), err);
  });
  closing.catch(() => {}); // 超时后它再失败也不能变成没人接的 rejection
  await within(closing, ms, () => new PatrolSqlFixtureError('close', `${ms}ms 内没关掉`));
}

export async function openPatrolSqlFixture<Db extends FixtureDb>(
  opts: PatrolSqlFixtureOptions<Db>,
): Promise<PatrolSqlFixture<Db>> {
  const deadlineMs = opts.deadlineMs ?? FIXTURE_DEADLINE_MS;
  const closeMs = opts.closeMs ?? FIXTURE_CLOSE_MS;
  let stage: FixtureStage = 'load';
  let db: Db | undefined;
  let abandoned = false;
  const stopIfAbandoned = () => {
    if (abandoned) throw new PatrolSqlFixtureError(stage, '期限已过，迟到的结果不再使用');
  };

  const init = (async (): Promise<Db> => {
    const Ctor = await opts.load();
    stopIfAbandoned(); // 装载迟到：不再建库
    stage = 'construct';
    const created = new Ctor();
    db = created;
    stage = 'ready';
    await created.waitReady;
    stopIfAbandoned(); // 就绪迟到：不再建表
    stage = 'schema';
    await created.exec(opts.schemaSql ?? PATROL_SCHEMA_SQL);
    stopIfAbandoned();
    const probe = await created.query(SCHEMA_PROBE, [], { rowMode: 'array' });
    if (probe.rows.length !== 1 || probe.rows[0]?.some((v) => v !== true)) {
      throw new PatrolSqlFixtureError(
        'schema',
        `建完表读回来不对（${JSON.stringify(probe.rows)}），不当成可用的库`,
      );
    }
    return created;
  })();

  let ready: Db;
  try {
    ready = await within(
      init,
      deadlineMs,
      () => new PatrolSqlFixtureError(stage, `${deadlineMs}ms 内没完成（卡在这一段）`),
    );
  } catch (err) {
    abandoned = true;
    init.catch(() => {}); // 迟到的成败都不再有人认领
    const failure =
      err instanceof PatrolSqlFixtureError
        ? err
        : new PatrolSqlFixtureError(stage, err instanceof Error ? err.message : String(err), err);
    if (db) {
      try {
        await closeWithin(db, closeMs);
        failure.cleanup = 'closed';
      } catch (closeErr) {
        failure.cleanup = `关库失败：${closeErr instanceof Error ? closeErr.message : String(closeErr)}`;
      }
    }
    throw failure;
  }

  let closed: Promise<void> | undefined;
  return {
    db: ready,
    close: () => {
      closed ??= closeWithin(ready, closeMs);
      return closed;
    },
  };
}
