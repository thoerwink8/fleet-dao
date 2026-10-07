// 引擎总开关的闸（#1086，engine-master.ts）：缓存怎么读、读不到按关；和「闸门测试」——总开关关着、把定时任务各跑一轮，
// 起模型会话的次数是 0、看家检查（探针等）至少各跑一次；开着时同样一轮，拉单、巡检跑了，对照证明这条测试抓得到「关着还在拉单」。
// 用假的钟和假的 setTimeout（和 timers.test.ts 同一套），不真等、不碰库、不起会话。
import { describe, expect, it } from 'vitest';
import type { EngineJobs } from '../src/activities.ts';
import { createEngineMasterGate, fixedEngineMaster, masterOffNote } from '../src/engine-master.ts';
import { engineTimerJobs } from '../src/jobs/engine-timers.ts';
import { startTimers, type TimerHost } from '../src/jobs/timers.ts';
import { oneShotSessions } from '../src/real/one-shot-sessions.ts';

const MIN = 60_000;
/** 一个整点（UTC 2026-10-05 00:00）：格子从 epoch 算起，整点在每个 5、15、60 分钟的格子上。 */
const T0 = Date.UTC(2026, 9, 5, 0, 0, 0);

describe('闸（createEngineMasterGate）', () => {
  const row = (value: unknown) => ({ value, updatedBy: 'user:frank', updatedAt: '2026-10-05T13:00:00.000Z' });

  it('没读过：关（不拿「还没读」当开）；读成了 true：开；读成了 false、没这一行：关', async () => {
    let result: ReturnType<typeof row> | null = row(true);
    const gate = createEngineMasterGate({ read: async () => result, log: () => {} });
    expect(gate.isOn()).toBe(false);
    expect(gate.state()).toMatchObject({ on: false, why: 'unread' });
    expect(await gate.refresh()).toBe(true);
    expect(gate.isOn()).toBe(true);
    result = row(false);
    expect(await gate.refresh()).toBe(false);
    expect(gate.state()).toMatchObject({ on: false, why: 'set' });
    result = null;
    expect(await gate.refresh()).toBe(false);
    expect(gate.state()).toMatchObject({ on: false, why: 'never_set' });
  });

  it('【故意造出的失败】值认不出（不是 true/false）：按关，写明认不出；不拿它当开', async () => {
    const gate = createEngineMasterGate({ read: async () => row('yes'), log: () => {} });
    expect(await gate.refresh()).toBe(false);
    expect(gate.state()).toMatchObject({ on: false, why: 'unreadable' });
    expect(masterOffNote(gate.state())).toContain('认不出');
  });

  it('【故意造出的失败】库读不到：按关（哪怕上一次是开着），日志写一次原因；恢复了再记一次，之后不重复刷', async () => {
    const logs: string[] = [];
    let broken = false;
    const gate = createEngineMasterGate({
      read: async () => {
        if (broken) throw new Error('库连不上（测试故意造的）');
        return row(true);
      },
      log: (m) => logs.push(m),
    });
    expect(await gate.refresh()).toBe(true);
    broken = true;
    expect(await gate.refresh()).toBe(false);
    expect(gate.state()).toMatchObject({ on: false, why: 'unread' });
    await gate.refresh();
    await gate.refresh();
    expect(logs.filter((m) => m.includes('读不到'))).toHaveLength(1);
    broken = false;
    expect(await gate.refresh()).toBe(true);
    expect(logs.filter((m) => m.includes('开着'))).toHaveLength(2);
  });

  it('并发的 refresh 只读一次库（库慢时不叠着读）', async () => {
    let reads = 0;
    let release: () => void = () => {};
    const gate = createEngineMasterGate({
      read: () => {
        reads += 1;
        return new Promise((resolve) => {
          release = () => resolve(row(true));
        });
      },
      log: () => {},
    });
    const a = gate.refresh();
    const b = gate.refresh();
    release();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(reads).toBe(1);
  });
});

describe('一次性会话登记（oneShotSessions）：关着这一段不起会话', () => {
  it('总开关关着：登记时信号一开始就是响的（runOneShot 当场回 org_switch、不起进程），原因写明总开关', () => {
    const reg = oneShotSessions({ master: fixedEngineMaster(false) });
    const ticket = reg.enter({ poolId: 'p', stage: 'execute', taskId: 't' });
    expect(ticket.signal.aborted).toBe(true);
    expect(String((ticket.signal.reason as Error).message)).toContain('总开关');
    expect(String((ticket.signal.reason as Error).message)).toContain('这一段没起会话');
  });

  it('总开关开着、或没接闸（测试里）：照常，信号没响', () => {
    const open = oneShotSessions({ master: fixedEngineMaster(true) }).enter({
      poolId: 'p',
      stage: 'execute',
      taskId: 't',
    });
    expect(open.signal.aborted).toBe(false);
    const none = oneShotSessions().enter({ poolId: 'p', stage: 'execute', taskId: 't' });
    expect(none.signal.aborted).toBe(false);
  });
});

// —— 闸门测试：关着时跑一轮所有定时任务，起会话 0 次、看家检查照跑 ——

interface Pending {
  at: number;
  fn: () => void;
  cleared: boolean;
}

/** 假的钟、假的 setTimeout（和 timers.test.ts 同一套）；master、recordSkipped 由用例给。 */
function rig(master: ReturnType<typeof fixedEngineMaster>) {
  let now = T0;
  const pending: Pending[] = [];
  const logs: string[] = [];
  const skipped: { jobId: string; why: string }[] = [];
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
    // 都当「刚跑过」：不触发「起来时补最近一轮」，只看到点的那一轮
    lastStartedAt: async () => new Date(T0),
    log: (level, text) => logs.push(`${level}:${text}`),
    master,
    recordSkipped: async (jobId, why) => {
      skipped.push({ jobId, why });
    },
  };
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return {
    host,
    logs,
    skipped,
    /** 拨到 t，途中到点的定时器按先后各叫一次。 */
    async advanceTo(t: number) {
      for (;;) {
        const due = pending
          .filter((p) => !p.cleared && p.at <= t)
          .sort((a, b) => a.at - b.at)
          .at(0);
        if (!due) break;
        due.cleared = true;
        now = Math.max(now, due.at);
        due.fn();
        await flush();
      }
      now = t;
      await flush();
    },
  };
}

/** 各任务一轮跑了几次：sessions 是拉单一轮起的模型会话数（拉单派活就是起任务、起会话），probes 是路由探针探的次数。 */
function counters() {
  return {
    sessions: 0,
    probes: 0,
    reconcile: 0,
    quota: 0,
    carpool: 0,
    hourly: 0,
    watchdog: 0,
    canaryStarts: 0,
    canarySweeps: 0,
  };
}

describe('闸门测试：总开关关着，跑一轮所有定时任务', () => {
  const fakeEngineJobs = (): EngineJobs => {
    const never = () => {
      throw new Error('这里不该被叫');
    };
    return {
      githubReconcile: never,
      routeProbe: never,
      quotaRead: never,
      carpoolWatch: never,
      hourlyReconcile: never,
      canary: never,
      watchdog: never,
      intake: never,
      ciTimings: never,
    } as unknown as EngineJobs;
  };
  const client = { workflow: { start: async () => ({}), getHandle: () => ({}) } } as never;

  /** 取 engineTimerJobs 的登记（格子、needsMaster 标记就是它定的），run 换成计数的替身，交给真的 startTimers 跑。 */
  function registered(count: ReturnType<typeof counters>) {
    const real = engineTimerJobs({ jobs: fakeEngineJobs(), client, taskQueue: 'fleet' });
    const stand: Record<string, () => Promise<unknown>> = {
      'github-reconcile': async () => {
        count.reconcile += 1;
      },
      'route-probe': async () => {
        count.probes += 1;
      },
      'quota-read': async () => {
        count.quota += 1;
      },
      'carpool-watch': async () => {
        count.carpool += 1;
      },
      'hourly-reconcile': async () => {
        count.hourly += 1;
      },
      watchdog: async () => {
        count.watchdog += 1;
      },
      // 拉单一轮会起任务、起模型会话；巡检会起一条巡检工作流（里面再开单、等拉单派活）
      intake: async () => {
        count.sessions += 1;
      },
      canary: async () => {
        count.canaryStarts += 1;
      },
    };
    return real.map((j) => ({
      ...j,
      run: stand[j.id] ?? (async () => {}),
      // 巡检的 onMasterSkip（#1141）会去调 jobs.canary 装依赖收留单；这里换成计数的替身（jobs.canary 是 never）
      ...(j.id === 'canary'
        ? {
            onMasterSkip: async () => {
              count.canarySweeps += 1;
            },
          }
        : {}),
    }));
  }

  it('关着：拉单、巡检不跑（起会话 0 次），探针和别的看家检查至少各跑一次；被跳过的两个各记一条原因', async () => {
    const count = counters();
    const r = rig(fixedEngineMaster(false));
    const timers = startTimers(registered(count), r.host);
    // 拨过 6 个半小时：巡检（6 小时一格）、每小时对账、15 分钟一格的探针和对账、5 分钟一格的拉单和看门狗都至少到点一回
    await r.advanceTo(T0 + 6 * 60 * MIN + 30 * MIN);
    await timers.stop(0);
    expect(count.sessions).toBe(0);
    expect(count.canaryStarts).toBe(0);
    expect(count.probes).toBeGreaterThanOrEqual(1);
    expect(count.reconcile).toBeGreaterThanOrEqual(1);
    expect(count.quota).toBeGreaterThanOrEqual(1);
    expect(count.carpool).toBeGreaterThanOrEqual(1);
    expect(count.hourly).toBeGreaterThanOrEqual(1);
    expect(count.watchdog).toBeGreaterThanOrEqual(1);
    const skippedJobs = new Set(r.skipped.map((s) => s.jobId));
    expect([...skippedJobs].sort()).toEqual(['canary', 'intake']);
    for (const s of r.skipped) expect(s.why).toContain('总开关');
    // 总开关关着跳过的轮次也收前面断轮留下的单（#1141）
    expect(count.canarySweeps).toBeGreaterThanOrEqual(1);
  });

  it('对照：开着同样一轮，拉单、巡检都跑了（证明上面那条抓得到「关着还在拉单」）', async () => {
    const count = counters();
    const r = rig(fixedEngineMaster(true));
    const timers = startTimers(registered(count), r.host);
    await r.advanceTo(T0 + 6 * 60 * MIN + 30 * MIN);
    await timers.stop(0);
    expect(count.sessions).toBeGreaterThanOrEqual(1);
    expect(count.canaryStarts).toBeGreaterThanOrEqual(1);
    expect(count.probes).toBeGreaterThanOrEqual(1);
    expect(count.canarySweeps).toBe(0);
    expect(r.skipped).toEqual([]);
  });

  it('关着时只有拉单、巡检标了 needsMaster：看家检查一个都不标（标多了关着就看不见渠道通不通）', () => {
    const flagged = engineTimerJobs({ jobs: fakeEngineJobs(), client, taskQueue: 'fleet' })
      .filter((j) => j.needsMaster)
      .map((j) => j.id)
      .sort();
    expect(flagged).toEqual(['canary', 'intake']);
  });

  it('【故意造出的失败】总开关读不到（闸按关算）：拉单照样不跑；记「跳过」没记上也只记日志，不停掉定时', async () => {
    const count = counters();
    const failing = createEngineMasterGate({
      read: async () => {
        throw new Error('库连不上（测试故意造的）');
      },
      log: () => {},
    });
    const r = rig(failing as never);
    r.host.recordSkipped = async () => {
      throw new Error('schedule_runs 写不进（测试故意造的）');
    };
    const timers = startTimers(registered(count), r.host);
    await r.advanceTo(T0 + 30 * MIN);
    await timers.stop(0);
    expect(count.sessions).toBe(0);
    expect(count.probes).toBeGreaterThanOrEqual(1);
    expect(r.logs.some((l) => l.startsWith('error:') && l.includes('没记进 schedule_runs'))).toBe(true);
  });
});
