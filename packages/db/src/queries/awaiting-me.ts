// 等你的事（飞书单向通知的「等你拍板」「引擎问你」两类，提需求 F1 #2051）：
// - 等你拍板 = 还没处理的 decision 级提醒（人闸批准、要人拍的工作树、选路全熔断……都是这一级）；
// - 引擎问你 = 还没回答、而且挡路的提问：scope 为空（引擎自己等人）或 hold（碰人闸四类，合并前等批）。
//   scope 为 task / outside 的提问当场按推荐先做、不等回答（asks 表注释），不算「等你」。
// 只给 since 以后出现的：上线第一轮不把一堆老的全推一遍。
import { and, asc, eq, gte, isNull, or } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { asks, notifications } from '../schema/index.ts';

export interface AwaitingMeItem {
  kind: 'decision' | 'ask';
  /** 提醒或提问的编号（推送去重按它）。 */
  id: string;
  taskId: string | null;
  /** 一句话：提醒标题，或提问原文。 */
  title: string;
  /** 补充说明（提醒正文；提问没有）。 */
  detail: string;
  at: Date;
}

/** 老的在前，两类合在一起按出现时刻排。读不到照抛，不回空列表冒充「没有」。 */
export async function listAwaitingMe(db: Db, input: { since: Date }): Promise<AwaitingMeItem[]> {
  const decisions = await db
    .select({
      id: notifications.id,
      taskId: notifications.taskId,
      title: notifications.title,
      body: notifications.body,
      at: notifications.createdAt,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.level, 'decision'),
        isNull(notifications.resolvedAt),
        gte(notifications.createdAt, input.since),
      ),
    )
    .orderBy(asc(notifications.createdAt), asc(notifications.id));
  const questions = await db
    .select({ id: asks.id, taskId: asks.taskId, question: asks.question, at: asks.askedAt })
    .from(asks)
    .where(
      and(
        isNull(asks.answer),
        or(isNull(asks.scope), eq(asks.scope, 'hold')),
        gte(asks.askedAt, input.since),
      ),
    )
    .orderBy(asc(asks.askedAt), asc(asks.id));
  const items: AwaitingMeItem[] = [
    ...decisions.map((d) => ({
      kind: 'decision' as const,
      id: d.id,
      taskId: d.taskId,
      title: d.title,
      detail: d.body,
      at: d.at,
    })),
    ...questions.map((q) => ({
      kind: 'ask' as const,
      id: q.id,
      taskId: q.taskId,
      title: q.question,
      detail: '',
      at: q.at,
    })),
  ];
  return items.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : 1));
}
