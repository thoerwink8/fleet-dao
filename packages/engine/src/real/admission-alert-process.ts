// 未接生产的两槽宿主：record和transfer各一槽，PG黑洞不独占本地承接资格。
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type AdmissionAlertObservation, admissionAlertKey } from '@fleet-dao/db';
import {
  ALERT_CLEANUP_MS,
  ALERT_FRAME_BYTES,
  ALERT_TOTAL_MS,
  type AlertCallOptions,
  type AlertOutcome,
  AlertRequestSchema,
  AlertResponseSchema,
  type AlertUnknownCode,
} from './admission-alert-protocol.ts';
import { LegacyFrameReader, legacyFrame } from './legacy-admission-protocol.ts';

type Launch = (entry: string) => ChildProcess;
interface ProcessDeps {
  launch?: Launch;
}
const unknown = (code: AlertUnknownCode): AlertOutcome => ({ kind: 'unknown', code });
const entry = fileURLToPath(new URL('./admission-alert-child.ts', import.meta.url));

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

export function createAdmissionAlertSink(
  options: { spoolPath: string; databaseUrl?: string },
  // 只供可信宿主/测试注入；单次调用不能选择入口、URL、env或执行器。
  deps: ProcessDeps = {},
): {
  record(input: AdmissionAlertObservation, call: AlertCallOptions): Promise<AlertOutcome>;
  transferOne(call: AlertCallOptions): Promise<AlertOutcome>;
  status(): { active: number; cleanupPending: number };
} {
  if (!options.spoolPath || Buffer.byteLength(options.spoolPath) > 4096) throw new Error('spool配置无效');
  const spoolPath = options.spoolPath;
  const databaseUrl = options.databaseUrl;
  const launch = deps.launch ?? launchChild;
  const slots = new Map<string, { returned: boolean }>();
  const invoke = async (
    operation: 'record' | 'transferOne',
    input: AdmissionAlertObservation | undefined,
    call: AlertCallOptions,
  ): Promise<AlertOutcome> => {
    if (call.signal.aborted) return unknown('cancelled');
    const now = performance.now();
    // caller只能缩短总预算；来源适配器在History之前固定的deadline必须原样传入。
    const deadlineAt = Math.min(call.deadlineAt, now + ALERT_TOTAL_MS);
    const killAt = deadlineAt - ALERT_CLEANUP_MS;
    if (!Number.isFinite(deadlineAt) || now >= killAt) return unknown('deadline');
    if (slots.has(operation)) return unknown('capacity');
    const id = randomUUID();
    let frame: Buffer;
    let expectedKey: string | undefined;
    try {
      const budgetMs = Math.max(1, Math.floor(killAt - performance.now()));
      const request = AlertRequestSchema.safeParse({
        version: 1,
        id,
        spoolPath,
        operation,
        ...(operation === 'record' ? { observation: input } : { databaseUrl }),
        killAt: Date.now() + budgetMs,
        budgetMs,
      });
      if (!request.success) return unknown('input_limit');
      if (request.data.operation === 'record')
        expectedKey = admissionAlertKey(request.data.observation.identity);
      frame = legacyFrame(request.data, ALERT_FRAME_BYTES);
    } catch {
      return unknown('input_limit');
    }
    if (call.signal.aborted) return unknown('cancelled');
    if (performance.now() >= killAt) return unknown('deadline');
    const slot = { returned: false };
    slots.set(operation, slot);
    return new Promise<AlertOutcome>((resolve) => {
      let child: ChildProcess;
      let terminal: AlertOutcome | undefined;
      let completed = false,
        exited = false,
        closed = false,
        stdoutEnded = false;
      let exitCode: number | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const reader = new LegacyFrameReader(ALERT_FRAME_BYTES);
      const releaseIfClosed = () => {
        if (closed && (exited || child.pid === undefined)) slots.delete(operation);
      };
      const finish = (result: AlertOutcome) => {
        if (completed) return;
        completed = true;
        slot.returned = true;
        clearTimeout(killTimer);
        clearTimeout(cleanupTimer);
        call.signal.removeEventListener('abort', onAbort);
        releaseIfClosed();
        resolve(result);
      };
      const stop = (code: AlertUnknownCode) => {
        if (terminal || completed) return;
        terminal = unknown(code);
        clearTimeout(killTimer);
        // 真强制终止，不能只发默认SIGTERM就把它当成退出。只有精确自建句柄。
        try {
          if (!exited && child.pid !== undefined) child.kill('SIGKILL');
        } catch {
          /* 保持unknown占槽，等真实close */
        }
        const until = Math.min(deadlineAt, performance.now() + ALERT_CLEANUP_MS);
        cleanupTimer = setTimeout(
          () => finish(unknown('cleanup_pending')),
          Math.max(0, until - performance.now()),
        );
      };
      const onAbort = () => stop('cancelled');
      try {
        child = launch(entry);
      } catch {
        slots.delete(operation);
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
          const response = AlertResponseSchema.safeParse(reader.finish());
          const r = response.success ? response.data.result : undefined;
          const valid =
            r &&
            (r.kind === 'unknown' ||
              (operation === 'record'
                ? r.kind === 'spooled' && r.key === expectedKey
                : r.kind === 'transferred' || r.kind === 'empty'));
          finish(
            response.success && response.data.id === id && valid ? response.data.result : unknown('protocol'),
          );
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
    record: (input, call) => invoke('record', input, call),
    transferOne: (call) => invoke('transferOne', undefined, call),
    status: () => ({
      active: slots.size,
      cleanupPending: [...slots.values()].filter((s) => s.returned).length,
    }),
  };
}
