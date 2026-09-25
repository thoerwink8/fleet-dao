// 手机上的看板：画布换成可折叠的树形列表，信息和操作一样不少。
import { ChevronRight, EllipsisVertical, GitPullRequest, TriangleAlert, User } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Board, BoardSubtask, BoardTask, Me } from '../api/types';
import { StatusChip, StatusDot, ToneBar } from '../components/status';
import {
  ACTIONS,
  type ActionTarget,
  availableActions,
  targetOf,
  useTaskActions,
} from '../components/task-actions';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { useNow } from '../lib/hooks';
import {
  describeSubtask,
  describeTask,
  isTaskClosed,
  letterOf,
  subtaskStateLabel,
  subtaskTone,
  taskLive,
  taskProgress,
  taskStateLabel,
  taskTone,
  toneText,
} from '../lib/status';
import { cn } from '../lib/utils';
import { filterTasks, sortTasks } from './model';

export interface TreeFilter {
  stuck: boolean;
  mine: boolean;
}

export function BoardTree({
  board,
  me,
  filter,
  onFilter,
}: {
  board: Board;
  me: Me | undefined;
  filter: TreeFilter;
  onFilter(f: TreeFilter): void;
}) {
  const tasks = sortTasks(
    filterTasks(board.tasks, {
      stuck: filter.stuck,
      mine: filter.mine && me ? [me.user.id, me.user.displayName] : null,
    }),
  );
  return (
    <div className="px-3 pt-3 pb-24">
      <div className="mb-3 flex items-center gap-2">
        <FilterChip active={filter.stuck} onClick={() => onFilter({ ...filter, stuck: !filter.stuck })}>
          <TriangleAlert className="size-3.5" />
          只看卡住的
        </FilterChip>
        <FilterChip active={filter.mine} onClick={() => onFilter({ ...filter, mine: !filter.mine })}>
          <User className="size-3.5" />
          只看我提的
        </FilterChip>
        <span className="num ml-auto text-xs text-muted-foreground">
          {tasks.length}/{board.tasks.length}
        </span>
      </div>
      {tasks.length ? (
        <ul className="space-y-2" aria-label={`${board.repo.name} 的需求`}>
          {tasks.map((t) => (
            <TaskRow key={t.id} t={t} />
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {filter.stuck ? '没有卡住的需求' : '没有符合条件的需求'}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors',
        active ? 'border-foreground bg-foreground text-background' : 'bg-card text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}

function ActionsMenu({ target, label }: { target: ActionTarget; label: string }) {
  const { trigger } = useTaskActions();
  const actions = availableActions(target);
  const href = `/tasks/${target.taskId}${target.sub ? `?sub=${target.sub.id}` : ''}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label={`${label} 的操作`}>
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {actions.map((a) => {
          const def = ACTIONS[a];
          const Icon = def.icon;
          return (
            <DropdownMenuItem
              key={a}
              variant={def.danger ? 'destructive' : 'default'}
              onSelect={() => trigger(a, target)}
            >
              <Icon />
              {def.label}
            </DropdownMenuItem>
          );
        })}
        {actions.length ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem asChild>
          <Link to={href}>打开详情</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskRow({ t }: { t: BoardTask }) {
  const now = useNow();
  const [open, setOpen] = useState(!isTaskClosed(t) && t.subtasks.length > 0);
  const tone = taskTone(t);
  const prog = taskProgress(t);
  const subs = [...t.subtasks].sort((a, b) => a.index - b.index);
  return (
    <li className="overflow-hidden rounded-xl border bg-card">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-start gap-2 py-2.5 pr-1.5 pl-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground disabled:opacity-30"
              aria-label={open ? '收起子任务' : '展开子任务'}
              disabled={!subs.length}
            >
              <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
            </button>
          </CollapsibleTrigger>
          <Link to={`/tasks/${t.id}`} className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="num text-xs font-semibold text-muted-foreground">#{t.issueNumber}</span>
              <StatusChip tone={tone} label={taskStateLabel[t.state]} />
            </div>
            <div className="mt-1 text-[15px] leading-snug font-semibold">{t.title}</div>
            <p
              className={cn(
                'mt-0.5 text-[13px] leading-snug',
                tone === 'run' ? 'text-muted-foreground' : toneText[tone],
              )}
            >
              {describeTask(t, now)}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <ToneBar value={prog.total ? prog.done / prog.total : 0} tone={tone} live={taskLive(t)} />
              <span className="num shrink-0 text-[11px] text-muted-foreground">
                {prog.done}/{prog.total}
              </span>
            </div>
          </Link>
          <ActionsMenu target={targetOf(t)} label={`#${t.issueNumber}`} />
        </div>
        <CollapsibleContent>
          <ul className="border-t bg-muted/40">
            {subs.map((s) => (
              <SubRow key={s.id} task={t} s={s} siblings={subs} now={now} />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function SubRow({
  task,
  s,
  siblings,
  now,
}: {
  task: BoardTask;
  s: BoardSubtask;
  siblings: BoardSubtask[];
  now: number;
}) {
  const tone = subtaskTone(s);
  const letter = letterOf(s.index);
  return (
    <li className="flex items-start gap-2 border-b py-2 pr-1.5 pl-4 last:border-b-0">
      <span className="mt-1 flex w-5 flex-col items-center gap-1">
        <StatusDot tone={tone} />
      </span>
      <Link to={`/tasks/${task.id}?sub=${s.id}`} className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('num text-xs font-bold', toneText[tone])}>{letter}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.title}</span>
          <StatusChip tone={tone} label={subtaskStateLabel[s.state]} />
        </div>
        <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
          {describeSubtask(s, now, siblings)}
        </p>
        {s.prNumber && s.state !== 'merged' ? (
          <span className="num mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <GitPullRequest className="size-3" aria-hidden />
            PR #{s.prNumber}
          </span>
        ) : null}
      </Link>
      <ActionsMenu target={targetOf(task, s)} label={`#${task.issueNumber} ${letter}`} />
    </li>
  );
}
