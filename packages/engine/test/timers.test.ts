// 引擎进程里的定时器（#1072，jobs/timers.ts）：钟点格子、不叠着跑、停机后只补最近一轮、一轮失败不停定时、重启后自己恢复；
// 和 8 个定时任务的登记（jobs/engine-timers.ts）：格子是原来 Temporal Schedule 的 interval + offset，没改。
// 用假的钟和假的 setTimeout，不真等。
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import type { EngineJobs } from '../src/activities.ts';
import type { CanaryDeps } from '../src/jobs/canary.ts';
import { engineTimerJobs } from '../src/jobs/engine-timers.ts';
import { latestSlot, startTimers, type TimerHost, type TimerJob } from '../src/jobs/timers.ts';
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

    it('停得太久（最近一格离现在超过补跑窗口，比如巡检只补一小时内的）：不补，等下一格', async () => {
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

    it('关着：run 不跑、recordSkipped 记一笔原因、onMasterSkip 做这一跳过的收尾', async () => {
      const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
      const seen = { ran: 0, swept: 0, skipped: [] as string[] };
      startTimers(
        [
          job({
            needsMaster: true,
            run: async () => {
              seen.ran += 1;
            },
            onMasterSkip: async () => {
              seen.swept += 1;
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
      expect(seen.swept).toBe(2);
      expect(seen.skipped).toHaveLength(2);
      expect(seen.skipped[0]).toContain('总开关');
    });

    it('【故意造出的失败】onMasterSkip 抛了：只记 error 日志，不停掉定时，下一格照常跳', async () => {
      const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
      const seen = { skipped: 0 };
      startTimers(
        [
          job({
            needsMaster: true,
            run: async () => {},
            onMasterSkip: async () => {
              throw new Error('收尾没做成（测试故意造的）');
            },
          }),
        ],
        { ...f.host, master: offMaster(), recordSkipped: async () => void seen.skipped++ },
      );
      await f.advanceTo(T0 + 13 * MIN);
      expect(seen.skipped).toBe(3);
      expect(f.logs.filter((l) => l.startsWith('error:') && l.includes('收尾没做成'))).toHaveLength(3);
    });

    it('开着：不碰 onMasterSkip，run 照跑', async () => {
      const f = fakeHost(T0 + 1 * MIN, async () => new Date(T0));
      const seen = { ran: 0, swept: 0, skipped: 0 };
      startTimers(
        [
          job({
            needsMaster: true,
            run: async () => {
              seen.ran += 1;
            },
            onMasterSkip: async () => {
              seen.swept += 1;
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
      expect(seen).toEqual({ ran: 2, swept: 0, skipped: 0 });
    });
  });
});

describe('8 个定时任务的登记（engineTimerJobs）', () => {
  const never = () => {
    throw new Error('这里不该被叫');
  };
  const fakeJobs = (): EngineJobs => ({
    githubReconcile: never,
    routeProbe: never,
    quotaRead: never,
    carpoolWatch: never,
    hourlyReconcile: never,
    canary: never,
    watchdog: never,
    intake: never,
  });
  const start = vi_fn();
  function vi_fn() {
    const calls: { type: string; options: Record<string, unknown> }[] = [];
    let error: unknown;
    return {
      calls,
      failWith: (e: unknown) => {
        error = e;
      },
      fn: async (type: string, options: Record<string, unknown>) => {
        calls.push({ type, options });
        if (error) throw error;
        return { firstExecutionRunId: 'r' };
      },
    };
  }
  const client = { workflow: { start: start.fn, getHandle: () => ({}) } } as never;
  const jobs = () => engineTimerJobs({ jobs: fakeJobs(), client, taskQueue: 'fleet' });

  it('和登记表（scheduled_jobs 的那 8 个）一一对得上、顺序一样', () => {
    expect(jobs().map((j) => j.id)).toEqual(ENGINE_JOBS.map((j) => j.id));
  });

  it('格子就是原来 Temporal Schedule 的 interval + offset：对账 15、探针 15 错 7、读额度 15 错 4、拼车盯读每分钟、每小时对账 60 错 41、巡检 6 小时错 26、看门狗 5 错 4、拉单 5 错 3', () => {
    expect(jobs().map((j) => [j.id, j.everyMinutes, j.offsetMinutes ?? 0])).toEqual([
      ['github-reconcile', 15, 0],
      ['route-probe', 15, 7],
      ['quota-read', 15, 4],
      ['carpool-watch', 1, 0],
      ['hourly-reconcile', 60, 41],
      ['canary', 360, 26],
      ['watchdog', 5, 4],
      ['intake', 5, 3],
    ]);
  });

  it('补跑窗口：都是一格（停机一阵再起来只补最近一轮）；巡检例外，错过的那一轮一小时内补上', () => {
    for (const j of jobs()) {
      expect(j.catchupMinutes, j.id).toBe(j.id === 'canary' ? 60 : j.everyMinutes);
      expect(j.overdueMinutes, j.id).toBe(15);
    }
  });

  it('【故意造出的失败】真端口没装某个任务：起的时候就明说起不来，不悄悄少一个', () => {
    for (const name of Object.keys(fakeJobs()) as (keyof EngineJobs)[]) {
      const j = fakeJobs();
      delete j[name];
      expect(() => engineTimerJobs({ jobs: j, client, taskQueue: 'fleet' }), name).toThrow(name);
    }
  });

  it('巡检这一轮只起工作流：固定编号 canary、任务队列照引擎的、一轮最长 5.5 小时', async () => {
    const canary = jobs().find((j) => j.id === 'canary');
    await canary?.run();
    expect(start.calls).toHaveLength(1);
    expect(start.calls[0]?.type).toBe('canaryWorkflow');
    expect(start.calls[0]?.options).toMatchObject({
      workflowId: 'canary',
      taskQueue: 'fleet',
      workflowRunTimeout: '330 minutes',
      workflowIdConflictPolicy: 'FAIL',
    });
  });

  it('巡检已经有一轮在跑：起第二条被 Temporal 拒掉，这一轮跳过、不报错（两轮叠着跑会在巡检仓里抢同一个文件）', async () => {
    start.failWith(new WorkflowExecutionAlreadyStartedError('already', 'canary', 'canaryWorkflow'));
    const canary = jobs().find((j) => j.id === 'canary');
    await expect(canary?.run()).resolves.toBeUndefined();
  });

  it('【故意造出的失败】巡检起的时候连不上 Temporal：原样抛出（定时器记日志、下一格再来），不当成「已经有一轮在跑」', async () => {
    start.failWith(new Error('14 UNAVAILABLE'));
    const canary = jobs().find((j) => j.id === 'canary');
    await expect(canary?.run()).rejects.toThrow('UNAVAILABLE');
  });

  it('巡检的 onMasterSkip（#1141）：总开关关着跳过时，用真端口装的依赖收前面断轮留下的东西（sweepCanaryLeftovers）', async () => {
    const swept: string[] = [];
    const j = fakeJobs();
    j.canary = () =>
      ({
        repo: { owner: 'acme', name: 'canary' },
        runs: { start: async () => 1, finish: async () => {} },
        record: {
          start: async () => 1,
          progress: async () => true,
          finish: async () => 'ok',
          leftovers: async () => [],
          abandon: async () => [],
          cleaned: async () => {},
        },
        alerts: { raise: async () => {}, resolve: async (why: string) => void swept.push(`resolve:${why}`) },
        now: () => new Date(),
        log: () => {},
      }) as unknown as CanaryDeps;
    const canaryTimer = engineTimerJobs({ jobs: j, client, taskQueue: 'fleet' }).find(
      (x) => x.id === 'canary',
    );
    await canaryTimer?.onMasterSkip?.();
    expect(swept).toHaveLength(1);
    expect(swept[0]).toContain('总开关');
  });
});
