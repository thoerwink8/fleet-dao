// 渠道顺延（#1118）：每次起会话的尝试落库、渠道运行中失败标 disabled 并写顺到谁、探针探通改回 ok。
// 表的来龙去脉在 schema/channel-fallback.ts；选路怎么读 channel_states 在 queries/candidates.ts 的 evaluateRoutes。
//
// 改这里之前必须知道：
// - 读写出错一律原样抛，不返回空、不当成「没有这一行 = ok」：没有行是 ok 只在「这个渠道真没出过事」时成立，
//   读失败（库连不上、表缺）是另一回事，调用方要看见（选路因此派不出去、报人，不会把 disabled 的渠道当成 ok 派过去）。
// - 标 disabled 是覆盖写：同一个渠道再失败，原因换成最新的、顺到谁清空（等下一次选路再写）、flagged_at 不重置。
// - 探针改回 ok 只认引发这次 disabled 的那条路由（failed_route_id）；它被删了置空，渠道下任一路由探通就改回。
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { channelAttempts, channelStates, routes } from '../schema/index.ts';

const MESSAGE_MAX = 500;

export interface ChannelAttemptWrite {
  /** runs 行的编号；会话没起来（没写 runs）不给。 */
  runId?: string | undefined;
  /** tasks.id；不属于哪张单不给。 */
  taskId?: string | undefined;
  modelId: string;
  routeId: string;
  channelId: string;
  /** 失败的原因码；成了不给。给了必须带 message。 */
  errorType?: string | undefined;
  message?: string | undefined;
  startedAt: Date;
  endedAt: Date;
}

/** 记一次起会话的尝试。attempt_idx 由库按这张单已有的最大值加一算（不属于哪张单的恒为 1）。 */
export async function recordChannelAttempt(db: Db, a: ChannelAttemptWrite): Promise<void> {
  const next =
    a.taskId === undefined
      ? sql`1`
      : sql`coalesce((select max(${channelAttempts.attemptIdx}) from ${channelAttempts} where ${channelAttempts.taskId} = ${a.taskId}), 0) + 1`;
  await db.insert(channelAttempts).values({
    runId: a.runId ?? null,
    taskId: a.taskId ?? null,
    attemptIdx: next,
    modelId: a.modelId,
    routeId: a.routeId,
    channelId: a.channelId,
    errorType: a.errorType ?? null,
    message: a.message === undefined ? null : a.message.slice(0, MESSAGE_MAX),
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    durationMs: Math.max(0, a.endedAt.getTime() - a.startedAt.getTime()),
  });
}

export interface ChannelDisableWrite {
  channelId: string;
  /** 引发的那条路由：探针探通它才改回 ok。 */
  routeId: string;
  /** 为什么（失败分流的原因）；必填，空的不收。 */
  reason: string;
  now: Date;
}

/** 渠道运行中失败：标 disabled、写原因。已经 disabled 的覆盖原因、保留 flagged_at、清掉旧的「顺到谁」。 */
export async function markChannelDisabled(db: Db, w: ChannelDisableWrite): Promise<void> {
  const reason = w.reason.trim().slice(0, MESSAGE_MAX * 2);
  if (reason === '') throw new Error(`渠道 ${w.channelId} 标 disabled 没带原因，不写`);
  await db
    .insert(channelStates)
    .values({
      channelId: w.channelId,
      status: 'disabled',
      reason,
      failedRouteId: w.routeId,
      flaggedAt: w.now,
      updatedAt: w.now,
    })
    .onConflictDoUpdate({
      target: channelStates.channelId,
      set: {
        status: 'disabled',
        reason,
        failedRouteId: w.routeId,
        fallbackChannelId: null,
        fallbackModelId: null,
        flaggedAt: sql`case when ${channelStates.status} = 'disabled' then ${channelStates.flaggedAt} else excluded.flagged_at end`,
        updatedAt: w.now,
      },
    });
}

/** 选路给这个失败渠道派到了谁：记下去。渠道现在不是 disabled（探针刚改回）不写，回 false。 */
export async function setChannelFallback(
  db: Db,
  w: { channelId: string; fallbackChannelId: string; fallbackModelId: string; now: Date },
): Promise<boolean> {
  const done = await db
    .update(channelStates)
    .set({ fallbackChannelId: w.fallbackChannelId, fallbackModelId: w.fallbackModelId, updatedAt: w.now })
    .where(and(eq(channelStates.channelId, w.channelId), eq(channelStates.status, 'disabled')))
    .returning({ id: channelStates.channelId });
  return done.length > 0;
}

export interface ChannelStateRow {
  channelId: string;
  status: 'ok' | 'disabled';
  reason: string | null;
  failedRouteId: string | null;
  fallbackChannelId: string | null;
  fallbackModelId: string | null;
  lastProbedAt: Date | null;
  flaggedAt: Date | null;
  updatedAt: Date;
}

/** 渠道近态，按渠道编号索引；没有行的渠道没出过事（按 ok 读）。读不到原样抛。给 channelIds 只读这几个。 */
export async function readChannelStates(
  db: Db,
  channelIds?: readonly string[],
): Promise<Map<string, ChannelStateRow>> {
  if (channelIds !== undefined && channelIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(channelStates)
    .where(channelIds === undefined ? undefined : inArray(channelStates.channelId, [...channelIds]));
  return new Map(rows.map((r) => [r.channelId, r]));
}

/**
 * 路由探针下了一条结论之后调（saveRouteProbe 在同一个事务里调）：这条路由所在渠道的 last_probed_at 记下；
 * 结论是 ok 且这就是引发 disabled 的那条路由（或那条已被删）就改回 ok。回 true = 这一下把渠道改回了 ok。
 */
export async function noteRouteProbed(
  db: Db,
  w: { routeId: string; state: string; at: Date },
): Promise<boolean> {
  const [route] = await db
    .select({ channelId: routes.channelId })
    .from(routes)
    .where(eq(routes.id, w.routeId));
  if (!route) return false;
  await db
    .update(channelStates)
    .set({ lastProbedAt: w.at })
    .where(eq(channelStates.channelId, route.channelId));
  if (w.state !== 'ok') return false;
  const restored = await db
    .update(channelStates)
    .set({
      status: 'ok',
      reason: `路由探针探通了 ${w.routeId}，渠道恢复`,
      failedRouteId: null,
      fallbackChannelId: null,
      fallbackModelId: null,
      flaggedAt: null,
      updatedAt: w.at,
    })
    .where(
      and(
        eq(channelStates.channelId, route.channelId),
        eq(channelStates.status, 'disabled'),
        or(eq(channelStates.failedRouteId, w.routeId), isNull(channelStates.failedRouteId)),
      ),
    )
    .returning({ id: channelStates.channelId });
  return restored.length > 0;
}
