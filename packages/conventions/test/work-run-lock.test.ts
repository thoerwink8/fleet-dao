// 工作锁的固定交错（PR #3215 评审的几轮反例）：在真实文件系统上，把一个恢复者停在「发布自己那一代」的改名前后，
// 让另一个恢复者在这个窗口里走完占位、交接、放开、再占，然后放前一个继续。只在 renameSync 边界插一段同步代码，
// claimRunLock、判活、真实目录都不替换。不管怎么交错，任何时刻最多一个活着的 token，已返回的赢家不被删、挪、覆盖。
import { mkdirSync, mkdtempSync, existsSync as realExists, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({
  before: null as null | ((to: string) => void),
  after: null as null | ((to: string) => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const renameSync: typeof fs.renameSync = (from, to) => {
    const target = String(to);
    const publish = /gen-\d+$/.test(target);
    const before = publish ? hook.before : null;
    if (before) {
      hook.before = null;
      before(target);
    }
    fs.renameSync(from, to);
    const after = publish ? hook.after : null;
    if (after) {
      hook.after = null;
      after(target);
    }
  };
  return { ...fs, default: { ...fs, renameSync }, renameSync };
});

const {
  claimRunLock,
  handoffRunLock,
  readJson,
  releaseRunLock,
  runLockHeld,
  setRunLockWorker,
  SUPERVISOR_START_LOCK,
  WORKER_SLOT_LOCK,
  writeJson,
} = await import('../src/work-run.ts');

const dirs: string[] = [];
afterEach(() => {
  hook.before = null;
  hook.after = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'work-lock-'));
  dirs.push(d);
  return d;
}

function deadPid(): number {
  for (let pid = 1 << 22; pid < (1 << 22) + 4096; pid++) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('没找到已退出的进程号');
}

/** 上一个版本的布局：主锁和回收闸根上都留着已死的 owner（持闸回收时进程退出能留下的样子） */
function deadLegacy(dir: string, name: string) {
  const stale = deadPid();
  for (const n of [name, `${name}.reclaim`]) {
    mkdirSync(join(dir, n), { recursive: true });
    writeJson(join(dir, n, 'owner.json'), {
      pid: stale,
      token: `old-${n}`,
      claimedAt: '2026-10-16T09:00:00.000Z',
    });
  }
}

const ownerOf = (dir: string, name: string, n: number) =>
  readJson<{ token: string; pid: number; workerPid?: number }>(join(dir, name, `gen-${n}`, 'owner.json'));

describe.each([SUPERVISOR_START_LOCK, WORKER_SLOT_LOCK])('%s 的固定交错', (name) => {
  it('主锁和回收闸都留死 owner：B 停在发布前，A 先接替并返回，B 撞上同一编号认输', () => {
    const dir = temp();
    deadLegacy(dir, name);
    let a: string | null = null;
    hook.before = () => {
      a = claimRunLock(dir, name, process.pid, new Date());
    };
    const b = claimRunLock(dir, name, process.pid, new Date());
    expect(a).toBeTruthy();
    expect(b).toBeNull();
    expect(ownerOf(dir, name, 1)?.token).toBe(a);
    expect(runLockHeld(dir, name, new Date())).toBe(true);
    expect(claimRunLock(dir, name, process.pid, new Date())).toBeNull();
    expect(ownerOf(dir, name, 1)?.token).toBe(a);
  });

  it('B 停在发布前，A 占上、交接给看护、登记工人：B 继续也拿不到，A 的 owner 原样', () => {
    const dir = temp();
    deadLegacy(dir, name);
    let a: string | null = null;
    hook.before = () => {
      a = claimRunLock(dir, name, process.pid, new Date());
      if (!a) return;
      expect(handoffRunLock(dir, name, a, process.ppid, new Date())).toBe(true);
      expect(setRunLockWorker(dir, name, a, process.pid)).toBe(true);
    };
    const b = claimRunLock(dir, name, process.pid, new Date());
    expect(a).toBeTruthy();
    expect(b).toBeNull();
    expect(ownerOf(dir, name, 1)).toMatchObject({ token: a, pid: process.ppid, workerPid: process.pid });
  });

  it('B 凭旧判断停在发布前，期间 A 占了又放、C 接了下一代：B 建出的旧编号复核认输，只删自己那一代', () => {
    const dir = temp();
    deadLegacy(dir, name);
    let a: string | null = null;
    let c: string | null = null;
    hook.before = () => {
      a = claimRunLock(dir, name, process.pid, new Date());
      if (a) releaseRunLock(dir, name, a);
      c = claimRunLock(dir, name, process.pid, new Date());
      // C 赢了以后清掉了 gen-1，B 接下来改名到 gen-1 会成功，只能靠复核认输
      expect(realExists(join(dir, name, 'gen-1'))).toBe(false);
    };
    const b = claimRunLock(dir, name, process.pid, new Date());
    expect(a).toBeTruthy();
    expect(c).toBeTruthy();
    expect(b).toBeNull();
    expect(realExists(join(dir, name, 'gen-1'))).toBe(false);
    expect(ownerOf(dir, name, 2)?.token).toBe(c);
    expect(runLockHeld(dir, name, new Date())).toBe(true);
    expect(claimRunLock(dir, name, process.pid, new Date())).toBeNull();
    expect(ownerOf(dir, name, 2)?.token).toBe(c);
  });

  it('B 已发布、还没复核时 A 进来：A 拒绝，B 成功后锁保留，C 也拿不到第二个', () => {
    const dir = temp();
    deadLegacy(dir, name);
    let a: string | null = 'unset';
    hook.after = () => {
      a = claimRunLock(dir, name, process.pid, new Date());
    };
    const b = claimRunLock(dir, name, process.pid, new Date());
    expect(b).toBeTruthy();
    expect(a).toBeNull();
    expect(ownerOf(dir, name, 1)?.token).toBe(b);
    expect(claimRunLock(dir, name, process.pid, new Date())).toBeNull();
    expect(ownerOf(dir, name, 1)?.token).toBe(b);
  });

  it('递归两层：B 停在发布前，A 停在自己发布前时 C 接替；三者只出一个 token，赢家没被换掉', () => {
    const dir = temp();
    deadLegacy(dir, name);
    let a: string | null = null;
    let c: string | null = null;
    hook.before = () => {
      hook.before = () => {
        c = claimRunLock(dir, name, process.pid, new Date());
      };
      a = claimRunLock(dir, name, process.pid, new Date());
    };
    const b = claimRunLock(dir, name, process.pid, new Date());
    const won = [a, b, c].filter((t) => t !== null);
    expect(won).toHaveLength(1);
    expect(ownerOf(dir, name, 1)?.token).toBe(won[0]);
    expect(claimRunLock(dir, name, process.pid, new Date())).toBeNull();
  });

  it('上一代的看护死了但登记的工人还活着：不接替', () => {
    const dir = temp();
    const token = claimRunLock(dir, name, deadPid(), new Date());
    expect(token).toBeTruthy();
    if (!token) return;
    expect(setRunLockWorker(dir, name, token, process.pid)).toBe(true);
    expect(runLockHeld(dir, name, new Date())).toBe(true);
    expect(claimRunLock(dir, name, process.pid, new Date())).toBeNull();
    expect(setRunLockWorker(dir, name, token, null)).toBe(true);
    expect(runLockHeld(dir, name, new Date())).toBe(false);
    expect(claimRunLock(dir, name, process.pid, new Date())).toBeTruthy();
  });
});
