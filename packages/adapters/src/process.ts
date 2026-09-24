// 起一个无头执行体进程：提示词从 stdin 喂完立即关，stdout 按行交给解析方；超时、停滞、叫停时连同子孙进程一起杀。
// 进程退出后把同一进程组里没退的也杀掉：谁起的谁回收，不留孤儿占树（旧系统池化进程占树 6.5 小时）。
import { spawn, spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { LineSplitter } from './lines.ts';
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
  /** 可执行文件（建议绝对路径）加参数；资源记账的包装（systemd-run）也在这里。 */
  command: string[];
  cwd: string;
  /** 整份环境，不再合并宿主的环境。 */
  env: Record<string, string>;
  /** 喂给 stdin 的内容，写完就关。管道不关的话执行体会一直等输入。 */
  stdin: string;
  limits: ProcessLimits;
  signal?: AbortSignal;
}

export interface ProcessControl {
  /** 解析方认定「在干活」时调用，停滞计时从这里重来。 */
  touch(): void;
  kill(reason: KillReason): void;
}

export interface AgentProcessHooks {
  onLine(line: string, control: ProcessControl): void;
  /** 有工具正在跑（比如一轮测试跑十几分钟）时返回 true，这段时间不算停滞。 */
  busy?(): boolean;
}

export interface AgentProcessResult {
  exitCode: number | null;
  signal: string | null;
  killed?: { reason: KillReason; at: string };
  spawnError?: string;
  /** 进程退了，进程组里却还有活着的（已被杀掉）。 */
  stragglers: boolean;
  /** stderr 最后 16KB，只做诊断，不拿它判成败。 */
  stderrTail: string;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  /** 起进程到第一行 stdout 的毫秒数；一行都没有就不给。 */
  firstLineMs?: number;
  lines: number;
  droppedLines: number;
  /** 解析方抛的第一个异常（解析继续）。 */
  hookError?: string;
}

const STDERR_TAIL = 16 * 1024;

/** 把会话放进 systemd 的一个 scope（挂在资源池 slice 下）做资源记账和限额。起它的用户要有建 scope 的权限。 */
export interface CgroupScope {
  /** 例如 fleet-agents.slice。 */
  slice: string;
  /** scope 名，例如 fleet-run-<会话编号>；会话结束后可以按它查用量。 */
  unit: string;
  /** 用用户级 systemd（systemctl --user）而不是系统级。 */
  user?: boolean;
}

const UNIT_NAME = /^[A-Za-z0-9:_.\\-]+$/;

/** systemd-run --scope 会 exec 目标命令：进程号、stdin/stdout 都不变，杀进程组的办法照样管用。 */
export function scopePrefix(scope: CgroupScope): string[] {
  if (!UNIT_NAME.test(scope.slice) || !UNIT_NAME.test(scope.unit)) {
    throw new Error(`systemd 单元名不合法：${scope.slice} / ${scope.unit}`);
  }
  return [
    'systemd-run',
    ...(scope.user ? ['--user'] : []),
    '--scope',
    '--quiet',
    '--collect',
    `--slice=${scope.slice}`,
    `--unit=${scope.unit}`,
    '--',
  ];
}

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

export function runAgentProcess(
  spec: AgentProcessSpec,
  hooks: AgentProcessHooks,
  now: () => Date = () => new Date(),
): Promise<AgentProcessResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const startedAt = now().toISOString();
    const splitter = new LineSplitter();
    let stderrTail = '';
    let lines = 0;
    let firstLineMs: number | undefined;
    let lastActivity = t0;
    let killed: AgentProcessResult['killed'];
    let hookError: string | undefined;
    let exitInfo: { code: number | null; signal: string | null } | undefined;
    let stragglers = false;
    let finished = false;
    const timers: NodeJS.Timeout[] = [];

    const finish = (extra: Partial<AgentProcessResult> = {}) => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      spec.signal?.removeEventListener('abort', onAbort);
      for (const line of splitter.end()) handleLine(line);
      const end = Date.now();
      resolve({
        exitCode: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        ...(killed ? { killed } : {}),
        stragglers,
        stderrTail,
        startedAt,
        endedAt: now().toISOString(),
        wallMs: end - t0,
        ...(firstLineMs === undefined ? {} : { firstLineMs }),
        lines,
        droppedLines: splitter.dropped,
        ...(hookError === undefined ? {} : { hookError }),
        ...extra,
      });
    };

    const control: ProcessControl = {
      touch: () => {
        lastActivity = Date.now();
      },
      kill: (reason) => {
        if (killed || exitInfo || finished) return;
        killed = { reason, at: now().toISOString() };
        signalTree('SIGTERM');
        timers.push(setTimeout(() => signalTree('SIGKILL'), spec.limits.killGraceMs));
      },
    };
    const onAbort = () => control.kill('aborted');

    if (spec.signal?.aborted) {
      killed = { reason: 'aborted', at: now().toISOString() };
      finish();
      return;
    }

    const [bin, ...args] = spec.command;
    if (!bin) {
      finish({ spawnError: '没有给命令' });
      return;
    }
    const child = spawn(bin, args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 自成一个进程组，杀的时候连子孙一起杀
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    function signalTree(sig: NodeJS.Signals): boolean {
      const pid = child.pid;
      if (pid === undefined) return false;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return true;
      }
      try {
        process.kill(-pid, sig);
        return true;
      } catch {
        return false;
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
        hookError ??= err instanceof Error ? err.message : String(err);
      }
    }

    child.on('error', (err) => {
      if (child.pid === undefined) finish({ spawnError: err.message });
    });
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
      // 主进程退了，组里还活着的一律收掉；它们握着 stdout 的话 close 永远等不来
      if (process.platform !== 'win32') stragglers = signalTree('SIGKILL');
      timers.push(setTimeout(() => finish(), 2_000));
    });
    child.on('close', () => finish());

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
