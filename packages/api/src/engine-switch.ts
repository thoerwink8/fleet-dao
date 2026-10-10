// 引擎总开关（#1086）在后端这一头的读写：设置表 'engine.master'（形状和读法在 @fleet-dao/shared 的 engine-switch.ts）。
// 读：listSettings 里找那一行，没设过、认不出都按关（shared 的 engineMasterOf）。
// 写：putSetting（同一事务记操作记录、带版本防两人同时改）。已经是要的状态就不改、不记（和 setAutoDispatch 同一个约定：
// 开着再开不改不记）。写之前现读版本，冲突回 conflict 让调用方重试或报给人。
// 三个调用方：环境快照（readEnvSnapshot 里「引擎总开关」那一格）、命令行 fleet-api engine on|off|status、
// 发版脚本（release.sh 每次发版成功后经 fleet-api engine off 置关）。驾驶舱的按钮走通用的 PUT /settings/engine.master，
// 不经这里（登录门、CSRF、版本冲突回 409 都在那条路上）。

import {
  describeEngineMaster,
  ENGINE_MASTER_DISABLE,
  ENGINE_MASTER_ENABLE,
  ENGINE_MASTER_SETTING,
  type EngineMasterState,
  engineMasterOf,
  orphanReleasePause,
} from '@fleet-dao/shared';
import type { Actor, AuditRecord, NewAuditEntry, Store } from './ports.ts';

/** 读总开关此刻的状态；设置表读不到照抛（调用方自己包一层「没查成」）。 */
export async function readEngineMaster(store: Store): Promise<EngineMasterState> {
  const rows = await store.listSettings();
  return engineMasterOf(rows.find((s) => s.key === ENGINE_MASTER_SETTING));
}

const MASTER_AUDIT_TARGET = `setting:${ENGINE_MASTER_SETTING}`;

/** 最近与总开关有关的操作记录（新的在前）；库读不到照抛。 */
export async function listEngineMasterAudits(
  store: Store,
  limit = 50,
): Promise<{ items: AuditRecord[]; more: boolean }> {
  const page = await store.listAudit({ target: MASTER_AUDIT_TARGET, limit });
  return { items: page.items, more: page.nextCursor !== undefined };
}

/** 总开关关着且最近一次关是「发版前暂停」、还没开回（#1739）。 */
export async function isOrphanReleasePause(store: Store): Promise<boolean> {
  const { items } = await listEngineMasterAudits(store);
  return orphanReleasePause(items);
}

export type EngineMasterChange =
  | { changed: true; state: EngineMasterState }
  /** 本来就是要的状态：什么都没改、也没记操作记录。 */
  | { changed: false; state: EngineMasterState }
  /** 写的时候版本对不上（刚被别人改过）：什么都没改。 */
  | { changed: false; conflict: true; state: EngineMasterState };

/**
 * 开或关总开关。actor 是「谁改的」（写进 settings.updatedBy 和操作记录）；audit 的 action 由这里按方向填
 * （ENGINE_MASTER_ENABLE/DISABLE），before/after 也由这里按读到的填。已经是要的状态不改不记。
 */
export async function setEngineMaster(
  store: Store,
  input: { on: boolean; by: Actor },
  audit: Omit<NewAuditEntry, 'action' | 'target' | 'before' | 'after'>,
): Promise<EngineMasterChange> {
  const rows = await store.listSettings();
  const row = rows.find((s) => s.key === ENGINE_MASTER_SETTING);
  const before = engineMasterOf(row);
  if (before.on === input.on) return { changed: false, state: before };
  const result = await store.putSetting(
    {
      key: ENGINE_MASTER_SETTING,
      value: input.on,
      expectedVersion: row?.version ?? 0,
      by: input.by,
    },
    {
      ...audit,
      actor: input.by,
      action: input.on ? ENGINE_MASTER_ENABLE : ENGINE_MASTER_DISABLE,
      target: `setting:${ENGINE_MASTER_SETTING}`,
      before: row?.value ?? null,
      after: input.on,
    },
  );
  const after = await readEngineMaster(store);
  if (result === 'conflict') return { changed: false, conflict: true, state: after };
  return { changed: true, state: after };
}

/**
 * 发版暂停后未恢复：开回总开关（#1739）。不是断链就不动。
 * actor/reason 由调用方填（命令行 ops:engine、巡检跳过时的引擎机器人）。
 */
export async function healOrphanReleasePause(
  store: Store,
  input: { by: Actor; reason: string; via: NewAuditEntry['via'] },
): Promise<
  | { healed: true; state: EngineMasterState }
  | { healed: false; why: 'not_orphan' | 'already_on' | 'conflict'; state: EngineMasterState }
> {
  const state = await readEngineMaster(store);
  if (state.on) return { healed: false, why: 'already_on', state };
  if (!(await isOrphanReleasePause(store))) return { healed: false, why: 'not_orphan', state };
  const change = await setEngineMaster(
    store,
    { on: true, by: input.by },
    { actor: input.by, reason: input.reason, via: input.via, ok: true },
  );
  if ('conflict' in change) return { healed: false, why: 'conflict', state: change.state };
  if (!change.changed) return { healed: false, why: 'already_on', state: change.state };
  return { healed: true, state: change.state };
}

export { describeEngineMaster };
