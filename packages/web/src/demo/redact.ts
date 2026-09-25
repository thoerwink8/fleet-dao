// 演示版按细节级别收起数据（在交给页面之前就收，页面拿不到的东西就不会被露出去）：
// status = 只看状态和耗时：需求、子任务的标题换成编号（「需求 #12」「子任务 B」），其余文字一律收起；
// titles = 还能看标题；原话、改哪些文件、步骤、过程、追问的内容照样收起；
// process = 全都能看。
// 每个函数都返回新对象，不改传进来的（传进来的是假后端的内部状态）。
import type {
  Activity,
  Audit,
  Board,
  BoardSubtask,
  BoardTask,
  Notifications,
  NowItem,
  TaskDetail,
} from '../api/types';
import { letterOf } from '../lib/status';
import type { DemoDetail } from './scope';

/** 收起来的文字换成这一句，页面上看得出「有，但没开放」，不冒充「没有」。 */
export const HIDDEN_TEXT = '（演示版没开放这一级的细节）';

function activity<T extends Activity>(a: T, level: DemoDetail): T {
  if (level === 'process') return a;
  const { step: _step, ...rest } = a;
  return { ...rest, text: `${a.modelName} ${a.queued ? '排队中' : '在干活'}` } as T;
}

export function taskTitle(t: Pick<BoardTask, 'issueNumber' | 'title'>, level: DemoDetail): string {
  return level === 'status' ? `需求 #${t.issueNumber}` : t.title;
}

function subtask(s: BoardSubtask, level: DemoDetail): BoardSubtask {
  if (level === 'process') return s;
  return {
    ...s,
    title: level === 'status' ? `子任务 ${letterOf(s.index)}` : s.title,
    touches: [],
    ...(s.activity ? { activity: activity(s.activity, level) } : {}),
  };
}

function boardTask(t: BoardTask, level: DemoDetail): BoardTask {
  if (level === 'process') return t;
  return {
    ...t,
    title: taskTitle(t, level),
    subtasks: t.subtasks.map((s) => subtask(s, level)),
    ...(t.activity ? { activity: activity(t.activity, level) } : {}),
  };
}

export function redactBoard(b: Board, level: DemoDetail): Board {
  if (level === 'process') return b;
  const byId = new Map(b.tasks.map((t) => [t.id, t]));
  return {
    ...b,
    tasks: b.tasks.map((t) => boardTask(t, level)),
    now: b.now.map(
      (n): NowItem => ({
        ...activity(n, level),
        taskTitle: (() => {
          const t = byId.get(n.taskId);
          return t ? taskTitle(t, level) : level === 'status' ? '需求' : n.taskTitle;
        })(),
      }),
    ),
  };
}

export function redactTaskDetail(d: TaskDetail, level: DemoDetail): TaskDetail {
  if (level === 'process') return d;
  const { specDir: _spec, ...task } = d.task;
  return {
    ...d,
    task: { ...task, title: taskTitle(d.task, level), rawRequest: HIDDEN_TEXT },
    subtasks: d.subtasks.map((s) => subtask(s, level)),
    runs: d.runs.map((r) => ({ ...r, whyRoute: HIDDEN_TEXT })),
    asks: d.asks.map((a) => {
      const { answer: _a, ...rest } = a;
      return { ...rest, question: '有一个问题在等拍板（内容没开放）', options: [] };
    }),
  };
}

/** 提醒的标题带着任务的内容（追问的原话、卡在哪一步），低于 process 一律换成按种类的说法。 */
export function redactNotifications(
  n: Notifications,
  level: DemoDetail,
  issueOf: (taskId: string) => { issueNumber: number; title: string } | undefined,
): Notifications {
  if (level === 'process') return n;
  return {
    ...n,
    items: n.items.map((x) => {
      const t = x.taskId ? issueOf(x.taskId) : undefined;
      const who = t ? `${taskTitle(t, level)}${level === 'status' ? '' : `（#${t.issueNumber}）`}` : '';
      const title =
        x.level === 'decision'
          ? `${who || '有一件事'}在等你拍板`
          : x.level === 'alert'
            ? `${who || '有东西'}卡住了`
            : '日报';
      return { ...x, title, body: HIDDEN_TEXT };
    }),
  };
}

/** 操作记录的理由、错误是人写的原话，低于 process 收起；动作、对象、谁、何时照常。 */
export function redactAudit(a: Audit, level: DemoDetail): Audit {
  if (level === 'process') return a;
  return {
    ...a,
    items: a.items.map((e) => ({
      ...e,
      ...(e.reason === undefined ? {} : { reason: HIDDEN_TEXT }),
      ...(e.error === undefined ? {} : { error: HIDDEN_TEXT }),
    })),
  };
}
