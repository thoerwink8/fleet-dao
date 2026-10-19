// 任务页「过程」要的读法（#3140）：全从现成的表读，不建步骤表。
//
// - readRunProcessRows：一笔的轻量行（run_transcript，不带整段文本：切步、算小计只要种类、工具名、成败、时刻、调用号和一小截文本），
//   给 shared 的 cutSteps 切步；一笔最多 3000 行。
// - readRunTallies：按请求的 runIds 一条批量查询，只读统计列、不读文本或整份 meta，再用 shared 的 tallyProcessRows 现算。
//   概览与切步共用调用号接受/去重规则；entries 和首尾时刻包括所有种类，没有记录的笔不造 0。
// - readRunLastSay：一笔最后一条主会话助手的话（最新汇报；不取 result，不取子代理的）。
// - listTaskRounds：回合（task_rounds）；listTaskEngineSteps：引擎在会话外做的事（step_timings 里这张单的活动和等待）。
// 读不到（库不通）一律抛，由接口回「没读到」带原因；「这一笔没有记录」返回空，和读不到分开。
import { type ProcessRow, type RunTallyRow, tallyProcessRows } from '@fleet-dao/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { stepTimings, taskRounds } from '../schema/index.ts';
import { runTranscript } from '../schema/runs.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rowsOf = (res: unknown) =>
  (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as Record<string, unknown>[];

/** 文本留多长：助手的话、结论、报错取开头一截（标题只要第一句）；工具调用的输入摘要（命令、路径）；结果和提示词不要文本。 */
const TEXT_LIMIT = sql`case
  when ${runTranscript.kind} in ('assistant', 'result', 'error') then 400
  when ${runTranscript.kind} = 'tool_call' then 300
  else 0 end`;

/** meta 里的数字字段：不是数字的当没写，不让一条脏数据把整张单的详情读挂。 */
const metaInt = (key: string) =>
  sql<number | null>`case when jsonb_typeof(${runTranscript.meta} -> ${key}) = 'number'
    then (${runTranscript.meta} ->> ${key})::int end`;

/** 一笔的轻量行，按 seq 排。不是 uuid、一条都没有返回空数组。 */
export async function readRunProcessRows(db: Db, runId: string): Promise<ProcessRow[]> {
  if (!UUID.test(runId)) return [];
  const rows = await db
    .select({
      seq: runTranscript.seq,
      at: runTranscript.at,
      kind: runTranscript.kind,
      tool: runTranscript.tool,
      ok: runTranscript.ok,
      text: sql<string>`left(${runTranscript.text}, ${TEXT_LIMIT})`,
      sub: sql<boolean>`(${runTranscript.meta} ->> 'subagent') is not null`,
      subOf: sql<
        string | null
      >`case when jsonb_typeof(${runTranscript.meta} -> 'subagent') = 'string' then ${runTranscript.meta} ->> 'subagent' end`,
      callId: sql<string | null>`${runTranscript.meta} ->> 'callId'`,
      exitUnknown: sql<boolean>`(${runTranscript.meta} ->> 'exitKnown') = 'false'`,
      added: metaInt('added'),
      removed: metaInt('removed'),
    })
    .from(runTranscript)
    .where(eq(runTranscript.runId, runId))
    .orderBy(asc(runTranscript.seq));
  return rows.map((r) => ({
    seq: r.seq,
    at: r.at.toISOString(),
    kind: r.kind,
    ...(r.tool === null ? {} : { tool: r.tool }),
    ...(r.ok === null ? {} : { ok: r.ok }),
    text: r.text,
    sub: r.sub,
    ...(r.subOf === null ? {} : { subOf: r.subOf }),
    ...(r.callId === null || r.callId === '' ? {} : { callId: r.callId }),
    ...(r.exitUnknown ? { exitKnown: false } : {}),
    ...(r.added === null ? {} : { added: r.added }),
    ...(r.removed === null ? {} : { removed: r.removed }),
  }));
}

const list = (names: readonly string[]) =>
  sql.join(
    names.map((n) => sql`${n}`),
    sql`, `,
  );

/**
 * 几笔的小计：一条轻量列查询，无 N+1，不取 text 或整 meta；shared 与切步共用原生号配对规则。
 * 读不到抛；没有记录的笔不出现在结果里。所有 kind 都保留，entries 和首尾时刻不因只看工具而缩水。
 */
export async function readRunTallies(db: Db, runIds: readonly string[]): Promise<Map<string, RunTallyRow>> {
  const out = new Map<string, RunTallyRow>();
  const ids = runIds.filter((id) => UUID.test(id));
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      runId: runTranscript.runId,
      seq: runTranscript.seq,
      at: runTranscript.at,
      kind: runTranscript.kind,
      tool: runTranscript.tool,
      ok: runTranscript.ok,
      callId: sql<string | null>`${runTranscript.meta} ->> 'callId'`,
      exitUnknown: sql<boolean>`(${runTranscript.meta} ->> 'exitKnown') = 'false'`,
      added: metaInt('added'),
      removed: metaInt('removed'),
    })
    .from(runTranscript)
    .where(inArray(runTranscript.runId, ids))
    .orderBy(asc(runTranscript.runId), asc(runTranscript.seq));
  const byRun = new Map<string, ProcessRow[]>();
  for (const r of rows) {
    const runRows = byRun.get(r.runId) ?? [];
    runRows.push({
      seq: r.seq,
      at: r.at.toISOString(),
      kind: r.kind,
      text: '',
      sub: false,
      ...(r.tool === null ? {} : { tool: r.tool }),
      ...(r.ok === null ? {} : { ok: r.ok }),
      ...(r.callId === null || r.callId === '' ? {} : { callId: r.callId }),
      ...(r.exitUnknown ? { exitKnown: false } : {}),
      ...(r.added === null ? {} : { added: r.added }),
      ...(r.removed === null ? {} : { removed: r.removed }),
    });
    byRun.set(r.runId, runRows);
  }
  for (const [id, runRows] of byRun) out.set(id, tallyProcessRows(runRows));
  return out;
}

/** 一笔最后一条主会话助手的话（整段文本）；一条都没有返回 null。不取 result、不取子代理的。 */
export async function readRunLastSay(db: Db, runId: string): Promise<{ text: string; at: Date } | null> {
  if (!UUID.test(runId)) return null;
  const res = rowsOf(
    await db.execute(sql`
      select text, at from run_transcript
       where run_id = ${runId}::uuid and kind = 'assistant' and (meta ->> 'subagent') is null
         and btrim(text) <> ''
       order by seq desc limit 1
    `),
  );
  const row = res[0];
  return row ? { text: String(row.text), at: new Date(String(row.at)) } : null;
}

export interface TaskRoundRow {
  seq: number;
  round: number;
  outcome: string;
  tier?: string | undefined;
  firstModel?: string | undefined;
  addedLines?: number | undefined;
  flowMode?: 'three' | 'full' | undefined;
  startedAt?: Date | undefined;
  endedAt: Date;
  reworkSummary?: string | undefined;
}

/** 这张单的回合，按 seq 排。一个都没有返回空数组（还没有一轮收场过）。 */
export async function listTaskRounds(db: Db, taskId: string): Promise<TaskRoundRow[]> {
  if (!UUID.test(taskId)) return [];
  const rows = await db
    .select()
    .from(taskRounds)
    .where(eq(taskRounds.taskId, taskId))
    .orderBy(asc(taskRounds.seq));
  return rows.map((r) => ({
    seq: r.seq,
    round: r.round,
    outcome: r.outcome,
    ...(r.tier === null ? {} : { tier: r.tier }),
    ...(r.firstModel === null ? {} : { firstModel: r.firstModel }),
    ...(r.addedLines === null ? {} : { addedLines: r.addedLines }),
    ...(r.flowMode === null ? {} : { flowMode: r.flowMode }),
    ...(r.startedAt === null ? {} : { startedAt: r.startedAt }),
    endedAt: r.endedAt,
    ...(r.reworkSummary === null ? {} : { reworkSummary: r.reworkSummary }),
  }));
}

/** 页面要写出来的活动：自测、推分支、开 PR、等 CI、验收、合并……（别的活动是内部记账，不进过程）。 */
export const ENGINE_STEP_ACTIVITIES = [
  'createWorktree',
  'selfCheck',
  'syncMainline',
  'pushBranch',
  'openPr',
  'waitCi',
  'coldVerify',
  'armAutoMerge',
  'waitMerged',
  'mergeNow',
  'removeWorktree',
] as const;

/** 一张单最多读多少条引擎步骤（最近的）。 */
export const ENGINE_STEPS_MAX = 400;

export type EngineStepRow =
  | {
      kind: 'activity';
      activity: string;
      attempt: number;
      startedAt: Date;
      endedAt: Date;
      runMs: number;
      outcome: 'ok' | 'failed' | 'cancelled';
      errorCode?: string | undefined;
    }
  | {
      kind: 'wait';
      waitFor: string;
      detail?: string | undefined;
      startedAt: Date;
      endedAt: Date;
      waitMs: number;
    };

/** 引擎在会话外做的事和等待（step_timings 里这张单的），按开始时间从早到晚，最多最近 ENGINE_STEPS_MAX 条。 */
export async function listTaskEngineSteps(db: Db, taskId: string): Promise<EngineStepRow[]> {
  if (!UUID.test(taskId)) return [];
  const rows = await db
    .select()
    .from(stepTimings)
    .where(
      sql`${stepTimings.taskId} = ${taskId}::uuid and (${stepTimings.kind} = 'wait' or ${stepTimings.activity} in (${list(ENGINE_STEP_ACTIVITIES)}))`,
    )
    .orderBy(sql`${stepTimings.startedAt} desc`)
    .limit(ENGINE_STEPS_MAX);
  return rows
    .reverse()
    .map((r): EngineStepRow | null => {
      if (r.kind === 'wait') {
        return {
          kind: 'wait',
          waitFor: r.waitFor ?? '',
          ...(r.detail === null ? {} : { detail: r.detail }),
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          waitMs: Number(r.waitMs ?? 0),
        };
      }
      if (r.activity === null || r.outcome === null) return null;
      return {
        kind: 'activity',
        activity: r.activity,
        attempt: r.attempt ?? 1,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        runMs: Number(r.runMs ?? 0),
        outcome: r.outcome,
        ...(r.errorCode === null ? {} : { errorCode: r.errorCode }),
      };
    })
    .filter((r): r is EngineStepRow => r !== null);
}
