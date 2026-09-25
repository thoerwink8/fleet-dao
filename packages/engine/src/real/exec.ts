// 以会话用户的身份跑一条短命令（git、读结论文件）：经 fleet-agent-scope 起一个短命 scope（design 十四：
// 引擎不以自己的身份在会话的目录里跑 git——会话能在自己的树里埋 git 配置和钩子，引擎一跑就以引擎的身份执行了）。
// 标准输入输出都是字节：bundle 经它进出（会话用户读不到引擎的镜像仓，引擎也读不到会话用户的家）。

import { spawn } from 'node:child_process';
import {
  assertScopeInProduction,
  type CgroupScope,
  type ScopeLimits,
  type SessionUser,
  scopePrefix,
} from '@fleet-dao/adapters';

export interface UserCommand {
  user: SessionUser;
  /** 绝对路径，会话用户进得去。 */
  cwd: string;
  /** argv[0] 是绝对路径。 */
  argv: string[];
  stdin?: Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
  /** scope 编号（单元名 fleet-agent-<编号>.scope 的一段）：同一时刻不许重复，最长 63。 */
  scopeId: string;
  /** 额外的环境变量：只有 FLEET_*、LANG、LC_*、TZ、TERM、GIT_TERMINAL_PROMPT 过得了 sudo。 */
  env?: Record<string, string>;
}

export interface UserCommandResult {
  /** null = 没正常退出（超时、被叫停、起不来）。 */
  code: number | null;
  stdout: Buffer;
  /** 末尾一段。 */
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** 起不来（找不到 sudo、帮手脚本）时的原因。 */
  spawnError?: string;
}

export type UserExec = (command: UserCommand) => Promise<UserCommandResult>;

const STDERR_TAIL = 4000;
/** stdout 上限：bundle 最大 100 MiB（github 包的 MAX_BUNDLE_BYTES），多留一点。超了就杀掉、算失败。 */
export const MAX_STDOUT_BYTES = 110 * 1024 * 1024;

interface SpawnPlan {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

function run(plan: SpawnPlan, command: UserCommand, maxStdout: number): Promise<UserCommandResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let overflow = false;
    let settled = false;
    const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: 'pipe' });
    const finish = (result: UserCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      command.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已经退了
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, command.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (command.signal?.aborted) onAbort();
    command.signal?.addEventListener('abort', onAbort);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxStdout) {
        overflow = true;
        kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('error', (error) =>
      finish({
        code: null,
        stdout: Buffer.alloc(0),
        stderr,
        timedOut,
        aborted,
        spawnError: error.message,
      }),
    );
    child.on('close', (code) =>
      finish({
        code: overflow ? null : code,
        stdout: Buffer.concat(chunks),
        stderr: overflow ? `${stderr}\n输出超过 ${maxStdout} 字节，已中止`.slice(-STDERR_TAIL) : stderr,
        timedOut,
        aborted,
      }),
    );
    child.stdin.on('error', () => {
      // 对方没读完就退了：结局按退出码判
    });
    child.stdin.end(command.stdin ?? Buffer.alloc(0));
  });
}

export interface ScopeExecOptions {
  helper?: string;
  sudo?: readonly string[];
  limits?: ScopeLimits;
  maxStdoutBytes?: number;
}

/** 生产用：`sudo -n fleet-agent-scope run <编号> --user <用户> --cwd <目录> -- <命令…>`。 */
export function scopeExec(options: ScopeExecOptions = {}): UserExec {
  return (command) => {
    const scope: CgroupScope = {
      id: command.scopeId,
      user: command.user,
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.helper ? { helper: options.helper } : {}),
      ...(options.sudo ? { sudo: options.sudo } : {}),
    };
    const prefix = scopePrefix(scope, command.cwd);
    const [head, ...rest] = [...prefix, ...command.argv];
    if (!head) throw new Error('命令是空的');
    return run(
      {
        command: head,
        args: rest,
        // 进程本身从 / 起，工作目录由帮手按 --cwd 以会话用户的身份进（进不去就 64）。
        cwd: '/',
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          GIT_TERMINAL_PROMPT: '0',
          ...(command.env ?? {}),
        },
      },
      command,
      options.maxStdoutBytes ?? MAX_STDOUT_BYTES,
    );
  };
}

/**
 * 开发机、测试用：直接以当前用户在 cwd 里跑（不管 user、不进 scope）。生产配置下拒用——那等于以引擎的身份在会话的树里跑。
 */
export function localExec(env: Readonly<Record<string, string | undefined>> = process.env): UserExec {
  assertScopeInProduction(undefined, env);
  return (command) => {
    const [head, ...rest] = command.argv;
    if (!head) throw new Error('命令是空的');
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
    return run(
      {
        command: head,
        args: rest,
        cwd: command.cwd,
        env: { ...base, GIT_TERMINAL_PROMPT: '0', ...(command.env ?? {}) },
      },
      command,
      MAX_STDOUT_BYTES,
    );
  };
}

/** 一条命令没跑成的白话（给 PortError 的原文）。 */
export function describeFailure(what: string, r: UserCommandResult): string {
  if (r.spawnError) return `${what}：没起来（${r.spawnError}）`;
  if (r.timedOut) return `${what}：超时被停`;
  if (r.aborted) return `${what}：被叫停`;
  const tail = r.stderr.trim().split('\n').slice(-5).join(' / ');
  return `${what}：退出码 ${r.code}${tail ? `（${tail}）` : ''}`;
}
