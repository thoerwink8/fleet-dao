// 引擎进程里的定时器（#1072，替代 Temporal Schedule）：按固定的钟点格子（每 N 分钟、错开 offset 分钟，从 epoch 算起，和
// 原来 Schedule 的 interval + offset 同一个格子）一轮一轮叫醒各定时任务。语义和原来的 Schedule 一一对应：
// - 上一轮还没完就跳过这一轮（不叠着跑）：同一个任务同一时刻进程里最多一轮，卡住了也不放开（只记日志、看门狗报），宁可漏一轮不叠着跑；
// - 停机一阵再起来：只补最近一轮，不把错过的全补一遍——最近一格的钟点在补跑窗口里、且那之后没起过一轮才补，再久就等下一格；
// - 一轮失败不停掉定时：下一格照样来（没跑成的一轮由各任务自己记进 schedule_runs，看门狗照登记表看）；
// - 引擎重启后自己恢复：没有「暂停」这个持久状态，也就没有「重启不替人恢复暂停的」那个坑；要停就停引擎、或关项目的开关。
// 单实例假设：法国只有一个引擎进程（一个 systemd 单元，发布是先停旧的再起新的），「不叠着跑」只在进程内保证。
// 将来要起第二个引擎进程（多机、蓝绿并起）时，每一轮开头要先抢一把锁（比如 Postgres 咨询锁 pg_try_advisory_lock(任务编号)），
// 抢不到就跳过这一轮——现在不做，不为没有的需求写代码。

import { type EngineMasterGate, masterOffNote } from '../engine-master.ts';

const MINUTE_MS = 60_000;

export interface TimerJob {
  /** 登记表（scheduled_jobs）上的任务编号。 */
  id: string;
  everyMinutes: number;
  /** 钟点格子错开几分钟（从 epoch 算起）；不给就是 0。 */
  offsetMinutes?: number;
  /** 停机后补最近一轮的窗口（分钟）：最近一格的钟点离现在不超过这么久才补。 */
  catchupMinutes: number;
  /**
   * 一轮超过多久（分钟）还没回就记一条 error 日志。只记日志、不放开「不叠着跑」：那一轮没人能取消，放开就会在它还在跑时又起一轮
   * （同一个任务并行：探针同时起两个会话、对账同时写同一批行）。它回来之前下一格一律跳过，看门狗照登记表报「停了」，要人看。
   */
  overdueMinutes: number;
  /**
   * 引擎总开关关着时这个任务这一轮不跑（#1086）：拉单、巡检这类会拉单、派活、起干活会话的任务标它；探针、读额度、看门狗、
   * 对账这些看家检查不标，关着照跑（创始人 2026-10-05 约 22:40：关着也要能看到渠道通不通）。闸在这里统一判，不在各任务里各加 if。
   */
  needsMaster?: boolean;
  run(): Promise<unknown>;
}

export interface TimerHost {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** 这个任务最近一轮是几点起的（schedule_runs）；一轮都没有回 null；读不到抛错（调用方当「不知道」处理，不当 null）。 */
  lastStartedAt(jobId: string): Promise<Date | null>;
  log(level: 'info' | 'warn' | 'error', text: string): void;
  /**
   * 引擎总开关（engine-master.ts）：needsMaster 的任务每一轮开头现读一次，关着（含读不到、认不出）就不跑这一轮。
   * 不给 = 不闸（只有测试里可以不给；生产的 realTimerHost 必须给，由 worker.ts 接）。
   */
  master?: Pick<EngineMasterGate, 'refresh' | 'state'>;
  /** 总开关关着、这一轮被跳过：记一条 partial 进 schedule_runs（看门狗不当成「停了」）。记不上抛，由调用方（runRound）记日志。 */
  recordSkipped?(jobId: string, why: string): Promise<void>;
}

export const realTimerHost = (
  lastStartedAt: TimerHost['lastStartedAt'],
  master: NonNullable<TimerHost['master']>,
  recordSkipped: NonNullable<TimerHost['recordSkipped']>,
): TimerHost => ({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  lastStartedAt,
  log: (level, text) => console[level](text),
  master,
  recordSkipped,
});

export interface EngineTimers {
  /** 不再起新的一轮，等在跑的最多 graceMs；返回超时还没回的任务编号。 */
  stop(graceMs: number): Promise<string[]>;
  /** 现在在跑的任务编号。 */
  running(): string[];
}

/** t 时刻之前（含）最近一格的钟点（毫秒）。 */
export function latestSlot(job: Pick<TimerJob, 'everyMinutes' | 'offsetMinutes'>, t: number): number {
  const every = job.everyMinutes * MINUTE_MS;
  const offset = (job.offsetMinutes ?? 0) * MINUTE_MS;
  return Math.floor((t - offset) / every) * every + offset;
}

export function startTimers(jobs: readonly TimerJob[], host: TimerHost): EngineTimers {
  const inFlight = new Map<string, Promise<void>>();
  const handles = new Map<string, unknown>();
  let stopped = false;

  const runRound = (job: TimerJob, why: string): void => {
    if (stopped) return;
    if (inFlight.has(job.id)) {
      host.log('info', `定时任务 ${job.id}：上一轮还没完，跳过这一轮（${why}）`);
      return;
    }
    let overdue: unknown;
    const round = (async () => {
      overdue = host.setTimeout(
        () =>
          host.log(
            'error',
            `定时任务 ${job.id}：这一轮超过 ${job.overdueMinutes} 分钟还没回；它回来之前不再起新的一轮（不叠着跑），看门狗会照登记表报，要人看看是卡在哪`,
          ),
        job.overdueMinutes * MINUTE_MS,
      );
      try {
        // 引擎总开关（#1086）：拉单、巡检这类要总开关开着才跑；关着（含读不到、认不出）这一轮不跑，记一笔 partial 说明原因
        if (job.needsMaster && host.master && !(await host.master.refresh())) {
          const why = `引擎总开关关着，这一轮不跑：${masterOffNote(host.master.state())}`;
          host.log('info', `定时任务 ${job.id}：${why}`);
          try {
            await host.recordSkipped?.(job.id, why);
          } catch (error) {
            host.log(
              'error',
              `定时任务 ${job.id}：总开关关着跳过这一轮，但没记进 schedule_runs：${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return;
        }
        await job.run();
      } catch (error) {
        // 没跑成的一轮各任务自己已经记进 schedule_runs（看门狗照登记表报）；这里只让日志看得见，不停掉定时
        host.log(
          'error',
          `定时任务 ${job.id} 这一轮没跑成：${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        host.clearTimeout(overdue);
        inFlight.delete(job.id);
      }
    })();
    inFlight.set(job.id, round);
  };

  const arm = (job: TimerJob, at: number): void => {
    if (stopped) return;
    handles.set(
      job.id,
      host.setTimeout(
        () => {
          // 下一格从「这一格」往后推，不从醒来的时刻算（定时器醒早一两毫秒也不会在同一格里再醒一次）；
          // 睡过了好几格（机器挂起）就直接跳到下一个还没到的格子，不补
          const now = host.now();
          let next = at + job.everyMinutes * MINUTE_MS;
          if (next <= now) next = latestSlot(job, now) + job.everyMinutes * MINUTE_MS;
          arm(job, next);
          runRound(job, '到点');
        },
        Math.max(0, at - host.now()),
      ),
    );
  };

  for (const job of jobs) {
    const now = host.now();
    const slot = latestSlot(job, now);
    arm(job, slot + job.everyMinutes * MINUTE_MS);
    // 起来时补最近一轮：最近一格在窗口里、且那一格之后没起过一轮
    void (async () => {
      let last: Date | null;
      try {
        last = await host.lastStartedAt(job.id);
      } catch (error) {
        // 读不到上次几点跑的：不当成「跑过了」。补一轮比漏一轮好（不叠着跑的保护照样在）
        host.log(
          'warn',
          `定时任务 ${job.id}：读不到上一轮是几点起的（${error instanceof Error ? error.message : String(error)}），按没跑过算`,
        );
        last = null;
      }
      const missed = last === null || last.getTime() < slot;
      if (missed && now - slot <= job.catchupMinutes * MINUTE_MS) runRound(job, '起来时补最近一轮');
    })();
  }

  return {
    running: () => [...inFlight.keys()],
    async stop(graceMs) {
      stopped = true;
      for (const handle of handles.values()) host.clearTimeout(handle);
      handles.clear();
      if (inFlight.size === 0) return [];
      let graceTimer: unknown;
      await Promise.race([
        Promise.allSettled([...inFlight.values()]),
        new Promise<void>((resolve) => {
          graceTimer = host.setTimeout(resolve, graceMs);
        }),
      ]);
      host.clearTimeout(graceTimer);
      return [...inFlight.keys()];
    },
  };
}
