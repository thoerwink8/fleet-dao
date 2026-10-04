// 拼车「用不了」分哪一种、「恢复了」凭什么认（jobs/carpool-outage.ts，#194 方案 v2 4.2、4.4、第六节）。
// 读不到、认不出、对不上的每一条都故意造一次：不当成恢复、不当成到点了、不当成 0 或满。
import { describe, expect, it } from 'vitest';
import {
  type CarpoolApiRead,
  type CarpoolOutage,
  type CarpoolQuota,
  classifyCarpoolRejection,
  freshReads,
  judgeCarpoolRecovery,
  outageFromApi,
} from '../src/jobs/carpool-outage.ts';

const T0 = new Date('2026-10-04T02:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

const quota = (usedUsd: number, over: Partial<CarpoolQuota> = {}): CarpoolQuota => ({
  usedUsd,
  limitUsd: 80,
  resetsAt: at(200 * MIN),
  status: 'active',
  ...over,
});

function read(ms: number, q: CarpoolQuota | null, over: Partial<Extract<CarpoolApiRead, { ok: true }>> = {}) {
  return {
    ok: true as const,
    requestedAt: at(ms),
    serverDate: at(ms),
    ageSeconds: null,
    quota: q,
    org: 'ok' as const,
    ...over,
  };
}
const failRead = (ms: number, why = '503'): CarpoolApiRead => ({
  ok: false,
  requestedAt: at(ms),
  code: 'http',
  why,
});

const CARPOOL_REJECT =
  'API Error: Server is temporarily limiting requests (not your usage limit) · 拼车 5 小时额度已用完，约 20 分钟后重置，请稍后再来（请求 ID: <请求ID>）';
const OFFICIAL_REJECT = "Claude AI usage limit reached. You've hit your 5-hour limit";

describe('被拒是哪一种', () => {
  it('拼车本人那句（夹具 X03）→ E1；接口读到顶时恢复时刻取接口的', () => {
    const v = classifyCarpoolRejection({ at: T0, text: CARPOOL_REJECT }, read(-MIN, quota(80)));
    expect(v.kind).toBe('outage');
    if (v.kind !== 'outage') return;
    expect(v.outage).toMatchObject({ kind: 'E1', resetsFrom: 'api', resetsAt: at(200 * MIN) });
    expect(v.outage.mismatch).toBeUndefined();
  });

  it('拼车本人那句、接口没读过 → E1，恢复时刻取原文的「约 20 分钟」', () => {
    const v = classifyCarpoolRejection({ at: T0, text: CARPOOL_REJECT }, null);
    expect(v).toMatchObject({
      kind: 'outage',
      outage: { kind: 'E1', resetsFrom: 'text', resetsAt: at(20 * MIN) },
    });
  });

  it('第六节第 4 条：接口说 $10/$80、原文是官方 5 小时那句 → 照被拒切，记 E2、时刻取原文、记对不上', () => {
    const v = classifyCarpoolRejection(
      { at: T0, text: `${OFFICIAL_REJECT}, resets in 30 minutes` },
      read(-MIN, quota(10)),
    );
    expect(v.kind).toBe('outage');
    if (v.kind !== 'outage') return;
    expect(v.outage).toMatchObject({ kind: 'E2', resetsFrom: 'text', resetsAt: at(30 * MIN) });
    expect(v.outage.mismatch).toMatch(/没用满，请求却被拒/);
  });

  it('官方那句、接口也说到顶 → E1', () => {
    const v = classifyCarpoolRejection({ at: T0, text: OFFICIAL_REJECT }, read(-MIN, quota(80.5)));
    expect(v).toMatchObject({ kind: 'outage', outage: { kind: 'E1', resetsFrom: 'api' } });
  });

  it('官方那句、接口读不成 → E2（不猜本人满了），恢复时刻不知道就是 null', () => {
    const v = classifyCarpoolRejection({ at: T0, text: OFFICIAL_REJECT }, failRead(-MIN));
    expect(v).toMatchObject({ kind: 'outage', outage: { kind: 'E2', resetsAt: null, resetsFrom: null } });
  });

  it('「所选组织没有可用的绑定账号」→ E3，没有恢复时刻', () => {
    const v = classifyCarpoolRejection({ at: T0, text: '所选组织没有可用的绑定账号' }, null);
    expect(v).toMatchObject({ kind: 'outage', outage: { kind: 'E3', resetsAt: null } });
  });

  it('第六节第 7 条：401 device_revoked → 设备级，不切号', () => {
    expect(classifyCarpoolRejection({ at: T0, text: '401 device_revoked' }, null).kind).toBe('device');
    expect(classifyCarpoolRejection({ at: T0, code: 'device_revoked', text: '' }, null).kind).toBe('device');
  });

  it('第六节第 8 条：按分钟限流、过载 → 不切号、不记用满', () => {
    expect(
      classifyCarpoolRejection({ at: T0, text: '429 Too many requests: 50 requests per minute' }, null).kind,
    ).toBe('throttle');
    expect(classifyCarpoolRejection({ at: T0, httpStatus: 529, text: 'Overloaded' }, null).kind).toBe(
      'throttle',
    );
  });

  it('「not your usage limit」单独出现不认成用满', () => {
    const v = classifyCarpoolRejection(
      { at: T0, text: 'Server is temporarily limiting requests (not your usage limit)' },
      null,
    );
    expect(v.kind).not.toBe('outage');
  });

  it('别的报错 → other，交给失败分流', () => {
    expect(classifyCarpoolRejection({ at: T0, text: 'ENOENT: no such file' }, null).kind).toBe('other');
  });
});

describe('只看接口认用不了', () => {
  it('本人到顶 → E1；组织没分到账号 → E3；读不成、正常 → null（读不成不是用不了的证据）', () => {
    expect(outageFromApi(read(0, quota(80)))).toMatchObject({ kind: 'E1', resetsFrom: 'api' });
    expect(outageFromApi(read(0, quota(5), { org: 'no-account' }))).toMatchObject({ kind: 'E3' });
    expect(outageFromApi(failRead(0))).toBeNull();
    expect(outageFromApi(read(0, quota(40)))).toBeNull();
  });

  it('第六节第 2 条：金额认不出不当 0 也不当满', () => {
    expect(outageFromApi(read(0, quota(Number.NaN)))).toBeNull();
  });
});

const e1: CarpoolOutage = {
  kind: 'E1',
  since: T0,
  resetsAt: at(200 * MIN),
  resetsFrom: 'api',
  evidence: 'x',
};

describe('E1 恢复：连着两次真新读数过切回线', () => {
  it('隔 1 分钟两次都归零、active → 恢复', () => {
    const v = judgeCarpoolRecovery(e1, [read(201 * MIN, quota(0)), read(202 * MIN, quota(0))]);
    expect(v.state).toBe('recovered');
  });

  it('只有一次过线 → 还没（等第二次确认）', () => {
    expect(judgeCarpoolRecovery(e1, [read(201 * MIN, quota(0))]).state).toBe('not-yet');
  });

  it('第六节第 18 条：两次回同一份缓存（Age 300）→ 不算新读数，unknown', () => {
    const stale = { ageSeconds: 300 };
    const v = judgeCarpoolRecovery(e1, [read(201 * MIN, quota(0), stale), read(202 * MIN, quota(0), stale)]);
    expect(v.state).toBe('unknown');
  });

  it('第六节第 18 条：两次的服务端 Date 一样 → 只算一次', () => {
    const same = { serverDate: at(201 * MIN) };
    const v = judgeCarpoolRecovery(e1, [read(201 * MIN, quota(0), same), read(202 * MIN, quota(0), same)]);
    expect(v.state).toBe('not-yet');
  });

  it('中间有一次没过线 → 不算连着两次', () => {
    const v = judgeCarpoolRecovery(e1, [
      read(201 * MIN, quota(0)),
      read(202 * MIN, quota(70)),
      read(202.5 * MIN, quota(0)),
    ]);
    expect(v.state).toBe('not-yet');
  });

  it('迟滞：只退回到剩 30%（切回线 50%）→ 不切回', () => {
    const v = judgeCarpoolRecovery(e1, [read(201 * MIN, quota(56)), read(202 * MIN, quota(56))]);
    expect(v).toMatchObject({ state: 'not-yet' });
    expect(v.why).toMatch(/不到切回线/);
  });

  it('第六节第 2 条：已归零但 status 是 suspended → 不切回', () => {
    const s = { status: 'suspended' };
    const v = judgeCarpoolRecovery(e1, [read(201 * MIN, quota(0, s)), read(202 * MIN, quota(0, s))]);
    expect(v.state).toBe('not-yet');
  });

  it('第六节第 2 条：金额认不出（NaN）→ 不切回', () => {
    const v = judgeCarpoolRecovery(e1, [read(201 * MIN, quota(0)), read(202 * MIN, quota(Number.NaN))]);
    expect(v.state).toBe('not-yet');
  });

  it('第六节第 16 条：被拒之前的读数说有余额、之后再没读成 → unknown，不当恢复', () => {
    const v = judgeCarpoolRecovery(e1, [read(-40 * MIN, quota(0)), failRead(210 * MIN)]);
    expect(v.state).toBe('unknown');
    expect(v.why).toMatch(/503/);
  });

  it('第六节第 14 条：本机钟早过了恢复时刻、接口说还没归零 → 不切回', () => {
    const v = judgeCarpoolRecovery(e1, [read(260 * MIN, quota(79)), read(261 * MIN, quota(79))]);
    expect(v.state).toBe('not-yet');
  });
});

describe('E2 恢复：恢复时刻之后的新读数说正常', () => {
  const e2: CarpoolOutage = {
    kind: 'E2',
    since: T0,
    resetsAt: at(30 * MIN),
    resetsFrom: 'text',
    evidence: 'x',
  };

  it('恢复时刻之后读到正常、本人没满 → 恢复', () => {
    expect(judgeCarpoolRecovery(e2, [read(31 * MIN, quota(10))]).state).toBe('recovered');
  });

  it('第六节第 14 条：只有恢复时刻之前的读数（服务端钟）→ 不算，本机钟到点不算数', () => {
    const v = judgeCarpoolRecovery(e2, [read(31 * MIN, quota(10), { serverDate: at(20 * MIN) })]);
    expect(v.state).toBe('not-yet');
  });

  it('第六节第 5 条：恢复时刻不知道 → unknown（交给退避试探），不当到点了', () => {
    const v = judgeCarpoolRecovery({ ...e2, resetsAt: null, resetsFrom: null }, [read(31 * MIN, quota(10))]);
    expect(v.state).toBe('unknown');
  });
});

describe('E3 恢复：接口说拼车组织又能用', () => {
  const e3: CarpoolOutage = { kind: 'E3', since: T0, resetsAt: null, resetsFrom: null, evidence: 'x' };

  it('第六节第 6 条：组织还没分到账号（旧窗口清零时刻早过了）→ 不切回', () => {
    const v = judgeCarpoolRecovery(e3, [
      read(300 * MIN, quota(0, { resetsAt: at(-MIN) }), { org: 'no-account' }),
    ]);
    expect(v.state).toBe('not-yet');
  });

  it('组织恢复、本人没满 → 恢复', () => {
    expect(judgeCarpoolRecovery(e3, [read(10 * MIN, quota(0))]).state).toBe('recovered');
  });

  it('组织接口没读成（unknown）→ 不切回', () => {
    expect(judgeCarpoolRecovery(e3, [read(10 * MIN, quota(0), { org: 'unknown' })]).state).toBe('not-yet');
  });
});

describe('真新读数', () => {
  it('发请求在被拒之前的不算', () => {
    expect(freshReads([read(-MIN, quota(0))], T0)).toEqual([]);
  });
});
