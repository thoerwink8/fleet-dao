// 仅固定 child 调用。Linux 私有目录，SQLite 原生事务/恢复；不自建 WAL、TTL 锁或 tombstone。

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type AdmissionAlertObservation,
  admissionAlertIdentityJson,
  admissionAlertJson,
  admissionAlertKey,
  admissionAlertRecordHash,
  createDb,
  insertAdmissionUnknownAlertOnce,
} from '@fleet-dao/db';
import {
  AlertObservationSchema,
  type AlertOutcome,
  type AlertUnknownCode,
} from './admission-alert-protocol.ts';

export const ALERT_SPOOL_LIMITS = Object.freeze({
  rows: 256,
  payloadBytes: 1024 * 1024,
  pageSize: 4096,
  pages: 1024,
  databaseBytes: 4 * 1024 * 1024,
  // 无 spill/savepoint/ATTACH：一份原页像，每页4字节页号+4字节校验；保留两份最大扇区余量。
  journalBytes: 1024 * (4096 + 8) + 2 * 65536,
});
const NAME = 'pending.sqlite';
const APP_ID = 0x46444131;
const TABLE_SQL =
  'CREATE TABLE pending (key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, record_hash TEXT NOT NULL) STRICT';
const fail = (code: AlertUnknownCode): never => {
  throw new SpoolError(code);
};
class SpoolError extends Error {
  readonly code: AlertUnknownCode;
  constructor(code: AlertUnknownCode) {
    super(code);
    this.code = code;
  }
}
function errorCode(error: unknown): AlertUnknownCode {
  if (error instanceof SpoolError) return error.code;
  const e = error as { code?: string; errcode?: number };
  if ((e.errcode !== undefined && [5, 6].includes(e.errcode & 255)) || e.code === 'SQLITE_BUSY')
    return 'busy';
  if (e.errcode !== undefined && [11, 26].includes(e.errcode & 255)) return 'corrupt';
  if (e.errcode !== undefined && (e.errcode & 255) === 13) return 'capacity';
  return 'io';
}
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;

// 本进程已经整表核过的提交代次，只省连续写入的整表重解。
// 不记住时，每次打开和事务里各 prepare 一次全表：256 次是 512 次 prepare、65280 行解码。
// 这是读取次数，不是原完整 CI 首红的等待阶段；那次运行没有失败阶段输出。
// 文件身份或 SQLite 头计数对不上就整表重解。close 失败不清这份记忆。
// 记忆只覆盖 SQLite 自己提交会改动的头和元数据：dev/ino/size/mtime 加上 change/schema/pages。
// 命中后仍核行数和 payload 字节，schema 与 quick_check 每次都跑；整行解码（含 record_hash 对规范哈希）
// 留在代次不中、行数或字节对不上、以及没有记忆时。清掉记忆后同一库回到整表解码。
// 同 inode、同大小、头字段不变、再把 mtime 拨回去的同长 record_hash 原字节改写，不在这个模型里。
// 那要冻结元数据，不是普通 SQL UPDATE（UPDATE 会推进 change counter），也不把它当成已经发生的生产事故。
type DbGeneration = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  change: number;
  schema: number;
  pages: number;
};
type ValidatedDb = DbGeneration & { rows: number; payloadBytes: number };
let validatedDb: ValidatedDb | undefined;
// 本进程已经把该父目录的目录项同步过。新叶仍要再同步；已有叶的重开不必再付一次 fsync。
const syncedParentInodes = new Set<string>();

function sqlNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return Number.NaN;
}

function sameGeneration(a: DbGeneration, b: DbGeneration): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.change === b.change &&
    a.schema === b.schema &&
    a.pages === b.pages
  );
}

function readDbGeneration(dbPath: string): DbGeneration | undefined {
  let fd: number;
  try {
    fd = openSync(dbPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    const data = Buffer.alloc(100);
    let offset = 0;
    while (offset < data.length) {
      const n = readSync(fd, data, offset, data.length - offset, offset);
      if (n === 0) return undefined;
      offset += n;
    }
    if (!data.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) return undefined;
    const pageSize = data.readUInt16BE(16);
    if (pageSize !== 4096) return undefined;
    return {
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      change: data.readUInt32BE(24),
      schema: data.readUInt32BE(40),
      pages: data.readUInt32BE(28),
    };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

class PrivatePath {
  readonly path: string;
  private anchors: { path: string; fd: number; initial: Stats }[] = [];
  private dbIdentity: Stats | undefined;
  constructor(path: string) {
    if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0) fail('unsupported');
    if (!isAbsolute(path) || resolve(path) !== path || path === parse(path).root) fail('private_path');
    this.path = path;
    const uid = process.getuid?.();
    try {
      const root = parse(path).root;
      let next = root;
      for (const piece of ['', ...path.slice(root.length).split('/')]) {
        next = piece ? join(next, piece) : next;
        const leaf = next === path;
        try {
          let createdLeaf = false;
          if (leaf) {
            try {
              mkdirSync(next, { mode: 0o700 });
              createdLeaf = true;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            }
          }
          const fd = openSync(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          const s = fstatSync(fd);
          this.anchors.push({ path: next, fd, initial: s });
          if (
            !s.isDirectory() ||
            (s.uid !== 0 && s.uid !== uid) ||
            (s.mode & 0o022) !== 0 ||
            (leaf && (s.uid !== uid || (s.mode & 0o777) !== 0o700))
          )
            fail('private_path');
          if (!same(s, lstatSync(next))) fail('private_path');
          // 新叶，或本进程还没同步过这个父目录（含别的进程创建后崩溃），都要同步父目录。EXTRA 不替代。
          const parent = this.anchors[this.anchors.length - 2];
          if (leaf && parent) {
            const id = `${parent.initial.dev}:${parent.initial.ino}`;
            if (createdLeaf || !syncedParentInodes.has(id)) {
              fsyncSync(parent.fd);
              syncedParentInodes.add(id);
            }
          }
        } catch (e) {
          if (e instanceof SpoolError) throw e;
          fail('private_path');
        }
      }
      this.check();
    } catch (e) {
      this.close();
      throw e;
    }
  }
  check(): void {
    for (const a of this.anchors) {
      const now = lstatSync(a.path);
      if (!same(a.initial, now) || !same(a.initial, fstatSync(a.fd)) || now.mode !== a.initial.mode)
        fail('private_path');
    }
    for (const name of readdirSync(this.path)) {
      if (name !== NAME && name !== `${NAME}-journal`) fail('private_path');
      let s: Stats;
      try {
        s = lstatSync(join(this.path, name));
      } catch (e) {
        // 活跃的 DELETE journal 可在 enumerate/stat 之间合法消失。
        if (name.endsWith('-journal') && (e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1)
        fail('private_path');
      if (s.size > (name === NAME ? ALERT_SPOOL_LIMITS.databaseBytes : ALERT_SPOOL_LIMITS.journalBytes))
        fail('capacity');
      if (name === NAME && this.dbIdentity && !same(this.dbIdentity, s)) fail('private_path');
    }
  }
  pinDatabase(): boolean {
    const path = join(this.path, NAME);
    // 孤立journal不是空spool：不造新主库去覆盖/冒领未明的恢复责任。
    const entries = readdirSync(this.path);
    if (!entries.includes(NAME) && entries.includes(`${NAME}-journal`)) fail('corrupt');
    let created = false;
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    }
    try {
      this.dbIdentity = fstatSync(fd);
      this.check();
      if (!created && this.dbIdentity.size === 0) fail('corrupt');
      if (created) {
        fsyncSync(fd);
        this.sync();
      }
    } finally {
      closeSync(fd);
    }
    return created;
  }
  checkRecoveryBounds(): void {
    let fd: number;
    try {
      fd = openSync(join(this.path, `${NAME}-journal`), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600)
        fail('private_path');
      if (s.size > ALERT_SPOOL_LIMITS.journalBytes) fail('capacity');
      const data = Buffer.alloc(ALERT_SPOOL_LIMITS.journalBytes + 1);
      let length = 0;
      while (length < data.length) {
        const n = readSync(fd, data, length, data.length - length, length);
        if (n === 0) break;
        length += n;
      }
      if (length > ALERT_SPOOL_LIMITS.journalBytes) fail('capacity');
      // 只核可能恢复的页数/字节界，恢复仍全由SQLite完成；不改写/删除journal。
      const magic = Buffer.from('d9d505f920a163d7', 'hex');
      // 原生writeJournalHdr在同步前可合法留下零magic；明确异格式或截断magic不交给后续写覆盖。
      const prefix = data.subarray(0, Math.min(8, length));
      if (prefix.some((b) => b !== 0) && (!prefix.equals(magic) || length < 28)) fail('corrupt');
      // 本能力从不ATTACH；super-journal尾指针不属于受管格式，不能让SQLite沿它访问别的路径。
      if (length >= 8 && data.subarray(length - 8, length).equals(magic)) fail('corrupt');
      let offset = 0,
        sector = 512;
      while (offset + 28 <= length && data.subarray(offset, offset + 8).equals(magic)) {
        const pages = data.readUInt32BE(offset + 16);
        const pageSize = data.readUInt32BE(offset + 24);
        const reportedSector = data.readUInt32BE(offset + 20);
        if (
          pages > 1024 ||
          pageSize !== 4096 ||
          reportedSector < 32 ||
          reportedSector > 65536 ||
          (reportedSector & (reportedSector - 1)) !== 0
        )
          fail('corrupt');
        if (offset === 0) sector = reportedSector;
        else if (reportedSector !== sector) fail('corrupt');
        let count = data.readUInt32BE(offset + 8);
        offset += sector;
        if (count === 0xffffffff) count = Math.floor((length - offset) / 4104);
        if (count > 1024 || offset + count * 4104 > length) fail('corrupt');
        for (let i = 0; i < count; i++) {
          const page = data.readUInt32BE(offset + i * 4104);
          if (page === 0 || page > 1024) fail('corrupt');
        }
        offset = Math.ceil((offset + count * 4104) / sector) * sector;
      }
    } finally {
      closeSync(fd);
    }
  }
  sync(): void {
    const leaf = this.anchors[this.anchors.length - 1];
    if (!leaf) throw new SpoolError('private_path');
    fsyncSync(leaf.fd);
  }
  close(): void {
    for (const a of this.anchors.splice(0).reverse()) closeSync(a.fd);
  }
}

class Spool {
  private readonly path: PrivatePath;
  private db: DatabaseSync | undefined;
  constructor(path: string) {
    this.path = new PrivatePath(path);
    try {
      const created = this.path.pinDatabase();
      this.path.checkRecoveryBounds();
      // 所有祖先仅root/可信UID可写；字符串路径不假称dirfd锚定。前后身份复核。
      this.db = new DatabaseSync(join(path, NAME), {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
      });
      const d = this.db;
      d.exec(
        'PRAGMA busy_timeout=0; PRAGMA temp_store=MEMORY; PRAGMA cache_spill=OFF; PRAGMA trusted_schema=OFF; PRAGMA synchronous=EXTRA',
      );
      if (created) d.exec('PRAGMA page_size=4096; PRAGMA auto_vacuum=NONE');
      const one = (sql: string) => Object.values(d.prepare(sql).get() ?? {})[0];
      if (
        one('PRAGMA page_size') !== 4096 ||
        one('PRAGMA max_page_count=1024') !== 1024 ||
        (one('PRAGMA page_count') as number) > 1024 ||
        one('PRAGMA journal_mode=DELETE') !== 'delete' ||
        one('PRAGMA synchronous') !== 3 ||
        one('PRAGMA busy_timeout') !== 0 ||
        one('PRAGMA temp_store') !== 2 ||
        one('PRAGMA cache_spill') !== 0 ||
        one('PRAGMA auto_vacuum') !== 0
      )
        fail('capacity');
      if (created) {
        d.exec('BEGIN IMMEDIATE');
        d.exec(TABLE_SQL);
        d.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=1`);
        d.exec('COMMIT');
        this.path.sync();
      }
      this.validate();
    } catch (e) {
      this.close();
      throw e;
    }
  }
  private validate(): ValidatedDb | undefined {
    const d = this.db as DatabaseSync;
    this.path.check();
    if (
      d.prepare('PRAGMA application_id').get()?.application_id !== APP_ID ||
      d.prepare('PRAGMA user_version').get()?.user_version !== 1
    )
      fail('corrupt');
    const schema = d.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all();
    if (
      schema.length !== 2 ||
      schema[0]?.name !== 'pending' ||
      schema[0]?.type !== 'table' ||
      schema[0]?.sql !== TABLE_SQL ||
      schema[1]?.name !== 'sqlite_autoindex_pending_1' ||
      schema[1]?.type !== 'index' ||
      schema[1]?.sql !== null
    )
      fail('corrupt');
    if (d.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') fail('corrupt');
    const generation = readDbGeneration(join(this.path.path, NAME));
    if (generation && validatedDb && sameGeneration(validatedDb, generation)) {
      const total = d
        .prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM pending')
        .get();
      const rows = sqlNumber(total?.n);
      const payloadBytes = sqlNumber(total?.bytes);
      if (rows !== validatedDb.rows || payloadBytes !== validatedDb.payloadBytes) fail('corrupt');
      return validatedDb;
    }
    const rows = d.prepare('SELECT key,payload,record_hash FROM pending').all();
    if (rows.length > ALERT_SPOOL_LIMITS.rows) fail('capacity');
    let bytes = 0;
    for (const r of rows) {
      this.decode(r);
      bytes += Buffer.byteLength(r.payload as string);
    }
    if (bytes > ALERT_SPOOL_LIMITS.payloadBytes) fail('capacity');
    if (!generation) return undefined;
    validatedDb = { ...generation, rows: rows.length, payloadBytes: bytes };
    return validatedDb;
  }
  // 只在本次 INSERT 已提交且头计数正好 +1 时推进代次。对不上就留空，下次整表重解；不把 close 失败写成这一代无效。
  private rememberInsert(seen: ValidatedDb | undefined, payloadBytes: number): void {
    if (!seen) return;
    const generation = readDbGeneration(join(this.path.path, NAME));
    if (
      !generation ||
      generation.dev !== seen.dev ||
      generation.ino !== seen.ino ||
      generation.schema !== seen.schema
    )
      return;
    if (generation.change !== (seen.change + 1) >>> 0) return;
    const rows = seen.rows + 1;
    const bytes = seen.payloadBytes + payloadBytes;
    if (rows > ALERT_SPOOL_LIMITS.rows || bytes > ALERT_SPOOL_LIMITS.payloadBytes) return;
    validatedDb = { ...generation, rows, payloadBytes: bytes };
  }
  private decode(row: Record<string, unknown>): AdmissionAlertObservation {
    if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > 4096) fail('corrupt');
    let o: AdmissionAlertObservation;
    try {
      o = AlertObservationSchema.parse(JSON.parse(row.payload as string));
    } catch {
      return fail('corrupt');
    }
    if (
      row.payload !== admissionAlertJson(o) ||
      row.key !== admissionAlertKey(o.identity) ||
      row.record_hash !== admissionAlertRecordHash(o)
    )
      fail('corrupt');
    return o;
  }
  record(input: AdmissionAlertObservation): AlertOutcome {
    const o = AlertObservationSchema.parse(input);
    const key = admissionAlertKey(o.identity);
    const d = this.db as DatabaseSync;
    d.exec('BEGIN IMMEDIATE');
    try {
      const seen = this.validate();
      const row = d.prepare('SELECT key,payload,record_hash FROM pending WHERE key=?').get(key);
      if (row) {
        if (admissionAlertIdentityJson(this.decode(row).identity) !== admissionAlertIdentityJson(o.identity))
          fail('corrupt');
        d.exec('COMMIT');
        this.path.check();
        return { kind: 'spooled', key, recordHash: row.record_hash as string };
      }
      const total = d
        .prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM pending')
        .get();
      const payload = admissionAlertJson(o),
        recordHash = admissionAlertRecordHash(o);
      if (
        !total ||
        (total.n as number) >= 256 ||
        (total.bytes as number) + Buffer.byteLength(payload) > 1024 * 1024
      )
        fail('capacity');
      d.prepare('INSERT INTO pending(key,payload,record_hash) VALUES(?,?,?)').run(key, payload, recordHash);
      d.exec('COMMIT');
      this.path.check();
      this.rememberInsert(seen, Buffer.byteLength(payload));
      return { kind: 'spooled', key, recordHash };
    } catch (e) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* 原责任不丢弃 */
      }
      throw e;
    }
  }
  peek(): { key: string; recordHash: string; observation: AdmissionAlertObservation } | undefined {
    const d = this.db as DatabaseSync;
    // 读事务在PG连接前结束，不跨网络持写事务/读锁。
    d.exec('BEGIN');
    try {
      this.validate();
      const row = d.prepare('SELECT key,payload,record_hash FROM pending ORDER BY key LIMIT 1').get();
      const result = row
        ? { key: row.key as string, recordHash: row.record_hash as string, observation: this.decode(row) }
        : undefined;
      d.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* 不抹原错 */
      }
      throw e;
    }
  }
  // 仅transfer方法闭包可调用；公共coordinator无caller提供ack的入口。
  async transfer(databaseUrl: string, deadlineAt: number): Promise<AlertOutcome> {
    const row = this.peek();
    if (!row) return { kind: 'empty' };
    let connection: ReturnType<typeof createDb> | undefined;
    let persisted: Awaited<ReturnType<typeof insertAdmissionUnknownAlertOnce>>;
    try {
      connection = createDb({ url: databaseUrl, max: 1 });
      persisted = await connection.db.transaction(async (tx) => {
        const ms = Math.max(1, Math.min(4000, Math.floor(deadlineAt - performance.now())));
        await tx.execute(`set local statement_timeout = ${ms}`);
        await tx.execute(`set local lock_timeout = ${Math.min(1000, ms)}`);
        await tx.execute(`set local idle_in_transaction_session_timeout = ${ms}`);
        return insertAdmissionUnknownAlertOnce(tx, row.observation);
      });
    } catch {
      persisted = { kind: 'unknown', code: 'store_unavailable' };
    }
    try {
      if (connection) await connection.close();
    } catch {
      return { kind: 'unknown', code: 'store_unavailable' };
    }
    if (persisted.kind === 'unknown') return persisted;
    if (performance.now() >= deadlineAt) return { kind: 'unknown', code: 'deadline' };
    const d = this.db as DatabaseSync;
    d.exec('BEGIN IMMEDIATE');
    try {
      this.validate();
      d.prepare('DELETE FROM pending WHERE key=? AND record_hash=?').run(row.key, row.recordHash);
      d.exec('COMMIT');
      this.path.check();
    } catch (e) {
      try {
        d.exec('ROLLBACK');
      } catch {
        /* 保留pending/PG责任并集 */
      }
      throw e;
    }
    return {
      kind: 'transferred',
      key: row.key,
      recordHash: row.recordHash,
      notificationId: persisted.notificationId,
    };
  }
  // 复用前再核路径和 journal 上界。代次对不上就返回 false，调用方冷打开；核验失败照旧抛出，不能先让 SQLite 回放。
  revalidateOpen(): boolean {
    this.path.check();
    this.path.checkRecoveryBounds();
    const generation = readDbGeneration(join(this.path.path, NAME));
    return Boolean(this.db && generation && validatedDb && sameGeneration(validatedDb, generation));
  }
  close(): void {
    try {
      this.db?.close();
    } finally {
      this.db = undefined;
      this.path.close();
    }
  }
}

// 同进程连续写入复用已提交、未持锁的连接，避免每次重开再付一次打开和 DELETE journal 建立。
// 跨调用不持有事务；代次变化、路径/journal 核验失败或本次抛错就关掉。
// 少重开不是原 15 秒首红已经定位完成。
type CachedSpool = { path: string; spool: Spool; held: boolean };
let cachedSpool: CachedSpool | undefined;

function dropCached(spool: Spool | undefined): void {
  if (cachedSpool?.spool === spool) cachedSpool = undefined;
  try {
    spool?.close();
  } catch {
    /* 关掉失败不改这次的结果 */
  }
}

function takeSpool(path: string): { spool: Spool; ownsCache: boolean } {
  if (cachedSpool?.path === path && !cachedSpool.held) {
    const current = cachedSpool.spool;
    try {
      if (current.revalidateOpen()) {
        cachedSpool.held = true;
        return { spool: current, ownsCache: true };
      }
    } catch (e) {
      cachedSpool = undefined;
      dropCached(current);
      throw e;
    }
    dropCached(current);
  } else if (cachedSpool && !cachedSpool.held) {
    dropCached(cachedSpool.spool);
  }
  const spool = new Spool(path);
  const ownsCache = !cachedSpool?.held;
  if (ownsCache) cachedSpool = { path, spool, held: true };
  return { spool, ownsCache };
}

function finishSpool(spool: Spool, ownsCache: boolean, keep: boolean): void {
  if (keep && ownsCache && cachedSpool?.spool === spool) {
    cachedSpool.held = false;
    return;
  }
  dropCached(spool);
}

export function recordAdmissionAlert(path: string, input: AdmissionAlertObservation): AlertOutcome {
  let spool: Spool | undefined;
  let ownsCache = false;
  let keep = false;
  try {
    const got = takeSpool(path);
    spool = got.spool;
    ownsCache = got.ownsCache;
    const result = spool.record(input);
    keep = true;
    return result;
  } catch (e) {
    return { kind: 'unknown', code: errorCode(e) };
  } finally {
    if (spool) finishSpool(spool, ownsCache, keep);
  }
}
export async function transferOneAdmissionAlert(
  path: string,
  databaseUrl: string,
  deadlineAt: number,
): Promise<AlertOutcome> {
  let spool: Spool | undefined;
  let ownsCache = false;
  let keep = false;
  try {
    const got = takeSpool(path);
    spool = got.spool;
    ownsCache = got.ownsCache;
    const result = await spool.transfer(databaseUrl, deadlineAt);
    keep = true;
    return result;
  } catch (e) {
    return { kind: 'unknown', code: errorCode(e) };
  } finally {
    if (spool) finishSpool(spool, ownsCache, keep);
  }
}
