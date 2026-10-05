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
