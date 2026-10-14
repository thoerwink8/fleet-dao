// 两条线（法国引擎 / 本机）的交付质量对比（决定 0093 的 A4）：近 7、30 天开的 PR，按线分开算
// 开→合中位和 p90（分钟）、一轮做成率、返工轮数、合并后 7 天内被回退/返修的比例。只读，一条 SQL。
//
// 怎么分线：看 PR 的分支前缀，fleet/ 是引擎，其余都是本机（本机会话、指挥官手工开的；0096 之后是 local/<单号>-）。
// 不靠 tasks.executor：那一列只对 0096 之后领过的单有值，老 PR 和没登记的会漏。
// 返工轮数：开 PR 之后又推过几次（github_events 里 pull_request/synchronize 的条数）。含合并前同步主线、修 CI 的推送，两条线同口径，
//   所以只拿来互相比，不当作「被打回几次」。一轮做成率＝已合并里一次都没再推过的占比。
// 回退/返修：同仓、合并后 7 天内开出的另一个 PR，标题或正文（取开 PR 事件）里「修/回退/revert/fix/返修/弄坏/坏了」后面 12 字内点名了 #本 PR 号（仓约定修复 PR 要写清是哪次合并弄坏的）。
//   只对合并已满 7 天的 PR 算（不满的观察期不够，不进分母）。正文读不到（事件已清）的只看标题。
// 读不到照抛，不拿空顶；某条线某个窗口一个 PR 都没有，该行 n_opened 为 0、各指标为 null。
import { sql } from 'drizzle-orm';
import type { Db } from '../client.ts';

export const EXECUTOR_LINE_WINDOWS_DAYS = [7, 30] as const;

/** `{{NOW}}` 换成 now() 或一个时刻字面量。 */
export const EXECUTOR_LINE_STATS_SQL = `
with params as (select {{NOW}}::timestamptz as now_at),
prs as (
  select p.repo_id, p.number, p.opened_at, p.merged_at, p.title,
         r.owner || '/' || r.name as repo,
         case when p.head_ref like 'fleet/%' then 'engine' else 'local' end as line
  from pull_requests p
  join repos r on r.id = p.repo_id, params
  where p.opened_at is not null and p.opened_at >= params.now_at - interval '30 days'
),
pr_events as materialized (
  -- github_events 没有按事件分的索引，只扫这一遍，推送条数和开 PR 正文都从这里取
  select repo, action, (payload->'pull_request'->>'number')::int as number,
         case when action = 'opened' then payload->'pull_request'->>'body' end as body, received_at
  from github_events, params
  where event = 'pull_request' and action in ('synchronize', 'opened')
    and received_at >= params.now_at - interval '31 days'
),
pushes as (
  select repo, number, count(*) as n from pr_events where action = 'synchronize' group by 1, 2
),
bodies as (
  select distinct on (repo, number) repo, number, body from pr_events where action = 'opened' order by repo, number, received_at
),
fixes as (
  select p.repo, p.number, p.opened_at, m[1]::int as ref
  from prs p
  left join bodies b on b.repo = p.repo and b.number = p.number
  cross join lateral regexp_matches(p.title || chr(10) || coalesce(b.body, ''),
    '(?:修|回退|revert|fix|返修|弄坏|坏了)[^\n#]{0,12}#([0-9]+)', 'gi') as m
),
joined as (
  select w.days, p.line, p.number, p.opened_at, p.merged_at, coalesce(s.n, 0) as pushes,
         extract(epoch from (p.merged_at - p.opened_at)) / 60 as mins,
         (p.merged_at is not null and p.merged_at <= params.now_at - interval '7 days') as observed,
         exists (
           select 1 from fixes f
           where f.repo = p.repo and f.ref = p.number and f.number <> p.number
             and f.opened_at > p.merged_at and f.opened_at <= p.merged_at + interval '7 days'
         ) as fixed
  from prs p
  cross join (values (7), (30)) as w(days)
  cross join params
  left join pushes s on s.repo = p.repo and s.number = p.number
  where p.opened_at >= params.now_at - make_interval(days => w.days)
)
select days, line,
       count(*)::int as n_opened,
       count(merged_at)::int as n_merged,
       round((percentile_cont(0.5) within group (order by mins))::numeric, 1) as open_to_merge_p50_min,
       round((percentile_cont(0.9) within group (order by mins))::numeric, 1) as open_to_merge_p90_min,
       round((count(*) filter (where merged_at is not null and pushes = 0))::numeric / nullif(count(merged_at), 0), 3) as one_round_rate,
       round((avg(pushes) filter (where merged_at is not null))::numeric, 2) as rework_pushes_avg,
       (count(*) filter (where observed))::int as n_observed_7d,
       round((count(*) filter (where observed and fixed))::numeric / nullif(count(*) filter (where observed), 0), 3) as fixed_within_7d_rate
from joined
group by days, line
order by days, line`;

export interface ExecutorLineStat {
  days: number;
  line: 'engine' | 'local';
  nOpened: number;
  nMerged: number;
  openToMergeP50Min: number | null;
  openToMergeP90Min: number | null;
  oneRoundRate: number | null;
  reworkPushesAvg: number | null;
  nObserved7d: number;
  fixedWithin7dRate: number | null;
}

/** 渲染成能直接跑的 SQL；`now` 不给就用库的 now()。 */
export function executorLineStatsSql(now?: Date): string {
  if (now && Number.isNaN(now.getTime())) throw new Error('executorLineStatsSql: 时刻不是有效日期');
  return EXECUTOR_LINE_STATS_SQL.replaceAll('{{NOW}}', now ? `'${now.toISOString()}'` : 'now()');
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function executorLineStats(db: Db, now?: Date): Promise<ExecutorLineStat[]> {
  const res: unknown = await db.execute(sql.raw(executorLineStatsSql(now)));
  // 驱动不同，结果可能是行数组，也可能包一层 { rows }。
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as Record<string, unknown>[];
  return rows.map((r) => ({
    days: Number(r.days),
    line: r.line as 'engine' | 'local',
    nOpened: Number(r.n_opened),
    nMerged: Number(r.n_merged),
    openToMergeP50Min: num(r.open_to_merge_p50_min),
    openToMergeP90Min: num(r.open_to_merge_p90_min),
    oneRoundRate: num(r.one_round_rate),
    reworkPushesAvg: num(r.rework_pushes_avg),
    nObserved7d: Number(r.n_observed_7d),
    fixedWithin7dRate: num(r.fixed_within_7d_rate),
  }));
}
