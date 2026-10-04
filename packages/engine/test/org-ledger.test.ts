// 切号账本（jobs/org-ledger.ts，#194 第六节第 13 条）：存了能原样读回；认不出明确失败，不当成空账本。
import { OrgLedgerViewDocSchema } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import type { CarpoolApiRead } from '../src/jobs/carpool-outage.ts';
import {
  emptyLedger,
  lastOkRead,
  ledgerAfterSwitch,
  OrgLedgerError,
  parseLedger,
  READS_KEPT,
  serializeLedger,
  withRead,
} from '../src/jobs/org-ledger.ts';

const T0 = new Date('2026-10-04T12:00:00.000Z');
const MIN = 60_000;
const at = (m: number) => new Date(T0.getTime() + m * MIN);

const read = (m: number): CarpoolApiRead => ({
  ok: true,
  requestedAt: at(m),
  serverDate: at(m),
  ageSeconds: 3,
  quota: { usedUsd: 10, limitUsd: 80, resetsAt: at(m + 100), status: 'active' },
  org: 'ok',
  accounts: [{ id: 'a', kind: 'carpool', hasAssignedAccount: true, expiresAt: at(9999) }],
});

describe('存取', () => {
  it('空账本、满账本都能存成 JSON 再原样读回', () => {
    expect(parseLedger(JSON.parse(JSON.stringify(serializeLedger(emptyLedger()))))).toEqual(emptyLedger());
    const full = {
      ...emptyLedger(),
      outage: {
        kind: 'E2' as const,
        since: at(-5),
        resetsAt: at(30),
        resetsFrom: 'text' as const,
        evidence: '官方窗口',
        mismatch: '接口说有余额',
      },
      onSoloSince: at(-4),
      backs: [{ at: at(-100), trial: true }],
      lastBack: { at: at(-100), trial: true },
      whites: { count: 2, lastAt: at(-90), lastTrial: true },
      helperFailures: [at(-3)],
      reads: [read(-2), { ok: false as const, requestedAt: at(-1), code: 'http' as const, why: '503' }],
      soloPause: { since: at(-60), by: '创始人', reason: '我要用独享' },
      channel: { state: 'single' as const, since: at(-10), why: '只剩 1 个' },
      backPending: { since: at(-1), mode: 'trial' as const, why: 'x' },
      live: 'solo' as const,
      liveAt: at(-1),
    };
    expect(parseLedger(JSON.parse(JSON.stringify(serializeLedger(full))))).toEqual(full);
  });
});

describe('和驾驶舱后端读的形状对得上（shared 的 org-ledger-doc.ts）', () => {
  it('引擎写出去的账本（空的、满的）驾驶舱读得出；字段改了名它会红', () => {
    const full = {
      ...emptyLedger(),
      outage: {
        kind: 'E1' as const,
        since: at(-5),
        resetsAt: at(30),
        resetsFrom: 'api' as const,
        evidence: 'x',
      },
      onSoloSince: at(-4),
      channel: { state: 'single' as const, since: at(-10), why: '只剩 1 个' },
      backPending: { since: at(-1), mode: 'confirmed' as const, why: 'x' },
      whites: { count: 2, lastAt: at(-9), lastTrial: false },
      reads: [read(-2), { ok: false as const, requestedAt: at(-1), code: 'http' as const, why: '503' }],
      live: 'solo' as const,
      liveAt: at(-1),
    };
    for (const l of [emptyLedger(), full]) {
      expect(OrgLedgerViewDocSchema.safeParse(JSON.parse(JSON.stringify(serializeLedger(l)))).success).toBe(
        true,
      );
    }
    const renamed = JSON.parse(JSON.stringify(serializeLedger(full)));
    renamed.liveOrg = renamed.live;
    renamed.live = undefined;
    expect(OrgLedgerViewDocSchema.safeParse(renamed).success).toBe(false);
  });
});

describe('【故意造出失败】认不出的账本：抛 OrgLedgerError，不当成空账本', () => {
  it('不是对象 / 版本不对 / 缺字段 / 时间不是时间 / 读数形状不对', () => {
    const good = JSON.parse(JSON.stringify(serializeLedger(emptyLedger())));
    for (const bad of [
      null,
      'x',
      { ...good, v: 2 },
      { ...good, whites: undefined },
      { ...good, onSoloSince: 'not a time' },
      { ...good, reads: [{ ok: true, requestedAt: T0.toISOString() }] },
      { ...good, channel: { state: 'weird', since: T0.toISOString(), why: '' } },
    ]) {
      expect(() => parseLedger(bad)).toThrow(OrgLedgerError);
    }
  });

  it('错误信息带出是哪一项', () => {
    const good = JSON.parse(JSON.stringify(serializeLedger(emptyLedger())));
    expect(() => parseLedger({ ...good, onSoloSince: 'not a time' })).toThrow(/onSoloSince/);
  });
});

describe('变换', () => {
  it('读数按发请求的时刻排好，只留最近 READS_KEPT 条', () => {
    let l = emptyLedger();
    for (let i = 0; i < READS_KEPT + 5; i++) l = withRead(l, read(i));
    l = withRead(l, read(-1000));
    expect(l.reads).toHaveLength(READS_KEPT);
    expect(l.reads[0]?.requestedAt.getTime()).toBeGreaterThan(at(-1000).getTime());
  });

  it('lastOkRead 跳过读失败的', () => {
    let l = withRead(emptyLedger(), read(0));
    l = withRead(l, { ok: false, requestedAt: at(1), code: 'network', why: '断' });
    expect(lastOkRead(l)?.requestedAt).toEqual(at(0));
    expect(lastOkRead(emptyLedger())).toBeNull();
  });

  it('切到独享：记挂上的时刻，清宽限和帮手失败，恢复条件留着', () => {
    const l = {
      ...emptyLedger(),
      outage: { kind: 'E1' as const, since: at(-1), resetsAt: null, resetsFrom: null, evidence: 'x' },
      helperFailures: [at(-2)],
      backPending: { since: at(-3), mode: 'confirmed' as const, why: 'x' },
    };
    const r = ledgerAfterSwitch(l, 'solo', at(0), null);
    expect(r.onSoloSince).toEqual(at(0));
    expect(r.outage).not.toBeNull();
    expect(r.helperFailures).toEqual([]);
    expect(r.backPending).toBeNull();
  });

  it('切回拼车：清恢复条件、记切回（试探的标出来）；很久以前的切回记录丢掉', () => {
    const l = {
      ...emptyLedger(),
      outage: { kind: 'E1' as const, since: at(-1), resetsAt: null, resetsFrom: null, evidence: 'x' },
      onSoloSince: at(-50),
      backs: [{ at: at(-24 * 60), trial: false }],
    };
    const r = ledgerAfterSwitch(l, 'carpool', at(0), 'trial');
    expect(r.outage).toBeNull();
    expect(r.onSoloSince).toBeNull();
    expect(r.lastBack).toEqual({ at: at(0), trial: true });
    expect(r.backs).toEqual([{ at: at(0), trial: true }]);
  });
});
