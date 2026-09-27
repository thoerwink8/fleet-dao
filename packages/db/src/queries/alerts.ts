// 提醒（notifications）的对账要用的查询：列出没处理的、按前缀连同已处理的一起列、按条件撤掉（写明谁撤的、为什么，
// 进操作记录）、只在没有时插一条（再提醒一天一条）、只改还开着的（不把人刚处理掉的又打开）。
// 报警本身的写法（同一件事一条、再报原地更新）在 engine.ts 的 upsertAlert。
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, notifications } from '../schema/index.ts';

export interface AlertRow {
  id: string;
  dedupeKey: string;
  level: 'decision' | 'alert' | 'daily';
  taskId: string | null;
  title: string;
  body: string;
  link: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  /** 谁处理掉的：人是用户编号，系统写自己的名字（engine:…、auto-release、fleet-backup……）。 */
  resolvedBy: string | null;
}

/**
 * GitHub 两个机器人的权限自检（引擎每小时对账，engine 的 jobs/github-app-check.ts）报的提醒都用这个前缀
 * （github-app:<机器人>:<仓>）；开着就让驾驶舱后端的健康检查 github_app 那一项红，权限好了引擎下一轮自己撤、跟着回绿。
 */
export const GITHUB_APP_ALERT_PREFIX = 'github-app:';

const columns = {
  id: notifications.id,
  dedupeKey: notifications.dedupeKey,
  level: notifications.level,
  taskId: notifications.taskId,
  title: notifications.title,
  body: notifications.body,
  link: notifications.link,
  createdAt: notifications.createdAt,
  updatedAt: notifications.updatedAt,
  resolvedAt: notifications.resolvedAt,
  resolvedBy: notifications.resolvedBy,
};

/**
 * 没处理的提醒，老的在前，最多 limit 条；多出来的回 truncated=true（调用方照实说没看全，不当成只有这么多）。
 */
export async function listOpenAlerts(
  db: Db,
  options: { limit: number },
): Promise<{ alerts: AlertRow[]; truncated: boolean }> {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error(`limit 要是正整数：${options.limit}`);
  }
  const rows = await db
    .select(columns)
    .from(notifications)
    .where(isNull(notifications.resolvedAt))
    .orderBy(asc(notifications.createdAt), asc(notifications.id))
    .limit(options.limit + 1);
  return { alerts: rows.slice(0, options.limit), truncated: rows.length > options.limit };
}

/** 这个键的那一条（处理没处理都给）；没有回 null。 */
export async function alertByKey(db: Db, dedupeKey: string): Promise<AlertRow | null> {
  const [row] = await db.select(columns).from(notifications).where(eq(notifications.dedupeKey, dedupeKey));
  return row ?? null;
}

/**
 * dedupe_key 以 prefix 开头的最新一条（处理没处理都算，按建立时刻）。按前缀逐字比（starts_with），前缀里的 % 和 _
 * 不当通配符；空前缀明确拒绝（那等于全表）。
 */
export async function latestAlertByPrefix(db: Db, prefix: string): Promise<AlertRow | null> {
  if (!prefix) throw new Error('报警前缀是空的：那等于把所有报警都拿出来');
  const [row] = await db
    .select(columns)
    .from(notifications)
    .where(sql`starts_with(${notifications.dedupeKey}, ${prefix})`)
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(1);
  return row ?? null;
}

/**
 * 按条件撤掉一条（事情好了、没人再需要它）：标成已处理、处理人记 by，正文开头加一行「已撤：<why>」（驾驶舱和飞书卡片上
 * 一眼看得到为什么没了），同一事务里记一条操作记录（引擎做的，actor 是 auditActor，不给就是 by；reason 就是 why）。
 * by 和 auditActor 分开：人在再提醒上点了处理、引擎替他把原来那条也撤掉时，处理人记那个人，操作记录记是引擎做的。
 * 已经处理过的不动，回 already_resolved；没有这条回 not_found。
 */
export async function resolveAlertWithReason(
  db: Db,
  input: { dedupeKey: string; by: string; why: string; at?: Date; auditActor?: string },
): Promise<'ok' | 'already_resolved' | 'not_found'> {
  const why = input.why.trim();
  if (!why) throw new Error(`撤提醒 ${input.dedupeKey} 没写为什么`);
  const at = input.at ?? new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(notifications)
      .set({
        resolvedAt: at,
        resolvedBy: input.by,
        updatedAt: at,
        body: sql`${`已撤：${why}`} || case when ${notifications.body} = '' then '' else ${'\n\n'} || ${notifications.body} end`,
      })
      .where(and(eq(notifications.dedupeKey, input.dedupeKey), isNull(notifications.resolvedAt)))
      .returning({ id: notifications.id });
    if (!row) {
      const [existing] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.dedupeKey, input.dedupeKey));
      return existing ? 'already_resolved' : 'not_found';
    }
    await tx.insert(auditLog).values({
      at,
      actorKind: 'engine',
      actorId: input.auditActor ?? input.by,
      action: 'notification.resolve',
      target: `notification:${row.id}`,
      reason: why,
      via: 'engine',
    });
    return 'ok';
  });
}

/**
 * 只在这个键还没有时插一条（有了——开着的、已处理的都算——一概不动）：一天一条的再提醒靠它，重跑、两轮叠着跑都不会多出第二条，
 * 也不会把人已经处理掉的那条又打开。
 */
export async function insertAlertOnce(
  db: Db,
  input: {
    dedupeKey: string;
    level: 'alert' | 'decision';
    taskId: string | null;
    title: string;
    body: string;
    link?: string | null;
  },
): Promise<{ id: string; created: boolean }> {
  const [row] = await db
    .insert(notifications)
    .values({
      level: input.level,
      dedupeKey: input.dedupeKey,
      taskId: input.taskId,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
    })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id });
  if (row) return { id: row.id, created: true };
  const existing = await alertByKey(db, input.dedupeKey);
  if (!existing) throw new Error(`报警 ${input.dedupeKey} 写不进也读不到`);
  return { id: existing.id, created: false };
}

/** 改一条还开着的提醒的标题、正文（原地改卡）。已经处理掉的不动（不替人把它打开），回 not_open；没有这条也是 not_open。 */
export async function updateOpenAlert(
  db: Db,
  input: { dedupeKey: string; title?: string; body?: string; at?: Date },
): Promise<'ok' | 'not_open'> {
  if (input.title === undefined && input.body === undefined) throw new Error('什么都没给，改不了');
  const at = input.at ?? new Date();
  const [row] = await db
    .update(notifications)
    .set({
      updatedAt: at,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.body === undefined ? {} : { body: input.body }),
    })
    .where(and(eq(notifications.dedupeKey, input.dedupeKey), isNull(notifications.resolvedAt)))
    .returning({ id: notifications.id });
  return row ? 'ok' : 'not_open';
}
