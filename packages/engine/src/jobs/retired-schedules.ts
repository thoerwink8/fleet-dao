// 退役了的 Temporal 定时任务：代码删掉之后，Temporal 里当初建的 Schedule 不会跟着消失——留着的话，它照样每轮去起一个
// 已经不存在的工作流类型（#445 删掉「提醒派单」整层撞上这个：法国的 alert-dispatch 只能帅位手动暂停，
// `fleet-temporal schedule toggle --pause`，specs/445-提醒减负/结果.md）。这份名单是唯一的出处：引擎起来时
// （real/retire-schedules.ts 的 retireEngineSchedules）按它把 Temporal 上还在的删掉；看门狗（real/watchdog.ts）按它把
// 这几个从「新不新鲜」的判断里剔除（登记表上的行还在，但不会再有新的跑记录，不剔除会被判成「停了」永远报警）。
// 两处认同一份名单：退役一个定时任务只改这一个文件，不用两处各改一遍。
export interface RetiredSchedule {
  /** Temporal 的 scheduleId，同时是 scheduled_jobs 登记表上的 job id。 */
  id: string;
  /** 哪个 PR 把它的代码删掉的（不是改这份名单的那个 PR）。 */
  retiredBy: string;
}

export const RETIRED_SCHEDULES: readonly RetiredSchedule[] = [{ id: 'alert-dispatch', retiredBy: '#445' }];

export const RETIRED_SCHEDULE_IDS: ReadonlySet<string> = new Set(RETIRED_SCHEDULES.map((s) => s.id));
