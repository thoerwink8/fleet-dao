import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { AdmissionAlertObservation } from '@fleet-dao/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAdmissionAlertSink } from '../src/real/admission-alert-process.ts';
import { ALERT_SPOOL_LIMITS, recordAdmissionAlert } from '../src/real/admission-alert-spool.ts';

let root: string, path: string;
const children: ChildProcess[] = [];
const fixture = fileURLToPath(new URL('./fixtures/admission-alert-sqlite-stage.mjs', import.meta.url));
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
beforeEach(() => {
  if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0)
    throw Error('真实Linux普通用户必需');
  root = mkdtempSync(join(homedir(), '.fleet-admission-crash-'));
  path = join(root, 'spool');
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
async function killAt(stage: string, o: AdmissionAlertObservation) {
  const c = spawn(process.execPath, [fixture], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  children.push(c);
  const message = once(c, 'message'),
    closed = once(c, 'close');
  c.send({ stage, path, observation: o });
  expect((await message)[0]).toEqual({ stage });
  c.kill('SIGKILL');
  await closed;
  expect(c.signalCode).toBe('SIGKILL');
}
const count = () => {
  const d = new DatabaseSync(join(path, 'pending.sqlite'));
  try {
    return d.prepare('SELECT count(*) n FROM pending').get()?.n;
  } finally {
    d.close();
  }
};
type CommitSample = number | 'unknown';
function commitBoundaryDiag(input: {
  stage?: string | undefined;
  index?: number | undefined;
  observed?: number | undefined;
  mainBytes?: number | undefined;
  journalBytes?: number | undefined;
  blocksBytes?: number | undefined;
  rssBytes?: number | undefined;
}): string {
  const sample = (value: number | undefined): CommitSample =>
    typeof value === 'number' && Number.isFinite(value) ? value : 'unknown';
  const stage =
    input.stage === 'validate' || input.stage === 'commit' || input.stage === 'cleanup'
      ? input.stage
      : 'unknown';
  return JSON.stringify({
    synthetic: true,
    stage,
    index: sample(input.index),
    observed: sample(input.observed),
    mainBytes: sample(input.mainBytes),
    journalBytes: sample(input.journalBytes),
    blocksBytes: sample(input.blocksBytes),
    rssBytes: sample(input.rssBytes),
  });
}
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('测试子进程阶段超时')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
describe('SQLite真实进程崩溃与恢复界', () => {
  it.each(['before-begin', 'after-schema', 'after-version', 'before-commit', 'after-commit'])(
    '首次初始化%s强杀：未确认不冒成功，零字节/无schema保留unknown；已提交schema可重开',
    async (stage) => {
      const o = observation();
      await killAt(stage, o);
      const db = join(path, 'pending.sqlite'),
        before = readFileSync(db);
      const result = recordAdmissionAlert(path, o);
      if (stage === 'after-commit') {
        expect(result.kind).toBe('spooled');
        expect(count()).toBe(1);
      } else {
        expect(result.kind).toBe('unknown');
        expect(readFileSync(db).equals(before)).toBe(true);
      }
    },
    10000,
  );
  it.each(['before-commit', 'after-commit'])(
    '已有责任后%s强杀：重开保留旧行，精确重试只一新行',
    async (stage) => {
      const old = observation(),
        o = observation();
      expect(recordAdmissionAlert(path, old).kind).toBe('spooled');
      await killAt(stage, o);
      expect(recordAdmissionAlert(path, old).kind).toBe('spooled');
      expect(count()).toBe(stage === 'before-commit' ? 1 : 2);
      expect(recordAdmissionAlert(path, o).kind).toBe('spooled');
      expect(count()).toBe(2);
    },
    10000,
  );
  it('32真实SQLite进程ready后争同identity，只允spooled/busy且最终一行', async () => {
    const o = observation();
    expect(recordAdmissionAlert(path, o).kind).toBe('spooled');
    const contender = fileURLToPath(
      new URL('./fixtures/admission-alert-sqlite-contender.mjs', import.meta.url),
    );
    const processes = Array.from({ length: 32 }, () => {
      const child = spawn(process.execPath, [contender], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      });
      children.push(child);
      return { child, ready: once(child, 'message'), closed: once(child, 'close') };
    });
    try {
      // 整段 test:changed 里 32 个进程的 ready 会超过 45 秒（这次约 48 秒撞上界）。这是等它们起来，不是产品时限。
      for (const message of await bounded(Promise.all(processes.map((p) => p.ready)), 90000))
        expect(message[0]).toEqual({ ready: true });
      const finished = processes.map(async ({ child, closed }) => {
        const result = once(child, 'message');
        child.send({ path, observation: o });
        const [message] = await result;
        await closed;
        expect(child.exitCode).toBe(0);
        expect(child.signalCode).toBeNull();
        return message.result;
      });
      const results = await bounded(Promise.all(finished), 10000);
      expect(
        results.every((r) => r.kind === 'spooled' || (r.kind === 'unknown' && r.code === 'busy')),
        JSON.stringify(results),
      ).toBe(true);
      expect(results.some((r) => r.kind === 'spooled')).toBe(true);
      expect(recordAdmissionAlert(path, o).kind).toBe('spooled');
      expect(count()).toBe(1);
    } finally {
      await bounded(
        Promise.all(
          processes.map(async ({ child, closed }) => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await closed;
          }),
        ),
        5000,
      );
    }
  }, 150000);
  it('真实sink冷启动未就绪仍按总deadline强杀，close后不留槽或假承接', async () => {
    let child: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    const sink = createAdmissionAlertSink(
      { spoolPath: path },
      {
        launch: (entry) => {
          expect(entry).toBe(fileURLToPath(new URL('../src/real/admission-alert-child.ts', import.meta.url)));
          // 仅模拟加载产品入口前的冷启动停顿，不改产品deadline或响应。
          child = spawn(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              'await new Promise(r => setTimeout(r, 60000)); await import(process.argv[1]);',
              entry,
            ],
            { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
          );
          children.push(child);
          closed = once(child, 'close');
          return child;
        },
      },
    );
    const result = await sink.record(observation(), {
      signal: new AbortController().signal,
      deadlineAt: performance.now() + 2000,
    });
    expect(result).toEqual({ kind: 'unknown', code: 'deadline' });
    await closed;
    expect(child?.signalCode).toBe('SIGKILL');
    expect(sink.status()).toEqual({ active: 0, cleanupPending: 0 });
    expect(existsSync(path)).toBe(false);
  }, 10000);
  // 两个 sink 的 10 秒期限不变。
  it('不同identity争最后一格：busy可有界重试，只承接一个且保全全部旧行', async () => {
    for (let n = 0; n < 255; n++) expect(recordAdmissionAlert(path, observation()).kind).toBe('spooled');
    const a = observation(),
      b = observation();
    const records = await Promise.all(
      [a, b].map((o) =>
        createAdmissionAlertSink({ spoolPath: path }).record(o, {
          signal: new AbortController().signal,
          deadlineAt: performance.now() + 10000,
        }),
      ),
    );
    for (const [n, r] of records.entries()) {
      if (r.kind === 'unknown' && r.code === 'busy') records[n] = recordAdmissionAlert(path, n === 0 ? a : b);
    }
    expect(records.filter((r) => r.kind === 'spooled')).toHaveLength(1);
    expect(records.filter((r) => r.kind === 'unknown' && r.code === 'capacity')).toHaveLength(1);
    expect(count()).toBe(256);
  }, 120000);
  it('COMMIT失败诊断只记合成阶段和资源读数，缺采样是 unknown', () => {
    expect(JSON.parse(commitBoundaryDiag({}))).toEqual({
      synthetic: true,
      stage: 'unknown',
      index: 'unknown',
      observed: 'unknown',
      mainBytes: 'unknown',
      journalBytes: 'unknown',
      blocksBytes: 'unknown',
      rssBytes: 'unknown',
    });
    expect(JSON.parse(commitBoundaryDiag({ stage: 'teardown' })).stage).toBe('unknown');
    expect(
      JSON.parse(
        commitBoundaryDiag({
          stage: 'commit',
          index: 4,
          observed: 8,
          mainBytes: 3,
          journalBytes: 0,
          blocksBytes: 512,
          rssBytes: 9,
        }),
      ),
    ).toMatchObject({ synthetic: true, stage: 'commit', index: 4, journalBytes: 0 });
  });
  // 失败才打一条诊断。阶段在 COMMIT 出错时冻结，后面的 close 不能把它改成收尾。
  it('256个近DTO上界记录的COMMIT边界：主库和journal峰值在固定字节界内', () => {
    const originalExec = DatabaseSync.prototype.exec;
    const originalClose = DatabaseSync.prototype.close;
    let mainPeak = 0,
      journalPeak = 0,
      observed = 0;
    let sampled = false;
    let mainBytes: number | undefined;
    let journalBytes: number | undefined;
    let blocksBytes: number | undefined;
    let phase = 'unknown';
    let frozen = false;
    let index: number | undefined;
    const sample = () => {
      if (!existsSync(path)) return;
      for (const name of readdirSync(path))
        expect(['pending.sqlite', 'pending.sqlite-journal']).toContain(name);
      const db = join(path, 'pending.sqlite'),
        journal = `${db}-journal`;
      const main = existsSync(db) ? statSync(db) : undefined;
      const rollback = existsSync(journal) ? statSync(journal) : undefined;
      mainPeak = Math.max(mainPeak, main?.size ?? 0);
      journalPeak = Math.max(journalPeak, rollback?.size ?? 0);
      sampled = true;
      mainBytes = main?.size ?? 0;
      journalBytes = rollback?.size ?? 0;
      blocksBytes = ((main?.blocks ?? 0) + (rollback?.blocks ?? 0)) * 512;
      observed++;
    };
    DatabaseSync.prototype.exec = function (sql: string) {
      if (sql !== 'COMMIT') return originalExec.call(this, sql);
      if (!frozen) phase = 'commit';
      try {
        sample();
        originalExec.call(this, sql);
      } catch (error) {
        frozen = true;
        throw error;
      }
      try {
        sample();
      } catch (error) {
        frozen = true;
        throw error;
      }
      phase = 'validate';
    };
    DatabaseSync.prototype.close = function () {
      if (!frozen) phase = 'cleanup';
      try {
        return originalClose.call(this);
      } catch (error) {
        frozen = true;
        throw error;
      } finally {
        if (!frozen) phase = 'validate';
      }
    };
    try {
      try {
        const started = performance.now();
        let noted = false;
        for (let n = 0; n < 256; n++) {
          if (!frozen) {
            phase = 'validate';
            index = n;
          }
          // 同步循环被 15 秒杀掉时 catch 跑不到。只有按当前速度会越过 15 秒才记一条，正常跑完不打印。
          if (!noted && n >= 32) {
            const elapsed = performance.now() - started;
            if (elapsed >= 10000 && (elapsed / n) * 256 > 15000) {
              noted = true;
              let rssBytes: number | undefined;
              try {
                rssBytes = process.memoryUsage().rss;
              } catch {
                rssBytes = undefined;
              }
              console.log(
                'SPOOL_COMMIT_DIAG=' +
                  commitBoundaryDiag({
                    stage: phase,
                    index,
                    observed: sampled ? observed : undefined,
                    mainBytes: sampled ? mainBytes : undefined,
                    journalBytes: sampled ? journalBytes : undefined,
                    blocksBytes: sampled ? blocksBytes : undefined,
                    rssBytes,
                  }),
              );
            }
          }
          const o = observation();
          o.identity.namespace = '\u0001'.repeat(300);
          o.identity.workflowId = '\u0002'.repeat(300);
          expect(recordAdmissionAlert(path, o).kind).toBe('spooled');
        }
      } finally {
        DatabaseSync.prototype.exec = originalExec;
        DatabaseSync.prototype.close = originalClose;
      }
      if (!frozen) phase = 'unknown';
      expect(count()).toBe(256);
      expect(observed).toBeGreaterThanOrEqual(512);
      expect(mainPeak).toBeGreaterThan(1024 * 1024);
      expect(journalPeak).toBeGreaterThan(0);
      expect(mainPeak).toBeLessThanOrEqual(ALERT_SPOOL_LIMITS.databaseBytes);
      expect(journalPeak).toBeLessThanOrEqual(ALERT_SPOOL_LIMITS.journalBytes);
    } catch (error) {
      let rssBytes: number | undefined;
      try {
        rssBytes = process.memoryUsage().rss;
      } catch {
        rssBytes = undefined;
      }
      console.log(
        'SPOOL_COMMIT_DIAG=' +
          commitBoundaryDiag({
            stage: phase,
            index,
            observed: sampled ? observed : undefined,
            mainBytes: sampled ? mainBytes : undefined,
            journalBytes: sampled ? journalBytes : undefined,
            blocksBytes: sampled ? blocksBytes : undefined,
            rssBytes,
          }),
      );
      throw error;
    }
  }, 15000);
  it.each(['zero-second-oversize', 'minus-one-oversize', 'different-sector'])(
    '%s损坏journal在SQLite打开前保留且拒绝',
    (mode) => {
      recordAdmissionAlert(path, observation());
      const db = join(path, 'pending.sqlite'),
        before = readFileSync(db),
        journal = Buffer.alloc(1024 + 4104);
      const header = (offset: number, n: number, sector = 512) => {
        Buffer.from('d9d505f920a163d7', 'hex').copy(journal, offset);
        journal.writeUInt32BE(n, offset + 8);
        journal.writeUInt32BE(3, offset + 16);
        journal.writeUInt32BE(sector, offset + 20);
        journal.writeUInt32BE(4096, offset + 24);
      };
      if (mode === 'minus-one-oversize') {
        header(0, 0xffffffff);
        journal.writeUInt32BE(1025, 512);
      } else {
        header(0, 0);
        header(512, 1, mode === 'different-sector' ? 4096 : 512);
        journal.writeUInt32BE(mode === 'different-sector' ? 1 : 1025, 1024);
      }
      writeFileSync(`${db}-journal`, journal, { mode: 0o600 });
      expect(recordAdmissionAlert(path, observation())).toEqual({ kind: 'unknown', code: 'corrupt' });
      expect(readFileSync(db).equals(before)).toBe(true);
      expect(readFileSync(`${db}-journal`).equals(journal)).toBe(true);
      expect(statSync(db).size).toBe(before.length);
    },
  );
});
