// 引擎总开关（#1086，设置 engine.master）在页面上的三处：顶栏常驻的「引擎 开着/关着」、环境页里能点的开关卡、
// 设置页「仓库」一节旁边的一句关系说明。总开关关＝全停（不拉单、不派活、不起干活的会话；探针和健康检查照跑）；
// 总开关开＝只有「让 AI 接活」开着的项目才派。
// 改这里之前必须知道：
// - 本台的状态读设置（/api/settings 里 engine.master 那一行，用 shared 的 engineMasterOf 判，和后端同一个口径）：顶栏每一页都常驻，
//   不能拉整份 /api/env（每次要跑全套健康检查，07b-env.e2e 钉着「别的页不拉它」）；设置有实时推送，一变就跟着变。选了远程环境读那个
//   环境推来的快照里的 facts.master。写走通用的 PUT /settings/engine.master（登录门、CSRF、版本冲突回 409、操作记录都在那条路上），
//   不另开接口。
// - 选了远程环境（本机 WSL）时只显示它的状态、不能点：后端的写口只管本台的库，写明去那台上用 fleet-api engine on|off。
// - 演示版没有环境页、也没有这个开关：isDemo() 时整块不渲染。
// - 读不到（环境页读失败、远程快照没有这一格）就如实写「没查成」「这个环境的版本还不带总开关」，不画成开、也不画成关。

import { describeEngineMaster, ENGINE_MASTER_SETTING, engineMasterOf } from '@fleet-dao/shared';
import { Power } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { errorText, useNodeSnapshots, useSettings, useUpdateSetting } from '../api/client';
import type { EnvMaster, Setting } from '../api/types';
import { isDemo } from '../demo/access';
import { formatDateTime } from '../lib/format';
import { useNodeSelection, withNode } from '../lib/node';
import { cn } from '../lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Button } from './ui/button';
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

/** 谁、什么时候改的（没设过、认不出就没有这一句）。 */
function changedBy(m: EnvMaster): string | null {
  if (m.by === undefined || m.at === undefined) return null;
  return `${formatDateTime(m.at)} 由 ${m.by.replace(/^user:/, '')} ${m.on ? '打开' : '关上'}`;
}

/**
 * 顶栏常驻的小胶囊：引擎开着还是关着，一眼看得见。点它去环境页（那里能点开关）。关着用等待色（不是红：关着是常态、
 * 不是坏了），开着用完成色；读不到用虚线框写「没查成」。演示版不显示。
 */
export function EngineMasterBadge() {
  const { view, remote, nodeId } = useMasterView();
  if (isDemo()) return null;
  const label =
    view.kind === 'ok'
      ? view.master.on
        ? '引擎 开着'
        : '引擎 关着'
      : view.kind === 'loading'
        ? '引擎 …'
        : view.kind === 'absent'
          ? '引擎 无总开关'
          : '引擎 没查成';
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={withNode('/env', nodeId)}
          data-engine-master={view.kind === 'ok' ? (view.master.on ? 'on' : 'off') : view.kind}
          aria-label={`${label}${remote ? '（远程环境，只读）' : ''}，去环境页`}
          className={cn(
            'hidden h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs whitespace-nowrap transition-colors hover:bg-accent sm:flex',
            on && 'border-st-done/40 text-ink-done',
            off && 'border-st-stall/50 text-ink-stall',
            !on && !off && 'border-dashed text-muted-foreground',
          )}
        >
          <Power className="size-3.5" aria-hidden />
          <span>{label}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        {detail}
        {remote ? '（远程环境只读：要开关请去那台上用 fleet-api engine on|off）' : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 环境页里的总开关卡：状态、谁什么时候改的、开/关按钮（点了先二次确认）。写走通用设置写入口，带上改之前看到的版本，
 * 别人先改了回 409、提示刷新。选了远程环境、演示版、读不到：不给按钮，各写各的原因。
 */
export function EngineMasterControl() {
  const { view, remote } = useMasterView();
  const settings = useSettings();
  const update = useUpdateSetting();
  const [asking, setAsking] = useState(false);
  if (isDemo()) return null;

  const row = settings.data?.settings.find((s) => s.key === ENGINE_MASTER_SETTING);
  const master = view.kind === 'ok' ? view.master : null;
  const target = master === null ? null : !master.on;
  const verb = target ? '开启' : '关闭';
  const confirm = () => {
    if (target === null) return;
    update.mutate(
      {
        key: ENGINE_MASTER_SETTING,
        body: {
          value: target,
          version: row?.version ?? 0,
          reason: `驾驶舱环境页上点了${verb}引擎总开关`,
        },
      },
      {
        onSuccess: () => {
          setAsking(false);
          toast.success(`已${verb}引擎总开关`);
        },
        onError: (e) => {
          setAsking(false);
          toast.error(`没能${verb}`, { description: errorText(e) });
        },
      },
    );
  };

  const note =
    view.kind === 'loading'
      ? '正在读…'
      : view.kind === 'error'
        ? `没查成：${view.reason}`
        : view.kind === 'absent'
          ? '这个环境的版本还不带引擎总开关（它升级后会有这一项）。'
          : (master?.detail ?? '');
  const who = master === null ? null : changedBy(master);

  return (
    <section
      data-testid="engine-master"
      data-engine-master={master === null ? view.kind : master.on ? 'on' : 'off'}
      className={cn('mb-4 rounded-2xl border p-4', master?.on === false && 'border-st-stall/40')}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <Power className="size-4 text-muted-foreground" aria-hidden />
            引擎总开关
            <span
              data-testid="engine-master-state"
              className={cn(
                'rounded-full border px-2 py-0.5 text-xs font-normal',
                master?.on === true && 'border-st-done/40 text-ink-done',
                master?.on === false && 'border-st-stall/50 text-ink-stall',
                master === null && 'border-dashed text-muted-foreground',
              )}
            >
              {master === null
                ? view.kind === 'loading'
                  ? '读取中'
                  : '没查成'
                : master.on
                  ? '开着'
                  : '关着'}
            </span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="engine-master-note">
            {note}
          </p>
          {who ? (
            <p className="num mt-1 text-xs text-muted-foreground" data-testid="engine-master-who">
              {who}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">
            总开关关＝全停：不拉单、不派活、不起干活的会话（探针和健康检查照跑，渠道通不通照样看得到）；总开关开＝只有「让
            AI 接活」开着的项目才派（在设置 → 仓库里逐个项目开）。每次往法国发版后会自己回到关。
          </p>
        </div>
        {master === null ? null : remote ? (
          <p className="max-w-64 text-xs text-muted-foreground" data-testid="engine-master-remote-note">
            这是远程环境的快照，只读。要开关请去那台上用 <span className="num">fleet-api engine on</span> /{' '}
            <span className="num">off</span>。
          </p>
        ) : (
          <>
            <Button
              variant={target ? 'default' : 'outline'}
              disabled={update.isPending || settings.isLoading}
              onClick={() => setAsking(true)}
              aria-label={`${verb}引擎总开关`}
            >
              {verb}
            </Button>
            <AlertDialog open={asking} onOpenChange={setAsking}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{verb}引擎总开关？</AlertDialogTitle>
                  <AlertDialogDescription>
                    {target
                      ? '开启后引擎开始运转：下一轮拉单就往「让 AI 接活」开着的项目派活、起 AI 会话（会花额度）。并记一条操作记录。'
                      : '关闭后引擎全停：不再拉单、不派活、不起新的干活会话；已经在跑的会话做完这一步就停，不会被腰斩；探针和健康检查照跑。并记一条操作记录。'}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>先不</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(e) => {
                      e.preventDefault();
                      confirm();
                    }}
                  >
                    {verb}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </div>
    </section>
  );
}

/** 设置 → 仓库一节开头的一句：总开关和每个项目的「让 AI 接活」是什么关系，并给出总开关现在的状态。 */
export function EngineMasterRelation() {
  const { view } = useMasterView();
  if (isDemo()) return null;
  const state =
    view.kind === 'ok'
      ? view.master.on
        ? '现在开着'
        : '现在关着：下面哪个项目开着也不会派'
      : view.kind === 'absent'
        ? '这个环境的版本还不带总开关'
        : view.kind === 'error'
          ? '总开关现在是开是关没查成'
          : '正在读总开关';
  return (
    <p className="mb-3 text-xs text-muted-foreground" data-testid="engine-master-relation">
      每个项目的「让 AI 接活」要和<strong className="font-medium text-foreground">引擎总开关</strong>
      一起看：总开关关＝全停，开＝只有这里接活开着的项目才派。总开关{state}（
      <Link to="/env" className="underline underline-offset-2 hover:text-foreground">
        去环境页开关
      </Link>
      ）。
    </p>
  );
}
