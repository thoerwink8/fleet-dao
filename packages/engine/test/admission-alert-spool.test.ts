import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type AdmissionAlertObservation,
  admissionAlertJson,
  admissionAlertKey,
  admissionAlertRecordHash,
} from '@fleet-dao/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdmissionAlertSink } from '../src/real/admission-alert-process.ts';
import {
  ALERT_SPOOL_LIMITS,
  recordAdmissionAlert,
  transferOneAdmissionAlert,
} from '../src/real/admission-alert-spool.ts';

let root: string, path: string;
const observation = (): AdmissionAlertObservation => ({
  identity: {
    version: 1,
    category: 'legacy_admission_unknown',
    namespace: 'isolated',
    workflowId: 'task:example/test#1',
    runId: randomUUID(),
  },
  firstCode: 'deadline',
});
const options = () => ({ signal: new AbortController().signal, deadlineAt: performance.now() + 10000 });
const database = () => new DatabaseSync(join(path, 'pending.sqlite'));
beforeEach(() => {
  if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0)
    throw Error('必须在真实Linux普通用户下执行，不跳过权限断言');
  root = mkdtempSync(join(homedir(), '.fleet-admission-test-'));
  path = join(root, 'spool');
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

// 子进程冷启动和 256 行同步重开库都会超过默认 5 秒。同步写完才返回，时限必须盖住做完。
describe('专用SQLite持久pending', { timeout: 120_000 }, () => {
  it('无任何PG配置也可持久写入，两个独立child重开回同一key/hash和首码', async () => {
    const o = observation();
    const c = createAdmissionAlertSink({ spoolPath: path });
    const first = await c.record(o, options());
    expect(first).toEqual({
      kind: 'spooled',
      key: admissionAlertKey(o.identity),
      recordHash: admissionAlertRecordHash(o),
    });
    expect(
      await createAdmissionAlertSink({ spoolPath: path }).record(
        { ...o, firstCode: 'store_unavailable' },
        options(),
      ),
    ).toEqual(first);
    expect(c.status()).toEqual({ active: 0, cleanupPending: 0 });
    const d = database();
    expect(d.prepare('SELECT payload FROM pending').get()?.payload).toBe(admissionAlertJson(o));
    expect(d.prepare('PRAGMA page_size').get()?.page_size).toBe(4096);
    d.close();
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(join(path, 'pending.sqlite')).mode & 0o777).toBe(0o600);
  });
  it('第257条明确capacity；满额同key仍回原行且所有旧行保留', () => {
    const first = observation();
    expect(recordAdmissionAlert(path, first).kind).toBe('spooled');
    for (let n = 1; n < 256; n++) expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
    expect(recordAdmissionAlert(path, observation())).toEqual({ kind: 'unknown', code: 'capacity' });
    expect(recordAdmissionAlert(path, first).kind).toBe('spooled');
    const d = database();
    expect(d.prepare('SELECT count(*) n FROM pending').get()?.n).toBe(256);
    d.close();
    // 257 次同步落盘（每次 fsync），慢盘上默认 5 秒不够。
  }, 30000);
  it('实际写锁第二连接fail-fast busy，原事务回滚后重开成功', () => {
    const o = observation();
    recordAdmissionAlert(path, o);
    const d = database();
    d.exec('BEGIN IMMEDIATE');
    expect(recordAdmissionAlert(path, observation())).toEqual({ kind: 'unknown', code: 'busy' });
    d.exec('ROLLBACK');
    d.close();
    expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
  });
  it.each(['key', 'hash', 'identity'])('损坏%s不能借同key冒领原责任', (mode) => {
    const o = observation();
    recordAdmissionAlert(path, o);
    const d = database();
    if (mode === 'key') d.prepare('UPDATE pending SET key=?').run('a'.repeat(64));
    if (mode === 'hash') d.prepare('UPDATE pending SET record_hash=?').run('b'.repeat(64));
    if (mode === 'identity') {
      const other = observation();
      d.prepare('UPDATE pending SET payload=?,record_hash=?').run(
        admissionAlertJson(other),
        admissionAlertRecordHash(other),
      );
    }
    d.close();
    const before = readFileSync(join(path, 'pending.sqlite'));
    expect(recordAdmissionAlert(path, o)).toEqual({ kind: 'unknown', code: 'corrupt' });
    expect(readFileSync(join(path, 'pending.sqlite')).equals(before)).toBe(true);
  });
  it('max_page_count不能缩既有超额真库，产品在打开前拒绝并保留', () => {
    recordAdmissionAlert(path, observation());
    const d = database();
    d.exec('CREATE TABLE oversized(payload BLOB); INSERT INTO oversized VALUES(zeroblob(4194304))');
    const actualPages = d.prepare('PRAGMA page_count').get()?.page_count;
    expect(actualPages).toBeGreaterThan(1024);
    expect(d.prepare('PRAGMA max_page_count=1024').get()?.max_page_count).toBe(actualPages);
    d.close();
    const before = readFileSync(join(path, 'pending.sqlite'));
    expect(recordAdmissionAlert(path, observation())).toEqual({ kind: 'unknown', code: 'capacity' });
    expect(readFileSync(join(path, 'pending.sqlite')).equals(before)).toBe(true);
  });
  it('文件不可写和目录不可访问时明确拒绝，恢复权限后旧责任不丢', () => {
    const o = observation();
    recordAdmissionAlert(path, o);
    chmodSync(join(path, 'pending.sqlite'), 0o400);
    expect(recordAdmissionAlert(path, o)).toEqual({ kind: 'unknown', code: 'private_path' });
    chmodSync(join(path, 'pending.sqlite'), 0o600);
    chmodSync(path, 0o000);
    try {
      expect(recordAdmissionAlert(path, o)).toEqual({ kind: 'unknown', code: 'private_path' });
    } finally {
      chmodSync(path, 0o700);
    }
    expect(recordAdmissionAlert(path, o).kind).toBe('spooled');
  });
  it('打开后叶目录被真实换inode：拒绝且原库和替身库都未写', () => {
    const o = observation();
    recordAdmissionAlert(path, o);
    const before = readFileSync(join(path, 'pending.sqlite'));
    const original = DatabaseSync.prototype.exec;
    let replaced = false;
    DatabaseSync.prototype.exec = function (sql: string) {
      if (sql === 'BEGIN IMMEDIATE' && !replaced) {
        replaced = true;
        renameSync(path, `${path}-original`);
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(join(path, 'pending.sqlite'), before, { mode: 0o600 });
      }
      return original.call(this, sql);
    };
    try {
      expect(recordAdmissionAlert(path, observation())).toEqual({ kind: 'unknown', code: 'private_path' });
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    expect(replaced).toBe(true);
    expect(readFileSync(join(`${path}-original`, 'pending.sqlite')).equals(before)).toBe(true);
    expect(readFileSync(join(path, 'pending.sqlite')).equals(before)).toBe(true);
  });
  it.each(['leaf-link', 'db-link', 'db-hardlink', 'mode', 'parent-link', 'foreign-file'])(
    '%s拒绝且不删除已有责任',
    (mode) => {
      const o = observation();
      expect(recordAdmissionAlert(path, o).kind).toBe('spooled');
      const dbPath = join(path, 'pending.sqlite'),
        before = readFileSync(dbPath);
      if (mode === 'leaf-link') {
        renameSync(path, `${path}-original`);
        symlinkSync(`${path}-original`, path);
      }
      if (mode === 'db-link') {
        renameSync(dbPath, join(root, 'original'));
        symlinkSync(join(root, 'original'), dbPath);
      }
      if (mode === 'db-hardlink') linkSync(dbPath, join(root, 'linked'));
      if (mode === 'mode') chmodSync(path, 0o750);
      if (mode === 'parent-link') {
        symlinkSync(root, join(root, 'alias'));
        path = join(root, 'alias', 'spool');
      }
      if (mode === 'foreign-file') writeFileSync(join(path, 'unexpected'), 'keep');
      expect(recordAdmissionAlert(path, o)).toEqual({ kind: 'unknown', code: 'private_path' });
      expect(
        readFileSync(mode === 'leaf-link' ? join(`${path}-original`, 'pending.sqlite') : dbPath),
      ).toEqual(before);
    },
  );
  it.each([
    'zero',
    'schema',
    'trigger',
    'row',
    'oversized-db',
    'oversized-journal',
    'foreign-journal',
    'truncated-journal',
  ])('%s保留原件并明确unknown', (mode) => {
    expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
    const dbPath = join(path, 'pending.sqlite');
    if (mode === 'zero') truncateSync(dbPath, 0);
    if (mode === 'oversized-db') truncateSync(dbPath, ALERT_SPOOL_LIMITS.databaseBytes + 4096);
    if (mode === 'oversized-journal') {
      writeFileSync(`${dbPath}-journal`, '', { mode: 0o600 });
      truncateSync(`${dbPath}-journal`, ALERT_SPOOL_LIMITS.journalBytes + 1);
    }
    if (mode === 'foreign-journal')
      writeFileSync(`${dbPath}-journal`, 'keep-corrupt-original', { mode: 0o600 });
    if (mode === 'truncated-journal')
      writeFileSync(`${dbPath}-journal`, Buffer.from('d9d505f920a163d7', 'hex'), { mode: 0o600 });
    if (['schema', 'trigger', 'row'].includes(mode)) {
      const d = database();
      if (mode === 'schema') d.exec('PRAGMA user_version=2');
      if (mode === 'trigger') d.exec('CREATE TRIGGER unexpected AFTER INSERT ON pending BEGIN SELECT 1; END');
      if (mode === 'row') d.exec("UPDATE pending SET record_hash='wrong'");
      d.close();
    }
    const before = readFileSync(dbPath);
    const journal = existsSync(`${dbPath}-journal`) ? readFileSync(`${dbPath}-journal`) : undefined;
    expect(recordAdmissionAlert(path, observation())).toMatchObject({ kind: 'unknown' });
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    if (journal) expect(readFileSync(`${dbPath}-journal`).equals(journal)).toBe(true);
  });
  it('坏hot journal原库页数/页号在任何SQLite恢复前被拒绝，原件不变', () => {
    recordAdmissionAlert(path, observation());
    const dbPath = join(path, 'pending.sqlite'),
      before = readFileSync(dbPath);
    for (const tooLarge of ['dbSize', 'page']) {
      const journal = Buffer.alloc(512 + 4104);
      Buffer.from('d9d505f920a163d7', 'hex').copy(journal);
      journal.writeUInt32BE(1, 8);
      journal.writeUInt32BE(tooLarge === 'dbSize' ? 0x7fffffff : 3, 16);
      journal.writeUInt32BE(512, 20);
      journal.writeUInt32BE(4096, 24);
      journal.writeUInt32BE(tooLarge === 'page' ? 0x7fffffff : 1, 512);
      writeFileSync(`${dbPath}-journal`, journal, { mode: 0o600 });
      expect(recordAdmissionAlert(path, observation())).toEqual({ kind: 'unknown', code: 'corrupt' });
      expect(readFileSync(dbPath)).toEqual(before);
      expect(readFileSync(`${dbPath}-journal`)).toEqual(journal);
    }
  });
  it('PG不可达只返回unknown，pending仍在；没有caller ACK方法', async () => {
    const o = observation();
    recordAdmissionAlert(path, o);
    const r = await transferOneAdmissionAlert(
      path,
      'postgres://fixture:fixture@127.0.0.1:1/fixture?connect_timeout=1',
      performance.now() + 3000,
    );
    expect(r).toEqual({ kind: 'unknown', code: 'store_unavailable' });
    expect(recordAdmissionAlert(path, o).kind).toBe('spooled');
    expect(Object.keys(createAdmissionAlertSink({ spoolPath: path })).sort()).toEqual([
      'record',
      'status',
      'transferOne',
    ]);
  });
  it('真实PG黑洞中的transfer不占record槽，也不持SQLite事务锁', async () => {
    const sockets: Socket[] = [];
    const server = createServer((s) => sockets.push(s));
    // WSL VirtioProxy会转发127.0.0.1；显式本机IPv4保持child与夹具在同一个网络栈。
    const host =
      Object.values(networkInterfaces())
        .flat()
        .find((a) => a?.family === 'IPv4' && !a.internal)?.address ?? '127.0.0.1';
    server.listen(0, host);
    await once(server, 'listening');
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw Error('无端口');
    const sink = createAdmissionAlertSink({
      spoolPath: path,
      databaseUrl: `postgres://fixture:fixture@${host}:${addr.port}/fixture`,
    });
    expect((await sink.record(observation(), options())).kind).toBe('spooled');
    const connected = once(server, 'connection');
    const transfer = sink.transferOne(options());
    try {
      await Promise.race([
        connected,
        transfer.then((r) => {
          throw Error(`未进入PG黑洞: ${JSON.stringify(r)}`);
        }),
      ]);
      expect(sink.status().active).toBe(1);
      expect((await sink.record(observation(), options())).kind).toBe('spooled');
      expect(await transfer).toEqual({ kind: 'unknown', code: 'deadline' });
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
    expect(sink.status().active).toBe(0);
  }, 15000);
});
