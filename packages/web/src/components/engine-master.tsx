// 引擎总开关（#1086，设置 engine.master）在页面上的两处读法：顶栏的引擎状态（shell/engine-status.tsx）、设置页「仓库」一节旁边的一句关系说明，
// 和它们共用的读法 useMasterView（法国页里能点的开关在 engine-card.tsx）。总开关关＝全停（不拉单、不派活、不起干活的
// 会话；探针和健康检查照跑）；总开关开＝只有「让 AI 接活」开着的项目才派。
// 改这里之前必须知道：
// - 本台的状态读设置（/api/settings 里 engine.master 那一行，用 shared 的 engineMasterOf 判，和后端同一个口径）：顶栏每一页都常驻，
//   不能拉整份 /api/env（每次要跑全套健康检查，07b-env.e2e 钉着「别的页不拉它」）；设置有实时推送，一变就跟着变。选了远程环境读那个
//   环境推来的快照里的 facts.master。写走通用的 PUT /settings/engine.master（登录门、CSRF、版本冲突回 409、操作记录都在那条路上），
//   不另开接口。
// - 选了远程环境（本机 WSL）时只显示它的状态、不能点：后端的写口只管本台的库（法国页的卡里写明去那台上用命令行）。
// - 读不到（设置读失败、远程快照没有这一格）就如实写「没读到」「这个环境的版本还不带总开关」，不画成开、也不画成关。

import { describeEngineMaster, ENGINE_MASTER_SETTING, engineMasterOf } from '@fleet-dao/shared';
import { errorText, useNodeSnapshots, useSettings } from '../api/client';
import type { EnvMaster, Setting } from '../api/types';
import { useNodeSelection } from '../lib/node';

/** 现在这个页面看的那个环境的总开关：本台读设置，远程环境读它推来的快照。 */
export type MasterView =
  | { kind: 'loading' }
  | { kind: 'error'; reason: string }
  /** 那个环境的版本还不带总开关（旧快照没有这一格）。 */
  | { kind: 'absent' }
  | { kind: 'ok'; master: EnvMaster };

/** 设置里 engine.master 那一行 → 页面要的形状（和后端的 masterFact 同一个翻法：同一份 engineMasterOf、describeEngineMaster）。 */
function masterOfSetting(row: Setting | undefined): EnvMaster {
  const state = engineMasterOf(
    row === undefined || row.version === 0
      ? null
      : { value: row.value, updatedAt: row.updatedAt, updatedBy: row.updatedBy },
  );
  return {
    on: state.on,
    why: state.on ? 'set' : state.why,
    ...(state.by === undefined ? {} : { by: state.by }),
    ...(state.at === undefined ? {} : { at: state.at }),
    detail: describeEngineMaster(state),
  };
}

export function useMasterView(): { view: MasterView; remote: boolean; nodeId: string | null } {
  const { nodeId } = useNodeSelection();
  const settings = useSettings();
  const [snap] = useNodeSnapshots(nodeId === null ? [] : [nodeId]);
  if (nodeId === null) {
    if (settings.error)
      return { view: { kind: 'error', reason: errorText(settings.error) }, remote: false, nodeId };
    if (!settings.data) return { view: { kind: 'loading' }, remote: false, nodeId };
    const row = settings.data.settings.find((s) => s.key === ENGINE_MASTER_SETTING);
    return { view: { kind: 'ok', master: masterOfSetting(row) }, remote: false, nodeId };
  }
  if (!snap || snap.isLoading) return { view: { kind: 'loading' }, remote: true, nodeId };
  if (snap.error) return { view: { kind: 'error', reason: errorText(snap.error) }, remote: true, nodeId };
  const fact = snap.data?.env.facts.master;
  if (!fact) return { view: { kind: 'absent' }, remote: true, nodeId };
  return {
    view: fact.ok ? { kind: 'ok', master: fact.value } : { kind: 'error', reason: fact.reason },
    remote: true,
    nodeId,
  };
}
