import { describe, expect, it } from 'vitest';
import {
  ENGINE_MASTER_RELEASE_GRACE_MS,
  engineMasterOffWithinReleaseGrace,
  isReleaseStuckMasterOff,
  latestAuditIsReleasePause,
  releaseSiteInFlight,
} from '../src/web-api/engine-master-stuck.ts';
import { ENGINE_MASTER_DISABLE, ENGINE_MASTER_ENABLE } from '../src/web-api/engine-switch.ts';

const NOW = new Date('2026-10-10T08:00:00.000Z');

describe('isReleaseStuckMasterOff（#1732）', () => {
  it('开着不算卡住', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: true,
        latest: {
          action: ENGINE_MASTER_DISABLE,
          reason: '发版前暂停（x）',
          at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        },
        now: NOW,
        releaseInFlight: false,
      }),
    ).toBe(false);
  });

  it('发版还在走不算卡住', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: false,
        latest: {
          action: ENGINE_MASTER_DISABLE,
          reason: '发版前暂停（x）',
          at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        },
        now: NOW,
        releaseInFlight: true,
      }),
    ).toBe(false);
  });

  it('宽限内不算卡住', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: false,
        latest: {
          action: ENGINE_MASTER_DISABLE,
          reason: '发版前暂停（release-train）',
          at: new Date(NOW.getTime() - 10 * 60_000),
        },
        now: NOW,
        releaseInFlight: false,
      }),
    ).toBe(false);
  });

  it('发版前暂停关上、过了宽限、没开回：卡住', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: false,
        latest: {
          action: ENGINE_MASTER_DISABLE,
          reason: '发版前暂停（驾驶舱点击发布，目标 abcdef012345）',
          at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        },
        now: NOW,
        releaseInFlight: false,
      }),
    ).toBe(true);
  });

  it('有意关（原因不含发版前暂停）不自动当卡住', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: false,
        latest: {
          action: ENGINE_MASTER_DISABLE,
          reason: '今晚先停派活，明天再说',
          at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        },
        now: NOW,
        releaseInFlight: false,
      }),
    ).toBe(false);
  });

  it('最近一笔是打开：不算卡住', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: false,
        latest: {
          action: ENGINE_MASTER_ENABLE,
          reason: '发版后恢复',
          at: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        },
        now: NOW,
        releaseInFlight: false,
      }),
    ).toBe(false);
  });
});

describe('releaseSiteInFlight（#1732 返工：过期现场不算在走）', () => {
  it('新鲜暂停标记或新鲜 running：在走', () => {
    expect(
      releaseSiteInFlight({
        pauseActive: true,
        pauseMtimeMs: NOW.getTime() - 10 * 60_000,
        trainRunning: false,
        trainBeatMs: null,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      releaseSiteInFlight({
        pauseActive: false,
        pauseMtimeMs: null,
        trainRunning: true,
        trainBeatMs: NOW.getTime() - 10 * 60_000,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('暂停标记或 running 超过宽限：不在走（驱动死了没清）', () => {
    expect(
      releaseSiteInFlight({
        pauseActive: true,
        pauseMtimeMs: NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1,
        trainRunning: false,
        trainBeatMs: null,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      releaseSiteInFlight({
        pauseActive: false,
        pauseMtimeMs: null,
        trainRunning: true,
        trainBeatMs: NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('有标记但时刻认不出：不在走（不挡恢复、不一直绿）', () => {
    expect(
      releaseSiteInFlight({
        pauseActive: true,
        pauseMtimeMs: null,
        trainRunning: true,
        trainBeatMs: null,
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe('engineMasterOffWithinReleaseGrace', () => {
  it('新鲜暂停或刚写过发布历史：在宽限里；太久了不在', () => {
    expect(
      engineMasterOffWithinReleaseGrace({
        pauseActive: true,
        pauseMtimeMs: NOW.getTime() - 10 * 60_000,
        trainRunning: false,
        trainBeatMs: null,
        lastReleaseAt: null,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      engineMasterOffWithinReleaseGrace({
        pauseActive: false,
        pauseMtimeMs: null,
        trainRunning: false,
        trainBeatMs: null,
        lastReleaseAt: new Date(NOW.getTime() - 10 * 60_000),
        now: NOW,
      }),
    ).toBe(true);
    expect(
      engineMasterOffWithinReleaseGrace({
        pauseActive: false,
        pauseMtimeMs: null,
        trainRunning: false,
        trainBeatMs: null,
        lastReleaseAt: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        now: NOW,
      }),
    ).toBe(false);
  });

  it('过期暂停标记不挡：宽限外红', () => {
    expect(
      engineMasterOffWithinReleaseGrace({
        pauseActive: true,
        pauseMtimeMs: NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1,
        trainRunning: false,
        trainBeatMs: null,
        lastReleaseAt: new Date(NOW.getTime() - ENGINE_MASTER_RELEASE_GRACE_MS - 1),
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe('latestAuditIsReleasePause', () => {
  it('认出发版前暂停；有意关不算', () => {
    expect(
      latestAuditIsReleasePause({
        action: ENGINE_MASTER_DISABLE,
        reason: '发版前暂停（release-train）',
        at: NOW,
      }),
    ).toBe(true);
    expect(
      latestAuditIsReleasePause({
        action: ENGINE_MASTER_DISABLE,
        reason: '今晚先停',
        at: NOW,
      }),
    ).toBe(false);
  });
});

/**
 * #1732 本轮现场夹具（2026-10-10，法国机会话只读复核，不是有意关）：
 * - 08:23 CST：SSH 复核 engine.master=true、接活开着（单原文）
 * - 15:36 CST：healthz canary「跳过：引擎总开关关着…」；watchdog 15:34 仍绿
 * - 15:42 CST：.history 末行 `2026-10-10T07:42:51Z 6ae542cc… release`；`.train/` 空（无暂停标记、无 progress）
 * - 会话用户无 root / 连不上 8787（nft 只放行 fleet）：不能当场 fleet-api engine on
 * 结论：发版暂停后未恢复（误关/未恢复），不是有意关；有意关分支不适用。
 */
describe('本轮现场夹具（#1732 验收第 1/3 条）', () => {
  const disableAt = new Date('2026-10-10T07:00:00.000Z'); // 发版暂停约在 15:00 CST 一带
  const superviseAt = new Date('2026-10-10T07:36:00.000Z'); // 15:36 CST
  const afterGrace = new Date(disableAt.getTime() + ENGINE_MASTER_RELEASE_GRACE_MS + 60_000);

  it('按操作记录判：发版前暂停且过了宽限 → 卡住应开回；有意关文案则不应开回', () => {
    expect(
      isReleaseStuckMasterOff({
        masterOn: false,
        latest: {
          action: ENGINE_MASTER_DISABLE,
          reason: '发版前暂停（驾驶舱点击发布，目标 6ae542cc8c43）',
          at: disableAt,
        },
        now: afterGrace,
        releaseInFlight: false,
      }),
    ).toBe(true);
    expect(
      isReleaseStuckMasterOff({
        masterOn: false,
        latest: {
          action: ENGINE_MASTER_DISABLE,
          reason: '有意关：维护到今晚 22:00 再开',
          at: disableAt,
        },
        now: afterGrace,
        releaseInFlight: false,
      }),
    ).toBe(false);
  });

  it('.train 空 + 监督时刻：不算发版现场在走；宽限外应红', () => {
    expect(
      releaseSiteInFlight({
        pauseActive: false,
        pauseMtimeMs: null,
        trainRunning: false,
        trainBeatMs: null,
        now: superviseAt,
      }),
    ).toBe(false);
    expect(
      engineMasterOffWithinReleaseGrace({
        pauseActive: false,
        pauseMtimeMs: null,
        trainRunning: false,
        trainBeatMs: null,
        lastReleaseAt: new Date('2026-10-10T04:29:56.000Z'), // 上一趟 12:29 CST
        now: superviseAt,
      }),
    ).toBe(false);
  });
});
