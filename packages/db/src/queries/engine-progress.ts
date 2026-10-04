// 会话进度事实：读（最后一条事件、步骤推进、在等的提问、done/blocked/say）和写（引擎被动读到的进度按批追加，
// 同一事务里把输出确认到哪一行推前）。
import type { ProgressKind } from '@fleet-dao/shared';
import { and, asc, desc, eq, isNull, max, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { asks, progressEvents, sessionRuns } from '../schema/index.ts';

/** plan 的 payload 是 { steps: {title,state}[] }（AskRequest/PlanRequest 同形，没有 index 字段）。形状不对的步骤跳过。 */
function parsePlanSteps(payload: unknown): { title: string; state: string }[] {
  const raw =
    typeof payload === 'object' && payload !== null ? (payload as { steps?: unknown }).steps : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is { title: string; state: string } =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as { title?: unknown }).title === 'string' &&
      typeof (s as { state?: unknown }).state === 'string',
  );
}

function asRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null;
}

export interface RunProgressFacts {
  /** 这次会话最后一条进度事件的时刻（任何 kind）；一条都没有是 null。 */
  lastEventAt: Date | null;
  /**
   * 步骤清单最后一次「有一步变成进行中或做完」的时刻。按步骤标题比对相邻两次 plan（没有稳定的步骤编号）；
   * 缺前一次记录（含第一次 plan）时按「之前是 pending」算，所以第一次 plan 里有非 pending 的也算。
   */
  lastStepAdvanceAt: Date | null;
  lastPlan: { at: Date; steps: { title: string; state: string }[] } | null;
  /** 这次会话里还没答、会话真在等的提问（最早的那个）：带了范围的（#259，问完不等）不算。 */
  pendingAsk: { id: string; question: string; askedAt: Date } | null;
  /** 最后一条 done 事件的 payload（api 写的形状：{summary, prNumber?, testsPassed, verified?}）。 */
  done: { at: Date; summary: string; testsPassed: boolean | null; payload: unknown } | null;
  /** 最后一条 blocked 事件（{reason, needs}）。 */
  blocked: { at: Date; reason: string; needs: string; payload: unknown } | null;
  /** 最近的 say（新的在后），最多 limit 条。 */
  says: { at: Date; text: string }[];
}

const DEFAULT_SAYS_LIMIT = 20;
/** 步骤状态的先后名次：缺前一次记录时按 pending（0）算。 */
const STEP_STATE_RANK: Record<string, number> = { pending: 0, in_progress: 1, done: 2 };

/** 会话行不在返回 null（不是「没有进度」）。 */
export async function runProgressFacts(
  db: Db,
  runId: string,
  options: { saysLimit?: number } = {},
): Promise<RunProgressFacts | null> {
  const [run] = await db.select({ id: sessionRuns.id }).from(sessionRuns).where(eq(sessionRuns.id, runId));
  if (!run) return null;

  const saysLimit = options.saysLimit ?? DEFAULT_SAYS_LIMIT;
  const [lastEventRows, planEvents, pendingAskRows, doneRows, blockedRows, sayRows] = await Promise.all([
    db
      .select({ at: max(progressEvents.at) })
      .from(progressEvents)
      .where(eq(progressEvents.runId, runId)),
    db
      .select({ at: progressEvents.at, payload: progressEvents.payload })
      .from(progressEvents)
      .where(and(eq(progressEvents.runId, runId), eq(progressEvents.kind, 'plan')))
      .orderBy(asc(progressEvents.at), asc(progressEvents.id)),
    db
      .select({ id: asks.id, question: asks.question, askedAt: asks.askedAt })
      .from(asks)
      // 只有老式的（没带范围的）才算会话在等人：带了范围的问完当场按推荐接着干（#259），不能拿它把真停滞当成「在等人」
      .where(and(eq(asks.runId, runId), isNull(asks.answer), isNull(asks.scope)))
      .orderBy(asc(asks.askedAt))
      .limit(1),
    db
      .select({ at: progressEvents.at, payload: progressEvents.payload })
      .from(progressEvents)
      .where(and(eq(progressEvents.runId, runId), eq(progressEvents.kind, 'done')))
      .orderBy(desc(progressEvents.at), desc(progressEvents.id))
      .limit(1),
    db
      .select({ at: progressEvents.at, payload: progressEvents.payload })
      .from(progressEvents)
      .where(and(eq(progressEvents.runId, runId), eq(progressEvents.kind, 'blocked')))
      .orderBy(desc(progressEvents.at), desc(progressEvents.id))
      .limit(1),
    db
      .select({ at: progressEvents.at, payload: progressEvents.payload })
      .from(progressEvents)
      .where(and(eq(progressEvents.runId, runId), eq(progressEvents.kind, 'say')))
      .orderBy(desc(progressEvents.at), desc(progressEvents.id))
      .limit(saysLimit),
  ]);

  let lastStepAdvanceAt: Date | null = null;
  let prevByTitle = new Map<string, string>();
  for (const ev of planEvents) {
    const steps = parsePlanSteps(ev.payload);
    const advanced = steps.some(
      (s) => (STEP_STATE_RANK[s.state] ?? 0) > (STEP_STATE_RANK[prevByTitle.get(s.title) ?? 'pending'] ?? 0),
    );
    if (advanced) lastStepAdvanceAt = ev.at;
    prevByTitle = new Map(steps.map((s) => [s.title, s.state]));
  }
  const lastPlanEvent = planEvents.at(-1);
  const lastPlan = lastPlanEvent
    ? { at: lastPlanEvent.at, steps: parsePlanSteps(lastPlanEvent.payload) }
    : null;

  const pendingAskRow = pendingAskRows[0];
  const pendingAsk = pendingAskRow
    ? { id: pendingAskRow.id, question: pendingAskRow.question, askedAt: pendingAskRow.askedAt }
    : null;

  const doneRow = doneRows[0];
  const done = doneRow
    ? {
        at: doneRow.at,
        summary: (() => {
          const s = asRecord(doneRow.payload)?.summary;
          return typeof s === 'string' ? s : '';
        })(),
        testsPassed: (() => {
          const v = asRecord(doneRow.payload)?.testsPassed;
          return typeof v === 'boolean' ? v : null;
        })(),
        payload: doneRow.payload,
      }
    : null;

  const blockedRow = blockedRows[0];
  const blocked = blockedRow
    ? {
        at: blockedRow.at,
        reason: (() => {
          const v = asRecord(blockedRow.payload)?.reason;
          return typeof v === 'string' ? v : '';
        })(),
        needs: (() => {
          const v = asRecord(blockedRow.payload)?.needs;
          return typeof v === 'string' ? v : '';
        })(),
        payload: blockedRow.payload,
      }
    : null;

  const says = sayRows
    .map((r) => {
      const v = asRecord(r.payload)?.text;
      return { at: r.at, text: typeof v === 'string' ? v : '' };
    })
    .reverse();

  return {
    lastEventAt: lastEventRows[0]?.at ?? null,
    lastStepAdvanceAt,
    lastPlan,
    pendingAsk,
    done,
    blocked,
    says,
  };
}

/** 一次最多写这么多条：插头一秒能吐几十条工具事件，引擎攒一批再写；再多说明攒批的地方坏了。 */
export const PROGRESS_BATCH_MAX = 500;

/**
 * 引擎从过程记录里被动读到的进度（说话、工具、改文件、跑测试、待办清单）按批追加进 progress_events。
 * 会话行不在回 run_not_found（一条都不写）；plan 的 payload 没有 steps 数组、条数超上限、时刻读不出都直接抛——
 * 这些是引擎自己的错，不能静默丢（看板的进度条会变成 0/0）。整批一个语句，要么全进要么全不进。
 */
/**
 * 写一批进度事件。给了 outputSeq（这批事件出自会话输出的哪一行为止）就在同一个事务里把 session_runs.output_seq 推到它
 * （只往前推）：事件进库和「确认到哪一行」要么都成、要么都不成，引擎重启后接回会话按它去重。
 */
export async function appendProgressEvents(
  db: Db,
  runId: string,
  events: readonly { at: Date; kind: ProgressKind; payload: unknown }[],
  options: { outputSeq?: number } = {},
): Promise<'written' | 'run_not_found'> {
  const seq = options.outputSeq;
  if (seq !== undefined && (!Number.isInteger(seq) || seq < 0)) {
    throw new Error(`输出序号要是不小于 0 的整数，给的是 ${seq}`);
  }
  if (events.length > PROGRESS_BATCH_MAX) {
    throw new Error(`一批进度事件 ${events.length} 条，超过上限 ${PROGRESS_BATCH_MAX}`);
  }
  for (const [i, e] of events.entries()) {
    if (!(e.at instanceof Date) || Number.isNaN(e.at.getTime()))
      throw new Error(`第 ${i + 1} 条进度事件的时刻读不出`);
    if (e.kind === 'plan' && !Array.isArray(asRecord(e.payload)?.steps)) {
      throw new Error(`第 ${i + 1} 条进度事件是 plan，但 payload 里没有 steps 数组`);
    }
  }
  const [run] = await db.select({ id: sessionRuns.id }).from(sessionRuns).where(eq(sessionRuns.id, runId));
  if (!run) return 'run_not_found';
  if (events.length === 0 && seq === undefined) return 'written';
  await db.transaction(async (tx) => {
    if (events.length > 0) {
      await tx
        .insert(progressEvents)
        .values(events.map((e) => ({ runId, at: e.at, kind: e.kind, payload: e.payload })));
    }
    if (seq !== undefined) {
      await tx
        .update(sessionRuns)
        .set({ outputSeq: sql`greatest(coalesce(${sessionRuns.outputSeq}, -1), ${seq})` })
        .where(eq(sessionRuns.id, runId));
    }
  });
  return 'written';
}
