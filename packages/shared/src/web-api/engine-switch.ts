// 引擎总开关（#1086）：设置表里的 'engine.master'（SETTING_SCHEMAS 里有它的形状）。
// 这里放三处共用的读法：引擎起会话前的闸（packages/engine）、环境快照里「引擎总开关」那一格（packages/api）、
// 命令行 fleet-api engine on|off|status。写入口只有两处：驾驶舱走 PUT /settings/engine.master（登录门、操作记录都在
// 通用设置那条路上），命令行和发版脚本走 Store.putSetting 同一个写入口。
// 没设过、认不出（值不是 true/false）都按关算：默认关是创始人拍的（每次更上去先是关着），认不出时宁可不接活也不乱派。

/** 设置表里总开关那一项的键（和 SETTING_SCHEMAS 里同名）。 */
export const ENGINE_MASTER_SETTING = 'engine.master';

/** 操作记录里开、关这两件事的名字；target 是 setting:engine.master。驾驶舱按钮和命令行记同一对。 */
export const ENGINE_MASTER_ENABLE = 'engine.master.enable';
export const ENGINE_MASTER_DISABLE = 'engine.master.disable';

/** 总开关此刻的状态。on=false 就是关着（不管 reason）；by/at 是没设过、认不出时为 undefined。 */
export type EngineMasterState =
  | { on: true; by?: string | undefined; at?: string | undefined }
  | { on: false; by?: string | undefined; at?: string | undefined; why: 'set' | 'never_set' | 'unreadable' };

/** 设置表一行的最小形状（store 的 SettingRecord 满足它；这里不强绑 store 类型，引擎那边不引 store）。 */
export interface MasterSettingRow {
  value: unknown;
  /** ISO 字符串（SettingRecord 就是它）。 */
  updatedAt?: string | undefined;
  updatedBy?: string | null | undefined;
}

/**
 * 从设置表一行读出总开关状态。没这一行 = 从没设过 = 关（why: never_set）；值不是 true/false = 认不出 = 关
 * （why: unreadable，写明为什么不拿它当开）。值是 false = 人关的（why: set，带谁、什么时候）。
 */
export function engineMasterOf(row: MasterSettingRow | null | undefined): EngineMasterState {
  if (!row) return { on: false, why: 'never_set' };
  const at =
    typeof row.updatedAt === 'string' && row.updatedAt !== '' && !Number.isNaN(Date.parse(row.updatedAt))
      ? row.updatedAt
      : undefined;
  const by = typeof row.updatedBy === 'string' && row.updatedBy !== '' ? row.updatedBy : undefined;
  if (row.value === true) return { on: true, ...(by ? { by } : {}), ...(at ? { at } : {}) };
  if (row.value === false) return { on: false, why: 'set', ...(by ? { by } : {}), ...(at ? { at } : {}) };
  return { on: false, why: 'unreadable' };
}

/** 给人看的一句：现在是开是关、谁什么时候改的（关着且从没设过就写「默认关」）。 */
export function describeEngineMaster(state: EngineMasterState): string {
  if (state.on) {
    const who = state.by !== undefined && state.at !== undefined ? `（${state.at} 由 ${state.by} 打开）` : '';
    return `开着${who}：引擎在接活（只有「让 AI 接活」开着的项目才派）`;
  }
  if (state.why === 'never_set')
    return '关着（从没设过，默认关）：不拉单、不派活、不起干活的会话；探针和健康检查照跑';
  if (state.why === 'unreadable')
    return '关着（设置认不出，按关算）：不拉单、不派活、不起干活的会话；探针和健康检查照跑';
  const who = state.by !== undefined && state.at !== undefined ? `，${state.at} 由 ${state.by} 关上` : '';
  return `关着${who}：不拉单、不派活、不起干活的会话；探针和健康检查照跑`;
}

/**
 * 发版车 / 驾驶舱接活在第 2 步关总开关时写进操作记录的原因前缀（#1256 / #1739）。
 * 后头会带目标提交；这里只认前缀，别拿别的「关」当成发版暂停。
 */
export const ENGINE_PAUSE_REASON_PREFIX = '发版前暂停';

/** 第 7 步开回时写进操作记录的原因前缀。有这一条就说明暂停已收尾，不算断链。 */
export const ENGINE_RESTORE_REASON_PREFIX = '发版后恢复发版前的状态';

/** 判「发版暂停后未恢复」时只用开关这一对操作记录（别的 setting 改动不算）。 */
export type EngineMasterAuditSlice = {
  action: string;
  /** ISO 或能 Date.parse 的时间；缺了或认不出的条目跳过。 */
  at?: string | undefined;
  reason?: string | null | undefined;
};

/**
 * 最近一条总开关操作记录是不是「发版前暂停」关着、还没有后来的打开（#1739）。
 * 真：发版车/驾驶舱接活关了总开关，驱动中途死掉或发完误记「本来就关着」，没人开回——应开回，不该当成有意关着。
 * 条目按 at 从新到旧；同秒多条时保持传入顺序（新的在前）。没有开关记录、最近一条是打开、或关的原因不是发版暂停 → 假。
 * 原因必须以 `ENGINE_PAUSE_REASON_PREFIX` 开头（发版脚本写的原文如此）；用 includes 会把「排查发版前暂停问题…」这类有意关也当成断链。
 */
export function orphanReleasePause(audits: readonly EngineMasterAuditSlice[]): boolean {
  const switches = audits.filter(
    (a) => a.action === ENGINE_MASTER_ENABLE || a.action === ENGINE_MASTER_DISABLE,
  );
  if (switches.length === 0) return false;
  const sorted = [...switches].sort((a, b) => {
    const ta = a.at !== undefined && a.at !== '' ? Date.parse(a.at) : Number.NaN;
    const tb = b.at !== undefined && b.at !== '' ? Date.parse(b.at) : Number.NaN;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });
  const last = sorted[0];
  if (last === undefined || last.action !== ENGINE_MASTER_DISABLE) return false;
  const reason = typeof last.reason === 'string' ? last.reason : '';
  return reason.startsWith(ENGINE_PAUSE_REASON_PREFIX);
}

/**
 * 发版暂停标记还在、且驱动这一趟仍算「在走」时，巡检不得自动开回总开关（#1739）。
 * - 没有标记 → 不挡。
 * - 有标记但没有进度记录、或已是 blocked/failed/done/aborted → 不挡（驱动死掉或收尾失败留下的孤儿标记）。
 * - status=running 且记下了 pid、进程已死 → 不挡（与发版卡 staleDead 同判）。
 * - status=running 且 pid 还活着、或老记录没写 pid → 挡（不敢在真发版中途开回）。
 */
export function releasePauseStillActive(input: {
  markerPresent: boolean;
  /** 进度记录里的 status / pid；没有文件或认不出时传 null。 */
  train: { status: string; pid: number | null } | null;
  pidAlive: (pid: number) => boolean;
}): boolean {
  if (!input.markerPresent) return false;
  if (input.train === null) return false;
  const { status, pid } = input.train;
  if (status === 'blocked' || status === 'failed' || status === 'done' || status === 'aborted') return false;
  if (status !== 'running') return false;
  if (pid === null) return true;
  return input.pidAlive(pid);
}

/**
 * 法国 `.history` 末几行（`时间戳 sha 事件`）里，在 `sinceIso` 之后有没有成功发出去的版本（#1739 旁证）。
 * 用来核对「总开关又关着」是不是跟某次发版叠在一起：有 → 高度像发版暂停链；没有 → 更像中途死掉的暂停（还没跑到 release.sh）。
 */
export function releaseHistoryAfter(
  lines: readonly string[],
  sinceIso: string,
): { at: string; sha: string; event: string }[] {
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return [];
  const out: { at: string; sha: string; event: string }[] = [];
  for (const line of lines) {
    const m = /^(\S+)\s+([0-9a-f]{7,40})\s+(\S+)\s*$/.exec(line.trim());
    if (!m) continue;
    const at = m[1] ?? '';
    const t = Date.parse(at);
    if (Number.isNaN(t) || t <= since) continue;
    const event = m[3] ?? '';
    if (event !== 'release' && event !== 'recovered') continue;
    out.push({ at, sha: m[2] ?? '', event });
  }
  return out;
}
