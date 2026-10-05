// 引擎起来时把退役的 Temporal 定时任务（jobs/retired-schedules.ts 的共用名单）删掉的真装配。这一步不经 Temporal 活动、
// 直接拿 db（和 session-io.ts 的 reportIoRoot 同一个道理）：删成了、本来就没有都不算问题，只有删不掉要能被人看
// 见——经 upsertAlert 写库，日报能捞到（不是当场要人拍的事，没必要推卡片）；好了自动撤，不用人去点「处理」。
// 删的这一步本身从不抛出（jobs/retired-schedules.ts 的 deleteRetiredSchedules 已经保证），不当成挡引擎接活的理由。
import { type Db, resolveAlertWithReason, upsertAlert } from '@fleet-dao/db';
import type { Client } from '@temporalio/client';
import {
  deleteRetiredSchedules,
  RETIRED_SCHEDULES,
  type RetiredSchedule,
} from '../jobs/retired-schedules.ts';

/** 这份提醒的键前缀：一个退役任务一条，好了自动撤。 */
export const RETIRED_SCHEDULE_ALERT_PREFIX = 'retired-schedule:';

export type RetireScheduleLog = (
  level: 'info' | 'error',
  text: string,
  fields?: Record<string, unknown>,
) => void;

const defaultLog: RetireScheduleLog = (level, text, fields) => console[level](text, fields ?? {});

/**
 * 引擎每次起都跑一遍：名单里还在 Temporal 上的删掉。删成了记一行日志、把之前可能报过的「删不掉」提醒撤掉（重试之后
 * 补删成功的路径）；本来就不在了什么都不做（不记日志、不碰库——这是稳态，不是「查过一遍确认没事」，别把它当成事件）；
 * 删的时候出了别的错，日志和 notifications 都要照实写清楚，绝不当成删掉了。
 */
export async function retireEngineSchedules(
  client: Pick<Client, 'schedule'>,
  db: Db,
  log: RetireScheduleLog = defaultLog,
  schedules: readonly RetiredSchedule[] = RETIRED_SCHEDULES,
): Promise<void> {
  const outcomes = await deleteRetiredSchedules(client, schedules);
  for (const s of schedules) {
    const outcome = outcomes[s.id];
    const dedupeKey = `${RETIRED_SCHEDULE_ALERT_PREFIX}${s.id}`;
    if (outcome && typeof outcome === 'object') {
      log('error', `退役的定时任务删不掉：${s.id}：${outcome.error}`, { scheduleId: s.id });
      await upsertAlert(db, {
        dedupeKey,
        level: 'daily',
        taskId: null,
        title: `退役的定时任务「${s.id}」删不掉`,
        body: `${s.moved ? `${s.retiredBy} 把它改成了引擎进程内的定时器，` : `${s.retiredBy} 把它的代码删掉了，`}但 Temporal 上这个 Schedule 还在、删不掉：${outcome.error}。不删的话它每轮照样去起一个${s.moved ? '老的工作流（和进程内定时器重复跑一轮）' : '不存在的工作流类型'}。查一下 Temporal 的连接和权限，或者手动 fleet-temporal schedule delete --schedule-id ${s.id}。`,
      });
      continue;
    }
    if (outcome === 'deleted') {
      log('info', `退役的定时任务已删：${s.id}（${s.retiredBy} 退役）`);
      await resolveAlertWithReason(db, {
        dedupeKey,
        by: 'engine:retire-schedules',
        why: `「${s.id}」删掉了`,
      });
    }
    // 'absent'（或结局里压根没有这个编号）：本来就不在，什么都不做。
  }
}
