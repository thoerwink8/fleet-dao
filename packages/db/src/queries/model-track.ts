// 动手战绩按模型算（PLAN 3f，决定 0093）：选路给「动手」排模型用——每单期望花多少分钟、一轮做成率。
// 口径（和 _tmp/rethink/routescore/q2.sql 在法国库上查的同一个）：
// - 一单记在它第一段动手（runs.segment = manual）的模型名下：派给谁开头，这一单后面的返工就是选它的代价；
// - 只数算路由账的段（route_outcome 为 ok、fail）：发版排空打断、切号、被杀这些记 neutral 的不是模型的事，不算；
// - 只数到了终态的单（done、failed、stopped）：还在跑的不知道要几段。stopped 算没做成：法国库 10-14 查的近 7 天没做成的单
//   全是 stopped（failed 一单都没有），做不下去停下等人、人看了不再续的都落在这里，不算就看不见失败；
// - 第一段开工在 since 之后的单才算（窗口外开头的单不知道全貌）。
// 读不了照抛：调用方（选路）按「战绩没读成」退回人排的先后，不拿空当「大家都没战绩」。
import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { routes, runs, tasks } from '../schema/index.ts';

/** 一个模型的动手战绩。 */
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

const TERMINAL = ['done', 'failed', 'stopped'] as const;

export async function modelExecuteTracks(db: Db, since: Date): Promise<ModelTrack[]> {
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
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .leftJoin(routes, eq(routes.id, runs.routeId))
    .where(and(accountable, inArray(runs.taskId, recent), inArray(tasks.state, [...TERMINAL])));

  const byTask = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.taskId === null) continue;
    const list = byTask.get(r.taskId) ?? [];
    list.push(r);
    byTask.set(r.taskId, list);
  }
  const out = new Map<string, ModelTrack>();
  for (const list of byTask.values()) {
    list.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || (a.runId < b.runId ? -1 : 1));
    const first = list[0];
    if (!first || first.startedAt < since) continue;
    const modelId = first.routeModel ?? first.runModel;
    const t = out.get(modelId) ?? { modelId, tasks: 0, done: 0, oneRound: 0, segments: 0, segmentMinutes: 0 };
    const done = first.state === 'done';
    t.tasks += 1;
    if (done) t.done += 1;
    if (done && list.length === 1) t.oneRound += 1;
    t.segments += list.length;
    for (const r of list) {
      if (r.endedAt === null) throw new Error(`动手段 ${r.runId} 按结束了查出来，结束时刻却是空的`);
      t.segmentMinutes += Math.max(0, r.endedAt.getTime() - r.startedAt.getTime()) / 60_000;
    }
    out.set(modelId, t);
  }
  return [...out.values()].sort((a, b) => b.tasks - a.tasks || (a.modelId < b.modelId ? -1 : 1));
}
