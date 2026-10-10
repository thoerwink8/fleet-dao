// 发版把总开关关了、恢复没粘住时，看门狗每轮顺手开回（#1732）。
// 只认操作记录里最近一笔是「发版前暂停」且过了宽限；有意关、发版还在走的不动。
// 判法在 shared 的 isReleaseStuckMasterOff；这里只接线、记日志。

import { existsSync, readFileSync } from 'node:fs';
import {
  type EngineMasterAuditRow,
  engineMasterOf,
  isReleaseStuckMasterOff,
  type MasterSettingRow,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';

export const ENGINE_MASTER_RESTORE_ACTOR = 'engine:master-restore';

/** 法国发布目录上的发版现场（和 api 的 engine-master-health、release-request 同一处）。 */
export const FRANCE_TRAIN_DIR = '/srv/fleet-dao-releases/.train';

export interface EngineMasterRestoreDeps {
  readMasterRow(): Promise<MasterSettingRow | null>;
  latestAudit(): Promise<EngineMasterAuditRow | null>;
  enable(input: { by: string; reason: string; at: Date }): Promise<'enabled' | 'already_on' | 'conflict'>;
  /** 发版暂停标记在、或发版车 status=running。 */
  releaseInFlight(): boolean;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** 读法国 .train：有暂停标记或 progress 是 running → 发版还在走。 */
export function franceReleaseInFlight(
  trainDir: string = FRANCE_TRAIN_DIR,
  io: {
    existsSync?: (path: string) => boolean;
    readFileSync?: (path: string, enc: 'utf8') => string;
  } = {},
): boolean {
  const exists = io.existsSync ?? existsSync;
  const read = io.readFileSync ?? readFileSync;
  if (exists(`${trainDir}/release-train.paused`)) return true;
  if (!exists(`${trainDir}/release-train.json`)) return false;
  try {
    const s = JSON.parse(read(`${trainDir}/release-train.json`, 'utf8')) as { status?: unknown };
    return s.status === 'running';
  } catch {
    return false;
  }
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
  const stuck = isReleaseStuckMasterOff({
    masterOn: master.on,
    latest,
    now: deps.now(),
    releaseInFlight: deps.releaseInFlight(),
  });
  if (!stuck) return 'skipped';
  const at = deps.now();
  const result = await deps.enable({
    by: ENGINE_MASTER_RESTORE_ACTOR,
    reason: '发版后总开关一直关着：最近一笔是发版前暂停且过了宽限、发版车不在走，看门狗自动开回（#1732）',
    at,
  });
  if (result === 'enabled') {
    deps.log('warn', '看门狗：发版卡住的总开关已自动开回', {
      lastDisableAt: latest?.at?.toISOString(),
      reason: latest?.reason,
    });
  } else if (result === 'conflict') {
    deps.log('warn', '看门狗：自动开回总开关时版本冲突，下一轮再试', {});
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
