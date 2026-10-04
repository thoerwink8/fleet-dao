// 快捷操作只有这一份定义：悬停条、右键菜单、侧边详情、手机列表、任务详情都从这里取，行为一致。
// 能做的动作以 shared/web-api.ts 的 TaskActionRequest 为准：暂停、继续、叫停、换路由（可指定子任务），另有回答追问。
import type { LucideIcon } from 'lucide-react';
import { CircleStop, MessageCircleQuestion, Pause, Play, Shuffle } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  errorText,
  useAnswerAsk,
  usePools,
  useRoutingLayers,
  useTaskAction,
  useTaskDetail,
} from '../api/client';
import type {
  Activity,
  BoardSubtask,
  BoardTask,
  PoolView,
  RoutingLayerPurpose,
  RoutingLayerRoute,
  RoutingLayers,
  StageKind,
  TaskActionBody,
  TaskState,
} from '../api/types';
import {
  billingLabel,
  headlineInk,
  headlineText,
  type QuotaHeadline,
  routeQuotaHeadline,
  stageLabel,
} from '../lib/catalog';
import { clipText } from '../lib/format';
import { routeHost, routeTitle } from '../lib/routing';
import { isTaskFinished, letterOf } from '../lib/status';
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
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Textarea } from './ui/textarea';

/** 一个操作对着谁：需求，或需求下的某个子任务。 */
export interface ActionTarget {
  taskId: string;
  issueNumber: number;
  title: string;
  state: TaskState;
  /** 需求级在跑的会话（分诊、写需求文档、写方案）。 */
  activity?: Activity | undefined;
  sub?: BoardSubtask | undefined;
}

export function targetOf(t: BoardTask, sub?: BoardSubtask): ActionTarget {
  return {
    taskId: t.id,
    issueNumber: t.issueNumber,
    title: t.title,
    state: t.state,
    activity: t.activity,
    sub,
  };
}

export type UiAction = 'answer' | 'reroute' | 'pause' | 'resume' | 'stop';

export interface ActionDef {
  label: string;
  icon: LucideIcon;
  /** 看板上选中卡片后按的键。 */
  key: string;
  danger?: boolean;
}

export const ACTIONS: Record<UiAction, ActionDef> = {
  answer: { label: '回答', icon: MessageCircleQuestion, key: 'A' },
  reroute: { label: '换模型', icon: Shuffle, key: 'M' },
  pause: { label: '暂停', icon: Pause, key: 'P' },
  resume: { label: '继续', icon: Play, key: 'C' },
  stop: { label: '叫停', icon: CircleStop, key: 'X', danger: true },
};

/**
 * 按状态决定该画出哪些操作：只画引擎的任务工作流真有人听的（继续、叫停，外加回答）。暂停、换模型引擎没有这两个动作
 * （后端回 409 action_not_supported，api/src/cockpit.ts；#901），所以不画：画出来点了只会弹一句「做不到」。
 * 叫停、继续对整个需求生效，只放在需求上。接口里没有「暂停中」这个状态，「继续」一直给出来，由后端判断（没停着等人就没有收信的）。
 * 现在页面上只有通知中心用到「回答」（看板删了以后这个函数没有别的调用方，#856）；将来哪个页面接这排按钮，都从这里取。
 */
export function availableActions(target: ActionTarget): UiAction[] {
  if (isTaskFinished(target)) return [];
  const list: UiAction[] = [];
  if (!target.sub && target.state === 'asking') list.push('answer');
  if (!target.sub) list.push('resume', 'stop');
  return list;
}

export function targetName(t: ActionTarget): string {
  const n = `#${t.issueNumber}`;
  return t.sub ? `${n} 子任务 ${letterOf(t.sub.index)}` : n;
}

type DialogState =
  | { kind: 'route'; target: ActionTarget }
  | { kind: 'stop'; target: ActionTarget }
  | { kind: 'answer'; target: ActionTarget }
  | null;

interface TaskActionsApi {
  trigger(action: UiAction, target: ActionTarget): void;
}

const Ctx = createContext<TaskActionsApi | null>(null);

export function TaskActionsProvider({ children }: { children: ReactNode }) {
  // 只取 mutateAsync（它在各次渲染间不变）：整个 mutation 对象每次渲染都是新的，拿它当依赖会让 trigger 每次都变。
  const { mutateAsync } = useTaskAction();
  const [dialog, setDialog] = useState<DialogState>(null);

  const send = useCallback(
    async (target: ActionTarget, body: TaskActionBody, label: string) => {
      try {
        await mutateAsync({ taskId: target.taskId, body });
        toast.success(`${label}：${targetName(target)}`, {
          description: body.action === 'pause' ? '当前会话停在干净的点，做完的已提交' : undefined,
        });
      } catch (e) {
        toast.error(`${label}没成功`, { description: errorText(e) });
      }
    },
    [mutateAsync],
  );

  const trigger = useCallback(
    (action: UiAction, target: ActionTarget) => {
      if (action === 'reroute') setDialog({ kind: 'route', target });
      else if (action === 'stop') setDialog({ kind: 'stop', target });
      else if (action === 'answer') setDialog({ kind: 'answer', target });
      else void send(target, { action }, ACTIONS[action].label);
    },
    [send],
  );

  const api = useMemo(() => ({ trigger }), [trigger]);
  const close = () => setDialog(null);

  return (
    <Ctx value={api}>
      {children}
      <RoutePickerDialog
        target={dialog?.kind === 'route' ? dialog.target : null}
        onClose={close}
        onPick={(routeId) => {
          if (dialog?.kind === 'route') {
            const t = dialog.target;
            void send(t, { action: 'reroute', routeId, ...(t.sub ? { subtaskId: t.sub.id } : {}) }, '换模型');
          }
          close();
        }}
      />
      <AlertDialog open={dialog?.kind === 'stop'} onOpenChange={(o) => !o && close()}>
        <AlertDialogContent>
          {dialog?.kind === 'stop' ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>叫停 {targetName(dialog.target)}？</AlertDialogTitle>
                <AlertDialogDescription>
                  在跑的会话停在干净的点，做完的已提交；之后这个需求不再往下走，要做可以重新开。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>先不</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-white hover:bg-destructive/90"
                  onClick={() => void send(dialog.target, { action: 'stop' }, '叫停')}
                >
                  叫停
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
      <AnswerDialog target={dialog?.kind === 'answer' ? dialog.target : null} onClose={close} />
    </Ctx>
  );
}

export function useTaskActions(): TaskActionsApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('缺少 TaskActionsProvider');
  return ctx;
}

/** 一排操作按钮（侧边详情、任务详情页用）。 */
export function ActionButtons({ target, size = 'sm' }: { target: ActionTarget; size?: 'sm' | 'default' }) {
  const { trigger } = useTaskActions();
  const list = availableActions(target);
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((a) => {
        const def = ACTIONS[a];
        const Icon = def.icon;
        return (
          <Button
            key={a}
            size={size}
            variant={a === 'answer' ? 'default' : 'outline'}
            className={cn(def.danger && 'text-ink-fail hover:text-ink-fail')}
            onClick={() => trigger(a, target)}
          >
            <Icon aria-hidden />
            {def.label}
          </Button>
        );
      })}
    </div>
  );
}

export interface RouteOption {
  id: string;
  model: string;
  where: string;
  host: string;
  /** 额度表还没读到（在读或没读成）时是 undefined：计费方式从额度表的账号池来，没读到不猜。 */
  billing: string | undefined;
  /**
   * 这条路由的账号池额度，一句话（和额度页同一套说法）：额度没查成 / 已用满 / 62% / 用量没读到……
   * 额度表还没读到（在读或没读成）时是 undefined，对话框另有提示。
   */
  quota: QuotaHeadline | undefined;
  estimated: boolean;
  /** 选不了的原因（完整的一句，显示时再截短）；选得了是 undefined。 */
  blocked: string | undefined;
  note: string | undefined;
}

/**
 * 选不了的原因，照后端现算的三件事说（db 的 routing-liveness.ts），这里不再判一遍：死了的写死在哪几件；接不接得上还不知道
 * （探针没看过、这一轮没探它）的也选不了——引擎点名派路由只派探针探通了的，点了也是照常另选。额度没读成不挡（引擎照派、排后面）。
 */
function blockedBy(r: RoutingLayerRoute): string | undefined {
  const dead = [r.connect, r.quota, r.ban].filter((f) => f.verdict === 'dead').map((f) => f.reason);
  if (dead.length) return dead.join('；');
  if (r.connect.verdict === 'unknown') return `接不接得上还不知道：${r.connect.reason}`;
  return undefined;
}

/** 后端回的路由两层里这个用途的那一份。没接上、认不出（回的用途里没有它）都写明为什么，不当成「没有路由」。 */
export function purposeFor(
  layers: RoutingLayers,
  stage: StageKind,
): { purpose: RoutingLayerPurpose } | { problem: string } {
  if (layers.unavailable) return { problem: `现在没法换：${layers.unavailable}` };
  const purpose = layers.purposes.find((p) => p.purpose === stage);
  if (!purpose) {
    return { problem: `现在没法换：后端回的路由两层里没有「${stageLabel[stage]}」这个用途，认不出` };
  }
  return { purpose };
}

/**
 * 换模型的候选：这个用途在路由两层里的路由，先模型的先后、再模型下路由的先后（和选路同一个顺序，#574）。
 * 不在这个用途两层里的路由不列：点了引擎也不认，照常另选（engine 的 store-ports.ts 选路时写「不在这个用途的路由两层顺序里」）。
 */
export function routeOptions(
  purpose: RoutingLayerPurpose,
  pools: PoolView[] | undefined,
  currentRouteId: string | undefined,
): RouteOption[] {
  return purpose.models.flatMap((m) =>
    m.routes.map((r): RouteOption => {
      const pool = pools?.find((p) => p.id === r.poolId);
      // 按这条路由算：只扣别的模型组的窗满了不算它满，和额度页同一句话。模型的族不知道就整池一起算（宁可说紧）。
      const quota = pools
        ? routeQuotaHeadline(pool, m.family ? { id: m.modelId, family: m.family } : undefined)
        : undefined;
      let note: string | undefined;
      if (r.routeId === currentRouteId) note = '正在用';
      else if (r.inFlight >= r.maxConcurrency) note = `账号池满 ${r.inFlight}/${r.maxConcurrency}`;
      return {
        id: r.routeId,
        model: m.displayName,
        where: routeTitle(r),
        host: routeHost(r),
        billing: pools ? (pool?.billing ? billingLabel[pool.billing] : '计费未知') : undefined,
        quota,
        estimated: quota?.kind === 'util' && quota.w.reading === 'estimated',
        blocked: blockedBy(r),
        note,
      };
    }),
  );
}

function RoutePickerDialog({
  target,
  onClose,
  onPick,
}: {
  target: ActionTarget | null;
  onClose(): void;
  onPick(routeId: string): void;
}) {
  // 对话框一直挂着：只在打开时读，不然每一页的首屏都白拉这两份、路由两层还每分钟重拉一次
  const { data: layers, error: layersError } = useRoutingLayers({ enabled: Boolean(target) });
  const { data: pools, error: poolsError } = usePools({ enabled: Boolean(target) });
  const activity = target ? (target.sub ? target.sub.activity : target.activity) : undefined;
  const stage: StageKind = activity?.stage ?? 'execute';
  const current = activity?.routeId;
  const found = layers ? purposeFor(layers, stage) : undefined;
  const purpose = found && 'purpose' in found ? found.purpose : undefined;
  // 没读成、没接上、认不出：照实说现在没法换，不画空列表冒充「没有路由」
  const cannot = layersError
    ? `路由没读成，现在没法换：${errorText(layersError)}`
    : found && 'problem' in found
      ? found.problem
      : undefined;
  const opts = purpose && target ? routeOptions(purpose, pools?.pools, current) : [];
  const empty = cannot
    ? '现在没法换'
    : !layers
      ? '正在读路由…'
      : opts.length === 0
        ? `「${stageLabel[stage]}」用途在路由两层里一条路由都没有`
        : '没有匹配的路由';

  const item = (o: RouteOption) => (
    <CommandItem
      key={o.id}
      value={`${o.model} ${o.where} ${o.host}`}
      disabled={Boolean(o.blocked) || o.id === current}
      onSelect={() => onPick(o.id)}
      className="items-start gap-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="num text-[13px] font-semibold">{o.model}</span>
          <span className="truncate text-xs text-muted-foreground">{o.where}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{o.host}</span>
          {o.billing ? (
            <>
              <span aria-hidden>·</span>
              <span>{o.billing}</span>
            </>
          ) : null}
          {o.note ? (
            <Badge variant="outline" className="h-4 px-1 text-[10px]">
              {o.note}
            </Badge>
          ) : null}
          {o.blocked ? (
            <span className="text-ink-fail" title={o.blocked}>
              {clipText(o.blocked, 80)}
            </span>
          ) : null}
        </div>
      </div>
      {o.quota ? (
        <div className="w-24 shrink-0 text-right" data-quota={o.quota.kind}>
          <div
            className={cn(
              o.quota.kind === 'util' ? 'num text-xs' : cn('text-[11px] font-medium', headlineInk(o.quota)),
            )}
          >
            {headlineText(o.quota)}
          </div>
          {o.quota.kind === 'util' ? (
            <div className="text-[10px] text-muted-foreground">{o.estimated ? '估算' : '实读'}</div>
          ) : null}
        </div>
      ) : null}
    </CommandItem>
  );

  return (
    <Dialog open={Boolean(target)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>
            换模型
            {target ? <span className="ml-2 text-muted-foreground">{targetName(target)}</span> : null}
          </DialogTitle>
          <DialogDescription>
            当前会话停在干净的点（做完的已提交），换成新路由接着干。阶段：{stageLabel[stage]}。
          </DialogDescription>
        </DialogHeader>
        {cannot ? (
          <p role="alert" className="mx-4 rounded-md bg-st-fail/10 px-3 py-2 text-sm text-ink-fail">
            {cannot}
          </p>
        ) : null}
        {purpose?.problems.length ? (
          <p className="mx-4 text-xs text-ink-stall">路由两层的配置缺口：{purpose.problems.join('；')}</p>
        ) : null}
        {poolsError ? (
          <p className="mx-4 text-xs text-ink-stall">
            额度没读成：下面不显示用量和计费方式，挑之前自己去额度页看一眼。
          </p>
        ) : null}
        <Command className="border-t">
          <CommandInput placeholder="搜模型、渠道、执行方式…" />
          <CommandList className="max-h-[420px]">
            <CommandEmpty>{empty}</CommandEmpty>
            <CommandGroup
              heading={`「${stageLabel[stage]}」用途的路由（路由两层的顺序：先模型，再模型下的路由）`}
            >
              {opts.map(item)}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** 回答追问：列出这个需求里还没回答的追问，每条可以点选项或直接写。 */
function AnswerDialog({ target, onClose }: { target: ActionTarget | null; onClose(): void }) {
  const detail = useTaskDetail(target?.taskId);
  const answer = useAnswerAsk();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const pending = detail.data?.asks.filter((a) => a.status === 'pending') ?? [];

  const submit = (askId: string, text: string) => {
    if (!target || !text.trim()) return;
    answer.mutate(
      { askId, answer: text.trim(), taskId: target.taskId },
      {
        onSuccess: () => {
          toast.success(`回答了 ${targetName(target)} 的追问`);
          setDrafts((d) => ({ ...d, [askId]: '' }));
          if (pending.length <= 1) onClose();
        },
        onError: (e) => toast.error('回答没发出去', { description: errorText(e) }),
      },
    );
  };

  return (
    <Dialog open={Boolean(target)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>回答 {target ? targetName(target) : ''} 的追问</DialogTitle>
          <DialogDescription>{target?.title}</DialogDescription>
        </DialogHeader>
        {detail.isLoading ? <p className="text-sm text-muted-foreground">正在读追问…</p> : null}
        {detail.error ? (
          <p role="alert" className="text-sm text-ink-fail">
            追问没读成：{errorText(detail.error)}
          </p>
        ) : null}
        {detail.data && pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">这个需求现在没有待回答的追问。</p>
        ) : null}
        <div className="space-y-5">
          {pending.map((ask) => (
            <div key={ask.id} className="space-y-2">
              <p className="text-sm font-medium">{ask.question}</p>
              {ask.options.length ? (
                <div className="grid gap-2">
                  {ask.options.map((o) => (
                    <Button
                      key={o}
                      variant="outline"
                      className="justify-start"
                      disabled={answer.isPending}
                      onClick={() => submit(ask.id, o)}
                    >
                      {o}
                      {o === ask.recommended ? (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {ask.scope === 'outside' ? '推荐' : '推荐 · AI 已按它先做'}
                        </span>
                      ) : null}
                    </Button>
                  ))}
                </div>
              ) : null}
              <form
                className="grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit(ask.id, drafts[ask.id] ?? '');
                }}
              >
                <Textarea
                  value={drafts[ask.id] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [ask.id]: e.target.value }))}
                  placeholder="或者直接写你的回答…"
                  className="min-h-20"
                />
                <div className="flex justify-end">
                  <Button type="submit" disabled={!(drafts[ask.id] ?? '').trim() || answer.isPending}>
                    发出回答
                  </Button>
                </div>
              </form>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
