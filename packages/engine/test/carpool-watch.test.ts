// 拼车额度盯读（jobs/carpool-watch.ts，#194 方案 4.1）：这一分钟真不真读接口、读不到明确失败、读到了交给切号。
// 每条「不许做」都故意造一次：读不到不报平安、连着失败退避不硬砸、账本认不出这一轮记没跑成不假装读过。
import { describe, expect, it } from 'vitest';
import type { CarpoolApiRead, CarpoolOutage } from '../src/jobs/carpool-outage.ts';
import {
  apiFailureAlert,
  type CarpoolWatchDeps,
  CarpoolWatchFailedError,
  DEFAULT_WATCH_POLICY,
  needsSwitchCheck,
  readSchedule,
  runCarpoolWatchJob,
  trailingFailures,
} from '../src/jobs/carpool-watch.ts';
import { emptyLedger, type OrgLedger, OrgLedgerError } from '../src/jobs/org-ledger.ts';
import type { OrgSwitchTrigger } from '../src/jobs/org-switch.ts';

const T0 = new Date('2026-10-04T12:00:00.000Z');
const MIN = 60_000;
const at = (m: number) => new Date(T0.getTime() + m * MIN);

const ok = (m: number, used = 10, resetsInMin: number | null = 100): CarpoolApiRead => ({
  ok: true,
  requestedAt: at(m),
  serverDate: at(m),
  ageSeconds: null,
  quota: {
    usedUsd: used,
    limitUsd: 80,
    resetsAt: resetsInMin === null ? null : at(resetsInMin),
    status: 'active',
  },
  org: 'ok',
});
const fail = (m: number, code: 'network' | 'http' | 'auth' | 'bad_response' | 'throttled' = 'http') =>
  ({ ok: false, requestedAt: at(m), code, why: '503' }) satisfies CarpoolApiRead;
const led = (over: Partial<OrgLedger> = {}): OrgLedger => ({ ...emptyLedger(), ...over });
const carpool = { ok: true, org: 'carpool' } as const;
const solo = { ok: true, org: 'solo' } as const;
const outage = (resetsInMin: number | null): CarpoolOutage => ({
  kind: 'E1',
  since: at(-30),
  resetsAt: resetsInMin === null ? null : at(resetsInMin),
  resetsFrom: 'api',
  evidence: 'x',
});

describe('这一分钟读不读接口、间隔多少', () => {
  it('平时挂拼车：5 分钟一次；从没读过马上读', () => {
    expect(readSchedule(led(), carpool, T0).due).toBe(true);
    const l = led({ reads: [ok(-3)] });
    expect(readSchedule(l, carpool, T0)).toMatchObject({ due: false, everyMs: 5 * MIN });
    expect(readSchedule(l, carpool, at(2))).toMatchObject({ due: true });
  });

  it('紧：挂着拼车、本人额度剩不到 25%：1 分钟一次', () => {
    const l = led({ reads: [ok(-2, 70)] });
    expect(readSchedule(l, carpool, T0)).toMatchObject({ due: true, everyMs: MIN });
    expect(readSchedule(l, carpool, T0).why).toContain('剩不到 25%');
  });

  it('紧：记着拼车用不了（还没切走）/ 切回宽限中：1 分钟一次', () => {
    expect(readSchedule(led({ outage: outage(60), reads: [ok(-1)] }), carpool, T0).everyMs).toBe(MIN);
    expect(
      readSchedule(
        led({ backPending: { since: at(-1), mode: 'confirmed', why: 'x' }, reads: [ok(-1)] }),
        solo,
        T0,
      ).everyMs,
    ).toBe(MIN);
  });

  it('挂着独享：离恢复时刻还远（超过 15 分钟）5 分钟一次；不到 15 分钟或已经过了 1 分钟一次', () => {
    const far = led({ outage: outage(120), reads: [ok(-1)] });
    expect(readSchedule(far, solo, T0).everyMs).toBe(5 * MIN);
    expect(readSchedule(led({ outage: outage(10), reads: [ok(-1)] }), solo, T0).everyMs).toBe(MIN);
    expect(readSchedule(led({ outage: outage(-5), reads: [ok(-1)] }), solo, T0).everyMs).toBe(MIN);
  });

  it('【故意造出失败】连着读失败：按 1 → 2 → 5 分钟退避，比「紧」优先——接口在抖，不硬砸', () => {
    const hot = { outage: outage(10) };
    expect(readSchedule(led({ ...hot, reads: [fail(-1)] }), solo, T0)).toMatchObject({
      everyMs: MIN,
      due: true,
    });
    const two = led({ ...hot, reads: [fail(-2), fail(-1)] });
    expect(readSchedule(two, solo, T0)).toMatchObject({ everyMs: 2 * MIN, due: false });
    const many = led({ ...hot, reads: [fail(-9), fail(-8), fail(-7), fail(-6), fail(-1)] });
    expect(readSchedule(many, solo, T0).everyMs).toBe(5 * MIN);
    expect(trailingFailures(many)).toBe(5);
    // 读成一次就不算连着失败了
    expect(trailingFailures(led({ reads: [fail(-3), ok(-2)] }))).toBe(0);
  });
});

describe('什么时候要叫切号判一次', () => {
  it('读到了、记着恢复条件、宽限中、挂着独享：要；挂着拼车且什么都没有、没读：不要', () => {
    expect(needsSwitchCheck(led(), carpool, true)).toBe(true);
    expect(needsSwitchCheck(led({ outage: outage(10) }), carpool, false)).toBe(true);
    expect(needsSwitchCheck(led(), solo, false)).toBe(true);
    expect(needsSwitchCheck(led(), carpool, false)).toBe(false);
  });
});

describe('读失败要不要报', () => {
  const failed = (code: 'network' | 'http' | 'auth' | 'bad_response' | 'throttled') =>
    fail(0, code) as Extract<CarpoolApiRead, { ok: false }>;
  it('Key 失效、回包认不出：当场报；网断、5xx、限流：连着 2 次才报，第 1 次不报', () => {
    expect(apiFailureAlert(failed('auth'), 1, DEFAULT_WATCH_POLICY)?.body).toContain('要人动手');
    expect(apiFailureAlert(failed('bad_response'), 1, DEFAULT_WATCH_POLICY)).not.toBeNull();
    for (const code of ['network', 'http', 'throttled'] as const) {
      expect(apiFailureAlert(failed(code), 1, DEFAULT_WATCH_POLICY)).toBeNull();
      expect(apiFailureAlert(failed(code), 2, DEFAULT_WATCH_POLICY)?.body).toContain('连着 2 次没读成');
    }
  });
});

function harness(
  over: Partial<CarpoolWatchDeps> & { ledger?: OrgLedger; live?: typeof carpool | typeof solo } = {},
) {
  const calls: OrgSwitchTrigger[] = [];
  const alerts: { key: string; title: string }[] = [];
  const resolved: string[] = [];
  const runs: { start: string[]; finish: unknown[] } = { start: [], finish: [] };
  const logs: string[] = [];
  const deps: CarpoolWatchDeps = {
    loadLedger: async () => over.ledger ?? led(),
    liveOrg: async () => over.live ?? carpool,
    read: async () => ok(0),
    switchNow: async (t) => {
      calls.push(t);
      return null;
    },
    raise: async (a) => void alerts.push({ key: a.key, title: a.title }),
    resolve: async (k) => void resolved.push(k),
    runs: {
      start: async (job) => {
        runs.start.push(job);
        return 7;
      },
      finish: async (_id, result) => void runs.finish.push(result),
    },
    now: () => T0,
    log: (_l, m) => void logs.push(m),
    ...over,
  };
  return { deps, calls, alerts, resolved, runs, logs };
}

describe('跑一轮', () => {
  it('到点：读接口、读成了撤报警、交给切号当场判（带上这条读数）', async () => {
    const h = harness();
    const run = await runCarpoolWatchJob(h.deps);
    expect(run).toMatchObject({ runId: 7, outcome: 'ok', scanned: 1, found: 0 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.by).toBe('定时读接口');
    expect(h.calls[0]?.read?.ok).toBe(true);
    expect(h.resolved).toContain('carpool-api');
  });

  it('没到点、挂着拼车且没什么要判的：不读、不叫切号', async () => {
    const h = harness({ ledger: led({ reads: [ok(-1)] }) });
    const run = await runCarpoolWatchJob(h.deps);
    expect(run.outcome).toBe('ok');
    expect(h.calls).toEqual([]);
  });

  it('没到点、但挂着独享：不读，照样叫切号判一次（宽限到点、最小停留到点靠这个）', async () => {
    const h = harness({ ledger: led({ reads: [ok(-1)], outage: outage(120) }), live: solo });
    await runCarpoolWatchJob(h.deps);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.read).toBeUndefined();
  });

  it('【故意造出失败】读不到（503）：记 partial、写明原因；读数照样交给切号存进账本；第 1 次不报警，连着第 2 次才报', async () => {
    const first = harness({ read: async () => fail(0) });
    const r1 = await runCarpoolWatchJob(first.deps);
    expect(r1).toMatchObject({ outcome: 'partial', found: 0 });
    expect(r1.why).toContain('503');
    expect(first.alerts).toEqual([]);
    expect(first.calls[0]?.read?.ok).toBe(false);
    const second = harness({ ledger: led({ reads: [fail(-2)] }), read: async () => fail(0) });
    const r2 = await runCarpoolWatchJob(second.deps);
    expect(r2.found).toBe(1);
    expect(second.alerts.map((a) => a.key)).toEqual(['carpool-api']);
  });

  it('【故意造出失败】Key 失效（401）：当场报警，不等第二次', async () => {
    const h = harness({ read: async () => fail(0, 'auth') });
    await runCarpoolWatchJob(h.deps);
    expect(h.alerts.map((a) => a.title)).toEqual(['拼车额度接口读不到（切号用）']);
  });

  it('【故意造出失败】账本认不出：这一轮记 failed 并抛，不读接口、不叫切号、不假装读过', async () => {
    const h = harness({
      loadLedger: async () => {
        throw new OrgLedgerError('版本不对');
      },
    });
    await expect(runCarpoolWatchJob(h.deps)).rejects.toBeInstanceOf(CarpoolWatchFailedError);
    expect(h.calls).toEqual([]);
    expect(JSON.stringify(h.runs.finish)).toContain('failed');
  });
});
