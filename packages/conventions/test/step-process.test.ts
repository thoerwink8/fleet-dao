// pnpm check 那一层子进程的生命周期：旧的同步执行在直接子进程先退后留着孙进程；
// 检查入口要在拒绝、抛异常、部分退出、父进程先死时把整组收掉。看守自己被杀掉时，旧实现也留着孙进程。
// setsid（spawn detached）的孙进程不在这一组里，只杀组留着它；检查入口按记下的 pid 和启动时刻收。
// 这里起的都是真进程，不用计数器代替。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DESCENDANT_TRACK_MS,
  descendantProcs,
  killProcessGroup,
  PID_ENV,
  procStartTicks,
  reapIfSameStart,
  runCheckedChild,
  runSupervised,
  SUPERVISED_ENV,
} from '../src/step-process.ts';
import { runChild } from './child.ts';

const superviseBin = fileURLToPath(new URL('../src/bin/step-supervise.ts', import.meta.url));
const linux = process.platform === 'linux';

/**
 * pnpm test:changed 经检查入口起 vitest，外层已经写上 FLEET_CHECK_SUPERVISED。
 * 这个变量的意思是「本进程已经在看守里，不要再 setsid」。测试进程继承到它之后，
 * runCheckedChild 会改走直跑：孙进程不收，SIGINT 打到 vitest worker 自己。
 * 这里要测的是 pnpm check 顶层那一跳（biome、tsc、test:changed 本身），所以剥掉再进入口。
 */
function entryEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env[SUPERVISED_ENV];
  return env;
}

function procState(pid: number): string | undefined {
  try {
    return /^State:\s+(\S+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function procPpid(pid: number): number | undefined {
  try {
    const n = Number(/^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]);
    return Number.isInteger(n) ? n : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function waitUntil(pred: () => boolean, ms: number): boolean {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  }
  return pred();
}

function killPid(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

describe.skipIf(!linux)('检查子进程收组', () => {
  let dir = '';
  const leftovers: number[] = [];

  afterEach(() => {
    for (const pid of leftovers.splice(0)) {
      const parent = procPpid(pid);
      killPid(pid);
      if (parent !== undefined && parent > 1 && parent !== process.pid) killPid(parent);
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function scripts() {
    dir = mkdtempSync(join(tmpdir(), 'fleet-step-process-'));
    // 要比记账间隔长，退出前看守来得及看见已经 setsid 的孙进程。短于这一截的脱离进程不在这条回归里。
    const dwell = DESCENDANT_TRACK_MS * 6;
    writeFileSync(join(dir, 'sleep.mjs'), 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n');
    writeFileSync(
      join(dir, 'partial.mjs'),
      `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const grand = spawn(process.execPath, [process.argv[3]], { stdio: 'ignore' });
grand.on('spawn', () => {
  writeFileSync(process.argv[2], String(grand.pid));
  process.kill(process.pid, 'SIGKILL');
});
`,
    );
    writeFileSync(
      join(dir, 'leave.mjs'),
      `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const grand = spawn(process.execPath, [process.argv[3]], { stdio: 'ignore' });
grand.on('spawn', () => {
  writeFileSync(process.argv[2], String(grand.pid));
  grand.unref();
});
`,
    );
    writeFileSync(
      join(dir, 'hang.mjs'),
      `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const grand = spawn(process.execPath, [process.argv[3]], { stdio: 'ignore' });
grand.on('spawn', () => {
  writeFileSync(process.argv[2], String(grand.pid));
  if (process.argv[4] === 'sigint') process.kill(process.ppid, 'SIGINT');
});
setInterval(() => {}, 1000);
`,
    );
    writeFileSync(
      join(dir, 'lead.mjs'),
      `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, [process.argv[3]], { stdio: 'ignore', detached: true });
child.on('spawn', () => {
  writeFileSync(process.argv[2], String(child.pid));
  child.unref();
});
`,
    );
    writeFileSync(
      join(dir, 'killsup.mjs'),
      `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const grand = spawn(process.execPath, [process.argv[3]], { stdio: 'ignore' });
let stay;
const timer = setTimeout(() => {
  if (stay) clearInterval(stay);
  process.exitCode = 2;
}, 8000);
stay = setInterval(() => {}, 1000);
grand.on('spawn', () => {
  clearTimeout(timer);
  writeFileSync(process.argv[2], String(grand.pid));
  writeFileSync(process.argv[4], process.env[${JSON.stringify(PID_ENV)}] ?? '');
  // 只杀看守自己。命令已经脱离会话，孙进程不在检查进程组里，看守的处理函数也跑不到。
  process.kill(process.ppid, 'SIGKILL');
});
`,
    );
    writeFileSync(
      join(dir, 'parent.mjs'),
      `
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const [supervise, command, pidFile, sleeper, supFile] = process.argv.slice(2);
// 命令必须是 node 去跑脚本。直接把 .mjs 当可执行文件，内核会 EACCES，看守马上退出，父进程号根本不会变。
const child = spawn(process.execPath, [supervise, process.execPath, command, pidFile, sleeper], {
  stdio: 'ignore',
  env: { ...process.env },
});
child.on('spawn', () => writeFileSync(supFile, String(child.pid)));
const start = Date.now();
const timer = setInterval(() => {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (pid > 0) {
      clearInterval(timer);
      process.kill(process.pid, 'SIGKILL');
    }
  } catch {
    // 孙进程还没把 pid 写出来。
  }
  if (Date.now() - start > 8000) {
    clearInterval(timer);
    process.exitCode = 2;
  }
}, 20);
`,
    );
    const detachedGrand = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const grand = spawn(process.execPath, [process.argv[3]], { stdio: 'ignore', detached: true });
grand.unref();
grand.on('error', () => {});
writeFileSync(process.argv[2], String(grand.pid ?? ''));
`;
    writeFileSync(
      join(dir, 'detach-hang.mjs'),
      `${detachedGrand}
setInterval(() => {}, 1000);
`,
    );
    writeFileSync(
      join(dir, 'detach-exit.mjs'),
      `${detachedGrand}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${dwell});
`,
    );
    writeFileSync(
      join(dir, 'detach-partial.mjs'),
      `${detachedGrand}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${dwell});
process.kill(process.pid, 'SIGKILL');
`,
    );
    writeFileSync(
      join(dir, 'killsup-detach.mjs'),
      `${detachedGrand}
writeFileSync(process.argv[4], String(process.pid));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${dwell});
process.kill(process.ppid, 'SIGKILL');
setInterval(() => {}, 1000);
`,
    );
  }

  function remember(file: string): number {
    const pid = Number(readFileSync(file, 'utf8'));
    leftovers.push(pid);
    return pid;
  }

  it('不是正数的 pid、以及 pid 1，不发信号', () => {
    expect(() => killProcessGroup(undefined)).not.toThrow();
    expect(() => killProcessGroup(0)).not.toThrow();
    // kill(-1) 会打到本进程能打的所有进程。这里必须什么都不发。
    expect(() => killProcessGroup(1)).not.toThrow();
    expect(() => reapIfSameStart(1, procStartTicks(1) ?? '1', true)).not.toThrow();
    expect(procState(process.pid)).toMatch(/^[SRD]/);
  });

  it('直接子进程被信号杀掉：旧执行留着孙进程（State S），检查入口把它收掉', () => {
    scripts();
    const sleeper = join(dir, 'sleep.mjs');
    const oldPid = join(dir, 'old.pid');
    expect(() => runChild(process.execPath, [join(dir, 'partial.mjs'), oldPid, sleeper])).toThrow(/被信号/);
    const oldGrand = remember(oldPid);
    // 旧路径不收组：直接子进程已经没了，孙进程还在（阻塞在 Atomics.wait 上是 S；刚起来可能还是 R）。
    expect(waitUntil(() => procState(oldGrand) === 'S', 1000)).toBe(true);
    killPid(oldGrand);
    expect(waitUntil(() => procState(oldGrand) === undefined, 2000)).toBe(true);

    const newPid = join(dir, 'new.pid');
    const result = runCheckedChild(process.execPath, [join(dir, 'partial.mjs'), newPid, sleeper], {
      stdio: 'ignore',
      env: entryEnv(),
    });
    const grand = remember(newPid);
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGKILL');
    expect(waitUntil(() => procState(grand) === undefined, 3000)).toBe(true);
  });

  it('直接子进程自己退出 0 并留下孙进程：旧执行留着，检查入口收掉且退出码仍是 0', () => {
    scripts();
    const sleeper = join(dir, 'sleep.mjs');
    const oldPid = join(dir, 'old.pid');
    expect(runChild(process.execPath, [join(dir, 'leave.mjs'), oldPid, sleeper]).status).toBe(0);
    const oldGrand = remember(oldPid);
    expect(waitUntil(() => procState(oldGrand) === 'S', 1000)).toBe(true);
    killPid(oldGrand);

    const newPid = join(dir, 'new.pid');
    const result = runCheckedChild(process.execPath, [join(dir, 'leave.mjs'), newPid, sleeper], {
      stdio: 'ignore',
      env: entryEnv(),
    });
    const grand = remember(newPid);
    expect(result.status).toBe(0);
    expect(result.signal ?? null).toBeNull();
    expect(waitUntil(() => procState(grand) === undefined, 3000)).toBe(true);
  });

  it('命令不存在：带回 ENOENT，不抛', () => {
    scripts();
    const result = runCheckedChild(join(dir, 'missing-bin'), [], { stdio: 'ignore', env: entryEnv() });
    expect(result.status).toBeNull();
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT');
  });

  it('子进程已经起来之后抛异常：孙进程被收掉，异常继续抛', async () => {
    scripts();
    const pidFile = join(dir, 'grand.pid');
    let grand = 0;
    await expect(
      runSupervised(process.execPath, [join(dir, 'hang.mjs'), pidFile, join(dir, 'sleep.mjs')], {
        stdio: 'ignore',
        watchParent: false,
        afterSpawn: () => {
          const ok = waitUntil(() => {
            try {
              grand = Number(readFileSync(pidFile, 'utf8'));
              return grand > 0;
            } catch {
              return false;
            }
          }, 5000);
          if (!ok) throw new Error('孙进程没起来');
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    leftovers.push(grand);
    expect(grand).toBeGreaterThan(0);
    expect(waitUntil(() => procState(grand) === undefined, 3000)).toBe(true);
  });

  it('看守收到 SIGINT：收掉孙进程，并把这个信号交回', () => {
    scripts();
    const pidFile = join(dir, 'grand.pid');
    const result = runCheckedChild(
      process.execPath,
      [join(dir, 'hang.mjs'), pidFile, join(dir, 'sleep.mjs'), 'sigint'],
      { stdio: 'ignore', env: entryEnv() },
    );
    const grand = remember(pidFile);
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGINT');
    expect(waitUntil(() => procState(grand) === undefined, 3000)).toBe(true);
  });

  it('父进程先死：看守看见父进程号变了，收掉孙进程然后自己退出', () => {
    scripts();
    const pidFile = join(dir, 'grand.pid');
    const supFile = join(dir, 'sup.pid');
    expect(() =>
      runChild(process.execPath, [
        join(dir, 'parent.mjs'),
        superviseBin,
        join(dir, 'hang.mjs'),
        pidFile,
        join(dir, 'sleep.mjs'),
        supFile,
      ]),
    ).toThrow(/被信号/);
    const grand = remember(pidFile);
    const sup = remember(supFile);
    expect(waitUntil(() => procState(grand) === undefined, 4000)).toBe(true);
    expect(waitUntil(() => procState(sup) === undefined, 4000)).toBe(true);
  });

  it('看守自己被信号杀掉：旧实现留着孙进程，检查入口按记下的 pid 和启动时刻收掉', () => {
    scripts();
    const pidFile = join(dir, 'grand.pid');
    const seen = join(dir, 'seen-pid-env');
    const result = runCheckedChild(
      process.execPath,
      [join(dir, 'killsup.mjs'), pidFile, join(dir, 'sleep.mjs'), seen],
      { stdio: 'ignore', env: entryEnv() },
    );
    const grand = remember(pidFile);
    expect(readFileSync(seen, 'utf8')).toBe('');
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGKILL');
    expect(waitUntil(() => procState(grand) === undefined, 3000)).toBe(true);
  });

  it('启动时刻是 stat 第 22 段，切分用父进程号锚住', () => {
    const text = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const rest = text
      .slice(text.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    // 第 4 段是父进程号。这一段对得上，后面的下标才没有切偏。
    expect(rest[1]).toBe(String(process.ppid));
    expect(procStartTicks(process.pid)).toBe(rest[19]);
    expect(procStartTicks(0)).toBeUndefined();
    expect(() => reapIfSameStart(0, '1')).not.toThrow();
  });

  it('记下的启动时刻对不上就不收，对得上才收', () => {
    scripts();
    const pidFile = join(dir, 'lead.pid');
    const sleeper = join(dir, 'sleep.mjs');
    // 短命父进程退出后，脱离的命令过继走。测试进程不是它的父进程，收掉之后 /proc 会消失，而不是停在僵尸。
    expect(runChild(process.execPath, [join(dir, 'lead.mjs'), pidFile, sleeper]).status).toBe(0);
    const pid = remember(pidFile);
    expect(waitUntil(() => procState(pid) === 'S', 2000)).toBe(true);
    const start = procStartTicks(pid);
    expect(start).toMatch(/^\d+$/);
    reapIfSameStart(pid, undefined);
    reapIfSameStart(pid, '0');
    expect(procState(pid)).toBe('S');
    reapIfSameStart(pid, start);
    expect(waitUntil(() => procState(pid) === undefined, 3000)).toBe(true);
  });

  it('脱离进程组的孙进程：只杀命令那一组留着它；旧的同步执行留着；正常退出时检查入口收掉', () => {
    scripts();
    const sleeper = join(dir, 'sleep.mjs');
    const shown = join(dir, 'shown.pid');
    const cmd = spawn(process.execPath, [join(dir, 'detach-hang.mjs'), shown, sleeper], {
      detached: true,
      stdio: 'ignore',
    });
    cmd.unref();
    expect(cmd.pid).toBeGreaterThan(1);
    leftovers.push(cmd.pid as number);
    expect(
      waitUntil(() => {
        try {
          return Number(readFileSync(shown, 'utf8')) > 1;
        } catch {
          return false;
        }
      }, 5000),
    ).toBe(true);
    const shownGrand = remember(shown);
    expect(waitUntil(() => procState(shownGrand) === 'S', 2000)).toBe(true);
    // 孙进程已经 setsid，记账看得到，但它不在命令那一组里。
    expect(descendantProcs(cmd.pid as number).get(shownGrand)?.groupLeader).toBe(true);
    killProcessGroup(cmd.pid);
    expect(procState(shownGrand)).toBe('S');
    killPid(shownGrand);

    const oldPid = join(dir, 'old.pid');
    expect(runChild(process.execPath, [join(dir, 'detach-exit.mjs'), oldPid, sleeper]).status).toBe(0);
    const oldGrand = remember(oldPid);
    expect(waitUntil(() => procState(oldGrand) === 'S', 2000)).toBe(true);
    killPid(oldGrand);

    const newPid = join(dir, 'new.pid');
    const result = runCheckedChild(process.execPath, [join(dir, 'detach-exit.mjs'), newPid, sleeper], {
      stdio: 'ignore',
      env: entryEnv(),
    });
    const grand = remember(newPid);
    expect(result.status).toBe(0);
    expect(result.signal ?? null).toBeNull();
    expect(waitUntil(() => procState(grand) === undefined, 3000)).toBe(true);
  }, 20_000);

  it('脱离进程组的孙进程，直接子进程被信号杀掉：旧执行留着，检查入口收掉', () => {
    scripts();
    const sleeper = join(dir, 'sleep.mjs');
    const script = join(dir, 'detach-partial.mjs');
    const oldPid = join(dir, 'old.pid');
    expect(() => runChild(process.execPath, [script, oldPid, sleeper])).toThrow(/被信号/);
    const oldGrand = remember(oldPid);
    expect(waitUntil(() => procState(oldGrand) === 'S', 2000)).toBe(true);
    killPid(oldGrand);

    const newPid = join(dir, 'new.pid');
    const result = runCheckedChild(process.execPath, [script, newPid, sleeper], {
      stdio: 'ignore',
      env: entryEnv(),
    });
    const grand = remember(newPid);
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGKILL');
    expect(waitUntil(() => procState(grand) === undefined, 3000)).toBe(true);
  }, 20_000);

  it('子进程已经起来之后抛异常：脱离进程组的孙进程也被收掉', async () => {
    scripts();
    const pidFile = join(dir, 'grand.pid');
    let grand = 0;
    await expect(
      runSupervised(process.execPath, [join(dir, 'detach-hang.mjs'), pidFile, join(dir, 'sleep.mjs')], {
        stdio: 'ignore',
        watchParent: false,
        afterSpawn: () => {
          const ok = waitUntil(() => {
            try {
              grand = Number(readFileSync(pidFile, 'utf8'));
              return grand > 1;
            } catch {
              return false;
            }
          }, 5000);
          if (!ok) throw new Error('孙进程没起来');
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    leftovers.push(grand);
    expect(grand).toBeGreaterThan(1);
    expect(waitUntil(() => procState(grand) === undefined, 3000)).toBe(true);
  });

  it('看守自己被信号杀掉：脱离进程组的孙进程由父进程按记下的 pid 和启动时刻收掉', () => {
    scripts();
    const pidFile = join(dir, 'grand.pid');
    const selfFile = join(dir, 'self.pid');
    const result = runCheckedChild(
      process.execPath,
      [join(dir, 'killsup-detach.mjs'), pidFile, join(dir, 'sleep.mjs'), selfFile],
      { stdio: 'ignore', env: entryEnv() },
    );
    const grand = remember(pidFile);
    const self = remember(selfFile);
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGKILL');
    expect(waitUntil(() => procState(grand) === undefined, 3000)).toBe(true);
    expect(waitUntil(() => procState(self) === undefined, 3000)).toBe(true);
  }, 20_000);

  it('不是组长的只杀这一个；把它的 pid 当成组号杀，够不着', () => {
    scripts();
    const child = spawn(process.execPath, [join(dir, 'sleep.mjs')], { stdio: 'ignore' });
    child.unref();
    expect(child.pid).toBeGreaterThan(1);
    const pid = child.pid as number;
    leftovers.push(pid);
    expect(waitUntil(() => procState(pid) === 'S', 2000)).toBe(true);
    const start = procStartTicks(pid);
    expect(start).toMatch(/^\d+$/);
    reapIfSameStart(pid, start, true);
    expect(procState(pid)).toBe('S');
    reapIfSameStart(pid, start, false);
    // 父进程还是这个测试进程，事件循环又停在 Atomics.wait 上，收不到 wait：进程已死时 /proc 停在 Z，不会消失。
    expect(
      waitUntil(() => {
        const state = procState(pid);
        return state === undefined || state === 'Z';
      }, 3000),
    ).toBe(true);
  });

  it('退出码原样交回', () => {
    const result = runCheckedChild(process.execPath, ['-e', 'process.exitCode = 3'], {
      stdio: 'ignore',
      env: entryEnv(),
    });
    expect(result.status).toBe(3);
    expect(result.error).toBeUndefined();
  });
});
