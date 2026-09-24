// 生产用的外部能力：起子进程、读文件、开 WebSocket。读取器只经 ReaderContext 用它们。
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { WebSocket } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, RunCommand, ScratchDir, WebSocketLike } from './context.ts';

/**
 * 子进程的工作目录用一个新建的空目录：在 /tmp 或家目录里起 Claude Code，
 * 会把那里别人留下的项目设置（含钩子）一起加载。
 */
export async function scratchDir(): Promise<ScratchDir> {
  const path = await mkdtemp(join(tmpdir(), 'fleet-quota-'));
  return { path, dispose: () => rm(path, { recursive: true, force: true }) };
}

const MAX_OUTPUT = 4 * 1024 * 1024;
const KILL_GRACE_MS = 3_000;

/**
 * 起一个命令，收齐 stdout/stderr。stdin 一律不给（管道不关，Claude Code 会干等输入）。
 * 叫停时连同进程组一起杀（POSIX 下 detached 起，杀负 pid），不留孤儿。
 */
export const runCommand: RunCommand = (argv, { cwd, env, signal }) =>
  new Promise<CommandResult>((resolve) => {
    const [bin, ...args] = argv;
    if (!bin) {
      resolve({ code: null, stdout: '', stderr: '', spawnError: '命令是空的', killed: false });
      return;
    }
    const posix = process.platform !== 'win32';
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: posix,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let killed = false;
    let settled = false;
    let spawnError: string | undefined;

    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (posix) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // 已经退了
      }
    };
    const onAbort = () => {
      killed = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS).unref();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (b: Buffer) => {
      if (outBytes < MAX_OUTPUT) out.push(b);
      outBytes += b.length;
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (errBytes < MAX_OUTPUT) err.push(b);
      errBytes += b.length;
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      // 进程退了，进程组里还活着的一并收掉。
      if (posix) killTree('SIGKILL');
      const result: CommandResult = {
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        killed,
      };
      if (spawnError !== undefined) result.spawnError = spawnError;
      resolve(result);
    };
    child.on('error', (e) => {
      spawnError = e.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

export async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export function openWebSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

/** 子进程只带这些宿主环境变量；ANTHROPIC_* 之类一律不带——有值就会绕开 reclaude 的代理链。 */
const PASS_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'SystemRoot',
  'SYSTEMROOT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'PATHEXT',
  'ComSpec',
];

export function childEnv(
  host: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASS_ENV) {
    const v = host[key];
    if (typeof v === 'string') env[key] = v;
  }
  return { ...env, ...extra };
}
