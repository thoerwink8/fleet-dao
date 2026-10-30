// 引擎进程里的定时器（#1072，jobs/timers.ts）：钟点格子、不叠着跑、停机后只补最近一轮、一轮失败不停定时、重启后自己恢复；
// 和 10 个定时任务的登记（jobs/engine-timers.ts）：原来 8 个的格子是 Temporal Schedule 的 interval + offset，没改；
// 耗时表是 #921 新加的，周一 06:00（北京时间）。
// 用假的钟和假的 setTimeout，不真等。
import {
  closeInterruptedScheduleRuns,
  finishScheduleRun,
  recordScheduleRunProgress,
  registerScheduledJobs,
  scheduleHealth,
  startScheduleRun,
} from '@fleet-dao/db';
import { createTestDb, TEST_DB_TIMEOUT_MS } from '@fleet-dao/db/testing';
import { describe, expect, it } from 'vitest';
import type { EngineJobs } from '../src/activities.ts';
import { engineTimerJobs } from '../src/jobs/engine-timers.ts';
import {
  latestSlot,
  startEngineTimers,
  startTimers,
  type TimerHost,
  type TimerJob,
} from '../src/jobs/timers.ts';
import { ENGINE_JOBS } from '../src/real/jobs.ts';

const MIN = 60_000;
/** 一个整点（UTC 2026-10-05 00:00），格子从 epoch 算起，整点一定在每个 5、15、60 分钟的格子上。 */
const T0 = Date.UTC(2026, 9, 5, 0, 0, 0);

interface Pending {
  at: number;
  fn: () => void;
  cleared: boolean;
}

/** 假的钟、假的 setTimeout：advanceTo 把钟拨到某一刻，途中到点的定时器按先后各叫一次。 */
function fakeHost(start: number, last: (id: string) => Promise<Date | null> = async () => null) {
  let now = start;
  const pending: Pending[] = [];
  const logs: string[] = [];
  const host: TimerHost = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const p: Pending = { at: now + ms, fn, cleared: false };
      pending.push(p);
      return p;
    },
    clearTimeout: (h) => {
      if (h) (h as Pending).cleared = true;
    },
    lastStartedAt: last,
    log: (level, text) => logs.push(`${level}:${text}`),
  };
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return {
    host,
    logs,
    clock: () => now,
    /** 拨到 t（含），途中到点的定时器按先后各叫一次；每叫一次让出一下，让一轮的 await 往前走。 */
    async advanceTo(t: number, wakeEarlyMs = 0) {
      for (;;) {
        const due = pending
          .filter((p) => !p.cleared && p.at <= t)
          .sort((a, b) => a.at - b.at)
          .at(0);
        if (!due) break;
        due.cleared = true;
        now = Math.max(now, due.at - wakeEarlyMs);
        due.fn();
        await flush();
      }
      now = t;
      await flush();
    },
    flush,
  };
}

function job(over: Partial<TimerJob> & { run: TimerJob['run'] }): TimerJob {
  return {
    id: 'j',
    everyMinutes: 5,
    offsetMinutes: 3,
    catchupMinutes: 5,
    overdueMinutes: 15,
    ...over,
  };
}

describe('钟点格子（latestSlot）', () => {
  it('每 N 分钟、错开 offset 分钟，从 epoch 算起：不错开的在整格上，错开的整格加偏移', () => {
    expect(latestSlot({ everyMinutes: 15 }, T0 + 20 * MIN)).toBe(T0 + 15 * MIN);
    expect(latestSlot({ everyMinutes: 15, offsetMinutes: 7 }, T0 + 20 * MIN)).toBe(T0 + 7 * MIN);
    expect(latestSlot({ everyMinutes: 15, offsetMinutes: 7 }, T0 + 22 * MIN)).toBe(T0 + 22 * MIN);
    // 还没到这一格的偏移：算上一格的
    expect(latestSlot({ everyMinutes: 60, offsetMinutes: 41 }, T0 + 40 * MIN)).toBe(T0 - 19 * MIN);
  });
});

describe('进程内定时器（startTimers）', () => {
  it('按格子叫醒：每 5 分钟、3 分起，在 3、8、13 分各跑一轮，不早不晚', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    const ran: number[] = [];
    startTimers([job({ run: async () => void ran.push(f.clock()) })], f.host);
    await f.advanceTo(T0 + 14 * MIN);
    expect(ran).toEqual([T0 + 3 * MIN, T0 + 8 * MIN, T0 + 13 * MIN]);
  });

  it('定时器醒早一点（差几毫秒）也不会在同一格里再醒一次', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    const ran: number[] = [];
    startTimers([job({ run: async () => void ran.push(f.clock()) })], f.host);
    await f.advanceTo(T0 + 14 * MIN, 2);
    expect(ran).toHaveLength(3);
  });

  it('上一轮还没完：跳过这一轮，不叠着跑；完了以后下一格照来', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    let calls = 0;
    let release: () => void = () => {};
    startTimers(
      [
        job({
          run: () => {
            calls += 1;
            return new Promise<void>((r) => {
              release = r;
            });
          },
        }),
      ],
      f.host,
    );
    await f.advanceTo(T0 + 14 * MIN);
    expect(calls).toBe(1);
    expect(f.logs.filter((l) => l.includes('跳过这一轮'))).toHaveLength(2);
    release();
    await f.flush();
    await f.advanceTo(T0 + 18 * MIN);
    expect(calls).toBe(2);
  });

  it('一轮失败不停定时：日志里看得见，下一格照样来', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    let calls = 0;
    startTimers(
      [
        job({
          run: async () => {
            calls += 1;
            throw new Error('读库超时');
          },
        }),
      ],
      f.host,
    );
    await f.advanceTo(T0 + 9 * MIN);
    expect(calls).toBe(2);
    expect(f.logs.filter((l) => l.startsWith('error:') && l.includes('读库超时'))).toHaveLength(2);
  });

  it('一轮超过限时还没回：只记 error 日志，不放开「不叠着跑」——它回来之前下一格照样跳过，回来以后下一格照来', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    let calls = 0;
    let release: () => void = () => {};
    startTimers(
      [
        job({
          everyMinutes: 5,
          offsetMinutes: 3,
          overdueMinutes: 2,
          run: () => {
            calls += 1;
            return new Promise<void>((r) => {
              release = r;
            });
          },
        }),
      ],
      f.host,
    );
    await f.advanceTo(T0 + 6 * MIN);
    expect(calls).toBe(1);
    expect(f.logs.some((l) => l.startsWith('error:') && l.includes('超过 2 分钟还没回'))).toBe(true);
    // 过了好几格，那一轮还没回：一格都不起新的
    await f.advanceTo(T0 + 19 * MIN);
    expect(calls).toBe(1);
    release();
    await f.flush();
    await f.advanceTo(T0 + 23 * MIN);
    expect(calls).toBe(2);
  });

  describe('起来时补最近一轮（引擎重启后自己恢复）', () => {
    const startAt = T0 + 10 * MIN; // 最近一格是 T0+8 分
    const runStarts = async (last: Date | null | Error, over: Partial<TimerJob> = {}) => {
      const f = fakeHost(startAt, async () => {
        if (last instanceof Error) throw last;
        return last;
      });
      const calls = { n: 0 };
      startTimers([job({ run: async () => void calls.n++, ...over })], f.host);
      await f.flush();
      return { calls: calls.n, logs: f.logs };
    };

    it('最近一格之后没起过一轮、一格还在补跑窗口里：起来就补一轮', async () => {
      expect((await runStarts(new Date(T0 + 3 * MIN))).calls).toBe(1);
    });

    it('一轮都没跑过：也补（窗口里）', async () => {
      expect((await runStarts(null)).calls).toBe(1);
    });

    it('最近一格之后已经起过一轮：不补，不重复', async () => {
      expect((await runStarts(new Date(T0 + 9 * MIN))).calls).toBe(0);
    });

    it('停得太久（最近一格离现在超过补跑窗口，补跑窗口给得比一格短的）：不补，等下一格', async () => {
      const f = fakeHost(T0 + 3 * 60 * MIN + 30 * MIN, async () => new Date(T0));
      const calls = { n: 0 };
      startTimers(
        [
          job({
            everyMinutes: 360,
            offsetMinutes: 26,
            catchupMinutes: 60,
            run: async () => void calls.n++,
          }),
        ],
        f.host,
      );
      await f.flush();
      expect(calls.n).toBe(0);
    });

    it('【故意造出的失败】读不到上一轮是几点起的：不当成「跑过了」，补一轮并在日志里说清', async () => {
      const r = await runStarts(new Error('库连不上'));
      expect(r.calls).toBe(1);
      expect(r.logs.some((l) => l.startsWith('warn:') && l.includes('库连不上'))).toBe(true);
    });
  });

  it('stop：不再起新的一轮；在跑的等到宽限，没回的把编号交回去', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    let calls = 0;
    const t = startTimers(
      [
        job({
          run: () => {
            calls += 1;
            return new Promise<void>(() => {});
          },
        }),
      ],
      f.host,
    );
    await f.advanceTo(T0 + 4 * MIN);
    expect(t.running()).toEqual(['j']);
    const stopping = t.stop(1_000);
    // 宽限到点（假的 setTimeout 要拨钟才叫）
    await f.advanceTo(T0 + 4 * MIN + 1_000);
    expect(await stopping).toEqual(['j']);
    await f.advanceTo(T0 + 30 * MIN);
    expect(calls).toBe(1);
  });

  it('停机与总开关异步读取交错：尚未进入任务 body 的轮次不再启动', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    let release!: (on: boolean) => void;
    let calls = 0;
    const t = startTimers([job({ needsMaster: true, run: async () => void calls++ })], {
      ...f.host,
      master: {
        refresh: () => new Promise<boolean>((resolve) => (release = resolve)),
        state: () => ({ on: true, why: 'on' }) as const,
      },
    });
    await f.advanceTo(T0 + 3 * MIN);
    expect(t.running()).toEqual(['j']);
    const stopping = t.stop(1_000);
    release(true);
    expect(await stopping).toEqual([]);
    expect(calls).toBe(0);
  });

  it('同步停接可重复调用，不提前记未完成；在途只在 stop 的原宽限到期时记一次', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    const recorded: number[] = [];
    let calls = 0;
    const t = startTimers(
      [
        job({
          run: () => {
            calls++;
            return new Promise<void>(() => {});
          },
        }),
      ],
      {
        ...f.host,
        recordUnfinished: async () => void recorded.push(f.clock()),
      },
    );
    await f.advanceTo(T0 + 4 * MIN);
    t.stopAccepting();
    t.stopAccepting();
    await f.advanceTo(T0 + 9 * MIN);
    expect(calls).toBe(1);
    expect(recorded).toEqual([]);
    const stopping = t.stop(1_000);
    await f.advanceTo(T0 + 9 * MIN + 999);
    expect(recorded).toEqual([]);
    await f.advanceTo(T0 + 9 * MIN + 1_000);
    expect(await stopping).toEqual(['j']);
    expect(recorded).toEqual([T0 + 9 * MIN + 1_000]);
  });

  it('同步停接后已进入 body 的轮次仍可交回，收尾不记未完成', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    let release!: () => void;
    let recorded = 0;
    const t = startTimers([job({ run: () => new Promise<void>((resolve) => (release = resolve)) })], {
      ...f.host,
      recordUnfinished: async () => void recorded++,
    });
    await f.advanceTo(T0 + 4 * MIN);
    t.stopAccepting();
    release();
    await f.flush();
    expect(await t.stop(1_000)).toEqual([]);
    expect(recorded).toBe(0);
  });

  it('停机与前一实例补记交错：补记交回后不再进入任务 body', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    let release!: (ids: number[]) => void;
    let calls = 0;
    let sweeps = 0;
    const t = startTimers([job({ overdueMinutes: 1, run: async () => void calls++ })], f.host, {
      since: new Date(T0 + 1 * MIN),
      close: () => {
        if (++sweeps === 1) return Promise.reject(new Error('第一次补记没写成'));
        return new Promise<number[]>((resolve) => (release = resolve));
      },
    });
    await f.advanceTo(T0 + 3 * MIN);
    expect(t.running()).toEqual(['j']);
    const stopping = t.stop(1_000);
    release([]);
    expect(await stopping).toEqual([]);
    expect(calls).toBe(0);
  });

  it('stop：宽限到了没回的一轮，把编号、本进程起定时器的时刻和停机时刻交给 recordUnfinished；记不上不挡停机', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    const recorded: { ids: readonly string[]; since: number; at: number }[] = [];
    let fail = false;
    const t = startTimers([job({ run: () => new Promise<void>(() => {}) })], {
      ...f.host,
      async recordUnfinished(ids, since, at) {
        recorded.push({ ids, since: since.getTime(), at: at.getTime() });
        if (fail) throw new Error('库写不进');
      },
    });
    await f.advanceTo(T0 + 4 * MIN);
    const stopping = t.stop(1_000);
    await f.advanceTo(T0 + 4 * MIN + 1_000);
    expect(await stopping).toEqual(['j']);
    expect(recorded).toEqual([{ ids: ['j'], since: T0 + 1 * MIN, at: T0 + 4 * MIN + 1_000 }]);

    fail = true;
    const g = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    const t2 = startTimers([job({ run: () => new Promise<void>(() => {}) })], {
      ...g.host,
      async recordUnfinished() {
        throw new Error('库写不进');
      },
    });
    await g.advanceTo(T0 + 4 * MIN);
    const stopping2 = t2.stop(1_000);
    await g.advanceTo(T0 + 4 * MIN + 1_000);
    expect(await stopping2).toEqual(['j']);
    expect(g.logs.some((l) => l.startsWith('error:') && l.includes('库写不进'))).toBe(true);
  });

  it('stop：宽限内都回了，不调 recordUnfinished', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    let release: () => void = () => {};
    let called = 0;
    const t = startTimers([job({ run: () => new Promise<void>((r) => (release = r)) })], {
      ...f.host,
      recordUnfinished: async () => {
        called += 1;
      },
    });
    await f.advanceTo(T0 + 4 * MIN);
    const stopping = t.stop(60_000);
    release();
    expect(await stopping).toEqual([]);
    expect(called).toBe(0);
  });

  it('stop：在跑的一轮宽限内完了，回空，不拖到宽限', async () => {
    const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
    let release: () => void = () => {};
    const t = startTimers(
      [
        job({
          run: () =>
            new Promise<void>((r) => {
              release = r;
            }),
        }),
      ],
      f.host,
    );
    await f.advanceTo(T0 + 4 * MIN);
    const stopping = t.stop(60_000);
    release();
    expect(await stopping).toEqual([]);
  });

  describe('总开关关着跳过的轮次（needsMaster 闸，#1086）', () => {
    const offMaster = () => ({
      refresh: async () => false,
      state: () => ({ on: false, why: 'never_set' }) as const,
    });

    it('关着：run 不跑、recordSkipped 记一笔原因', async () => {
      const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
      const seen = { ran: 0, skipped: [] as string[] };
      startTimers(
        [
          job({
            needsMaster: true,
            run: async () => {
              seen.ran += 1;
            },
          }),
        ],
        {
          ...f.host,
          master: offMaster(),
          recordSkipped: async (id, why) => void seen.skipped.push(`${id}:${why}`),
        },
      );
      await f.advanceTo(T0 + 8 * MIN);
      expect(seen.ran).toBe(0);
      expect(seen.skipped).toHaveLength(2);
      expect(seen.skipped[0]).toContain('总开关');
    });

    it('开着：run 照跑、不记跳过', async () => {
      const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
      const seen = { ran: 0, skipped: 0 };
      startTimers(
        [
          job({
            needsMaster: true,
            run: async () => {
              seen.ran += 1;
            },
          }),
        ],
        {
          ...f.host,
          master: { refresh: async () => true, state: () => ({ on: true }) as const },
          recordSkipped: async () => void seen.skipped++,
        },
      );
      await f.advanceTo(T0 + 8 * MIN);
      expect(seen).toEqual({ ran: 2, skipped: 0 });
    });
  });
});

describe('14 个定时任务的登记（engineTimerJobs）', () => {
  const never = () => {
    throw new Error('这里不该被叫');
  };
  const fakeJobs = (): EngineJobs => ({
    githubReconcile: never,
    routeProbe: never,
    quotaRead: never,
    carpoolWatch: never,
    hourlyReconcile: never,
    watchdog: never,
    intake: never,
    judgeSelfCheck: never,
    ciTimings: never,
    changelog: never,
    usageBackfill: never,
    cliVersions: never,
    cliUpgrade: never,
    requestSweep: never,
    dailyBrief: never,
    e2eQuarantine: never,
    parkedRetry: never,
    parkTriage: never,
  });
  const client = {} as never;
  const jobs = () => engineTimerJobs({ jobs: fakeJobs(), client, taskQueue: 'fleet' });

  it('和登记表（scheduled_jobs）一一对得上、顺序一样', () => {
    expect(jobs().map((j) => j.id)).toEqual(ENGINE_JOBS.map((j) => j.id));
  });

  it('格子：对账 15、探针 15 错 7、读额度 15 错 4、拼车盯读每分钟、每小时对账 60 错 41、看门狗 5 错 4、拉单 5 错 3、判断题自检 30 错 17、耗时表每周一 06:00（北京时间）、用量补记 5 错 2、命令行工具版本 60 错 11、命令行工具升级 30 错 6、需求整理 60 错 23、每日简报每天 08:30（北京时间）、隔离集进出每天 05:20（北京时间）、引擎续停 10 错 4、指挥官看停下的单 10 错 7', () => {
    expect(jobs().map((j) => [j.id, j.everyMinutes, j.offsetMinutes ?? 0])).toEqual([
      ['github-reconcile', 15, 0],
      ['route-probe', 15, 7],
      ['quota-read', 15, 4],
      ['carpool-watch', 1, 0],
      ['hourly-reconcile', 60, 41],
      ['watchdog', 5, 4],
      ['intake', 5, 3],
      ['judge-self-check', 30, 17],
      ['ci-timings', 7 * 24 * 60, 3 * 24 * 60 + 22 * 60],
      ['changelog', 24 * 60, 22 * 60 + 30],
      ['usage-backfill', 5, 2],
      ['cli-versions', 60, 11],
      ['cli-upgrade', 30, 6],
      ['request-sweep', 60, 23],
      ['daily-brief', 24 * 60, 30],
      ['e2e-quarantine', 24 * 60, 21 * 60 + 20],
      ['parked-retry', 10, 4],
      ['park-triage', 10, 7],
    ]);
  });

  it('补跑窗口：都是一格（停机一阵再起来只补最近一轮）', () => {
    for (const j of jobs()) {
      expect(j.catchupMinutes, j.id).toBe(j.everyMinutes);
      // 耗时表要下日志，超时线是 60 分钟；其余仍是原来的 15 分钟
      expect(j.overdueMinutes, j.id).toBe(j.id === 'ci-timings' ? 60 : 15);
    }
  });

  it('【故意造出的失败】真端口没装某个任务：起的时候就明说起不来，不悄悄少一个', () => {
    for (const name of Object.keys(fakeJobs()) as (keyof EngineJobs)[]) {
      const j = fakeJobs();
      delete j[name];
      expect(() => engineTimerJobs({ jobs: j, client, taskQueue: 'fleet' }), name).toThrow(name);
    }
  });
});

describe('起来时补记进程中断没收尾的 schedule_runs（startEngineTimers，#1522）', () => {
  it('先按一轮工作上限补记，再起定时器', async () => {
    const f = fakeHost(T0);
    const seen: { id: string; startedBefore: number }[] = [];
    const order: string[] = [];
    let why = '';
    await startEngineTimers(
      [
        job({
          id: 'route-probe',
          overdueMinutes: 15,
          run: async () => {
            order.push('run:route-probe');
          },
        }),
        job({
          id: 'intake',
          overdueMinutes: 30,
          run: async () => {
            order.push('run:intake');
          },
        }),
      ],
      f.host,
      async (input) => {
        order.push('close');
        why = input.why;
        for (const item of input.jobs)
          seen.push({ id: item.id, startedBefore: item.startedBefore.getTime() });
        return [8029, 4596, 2951];
      },
    );
    await f.flush();
    expect(why).toContain('没收尾');
    expect(seen).toEqual([
      { id: 'route-probe', startedBefore: T0 - 15 * MIN },
      { id: 'intake', startedBefore: T0 - 30 * MIN },
    ]);
    expect(f.logs).toEqual(['info:进程中断没收尾，启动时补记了 3 条定时任务记录：8029、4596、2951']);
    expect(order[0]).toBe('close');
    expect(order).toEqual(['close', 'run:route-probe', 'run:intake']);
  });

  it(
    '【故意造出的失败】查到超时孤儿后，补记的更新写不进要抛并记日志，定时器不起',
    async () => {
      const db = await createTestDb();
      try {
        await registerScheduledJobs(db.db, [
          { id: 'route-probe', name: '路由探针', schedule: '每 15 分钟', expectEveryMinutes: 45 },
        ]);
        const id = await startScheduleRun(db.db, 'route-probe', new Date(T0 - 60 * MIN));
        // 查询读得到这条超时行；更新被触发器拒掉。错要从真的 closeInterruptedScheduleRuns 的 update 冒出来。
        await db.client.exec(`
          create or replace function schedule_runs_close_boom() returns trigger
          language plpgsql as $$
          begin
            raise exception '库写不进';
          end;
          $$
        `);
        await db.client.exec(`
          create trigger schedule_runs_close_boom
          before update on schedule_runs
          for each row execute function schedule_runs_close_boom()
        `);
        const f = fakeHost(T0);
        let ran = false;
        const error = await startEngineTimers(
          [
            job({
              id: 'route-probe',
              overdueMinutes: 15,
              run: async () => {
                ran = true;
              },
            }),
          ],
          f.host,
          (input) => closeInterruptedScheduleRuns(db.db, input),
        ).then(
          () => null,
          (caught: unknown) => caught,
        );
        await f.flush();
        const text = errorText(error);
        expect(text).toContain('补记没收尾的定时任务失败');
        expect(text).toContain('Failed query: update');
        expect(text).toContain('库写不进');
        expect(ran).toBe(false);
        expect(f.logs).toHaveLength(1);
        expect(f.logs[0]).toContain('error:进程中断没收尾的定时任务没补记成');
        expect(f.logs[0]).toContain('Failed query: update');
        const { rows } = await db.client.query<{
          outcome: string | null;
          ended_at: string | null;
          why: string | null;
        }>('select outcome, ended_at, why from schedule_runs where id = $1', [id]);
        expect(rows[0]?.outcome ?? null).toBeNull();
        expect(rows[0]?.ended_at ?? null).toBeNull();
        expect(rows[0]?.why ?? null).toBeNull();
      } finally {
        await db.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});

describe('前一实例不满一轮工作上限的遗留行（startEngineTimers 二次补记，#3585）', () => {
  /** 每小时 41 分一格，本进程 T0+49 分起：下一格 T0+101 分，二次补记点（起点 + 15 分）前后都没有正常一轮。 */
  const S = T0 + 49 * MIN;
  const hourly = (over: Partial<TimerJob> = {}) =>
    job({
      id: 'hourly-reconcile',
      everyMinutes: 60,
      offsetMinutes: 41,
      catchupMinutes: 60,
      overdueMinutes: 15,
      run: async () => {},
      ...over,
    });
  /** 本进程起点（S）之前已经起的那一轮，上一次是几点起的。 */
  const lastAfterSlot = async () => new Date(S - 8 * MIN);

  interface Row {
    id: number;
    job: string;
    startedAt: number;
    endedAt: number | null;
  }
  /** 和 closeInterruptedScheduleRuns 同口径的假端口：严格早于边界、没结束、名单内的任务才结束，结束时刻写开跑时刻。 */
  const fakeRows = (rows: Row[]) => {
    const calls: { jobs: string[]; startedBefore: number[] }[] = [];
    const close = async (input: Parameters<Parameters<typeof startEngineTimers>[2]>[0]) => {
      calls.push({
        jobs: input.jobs.map((j) => j.id),
        startedBefore: input.jobs.map((j) => j.startedBefore.getTime()),
      });
      const ids: number[] = [];
      for (const item of input.jobs)
        for (const row of rows)
          if (row.job === item.id && row.endedAt === null && row.startedAt < item.startedBefore.getTime()) {
            row.endedAt = row.startedAt;
            ids.push(row.id);
          }
      return ids;
    };
    return { calls, close };
  };

  it('复现：起来时只有 8 分钟的前一实例行被启动补记漏过；本进程起满一轮工作上限后补上，不用再重启；20 分钟前的旧行启动就补', async () => {
    const rows: Row[] = [
      { id: 1, job: 'hourly-reconcile', startedAt: S - 29 * MIN, endedAt: null }, // 20 分钟前（对照）
      { id: 2, job: 'hourly-reconcile', startedAt: S - 8 * MIN, endedAt: null }, // 年轻前实例
    ];
    const f = fakeHost(S, lastAfterSlot);
    const port = fakeRows(rows);
    await startEngineTimers([hourly()], f.host, port.close);
    expect(rows.map((r) => r.endedAt)).toEqual([S - 29 * MIN, null]);
    expect(port.calls).toHaveLength(1);

    await f.advanceTo(S + 14 * MIN);
    expect(rows[1]?.endedAt).toBeNull();
    expect(port.calls).toHaveLength(1);

    await f.advanceTo(S + 15 * MIN);
    expect(port.calls).toHaveLength(2);
    // 边界是本进程起点，不是「现在减一轮上限」
    expect(port.calls[1]).toEqual({ jobs: ['hourly-reconcile'], startedBefore: [S] });
    // 结束时刻仍用原规则：写开跑时刻，不写补记时刻
    expect(rows[1]?.endedAt).toBe(S - 8 * MIN);
    expect(f.logs.filter((l) => l.includes('前一个引擎实例'))).toEqual([
      'info:定时任务 hourly-reconcile：补记了前一个引擎实例留下的 1 条没收尾的记录：2',
    ]);
  });

  it('当前实例仍活跃的行、等于边界的行、名单外任务、已结束的行都不动', async () => {
    const rows: Row[] = [
      { id: 1, job: 'hourly-reconcile', startedAt: S - 1, endedAt: null }, // 前一实例，差 1 毫秒
      { id: 2, job: 'hourly-reconcile', startedAt: S, endedAt: null }, // 等于边界
      { id: 3, job: 'hourly-reconcile', startedAt: S + 1 * MIN, endedAt: null }, // 本进程的，长时间仍在跑
      { id: 4, job: 'not-ours', startedAt: S - 8 * MIN, endedAt: null }, // 名单外
      { id: 5, job: 'hourly-reconcile', startedAt: S - 9 * MIN, endedAt: S - 5 * MIN }, // 已结束
    ];
    const f = fakeHost(S, lastAfterSlot);
    const port = fakeRows(rows);
    await startEngineTimers([hourly()], f.host, port.close);
    await f.advanceTo(S + 40 * MIN);
    expect(rows.map((r) => r.endedAt)).toEqual([S - 1, null, null, null, S - 5 * MIN]);
  });

  it('补过一次就不再补：之后正常钟点的轮次也不重复调用端口', async () => {
    const rows: Row[] = [{ id: 1, job: 'hourly-reconcile', startedAt: S - 8 * MIN, endedAt: null }];
    const f = fakeHost(S, lastAfterSlot);
    const port = fakeRows(rows);
    let ran = 0;
    await startEngineTimers([hourly({ run: async () => void ran++ })], f.host, port.close);
    await f.advanceTo(S + 15 * MIN);
    await f.advanceTo(T0 + 101 * MIN + 1);
    await f.advanceTo(T0 + 161 * MIN + 1);
    expect(ran).toBe(2);
    expect(port.calls).toHaveLength(2); // 启动一次 + 二次补记一次
    expect(rows[0]?.endedAt).toBe(S - 8 * MIN);
  });

  it('补记写不进：明确记 error、行仍是进行中，不当成已补；稍后自己重试，补上才记「补记了」；定时照跑', async () => {
    const rows: Row[] = [{ id: 1, job: 'hourly-reconcile', startedAt: S - 8 * MIN, endedAt: null }];
    let ran = 0;
    // 启动那次成功（没有可补的），二次补记那次写不进一次
    const base = fakeRows(rows);
    let call = 0;
    const close = async (input: Parameters<typeof base.close>[0]) => {
      call += 1;
      if (call === 2) throw new Error('补记没收尾的定时任务失败：库写不进');
      return base.close(input);
    };
    const g = fakeHost(S, lastAfterSlot);
    await startEngineTimers([hourly({ run: async () => void ran++ })], g.host, close);
    await g.advanceTo(S + 15 * MIN);
    expect(rows[0]?.endedAt).toBeNull();
    expect(
      g.logs.some((l) => l.startsWith('error:') && l.includes('没补记成') && l.includes('库写不进')),
    ).toBe(true);
    expect(g.logs.some((l) => l.includes('补记了前一个引擎实例'))).toBe(false);
    await g.advanceTo(S + 30 * MIN);
    expect(rows[0]?.endedAt).toBe(S - 8 * MIN);
    expect(g.logs.some((l) => l.includes('补记了前一个引擎实例留下的 1 条'))).toBe(true);
    await g.advanceTo(T0 + 101 * MIN + 1);
    expect(ran).toBeGreaterThan(0);
  });

  it('下一轮开头也会补一次没补成的（不依赖重试定时器）', async () => {
    const rows: Row[] = [{ id: 1, job: 'hourly-reconcile', startedAt: S - 8 * MIN, endedAt: null }];
    const f = fakeHost(S, lastAfterSlot);
    // 启动补记成功；二次补记（S+15）和两次重试（S+30、S+45）都写不进。下一次重试在 S+60，正常一轮 S+52 先到，由它补上
    const base = fakeRows(rows);
    let call = 0;
    const close = async (input: Parameters<typeof base.close>[0]) => {
      call += 1;
      if (call >= 2 && call <= 4) throw new Error('补记没收尾的定时任务失败：库写不进');
      return base.close(input);
    };
    await startEngineTimers([hourly({ overdueMinutes: 15 })], f.host, close);
    await f.advanceTo(S + 51 * MIN);
    expect(rows[0]?.endedAt).toBeNull();
    expect(call).toBe(4);
    await f.advanceTo(T0 + 101 * MIN + 1);
    expect(rows[0]?.endedAt).toBe(S - 8 * MIN);
    expect(call).toBe(5);
    // 补上之后 S+60 的重试定时器醒来也不再调端口
    await f.advanceTo(S + 70 * MIN);
    expect(call).toBe(5);
  });

  it('归属认不出（本进程起点、或一轮工作上限读不出来）：不补记、保留，日志说清，不写成 ok', async () => {
    const f = fakeHost(S, lastAfterSlot);
    const port = fakeRows([{ id: 1, job: 'hourly-reconcile', startedAt: S - 8 * MIN, endedAt: null }]);
    startTimers([hourly()], f.host, { since: new Date(Number.NaN), close: port.close });
    startTimers([hourly({ overdueMinutes: Number.NaN })], f.host, { since: new Date(S), close: port.close });
    await f.advanceTo(S + 40 * MIN);
    expect(port.calls).toHaveLength(0);
    expect(f.logs.filter((l) => l.startsWith('warn:') && l.includes('认不出'))).toHaveLength(2);
  });

  it('停机后不再补记（定时器随 stop 一起撤掉）', async () => {
    const rows: Row[] = [{ id: 1, job: 'hourly-reconcile', startedAt: S - 8 * MIN, endedAt: null }];
    const f = fakeHost(S, lastAfterSlot);
    const port = fakeRows(rows);
    const timers = await startEngineTimers([hourly()], f.host, port.close);
    await timers.stop(1_000);
    await f.advanceTo(S + 40 * MIN);
    expect(port.calls).toHaveLength(1);
    expect(rows[0]?.endedAt).toBeNull();
  });

  it(
    '真库：年轻前实例行补成 failed 且保留阶段 why、结束时刻是开跑时刻；等于边界、当前实例、已结束、名单外的不动；更新的成功轮不被盖过；重复执行不再动',
    async () => {
      const db = await createTestDb();
      try {
        await registerScheduledJobs(db.db, [
          { id: 'hourly-reconcile', name: '每小时对账', schedule: '每小时', expectEveryMinutes: 150 },
          { id: 'not-ours', name: '别的', schedule: '每小时', expectEveryMinutes: 150 },
        ]);
        const young = await startScheduleRun(db.db, 'hourly-reconcile', new Date(S - 8 * MIN));
        await recordScheduleRunProgress(db.db, {
          id: young,
          step: 'worktrees',
          phase: 'start',
          at: new Date(S - 7 * MIN),
        });
        const equal = await startScheduleRun(db.db, 'hourly-reconcile', new Date(S));
        const current = await startScheduleRun(db.db, 'hourly-reconcile', new Date(S + 2 * MIN));
        const other = await startScheduleRun(db.db, 'not-ours', new Date(S - 8 * MIN));
        const done = await startScheduleRun(db.db, 'hourly-reconcile', new Date(S - 20 * MIN));
        await finishScheduleRun(db.db, done, { outcome: 'ok', scanned: 3, found: 0 }, new Date(S - 19 * MIN));
        const newerOk = await startScheduleRun(db.db, 'hourly-reconcile', new Date(S + 3 * MIN));
        await finishScheduleRun(
          db.db,
          newerOk,
          { outcome: 'ok', scanned: 5, found: 0 },
          new Date(S + 4 * MIN),
        );

        const f = fakeHost(S, lastAfterSlot);
        const close = (input: Parameters<typeof closeInterruptedScheduleRuns>[1]) =>
          closeInterruptedScheduleRuns(db.db, input);
        await startEngineTimers([hourly()], f.host, close);
        await f.advanceTo(S + 15 * MIN);

        const { rows } = await db.client.query<{
          id: number;
          outcome: string | null;
          started_at: string;
          ended_at: string | null;
          why: string | null;
        }>('select id, outcome, started_at, ended_at, why from schedule_runs order by id');
        const byId = new Map(rows.map((r) => [r.id, r]));
        const closed = byId.get(young);
        expect(closed?.outcome).toBe('failed');
        expect(new Date(closed?.ended_at ?? '').getTime()).toBe(S - 8 * MIN);
        expect(new Date(closed?.started_at ?? '').getTime()).toBe(S - 8 * MIN);
        expect(closed?.why).toContain('没收尾');
        expect(closed?.why).toContain('step=worktrees');
        for (const id of [equal, current, other]) {
          expect(byId.get(id)?.ended_at ?? null, String(id)).toBeNull();
          expect(byId.get(id)?.outcome ?? null).toBeNull();
        }
        expect(byId.get(done)?.outcome).toBe('ok');
        expect(byId.get(newerOk)?.outcome).toBe('ok');
        // 补记没有把这行变成「最近一次结束的」：看门狗看到的最近一次跑成仍是更新的那条
        const health = (await scheduleHealth(db.db, new Date(S + 15 * MIN))).find(
          (h) => h.job.id === 'hourly-reconcile',
        );
        expect(health?.lastSuccess?.id).toBe(newerOk);
        // 重复执行：端口已无可补
        expect(
          await close({ jobs: [{ id: 'hourly-reconcile', startedBefore: new Date(S) }], at: new Date(S) }),
        ).toEqual([]);
      } finally {
        await db.close();
      }
    },
    TEST_DB_TIMEOUT_MS,
  );
});

/** 顺着 cause 把报错拼起来。drizzle 把真正的库错误放在 cause 里，只看最外层会漏掉「库写不进」。 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  for (let current: unknown = error; current instanceof Error && parts.length < 8; current = current.cause) {
    parts.push(current.message);
  }
  return parts.join('\n');
}
