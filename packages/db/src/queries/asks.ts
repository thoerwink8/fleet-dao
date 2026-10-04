// 单子里问创始人（#259）落地之后要读写的几样：引擎在存档点看晚到的回答、决定要不要照改（listTaskAsks），
// 改完记 markAsksApplied；listTaskAsks 现在只有测试在读（core 里按它记数、写 PR 正文的函数已在 #901 删掉）。
// follow_up_issue 这一栏原来由 GitHub 对账开单后回写，#530 删了那一步，现在只读、没人写；列留到删库表那一步。
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { asks } from '../schema/index.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TaskAskRow {
  id: string;
  taskId: string;
  runId: string | null;
  question: string;
  options: string[];
  askedAt: Date;
  answer: string | null;
  answeredAt: Date | null;
  scope: 'task' | 'outside' | 'hold' | null;
  recommended: string | null;
  hold: 'release' | 'spend' | 'delete' | 'standard' | null;
  followUpIssue: number | null;
  appliedAt: Date | null;
}

function mapAsk(row: typeof asks.$inferSelect): TaskAskRow {
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    question: row.question,
    options: row.options,
    askedAt: row.askedAt,
    answer: row.answer,
    answeredAt: row.answeredAt,
    scope: row.scope,
    recommended: row.recommended,
    hold: row.hold,
    followUpIssue: row.followUpIssue,
    appliedAt: row.appliedAt,
  };
}

/** 一张单的全部提问，按提问先后（asked_at、再按 id）。 */
export async function listTaskAsks(db: Db, taskId: string): Promise<TaskAskRow[]> {
  const rows = await db
    .select()
    .from(asks)
    .where(eq(asks.taskId, taskId))
    .orderBy(asc(asks.askedAt), asc(asks.id));
  return rows.map(mapAsk);
}

/**
 * 照改完：只给这张单的、已经回答了的、还没记过 applied_at 的几条记上 applied_at（别的单的、没回答的不动；
 * 已经记过的保留原来的时刻，不会被再次调用往后推）。回记上了几条；空列表不查库，直接回 0。
 * askIds 里有不是 UUID 的是调用方的错，抛错写明，不悄悄跳过。
 */
export async function markAsksApplied(
  db: Db,
  input: { taskId: string; askIds: readonly string[]; at: Date },
): Promise<number> {
  if (input.askIds.length === 0) return 0;
  const bad = input.askIds.filter((id) => !UUID.test(id));
  if (bad.length > 0) throw new Error(`markAsksApplied 收到不是 UUID 的提问编号：${bad.join('、')}`);
  const updated = await db
    .update(asks)
    .set({ appliedAt: input.at })
    .where(
      and(
        eq(asks.taskId, input.taskId),
        inArray(asks.id, [...input.askIds]),
        isNotNull(asks.answer),
        isNull(asks.appliedAt),
      ),
    )
    .returning({ id: asks.id });
  return updated.length;
}
