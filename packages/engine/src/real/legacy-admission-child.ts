// 独立单次入口，尚未接生产。父 SIGKILL/退出核验是主合同；本机 watchdog 只防父丢失。
import { createDb } from '@fleet-dao/db';
import { createPgStore } from '@fleet-dao/store';
import {
  LEGACY_ADMISSION_TOTAL_MS,
  LEGACY_REQUEST_MAX_BYTES,
  LEGACY_RESULT_MAX_BYTES,
  LegacyFrameReader,
  LegacyRequestSchema,
  LegacyResponseSchema,
  type LegacySqlOutcome,
  legacyFrame,
} from './legacy-admission-protocol.ts';

async function main(): Promise<void> {
  // 收到请求前也不能无限等 stdin。父只启动这个固定入口，不启动引擎、job或后代进程。
  const hardExit = () => process.exit(70);
  let watchdog = setTimeout(hardExit, LEGACY_ADMISSION_TOTAL_MS);
  process.stdout.on('error', hardExit);
  const reader = new LegacyFrameReader(LEGACY_REQUEST_MAX_BYTES);
  let raw: unknown;
  try {
    for await (const chunk of process.stdin) reader.push(Buffer.from(chunk));
    raw = reader.finish();
  } catch {
    clearTimeout(watchdog);
    process.exitCode = 65;
    return;
  }
  const parsed = LegacyRequestSchema.safeParse(raw);
  if (!parsed.success) {
    clearTimeout(watchdog);
    process.exitCode = 65;
    return;
  }
  const request = parsed.data;
  // 父发来的剩余期限只可缩短这次独立宿主寿命，不能延长默认硬上限。
  clearTimeout(watchdog);
  const remaining = Math.min(LEGACY_ADMISSION_TOTAL_MS, request.budgetMs, request.killAt - Date.now());
  if (remaining <= 0) {
    process.exitCode = 70;
    return;
  }
  watchdog = setTimeout(hardExit, remaining);
  const childDeadline = performance.now() + remaining;
  let result: LegacySqlOutcome;
  let connection: ReturnType<typeof createDb> | undefined;
  try {
    connection = createDb({ url: request.databaseUrl, max: 1 });
    result = await connection.db.transaction(async (tx) => {
      // 固定 SQL + 有界整数；在事务中 SET LOCAL，连接串 statement_timeout=0 不能覆盖它。
      // 这是单语句/锁/空闲的服务端兜底；不能冒称事务总期限，硬期限由父单独强制。
      const ms = Math.max(1, Math.min(4_000, Math.floor(childDeadline - performance.now())));
      await tx.execute(`set local statement_timeout = ${ms}`);
      await tx.execute(`set local lock_timeout = ${Math.min(1_000, ms)}`);
      await tx.execute(`set local idle_in_transaction_session_timeout = ${ms}`);
      // 复用 Store 原业务判定和审计事务，不复制；内层事务由Drizzle保存点管理。
      const admitted = await createPgStore(tx).admitLegacyExecution(request.input, request.audit);
      if (admitted.kind === 'rejected') return { kind: 'denied', code: admitted.reason };
      return {
        kind: 'allowed',
        status: admitted.kind,
        admissionId: admitted.admission.id,
        postCommitWarnings: admitted.postCommitWarnings,
      };
    });
  } catch {
    // 连接串、SQL参数、原始异常和canonical都不进入stderr/结果。
    result = { kind: 'unknown', code: 'store_unavailable' };
  }
  try {
    if (connection) await connection.close();
  } catch {
    result = { kind: 'unknown', code: 'store_unavailable' };
  }
  if (performance.now() >= childDeadline) {
    process.exitCode = 70;
    return;
  }
  const response = LegacyResponseSchema.safeParse({ version: 1, id: request.id, result });
  if (!response.success) {
    process.exitCode = 65;
    return;
  }
  const frame = legacyFrame(response.data, LEGACY_RESULT_MAX_BYTES);
  // close/COMMIT全结束才输出；父还须核 exit0+所有管道close，不因本帧提前允许。
  await new Promise<void>((resolve, reject) =>
    process.stdout.end(frame, (error?: Error | null) => (error ? reject(error) : resolve())),
  );
  clearTimeout(watchdog);
}

// 仅固定、脱敏的退出码。未捕获的驱动事件仍按 Node 默认行为使这个独立宿主非0终止。
await main().catch(() => {
  process.exitCode = 70;
});
