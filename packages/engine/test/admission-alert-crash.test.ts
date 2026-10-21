import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, loadavg } from 'node:os';
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
  // 先同步写入 255 行，每行都重开库做 quick_check。整段 test:changed 里这一段超过 15 秒
  // （这次约 19 秒）。同步写完才返回，时限必须盖住做完。后面两个 sink 的 10 秒期限不变。
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
  it('256个近DTO上界记录的COMMIT边界：主库和journal峰值在固定字节界内', () => {
    const originalExec = DatabaseSync.prototype.exec;
    const originalPrepare = DatabaseSync.prototype.prepare;
    const started = performance.now();
    // 1 分钟负载只作宿主争用旁证；读不到（非数字）记 unknown。
    const load = () => {
      const value = loadavg()[0];
      return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : 'unknown';
    };
    const loadAtStart = load();
    let mainPeak = 0,
      journalPeak = 0,
      blocksPeak = 0,
      observed = 0,
      fullScans = 0,
      commitSlice = 0;
    // 正在写的那条的起点；失败时把它已花的时间也算进 recordMs，和已计入的 COMMIT 次数/CPU 对齐。
    let recordMark: number | undefined;
    const diag = {
      stage: 'setup',
      index: -1,
      commit: 'unknown' as 'unknown' | 'before' | 'after',
      mainBytes: 'unknown' as number | 'unknown',
      journalBytes: 'unknown' as number | 'unknown',
      blocks: 'unknown' as number | 'unknown',
      recordMs: 0,
      commitMs: 0,
      commits: 0,
      commitCpuMs: 0,
      commitMaxMs: 0,
      slowestIndex: -1,
      slowestRecordMs: 0,
      slowestCommitMs: 0,
    };
    // COMMIT 墙钟远大于本进程 CPU，说明 COMMIT 里是在等内核落盘（SQLite 自己的 fsync），不是算。
    const timing = () => {
      const recordMs = diag.recordMs + (recordMark === undefined ? 0 : performance.now() - recordMark);
      return {
        observed,
        fullScans,
        recordMs: Math.round(recordMs),
        outsideCommitMs: Math.round(recordMs - diag.commitMs),
        commits: diag.commits,
        commitMs: Math.round(diag.commitMs),
        commitCpuMs: Math.round(diag.commitCpuMs),
        commitWaitMs: Math.round(diag.commitMs - diag.commitCpuMs),
        commitMaxMs: diag.commits ? Math.round(diag.commitMaxMs) : 'unknown',
        slowest:
          diag.slowestIndex < 0
            ? 'unknown'
            : {
                index: diag.slowestIndex,
                recordMs: Math.round(diag.slowestRecordMs),
                commitMs: Math.round(diag.slowestCommitMs),
              },
        load1: { start: loadAtStart, end: load() },
        elapsedMs: Math.round(performance.now() - started),
      };
    };
    let emitted = false;
    const emit = () => {
      if (emitted) return;
      emitted = true;
      // 只在失败或原 15 秒用尽时留下合成阶段；成功不写。读不到的采样是 unknown，不是 0。
      console.error(
        `SPOOL_COMMIT_DIAG=${JSON.stringify({
          stage: diag.stage,
          index: diag.index,
          commit: diag.commit,
          mainBytes: diag.mainBytes,
          journalBytes: diag.journalBytes,
          blocks: diag.blocks,
          ...timing(),
        })}`,
      );
    };
    const sample = () => {
      if (!existsSync(path)) return;
      let main: Stats | undefined;
      let rollback: Stats | undefined;
      for (const name of readdirSync(path)) {
        if (name !== 'pending.sqlite' && name !== 'pending.sqlite-journal')
          throw new Error(`未受管spool文件:${name}`);
        try {
          const st = statSync(join(path, name));
          if (name === 'pending.sqlite') main = st;
          else rollback = st;
        } catch (error) {
          // 活跃 DELETE journal 可在目录列举和 stat 之间消失。
          if (name.endsWith('-journal') && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
      }
      const mainBytes = main?.size ?? 0;
      const journalBytes = rollback?.size ?? 0;
      const blocks = ((main?.blocks ?? 0) + (rollback?.blocks ?? 0)) * 512;
      mainPeak = Math.max(mainPeak, mainBytes);
      journalPeak = Math.max(journalPeak, journalBytes);
      blocksPeak = Math.max(blocksPeak, blocks);
      // 主库没读到就不是 0 字节；journal 不在才是真 0。
      diag.mainBytes = main ? mainBytes : 'unknown';
      diag.journalBytes = journalBytes;
      diag.blocks = main ? blocks : 'unknown';
      observed++;
    };
    DatabaseSync.prototype.prepare = function (sql: string) {
      if (sql === 'SELECT key,payload,record_hash FROM pending') fullScans += 1;
      return originalPrepare.call(this, sql);
    };
    DatabaseSync.prototype.exec = function (sql: string) {
      if (sql !== 'COMMIT') return originalExec.call(this, sql);
      diag.stage = 'commit';
      diag.commit = 'before';
      sample();
      const mark = performance.now();
      const cpu = process.cpuUsage();
      try {
        return originalExec.call(this, sql);
      } finally {
        const spent = performance.now() - mark;
        const used = process.cpuUsage(cpu);
        commitSlice += spent;
        // 直接累计：断言在某条中途失败时，这次 COMMIT 的墙钟和它的 CPU 一起进诊断。
        diag.commitMs += spent;
        diag.commits += 1;
        diag.commitCpuMs += (used.user + used.system) / 1000;
        diag.commitMaxMs = Math.max(diag.commitMaxMs, spent);
        diag.commit = 'after';
        diag.stage = 'after-commit';
        sample();
      }
    };
    try {
      for (let n = 0; n < 256; n++) {
        diag.stage = 'record';
        diag.index = n;
        diag.commit = 'unknown';
        commitSlice = 0;
        const mark = performance.now();
        recordMark = mark;
        const o = observation();
        o.identity.namespace = '\u0001'.repeat(300);
        o.identity.workflowId = '\u0002'.repeat(300);
        expect(recordAdmissionAlert(path, o).kind).toBe('spooled');
        const recordMs = performance.now() - mark;
        recordMark = undefined;
        diag.recordMs += recordMs;
        if (recordMs >= diag.slowestRecordMs) {
          diag.slowestRecordMs = recordMs;
          diag.slowestCommitMs = commitSlice;
          diag.slowestIndex = n;
        }
      }
      diag.stage = 'assert';
      expect(count()).toBe(256);
      expect(observed).toBeGreaterThanOrEqual(512);
      // 旧实现每次提交都整表解码，256 条是 512 次全表读取，会越过下面的 15000ms。
      // 快照命中后不再解码；只剩第一条写锁内的那一次。
      expect(fullScans, '已提交行的整表解码必须保持常数次').toBe(1);
      expect(mainPeak).toBeGreaterThan(1024 * 1024);
      expect(journalPeak).toBeGreaterThan(0);
      expect(mainPeak).toBeLessThanOrEqual(ALERT_SPOOL_LIMITS.databaseBytes);
      expect(journalPeak).toBeLessThanOrEqual(ALERT_SPOOL_LIMITS.journalBytes);
      const d = new DatabaseSync(join(path, 'pending.sqlite'));
      const version = d.prepare('SELECT sqlite_version() version').get()?.version;
      d.close();
      // 这些是语句边界观测；运行期硬界另由固定SQL/SQLite pager不变量证明，不把采样当证明。
      // 耗时拆成 COMMIT 内/外：通过时也看得出 15 秒花在真实提交落盘还是提交前的读写与解码。
      console.log(
        `SPOOL_PEAK_EVIDENCE=${JSON.stringify({
          uid: process.getuid?.(),
          version,
          mainPeak,
          journalPeak,
          blocksPeak,
          ...timing(),
        })}`,
      );
    } catch (error) {
      emit();
      throw error;
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      DatabaseSync.prototype.prepare = originalPrepare;
      if (performance.now() - started >= 15000) emit();
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
