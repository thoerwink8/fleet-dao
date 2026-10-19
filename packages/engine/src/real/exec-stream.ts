import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { UserCommand, UserCommandResult } from './exec.ts';

/** 仅快照专用流使用；普通 UserExec 的 110MiB 界不变。包含帧头在内。 */
export const SNAPSHOT_STREAM_BYTES = 1024 * 1024 * 1024;

export async function runBoundedStream(
  plan: { command: string; args: string[]; cwd: string; env: Record<string, string> },
  command: UserCommand,
  stop: (() => Promise<unknown>) | undefined,
  settleMs: number,
): Promise<UserCommandResult> {
  const stream = command.snapshotStream;
  if (!stream || command.stdin) throw new Error('快照流不能与整包标准输入同时使用');
  const controller = new AbortController();
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: 'pipe' });
  let stderr = '';
  let timedOut = false;
  let aborted = false;
  let failed = false;
  let spawnError: string | undefined;
  let stopDeadlineMs: number | undefined;
  let stopPromise: Promise<unknown> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let forceSettle: (() => void) | undefined;
  const forced = new Promise<void>((resolve) => {
    forceSettle = resolve;
  });
  const fail = (reason: string) => {
    if (failed) return;
    failed = true;
    stopDeadlineMs = Date.now() + settleMs;
    stderr = `${stderr}\n${reason}`.slice(-4000);
    controller.abort();
    child.stdin.destroy();
    child.stdout.destroy();
    child.kill('SIGKILL');
    stopPromise = stop?.().catch(() => undefined);
    settleTimer = setTimeout(() => {
      child.stderr.destroy();
      stderr = `${stderr}\n流停止后管道或读写未在收尾时限内结束`.slice(-4000);
      forceSettle?.();
    }, settleMs);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    fail('快照流超时被停');
  }, command.timeoutMs);
  const onAbort = () => {
    aborted = true;
    fail('快照流被叫停');
  };
  command.signal?.addEventListener('abort', onAbort);
  if (command.signal?.aborted) onAbort();
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    try {
      command.onOutput?.(chunk);
    } catch {
      /* 观察者不影响命令。 */
    }
  });
  // 管道错误由 pump 与退出状态统一判失败，避免未处理的 error 事件。
  child.stdin.on('error', (error) => fail(`快照输入失败：${error.message}`));
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      spawnError = error.message;
      fail(`快照进程没起来：${error.message}`);
    });
    child.once('close', resolve);
  });
  const pumpInput = async () => {
    let bytes = 0;
    try {
      for await (const chunk of stream.input ?? []) {
        controller.signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > SNAPSHOT_STREAM_BYTES) throw new Error('快照输入超过 1GiB');
        if (!child.stdin.write(chunk)) await once(child.stdin, 'drain', { signal: controller.signal });
      }
      controller.signal.throwIfAborted();
      child.stdin.end();
    } catch (error) {
      fail(`快照输入未完成：${String(error)}`);
    }
  };
  const pumpOutput = async () => {
    let bytes = 0;
    try {
      for await (const value of child.stdout) {
        const chunk = value as Buffer;
        controller.signal.throwIfAborted();
        bytes += chunk.length;
        // verify/inspect 的小 JSON 仍保持普通界；只有显式 sink 才可收大帧。
        if (bytes > (stream.output ? SNAPSHOT_STREAM_BYTES : 110 * 1024 * 1024)) {
          throw new Error('快照输出超过受限流预算');
        }
        if (!stream.output) throw new Error('快照流缺少输出消费者');
        try {
          command.onOutput?.(chunk);
        } catch {
          /* 观察者不影响命令。 */
        }
        await stream.output(chunk, controller.signal);
      }
    } catch (error) {
      fail(`快照输出未完成：${String(error)}`);
    }
  };
  let code: number | null = null;
  try {
    const completed = Promise.all([closed, pumpInput(), pumpOutput()]).then(async ([result]) => {
      await stopPromise;
      code = result;
    });
    await Promise.race([completed, forced]);
    return {
      code: failed ? null : code,
      stdout: Buffer.alloc(0),
      stderr,
      timedOut,
      aborted,
      ...(spawnError ? { spawnError } : {}),
      ...(stopDeadlineMs ? { stopDeadlineMs } : {}),
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(settleTimer);
    command.signal?.removeEventListener('abort', onAbort);
  }
}
