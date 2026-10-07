// 按单指定模型（task_route_pins，表的来龙去脉在 schema/runs.ts）：驾驶舱写、引擎选路读。
//
// 改这里之前必须知道：
// - 读写出错一律原样抛：读不到不当成「没指定」（那样引擎会悄悄按自动派，人以为指定了的模型在跑）。
// - 写之前核对：单子在不在、模型在不在目录里、下没下架、钉的路由是不是这个模型的；不对回 not_found / invalid 和一句人话，
//   库里一行不动。
// - 清掉指定不删行：model_id、route_id 写空，谁什么时候清的留着。
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { models, type RoutedSegment, routes, taskRoutePins, tasks } from '../schema/index.ts';

export interface TaskRoutePin {
  taskId: string;
  segment: RoutedSegment;
  /** null = 自动。 */
  modelId: string | null;
  routeId: string | null;
  setBy: string;
  setAt: Date;
  reason: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toPin(row: typeof taskRoutePins.$inferSelect): TaskRoutePin {
  return {
    taskId: row.taskId,
    segment: row.segment,
    modelId: row.modelId,
    routeId: row.routeId,
    setBy: row.setBy,
    setAt: row.setAt,
    reason: row.reason,
  };
}

/** 这张单这一段的指定；从没指定过回 null。编号不是 uuid 回 null（不是库里的单，谈不上指定）。 */
export async function readTaskRoutePin(
  db: Db,
  taskId: string,
  segment: RoutedSegment,
): Promise<TaskRoutePin | null> {
  if (!UUID.test(taskId)) return null;
  const [row] = await db
    .select()
    .from(taskRoutePins)
    .where(and(eq(taskRoutePins.taskId, taskId), eq(taskRoutePins.segment, segment)));
  return row ? toPin(row) : null;
}

/** 这张单所有段的指定（含清掉了的），按段排。 */
export async function listTaskRoutePins(db: Db, taskId: string): Promise<TaskRoutePin[]> {
  if (!UUID.test(taskId)) return [];
  const rows = await db.select().from(taskRoutePins).where(eq(taskRoutePins.taskId, taskId));
  return rows.map(toPin).sort((a, b) => a.segment.localeCompare(b.segment));
}

export interface SetTaskRoutePinInput {
  taskId: string;
  segment: RoutedSegment;
  modelId: string | null;
  routeId: string | null;
  setBy: string;
  setAt: Date;
  reason?: string | undefined;
}

export type SetTaskRoutePinResult =
  | { ok: true; before: TaskRoutePin | null; after: TaskRoutePin }
  | { ok: false; kind: 'not_found' | 'invalid'; why: string };

/** 指定或清掉一段的模型（覆盖写）。核对不过回 ok: false，库里不动；写不进照抛。 */
export async function setTaskRoutePin(db: Db, input: SetTaskRoutePinInput): Promise<SetTaskRoutePinResult> {
  if (!UUID.test(input.taskId)) return { ok: false, kind: 'not_found', why: '没有这个任务' };
  const [task] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, input.taskId));
  if (!task) return { ok: false, kind: 'not_found', why: '没有这个任务' };
  if (input.modelId === null && input.routeId !== null) {
    return { ok: false, kind: 'invalid', why: '清掉指定时不能只留路由' };
  }
  if (input.modelId !== null) {
    const [model] = await db
      .select({ id: models.id, retiredAt: models.retiredAt })
      .from(models)
      .where(eq(models.id, input.modelId));
    if (!model) return { ok: false, kind: 'invalid', why: `模型目录里没有「${input.modelId}」` };
    if (model.retiredAt && model.retiredAt.getTime() <= input.setAt.getTime()) {
      return { ok: false, kind: 'invalid', why: `「${input.modelId}」已经下架，选路不会派它` };
    }
    if (input.routeId !== null) {
      const [route] = await db
        .select({ modelId: routes.modelId })
        .from(routes)
        .where(eq(routes.id, input.routeId));
      if (!route) return { ok: false, kind: 'invalid', why: `没有「${input.routeId}」这条路由` };
      if (route.modelId !== input.modelId) {
        return {
          ok: false,
          kind: 'invalid',
          why: `路由「${input.routeId}」跑的是 ${route.modelId}，不是指定的 ${input.modelId}`,
        };
      }
    }
  }
  const before = await readTaskRoutePin(db, input.taskId, input.segment);
  const values = {
    modelId: input.modelId,
    routeId: input.routeId,
    setBy: input.setBy,
    setAt: input.setAt,
    reason: input.reason?.trim() ? input.reason.trim() : null,
  };
  const [row] = await db
    .insert(taskRoutePins)
    .values({ taskId: input.taskId, segment: input.segment, ...values })
    .onConflictDoUpdate({ target: [taskRoutePins.taskId, taskRoutePins.segment], set: values })
    .returning();
  if (!row) throw new Error(`任务 ${input.taskId} 的${input.segment}段指定没写进去（库没回这一行）`);
  return { ok: true, before, after: toPin(row) };
}
