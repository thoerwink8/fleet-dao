// 发版把总开关关了、恢复没粘住时，看门狗每轮顺手开回（#1732）。
// 只认操作记录里最近一笔是「发版前暂停」且过了宽限；有意关、发版还在走的不动。
// 判法在 shared 的 isReleaseStuckMasterOff；写入前在同一事务里再核一次审计和版本，避免覆盖人工停派。

import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  type EngineMasterAuditRow,
  engineMasterOf,
  isReleaseStuckMasterOff,
  type MasterSettingRow,
  releaseSiteInFlight,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';

export const ENGINE_MASTER_RESTORE_ACTOR = 'engine:master-restore';

/** 法国发布目录上的发版现场（和 api 的 engine-master-health、release-request 同一处）。 */
export const FRANCE_TRAIN_DIR = '/srv/fleet-dao-releases/.train';

export interface EngineMasterRestoreDeps {
  readMasterRow(): Promise<MasterSettingRow | null>;
  latestAudit(): Promise<EngineMasterAuditRow | null>;
  /**
   * 开回总开关。调用方（db）须在同一事务里：锁设置行、再读最近一笔审计、仍判卡住才写，并用 version 条件更新。
   * expectDisableAt：判断时看到的那笔发版前暂停的时刻；对不上（人又关了一次）回 skipped。
   */
  enable(input: {
    by: string;
    reason: string;
    at: Date;
    expectDisableAt: Date;
  }): Promise<'enabled' | 'already_on' | 'conflict' | 'skipped'>;
  /** 发版暂停标记在、或发版车 status=running，且还在宽限内。 */
  releaseInFlight(): boolean;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 读法国 .train：新鲜的暂停标记或 running 进度 → 发版还在走；过期现场不算在走。 */
export function franceReleaseInFlight(
  trainDir: string = FRANCE_TRAIN_DIR,
  io: {
    existsSync?: (path: string) => boolean;
    readFileSync?: (path: string, enc: 'utf8') => string;
    mtimeMs?: (path: string) => number | null;
    now?: () => Date;
  } = {},
): boolean {
  const exists = io.existsSync ?? existsSync;
  const read = io.readFileSync ?? readFileSync;
  const mtime =
    io.mtimeMs ??
    ((path: string) => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return null;
      }
    });
  const now = io.now?.() ?? new Date();
  const paused = `${trainDir}/release-train.paused`;
  const pauseActive = exists(paused);
  const pauseMtimeMs = pauseActive ? mtime(paused) : null;
  let trainRunning = false;
  let trainBeatMs: number | null = null;
  const jsonPath = `${trainDir}/release-train.json`;
  if (exists(jsonPath)) {
    try {
      const s = JSON.parse(read(jsonPath, 'utf8')) as {
        status?: unknown;
        updatedAt?: unknown;
        driver?: { heartbeatAt?: unknown };
      };
      trainRunning = s.status === 'running';
      const text =
        (typeof s.driver?.heartbeatAt === 'string' && s.driver.heartbeatAt) ||
        (typeof s.updatedAt === 'string' && s.updatedAt) ||
        '';
      const at = Date.parse(text);
      trainBeatMs = Number.isFinite(at) ? at : mtime(jsonPath);
    } catch {
      trainRunning = false;
    }
  }
  return releaseSiteInFlight({
    pauseActive,
    pauseMtimeMs,
    trainRunning,
    trainBeatMs,
    now,
  });
}

/**
 * 若判为发版卡住：开回总开关。抛错由调用方（看门狗）记日志，不拖死看门狗本职。
 * 回 enabled / already_on / skipped / conflict。
 */
export async function maybeRestoreStuckEngineMaster(
  deps: EngineMasterRestoreDeps,
): Promise<'enabled' | 'already_on' | 'skipped' | 'conflict'> {
  const master = engineMasterOf(await deps.readMasterRow());
  const latest = await deps.latestAudit();
  const inFlight = deps.releaseInFlight();
  const stuck = isReleaseStuckMasterOff({
    masterOn: master.on,
    latest,
    now: deps.now(),
    releaseInFlight: inFlight,
  });
  if (!stuck || !latest) return 'skipped';
  const at = deps.now();
  const result = await deps.enable({
    by: ENGINE_MASTER_RESTORE_ACTOR,
    reason: '发版后总开关一直关着：最近一笔是发版前暂停且过了宽限、发版车不在走，看门狗自动开回（#1732）',
    at,
    expectDisableAt: latest.at,
  });
  if (result === 'enabled') {
    deps.log('warn', '看门狗：发版卡住的总开关已自动开回', {
      lastDisableAt: latest.at.toISOString(),
      reason: latest.reason,
    });
  } else if (result === 'conflict') {
    deps.log('warn', '看门狗：自动开回总开关时版本冲突，下一轮再试', {});
  } else if (result === 'skipped') {
    deps.log('info', '看门狗：开回前再核操作记录，已不是发版卡住（可能有人又关了），不动', {});
  }
  return result;
}

/** 包一层：失败只记日志，不抛（看门狗本职照跑）。 */
export async function tryRestoreStuckEngineMaster(deps: EngineMasterRestoreDeps): Promise<void> {
  try {
    await maybeRestoreStuckEngineMaster(deps);
  } catch (err) {
    deps.log('error', '看门狗：自动开回总开关没做成', { error: errMessage(err) });
  }
}
