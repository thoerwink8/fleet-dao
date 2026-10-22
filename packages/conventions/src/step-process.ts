// pnpm check / test:changed 起的那一层子进程：直接子进程被信号杀掉或自己退出时，孙进程会过继走、仍留在同一个 scope 里占内存。
// 这里让真正的命令自成一组，结束时（拒绝、抛异常、部分退出、父进程先死）把整组收掉。已经在看守里的调用不再套第二层，
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
 * 跑一条命令并在任何收场路径收掉它的进程组。
 * - 拒绝：命令起不来（ENOENT），error 带回，没有组可收；
 * - 异常：afterSpawn 抛出，或调用方拿到的 Promise 拒绝之前，组已经杀掉；
 * - 部分退出：直接子进程先退（包括被信号杀掉），组里剩下的子孙一起收掉。
 * 父进程号变了（父进程先死、自己过继走了）同样收组：父进程被内核杀掉时，这一层的 finally 跑不到。
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

/** 看守进程的入口（bin/step-supervise.ts）。结果写进 FLEET_CHECK_STATUS，自己以 0 退出，让父进程读文件而不是把看守的退出码当成命令的。 */
export async function superviseCli(argv: readonly string[]): Promise<void> {
  const file = process.env[STATUS_ENV];
  const command = argv[0];
  if (!command) {
    writeStatus(file, { error: '没有命令', code: 'ENOENT' });
    return;
  }
  // 状态文件路径只留给看守。传进命令的话，命令删掉文件，父进程会退回看看守自己的退出码，把失败看成通过。
  const env = { ...process.env };
  delete env[STATUS_ENV];
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
  const bin = fileURLToPath(new URL('./bin/step-supervise.ts', import.meta.url));
  const childEnv: NodeJS.ProcessEnv = { ...env, [SUPERVISED_ENV]: '1', [STATUS_ENV]: file };
  try {
    const run = spawnSync(process.execPath, [bin, command, ...args], {
      cwd: options.cwd,
      env: childEnv,
      stdio: options.stdio ?? 'inherit',
      windowsHide: true,
    });
    return readSupervisedResult(file, { status: run.status, signal: run.signal, error: run.error });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
