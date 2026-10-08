// 快捷操作只有这一份定义：悬停条、右键菜单、侧边详情、手机列表、任务详情都从这里取，行为一致。
// 页面上给的动作：暂停、继续、叫停、重做。没有「换模型」：任务工作流没有中途换路由，后端对 reroute 固定回 409
// action_not_supported（api/src/cockpit.ts，#901、#856）。要换这张单用的模型，在任务页「用哪个模型」里指定
// （components/task-model-pins.tsx：下一次选路起生效，动手这一轮可以「现在就换」）。
// 没有「回答追问」：v3 没有 AI 追问这一环（#928）。
import type { LucideIcon } from 'lucide-react';
import { CircleStop, Pause, Play, RotateCcw } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useTaskAction } from '../api/client';
import type { Activity, BoardSubtask, BoardTask, TaskActionBody, TaskState } from '../api/types';
import { isTaskFinished, letterOf } from '../lib/status';
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

/** 一个操作对着谁：需求，或需求下的某个子任务。 */
export interface ActionTarget {
  taskId: string;
  issueNumber: number;
  title: string;
  state: TaskState;
  /** 需求级在跑的会话（分诊、写需求文档、写方案）。 */
  activity?: Activity | undefined;
  sub?: BoardSubtask | undefined;
  /** 被人暂停着（引擎写的那句「已暂停：…」，#820 片 3）：这时不再给「暂停」，只给「继续」「叫停」。 */
  paused?: string | undefined;
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

/**
 * 按状态决定该画出哪些操作：只画引擎的任务工作流真有人听的（暂停、继续、叫停、重做）。
 * 暂停、叫停、继续、重做对整个需求生效，只放在需求上。暂停了的单不再给「暂停」（后端也回 409 already_paused）；
 * 没暂停的「继续」也一直给出来：停下等人（碰到问题自己停的）也是点它，由后端判断（没停着就没有收信的）。
 * 已叫停的只给「重做」。挂起的工作流还在跑，按钮也给，引擎会拒绝并说明先叫停。做完、失败不给。
 * 任务页（routes/task.tsx）和首页看板的卡片都从这里取。
 */
export function availableActions(target: ActionTarget): UiAction[] {
  if (target.sub) return [];
  if (target.state === 'stopped') return ['redo'];
  if (isTaskFinished(target)) return [];
  const list: UiAction[] = [];
  if (target.paused === undefined) list.push('pause');
  list.push('resume', 'stop');
  if (target.state === 'stalled') list.push('redo');
  return list;
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
      }
    },
    [mutateAsync],
  );

  const trigger = useCallback(
    (action: UiAction, target: ActionTarget) => {
      if (action === 'stop') setDialog({ kind: 'stop', target });
      else if (action === 'pause') setDialog({ kind: 'pause', target });
      else if (action === 'redo') setDialog({ kind: 'redo', target });
      else void send(target, { action }, ACTIONS[action].label);
    },
    [send],
  );

  const api = useMemo(() => ({ trigger }), [trigger]);
  const close = () => setDialog(null);

  return (
    <Ctx value={api}>
      {children}
      <AlertDialog open={dialog?.kind === 'pause'} onOpenChange={(o) => !o && close()}>
        <AlertDialogContent>
          {dialog?.kind === 'pause' ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>暂停 {targetName(dialog.target)}？</AlertDialogTitle>
                <AlertDialogDescription>
                  只停这一张单，别的单照常；点「继续」接着走（和「叫停」不同，叫停不能恢复）。
                  「做完这一段再停」会等手上这一段做完；「立刻停下」会把在跑的动手会话叫停，继续后在原分支原树上重跑。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>先不</AlertDialogCancel>
                <AlertDialogAction
                  variant="outline"
                  onClick={() => void send(dialog.target, { action: 'pause', mode: 'hard' }, '暂停')}
                >
                  立刻停下
                </AlertDialogAction>
                <AlertDialogAction
                  onClick={() => void send(dialog.target, { action: 'pause', mode: 'soft' }, '暂停')}
                >
                  做完这一段再停
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={dialog?.kind === 'stop'} onOpenChange={(o) => !o && close()}>
        <AlertDialogContent>
          {dialog?.kind === 'stop' ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>叫停 {targetName(dialog.target)}？</AlertDialogTitle>
                <AlertDialogDescription>
                  在跑的会话停在干净的点，做完的已提交；之后这个需求不再往下走，不能恢复（只想先停一停请用「暂停」）。要再做，等它停下来后点「重做」。
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
      <AlertDialog open={dialog?.kind === 'redo'} onOpenChange={(o) => !o && close()}>
        <AlertDialogContent>
          {dialog?.kind === 'redo' ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>重做 {targetName(dialog.target)}？</AlertDialogTitle>
                <AlertDialogDescription>
                  会给这张单再起一代，旧的记录留着。旧工作树里没推上去的东西会丢掉；已经推上去的分支还在。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>先不</AlertDialogCancel>
                <AlertDialogAction onClick={() => void send(dialog.target, { action: 'redo' }, '重做')}>
                  重做
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </Ctx>
  );
}

export function useTaskActions(): TaskActionsApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('缺少 TaskActionsProvider');
  return ctx;
}
