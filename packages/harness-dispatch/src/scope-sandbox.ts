// 工人以会话用户跑的真实现（#3814，接口 WorkerSandbox 在 harness-workers）：经 `sudo -n fleet-agent-scope` 调以 root 装好的帮手。
// 帮手协议从旧 adapters/src/tree-cleanup.ts、procs.ts 复制改写（决定 0124：不依赖旧包）：每次先问能力，删时带 adopt 回执的身份，
// 回执对不上就拒；真正的边界在帮手里。起子进程只走 runCommand（runProcess，A5），所以放在这一层。
import { tmpdir } from 'node:os';
import { makeRedactor, type Redactor } from '@fleet-dao/harness-runner';
import type { WorkerSandbox } from '@fleet-dao/harness-workers';
import { type CommandResult, runCommand } from './command.ts';

/** 影子工人的 scope 编号前缀：和旧引擎的会话编号分开，deploy/france/fleet2-worker.sh 用同一个。 */
export const SHADOW_SCOPE_PREFIX = 'fleet2-';
export const SCOPE_HELPER = '/usr/local/sbin/fleet-agent-scope';
export const SESSION_USER = 'fleet-agent-carpool';
const FEATURES = ['tree-usage', 'identity-remove', 'locked-adopt', 'temporary-files'];
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const DIGITS = /^(0|[1-9][0-9]{0,39})$/;
/** 写上 sudo 命令行的值不许带控制字符（\r、\n……会搅乱 sudo 的日志）。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要拦控制字符
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

export interface ScopeSandboxOptions {
  helper?: string;
  /** 调帮手的前缀，默认 ['/usr/bin/sudo', '-n']；测试换成起假帮手的命令。 */
  sudo?: readonly string[];
  timeoutMs?: number;
  redact?: Redactor;
  hostEnv?: Readonly<Record<string, string | undefined>>;
}

interface Identity {
  real: string;
  dev: string;
  ino: string;
  uid: string;
}

type Reply = Record<string, unknown>;

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

async function exec(o: ScopeSandboxOptions, args: string[]): Promise<string> {
  const r: CommandResult = await runCommand({
    command: [...(o.sudo ?? ['/usr/bin/sudo', '-n']), o.helper ?? SCOPE_HELPER, ...args],
    cwd: tmpdir(),
    timeoutMs: o.timeoutMs ?? 115_000,
    redact: o.redact ?? makeRedactor([]),
    maxOutputChars: 128 * 1024,
    ...(o.hostEnv ? { hostEnv: o.hostEnv } : {}),
  });
  if (!r.ran || r.exitCode !== 0 || r.truncated) {
    const why = r.spawnError ?? r.killed ?? (r.truncated ? '回执太长' : `退出码 ${r.exitCode}`);
    throw new SandboxError(
      `fleet-agent-scope ${args[0]} 没成：${why} ${r.stderrTail.trim().slice(-1000)}`.trim(),
    );
  }
  return r.stdout;
}

async function call(o: ScopeSandboxOptions, args: string[]): Promise<Reply> {
  const out = await exec(o, args);
  let row: unknown;
  try {
    row = JSON.parse(out);
  } catch {
    throw new SandboxError(`fleet-agent-scope ${args[0]} 的回执不是 JSON`);
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SandboxError('回执不是对象');
  const r = row as Reply;
  if (r.version !== 1 || typeof r.state !== 'string' || r.state === 'unknown') {
    throw new SandboxError(`fleet-agent-scope ${args[0]} 的回执版本或状态不完整`);
  }
  return r;
}

/** 每次先问能力：换了旧版帮手不能凭缓存的能力放行。 */
async function invoke(o: ScopeSandboxOptions, args: string[]): Promise<Reply> {
  const cap = await call(o, ['capabilities']);
  const features = cap.features;
  if (cap.state !== 'ok' || !Array.isArray(features) || !FEATURES.every((f) => features.includes(f))) {
    throw new SandboxError('帮手不支持完整的交树、删树协议');
  }
  return call(o, args);
}

function identity(value: unknown, dir: string): Identity {
  const row = (value ?? {}) as Reply;
  if (
    row.lex !== dir ||
    row.real !== dir ||
    !['dev', 'ino', 'uid'].every((k) => typeof row[k] === 'string' && DIGITS.test(row[k] as string))
  ) {
    throw new SandboxError(`回执里的目录身份不是 ${dir}`);
  }
  return { real: dir, dev: row.dev as string, ino: row.ino as string, uid: row.uid as string };
}

export function scopeSandbox(o: ScopeSandboxOptions = {}): WorkerSandbox {
  return {
    async adopt(dir) {
      if (!dir.startsWith('/') || CONTROL_CHAR.test(dir))
        throw new SandboxError(`目录要写绝对路径、不带控制字符：${dir}`);
      const r = await invoke(o, ['adopt', dir, '--user', SESSION_USER]);
      if (r.state !== 'adopted') throw new SandboxError(`没交成：${String(r.state)}`);
      const id = identity(r.identity, dir);
      return {
        async release() {
          const d = await invoke(o, ['remove', id.real, '--dev', id.dev, '--ino', id.ino, '--uid', id.uid]);
          const back = identity(d.identity, dir);
          if (back.dev !== id.dev || back.ino !== id.ino || back.uid !== id.uid) {
            throw new SandboxError('删除回执不是原来交出去的目录');
          }
          if (
            d.state !== 'removed' ||
            typeof d.transaction !== 'string' ||
            !/^[a-f0-9]{64}$/.test(d.transaction)
          ) {
            throw new SandboxError(`没删成：${String(d.state)}`);
          }
        },
      };
    },
    async stop(runId) {
      const id = `${SHADOW_SCOPE_PREFIX}${runId}`;
      if (!SCOPE_ID.test(id)) throw new SandboxError(`scope 编号不合法：${id}`);
      await exec(o, ['stop', id]);
    },
  };
}
