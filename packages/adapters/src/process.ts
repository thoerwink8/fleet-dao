// 起一个无头执行体进程：提示词从 stdin 喂完立即关，stdout 按行交给解析方；超时、停滞、叫停时整个会话一起杀。
// 「整个会话」= 执行体、它的子孙、它们各自的进程组、带会话标记的进程；有 systemd scope 时以 cgroup 为准。
// 执行体退出后会话里还活着的（后台服务、脱离了进程组的测试）一律收掉：谁起的谁回收，不留孤儿占树。
import { spawn, spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { LineSplitter } from './lines.ts';
import {
  type CgroupScope,
  HAS_PROC,
  killScope,
  RUN_MARKER_KEY,
  reapSession,
  scopePrefix,
  sessionProcs,
  signalProcs,
} from './procs.ts';
import type { KillReason } from './types.ts';

export interface ProcessLimits {
  /** 起进程后多久还没有第一行 stdout 就判起不来。reclaude 首跑会卡在「Syncing config…」上百秒，默认给足 180 秒。 */
  startupMs: number;
  /** 总时长上限。 */
  wallClockMs: number;
  /** 没有工具在跑、又这么久没有动静就判停滞；不给就不判。 */
  idleMs?: number;
  /** 先发 SIGTERM，过这么久还没退就 SIGKILL。 */
  killGraceMs: number;
}

export const DEFAULT_PROCESS_LIMITS: ProcessLimits = {
  startupMs: 180_000,
  wallClockMs: 2 * 60 * 60_000,
  killGraceMs: 5_000,
};

export interface AgentProcessSpec {
  /** 可执行文件（建议绝对路径）加参数。 */
  command: string[];
  cwd: string;
  /** 整份环境，不再合并宿主的环境；这里会再加上会话标记。 */
  env: Record<string, string>;
  /** 喂给 stdin 的内容，写完就关。管道不关的话执行体会一直等输入。 */
  stdin: string;
  limits: ProcessLimits;
  /** 会话编号：写进环境当标记（FLEET_RUN_ID），收尸时按它认出脱离了进程组的子孙。 */
  runId: string;
  /** 放进 systemd scope 做资源记账和收尸。起它的用户要有建 scope 的权限。 */
  scope?: CgroupScope;
  signal?: AbortSignal;
}

export interface ProcessControl {
  /** 解析方认定「在干活」时调用，停滞计时从这里重来。 */
  touch(): void;
  kill(reason: KillReason): void;
}

/** 起来之后交给引擎记下：引擎重启后按 runId / scope 调 reapSession 收掉旧会话。 */
export interface SpawnInfo {
  pid: number;
  runId: string;
  /** scope 单元全名，例如 fleet-run-x.scope。 */
  scope?: string;
  startedAt: string;
}

export interface AgentProcessHooks {
  onLine(line: string, control: ProcessControl): void;
  /** 有工具正在跑（比如一轮测试跑十几分钟）时返回 true，这段时间不算停滞。 */
  busy?(): boolean;
  onSpawn?(info: SpawnInfo): void;
}

export interface AgentProcessResult {
  exitCode: number | null;
  signal: string | null;
  killed?: { reason: KillReason; at: string };
  spawnError?: string;
  /** 执行体退出时会话里还活着、被收掉的进程数（后台服务、脱离了进程组的测试……）。 */
  stragglers: number;
  /** 收完还活着的进程数（有 scope 时按 cgroup 数）。不是 0 就是没收干净；undefined = 没查成（没有 /proc 也没有 scope）。 */
  leftovers: number | undefined;
  /** 收尸时出的错，例如 systemctl 失败。 */
  reapError?: string;
  /** stderr 最后 16KB，只做诊断，不拿它判成败。 */
  stderrTail: string;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  /** 起进程到第一行 stdout 的毫秒数；一行都没有就不给。 */
  firstLineMs?: number;
  lines: number;
  droppedLines: number;
  /** 解析方或回调抛的第一个异常（解析继续）。 */
  hookError?: string;
}

const STDERR_TAIL = 16 * 1024;

/** 各家执行体的命令名。单元测试里起它们一律拒绝：假会话泄漏出去的事故旧系统出过（14 个假会话）。 */
const REAL_AGENT_BINARIES = new Set([
  'reclaude',
  'claude',
  'codex',
  'cursor-agent',
  'grok',
  'kimi',
  'pi',
  'dsh',
]);

export function assertNotRealAgentInTests(command: readonly string[]): void {
  if (!process.env.VITEST) return;
  const bin = basename(command[0] ?? '')
    .toLowerCase()
    .replace(/\.(exe|cmd)$/, '');
  if (REAL_AGENT_BINARIES.has(bin)) {
    throw new Error(`测试里不许起真的执行体（${command[0]}）：换成假执行体，真跑放到测试之外`);
  }
}

/** 回调可能是 async 的：同步抛的、异步被拒的都接住，交给 record；返回还没落定的 Promise 供最后等齐。 */
export function guardCallback(
  fn: () => unknown,
  record: (err: unknown) => void,
): Promise<unknown> | undefined {
  try {
    const result = fn();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      return Promise.resolve(result).then(undefined, record);
    }
  } catch (err) {
    record(err);
  }
  return undefined;
}

export function runAgentProcess(
  spec: AgentProcessSpec,
  hooks: AgentProcessHooks,
  now: () => Date = () => new Date(),
): Promise<AgentProcessResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const startedAt = now().toISOString();
    const posix = process.platform !== 'win32';
    const splitter = new LineSplitter();
    let stderrTail = '';
    let lines = 0;
    let firstLineMs: number | undefined;
    let lastActivity = t0;
    let killed: AgentProcessResult['killed'];
    let hookError: string | undefined;
    let exitInfo: { code: number | null; signal: string | null } | undefined;
    let reaped: { stragglers: number; leftovers: number | undefined } | undefined;
    let closed = false;
    let finished = false;
    /** 杀之前拍下的会话进程：执行体一死，子孙就过继走了，按父子关系再也找不到。 */
    let snapshot: number[] = [];
    const timers: NodeJS.Timeout[] = [];
    const reapErrors: string[] = [];
    const record = (err: unknown) => {
      hookError ??= err instanceof Error ? err.message : String(err);
    };

    const finish = (extra: Partial<AgentProcessResult> = {}) => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      spec.signal?.removeEventListener('abort', onAbort);
      for (const line of splitter.end()) handleLine(line);
      resolve({
        exitCode: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        ...(killed ? { killed } : {}),
        stragglers: reaped?.stragglers ?? 0,
        leftovers: reaped?.leftovers,
        // 以清空为准：收干净了，中途 systemctl 报的错（scope 正在拆时的 EINVAL）不算数
        ...(reapErrors.length && reaped?.leftovers !== 0 ? { reapError: reapErrors.join('；') } : {}),
        stderrTail,
        startedAt,
        endedAt: now().toISOString(),
        wallMs: Date.now() - t0,
        ...(firstLineMs === undefined ? {} : { firstLineMs }),
        lines,
        droppedLines: splitter.dropped,
        ...(hookError === undefined ? {} : { hookError }),
        ...extra,
      });
    };
    const maybeFinish = () => {
      if (exitInfo && reaped && closed) finish();
    };

    const control: ProcessControl = {
      touch: () => {
        lastActivity = Date.now();
      },
      kill: (reason) => {
        if (killed || exitInfo || finished) return;
        killed = { reason, at: now().toISOString() };
        if (posix && HAS_PROC && child.pid !== undefined) snapshot = sessionProcs(spec.runId, child.pid);
        terminate('SIGTERM');
        timers.push(setTimeout(() => terminate('SIGKILL'), spec.limits.killGraceMs));
      },
    };
    const onAbort = () => control.kill('aborted');

    if (spec.signal?.aborted) {
      killed = { reason: 'aborted', at: now().toISOString() };
      reaped = { stragglers: 0, leftovers: 0 };
      finish();
      return;
    }

    const command = [...(spec.scope ? scopePrefix(spec.scope) : []), ...spec.command];
    const [bin, ...args] = command;
    if (!bin || spec.command.length === 0) {
      finish({ spawnError: '没有给命令' });
      return;
    }
    const child = spawn(bin, args, {
      cwd: spec.cwd,
      env: { ...spec.env, [RUN_MARKER_KEY]: spec.runId },
      stdio: ['pipe', 'pipe', 'pipe'],
      // 自成一个进程组；子孙靠 /proc 和会话标记另外认
      detached: posix,
      windowsHide: true,
    });

    function terminate(sig: NodeJS.Signals) {
      const pid = child.pid;
      if (spec.scope) {
        const err = killScope(spec.scope, sig);
        if (err) reapErrors.push(err);
      }
      if (pid === undefined) return;
      if (!posix) {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
      }
      signalProcs(new Set([...snapshot, ...sessionProcs(spec.runId, pid)]), sig);
      try {
        process.kill(-pid, sig);
      } catch {
        // 组已经空了
      }
    }

    function handleLine(line: string) {
      lines++;
      if (firstLineMs === undefined) {
        firstLineMs = Date.now() - t0;
        lastActivity = Date.now();
      }
      try {
        hooks.onLine(line, control);
      } catch (err) {
        record(err);
      }
    }

    child.on('error', (err) => {
      if (child.pid === undefined) {
        reaped = { stragglers: 0, leftovers: 0 };
        finish({ spawnError: err.message });
      }
    });
    if (child.pid !== undefined && hooks.onSpawn) {
      const info: SpawnInfo = {
        pid: child.pid,
        runId: spec.runId,
        ...(spec.scope ? { scope: `${spec.scope.unit}.scope` } : {}),
        startedAt,
      };
      guardCallback(() => hooks.onSpawn?.(info), record);
    }
    child.stdin.on('error', () => {
      // 执行体提前退出时写 stdin 会 EPIPE，结果以退出码和 stdout 为准
    });
    child.stdin.end(spec.stdin);
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of splitter.push(chunk)) handleLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      if (!posix) {
        reaped = { stragglers: 0, leftovers: undefined };
        timers.push(setTimeout(() => finish(), 2_000));
        maybeFinish();
        return;
      }
      // 执行体退了：会话里还活着的一律收掉；它们握着 stdout 的话 close 永远等不来
      void reapSession({
        runId: spec.runId,
        ...(spec.scope ? { scope: spec.scope } : {}),
        ...(child.pid === undefined ? {} : { rootPid: child.pid }),
        extra: snapshot,
        graceMs: spec.limits.killGraceMs,
      }).then(
        (r) => {
          reaped = { stragglers: r.found, leftovers: r.leftovers };
          if (r.error) reapErrors.push(r.error);
          timers.push(setTimeout(() => finish(), 2_000));
          maybeFinish();
        },
        (err: unknown) => {
          reaped = { stragglers: 0, leftovers: undefined };
          reapErrors.push(String(err));
          finish();
        },
      );
    });
    child.on('close', () => {
      closed = true;
      maybeFinish();
    });

    timers.push(
      setTimeout(() => {
        if (firstLineMs === undefined) control.kill('startup_timeout');
      }, spec.limits.startupMs),
      setTimeout(() => control.kill('wall_clock_timeout'), spec.limits.wallClockMs),
    );
    const idleMs = spec.limits.idleMs;
    if (idleMs !== undefined) {
      const every = Math.max(20, Math.min(1_000, Math.floor(idleMs / 5)));
      // clearTimeout 也能停 setInterval，所以和别的定时器放一起收
      timers.push(
        setInterval(() => {
          if (firstLineMs !== undefined && !hooks.busy?.() && Date.now() - lastActivity > idleMs) {
            control.kill('idle_timeout');
          }
        }, every),
      );
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
