// 进度：会话输出的每个事件进来（onEvent，顺手更新停滞判断要用的状态）、攒一小批写库（flush / scheduleFlush，写不进去先放回去、
// 攒太多记下丢了几条）、会话里顺带读到的额度记账（onRateLimit）。从 sessions.ts 拆出来，函数体原样。

import type { LineMeta, PlanPayload, RateLimitReading, ToolPayload } from '@fleet-dao/adapters';
import { readingsFromRateLimit } from '@fleet-dao/adapters/quota';
import { appendProgressEvents, savePoolQuota } from '@fleet-dao/db';
import type { ProgressEvent } from '@fleet-dao/shared';
import type { Live } from './session-live.ts';
import type { SessionShared } from './session-types.ts';
import { errorText } from './session-util.ts';

const STEP_RANK: Record<string, number> = { pending: 0, in_progress: 1, done: 2 };
const PENDING_MAX = 5_000;
const RECENT_TOOLS = 30;
const SAYS_KEPT = 12;

/**
 * 这一批进库后能确认到输出的哪一行：批里最大的序号；下一批的头一条还是同一行（一行的事件被 500 条一批切开了）就只确认到
 * 上一行——接回时从没确认的那一行起整行重放，不丢那一行剩下的事件。没有序号（走管道）、确认不到任何一行回 undefined。
 */
export function confirmedSeq(
  batch: readonly { seq: number | undefined }[],
  nextSeq: number | undefined,
): number | undefined {
  const seqs = batch.map((b) => b.seq).filter((n): n is number => n !== undefined);
  if (seqs.length === 0) return undefined;
  const top = Math.max(...seqs);
  const seq = nextSeq === top ? top - 1 : top;
  return seq >= 0 ? seq : undefined;
}

export function createProgress(shared: SessionShared) {
  const { db, clock, flushMs } = shared;

  const flush = (live: Live): Promise<void> => {
    live.flushing = live.flushing.then(async () => {
      while (live.pending.length > 0) {
        const batch = live.pending.splice(0, 500);
        const confirmed = confirmedSeq(batch, live.pending[0]?.seq);
        try {
          const r = await appendProgressEvents(
            db,
            live.runId,
            batch.map(({ event: e }) => ({ at: new Date(e.at), kind: e.kind, payload: e.payload })),
            confirmed === undefined ? {} : { outputSeq: confirmed },
          );
          if (r === 'run_not_found') {
            live.writeError ??= `库里没有会话 ${live.runId}，进度写不进去`;
            return;
          }
        } catch (error) {
          live.writeError ??= errorText(error);
          // 写不进去先放回去，下一轮再写；攒太多就丢最老的，记下丢了几条（不静默）。
          live.pending.unshift(...batch);
          if (live.pending.length > PENDING_MAX) {
            const drop = live.pending.length - PENDING_MAX;
            live.pending.splice(0, drop);
            live.dropped += drop;
          }
          return;
        }
      }
    });
    return live.flushing;
  };

  const scheduleFlush = (live: Live) => {
    if (live.flushTimer) return;
    live.flushTimer = setTimeout(() => {
      live.flushTimer = undefined;
      void flush(live);
    }, flushMs);
  };

  /** meta.replay = 接回时重读的、上一个引擎已经处理过的行：只重建状态（停滞判断要用），不再进库。 */
  const onEvent = (live: Live, event: ProgressEvent, meta?: LineMeta) => {
    const at = Date.parse(event.at);
    const when = Number.isNaN(at) ? clock().getTime() : at;
    live.lastEventAt = when;
    const payload = event.payload as Record<string, unknown> | null;
    if (event.kind === 'tool' && payload) {
      const tool = payload as unknown as ToolPayload;
      if (tool.phase === 'start') {
        live.tools.set(tool.toolUseId, { name: tool.name, since: when });
        live.recent.push({ name: tool.name, summary: tool.summary, action: tool.action });
        if (live.recent.length > RECENT_TOOLS) live.recent.shift();
      } else {
        live.tools.delete(tool.toolUseId);
      }
    } else if (event.kind === 'file') {
      live.lastFileAt = when;
    } else if (event.kind === 'plan' && payload) {
      const steps = (payload as unknown as PlanPayload).steps ?? [];
      const advanced = steps.some(
        (s) => (STEP_RANK[s.state] ?? 0) > (STEP_RANK[live.plan.get(s.title) ?? 'pending'] ?? 0),
      );
      if (advanced) live.lastStepAt = when;
      live.plan = new Map(steps.map((s) => [s.title, s.state]));
    } else if (event.kind === 'say' && typeof payload?.text === 'string') {
      live.says.push(payload.text);
      if (live.says.length > SAYS_KEPT) live.says.shift();
    }
    if (meta?.replay) return;
    live.pending.push({ event, seq: meta?.seq });
    scheduleFlush(live);
  };

  const onRateLimit = (live: Live, reading: RateLimitReading) => {
    const windows = readingsFromRateLimit(reading, { poolId: live.poolId });
    if (!windows?.length) return;
    // 会话里顺带读到的只是几个窗口：complete=false，不标别的窗口过期、不算一次读成。
    void savePoolQuota(db, {
      poolId: live.poolId,
      readAt: reading.observedAt,
      complete: false,
      windows,
    }).catch((error: unknown) => {
      live.quotaError ??= errorText(error);
    });
  };

  return { flush, onEvent, onRateLimit };
}
