// #1795：法国 healthz 再次出现「最近一轮（10-10 20:46 有结论）断在「收单」」——用钟点格子和收单期限钉死根因，
// 不许只靠口头推断。写方＝canary 定时任务写 canary_runs；读方＝healthz canaryHealth；同一 endedAt 钉死＝旧结论未刷新。

import { describe, expect, it } from 'vitest';
import { CANARY_EVERY_HOURS, CANARY_OFFSET_MINUTES, CANARY_STAGE_LIMIT_MINUTES } from '../src/jobs/canary.ts';
import { latestSlot } from '../src/jobs/timers.ts';

const CST_MS = 8 * 60 * 60_000;

/** 北京时间墙钟 → UTC Date。 */
function cst(isoLocal: string): Date {
  return new Date(`${isoLocal}+08:00`);
}

function stampCst(at: Date): string {
  const s = new Date(at.getTime() + CST_MS).toISOString();
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`;
}

describe('#1795 断在收单：20:46 旧结论未刷新', () => {
  const job = { everyMinutes: CANARY_EVERY_HOURS * 60, offsetMinutes: CANARY_OFFSET_MINUTES };

  it('巡检钟点是北京时间 2/8/14/20 点 26 分；20:46＝20:26 开轮后收单期限 20 分钟到期', () => {
    const opened = cst('2026-10-10T20:26:00');
    expect(latestSlot(job, opened.getTime())).toBe(opened.getTime());
    expect(CANARY_STAGE_LIMIT_MINUTES.intake).toBe(20);
    const brokenAt = new Date(opened.getTime() + CANARY_STAGE_LIMIT_MINUTES.intake * 60_000);
    expect(stampCst(brokenAt)).toBe('10-10 20:46');
  });

  it('监督时刻 01:48 还在下一槽 02:26 之前：库里最新有结论仍是 20:46 时，属旧结论未刷新，不是新一轮又失败', () => {
    const brokenAt = cst('2026-10-10T20:46:00');
    const supervision = cst('2026-10-11T01:48:00');
    const nextSlot = latestSlot(job, supervision.getTime()) + CANARY_EVERY_HOURS * 60 * 60_000;
    // 01:48 的「最近一格」是 20:26；下一格是 +6h＝02:26
    expect(stampCst(new Date(latestSlot(job, supervision.getTime())))).toBe('10-10 20:26');
    expect(stampCst(new Date(nextSlot))).toBe('10-11 02:26');
    expect(supervision.getTime()).toBeLessThan(nextSlot);
    // #1779 合入 23:52，晚于 20:46 断结论——不是修后又用同一时刻重写一条
    const fix1779 = cst('2026-10-10T23:52:42');
    expect(fix1779.getTime()).toBeGreaterThan(brokenAt.getTime());
  });
});
