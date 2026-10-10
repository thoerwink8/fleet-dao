// 任务列表页（驾驶舱 /tasks，#1639）读 tasks 表：按最近更新从新到旧翻页，各状态的数。
// 状态分组的规则和内存版 Store 是同一份（shared 的 task-list.ts）：这里是它的 SQL 写法，两边的契约测试对着同一批数据。
// 改这里之前必须知道：
// - 「最近更新」= 开单时刻、快照写入（tasks.updated_at，可空）、状态最近一次变化（state_changes）三者里最晚的，截到毫秒，和翻页游标一个精度。
// - 搜索：全是数字（可带 #）按单号精确找，也找标题里带这串数字的；其余按标题包含，不分大小写。% _ \ 当普通字符找。
import { TASK_LIST_GROUPS, type Task, type TaskListGroup } from '@fleet-dao/shared';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { toTask } from '../domain-map.ts';
import { tasks } from '../schema/index.ts';

export interface TaskListFilter {
  group?: TaskListGroup | undefined;
  /** 必须是 uuid；调用方先判。 */
  repoId?: string | undefined;
  q?: string | undefined;
}

export interface TaskListRowRecord {
  task: Task;
  /** 毫秒精度的 ISO 时刻。 */
  updatedAt: string;
}

/** 每张单所属的组：和 shared 的 taskListGroupOf 一字不差的 SQL 写法。 */
const groupExpr = sql<TaskListGroup>`(case
  when ${tasks.state} = 'done' then 'done'
  when ${tasks.state} = 'failed' then 'failed'
  when ${tasks.state} = 'stopped' then 'stopped'
  when ${tasks.phase} = 'paused' then 'waiting'
  when ${tasks.state} in ('asking', 'stalled') then 'waiting'
  when ${tasks.state} = 'queued' then 'queued'
  else 'running' end)`;

// 子查询里的列名写死成带表名的字面量：drizzle 单表查询时列名会去掉表名前缀，「task_id = id」会把 id 认成 state_changes 自己的。
// （greatest 忽略空值：updated_at 没写过、没有状态变化行都不影响。）
const updatedExpr = sql`date_trunc('milliseconds', greatest(${tasks.createdAt}, ${tasks.updatedAt}, (select max(sc.at) from state_changes sc where sc.task_id = tasks.id)))`;

/** LIKE 里的 % _ \ 当普通字符。 */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function searchWhere(raw: string | undefined): SQL | undefined {
  const q = raw?.trim();
  if (!q) return undefined;
  const byTitle = sql`${tasks.title} ilike ${`%${likeEscape(q)}%`}`;
  const issue = /^#?(\d{1,9})$/.exec(q);
  return issue ? sql`(${tasks.issueNumber} = ${Number(issue[1])} or ${byTitle})` : byTitle;
}

function baseWhere(filter: Pick<TaskListFilter, 'repoId' | 'q'>): (SQL | undefined)[] {
  return [filter.repoId === undefined ? undefined : eq(tasks.repoId, filter.repoId), searchWhere(filter.q)];
}

/** 一页：按 (最近更新, 编号) 倒序；多取一条判有没有下一页。cursor 是上一页最后一条的 (updatedAt, taskId)。 */
export async function listTaskRows(
  db: Db,
  filter: TaskListFilter & { cursor?: { at: string; id: string } | null | undefined; limit: number },
): Promise<{ rows: TaskListRowRecord[]; hasMore: boolean }> {
  const found = await db
    .select({ task: tasks, updatedAt: updatedExpr.mapWith(tasks.createdAt) })
    .from(tasks)
    .where(
      and(
        ...baseWhere(filter),
        filter.group === undefined ? undefined : sql`${groupExpr} = ${filter.group}`,
        filter.cursor
          ? sql`(${updatedExpr}, ${tasks.id}) < (${filter.cursor.at}::timestamptz, ${filter.cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(updatedExpr), desc(tasks.id))
    .limit(filter.limit + 1);
  return {
    rows: found
      .slice(0, filter.limit)
      .map((r) => ({ task: toTask(r.task), updatedAt: r.updatedAt.toISOString() })),
    hasMore: found.length > filter.limit,
  };
}

/** 各组的数，受仓和搜索影响、不受组影响；没有的组是 0。 */
export async function countTaskGroups(
  db: Db,
  filter: Pick<TaskListFilter, 'repoId' | 'q'>,
): Promise<Record<TaskListGroup, number>> {
  const rows = await db
    .select({ group: groupExpr, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(...baseWhere(filter)))
    .groupBy(groupExpr);
  const out = Object.fromEntries(TASK_LIST_GROUPS.map((g) => [g, 0])) as Record<TaskListGroup, number>;
  for (const r of rows) out[r.group] = r.n;
  return out;
}
