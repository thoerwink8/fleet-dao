// 起一个执行体进程（新内核所有子进程只走这一个起法，旧坑 A5）：提示词从 stdin 喂完就关，stdout 按行判帧。
// 从旧 adapters/src/process.ts 复制改写，按旧坑改了四处：
// - 起步看实质事件，不看第一行（A1）：只吐「Syncing config…」或 init 不算起来；
// - 截止是上层给的绝对时刻（A2、A4）：到点的原因写「总时限 N 用完、停在哪一步」，外层同时叫停也不盖掉它；
// - init 里的会话号交给调用方登记，续会话时对不上就判冲突、停掉这一个（A3）；
// - 输出、stderr 一律过脱敏器再交出去（H1）。
import { spawn } from 'node:child_process';
import { type Budget, fmtMs } from './budget.ts';
import { classifyClaudeLine, type Frame } from './frames.ts';
import { LineSplitter } from './lines.ts';
import { type ProcSnapshot, RUN_MARKER_KEY, reapSession, sessionSnapshot, signalSnapshot } from './procs.ts';
import type { Redactor } from './redact.ts';
import { stopCauseOf } from './stop-reason.ts';

export type KillReason = 'no_progress' | 'deadline' | 'idle' | 'aborted' | 'session_conflict';

export interface RunSpec {
  /** 可执行文件（建议绝对路径）加参数。 */
  command: string[];
  cwd: string;
  /** 整份环境，不合并宿主的；这里再加上会话标记。 */
  env: Record<string, string>;
  stdin: string;
  /** 会话编号：写进环境当标记（FLEET_RUN_ID），收尸时按它认出脱离了进程组的子孙。 */
  runId: string;
  budget: Budget;
  /** 这一层的绝对截止时刻（budget.ts 的 deriveDeadline 算）。 */
  deadline: Date;
  /** 续会话时给：init 帧里的会话号对不上就判冲突（A3）。 */
  expectSessionId?: string;
  /** 换壳时换判帧的函数；默认 Claude Code 的 stream-json。 */
  classify?: (line: string) => Frame;
  redact: Redactor;
  signal?: AbortSignal;
}

export interface RunHooks {
  /** 每一帧；line 已脱敏。 */
  onFrame?(frame: Frame, line: string): void;
  /** init 帧带出会话号时：调用方先登记再往下走（A3 按它对账接回）。 */
  onSession?(sessionId: string): void;
  onSpawn?(info: { pid: number; runId: string; startedAt: string }): void;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  killed?: { reason: KillReason; detail: string; at: string };
  sessionId?: string;
  /** 最后一个实质事件是哪一步；一个都没有就是最后一帧的。 */
  lastStep: string;
  /** 起进程到第一个实质事件的毫秒数。 */
  firstProgressMs?: number;
  lines: number;
  droppedLines: number;
  /** stderr 最后 16KB，已脱敏，只做诊断。 */
  stderrTail: string;
  /** 会话收尸前还活着的进程数、收完还剩的（undefined = 没查成，Windows 本机没有 /proc）。 */
  stragglers: number;
  leftovers: number | undefined;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  spawnError?: string;
  hookError?: string;
}

const STDERR_TAIL = 16 * 1024;

export function runProcess(spec: RunSpec, hooks: RunHooks = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    const classify = spec.classify ?? classifyClaudeLine;
    const posix = process.platform !== 'win32';
    const splitter = new LineSplitter();
    const timers: NodeJS.Timeout[] = [];
    let stderrTail = '';
    let lines = 0;
    let lastStep = '还没有输出';
    let firstProgressMs: number | undefined;
    let lastProgress = t0;
    let toolsInFlight = 0;
    let sessionId: string | undefined;
    let killed: RunResult['killed'];
    let hookError: string | undefined;
    let exitInfo: { code: number | null; signal: string | null } | undefined;
    let reaped: { found: number; leftovers: number | undefined } | undefined;
    let closed = false;
    let finished = false;
    let snapshot: ProcSnapshot = new Map();
    const record = (err: unknown) => {
      hookError ??= spec.redact(err instanceof Error ? err.message : String(err));
    };

    const finish = (extra: Partial<RunResult> = {}) => {
      if (finished) return;
      finished = true;
      for (const t of timers) clearTimeout(t);
      spec.signal?.removeEventListener('abort', onAbort);
      for (const line of splitter.end()) handleLine(line);
      resolve({
        exitCode: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        ...(killed ? { killed } : {}),
        ...(sessionId ? { sessionId } : {}),
        lastStep,
        ...(firstProgressMs === undefined ? {} : { firstProgressMs }),
        lines,
        droppedLines: splitter.dropped,
        stderrTail: spec.redact(stderrTail),
        stragglers: reaped?.found ?? 0,
        leftovers: reaped?.leftovers,
        startedAt,
        endedAt: new Date().toISOString(),
        wallMs: Date.now() - t0,
        ...(hookError === undefined ? {} : { hookError }),
        ...extra,
      });
    };
    const maybeFinish = () => {
      if (exitInfo && reaped && closed) finish();
    };

    /** 第一个叫停的原因作数，后来的不盖掉它。 */
    const kill = (reason: KillReason, detail: string) => {
      if (killed || exitInfo || finished) return;
      killed = { reason, detail: spec.redact(detail), at: new Date().toISOString() };
      if (child?.pid !== undefined) snapshot = sessionSnapshot(spec.runId, child.pid);
      terminate('SIGTERM');
      timers.push(setTimeout(() => terminate('SIGKILL'), spec.budget.killGraceMs));
    };
    const deadlineDetail = () => `总时限 ${fmtMs(spec.deadline.getTime() - t0)}用完、停在「${lastStep}」`;
    const onAbort = () => {
      // 外层到点和本层到点同时发生时，原因写时限，不写「被叫停」（A2）
      if (Date.now() >= spec.deadline.getTime()) return kill('deadline', deadlineDetail());
      const cause = stopCauseOf(spec.signal?.reason);
      kill('aborted', cause ? `被叫停（${cause.kind}）：${cause.detail}` : '被叫停');
    };

    if (spec.signal?.aborted) {
      killed = { reason: 'aborted', detail: '还没起就被叫停', at: startedAt };
      reaped = { found: 0, leftovers: 0 };
      finish();
      return;
    }
    if (Date.now() >= spec.deadline.getTime()) {
      killed = { reason: 'deadline', detail: '起之前截止时刻已经过了', at: startedAt };
      reaped = { found: 0, leftovers: 0 };
      finish();
      return;
    }
    const [bin, ...args] = spec.command;
    if (!bin) {
      reaped = { found: 0, leftovers: 0 };
      finish({ spawnError: '没有给命令' });
      return;
    }

    const child = spawn(bin, args, {
      cwd: spec.cwd,
      env: { ...spec.env, [RUN_MARKER_KEY]: spec.runId },
      stdio: ['pipe', 'pipe', 'pipe'],
      // 自成一个进程组；脱离了组的子孙靠会话标记另外认
      detached: posix,
      windowsHide: true,
    });

    function terminate(sig: NodeJS.Signals) {
      const pid = child.pid;
      if (pid === undefined) return;
      if (!posix) {
        // Windows 只在本机跑测试：整棵树一起杀，异步起（A5 禁同步起子进程，会卡住整个内核）
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
          'error',
          () => {},
        );
        return;
      }
      signalSnapshot(new Map([...snapshot, ...sessionSnapshot(spec.runId, pid)]), sig);
      try {
        process.kill(-pid, sig);
      } catch {
        // 组已经空了
      }
    }

    function handleLine(raw: string) {
      lines++;
      const line = spec.redact(raw);
      let frame: Frame;
      try {
        frame = classify(raw);
      } catch (err) {
        record(err);
        return;
      }
      if (frame.sessionId && !sessionId) {
        sessionId = frame.sessionId;
        if (spec.expectSessionId && frame.sessionId !== spec.expectSessionId) {
          kill(
            'session_conflict',
            `续的是会话 ${spec.expectSessionId}，起来的却是 ${frame.sessionId}：停掉后起的这个`,
          );
        } else {
          try {
            hooks.onSession?.(frame.sessionId);
          } catch (err) {
            record(err);
          }
        }
      }
      toolsInFlight = Math.max(0, toolsInFlight + frame.toolsOpened - frame.toolsClosed);
      if (frame.substantive) {
        lastProgress = Date.now();
        lastStep = frame.step;
        firstProgressMs ??= lastProgress - t0;
      } else if (firstProgressMs === undefined && frame.step) {
        lastStep = frame.step;
      }
      try {
        hooks.onFrame?.(frame, line);
      } catch (err) {
        record(err);
      }
    }

    child.on('error', (err) => {
      if (child.pid === undefined) {
        reaped = { found: 0, leftovers: 0 };
        finish({ spawnError: spec.redact(err.message) });
      }
    });
    if (child.pid !== undefined) {
      try {
        hooks.onSpawn?.({ pid: child.pid, runId: spec.runId, startedAt });
      } catch (err) {
        record(err);
      }
    }
    child.stdin.on('error', () => {
      // 执行体提前退出时写 stdin 会 EPIPE，结果以退出码和输出为准
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
      // 执行体退了：会话里还活着的一律收掉；它们握着 stdout 的话 close 永远等不来
      void reapSession(spec.runId, spec.budget.killGraceMs, snapshot).then(
        (r) => {
          reaped = r;
          timers.push(setTimeout(() => finish(), 2_000));
          maybeFinish();
        },
        (err: unknown) => {
          reaped = { found: 0, leftovers: undefined };
          record(err);
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
        if (firstProgressMs === undefined) {
          kill('no_progress', `起来 ${fmtMs(spec.budget.startupMs)} 内没有实质事件，停在「${lastStep}」`);
        }
      }, spec.budget.startupMs),
      setTimeout(() => kill('deadline', deadlineDetail()), spec.deadline.getTime() - t0),
    );
    const idleMs = spec.budget.idleMs;
    if (idleMs !== undefined) {
      const every = Math.max(20, Math.min(1_000, Math.floor(idleMs / 5)));
      // clearTimeout 也能停 setInterval，所以和别的定时器放一起收
      timers.push(
        setInterval(() => {
          if (firstProgressMs !== undefined && toolsInFlight === 0 && Date.now() - lastProgress > idleMs) {
            kill('idle', `没有工具在跑、${fmtMs(idleMs)} 没有实质事件，停在「${lastStep}」`);
          }
        }, every),
      );
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
