// 快捷操作只有这一份定义（#856 第 1 处）。
// 判定：暂停、继续、叫停不是漏了入口。#820 片 3（#1203，PR #1229）已经接到任务页和首页看板；重做是 #1307。
// 各处按钮收成 ActionButtons / useTargetActions，调用方：
// - 任务详情 routes/task.tsx、看板侧边详情 home/board/detail-panel.tsx：ActionButtons
// - 悬停条和右键 home/board/nodes.tsx、手机列表 home/board/board-tree.tsx：useTargetActions
// - 选中卡片后的快捷键 home/board/board-canvas.tsx：shortcutAction
// 没有「换模型」：任务工作流没有中途换路由，后端对 reroute 固定回 409 action_not_supported
// （api/src/cockpit.ts）。要换这张单用的模型，在任务页「用量与模型」的「用哪个模型」里指定（task-model-pins.tsx）。
// 没有「回答追问」：v3 没有 AI 追问这一环（#928）。
import { continueExhausted } from '@fleet-dao/shared';
import type { LucideIcon } from 'lucide-react';
import { CircleStop, Pause, Play, RotateCcw } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useTaskAction } from '../api/client';
import type { Activity, BoardSubtask, BoardTask, TaskActionBody, TaskState } from '../api/types';
import { isTaskFinished, letterOf } from '../lib/status';
import { Button } from './layout/button';
import { ConfirmDialog } from './layout/confirm-dialog';
import { RowMenu, RowMenuItem } from './layout/row-menu';
import { Stack } from './layout/stack';

/** 一个操作对着谁：需求，或需求下的某个子任务。 */
export interface ActionTarget {
  taskId: string;
  issueNumber: number;
  title: string;
  state: TaskState;
  /** 需求级在跑的会话（分诊、写需求文档、写方案）。 */
  activity?: Activity | undefined;
  sub?: BoardSubtask | undefined;
  /** 被人暂停着（引擎写的那句「已暂停：…」，#820 片 3）：这时不画「暂停」，只给「继续」「叫停」。 */
  paused?: string | undefined;
  /**
   * 停下等人的原因（state=stalled 时引擎写的 lastProblem）。
   * 是「已继续 N 次仍没过」时「继续」置灰，文案改成要重开用 redo。
   */
  parkedWhy?: string | undefined;
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

export type UiAction = 'pause' | 'resume' | 'stop' | 'redo';

export interface ActionDef {
  label: string;
  icon: LucideIcon;
  /** 看板上选中卡片后按的键。 */
  key: string;
  danger?: boolean;
}

export const ACTIONS: Record<UiAction, ActionDef> = {
  pause: { label: '暂停', icon: Pause, key: 'P' },
  resume: { label: '继续', icon: Play, key: 'C' },
  stop: { label: '叫停', icon: CircleStop, key: 'X', danger: true },
  redo: { label: '重做', icon: RotateCcw, key: 'R' },
};

/** 置灰时悬停写的原因。能点的按钮没有这句。不该出现的按钮不进这份列表，不靠置灰留在页上。 */
export interface TaskActionButton {
  action: UiAction;
  disabledReason?: string;
}

/** 继续次数用满：按钮还在，但点不了，文案就是拒绝的那一句。别的停住原因仍给能点的「继续」。 */
function resumeOffer(target: ActionTarget): TaskActionButton {
  const exhausted = continueExhausted(target.parkedWhy);
  return exhausted ? { action: 'resume', disabledReason: exhausted } : { action: 'resume' };
}

/**
 * 按状态决定画出哪些操作：只画引擎的任务工作流真有人听的（暂停、继续、叫停、重做）。
 * 暂停、叫停、继续、重做对整个需求生效，只放在需求上。
 * 已暂停不画「暂停」（后端再点也回 409 already_paused），只给「继续」「叫停」。
 * 在跑且没暂停不画「继续」，只给「暂停」「叫停」。已完成、已失败一个都不画。
 * 已叫停只给「重做」。停滞再加「重做」（工作流还在跑时由后端拒绝）。
 * 停滞是停下等人：等人的是「继续」或「叫停」，没有正在跑的一段可暂停，所以不画「暂停」。
 * 合并中在等合并，同样不画「暂停」；人已经暂停过的仍给「继续」。叫停留着。
 * 真要置灰的带 disabledReason，悬停写明原因；菜单和快捷键不提供点不了的。
 */
export function taskActionButtons(target: ActionTarget): TaskActionButton[] {
  if (target.sub) return [];
  if (target.state === 'stopped') return [{ action: 'redo' }];
  if (isTaskFinished(target)) return [];
  const list: TaskActionButton[] = [];
  if (target.state === 'stalled') list.push(resumeOffer(target));
  else if (target.state === 'merging') {
    if (target.paused !== undefined) list.push(resumeOffer(target));
  } else if (target.paused === undefined) list.push({ action: 'pause' });
  else list.push(resumeOffer(target));
  list.push({ action: 'stop' });
  if (target.state === 'stalled') list.push({ action: 'redo' });
  return list;
}

/** 这一状态下能点的操作。置灰的不在这里：菜单和快捷键不提供点不了的。 */
export function availableActions(target: ActionTarget): UiAction[] {
  return taskActionButtons(target)
    .filter((button) => button.disabledReason === undefined)
    .map((button) => button.action);
}

export function targetName(t: ActionTarget): string {
  const n = `#${t.issueNumber}`;
  return t.sub ? `${n} 子任务 ${letterOf(t.sub.index)}` : n;
}

type DialogState =
  | { kind: 'stop'; target: ActionTarget }
  | { kind: 'pause'; target: ActionTarget }
  | { kind: 'redo'; target: ActionTarget }
  | null;

interface TaskActionsApi {
  trigger(action: UiAction, target: ActionTarget): void;
  /** 这张单的这个操作正在发（任务页那排按钮转圈用，#2009）。 */
  pending(taskId: string, action: UiAction): boolean;
}

const Ctx = createContext<TaskActionsApi | null>(null);

export function TaskActionsProvider({ children }: { children: ReactNode }) {
  // 只取 mutateAsync（它在各次渲染间不变）：整个 mutation 对象每次渲染都是新的，拿它当依赖会让 trigger 每次都变。
  const { mutateAsync } = useTaskAction();
  const [dialog, setDialog] = useState<DialogState>(null);
  // 正在发的「单号:操作」：同一张单同一个操作在发的时候，那排按钮里对应那颗转圈、点不动
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());

  const send = useCallback(
    async (target: ActionTarget, body: TaskActionBody, label: string) => {
      const key = `${target.taskId}:${body.action}`;
      setInFlight((s) => new Set(s).add(key));
      try {
        await mutateAsync({ taskId: target.taskId, body });
        toast.success(`${label}：${targetName(target)}`, {
          description:
            body.action === 'pause'
              ? body.mode === 'hard'
                ? '动手的会话已叫停，树里留着的改动继续后接着干'
                : '手上这一段做完就停，不再起新会话'
              : body.action === 'redo'
                ? '新的一代已经起了。旧工作树里没推上去的东西不会跟着过来。'
                : undefined,
        });
      } catch (e) {
        toast.error(`${label}没成功`, { description: errorText(e) });
        // 抛给确认框：框留着、写原因、能再点（#2009）
        throw e;
      } finally {
        setInFlight((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    },
    [mutateAsync],
  );

  const trigger = useCallback(
    (action: UiAction, target: ActionTarget) => {
      if (action === 'stop') setDialog({ kind: 'stop', target });
      else if (action === 'pause') setDialog({ kind: 'pause', target });
      else if (action === 'redo') setDialog({ kind: 'redo', target });
      // 继续不弹确认框：失败已经弹了 toast，这里不再往外抛
      else send(target, { action }, ACTIONS[action].label).catch(() => {});
    },
    [send],
  );

  const api = useMemo(
    () => ({ trigger, pending: (taskId: string, action: UiAction) => inFlight.has(`${taskId}:${action}`) }),
    [trigger, inFlight],
  );
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };

  return (
    <Ctx value={api}>
      {children}
      {dialog?.kind === 'pause' ? (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={`暂停 ${targetName(dialog.target)}？`}
          description="只停这一张单，别的单照常；点「继续」接着走（和「叫停」不同，叫停不能恢复）。「做完这一段再停」会等手上这一段做完；「立刻停下」会把在跑的动手会话叫停，继续后在原分支原树上重跑。"
          confirmText="做完这一段再停"
          onConfirm={() => send(dialog.target, { action: 'pause', mode: 'soft' }, '暂停')}
          secondary={{
            text: '立刻停下',
            onConfirm: () => send(dialog.target, { action: 'pause', mode: 'hard' }, '暂停'),
          }}
        />
      ) : null}
      {dialog?.kind === 'stop' ? (
        <ConfirmDialog
          open
          onOpenChange={close}
          danger
          title={`叫停 ${targetName(dialog.target)}？`}
          description="在跑的会话停在干净的点，做完的已提交；之后这个需求不再往下走，不能恢复（只想先停一停请用「暂停」）。要再做，等它停下来后点「重做」。"
          confirmText="叫停"
          onConfirm={() => send(dialog.target, { action: 'stop' }, '叫停')}
        />
      ) : null}
      {dialog?.kind === 'redo' ? (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={`重做 ${targetName(dialog.target)}？`}
          description="会给这张单再起一代，旧的记录留着。旧工作树里没推上去的东西会丢掉；已经推上去的分支还在。"
          confirmText="重做"
          onConfirm={() => send(dialog.target, { action: 'redo' }, '重做')}
        />
      ) : null}
    </Ctx>
  );
}

export function useTaskActions(): TaskActionsApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('缺少 TaskActionsProvider');
  return ctx;
}

export interface RunnableAction {
  action: UiAction;
  def: ActionDef;
  run: () => void;
}

/** 这一处该画的动作，带上点了怎么发。没有对象、或这一状态下没有动作，就是空的。 */
export function useTargetActions(target: ActionTarget | undefined): RunnableAction[] {
  const { trigger } = useTaskActions();
  if (!target) return [];
  return availableActions(target).map((action) => ({
    action,
    def: ACTIONS[action],
    run: () => trigger(action, target),
  }));
}

/**
 * 任务页和看板侧边详情上的一排字按钮。没有该画的动作时什么都不画。置灰的悬停写明原因。
 * 灰底次按钮，叫停是红的、和前面的拉开一段（降低误点，#1751）；页头里没有主按钮。
 * moreRedo：「重做」是低频操作，收进「更多」菜单（任务页用）；不传就和别的操作一样摆在外面（看板侧边详情）。
 */
export function ActionButtons({
  target,
  moreRedo,
}: {
  target: ActionTarget;
  moreRedo?: boolean;
  /** @deprecated 样式交给组件；画布页侧边详情还在传，随 /board 一起删。 */
  className?: string;
}) {
  const { trigger, pending } = useTaskActions();
  const offers = taskActionButtons(target);
  if (!offers.length) return null;
  const inMenu = (action: UiAction) => moreRedo === true && action === 'redo' && offers.length > 1;
  const shown = offers.filter((o) => !inMenu(o.action));
  const redoInMenu = offers.some((o) => inMenu(o.action));
  const btn = ({ action, disabledReason }: TaskActionButton) => {
    const def = ACTIONS[action];
    return (
      <Button
        key={action}
        size="sm"
        variant={def.danger ? 'danger' : 'secondary'}
        // 正在发这一个操作（继续是直接发的；暂停、叫停、重做在确认框里等）：这颗转圈、点不动
        loading={pending(target.taskId, action)}
        {...(disabledReason !== undefined ? { disabledReason } : {})}
        onClick={() => trigger(action, target)}
      >
        {action === 'resume' && disabledReason ? disabledReason : def.label}
      </Button>
    );
  };
  // 前一组：暂停、继续；拉开一段后：叫停、重做（红的叫停和前面隔开，降低误点）
  const front = shown.filter((o) => o.action === 'pause' || o.action === 'resume');
  const stop = shown.filter((o) => o.action === 'stop' || o.action === 'redo');
  return (
    <div data-task-actions>
      <Stack direction="horizontal" gap="xl" align="center" wrap>
        {front.length > 0 ? (
          <Stack direction="horizontal" gap="sm" align="center">
            {front.map(btn)}
          </Stack>
        ) : null}
        {stop.length > 0 || redoInMenu ? (
          <Stack direction="horizontal" gap="sm" align="center">
            {stop.map(btn)}
            {redoInMenu ? (
              <RowMenu label="更多操作" title="重做" reveal={false}>
                <RowMenuItem onSelect={() => trigger('redo', target)}>重做</RowMenuItem>
              </RowMenu>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
    </div>
  );
}

/** 看板上选中卡片后按的那个键对应哪个动作。对不上（或这一状态下不给）就是 undefined。 */
export function shortcutAction(target: ActionTarget, key: string): UiAction | undefined {
  const upper = key.toUpperCase();
  return availableActions(target).find((action) => ACTIONS[action].key === upper);
}
