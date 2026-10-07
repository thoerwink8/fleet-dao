// 环境页里的引擎总开关卡（#1086，设置 engine.master）：状态、谁什么时候改的、开/关按钮（点了先二次确认）。
// 为什么和顶栏胶囊（engine-master.tsx）分成两个文件：这张卡的文案里有命令名、「驾驶舱」这类演示版产物里不许出现的词
// （演示版扫描 src/build/scan.ts 按子串扫整个包），而环境页不进演示版的路由表（routes.ts 的 cockpitOnly），只有环境页引用这个文件，
// 它就不会被打进演示版的包。顶栏、设置页在演示版里都在，它们用的 engine-master.tsx 里不许放这些词。
// 写走通用的 PUT /settings/engine.master（登录门、CSRF、版本冲突回 409、操作记录都在那条路上），带上改之前看到的版本，别人先改了回
// 409、提示刷新；选了远程环境、读不到：不给按钮，各写各的原因（本机 WSL 的开关只管那台自己的库，要去那台上用命令行）。

import { ENGINE_MASTER_SETTING } from '@fleet-dao/shared';
import { Power } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useSettings, useUpdateSetting } from '../api/client';
import type { EnvMaster } from '../api/types';
import { formatDateTime } from '../lib/format';
import { cn } from '../lib/utils';
import { useMasterView } from './engine-master';
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

/** 谁、什么时候改的（没设过、认不出就没有这一句）。 */
function changedBy(m: EnvMaster): string | null {
  if (m.by === undefined || m.at === undefined) return null;
  return `${formatDateTime(m.at)} 由 ${m.by.replace(/^user:/, '')} ${m.on ? '打开' : '关上'}`;
}

export function EngineMasterControl() {
  const { view, remote } = useMasterView();
  const settings = useSettings();
  const update = useUpdateSetting();
  const [asking, setAsking] = useState(false);

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
      className={cn('mb-4 rounded-xl border bg-card p-4', master?.on === false && 'border-st-stall/40')}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
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
              className="shrink-0 self-start"
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
