// 引擎的报警：同一件事（dedupe_key）一条、再报原地更新，按 dedupe_key 标成已处理，按前缀列还没处理的。
import {
  DECISION_REASONS,
  DecisionActionSchema,
  type DecisionOption,
  type DecisionReason,
  DecisionReasonSchema,
  decisionOptionsProblem,
} from '@fleet-dao/shared';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { notifications } from '../schema/index.ts';

/**
 * 「要你拍」落库前核一遍（统一写入口，#1915、#2729）：decision 级必须带至少两项选项（编号不重、恰好一项推荐）和原因
 * （DECISION_REASONS 之一：掏新钱、删了找不回、只有人能做）；别的级别两样都不能带。不合规矩的照抛，不悄悄存成没有选项、没有原因。
 * 选项可以不带 action（老数据、只留言），带了就要是认得出的动作。库里同样的 CHECK 约束兜底（直写表也绕不过去）。
 */
export function decisionFieldsFor(
  dedupeKey: string,
  level: 'alert' | 'decision' | 'daily',
  options: readonly DecisionOption[] | undefined,
  reason: DecisionReason | undefined,
): { decisionOptions: DecisionOption[] | null; decisionReason: DecisionReason | null } {
  if (level !== 'decision') {
    if (options !== undefined) throw new Error(`报警 ${dedupeKey} 是 ${level} 级，只有要人拍的才带选项`);
    if (reason !== undefined) throw new Error(`报警 ${dedupeKey} 是 ${level} 级，只有要人拍的才带原因`);
    return { decisionOptions: null, decisionReason: null };
  }
  if (!DecisionReasonSchema.safeParse(reason).success) {
    throw new Error(
      `报警 ${dedupeKey} 要你拍却没写原因（只认 ${DECISION_REASONS.join('、')}：掏新钱、删了找不回、只有人能做）；AI 自己能做的写成卡住报警或直接做掉`,
    );
  }
  return {
    decisionOptions: decisionOptionsFor(dedupeKey, level, options),
    decisionReason: reason as DecisionReason,
  };
}

/** decision 级的选项核一遍（decisionFieldsFor 调）：至少两项、编号不重、恰好一项推荐、动作认得出。 */
export function decisionOptionsFor(
  dedupeKey: string,
  level: 'alert' | 'decision' | 'daily',
  options: readonly DecisionOption[] | undefined,
): DecisionOption[] | null {
  if (options === undefined) {
    if (level === 'decision') {
      throw new Error(`报警 ${dedupeKey} 的选项不合规矩：要你拍的事至少给两个选项`);
    }
    return null;
  }
  if (level !== 'decision') throw new Error(`报警 ${dedupeKey} 是 ${level} 级，只有要人拍的才带选项`);
  const problem = decisionOptionsProblem(options);
  if (problem) throw new Error(`报警 ${dedupeKey} 的选项不合规矩：${problem}`);
  for (const option of options) {
    if (option.action === undefined) continue;
    const parsed = DecisionActionSchema.safeParse(option.action);
    if (!parsed.success) throw new Error(`报警 ${dedupeKey} 的选项 ${option.id} 的动作认不出`);
  }
  return [...options];
}

/**
 * 报警：同一件事（dedupe_key）只有一条，再报原地更新标题、正文、选项、updated_at（显式写），已处理的重新打开（resolved_at/by、
 * 上一次拍的答案清空：重开就是又要人拍一次）。
 * raised_at 是这一次挂起的起点：还开着再报留着原来的（条件没断，24 小时接着算）；从已处理重开才拨到这次。
 * created_at 始终是第一次报的时刻，不拿它当「挂了多久」。
 */
export async function upsertAlert(
  db: Db,
  input: {
    dedupeKey: string;
    level: 'alert' | 'decision' | 'daily';
    taskId: string | null;
    title: string;
    body: string;
    link?: string;
    /** 「要你拍」的选项（#1915）：只有 decision 级带。 */
    options?: readonly DecisionOption[];
    /** 为什么要创始人拍（#2729）：只有 decision 级带，且必须带。 */
    reason?: DecisionReason;
  },
): Promise<{ id: string; created: boolean }> {
  const now = new Date();
  const { decisionOptions, decisionReason } = decisionFieldsFor(
    input.dedupeKey,
    input.level,
    input.options,
    input.reason,
  );
  const [row] = await db
    .insert(notifications)
    .values({
      level: input.level,
      dedupeKey: input.dedupeKey,
      taskId: input.taskId,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
      decisionOptions,
      decisionReason,
      raisedAt: now,
    })
    .onConflictDoUpdate({
      target: notifications.dedupeKey,
      set: {
        level: input.level,
        taskId: input.taskId,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
        decisionOptions,
        decisionReason,
        updatedAt: now,
        resolvedAt: null,
        resolvedBy: null,
        answer: null,
        // 重开才拨这一次的起点。还开着时再报：resolved_at 仍是空，留着原来的 raised_at。
        // SET 各项按更新前的行算，这里看见的 resolved_at 是重开前的，不会被上面那句清掉的赋值盖住。
        raisedAt: sql`case when ${notifications.resolvedAt} is not null then excluded.raised_at else ${notifications.raisedAt} end`,
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

/**
 * 只在这条报警从 since 以来没再报过时标成已处理（#3036，冷验收检出恢复撤卡）：一次检出 since 开跑、成功了，
 * 它只能证明 since 之前报的那次故障好了；since 之后又报（updated_at 拨到更晚）的是新故障，不许被这张旧回执撤掉，回 changed。
 * 已处理的不动回 already_resolved；没有这条回 not_found。
 */
export async function resolveAlertIfUnchangedSince(
  db: Db,
  input: { dedupeKey: string; by: string; since: Date; at?: Date },
): Promise<'ok' | 'changed' | 'already_resolved' | 'not_found'> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(notifications)
    .set({ resolvedAt: at, resolvedBy: input.by, updatedAt: at })
    .where(
      and(
        eq(notifications.dedupeKey, input.dedupeKey),
        isNull(notifications.resolvedAt),
        lt(notifications.updatedAt, input.since),
      ),
    )
    .returning({ id: notifications.id });
  if (row) return 'ok';
  const [existing] = await db
    .select({ resolvedAt: notifications.resolvedAt })
    .from(notifications)
    .where(eq(notifications.dedupeKey, input.dedupeKey));
  if (!existing) return 'not_found';
  return existing.resolvedAt === null ? 'changed' : 'already_resolved';
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
