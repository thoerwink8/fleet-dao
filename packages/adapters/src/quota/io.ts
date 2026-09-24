// 生产用的外部能力：起子进程、读文件、开 WebSocket。读取器只经 ReaderContext 用它们；
// readAllQuotas 不会自己拿这些默认值，要调用方显式传 productionQuotaIo()。
import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { WebSocket } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, QuotaIo, RunCommand, WebSocketLike } from './context.ts';
import { isForbiddenClaudeEnv } from './util.ts';

/** 生产环境的全套外部能力：真进程、真网络、真文件、本进程的家目录和环境。 */
export function productionQuotaIo(): QuotaIo {
  const home = homedir();
  return {
    fetch: globalThis.fetch,
    runCommand,
    readFile: readTextFile,
    listDir,
    openWebSocket,
    workDir: () => quotaWorkDir(home),
    homeDir: home,
    env: process.env,
  };
}

/**
 * 子进程的固定工作目录：`<家目录>/.cache/fleet-dao/quota-cwd`，没有就建（只给自己读写）。
 * 每次同一个——Claude Code 按工作目录在 ~/.claude/projects 下建目录（哪怕不落会话记录也会建），
 * 换一次就多留一个；必须是空的真目录——里面要是有项目设置或钩子，Claude Code 会一起加载。
 */
export async function quotaWorkDir(home: string): Promise<string> {
  const path = join(home, '.cache', 'fleet-dao', 'quota-cwd');
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${path} 不是真目录`);
  const entries = await readdir(path);
  if (entries.length)
    throw new Error(`${path} 不是空的（${entries.slice(0, 3).join('、')}），不在里面起 Claude Code`);
  return path;
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

/** 目录不在就照实抛 ENOENT：「目录不在」和「目录是空的」是两回事，不许折成空列表。 */
export async function listDir(path: string): Promise<string[]> {
  return readdir(path);
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

/** 配置里的额外变量：配置校验已经拦了会绕开 reclaude 的那几个，这里构造环境时再兜一道。 */
export function childEnv(
  host: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASS_ENV) {
    const v = host[key];
    if (typeof v === 'string') env[key] = v;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!isForbiddenClaudeEnv(key)) env[key] = value;
  }
  return env;
}
