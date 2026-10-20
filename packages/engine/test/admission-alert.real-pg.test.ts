import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { type AdmissionAlertObservation, admissionAlertKey, admissionAlertRecordHash } from '@fleet-dao/db';
import {
  createConcurrentTestDb,
  realTestPgUrl,
  resetTestDb,
  TEST_DB_TIMEOUT_MS,
} from '@fleet-dao/db/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdmissionAlertSink } from '../src/real/admission-alert-process.ts';
import { commitAckProxy } from './fixtures/legacy-admission-pg-proxy.ts';

const url = realTestPgUrl();
it.runIf(Boolean(process.env.CI) && !url)('CI的报警移交真实PG台必须提供配置', () => {
  throw Error('真实PG配置缺失');
});
describe.runIf(Boolean(url))('专用spool真实PG移交（随机库/独立observer）', () => {
  let t: Awaited<ReturnType<typeof createConcurrentTestDb>>;
  let databaseUrl: string, root: string, spoolPath: string;
  const children: ChildProcess[] = [];
  const options = (signal = new AbortController().signal) => ({
    signal,
    deadlineAt: performance.now() + 10000,
  });
  const observation = (): AdmissionAlertObservation => ({
    identity: {
      version: 1,
      category: 'legacy_admission_unknown',
      namespace: 'test',
      workflowId: 'task:example/test#1',
      runId: randomUUID(),
    },
    firstCode: 'deadline',
  });
  const pending = () => {
    const d = new DatabaseSync(join(spoolPath, 'pending.sqlite'));
    try {
      return d.prepare('SELECT key,payload,record_hash FROM pending ORDER BY key').all();
    } finally {
      d.close();
    }
  };
  const notifications = () => t.client.query('SELECT * FROM notifications ORDER BY id').then((r) => r.rows);
  beforeAll(async () => {
    if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0)
      throw Error('spool真实PG矩阵需Linux普通用户');
    t = await createConcurrentTestDb();
    const identities = [];
    for (const c of [t, ...t.peers, t.blocker])
      identities.push(
        (
          await c.client.query<{ db: string; pid: number }>(
            'SELECT current_database() db,pg_backend_pid() pid',
          )
        ).rows[0],
      );
    const db = identities[0]?.db;
    expect(db).toMatch(/^fleet_test_[a-f0-9]{32}$/);
    expect(new Set(identities.map((x) => x?.db)).size).toBe(1);
    expect(new Set(identities.map((x) => x?.pid)).size).toBe(4);
    const parsed = new URL(url as string);
    parsed.pathname = `/${db}`;
    databaseUrl = parsed.href;
  }, TEST_DB_TIMEOUT_MS);
  beforeEach(async () => {
    await resetTestDb(t);
    root = mkdtempSync(join(homedir(), '.fleet-admission-pg-'));
    spoolPath = join(root, 'spool');
  });
  afterEach(async () => {
    for (const c of children.splice(0))
      if (c.exitCode === null && c.signalCode === null) {
        const closed = once(c, 'close');
        c.kill('SIGKILL');
        await closed;
      }
    if (root) rmSync(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    await t?.close();
  });
  it('移交→删→换code重建→再移交：同一通知所有字段和delivery保持原值', async () => {
    const o = observation(),
      sink = createAdmissionAlertSink({ spoolPath, databaseUrl });
    expect((await sink.record(o, options())).kind).toBe('spooled');
    const first = await sink.transferOne(options());
    expect(first).toMatchObject({
      kind: 'transferred',
      key: admissionAlertKey(o.identity),
      recordHash: admissionAlertRecordHash(o),
    });
    expect(pending()).toEqual([]);
    if (first.kind !== 'transferred') throw Error('未移交');
    await t.client.query(
      "UPDATE notifications SET resolved_at='2026-10-01T00:00:00Z',resolved_by='test',answer=$1::jsonb WHERE id=$2",
      [
        JSON.stringify({ text: '保持处理结果', at: '2026-10-01T00:00:00Z', by: 'test' }),
        first.notificationId,
      ],
    );
    await t.client.query(
      "INSERT INTO notification_deliveries(notification_id,channel,target,message_id,delivered_at,attempts) VALUES($1,'feishu','isolated','test-real-id',now(),3)",
      [first.notificationId],
    );
    const before = await notifications(),
      delivery = (await t.client.query('SELECT * FROM notification_deliveries')).rows;
    const rebuilt = { ...o, firstCode: 'store_unavailable' as const };
    expect((await sink.record(rebuilt, options())).kind).toBe('spooled');
    expect(await sink.transferOne(options())).toEqual({
      kind: 'transferred',
      key: admissionAlertKey(o.identity),
      recordHash: admissionAlertRecordHash(rebuilt),
      notificationId: first.notificationId,
    });
    expect(pending()).toEqual([]);
    expect(await notifications()).toEqual(before);
    expect((await t.client.query('SELECT * FROM notification_deliveries')).rows).toEqual(delivery);
  }, 15000);
  it('并发drainer读同pending，PG唯一键承接同一通知，本地CAS无第二次删除入口', async () => {
    const a = createAdmissionAlertSink({ spoolPath, databaseUrl }),
      b = createAdmissionAlertSink({ spoolPath, databaseUrl });
    expect((await a.record(observation(), options())).kind).toBe('spooled');
    const results = await Promise.all([a.transferOne(options()), b.transferOne(options())]);
    expect(
      results.every(
        (r) => ['transferred', 'empty'].includes(r.kind) || (r.kind === 'unknown' && r.code === 'busy'),
      ),
    ).toBe(true);
    expect(results.some((r) => r.kind === 'transferred')).toBe(true);
    expect(await notifications()).toHaveLength(1);
    expect(pending()).toEqual([]);
  });
  it.each(['before-begin', 'before-commit', 'after-commit'])(
    'PG真实ACK+close后SQLite删除%s强杀：本地或PG始终至少一份，重放不刷新',
    async (stage) => {
      const o = observation(),
        sink = createAdmissionAlertSink({ spoolPath, databaseUrl });
      expect((await sink.record(o, options())).kind).toBe('spooled');
      const fixture = fileURLToPath(new URL('./fixtures/admission-alert-sqlite-stage.mjs', import.meta.url));
      const child = spawn(process.execPath, [fixture], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
      children.push(child);
      const message = once(child, 'message'),
        closed = once(child, 'close');
      child.send({ operation: 'transferOne', stage, path: spoolPath, databaseUrl });
      expect((await message)[0]).toEqual({ stage });
      const committed = await notifications();
      expect(committed).toHaveLength(1);
      expect(pending()).toHaveLength(stage === 'after-commit' ? 0 : 1);
      child.kill('SIGKILL');
      await closed;
      expect(child.signalCode).toBe('SIGKILL');
      const retry = await sink.transferOne(options());
      expect(retry.kind).toBe(stage === 'after-commit' ? 'empty' : 'transferred');
      expect(pending()).toEqual([]);
      expect(await notifications()).toEqual(committed);
    },
    10000,
  );
  it('真实COMMIT已执行但ACK丢失：父强杀后pending保留，重放同通知不刷新', async () => {
    const o = observation(),
      proxy = await commitAckProxy(
        databaseUrl,
        Object.values(networkInterfaces())
          .flat()
          .find((a) => a?.family === 'IPv4' && !a.internal)?.address ?? '127.0.0.1',
      ),
      controller = new AbortController();
    const sink = createAdmissionAlertSink({ spoolPath, databaseUrl: proxy.url });
    expect((await sink.record(o, options())).kind).toBe('spooled');
    const run = sink.transferOne(options(controller.signal));
    try {
      await expect.poll(() => proxy.status().seenCommit, { timeout: 4000 }).toBe(true);
      expect(await notifications()).toEqual([]);
      expect(pending()).toHaveLength(1);
      proxy.releaseCommit();
      await expect.poll(async () => (await notifications()).length, { timeout: 3000 }).toBe(1);
      await expect.poll(() => proxy.status().droppedBytes, { timeout: 2000 }).toBeGreaterThan(0);
      const committed = await notifications();
      controller.abort();
      expect(await run).toEqual({ kind: 'unknown', code: 'cancelled' });
      expect(pending()).toHaveLength(1);
      const retry = await createAdmissionAlertSink({ spoolPath, databaseUrl }).transferOne(options());
      expect(retry.kind).toBe('transferred');
      expect(pending()).toEqual([]);
      expect(await notifications()).toEqual(committed);
      expect((await t.client.query('SELECT * FROM notification_deliveries')).rows).toEqual([]);
    } finally {
      controller.abort();
      await proxy.close();
    }
  }, 15000);
});
