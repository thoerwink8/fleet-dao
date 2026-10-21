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
import { runChild } from './child.ts';

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
    // 两次串行 record 各给产品 10 秒期限（options）。每次冷起 child 光导入 @fleet-dao/db 在负载约 15 的机器上要 2–3 秒，
    // 默认 5 秒会在产品期限前先掐断。时限盖住两段产品期限加收尾，不改产品期限。
  }, 25000);
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
  it('提交后、记快照前别的连接改坏旧行：快照作废，下次整表重核报corrupt', () => {
    const first = observation();
    expect(recordAdmissionAlert(path, first).kind).toBe('spooled');
    const original = DatabaseSync.prototype.exec;
    let tampered = false;
    DatabaseSync.prototype.exec = function (sql: string) {
      const result = original.call(this, sql);
      if (sql === 'COMMIT' && !tampered) {
        tampered = true;
        // 落在本次 COMMIT 与 rememberCommitted 之间；prepare().run 不经过被替换的 exec。
        const other = database();
        try {
          other
            .prepare('UPDATE pending SET record_hash=? WHERE key=?')
            .run('c'.repeat(64), admissionAlertKey(first.identity));
        } finally {
          other.close();
        }
      }
      return result;
    };
    try {
      expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    expect(tampered).toBe(true);
    // 若快照记下了别的连接提交后的文件头，这里会只跑容量 SQL、冒称 spooled。
    expect(recordAdmissionAlert(path, observation())).toEqual({ kind: 'unknown', code: 'corrupt' });
  });
  it('写事务里读完主库文件头后，另一进程仍拿不到写锁（不另开另关主库fd放掉POSIX锁）', () => {
    expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
    const original = DatabaseSync.prototype.prepare;
    const probes: string[] = [];
    // POSIX 锁按进程算，同进程第二个连接看不出锁被放掉，必须真起一个进程去抢。
    // 经 child.ts 起。10 秒是探针自己的杀死上限，不是放宽这条用例的时限。
    const probe = (): string => {
      // 父进程常带着 FORCE_COLOR。console.log(数字) 会被 inspect 上色，5 变成带转义的黄字，锁码对不上。
      const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
      delete env.FORCE_COLOR;
      const result = runChild(
        process.execPath,
        [
          '--no-warnings',
          '--input-type=module',
          '-e',
          `import { DatabaseSync } from 'node:sqlite';
           const d = new DatabaseSync(process.argv[1]);
           d.exec('PRAGMA busy_timeout=0');
           try { d.exec('BEGIN IMMEDIATE'); d.exec('ROLLBACK'); process.stdout.write('acquired\\n'); }
           catch (e) { process.stdout.write(String(e.errcode & 255) + '\\n'); }
           finally { d.close(); }`,
          join(path, 'pending.sqlite'),
        ],
        { limitMs: 10000, env },
      );
      if (result.status !== 0) throw new Error(`抢锁探针退出 ${result.status}：${result.stderr.trim()}`);
      return result.stdout.trim();
    };
    // validate 在 record 的 BEGIN IMMEDIATE 和 mainStamp 之后才查 application_id；rememberCommitted 不查。
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (sql === 'PRAGMA application_id') probes.push(probe());
      return original.call(this, sql);
    };
    try {
      expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
    } finally {
      DatabaseSync.prototype.prepare = original;
    }
    expect(probes).toEqual(['5']);
    expect(probe()).toBe('acquired');
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
      const t0 = performance.now();
      const during = await sink.record(observation(), options());
      const spent = Math.round(performance.now() - t0);
      expect(during.kind, `${JSON.stringify(during)} ${spent}ms`).toBe('spooled');
      expect(await transfer).toEqual({ kind: 'unknown', code: 'deadline' });
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
    expect(sink.status().active).toBe(0);
    // 先 record（产品期限 10 秒），再 transfer 要等满它自己的 10 秒期限才回 deadline；中途 record 落在这 10 秒里。
    // 原 15 秒只剩 5 秒给两次冷起 child，负载约 15 时撞上（实测 15062ms）。时限盖住两段产品期限加收尾，不改产品期限。
  }, 25000);
});
