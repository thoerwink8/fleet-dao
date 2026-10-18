// 三段会话的过程记录（run_transcript，表的来龙去脉在 schema/runs.ts）：引擎写、驾驶舱读。
//
// 改这里之前必须知道：
// - 写：一批一批 insert，(run_id, seq) 冲突就跳过（on conflict do nothing）——引擎重启后重读输出、重复写同一条不会写两遍，
//   也不会改掉已经写进去的那一条。run 不在 runs 表里（外键不过）原样抛：调用方（引擎）先保证有一行（三段是开跑那一行，
//   提需求、临时指挥官是没有 route_id 的锚点），写不进只记日志，不让会话失败。
// - 读：按 seq 往后读，after 不给从头读；多取一条判「后面还有没有」。run 的编号不是 uuid 回空（谈不上有记录）。
// - 「这一段没有记录」和「读不到」分开：没有记录是读成功了、一条都没有（返回 any: false）；读不到（库不通）照抛，由接口回 503。
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { type RunTranscriptKind, runTranscript } from '../schema/index.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TranscriptRow {
  seq: number;
  at: Date;
  kind: RunTranscriptKind;
  text: string;
  tool?: string | undefined;
  ok?: boolean | undefined;
  meta?: Record<string, unknown> | undefined;
}

/** 写一批条目。seq 已经冲突的跳过。写不进（run 不存在、库不通）照抛。 */
export async function appendRunTranscript(
  db: Db,
  runId: string,
  rows: readonly TranscriptRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(runTranscript)
    .values(
      rows.map((r) => ({
        runId,
        seq: r.seq,
        at: r.at,
        kind: r.kind,
        text: r.text,
        tool: r.tool ?? null,
        ok: r.ok ?? null,
        meta: r.meta ?? null,
      })),
    )
    .onConflictDoNothing({ target: [runTranscript.runId, runTranscript.seq] });
}

export interface RunTranscriptPage {
  entries: TranscriptRow[];
  /** 这一段在库里到底有没有记录（不看 after）：false = 一条都没有。 */
  any: boolean;
  /** 本页之后还有没有（取的比 limit 多一条判出来的）。 */
  more: boolean;
}

/** 读 seq 大于 after 的条目（after 不给 = 从头），最多 limit 条，按 seq 排。 */
export async function readRunTranscript(
  db: Db,
  runId: string,
  opts: { after?: number | undefined; limit: number },
): Promise<RunTranscriptPage> {
  if (!UUID.test(runId)) return { entries: [], any: false, more: false };
  const rows = await db
    .select()
    .from(runTranscript)
    .where(
      opts.after === undefined
        ? eq(runTranscript.runId, runId)
        : and(eq(runTranscript.runId, runId), gt(runTranscript.seq, opts.after)),
    )
    .orderBy(asc(runTranscript.seq))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  let any = page.length > 0;
  if (!any && opts.after !== undefined) {
    const [first] = await db
      .select({ one: sql<number>`1` })
      .from(runTranscript)
      .where(eq(runTranscript.runId, runId))
      .limit(1);
    any = first !== undefined;
  }
  return {
    entries: page.map((r) => ({
      seq: r.seq,
      at: r.at,
      kind: r.kind,
      text: r.text,
      ...(r.tool === null ? {} : { tool: r.tool }),
      ...(r.ok === null ? {} : { ok: r.ok }),
      ...(r.meta === null ? {} : { meta: r.meta }),
    })),
    any,
    more: rows.length > opts.limit,
  };
}

/** 任务页「过程」要的一行：不带整段文本，只带切步和小计用得到的列（文本按种类截短）。 */
export interface RunProcessRow {
  seq: number;
  at: Date;
  kind: RunTranscriptKind;
  tool: string | null;
  ok: boolean | null;
  text: string;
  /** 子代理里的条目。 */
  sub: boolean;
  /** 引擎记编辑时写在 meta 里的增删行数；没写是 null。 */
  added: number | null;
  removed: number | null;
}

/** 文本留多长：助手的话、结论、报错取开头一截（标题只要第一句）；工具调用的输入摘要（命令、路径）；结果和提示词不要文本。 */
const PROCESS_TEXT = sql`case
  when ${runTranscript.kind} in ('assistant', 'result', 'error') then 400
  when ${runTranscript.kind} = 'tool_call' then 300
  else 0 end`;

/** meta 里的数字字段：不是数字的当没写，不让一条脏数据把整张单的详情读挂。 */
const metaInt = (key: string) =>
  sql<number | null>`case when jsonb_typeof(${runTranscript.meta} -> ${key}) = 'number'
    then (${runTranscript.meta} ->> ${key})::int end`;

/**
 * 读几段的过程行（按 run 分组，各段按 seq 排）。一段最多 3000 条，这里不读整段文本：
 * 切步、算小计只要种类、工具名、成没成、时刻和一小截文本。读不到（库不通）照抛。
 */
export async function readRunProcessRows(
  db: Db,
  runIds: readonly string[],
): Promise<Map<string, RunProcessRow[]>> {
  const out = new Map<string, RunProcessRow[]>();
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
      text: sql<string>`left(${runTranscript.text}, ${PROCESS_TEXT})`,
      sub: sql<boolean>`(${runTranscript.meta} ->> 'subagent') is not null`,
      added: metaInt('added'),
      removed: metaInt('removed'),
    })
    .from(runTranscript)
    .where(inArray(runTranscript.runId, ids))
    .orderBy(asc(runTranscript.runId), asc(runTranscript.seq));
  for (const { runId, ...row } of rows) {
    const list = out.get(runId) ?? [];
    list.push(row);
    out.set(runId, list);
  }
  return out;
}

/** 一段最后的汇报：最后一条结论（result），没有就取主会话最后一句话（assistant）。整段文本，一条都没有返回 null。 */
export async function readRunReport(
  db: Db,
  runId: string,
): Promise<{ kind: 'result' | 'assistant'; text: string; at: Date } | null> {
  if (!UUID.test(runId)) return null;
  const pick = async (kind: 'result' | 'assistant') => {
    const [row] = await db
      .select({ text: runTranscript.text, at: runTranscript.at })
      .from(runTranscript)
      .where(
        and(
          eq(runTranscript.runId, runId),
          eq(runTranscript.kind, kind),
          sql`(${runTranscript.meta} ->> 'subagent') is null`,
        ),
      )
      .orderBy(desc(runTranscript.seq))
      .limit(1);
    return row && row.text.trim() ? { kind, text: row.text, at: row.at } : null;
  };
  return (await pick('result')) ?? (await pick('assistant'));
}
