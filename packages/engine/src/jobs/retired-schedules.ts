import { errMessage } from '@fleet-dao/shared/util';
import { type Client, ScheduleNotFoundError } from '@temporalio/client';

// 要从 Temporal 上删掉的 Schedule 名单：代码里不再有的定时任务，和改由引擎进程内定时器跑的定时任务（#1072），当初在
// Temporal 里建的 Schedule 不会跟着消失——留着的话，它照样每轮去起一个已经不存在的工作流类型，或者和进程内定时器重复跑一轮
// （#445 删「提醒派单」整层撞上过前一种：法国的 alert-dispatch 只能帅位手动暂停，
// `fleet-temporal schedule toggle --pause`，specs/445-提醒减负/结果.md）。这份名单是唯一的出处：引擎起来时
// （real/retire-schedules.ts 的 retireEngineSchedules）按它把 Temporal 上还在的删掉；看门狗（real/watchdog.ts）按它把
// 退役的（不含 moved 的）从「新不新鲜」的判断里剔除（登记表上的行还在，但不会再有新的跑记录，不剔除会被判成「停了」永远报警）。
// 两处认同一份名单：退役一个定时任务只改这一个文件，不用两处各改一遍。
// #1140 起：不带 moved 的退役任务，登记表 scheduled_jobs 上的行也由引擎起来时摘掉（real/jobs.ts 的 registerEngineJobs
// 调 db 的 unregisterScheduledJobs），驾驶舱「定时任务」页不再把它标成「过期」——#445 删「提醒派单」后 alert-dispatch
// 的登记行一直留在表上，页面标了 9 天「过期」。
// moved 的那 8 条等法国和本机的引擎都起过一次新版本、Temporal 上删干净之后，可以从名单里去掉。
export interface RetiredSchedule {
  /** Temporal 的 scheduleId，同时是 scheduled_jobs 登记表上的 job id。 */
  id: string;
  /** 哪个 PR 把它的代码删掉的（不是改这份名单的那个 PR）。 */
  retiredBy: string;
  /** true：任务本身还在，只是改由引擎进程内定时器跑（jobs/engine-timers.ts），Temporal 上这条 Schedule 要删；不从看门狗名单剔除。 */
  moved?: boolean;
}

const MOVED_TO_TIMERS = [
  'github-reconcile',
  'route-probe',
  'quota-read',
  'carpool-watch',
  'hourly-reconcile',
  'canary',
  'watchdog',
  'intake',
] as const;

export const RETIRED_SCHEDULES: readonly RetiredSchedule[] = [
  { id: 'alert-dispatch', retiredBy: '#445' },
  ...MOVED_TO_TIMERS.map((id): RetiredSchedule => ({ id, retiredBy: '#1072', moved: true })),
];

/** 看门狗要剔除的：任务已经没有了的。moved 的任务还在，照看。 */
export const RETIRED_SCHEDULE_IDS: ReadonlySet<string> = new Set(
  RETIRED_SCHEDULES.filter((s) => !s.moved).map((s) => s.id),
);

/** 一个退役的 Schedule 删的结局：删掉了、本来就不在了、删的时候出了别的错（原文带着，不当成删掉了）。 */
export type RetiredScheduleOutcome = 'deleted' | 'absent' | { error: string };

/**
 * 把名单（不传就用上面这份）里 Temporal 上还在的 Schedule 删掉。每个编号的结局独立、互不影响（一个删不掉不耽误别的照删）；
 * 从不抛出——这些 Schedule 已经没有代码在管了，删不掉不该挡引擎接活，调用方（real/retire-schedules.ts）按结局决定记日志还是报警，
 * 不许把「删的时候出错」当成「删掉了」。
 */
export async function deleteRetiredSchedules(
  client: Pick<Client, 'schedule'>,
  schedules: readonly RetiredSchedule[] = RETIRED_SCHEDULES,
): Promise<Record<string, RetiredScheduleOutcome>> {
  const out: Record<string, RetiredScheduleOutcome> = {};
  for (const { id } of schedules) {
    try {
      await client.schedule.getHandle(id).delete();
      out[id] = 'deleted';
    } catch (err) {
      out[id] = err instanceof ScheduleNotFoundError ? 'absent' : { error: errMessage(err) };
    }
  }
  return out;
}
