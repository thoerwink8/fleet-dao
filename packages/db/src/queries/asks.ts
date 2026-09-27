// 单子里问创始人（#259）落地之后要读写的几样：引擎在存档点看晚到的回答、决定要不要照改（listTaskAsks），
// 改完记 markAsksApplied；开 PR 写「按推荐先做了」、关单记数（core 的 tallyAsks）也从 listTaskAsks 读。
// GitHub 对账（每 15 分钟一轮）拿 askIssueCandidates 粗筛出「该开后续单」「超出范围该开单」的提问（开不开、怎么开单
// 由 core 和引擎判，这里只挑候选），开完单用 setAskFollowUpIssue 回写单号。
import type { TaskState } from '@fleet-dao/shared';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { asks, repos, tasks } from '../schema/index.ts';

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

export interface AskIssueCandidate {
  ask: TaskAskRow;
  taskState: TaskState;
  taskTitle: string;
  issueNumber: number;
  repo: { owner: string; name: string };
}

/**
 * 对账要看的提问（粗筛，开不开单由 core 判）：
 * (a) scope = 'outside' 且（follow_up_issue 为空，或回答了、applied_at 还空着——回答要写到另开的那张单上，写上了记
 *     applied_at，之后不再进来）；
 * (b) scope in ('task','hold')、回答了、follow_up_issue 为空、applied_at 为空、btrim(answer) <> btrim(recommended)、
 *     这张单 tasks.state = 'done'（改选了别的、原单已经合了，要开后续单）。
 * 老式提问（scope 为空）两条都进不来。连上 tasks（state、title、issue_number）和 repos（owner、name），
 * 按 asked_at、id 排。
 */
export async function askIssueCandidates(db: Db): Promise<AskIssueCandidate[]> {
  const rows = await db
    .select({
      ask: asks,
      taskState: tasks.state,
      taskTitle: tasks.title,
      issueNumber: tasks.issueNumber,
      owner: repos.owner,
      name: repos.name,
    })
    .from(asks)
    .innerJoin(tasks, eq(tasks.id, asks.taskId))
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(
      or(
        and(
          eq(asks.scope, 'outside'),
          or(isNull(asks.followUpIssue), and(isNotNull(asks.answer), isNull(asks.appliedAt))),
        ),
        and(
          inArray(asks.scope, ['task', 'hold']),
          isNotNull(asks.answer),
          isNull(asks.followUpIssue),
          isNull(asks.appliedAt),
          eq(tasks.state, 'done'),
          sql`btrim(${asks.answer}) <> btrim(${asks.recommended})`,
        ),
      ),
    )
    .orderBy(asc(asks.askedAt), asc(asks.id));
  return rows.map((r) => ({
    ask: mapAsk(r.ask),
    taskState: r.taskState,
    taskTitle: r.taskTitle,
    issueNumber: r.issueNumber,
    repo: { owner: r.owner, name: r.name },
  }));
}

/**
 * 回写另开的单号：只在还空着时写。ok = 写上了；same = 本来就是这个号（不重写，也不报错）；
 * conflict = 已经是别的号（不动）；not_found = 没这条。issueNumber 不是正整数是调用方的错，抛错。
 */
export async function setAskFollowUpIssue(
  db: Db,
  input: { askId: string; issueNumber: number },
): Promise<'ok' | 'same' | 'conflict' | 'not_found'> {
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error(`issueNumber 要是正整数：${input.issueNumber}`);
  }
  const updated = await db
    .update(asks)
    .set({ followUpIssue: input.issueNumber })
    .where(and(eq(asks.id, input.askId), isNull(asks.followUpIssue)))
    .returning({ id: asks.id });
  if (updated.length > 0) return 'ok';
  const [existing] = await db
    .select({ followUpIssue: asks.followUpIssue })
    .from(asks)
    .where(eq(asks.id, input.askId));
  if (!existing) return 'not_found';
  return existing.followUpIssue === input.issueNumber ? 'same' : 'conflict';
}
