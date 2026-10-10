// /healthz 的 engine_master 项（#1732）：总开关关着且不在发版宽限里 → 红，整体不再全绿。
// canary 在总开关关着时仍报「跳过」不红（#1141，故意不跑不算巡检断了）；这一项单独标出「派单链停着」。
// 发版暂停中 / 刚发完还在宽限：报跳过不红，避免发版中途被自己的健康检查绊住。

import { existsSync, readFileSync } from 'node:fs';
import { type EngineMasterState, engineMasterOffWithinReleaseGrace } from '@fleet-dao/shared';
import { PublicHealthError } from './health.ts';

/** 不在正式环境：这一项报「未接」。 */
export const ENGINE_MASTER_NOT_HERE = '只在正式环境查';

/** 法国发布目录（和 france-release / release-request 同一处）。 */
export const FRANCE_RELEASES_DIR = '/srv/fleet-dao-releases';

export type EngineMasterHealth = { ok: true; note: string } | { ok: false; code: string; message: string };

/** 发布历史末行「… <sha> release」的时刻；没有或认不出是 null。 */
export function parseLastReleaseAt(historyText: string): Date | null {
  const lines = historyText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const m = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s+[0-9a-f]{40}\s+release\b/.exec(line);
    if (!m?.[1]) continue;
    const at = Date.parse(m[1]);
    if (Number.isFinite(at)) return new Date(at);
  }
  return null;
}

/** 发版车进度是不是还在跑（status === running）。认不出当不在跑。 */
export function trainIsRunning(stateJson: string | null): boolean {
  if (!stateJson) return false;
  try {
    const s = JSON.parse(stateJson) as { status?: unknown };
    return s.status === 'running';
  } catch {
    return false;
  }
}

/**
 * 纯判断：开着 → 好；关着且在发版宽限 → 跳过不红；关着且宽限外 → 红。
 */
export function engineMasterHealth(
  master: EngineMasterState,
  ctx: {
    pauseActive: boolean;
    trainRunning: boolean;
    lastReleaseAt: Date | null;
    now: Date;
  },
): EngineMasterHealth {
  if (master.on) return { ok: true, note: '开着：引擎在接活' };
  if (
    engineMasterOffWithinReleaseGrace({
      pauseActive: ctx.pauseActive,
      trainRunning: ctx.trainRunning,
      lastReleaseAt: ctx.lastReleaseAt,
      now: ctx.now,
    })
  ) {
    return {
      ok: true,
      note: '跳过：总开关关着，发版暂停或刚发完还在宽限里，派单暂停',
    };
  }
  return {
    ok: false,
    code: 'engine_master_off',
    message: '引擎总开关关着：派单和巡检停着（不在发版宽限里）',
  };
}

export type EngineMasterHealthFs = {
  releasesDir?: string;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, enc: 'utf8') => string;
};

/**
 * 健康检查：现读总开关，再看法国发布目录上的暂停标记、发版车进度、发布历史。
 * 读总开关抛错 → 报没查成；目录读不到按「没有标记 / 没有历史」算，不装作在发版。
 */
export function engineMasterHealthCheck(
  readMaster: () => Promise<EngineMasterState>,
  now: () => Date = () => new Date(),
  fs: EngineMasterHealthFs = {},
): () => Promise<string> {
  const root = fs.releasesDir ?? FRANCE_RELEASES_DIR;
  const exists = fs.existsSync ?? existsSync;
  const read = fs.readFileSync ?? readFileSync;
  return async () => {
    const master = await readMaster();
    let pauseActive = false;
    let trainRunning = false;
    let lastReleaseAt: Date | null = null;
    try {
      pauseActive = exists(`${root}/.train/release-train.paused`);
      if (exists(`${root}/.train/release-train.json`)) {
        trainRunning = trainIsRunning(read(`${root}/.train/release-train.json`, 'utf8'));
      }
      if (exists(`${root}/.history`)) {
        lastReleaseAt = parseLastReleaseAt(read(`${root}/.history`, 'utf8'));
      }
    } catch {
      // 目录读不了：按没有发版现场算，关着就红（宁可不漏报）
    }
    const got = engineMasterHealth(master, {
      pauseActive,
      trainRunning,
      lastReleaseAt,
      now: now(),
    });
    if (!got.ok) throw new PublicHealthError(got.code, got.message);
    return got.note;
  };
}
