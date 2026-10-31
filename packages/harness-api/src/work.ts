// 任务波次图的快照（#3784）：驾驶舱 `/next/work` 的两条只读接口背后的读和推导。
// 现在的数据来源是影子批次：一批里每张单一个节点，没有依赖，全在第 0 波；形状放在 harness-contract 的 work-graph，
// 以后编排做出来同一个形状喂多波依赖图。
//
// 一张单的状态由这些推出（每一步都是按键或按索引读，行数跟这一批的单数、尝试次数成正比，不跟表大小走）：
//   fleet2.shadow_batch_items  批次清单（唯一约束索引 batch_id,repo,issue）
//   fleet2.events 的 session:shadow-<批次> 流   派工请求（带 shadow.repo/issue）和交回（outcome、verdict、attempt、runId），索引 events_stream_id_idx
//   fleet2.jobs                派工器的活（键 spawn:<请求事件号>，唯一约束 jobs_key_unique）：排队、在领、做完、取消、放弃
//   fleet2.events 的 worker:<runId> 流（开工时间和模型）、session:worker-<runId> 流（最近一句进度），同一个索引，每个运行一条
//   fleet2.shadow_runs（索引 shadow_runs_batch_idx）和 fleet2.shadow_compare（索引 shadow_compare_batch_idx）  影子产物的核验结论、打分
// 批次列表沿 shadow_batch_items_snapshot_idx（snapshot_at,batch_id）一个冻结时刻一个时刻地往下跳。
import {
  type BatchesPage,
  type BatchSummary,
  countStates,
  GRAPH_NODE_MAX,
  type NodeScore,
  type WorkGraph,
  type WorkNode,
} from '@fleet-dao/harness-contract/work-graph';
import type { Db } from '@fleet-dao/harness-store';
import { type SQL, sql } from 'drizzle-orm';

/** 影子批次的会话号规则（harness-dispatch 的 shadowSessionId，api 不依赖 dispatch，这里照抄；那边改了要跟着改）。 */
export const shadowSessionOf = (batchId: string): string => `shadow-${batchId}`;
const REQUEST_TYPE = 'worker.spawn.requested';
const HANDBACK_TYPE = 'handback.recorded';
const HEADLINE_MAX = 160;
/** 一批的交回、派工请求最多读多少条（单数 × 每张单大约的条数，留余量）。 */
const EVENT_ROWS_MAX = GRAPH_NODE_MAX * 8;

// ---------------------------------------------------------------- 纯推导

export interface RequestRow {
  eventId: number;
  taskId: string;
  repo: string;
  issue: number;
  /** 任务标题（派工请求里 task 的第一行）。 */
  task: string | null;
}

export interface HandbackRow {
  eventId: number;
  taskId: string;
  runId: string | null;
  attempt: number;
  final: boolean;
  outcome: string | null;
  verdict: string | null;
  reason: string | null;
  at: string;
}

export interface JobRow {
  key: string;
  state: string;
  attempts: number;
  leaseUntil: string | null;
  claimedAt: string | null;
  updatedAt: string;
  lastError: string | null;
}

export interface RunInfo {
  runId: string;
  startedAt: string | null;
  model: string | null;
}

export interface ShadowRunRow {
  id: number;
  runId: string;
  verdict: string;
  at: string;
}

export interface NodeInput {
  repo: string;
  issue: number;
  request: RequestRow | undefined;
  job: JobRow | undefined;
  handbacks: readonly HandbackRow[];
  /** 这张单的运行（按尝试顺序）。 */
  runs: readonly RunInfo[];
  shadowRuns: readonly ShadowRunRow[];
  /** 最近一次运行的最近一句进度。 */
  progress: string | null;
  score: NodeScore | null;
}

const clip = (s: string | null | undefined, n = HEADLINE_MAX): string | null => {
  if (!s) return null;
  const one = s.replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** 终局交回的结局 → 节点状态。completed/delivered 看核验结论；被叫停、起不来、出错、放弃都算失败；结局不确定要人看，算被卡住。 */
function stateOfFinal(h: HandbackRow): string {
  switch (h.outcome) {
    case 'completed':
    case 'delivered':
      return h.verdict === 'failed' ? 'failed' : 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'uncertain':
      return 'blocked';
    default:
      return 'failed';
  }
}

/**
 * 一张单的状态。优先级：终局交回 > 派工器的活 > 影子产物 > 还没派。
 * - 活在领：租约过期还没回收算「被卡住」（blocked），否则在跑；
 * - 活退回队列：最近一次交回是「发版暂停」算暂停（paused），领过又回来的是等重试（scheduled），没领过的是排队（pending）；
 * - 活 done 但没有终局交回（不该发生）：看影子产物的核验结论；活 dead 算失败；活被取消算取消。
 */
export function deriveNodeState(i: NodeInput, nowMs: number): string {
  if (!i.request) return 'pending';
  const final = [...i.handbacks].reverse().find((h) => h.final);
  if (final) return stateOfFinal(final);
  const shadow = i.shadowRuns.at(-1);
  const job = i.job;
  if (job) {
    switch (job.state) {
      case 'claimed':
        return job.leaseUntil !== null && Date.parse(job.leaseUntil) < nowMs ? 'blocked' : 'running';
      case 'done':
        return shadow?.verdict === 'failed' ? 'failed' : 'completed';
      case 'cancelled':
        return 'cancelled';
      case 'dead':
        return 'failed';
      default: {
        if (i.handbacks.at(-1)?.outcome === 'released') return 'paused';
        return job.attempts > 0 ? 'scheduled' : 'pending';
      }
    }
  }
  if (shadow) return shadow.verdict === 'failed' ? 'failed' : 'completed';
  return 'pending';
}

const TERMINAL_BAD = ['failed', 'blocked', 'cancelled'];

/** 把一张单的零件推成画布上的节点。 */
export function deriveNode(i: NodeInput, nowMs: number): WorkNode {
  const state = deriveNodeState(i, nowMs);
  const repoName = i.repo.includes('/') ? i.repo.slice(i.repo.lastIndexOf('/') + 1) : i.repo;
  const attempt = Math.max(i.job?.attempts ?? 0, ...i.handbacks.map((h) => h.attempt), 0);
  const final = [...i.handbacks].reverse().find((h) => h.final);
  const lastRun = i.runs.at(-1);
  const reason = final?.reason ?? [...i.handbacks].reverse().find((h) => h.reason)?.reason ?? null;
  let headline: string | null;
  if (TERMINAL_BAD.includes(state)) headline = clip(reason) ?? clip(i.job?.lastError) ?? clip(i.progress);
  else if (state === 'completed') headline = clip(reason) ?? clip(i.progress);
  else headline = clip(i.progress) ?? clip(i.job?.lastError);
  headline ??= clip(i.request?.task);
  const settled = ['completed', 'failed', 'cancelled'].includes(state);
  const completedAt = settled
    ? (final?.at ?? i.shadowRuns.at(-1)?.at ?? (i.job && i.job.state !== 'claimed' ? i.job.updatedAt : null))
    : null;
  return {
    id: `${i.repo}#${i.issue}`,
    label: `${repoName}#${i.issue}`,
    state,
    attempt,
    startedAt: lastRun?.startedAt ?? i.job?.claimedAt ?? null,
    completedAt,
    model: lastRun?.model ?? null,
    category: i.request ? 'shadow' : null,
    headline,
    runIds: i.runs.map((r) => r.runId),
    score: i.score,
  };
}

// ---------------------------------------------------------------- 读

type Rows<T> = T[] | { rows: T[] };
const rowsOf = <T>(r: unknown): T[] => {
  const x = r as Rows<T>;
  return Array.isArray(x) ? x : x.rows;
};

const textArray = (items: readonly string[]): SQL =>
  sql`array[${sql.join(
    items.map((s) => sql`${s}`),
    sql`, `,
  )}]::text[]`;

const ISO = (col: SQL): SQL => sql`to_char(${col} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** 各条查询的 SQL。单独导出：执行计划测试拿它们 EXPLAIN，确认走的是上面注释里写的索引。 */
export const workQueries = {
  items: (batchId: string, limit: number): SQL => sql`
    select repo, issue, ${ISO(sql`snapshot_at`)} as snapshot_at
    from fleet2.shadow_batch_items where batch_id = ${batchId} order by repo, issue limit ${limit}`,
  itemCount: (batchId: string): SQL =>
    sql`select count(*)::int as n from fleet2.shadow_batch_items where batch_id = ${batchId}`,
  requestsAndHandbacks: (streamId: string): SQL => sql`
    select e.id, e.type, ${ISO(sql`e.created_at`)} as at, jsonb_build_object(
      'taskId', e.payload->'taskId', 'shadow', e.payload->'shadow', 'task', left(e.payload->>'task', 200),
      'runId', e.payload->'runId', 'attempt', e.payload->'attempt', 'final', e.payload->'final',
      'outcome', e.payload->'outcome', 'verdict', e.payload->'verdict', 'reason', left(e.payload->'reasons'->>0, 200)
    ) as slim
    from fleet2.events e
    where e.stream_id = ${streamId} and e.type in (${REQUEST_TYPE}, ${HANDBACK_TYPE})
    order by e.id limit ${EVENT_ROWS_MAX}`,
  jobs: (keys: readonly string[]): SQL => sql`
    select key, state, attempts, ${ISO(sql`lease_until`)} as lease_until, ${ISO(sql`claimed_at`)} as claimed_at,
      ${ISO(sql`updated_at`)} as updated_at, left(last_error, 200) as last_error
    from fleet2.jobs where key = any(${textArray(keys)})`,
  workerSpawned: (streamIds: readonly string[]): SQL => sql`
    select e.stream_id, e.payload->>'model' as model, ${ISO(sql`e.created_at`)} as at
    from fleet2.events e where e.stream_id = any(${textArray(streamIds)}) and e.type = 'worker.spawned' order by e.id`,
  latestProgress: (streamIds: readonly string[]): SQL => sql`
    select s.stream_id, t.summary
    from unnest(${textArray(streamIds)}) as s(stream_id)
    cross join lateral (
      select left(e.payload->>'summary', 200) as summary from fleet2.events e
      where e.stream_id = s.stream_id and e.type = 'worker.progress.reported'
      order by e.id desc limit 1
    ) t`,
  shadowRuns: (batchId: string): SQL => sql`
    select id, run_id, repo, issue, verdict, ${ISO(sql`created_at`)} as at
    from fleet2.shadow_runs where batch_id = ${batchId} order by id limit ${EVENT_ROWS_MAX}`,
  shadowCompare: (batchId: string): SQL => sql`
    select shadow_run_id, score->>'lineJaccard' as line, score->>'fileJaccard' as file
    from fleet2.shadow_compare where batch_id = ${batchId} order by shadow_run_id limit ${EVENT_ROWS_MAX}`,
  /** 批次列表：沿 (snapshot_at, batch_id) 索引一个冻结时刻一个时刻地往下跳，再取这些时刻上的批次。 */
  batches: (limit: number, before: string | undefined): SQL => sql`
    with recursive t(n, ts) as (
      (select 1, snapshot_at from fleet2.shadow_batch_items
        ${before === undefined ? sql`` : sql`where snapshot_at < ${before}::timestamptz`}
        order by snapshot_at desc limit 1)
      union all
      select t.n + 1,
        (select i.snapshot_at from fleet2.shadow_batch_items i where i.snapshot_at < t.ts order by i.snapshot_at desc limit 1)
      from t where t.ts is not null and t.n < ${limit + 1}
    )
    select i.batch_id, ${ISO(sql`min(i.snapshot_at)`)} as snapshot_at,
      (select count(*) from t where ts is not null)::int as picked_n,
      ${ISO(sql`(select ts from t where n = ${limit})`)} as page_last
    from t join fleet2.shadow_batch_items i on i.snapshot_at = t.ts
    where t.ts is not null and t.n <= ${limit}
    group by i.batch_id
    order by min(i.snapshot_at) desc, i.batch_id desc`,
};

interface EventRow {
  id: number | string;
  type: string;
  at: string;
  slim: Record<string, unknown> | string;
}

const asSlim = (v: EventRow['slim']): Record<string, unknown> =>
  typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : v;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const firstLine = (v: unknown): string | null => str(typeof v === 'string' ? v.split('\n')[0] : null);

/** runId 末尾的 -a<n>（派工器的编号规则 d<请求事件号>-a<第几次领取>）。 */
const attemptOfRun = (runId: string): number => Number(/-a(\d+)$/.exec(runId)?.[1] ?? 0);

/** 读一批的整份快照；批次不存在（清单里一张单都没有）返回 null。读的行数跟这一批的单数、尝试次数成正比。 */
export async function loadBatchGraph(
  db: Db,
  batchId: string,
  opts: { now?: number } = {},
): Promise<WorkGraph | null> {
  const nowMs = opts.now ?? Date.now();
  const items = rowsOf<{ repo: string; issue: number }>(
    await db.execute(workQueries.items(batchId, GRAPH_NODE_MAX + 1)),
  );
  if (items.length === 0) return null;
  let truncatedFrom: number | null = null;
  if (items.length > GRAPH_NODE_MAX) {
    items.length = GRAPH_NODE_MAX;
    truncatedFrom = rowsOf<{ n: number }>(await db.execute(workQueries.itemCount(batchId)))[0]?.n ?? null;
  }

  // 派工请求和交回（一条流，一次读完）
  const requests = new Map<string, RequestRow>(); // 按 repo#issue，后来的覆盖
  const handbackRows: (HandbackRow & { key: string | null })[] = [];
  const evRows = rowsOf<EventRow>(
    await db.execute(workQueries.requestsAndHandbacks(`session:${shadowSessionOf(batchId)}`)),
  );
  const taskToItem = new Map<string, string>();
  for (const r of evRows) {
    const s = asSlim(r.slim);
    const taskId = str(s.taskId);
    if (!taskId) continue;
    if (r.type === REQUEST_TYPE) {
      const sh = s.shadow as { repo?: unknown; issue?: unknown } | null;
      if (!sh || typeof sh.repo !== 'string' || typeof sh.issue !== 'number') continue;
      const id = `${sh.repo}#${sh.issue}`;
      requests.set(id, {
        eventId: Number(r.id),
        taskId,
        repo: sh.repo,
        issue: sh.issue,
        task: firstLine(s.task),
      });
      taskToItem.set(taskId, id);
    } else {
      handbackRows.push({
        key: null,
        eventId: Number(r.id),
        taskId,
        runId: str(s.runId),
        attempt: typeof s.attempt === 'number' ? s.attempt : 0,
        final: s.final === true,
        outcome: str(s.outcome),
        verdict: str(s.verdict),
        reason: str(s.reason),
        at: r.at,
      });
    }
  }
  const handbacksByItem = new Map<string, HandbackRow[]>();
  for (const h of handbackRows) {
    const id = taskToItem.get(h.taskId);
    if (!id) continue;
    const list = handbacksByItem.get(id) ?? [];
    list.push(h);
    handbacksByItem.set(id, list);
  }

  // 派工器的活
  const jobsByKey = new Map<string, JobRow>();
  const keys = [...requests.values()].map((r) => `spawn:${r.eventId}`);
  if (keys.length > 0) {
    for (const j of rowsOf<{
      key: string;
      state: string;
      attempts: number;
      lease_until: string | null;
      claimed_at: string | null;
      updated_at: string;
      last_error: string | null;
    }>(await db.execute(workQueries.jobs(keys)))) {
      jobsByKey.set(j.key, {
        key: j.key,
        state: j.state,
        attempts: j.attempts,
        leaseUntil: j.lease_until,
        claimedAt: j.claimed_at,
        updatedAt: j.updated_at,
        lastError: j.last_error,
      });
    }
  }

  // 每张单可能的运行号：交回里记的 + 按派工器编号规则推的（d<请求事件号>-a1..a<领取次数>）
  const candidates = new Map<string, string[]>();
  for (const [id, req] of requests) {
    const set = new Set<string>();
    for (const h of handbacksByItem.get(id) ?? []) if (h.runId) set.add(h.runId);
    const attempts = jobsByKey.get(`spawn:${req.eventId}`)?.attempts ?? 0;
    for (let n = 1; n <= attempts; n++) set.add(`d${req.eventId}-a${n}`);
    candidates.set(id, [...set]);
  }
  const allRuns = [...new Set([...candidates.values()].flat())];
  const spawned = new Map<string, RunInfo>();
  if (allRuns.length > 0) {
    for (const r of rowsOf<{ stream_id: string; model: string | null; at: string }>(
      await db.execute(workQueries.workerSpawned(allRuns.map((x) => `worker:${x}`))),
    )) {
      const runId = r.stream_id.slice('worker:'.length);
      spawned.set(runId, { runId, startedAt: r.at, model: r.model });
    }
  }
  const runsByItem = new Map<string, RunInfo[]>();
  for (const [id, list] of candidates) {
    const known = new Set((handbacksByItem.get(id) ?? []).map((h) => h.runId));
    const runs = list
      .filter((rid) => spawned.has(rid) || known.has(rid))
      .map((rid) => spawned.get(rid) ?? { runId: rid, startedAt: null, model: null });
    runs.sort((a, b) => attemptOfRun(a.runId) - attemptOfRun(b.runId));
    runsByItem.set(id, runs);
  }

  // 最近一次运行的最近一句进度
  const progressByRun = new Map<string, string>();
  const lastRuns = [...runsByItem.values()].map((r) => r.at(-1)?.runId).filter((x): x is string => !!x);
  if (lastRuns.length > 0) {
    for (const r of rowsOf<{ stream_id: string; summary: string | null }>(
      await db.execute(workQueries.latestProgress(lastRuns.map((x) => `session:worker-${x}`))),
    )) {
      if (r.summary) progressByRun.set(r.stream_id.slice('session:worker-'.length), r.summary);
    }
  }

  // 影子产物和打分
  const shadowByItem = new Map<string, ShadowRunRow[]>();
  const shadowRunId = new Map<number, string>();
  for (const r of rowsOf<{
    id: number | string;
    run_id: string;
    repo: string;
    issue: number;
    verdict: string;
    at: string;
  }>(await db.execute(workQueries.shadowRuns(batchId)))) {
    const id = `${r.repo}#${r.issue}`;
    const list = shadowByItem.get(id) ?? [];
    list.push({ id: Number(r.id), runId: r.run_id, verdict: r.verdict, at: r.at });
    shadowByItem.set(id, list);
    shadowRunId.set(Number(r.id), id);
  }
  const scoreByItem = new Map<string, NodeScore>();
  for (const r of rowsOf<{ shadow_run_id: number | string; line: string | null; file: string | null }>(
    await db.execute(workQueries.shadowCompare(batchId)),
  )) {
    const id = shadowRunId.get(Number(r.shadow_run_id));
    const line = Number(r.line);
    const file = Number(r.file);
    if (id && Number.isFinite(line) && Number.isFinite(file))
      scoreByItem.set(id, { lineJaccard: line, fileJaccard: file });
  }

  const nodes = items.map((it) => {
    const id = `${it.repo}#${it.issue}`;
    const request = requests.get(id);
    const runs = runsByItem.get(id) ?? [];
    const lastRun = runs.at(-1);
    return deriveNode(
      {
        repo: it.repo,
        issue: it.issue,
        request,
        job: request ? jobsByKey.get(`spawn:${request.eventId}`) : undefined,
        handbacks: handbacksByItem.get(id) ?? [],
        runs,
        shadowRuns: shadowByItem.get(id) ?? [],
        progress: lastRun ? (progressByRun.get(lastRun.runId) ?? null) : null,
        score: scoreByItem.get(id) ?? null,
      },
      nowMs,
    );
  });
  return {
    batchId,
    at: new Date(nowMs).toISOString(),
    nodes,
    // 影子批次没有依赖：全在第 0 波，边是空的
    waves: [{ index: 0, nodeIds: nodes.map((n) => n.id) }],
    edges: [],
    truncatedFrom,
  };
}

const CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
export const isBatchCursor = (s: string): boolean => CURSOR.test(s) && !Number.isNaN(Date.parse(s));

/** 批次列表：从新到老翻页，每项带单数和各状态数。 */
export async function listBatches(
  db: Db,
  opts: { limit: number; before?: string; now?: number },
): Promise<BatchesPage> {
  const rows = rowsOf<{
    batch_id: string;
    snapshot_at: string;
    picked_n: number;
    page_last: string | null;
  }>(await db.execute(workQueries.batches(opts.limit, opts.before)));
  const batches: BatchSummary[] = [];
  for (const r of rows) {
    const g = await loadBatchGraph(db, r.batch_id, opts.now === undefined ? {} : { now: opts.now });
    if (!g) continue;
    batches.push({
      batchId: r.batch_id,
      items: g.truncatedFrom ?? g.nodes.length,
      counts: countStates(g.nodes),
      snapshotAt: r.snapshot_at,
    });
  }
  const more = (rows[0]?.picked_n ?? 0) > opts.limit;
  return { batches, nextBefore: more ? (rows[0]?.page_last ?? null) : null };
}
