// 引擎的报警：同一件事（dedupe_key）一条、再报原地更新，按 dedupe_key 标成已处理，按前缀列还没处理的。
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { notifications } from '../schema/index.ts';

/** 报警：同一件事（dedupe_key）只有一条，再报原地更新标题、正文、updated_at（显式写），已处理的重新打开（resolved_at/by 清空）。 */
export async function upsertAlert(
  db: Db,
  input: {
    dedupeKey: string;
    level: 'alert' | 'decision' | 'daily';
    taskId: string | null;
    title: string;
    body: string;
    link?: string;
  },
): Promise<{ id: string; created: boolean }> {
  const now = new Date();
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
    .onConflictDoUpdate({
      target: notifications.dedupeKey,
      set: {
        level: input.level,
        taskId: input.taskId,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
        updatedAt: now,
        resolvedAt: null,
        resolvedBy: null,
      },
    })
    // xmax = 0 只在这一行是刚插入（不是走 on conflict 更新）时成立，是判断「插成还是原地更新」的标准写法。
    .returning({ id: notifications.id, created: sql<boolean>`(xmax = 0)` });
  if (!row) throw new Error(`报警 ${input.dedupeKey} 写不进去`);
  return { id: row.id, created: row.created };
}

/**
 * 按 dedupe_key 把一条报警标成已处理（引擎看到事情好了：挂起的账号池跑通了一次会话）。已处理的不动（不改处理人、处理时刻），
 * 回 already_resolved；没有这条回 not_found——调用方分得清「处理掉了」「本来就处理过」「根本没报过」。
 */
export async function resolveAlertByKey(
  db: Db,
  input: { dedupeKey: string; by: string; at?: Date },
): Promise<'ok' | 'already_resolved' | 'not_found'> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(notifications)
    .set({ resolvedAt: at, resolvedBy: input.by, updatedAt: at })
    .where(and(eq(notifications.dedupeKey, input.dedupeKey), isNull(notifications.resolvedAt)))
    .returning({ id: notifications.id });
  if (row) return 'ok';
  const [existing] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.dedupeKey, input.dedupeKey));
  return existing ? 'already_resolved' : 'not_found';
}

export interface OpenAlert {
  id: string;
  dedupeKey: string;
  level: 'decision' | 'alert' | 'daily';
  taskId: string | null;
  title: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 还没处理的、dedupe_key 以 prefix 开头的报警，老的在前（例如 `pool-hold:` 找出被挂起的账号池）。
 * 按前缀逐字比（starts_with），不走 LIKE：前缀里的 % 和 _ 不会变成通配符。空前缀等于全表，明确拒绝。
 */
export async function openAlertsByPrefix(db: Db, prefix: string): Promise<OpenAlert[]> {
  if (!prefix) throw new Error('报警前缀是空的：那等于把所有没处理的报警都拿出来');
  return db
    .select({
      id: notifications.id,
      dedupeKey: notifications.dedupeKey,
      level: notifications.level,
      taskId: notifications.taskId,
      title: notifications.title,
      body: notifications.body,
      createdAt: notifications.createdAt,
      updatedAt: notifications.updatedAt,
    })
    .from(notifications)
    .where(and(isNull(notifications.resolvedAt), sql`starts_with(${notifications.dedupeKey}, ${prefix})`))
    .orderBy(asc(notifications.createdAt), asc(notifications.id));
}

/** 这个任务还没处理的提醒键。任务收尾时用来找挂起提醒。 */
export async function openAlertKeysOfTask(db: Db, taskId: string): Promise<string[]> {
  const rows = await db
    .select({ dedupeKey: notifications.dedupeKey })
    .from(notifications)
    .where(and(eq(notifications.taskId, taskId), isNull(notifications.resolvedAt)));
  return rows.map((row) => row.dedupeKey);
}
