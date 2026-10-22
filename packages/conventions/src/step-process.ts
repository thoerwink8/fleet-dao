// pnpm check / test:changed 起的那一层子进程：直接子进程被信号杀掉或自己退出时，孙进程会过继走、仍留在同一个 scope 里占内存。
// 这里让真正的命令自成一组，结束时（拒绝、抛异常、部分退出、父进程先死）把整组收掉。看守自己被 SIGKILL 时收组代码跑不到，
// 父进程再按记下的 pid 和启动时刻收一次（对不上就不杀，避免 pid 被复用）。已经在看守里的调用不再套第二层，
// 免得内层再 setsid，外层收不到 vitest 的工人。Windows 没有这套进程组，保持原来的 spawnSync。
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StepRun } from './check.ts';

/** 设在被看守的命令上：里面再起检查步骤时不要再套一层看守。 */
export const SUPERVISED_ENV = 'FLEET_CHECK_SUPERVISED';
const STATUS_ENV = 'FLEET_CHECK_STATUS';
/** 看守把命令的 pid 和启动时刻写到这个路径。不传给命令，避免命令删掉文件后父进程收不到组。 */
export const PID_ENV = 'FLEET_CHECK_PID';

export interface StepSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'ignore';
}

export interface SuperviseHooks extends StepSpawnOptions {
  /** 子进程已经起来。抛出时整组杀掉，异常继续往外抛。 */
  afterSpawn?: (pid: number) => void;
  /** 默认盯着自己的父进程号，变了就收组。测试可以关掉。 */
  watchParent?: boolean;
  /** 看守进程自己收到 SIGINT/SIGTERM 时先收组。进进程内测这条时关掉，免得换掉测试进程的信号行为。 */
  trapSignals?: boolean;
}

interface StatusFile {
  status?: number | null;
  signal?: string | null;
  error?: string;
  code?: string;
}

/** 杀掉 pid 带领的进程组。pid 不是正整数、组已经空了、没有权限，都不报。 */
export function killProcessGroup(pid: number | undefined): void {
  if (process.platform === 'win32') return;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw err;
  }
}

/**
 * `/proc/<pid>/stat` 第 22 段：进程启动时刻（时钟滴答）。
 * comm 可以含空格和括号，从最后一个 `)` 后面切。读不到就是 undefined，调用方据此不杀。
 */
export function procStartTicks(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = text.lastIndexOf(')');
    if (close < 0) return undefined;
    const start = text
      .slice(close + 1)
      .trim()
      .split(/\s+/)[19];
    return start !== undefined && /^\d+$/.test(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

/** 启动时刻还对得上才收组。对不上（已经退出，或这个 pid 被别人复用）不杀。 */
export function reapIfSameStart(pid: number, start: string | undefined): void {
  if (start === undefined || !/^\d+$/.test(start)) return;
  if (procStartTicks(pid) !== start) return;
  killProcessGroup(pid);
}

/**
 * 跑一条命令并在任何收场路径收掉它的进程组。
 * - 拒绝：命令起不来（ENOENT），error 带回，没有组可收；
 * - 异常：afterSpawn 抛出，或调用方拿到的 Promise 拒绝之前，组已经杀掉；
 * - 部分退出：直接子进程先退（包括被信号杀掉），组里剩下的子孙一起收掉。
 * 父进程号变了（父进程先死、自己过继走了）同样收组：父进程被内核杀掉时，这一层的 finally 跑不到。
 * 看守自己被 SIGKILL 时这里也跑不到，由 runCheckedChild 按记下的 pid 和启动时刻收。
 */
export function runSupervised(
  command: string,
  args: readonly string[],
  hooks: SuperviseHooks = {},
): Promise<StepRun> {
  const posix = process.platform !== 'win32';
  const parent = process.ppid;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let childPid: number | undefined;
    const onSigint = () => finish({ status: null, signal: 'SIGINT' });
    const onSigterm = () => finish({ status: null, signal: 'SIGTERM' });
    const stopTraps = () => {
      if (!hooks.trapSignals) return;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };
    function finish(result: StepRun, thrown?: unknown) {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      stopTraps();
      killProcessGroup(childPid);
      if (thrown !== undefined) reject(thrown);
      else resolve(result);
    }
    // 先装信号，再起进程：子进程一起来就可能给看守发 SIGINT，装晚了默认动作会把看守杀掉、组留着。
    if (hooks.trapSignals && posix) {
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigterm);
    }
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: hooks.cwd,
        env: hooks.env ?? process.env,
        stdio: hooks.stdio ?? 'inherit',
        detached: posix,
        windowsHide: true,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      finish({ status: null, error }, error);
      return;
    }
    childPid = child.pid;
    if (settled) {
      killProcessGroup(childPid);
      return;
    }
    child.on('error', (err) => finish({ status: null, error: err }));
    child.on('close', (status, signal) => finish({ status, signal }));
    if (hooks.watchParent !== false) {
      timer = setInterval(() => {
        if (process.ppid !== parent) finish({ status: null, signal: 'SIGKILL' });
      }, 200);
      timer.unref();
      if (process.ppid !== parent) {
        finish({ status: null, signal: 'SIGKILL' });
        return;
      }
    }
    try {
      if (childPid !== undefined) hooks.afterSpawn?.(childPid);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      finish({ status: null, error }, error);
    }
  });
}

function writeStatus(file: string | undefined, body: StatusFile): void {
  if (!file) return;
  writeFileSync(file, JSON.stringify(body));
}

/** 命令一起来就把 pid 和启动时刻写上。写在子进程跑 JS 之前，看守随后被杀掉也还有据可收。 */
function writeGroupPid(file: string | undefined, pid: number): void {
  if (!file) return;
  const start = procStartTicks(pid);
  if (start === undefined) return;
  writeFileSync(file, `${pid} ${start}\n`);
}

/** 看守没来得及收组时用。文件没有、写坏了、进程已退出、启动时刻变了，都不杀。 */
function reapRecordedGroup(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const [pidText, start] = text.trim().split(/\s+/);
  if (pidText === undefined || !/^\d+$/.test(pidText)) return;
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return;
  reapIfSameStart(pid, start);
}

/** 看守进程的入口（bin/step-supervise.ts）。结果写进 FLEET_CHECK_STATUS，自己以 0 退出，让父进程读文件而不是把看守的退出码当成命令的。 */
export async function superviseCli(argv: readonly string[]): Promise<void> {
  const file = process.env[STATUS_ENV];
  const command = argv[0];
  if (!command) {
    writeStatus(file, { error: '没有命令', code: 'ENOENT' });
    return;
  }
  // 状态文件和 pid 文件的路径只留给看守。传进命令的话，命令可以删掉，父进程就收不到组，或把失败看成通过。
  const env = { ...process.env };
  delete env[STATUS_ENV];
  delete env[PID_ENV];
  const pidFile = process.env[PID_ENV];
  let groupPid: number | undefined;
  let crashing = false;
  const crash = (err: unknown) => {
    if (crashing) return;
    crashing = true;
    try {
      killProcessGroup(groupPid);
    } catch {
      // 收组失败也要把状态写出去，父进程还堵在等看守退出。
    }
    try {
      writeStatus(file, { error: err instanceof Error ? err.message : String(err) });
    } catch {
      // 状态文件写不了时，父进程改看看守的退出码。
    }
    // 子进程句柄会把事件循环吊住，自然退不出，父进程就一直等不到状态文件。
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  try {
    const result = await runSupervised(command, argv.slice(1), {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
      trapSignals: true,
      afterSpawn: (pid) => {
        groupPid = pid;
        writeGroupPid(pidFile, pid);
      },
    });
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    writeStatus(file, {
      ...(result.signal ? { signal: result.signal } : { status: result.status }),
      ...(result.error ? { error: result.error.message, ...(code ? { code } : {}) } : {}),
    });
  } catch (err) {
    writeStatus(file, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    process.off('uncaughtException', crash);
  }
}

function readSupervisedResult(file: string, fallback: StepRun): StepRun {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  let data: StatusFile;
  try {
    data = JSON.parse(text) as StatusFile;
  } catch {
    return fallback;
  }
  if (data.error) {
    const error = new Error(data.error);
    if (data.code) (error as NodeJS.ErrnoException).code = data.code;
    return { status: null, error };
  }
  if (data.signal) return { status: null, signal: data.signal };
  if (typeof data.status === 'number') return { status: data.status };
  return fallback;
}

/** 检查的一步。POSIX 上套看守；已经在看守里、或 Windows，直接 spawnSync（和原来同一个返回）。 */
export function runCheckedChild(
  command: string,
  args: readonly string[],
  options: StepSpawnOptions = {},
): StepRun {
  const env = options.env ?? process.env;
  if (process.platform === 'win32' || env[SUPERVISED_ENV] === '1') {
    const run = spawnSync(command, args, {
      cwd: options.cwd,
      env,
      stdio: options.stdio ?? 'inherit',
      windowsHide: true,
    });
    return { status: run.status, signal: run.signal, error: run.error };
  }
  const dir = mkdtempSync(join(tmpdir(), 'fleet-check-status-'));
  const file = join(dir, 'status.json');
  const pidFile = join(dir, 'group.pid');
  const bin = fileURLToPath(new URL('./bin/step-supervise.ts', import.meta.url));
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    [SUPERVISED_ENV]: '1',
    [STATUS_ENV]: file,
    [PID_ENV]: pidFile,
  };
  try {
    const run = spawnSync(process.execPath, [bin, command, ...args], {
      cwd: options.cwd,
      env: childEnv,
      stdio: options.stdio ?? 'inherit',
      windowsHide: true,
    });
    return readSupervisedResult(file, { status: run.status, signal: run.signal, error: run.error });
  } finally {
    // 看守被 SIGKILL 时自己的收组跑不到，脱离的命令还在。启动时刻对不上（已退出或 pid 被复用）就不杀。
    try {
      reapRecordedGroup(pidFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
