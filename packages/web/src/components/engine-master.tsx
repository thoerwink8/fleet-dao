// 引擎总开关（#1086，设置 engine.master）在页面上的三处：顶栏常驻的「总开关 开着/关着」、设置页「仓库」一节旁边的一句关系说明，
// 和它们共用的读法 useMasterView（环境页里能点的开关卡在 engine-master-card.tsx）。总开关关＝全停（不拉单、不派活、不起干活的
// 会话；探针和健康检查照跑）；总开关开＝只有「让 AI 接活」开着的项目才派。
// 改这里之前必须知道：
// - 本台的状态读设置（/api/settings 里 engine.master 那一行，用 shared 的 engineMasterOf 判，和后端同一个口径）：顶栏每一页都常驻，
//   不能拉整份 /api/env（每次要跑全套健康检查，07b-env.e2e 钉着「别的页不拉它」）；设置有实时推送，一变就跟着变。选了远程环境读那个
//   环境推来的快照里的 facts.master。写走通用的 PUT /settings/engine.master（登录门、CSRF、版本冲突回 409、操作记录都在那条路上），
//   不另开接口。
// - 选了远程环境（本机 WSL）时只显示它的状态、不能点：后端的写口只管本台的库（卡里写明去那台上用命令行）。
// - 读不到（设置读失败、远程快照没有这一格）就如实写「没查成」「这个环境的版本还不带总开关」，不画成开、也不画成关。

import { describeEngineMaster, ENGINE_MASTER_SETTING, engineMasterOf } from '@fleet-dao/shared';
import { Power } from 'lucide-react';
import { Link } from 'react-router';
import { errorText, useNodeSnapshots, useSettings } from '../api/client';
import type { EnvMaster, Setting } from '../api/types';
import { useNodeSelection, withNode } from '../lib/node';
import { cn } from '../lib/utils';
import { usePhone } from '../lib/viewport';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

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

/**
 * 顶栏常驻的小胶囊：总开关开着还是关着，一眼看得见（这是人给的许可，不是引擎进程活没活）。点它去法国页（那里能点开关）。
 * 关着用等待色（不是红：关着是常态、不是坏了），开着用完成色；读不到用虚线框写「没查成」。
 * 悬停提示仍用 describeEngineMaster 那句（关着不派活、探针照跑），不跟着按钮改名。
 */
export function EngineMasterBadge() {
  const { view, remote, nodeId } = useMasterView();
  const phone = usePhone();
  const label =
    view.kind === 'ok'
      ? view.master.on
        ? '总开关 开着'
        : '总开关 关着'
      : view.kind === 'loading'
        ? '总开关 …'
        : view.kind === 'absent'
          ? '总开关 没有'
          : '总开关 没查成';
  const on = view.kind === 'ok' && view.master.on;
  const off = view.kind === 'ok' && !view.master.on;
  const detail =
    view.kind === 'ok'
      ? view.master.detail
      : view.kind === 'absent'
        ? '这个环境的版本还不带引擎总开关'
        : view.kind === 'error'
          ? `引擎总开关没读成：${view.reason}`
          : '正在读引擎总开关';
  const tone = cn(
    on && 'border-st-done/40 text-ink-done',
    off && 'border-st-stall/50 text-ink-stall',
    !on && !off && 'border-dashed text-muted-foreground',
  );
  const state = view.kind === 'ok' ? (view.master.on ? 'on' : 'off') : view.kind;
  if (phone) {
    // 手机顶栏放不下整颗胶囊：留一个 40×40 的状态点，点开是一张小卡（状态、说明、去法国页开关）
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-engine-master={state}
            aria-label={`${label}${remote ? '（远程环境，只读）' : ''}，点开看详情`}
            className={cn(
              'relative grid size-10 shrink-0 place-items-center rounded-lg border transition-colors hover:bg-accent',
              tone,
            )}
          >
            <Power className="size-4" aria-hidden />
            <span
              aria-hidden
              className={cn(
                'absolute top-1.5 right-1.5 size-2 rounded-full',
                on ? 'bg-st-done' : off ? 'bg-st-stall' : 'bg-muted-foreground/60',
              )}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72" data-engine-master-card>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Power className="size-4 text-muted-foreground" aria-hidden />
            {label}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {detail}
            {remote ? '（远程环境只读：要开关请到那台上操作，说明在法国页）' : null}
          </p>
          <Link
            to={withNode('/france', nodeId)}
            className="mt-3 flex h-10 items-center justify-center rounded-lg border text-sm hover:bg-accent"
          >
            去法国页看开关
          </Link>
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={withNode('/france', nodeId)}
          data-engine-master={state}
          aria-label={`${label}${remote ? '（远程环境，只读）' : ''}，去法国页`}
          className={cn(
            'hidden h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs whitespace-nowrap transition-colors hover:bg-accent sm:flex',
            tone,
          )}
        >
          <Power className="size-3.5" aria-hidden />
          <span>{label}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        {detail}
        {remote ? '（远程环境只读：要开关请到那台上操作，说明在法国页）' : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** 设置 → 仓库一节开头的一句：总开关和每个项目的「让 AI 接活」是什么关系，并给出总开关现在的状态。 */
export function EngineMasterRelation() {
  const { view } = useMasterView();
  const state =
    view.kind === 'ok'
      ? view.master.on
        ? '现在开着'
        : '现在关着：下面哪个项目开着也不会派'
      : view.kind === 'absent'
        ? '这个环境的版本还不带总开关'
        : view.kind === 'error'
          ? '现在是开是关没查成'
          : '正在读总开关';
  return (
    <p className="mb-3 text-xs text-muted-foreground" data-testid="engine-master-relation">
      每个项目的「让 AI 接活」要和<strong className="font-medium text-foreground">引擎总开关</strong>
      一起看：总开关关＝全停，开＝只有这里接活开着的项目才派。总开关{state}（
      <Link to="/france" className="underline underline-offset-2 hover:text-foreground">
        去法国页开关
      </Link>
      ）。
    </p>
  );
}
