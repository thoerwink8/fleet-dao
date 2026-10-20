// 未接生产的有界SQL宿主；一个长期coordinator持有容量与未核清的退出责任。
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  type BoundedLegacyAdmission,
  LEGACY_ADMISSION_CLEANUP_MS,
  LEGACY_ADMISSION_TOTAL_MS,
  LEGACY_REQUEST_MAX_BYTES,
  LEGACY_RESULT_MAX_BYTES,
  LegacyFrameReader,
  LegacyRequestSchema,
  LegacyResponseSchema,
  type LegacySqlOutcome,
  type LegacySqlUnknownCode,
  legacyFrame,
} from './legacy-admission-protocol.ts';

type Launch = (entry: string) => ChildProcess;
interface ProcessDeps {
  launch?: Launch;
}
const unknown = (code: LegacySqlUnknownCode): LegacySqlOutcome => ({ kind: 'unknown', code });
const entry = fileURLToPath(new URL('./legacy-admission-child.ts', import.meta.url));

function launchChild(path: string): ChildProcess {
  // 不继承 NODE_OPTIONS/preload/PG*；数据库配置仅从stdin的一次性封闭DTO发送。
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return spawn(process.execPath, [path], {
    env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

export function createBoundedLegacyAdmission(
  options: { databaseUrl: string },
  // 只供可信宿主/测试注入；单次调用不能选择入口、URL、env或执行器。
  deps: ProcessDeps = {},
): { admit: BoundedLegacyAdmission; status(): { active: number; cleanupPending: number } } {
  if (!options.databaseUrl || Buffer.byteLength(options.databaseUrl) > 16 * 1024)
    throw new Error('legacy SQL配置无效');
  const databaseUrl = options.databaseUrl;
  const launch = deps.launch ?? launchChild;
  const slots = new Set<{ returned: boolean }>();
  const admit: BoundedLegacyAdmission = async (input, audit, call) => {
    if (call.signal.aborted) return unknown('cancelled');
    const now = performance.now();
    // caller只能缩短总预算；来源适配器在History之前固定的deadline必须原样传入。
    const deadlineAt = Math.min(call.deadlineAt, now + LEGACY_ADMISSION_TOTAL_MS);
    const killAt = deadlineAt - LEGACY_ADMISSION_CLEANUP_MS;
    if (!Number.isFinite(deadlineAt) || now >= killAt) return unknown('deadline');
    if (slots.size !== 0) return unknown('capacity');
    const id = randomUUID();
    let frame: Buffer;
    try {
      const budgetMs = Math.max(1, Math.floor(killAt - performance.now()));
      const request = LegacyRequestSchema.safeParse({
        version: 1,
        id,
        databaseUrl,
        killAt: Date.now() + budgetMs,
        budgetMs,
        input,
        audit,
      });
      if (!request.success) return unknown('input_limit');
      frame = legacyFrame(request.data, LEGACY_REQUEST_MAX_BYTES);
    } catch {
      return unknown('input_limit');
    }
    if (call.signal.aborted) return unknown('cancelled');
    if (performance.now() >= killAt) return unknown('deadline');
    const slot = { returned: false };
    slots.add(slot);
    return new Promise<LegacySqlOutcome>((resolve) => {
      let child: ChildProcess;
      let terminal: LegacySqlOutcome | undefined;
      let completed = false,
        exited = false,
        closed = false,
        stdoutEnded = false;
      let exitCode: number | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const reader = new LegacyFrameReader(LEGACY_RESULT_MAX_BYTES);
      const releaseIfClosed = () => {
        if (closed && (exited || child.pid === undefined)) slots.delete(slot);
      };
      const finish = (result: LegacySqlOutcome) => {
        if (completed) return;
        completed = true;
        slot.returned = true;
        clearTimeout(killTimer);
        clearTimeout(cleanupTimer);
        call.signal.removeEventListener('abort', onAbort);
        releaseIfClosed();
        resolve(result);
      };
      const stop = (code: LegacySqlUnknownCode) => {
        if (terminal || completed) return;
        terminal = unknown(code);
        clearTimeout(killTimer);
        // 真强制终止，不能只发默认SIGTERM就把它当成退出。只有精确自建句柄。
        try {
          if (!exited && child.pid !== undefined) child.kill('SIGKILL');
        } catch {
          /* 保持unknown占槽，等真实close */
        }
        const until = Math.min(deadlineAt, performance.now() + LEGACY_ADMISSION_CLEANUP_MS);
        cleanupTimer = setTimeout(
          () => finish(unknown('cleanup_pending')),
          Math.max(0, until - performance.now()),
        );
      };
      const onAbort = () => stop('cancelled');
      try {
        child = launch(entry);
      } catch {
        slots.delete(slot);
        resolve(unknown('child_failed'));
        return;
      }
      child.once('error', () => stop('child_failed'));
      child.once('exit', (code) => {
        exited = true;
        exitCode = code;
        releaseIfClosed();
      });
      child.once('close', () => {
        closed = true;
        releaseIfClosed();
        if (completed) return;
        if (call.signal.aborted) terminal ??= unknown('cancelled');
        if (performance.now() >= killAt) terminal ??= unknown('deadline');
        if (terminal) {
          finish(terminal);
          return;
        }
        if (!exited || exitCode !== 0) {
          finish(unknown('child_failed'));
          return;
        }
        if (!stdoutEnded) {
          finish(unknown('protocol'));
          return;
        }
        try {
          const response = LegacyResponseSchema.safeParse(reader.finish());
          finish(response.success && response.data.id === id ? response.data.result : unknown('protocol'));
        } catch {
          finish(unknown('protocol'));
        }
      });
      if (!child.stdin || !child.stdout) {
        stop('child_failed');
        return;
      }
      child.stdout.on('data', (bytes: Buffer) => {
        if (terminal || completed) return;
        try {
          reader.push(bytes);
        } catch {
          stop('protocol');
        }
      });
      child.stdout.once('end', () => {
        stdoutEnded = true;
      });
      child.stdout.once('error', () => stop('protocol'));
      child.stdin.once('error', () => stop('protocol'));
      call.signal.addEventListener('abort', onAbort, { once: true });
      killTimer = setTimeout(() => stop('deadline'), Math.max(0, killAt - performance.now()));
      if (call.signal.aborted) {
        onAbort();
        return;
      }
      if (performance.now() >= killAt) {
        stop('deadline');
        return;
      }
      try {
        child.stdin.end(frame);
      } catch {
        stop('protocol');
      }
    });
  };
  return {
    admit,
    status: () => ({ active: slots.size, cleanupPending: [...slots].filter((s) => s.returned).length }),
  };
}
