// 动手战绩按模型算（PLAN 3f，决定 0093、0095、0098）：选路给「动手」排模型用。
// 两份口径共用同一批「算路由账的动手段」（和 _tmp/rethink/routescore/q2.sql 在法国库上查的同一个底）：
// - 只数算路由账的段（route_outcome 为 ok、fail）：发版排空打断、切号、被杀这些记 neutral 的不是模型的事，不算；
// - 只数到了终态的单（done、failed、stopped）：还在跑的不知道要几段。stopped 算没做成：法国库 10-14 查的近 7 天没做成的单
//   全是 stopped（failed 一单都没有），做不下去停下等人、人看了不再续的都落在这里，不算就看不见失败；
// - 第一段开工在 since 之后的单才算（窗口外开头的单不知道全貌）。
// modelExecuteTracks：一单整笔记在第一段动手的模型名下，后面别的模型接手的段也算它的（决定 0095，byTier 关掉时还用）。
// modelTierTracks：只记第一段（决定 0098）。接手返工的段不记在第一个模型名下，也不记到接手的那个模型头上；按档各出一行。
// 读不了照抛：调用方（选路）按「战绩没读成」退回人排的先后，不拿空当「大家都没战绩」。
import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { type RunTier, routes, runs, tasks } from '../schema/index.ts';

/** 一个模型的动手战绩（整单记在第一段的模型名下）。 */
export interface ModelTrack {
  modelId: string;
  /** 第一段动手是它、已到终态（done、failed、stopped）的单数。 */
  tasks: number;
  /** 其中做成（done）的。 */
  done: number;
  /** 其中一段就做成的（done，且这单只有一段算路由账的动手）。 */
  oneRound: number;
  /** 这些单一共跑了几段动手（算路由账的，含别的模型接手的段）。 */
  segments: number;
  /** 这些段一共跑了多少分钟（开跑到结束）。 */
  segmentMinutes: number;
}

/** 一个模型在一个派工档上的第一段动手战绩。四个结局互斥，加起来等于 firstSegs。 */
export interface ModelTierTrack {
  modelId: string;
  tier: RunTier;
  /** 第一段动手是它、这一档、已到终态的单数。 */
  firstSegs: number;
  /** 一段就做成（done，且这单只有一段算路由账的动手）。 */
  onePass: number;
  /** 后来又有算路由账的动手段（退回返工）。后面那些段不计入任何人的分钟和单数。 */
  sentBack: number;
  /** 只有一段、单没做成，可这一段自己的结局是 done 且没有 PR（会话收了场、没交出去）。 */
  noDeliver: number;
  /** 其余没做成（第一段失败、超时、被杀，或单停在 failed / stopped）。 */
  notDone: number;
  /** 只算第一段开跑到结束的分钟。 */
  minutes: number;
}

const TERMINAL = ['done', 'failed', 'stopped'] as const;
const TIER_ORDER: Record<RunTier, number> = { fast: 0, medium: 1, heavyweight: 2 };

interface AccountableRun {
  runId: string;
  taskId: string;
  runModel: string;
  routeModel: string | null;
  startedAt: Date;
  endedAt: Date | null;
  state: string;
  tier: string | null;
  outcome: string | null;
  prNumber: number | null;
}

/** 窗口里露过面的终态单，各自的算路由账动手段（按开跑先后）。第一段在窗口外的单还在里面，调用方丢掉。 */
async function loadAccountable(db: Db, since: Date): Promise<Map<string, AccountableRun[]>> {
  const accountable = and(
    eq(runs.segment, 'manual'),
    isNotNull(runs.endedAt),
    isNotNull(runs.taskId),
    inArray(runs.routeOutcome, ['ok', 'fail']),
  );
  const recent = db
    .select({ taskId: runs.taskId })
    .from(runs)
    .where(and(accountable, gte(runs.startedAt, since)));
  const rows = await db
    .select({
      runId: runs.id,
      taskId: runs.taskId,
      runModel: runs.model,
      routeModel: routes.modelId,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      state: tasks.state,
      tier: runs.tier,
      outcome: runs.outcome,
      prNumber: runs.prNumber,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .leftJoin(routes, eq(routes.id, runs.routeId))
    .where(and(accountable, inArray(runs.taskId, recent), inArray(tasks.state, [...TERMINAL])));

  const byTask = new Map<string, AccountableRun[]>();
  for (const r of rows) {
    if (r.taskId === null) continue;
    const list = byTask.get(r.taskId) ?? [];
    list.push({
      runId: r.runId,
      taskId: r.taskId,
      runModel: r.runModel,
      routeModel: r.routeModel,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      state: r.state,
      tier: r.tier,
      outcome: r.outcome,
      prNumber: r.prNumber,
    });
    byTask.set(r.taskId, list);
  }
  for (const list of byTask.values()) {
    list.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.runId < b.runId ? -1 : 1));
  }
  return byTask;
}

function minutesOf(run: AccountableRun): number {
  if (run.endedAt === null) throw new Error(`动手段 ${run.runId} 按结束了查出来，结束时刻却是空的`);
  return Math.max(0, run.endedAt.getTime() - run.startedAt.getTime()) / 60_000;
}

export async function modelExecuteTracks(db: Db, since: Date): Promise<ModelTrack[]> {
  const byTask = await loadAccountable(db, since);
  const out = new Map<string, ModelTrack>();
  for (const list of byTask.values()) {
    const first = list[0];
    if (!first || first.startedAt < since) continue;
    const modelId = first.routeModel ?? first.runModel;
    const t = out.get(modelId) ?? { modelId, tasks: 0, done: 0, oneRound: 0, segments: 0, segmentMinutes: 0 };
    const done = first.state === 'done';
    t.tasks += 1;
    if (done) t.done += 1;
    if (done && list.length === 1) t.oneRound += 1;
    t.segments += list.length;
    for (const r of list) t.segmentMinutes += minutesOf(r);
    out.set(modelId, t);
  }
  return [...out.values()].sort((a, b) => b.tasks - a.tasks || (a.modelId < b.modelId ? -1 : 1));
}

function asTier(tier: string | null, runId: string): RunTier | null {
  if (tier === null) return null;
  if (tier === 'fast' || tier === 'medium' || tier === 'heavyweight') return tier;
  throw new Error(`动手段 ${runId} 的档认不出（${tier}）`);
}

export async function modelTierTracks(db: Db, since: Date): Promise<ModelTierTrack[]> {
  const byTask = await loadAccountable(db, since);
  const out = new Map<string, ModelTierTrack>();
  for (const list of byTask.values()) {
    const first = list[0];
    if (!first || first.startedAt < since) continue;
    const tier = asTier(first.tier, first.runId);
    if (tier === null) continue;
    const modelId = first.routeModel ?? first.runModel;
    const key = `${modelId}\0${tier}`;
    const t = out.get(key) ?? {
      modelId,
      tier,
      firstSegs: 0,
      onePass: 0,
      sentBack: 0,
      noDeliver: 0,
      notDone: 0,
      minutes: 0,
    };
    const bucket =
      first.state === 'done' && list.length === 1
        ? 'onePass'
        : list.length > 1
          ? 'sentBack'
          : first.outcome === 'done' && first.prNumber == null
            ? 'noDeliver'
            : 'notDone';
    t.firstSegs += 1;
    t[bucket] += 1;
    t.minutes += minutesOf(first);
    out.set(key, t);
  }
  return [...out.values()].sort((a, b) => {
    if (a.firstSegs !== b.firstSegs) return b.firstSegs - a.firstSegs;
    if (a.modelId !== b.modelId) return a.modelId < b.modelId ? -1 : 1;
    return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
  });
}
