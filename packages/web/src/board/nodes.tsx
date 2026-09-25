// 看板上的四种卡片。尺寸固定（见 model.ts 的 NODE_SIZE），三级缩放只换内容。
import { Handle, type Node, type NodeProps, NodeToolbar, Position } from '@xyflow/react';
import { GitMerge, GitPullRequest, UserRound } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import type { Activity, BoardSubtask, BoardTask, Routing } from '../api/types';
import { StatusChip, StatusDot, ToneBar } from '../components/status';
import { ACTIONS, type ActionTarget, availableActions, useTaskActions } from '../components/task-actions';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
import { Kbd } from '../components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { routeInfo } from '../lib/catalog';
import { formatDuration } from '../lib/format';
import { useTimeText } from '../lib/hooks';
import { taskPhases } from '../lib/phases';
import {
  describeSubtask,
  describeTask,
  isMine,
  subLive,
  subtaskStateLabel,
  subtaskTone,
  type Tone,
  taskLive,
  taskProgress,
  taskStateLabel,
  taskTone,
  toneBg,
  toneBorder,
  toneSoft,
  toneText,
} from '../lib/status';
import { cn } from '../lib/utils';
import { nodeTarget, useBoardUi, useHoverIntent, useNodeView, useZoomLevel } from './board-ui';
import type { BoardNodeData, Side } from './model';

export type BoardNode = Node<BoardNodeData>;

type Props = NodeProps<BoardNode>;

/** 「Opus 5.5 · Claude 订阅 · claude-a」：模型、渠道、账号池。 */
function routeLine(routing: Routing | undefined, a: Activity): string {
  const info = routing ? routeInfo(routing, a.routeId) : undefined;
  return info ? `${a.modelName} · ${info.channel} · ${info.poolId}` : a.modelName;
}

// ---------- 外壳：边框、状态色条、选中、聚焦变暗、右键菜单、悬停操作条 ----------

function Shell({
  id,
  data,
  tone,
  live,
  title,
  children,
  className,
}: {
  id: string;
  data: BoardNodeData;
  tone: Tone;
  live: boolean;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const ui = useBoardUi();
  const level = useZoomLevel();
  const { trigger } = useTaskActions();
  const { hover, bind } = useHoverIntent();
  const target = nodeTarget(data);
  const actions = target ? availableActions(target) : [];
  const { selected, dimmed } = useNodeView(ui.view, id);

  return (
    <>
      {target && actions.length ? (
        <NodeToolbar
          isVisible={(hover || selected) && level !== 'far' && !dimmed}
          position={Position.Top}
          offset={8}
        >
          <div {...bind} className="flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-lg">
            {actions.map((a) => (
              <QuickButton key={a} action={a} target={target} onRun={() => trigger(a, target)} />
            ))}
          </div>
        </NodeToolbar>
      ) : null}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            {...bind}
            data-tone={tone}
            data-selected={selected || undefined}
            className={cn(
              'relative h-full w-full overflow-hidden rounded-xl border bg-card text-card-foreground',
              'shadow-[0_1px_2px_var(--shadow-color),0_8px_24px_-16px_var(--shadow-color)]',
              'transition-[opacity,filter,box-shadow] duration-300',
              toneBorder[tone],
              live && 'fd-live',
              selected && 'outline-2 outline-offset-4 outline-foreground',
              dimmed && 'opacity-[0.16] saturate-[0.3]',
              className,
            )}
          >
            <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', toneBg[tone])} />
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuLabel className="truncate text-xs text-muted-foreground">{title}</ContextMenuLabel>
          {target
            ? actions.map((a) => {
                const def = ACTIONS[a];
                const Icon = def.icon;
                return (
                  <ContextMenuItem
                    key={a}
                    variant={def.danger ? 'destructive' : 'default'}
                    onSelect={() => trigger(a, target)}
                  >
                    <Icon />
                    {def.label}
                    <ContextMenuShortcut>{def.key}</ContextMenuShortcut>
                  </ContextMenuItem>
                );
              })
            : null}
          {actions.length ? <ContextMenuSeparator /> : null}
          <ContextMenuItem onSelect={() => ui.select(id)}>
            看详情
            <ContextMenuShortcut>Enter</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ui.focusOn(id)}>
            聚焦这一支
            <ContextMenuShortcut>F</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ui.open(id)}>
            打开后台页
            <ContextMenuShortcut>O</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
}

function QuickButton({
  action,
  target,
  onRun,
}: {
  action: keyof typeof ACTIONS;
  target: ActionTarget;
  onRun(): void;
}) {
  const def = ACTIONS[action];
  const Icon = def.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${def.label} ${target.title}`}
          className={cn(
            'grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            def.danger && 'hover:text-ink-fail',
          )}
          onClick={(e) => {
            e.stopPropagation();
            onRun();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Icon className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex items-center gap-2">
        {def.label}
        <Kbd>{def.key}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** 连线的接头：右半边的卡片从左边进、右边出；左半边的反过来。 */
function Handles({ side, source = true, target = true }: { side: Side; source?: boolean; target?: boolean }) {
  const into = side === 'left' ? Position.Right : Position.Left;
  const out = side === 'left' ? Position.Left : Position.Right;
  return (
    <>
      {target ? <Handle type="target" position={into} isConnectable={false} /> : null}
      {source ? <Handle type="source" position={out} isConnectable={false} /> : null}
    </>
  );
}

/** 远景：整张卡只剩状态色和大号数字。 */
function Far({ tone, big, small }: { tone: Tone; big: string; small?: string | undefined }) {
  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-3', toneSoft[tone])}>
      <div className={cn('num text-[64px] leading-none font-bold tracking-tight', toneText[tone])}>{big}</div>
      {small ? (
        <div className="num text-[30px] leading-none font-semibold text-muted-foreground">{small}</div>
      ) : null}
    </div>
  );
}

/** 提出人：是自己就写「我」；别人的只有编号（契约里还没有显示名），放在悬停提示里。 */
function Requester({ requestedBy }: { requestedBy: string }) {
  const { me } = useBoardUi();
  if (isMine(requestedBy, me)) {
    return (
      <span
        title="我提的"
        className="grid size-5 place-items-center rounded-full bg-foreground text-[10px] font-semibold text-background"
      >
        我
      </span>
    );
  }
  return (
    <span
      title={`提出人：${requestedBy}`}
      className="grid size-5 place-items-center rounded-full bg-muted text-muted-foreground"
    >
      <UserRound className="size-3" aria-hidden />
    </span>
  );
}

// ---------- 需求 ----------

/** 秒表走动的「干了多久」：只有这一小段跟着秒表重画。 */
function Elapsed({ since }: { since: string }) {
  return <>{useTimeText((now) => formatDuration(now - Date.parse(since)))}</>;
}

/** 卡片上随时间变的那句白话（「Opus 5.5 正在写测试，已 12 分钟」）。 */
function TimeLine({ render }: { render: (now: number) => string }) {
  return <>{useTimeText(render)}</>;
}

function PhaseStrip({ t }: { t: BoardTask }) {
  // 迷你时间线只画每段的状态，不显示时长：不用跟着秒表重画。
  const phases = taskPhases(t, 0);
  return (
    <div className="flex gap-1">
      {phases.map((p) => (
        <div key={p.key} className="min-w-0 flex-1" title={`${p.label}${p.detail ? `：${p.detail}` : ''}`}>
          <div
            className={cn(
              'h-1.5 rounded-full',
              p.state === 'pending' ? 'bg-foreground/10' : toneBg[p.tone],
              p.state === 'done' && 'opacity-70',
              p.state === 'active' && p.tone === 'run' && 'fd-sweep',
            )}
          />
          <div
            className={cn(
              'mt-1 truncate text-[10px]',
              p.state === 'pending' ? 'text-faint' : 'text-muted-foreground',
            )}
          >
            {p.label}
          </div>
        </div>
      ))}
    </div>
  );
}

function PhaseRows({ t }: { t: BoardTask }) {
  const { routing } = useBoardUi();
  const phases = taskPhases(t, 0);
  return (
    <div className="space-y-[3px] text-[10.5px] leading-[14px]">
      {phases.map((p) => {
        const info = routing && p.routeId ? routeInfo(routing, p.routeId) : undefined;
        return (
          <div key={p.key} className="flex items-center gap-1.5">
            <StatusDot tone={p.state === 'pending' ? 'wait' : p.tone} className="size-1.5" />
            <span className="w-7 shrink-0 text-muted-foreground">{p.label}</span>
            <span className="min-w-0 flex-1 truncate">
              {p.modelName ? (
                <>
                  <span className="num">{p.modelName}</span>
                  {info ? <span className="text-muted-foreground"> · {info.poolId}</span> : null}
                  {p.detail ? <span className="text-muted-foreground"> · {p.detail}</span> : null}
                </>
              ) : (
                <span className="text-muted-foreground">
                  {p.detail ?? (p.state === 'pending' ? '还没到' : p.state === 'done' ? '做完了' : '—')}
                </span>
              )}
            </span>
            <span className="num shrink-0 text-muted-foreground">
              {p.state === 'active' && p.modelName && t.activity ? <Elapsed since={t.activity.since} /> : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export const TaskNode = memo(function TaskNode({ id, data }: Props) {
  const level = useZoomLevel();
  if (data.kind !== 'task') return null;
  const t = data.task;
  const tone = taskTone(t);
  const live = taskLive(t);
  const prog = taskProgress(t);
  const title = `#${t.issueNumber} ${t.title}`;
  return (
    <Shell id={id} data={data} tone={tone} live={live} title={title}>
      <Handles side={data.side} />
      {level === 'far' ? (
        <Far tone={tone} big={`#${t.issueNumber}`} small={`${prog.done}/${prog.total}`} />
      ) : (
        <div className="flex h-full flex-col overflow-hidden py-3 pr-3.5 pl-4">
          <div className="flex shrink-0 items-center gap-2">
            <span className="num text-[13px] font-semibold text-muted-foreground">#{t.issueNumber}</span>
            <StatusChip tone={tone} label={taskStateLabel[t.state]} />
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="num" title="优先级：数字越小越先做">
                P{t.priority}
              </span>
              <Requester requestedBy={t.requestedBy} />
            </span>
          </div>
          <div
            className={cn(
              'mt-1.5 shrink-0 text-[14px] leading-snug font-semibold',
              level === 'near' ? 'line-clamp-1' : 'line-clamp-2',
            )}
          >
            {t.title}
          </div>
          <p
            className={cn(
              'mt-1 shrink-0 text-[12px] leading-snug text-muted-foreground',
              level === 'near' ? 'line-clamp-1' : 'line-clamp-2',
            )}
          >
            <TimeLine render={(now) => describeTask(t, now)} />
          </p>
          <div className="mt-auto shrink-0 space-y-2 pt-2">
            {level === 'near' ? <PhaseRows t={t} /> : <PhaseStrip t={t} />}
            <div className="flex items-center gap-2">
              <ToneBar value={prog.total ? prog.done / prog.total : 0} tone={tone} live={live} />
              <span className="num shrink-0 text-[11px] text-muted-foreground">
                {prog.done}/{prog.total}
              </span>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
});

// ---------- 子任务 ----------

/** 步骤清单的进度点：做完的实心、正在做的扫光、没做的淡。步骤太多时换成进度条。 */
function StepDots({ s, tone }: { s: BoardSubtask; tone: Tone }) {
  const p = s.progress;
  if (!p?.total) return <span className="text-[11px] text-faint">还没报步骤</span>;
  const current = s.activity && !s.activity.queued && p.done < p.total ? p.done : -1;
  if (p.total > 12) {
    return <ToneBar value={p.done / p.total} tone={tone} live={current >= 0} className="max-w-32" />;
  }
  return (
    <div className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: p.total }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: 点只按序号区分，没有别的身份。
          key={i}
          className={cn(
            'h-1.5 w-3.5 rounded-full',
            i < p.done
              ? 'bg-st-done opacity-70'
              : i === current
                ? cn(toneBg[tone], 'fd-sweep')
                : 'bg-foreground/10',
          )}
        />
      ))}
    </div>
  );
}

/** 近景：路由、排队或干活的时长、正在做的那一步。 */
function SubNear({ s, siblings }: { s: BoardSubtask; siblings: BoardSubtask[] }) {
  const { routing } = useBoardUi();
  const a = s.activity;
  const p = s.progress;
  return (
    <>
      {a ? (
        <>
          <div className="mt-1 shrink-0 truncate text-[10.5px] text-muted-foreground">
            <span className="num text-foreground">{routeLine(routing, a)}</span>
          </div>
          <div className="shrink-0 truncate text-[10.5px] text-muted-foreground">
            {a.queued ? '排队' : '干活'}{' '}
            <span className="num">
              <Elapsed since={a.since} />
            </span>
            {p?.total ? (
              <>
                {' '}
                · 第 <span className="num">{Math.min(p.done + 1, p.total)}</span>/
                <span className="num">{p.total}</span> 步
              </>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 shrink-0 text-[11.5px] leading-snug">
            {a.step ? `正在：${a.step}` : <TimeLine render={(now) => describeSubtask(s, now, siblings)} />}
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 line-clamp-2 shrink-0 text-[11.5px] leading-snug text-muted-foreground">
            <TimeLine render={(now) => describeSubtask(s, now, siblings)} />
          </p>
          {s.touches.length ? (
            <div className="mt-1 shrink-0 space-y-px text-[10.5px] text-muted-foreground">
              {s.touches.slice(0, 3).map((f) => (
                <div key={f} className="num truncate">
                  {f}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
      <div className="mt-auto flex shrink-0 items-center gap-2 pt-1">
        <StepDots s={s} tone={subtaskTone(s)} />
      </div>
    </>
  );
}

export const SubNode = memo(function SubNode({ id, data }: Props) {
  const level = useZoomLevel();
  if (data.kind !== 'sub') return null;
  const s = data.sub;
  const tone = subtaskTone(s);
  const live = subLive(s);
  const p = s.progress;
  const title = `#${data.task.issueNumber} 子任务 ${data.letter}：${s.title}`;
  return (
    <Shell id={id} data={data} tone={tone} live={live} title={title}>
      <Handles side={data.side} source={Boolean(s.prNumber)} />
      {level === 'far' ? (
        <Far tone={tone} big={data.letter} small={p?.total ? `${p.done}/${p.total}` : undefined} />
      ) : (
        <div className="flex h-full flex-col overflow-hidden py-3 pr-3.5 pl-4">
          <div className="flex shrink-0 items-center gap-2">
            <span
              className={cn(
                'num grid size-5 place-items-center rounded-md text-[11px] font-bold',
                toneSoft[tone],
                toneText[tone],
              )}
            >
              {data.letter}
            </span>
            <StatusChip tone={tone} label={subtaskStateLabel[s.state]} />
            {s.prNumber ? (
              <span className="num ml-auto text-[11px] text-muted-foreground">PR #{s.prNumber}</span>
            ) : null}
          </div>
          <div
            className={cn(
              'shrink-0 text-[13.5px] leading-snug font-semibold',
              level === 'near' ? 'mt-1 line-clamp-1' : 'mt-1.5 line-clamp-2',
            )}
          >
            {s.title}
          </div>
          {level === 'near' ? (
            <SubNear s={s} siblings={data.task.subtasks} />
          ) : (
            <>
              <p className="mt-1 line-clamp-2 shrink-0 text-[12px] leading-snug text-muted-foreground">
                <TimeLine render={(now) => describeSubtask(s, now, data.task.subtasks)} />
              </p>
              <div className="mt-auto flex shrink-0 items-center gap-2 pt-2">
                <StepDots s={s} tone={tone} />
                {p?.total ? (
                  <span className="num ml-auto text-[11px] text-muted-foreground">
                    {p.done}/{p.total} 步
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>
      )}
    </Shell>
  );
});

// ---------- PR ----------

/** PR 卡只看子任务的状态说话：契约里没有检查结果和合并队列位置。 */
export function prState(s: BoardSubtask): { tone: Tone; text: string; live: boolean } {
  switch (s.state) {
    case 'merged':
      return { tone: 'done', text: '已合并', live: false };
    case 'in_merge_queue':
      return { tone: 'run', text: '排队合并', live: true };
    case 'verifying':
      return { tone: 'run', text: '在最新主线上重测', live: true };
    case 'failed':
      return { tone: 'fail', text: '没合成', live: false };
    case 'stalled':
      return { tone: 'stall', text: '停住了', live: false };
    case 'stopped':
      return { tone: 'stop', text: '已叫停', live: false };
    default:
      return {
        tone: 'wait',
        text: s.activity?.stage === 'review' ? '第二意见在看' : '已开 PR，还在改',
        live: false,
      };
  }
}

export const PrNode = memo(function PrNode({ id, data }: Props) {
  const level = useZoomLevel();
  if (data.kind !== 'pr') return null;
  const { tone, text, live } = prState(data.sub);
  const Icon = data.sub.state === 'merged' ? GitMerge : GitPullRequest;
  return (
    <Shell id={id} data={data} tone={tone} live={false} title={`PR #${data.prNumber}`}>
      <Handles side={data.side} source={false} />
      {level === 'far' ? (
        <div className={cn('flex h-full items-center justify-center', toneSoft[tone])}>
          <span className={cn('num text-[40px] font-bold', toneText[tone])}>#{data.prNumber}</span>
        </div>
      ) : (
        <div className="flex h-full flex-col justify-center gap-1 py-2 pr-3 pl-4">
          <div className="flex items-center gap-1.5">
            <Icon className={cn('size-3.5', toneText[tone])} aria-hidden />
            <span className="num text-[13px] font-semibold">PR #{data.prNumber}</span>
            {live ? <StatusDot tone="run" className="ml-auto size-1.5" /> : null}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">{text}</div>
        </div>
      )}
    </Shell>
  );
});

// ---------- 仓 ----------

export const RepoNode = memo(function RepoNode({ id, data }: Props) {
  const level = useZoomLevel();
  if (data.kind !== 'repo') return null;
  const { repo, counts } = data;
  const cells: { label: string; value: number; tone: Tone }[] = [
    { label: '在跑', value: counts.running, tone: 'run' },
    { label: '卡住', value: counts.stuck, tone: 'stall' },
    { label: '等你', value: counts.human, tone: 'human' },
    { label: '已完成', value: counts.done, tone: 'done' },
  ];
  return (
    <Shell
      id={id}
      data={data}
      tone="wait"
      live={false}
      title={`${repo.owner}/${repo.name}`}
      className="border-border-strong"
    >
      <Handle id="r" type="source" position={Position.Right} isConnectable={false} />
      <Handle id="l" type="source" position={Position.Left} isConnectable={false} />
      {level === 'far' ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-4">
          <div className="num max-w-full truncate text-[40px] leading-none font-bold tracking-tight">
            {repo.name}
          </div>
          <div className="text-[24px] text-muted-foreground">
            <span className="num">{counts.total}</span> 个需求
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col py-3 pr-3.5 pl-4">
          <div className="num truncate text-[11px] text-muted-foreground">{repo.owner}/</div>
          <div className="num truncate text-[19px] leading-tight font-bold">{repo.name}</div>
          <div className="text-[11px] text-muted-foreground">
            {counts.total} 个需求 · 主线 <span className="num">{repo.defaultBranch}</span>
          </div>
          <div className="mt-auto grid grid-cols-4 gap-1 pt-2">
            {cells.map((c) => (
              <div key={c.label} className="min-w-0">
                <div
                  className={cn(
                    'num text-[18px] leading-none font-semibold',
                    c.value ? toneText[c.tone] : 'text-faint',
                  )}
                >
                  {c.value}
                </div>
                <div className="mt-1 truncate text-[10px] text-muted-foreground">{c.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Shell>
  );
});

export const nodeTypes = { repo: RepoNode, task: TaskNode, sub: SubNode, pr: PrNode };
