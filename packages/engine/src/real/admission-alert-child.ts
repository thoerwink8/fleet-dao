// 固定单次入口；只接受record/transferOne，不提供任意模块、SQL或caller ACK。
import {
  ALERT_FRAME_BYTES,
  ALERT_TOTAL_MS,
  type AlertOutcome,
  AlertRequestSchema,
  AlertResponseSchema,
} from './admission-alert-protocol.ts';
import { recordAdmissionAlert, transferOneAdmissionAlert } from './admission-alert-spool.ts';
import { LegacyFrameReader, legacyFrame } from './legacy-admission-protocol.ts';

async function main(): Promise<void> {
  process.umask(0o077);
  const hardExit = () => process.exit(70);
  let watchdog = setTimeout(hardExit, ALERT_TOTAL_MS);
  process.stdout.on('error', hardExit);
  const reader = new LegacyFrameReader(ALERT_FRAME_BYTES);
  let raw: unknown;
  try {
    for await (const chunk of process.stdin) reader.push(Buffer.from(chunk));
    raw = reader.finish();
  } catch {
    clearTimeout(watchdog);
    process.exitCode = 65;
    return;
  }
  const parsed = AlertRequestSchema.safeParse(raw);
  if (!parsed.success) {
    clearTimeout(watchdog);
    process.exitCode = 65;
    return;
  }
  const r = parsed.data;
  clearTimeout(watchdog);
  const remaining = Math.min(ALERT_TOTAL_MS, r.budgetMs, r.killAt - Date.now());
  if (remaining <= 0) {
    process.exitCode = 70;
    return;
  }
  watchdog = setTimeout(hardExit, remaining);
  const deadlineAt = performance.now() + remaining;
  const result: AlertOutcome =
    r.operation === 'record'
      ? recordAdmissionAlert(r.spoolPath, r.observation)
      : await transferOneAdmissionAlert(r.spoolPath, r.databaseUrl, deadlineAt);
  if (performance.now() >= deadlineAt) {
    process.exitCode = 70;
    return;
  }
  const response = AlertResponseSchema.parse({ version: 1, id: r.id, result });
  await new Promise<void>((resolve, reject) =>
    process.stdout.end(legacyFrame(response, ALERT_FRAME_BYTES), (e?: Error | null) =>
      e ? reject(e) : resolve(),
    ),
  );
  clearTimeout(watchdog);
}
await main().catch(() => {
  process.exitCode = 70;
});
