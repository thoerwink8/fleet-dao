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
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
// 本进程上次成功提交后、在写锁内读到的主库身份。只用于跳过未变更文件的逐行规范解码。
type SpoolStamp = { path: string; dev: number; ino: number; size: number; counter: number };
let committedStamp: SpoolStamp | undefined;
const sameStamp = (a: SpoolStamp | undefined, b: SpoolStamp) =>
  !!a &&
  a.path === b.path &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.counter === b.counter;
const dropStamp = () => {
  committedStamp = undefined;
};
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
// 父目录 fsync 只为把新叶目录项落盘。同一进程、同一叶目录实例（路径+父 inode+叶 dev/ino/创建时刻）成功一次后不必再做；
// 叶目录被删后同路径重建是新实例，必须重新同步父目录。
const syncedLeafParents = new Set<string>();

class PrivatePath {
  readonly path: string;
  private anchors: { path: string; fd: number; initial: Stats }[] = [];
  private dbIdentity: Stats | undefined;
  private dbFd: number | undefined;
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
          if (leaf) {
            try {
              mkdirSync(next, { mode: 0o700 });
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
          // EXTRA 只同步叶目录，不替代父目录这一次。没记成功的重试仍会再同步。
          const parent = this.anchors[this.anchors.length - 2];
          if (leaf && parent) {
            // 叶目录被删后在同一路径重建，父 inode 不变，新目录项还没落盘：键必须带叶自己的 dev/ino/创建时刻。
            // 读不到创建时刻（0 或非有限）就不缓存，每次都同步。
            const born = s.birthtimeMs;
            const key =
              Number.isFinite(born) && born > 0
                ? `${path}\0${parent.initial.dev}:${parent.initial.ino}\0${s.dev}:${s.ino}:${born}`
                : undefined;
            if (key === undefined || !syncedLeafParents.has(key)) {
              fsyncSync(parent.fd);
              if (key !== undefined) syncedLeafParents.add(key);
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
    // 这个 fd 要留到 SQLite 关库之后：Linux 上关掉同一文件的任何 fd 会释放本进程在它上面的全部 POSIX 锁，
    // 事务中途关就把 SQLite 的 RESERVED/EXCLUSIVE 锁一并放掉，别的进程会把活 journal 当 hot journal 回滚删除。
    this.dbFd = fd;
    this.dbIdentity = fstatSync(fd);
    this.check();
    if (!created && this.dbIdentity.size === 0) fail('corrupt');
    if (created) {
      fsyncSync(fd);
      this.sync();
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
  // 文件头偏移 24 的变更计数随每次真实提交加一；空事务不加。调用时须已挡住其他写入。
  // 只读 pinDatabase 留着的 fd，不在事务里另开另关（见 pinDatabase）；路径被换由 check 的 lstat 身份核出。
  mainStamp(): SpoolStamp {
    this.check();
    const fd = this.dbFd;
    if (fd === undefined) return fail('private_path');
    const s = fstatSync(fd);
    if (!s.isFile() || (this.dbIdentity && !same(this.dbIdentity, s))) fail('private_path');
    const buf = Buffer.alloc(100);
    if (readSync(fd, buf, 0, buf.length, 0) < 100 || !buf.subarray(0, 16).equals(SQLITE_MAGIC))
      fail('corrupt');
    return { path: this.path, dev: s.dev, ino: s.ino, size: s.size, counter: buf.readUInt32BE(24) };
  }
  sync(): void {
    const leaf = this.anchors[this.anchors.length - 1];
    if (!leaf) throw new SpoolError('private_path');
    fsyncSync(leaf.fd);
  }
  // 须在 SQLite 关库之后调用（Spool.close 的顺序）。
  close(): void {
    const fd = this.dbFd;
    this.dbFd = undefined;
    if (fd !== undefined) closeSync(fd);
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
      // 逐行解码只在 record/peek/transfer 的事务里做。打开时再做一遍会让 256 次提交各多一次整库检查。
    } catch (e) {
      dropStamp();
      this.close();
      throw e;
    }
  }
  private dataVersion(): number {
    const value = (this.db as DatabaseSync).prepare('PRAGMA data_version').get()?.data_version;
    if (typeof value === 'number') return value;
    return fail('io');
  }
  // 自己的提交不改变 data_version。刷新快照前若它变了，说明别的连接已经提交，不能记下刚读到的头。
  private rememberCommitted(seen: number): void {
    const d = this.db as DatabaseSync;
    d.exec('BEGIN IMMEDIATE');
    try {
      if (this.dataVersion() !== seen) {
        dropStamp();
        return;
      }
      committedStamp = this.path.mainStamp();
    } catch {
      dropStamp();
    } finally {
      try {
        d.exec('ROLLBACK');
      } catch {
        dropStamp();
      }
    }
  }
  private validate(decodeRows: boolean): void {
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
    if (!decodeRows) {
      const bounds = d
        .prepare(
          'SELECT count(*) AS n,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes,coalesce(max(length(CAST(payload AS BLOB))),0) AS widest FROM pending',
        )
        .get();
      if (
        !bounds ||
        (bounds.n as number) > ALERT_SPOOL_LIMITS.rows ||
        (bounds.bytes as number) > ALERT_SPOOL_LIMITS.payloadBytes ||
        (bounds.widest as number) > 4096
      )
        fail('capacity');
      return;
    }
    const rows = d.prepare('SELECT key,payload,record_hash FROM pending').all();
    if (rows.length > ALERT_SPOOL_LIMITS.rows) fail('capacity');
    let bytes = 0;
    for (const r of rows) {
      this.decode(r);
      bytes += Buffer.byteLength(r.payload as string);
    }
    if (bytes > ALERT_SPOOL_LIMITS.payloadBytes) fail('capacity');
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
    let seen = 0;
    let outcome: AlertOutcome;
    try {
      seen = this.dataVersion();
      this.validate(!sameStamp(committedStamp, this.path.mainStamp()));
      const row = d.prepare('SELECT key,payload,record_hash FROM pending WHERE key=?').get(key);
      if (row) {
        if (admissionAlertIdentityJson(this.decode(row).identity) !== admissionAlertIdentityJson(o.identity))
          fail('corrupt');
        d.exec('COMMIT');
        this.path.check();
        outcome = { kind: 'spooled', key, recordHash: row.record_hash as string };
      } else {
        const total = d
          .prepare(
            'SELECT count(*) AS n,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM pending',
          )
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
        outcome = { kind: 'spooled', key, recordHash };
      }
    } catch (e) {
      dropStamp();
      try {
        d.exec('ROLLBACK');
      } catch {
        /* 原责任不丢弃 */
      }
      throw e;
    }
    try {
      this.rememberCommitted(seen);
    } catch {
      dropStamp();
    }
    return outcome;
  }
  peek(): { key: string; recordHash: string; observation: AdmissionAlertObservation } | undefined {
    const d = this.db as DatabaseSync;
    // 读事务在PG连接前结束，不跨网络持写事务/读锁。
    d.exec('BEGIN');
    try {
      this.dataVersion();
      const decodeRows = !sameStamp(committedStamp, this.path.mainStamp());
      this.validate(decodeRows);
      const row = d.prepare('SELECT key,payload,record_hash FROM pending ORDER BY key LIMIT 1').get();
      const result = row
        ? { key: row.key as string, recordHash: row.record_hash as string, observation: this.decode(row) }
        : undefined;
      if (decodeRows) committedStamp = this.path.mainStamp();
      d.exec('COMMIT');
      return result;
    } catch (e) {
      dropStamp();
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
    let seen = 0;
    try {
      seen = this.dataVersion();
      this.validate(!sameStamp(committedStamp, this.path.mainStamp()));
      d.prepare('DELETE FROM pending WHERE key=? AND record_hash=?').run(row.key, row.recordHash);
      d.exec('COMMIT');
      this.path.check();
    } catch (e) {
      dropStamp();
      try {
        d.exec('ROLLBACK');
      } catch {
        /* 保留pending/PG责任并集 */
      }
      throw e;
    }
    try {
      this.rememberCommitted(seen);
    } catch {
      dropStamp();
    }
    return {
      kind: 'transferred',
      key: row.key,
      recordHash: row.recordHash,
      notificationId: persisted.notificationId,
    };
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

export function recordAdmissionAlert(path: string, input: AdmissionAlertObservation): AlertOutcome {
  let spool: Spool | undefined;
  try {
    spool = new Spool(path);
    return spool.record(input);
  } catch (e) {
    return { kind: 'unknown', code: errorCode(e) };
  } finally {
    spool?.close();
  }
}
export async function transferOneAdmissionAlert(
  path: string,
  databaseUrl: string,
  deadlineAt: number,
): Promise<AlertOutcome> {
  let spool: Spool | undefined;
  try {
    spool = new Spool(path);
    return await spool.transfer(databaseUrl, deadlineAt);
  } catch (e) {
    return { kind: 'unknown', code: errorCode(e) };
  } finally {
    spool?.close();
  }
}
