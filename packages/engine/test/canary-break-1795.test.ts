// #1795：法国 healthz 再次出现「最近一轮（10-10 20:46 有结论）断在「收单」」。
// 证据来自法国机上的发版历史、巡检仓公开 API/巡检记录、以及 #1773 评论——不是写死钟点空想。
// 写方＝canary 定时任务写 canary_runs；读方＝healthz canaryHealth；存放处＝库里最近有结论的那一行。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CANARY_EVERY_HOURS, CANARY_OFFSET_MINUTES, CANARY_STAGE_LIMIT_MINUTES } from '../src/jobs/canary.ts';
import { latestSlot } from '../src/jobs/timers.ts';

const CST_MS = 8 * 60 * 60_000;
const here = dirname(fileURLToPath(import.meta.url));
const evidence = JSON.parse(readFileSync(join(here, 'fixtures/1795-canary-evidence.json'), 'utf8')) as {
  rootCause: {
    kind: string;
    round27: {
      issue83Created: string;
      intakeDeadline: string;
      issue84PrCreated: string;
      pr84Merged: string;
    };
    issue1773: {
      closedAt: string;
      comment2359MentionsMasterOffSkip: boolean;
      comment0049ClaimsFixed: boolean;
    };
  };
  round28Pass: {
    issue85Created: string;
    pr86Merged: string;
    issue85Closed: string;
    canaryLogLine: string;
    canaryLogUrl: string;
  };
  france: { deployHistory1779: string; deployHistoryCurrent: string; deployedSha: string };
  github?: Record<string, { state?: string; merged_at?: string | null; closed_at?: string | null }>;
  ssh: { liveMatchesRepoPub: boolean; loginUser: string; notRoot: boolean };
};

function cst(isoLocal: string): Date {
  return new Date(`${isoLocal}+08:00`);
}

function stampCst(at: Date): string {
  const s = new Date(at.getTime() + CST_MS).toISOString();
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`;
}

describe('#1795 断在收单：真实时间线（旧结论未刷新 + #1773 误关）', () => {
  const job = { everyMinutes: CANARY_EVERY_HOURS * 60, offsetMinutes: CANARY_OFFSET_MINUTES };

  it('证据钉死根因种类：旧结论未刷新 + 总开关跳过被当成修好，不是修后又用同一时刻重写一条', () => {
    expect(evidence.rootCause.kind).toBe('stale_conclusion_plus_false_close');
    expect(evidence.rootCause.issue1773.comment2359MentionsMasterOffSkip).toBe(true);
    expect(evidence.rootCause.issue1773.comment0049ClaimsFixed).toBe(true);
    expect(evidence.france.deployHistory1779).toContain('9c069129');
    expect(evidence.france.deployHistory1779).toContain('2026-10-10T15:56:59Z'); // 北京 23:56
    expect(evidence.france.deployedSha).toBe('40ff88c5b4f5f0d09c07765d91029334e5c3d4f6');
  });

  it('第 27 轮：#83 20:26 开单，收单期限 20 分钟 → 20:46；#84/PR 20:48 才起、20:50 才合——超时结论早于活干完', () => {
    const opened = cst('2026-10-10T20:26:00');
    expect(CANARY_STAGE_LIMIT_MINUTES.intake).toBe(20);
    const brokenAt = new Date(opened.getTime() + CANARY_STAGE_LIMIT_MINUTES.intake * 60_000);
    expect(stampCst(brokenAt)).toBe('10-10 20:46');
    expect(evidence.rootCause.round27.intakeDeadline).toContain('20:46');
    // PR 晚于收单期限：不是「20:46 那一刻又失败一遍」，而是超时先落库
    const prCreated = new Date(evidence.rootCause.round27.issue84PrCreated);
    expect(prCreated.getTime()).toBeGreaterThan(brokenAt.getTime());
    expect(evidence.github?.pr84?.merged_at).toBe('2026-10-10T12:50:32Z');
  });

  it('监督 01:48 仍在下一槽 02:26 之前；#1779 23:56 已发也换不掉库里 20:46 那条有结论', () => {
    const supervision = cst('2026-10-11T01:48:00');
    const slot = latestSlot(job, supervision.getTime());
    const nextSlot = slot + CANARY_EVERY_HOURS * 60 * 60_000;
    expect(stampCst(new Date(slot))).toBe('10-10 20:26');
    expect(stampCst(new Date(nextSlot))).toBe('10-11 02:26');
    expect(supervision.getTime()).toBeLessThan(nextSlot);
    const fixDeployed = Date.parse('2026-10-10T15:56:59Z');
    expect(fixDeployed).toBeGreaterThan(cst('2026-10-10T20:46:00').getTime());
    expect(fixDeployed).toBeLessThan(nextSlot);
  });

  it('第 28 轮（02:26 槽）公开证据：开单→合 PR→关单，巡检记录已追加第 28 轮', () => {
    expect(evidence.round28Pass.issue85Created).toBe('2026-10-10T18:26:02Z');
    expect(evidence.round28Pass.pr86Merged).toBe('2026-10-10T18:30:12Z');
    expect(evidence.round28Pass.issue85Closed).toBe('2026-10-10T18:30:18Z');
    expect(evidence.round28Pass.canaryLogLine).toBe('- 第 28 轮 2026-10-10T18:26:00Z');
    expect(evidence.github?.issue85?.state).toBe('closed');
    expect(evidence.github?.pr86?.merged_at).toBe('2026-10-10T18:30:12Z');
  });

  it('SSH：仓里 session-login.pub 与法国现网 authorized_keys 指纹一致；登录用户是会话用户不是 root', () => {
    expect(evidence.ssh.liveMatchesRepoPub).toBe(true);
    expect(evidence.ssh.loginUser).toBe('fleet-agent-carpool');
    expect(evidence.ssh.notRoot).toBe(true);
  });

  it('现网巡检记录仍含第 28 轮（公开 raw，证明不是只写在 fixture 里）', async () => {
    const res = await fetch(evidence.round28Pass.canaryLogUrl);
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).toContain(evidence.round28Pass.canaryLogLine);
  });
});
