// 首页看板上的四种卡片：引擎（中心）、三段、单子、要你拍。尺寸固定（见 model.ts 的 NODE_SIZE），三级缩放只换内容。
// 外壳、远中近三档、悬停操作条、右键菜单照初版（PR #13）的 nodes.tsx 搬回；内容换成 /api/home 的三段流水。
import { Handle, type Node, type NodeProps, NodeToolbar, Position } from '@xyflow/react';
import { ArrowUpRight, Bot, MessageCircleQuestion } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { formatAgo, formatDuration } from '../../../lib/format';
import { useNow } from '../../../lib/hooks';
import { SEGMENT_UNMETERED, segmentHint, segmentLabel } from '../../../lib/segments';
import { type Tone, toneBg, toneSoft, toneText } from '../../../lib/status';
import { cn } from '../../../lib/utils';
import { StatusChip, StatusDot } from '../../status';
import { ACTIONS, type ActionTarget, useTargetActions } from '../../task-actions';
import { Kbd } from '../../ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { CardLink, needsFounder, statusTextOf, WAIT_LABEL } from '../running-card';
import type { HomeFlowStage, HomeRunning } from '../types';
import {
  farCardFontPx,
  farTitleFontSize,
  itemOf,
  targetOfItem,
  useBoardUi,
  useHoverIntent,
  useNodeView,
  useZoomLevel,
  ZOOM_OF,
} from './board-ui';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from './context-menu';
import {
  type BoardNodeData,
  phasesOf,
  type SegmentKey,
  type Side,
  type ToneCounts,
  ticketLive,
  ticketTone,
  worstTone,
} from './model';
import { toneBorder } from './tones';

export type BoardNode = Node<BoardNodeData>;

type Props = NodeProps<BoardNode>;

/** 窗口天数写在三段节点的说明里：api 的样本取看板窗口（近 7 天进终态的 + 开着的）。 */
const SAMPLE_DAYS = 7;

export function segmentName(key: SegmentKey): string {
  return key === 'none' ? '还没分段' : segmentLabel[key];
}

export function segmentHintOf(key: SegmentKey): string {
  return key === 'none' ? 'runs 里没有流水可推出在哪一段' : segmentHint[key];
}

/** 三段节点上的平均耗时那句：没有样本不写 0；不计的段（对题，#761）写「不计」。 */
export function avgText(stage: HomeFlowStage | undefined, key: SegmentKey): string {
  if (!stage) return '不在三段里，没有耗时';
  if (stage.avgMs === undefined) {
    const unmetered = key === 'none' ? undefined : SEGMENT_UNMETERED[key];
    return unmetered ? `${unmetered.short}耗时` : '还没有跑完的样本';
  }
  return `平均 ${formatDuration(stage.avgMs)} · ${stage.samples} 笔`;
}

/** 秒表走动的「多久」：只有这一小段跟着秒表重画。 */
export function Elapsed({ since }: { since: string }) {
  const now = useNow();
  return <>{formatDuration(Math.max(0, now - Date.parse(since)))}</>;
}

function Ago({ at }: { at: string }) {
  const now = useNow();
  return <>{formatAgo(at, now)}</>;
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
  attrs,
}: {
  id: string;
  data: BoardNodeData;
  tone: Tone;
  live: boolean;
  title: string;
  children: ReactNode;
  className?: string;
  attrs?: Record<string, string | boolean | undefined>;
}) {
  const ui = useBoardUi();
  const level = useZoomLevel();
  const { hover, bind } = useHoverIntent();
  const item = itemOf(data);
  const target = item ? targetOfItem(item, ui.remote) : undefined;
  const entries = useTargetActions(target);
  const { selected, dimmed } = useNodeView(ui.view, id);

  return (
    <>
      {target && entries.length ? (
        <NodeToolbar
          isVisible={(hover || selected) && level !== 'far' && !dimmed}
          position={Position.Top}
          offset={8}
        >
          <div {...bind} className="flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-lg">
            {entries.map(({ action, run }) => (
              <QuickButton key={action} action={action} target={target} onRun={run} />
            ))}
          </div>
        </NodeToolbar>
      ) : null}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            {...bind}
            {...attrs}
            data-tone={tone}
            data-selected={selected || undefined}
            className={cn(
              'relative h-full w-full overflow-hidden rounded-xl border bg-card text-card-foreground',
              'shadow-[0_1px_2px_var(--shadow-color),0_8px_24px_-16px_var(--shadow-color)]',
              'transition-[opacity,filter,box-shadow] duration-300',
              toneBorder[tone],
              live && 'fd-live',
              selected && 'outline-2 outline-offset-4 outline-foreground',
              dimmed && 'opacity-15 saturate-30',
              className,
            )}
          >
            <span aria-hidden className={cn('absolute inset-y-0 left-0 w-0.75', toneBg[tone])} />
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuLabel className="truncate text-xs text-muted-foreground">{title}</ContextMenuLabel>
          {entries.map(({ action, def, run }) => {
            const Icon = def.icon;
            return (
              <ContextMenuItem key={action} variant={def.danger ? 'destructive' : 'default'} onSelect={run}>
                <Icon />
                {def.label}
                <ContextMenuShortcut>{def.key}</ContextMenuShortcut>
              </ContextMenuItem>
            );
          })}
          {entries.length ? <ContextMenuSeparator /> : null}
          <ContextMenuItem onSelect={() => ui.select(id)}>
            看详情
            <ContextMenuShortcut>Enter</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => ui.focusOn(id)}>
            聚焦这一支
            <ContextMenuShortcut>F</ContextMenuShortcut>
          </ContextMenuItem>
          {item ? (
            <ContextMenuItem onSelect={() => ui.open(id)}>
              {data.kind === 'ask' ? (ui.remote ? '去那台上答' : '去通知中心答') : '打开单子详情'}
              <ContextMenuShortcut>O</ContextMenuShortcut>
            </ContextMenuItem>
          ) : null}
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
          aria-label={`${def.label} #${target.issueNumber}`}
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

/**
 * 远档编号的 CSS 字号。基准 32：远档缩放 0.4 时屏幕上是 32px；
 * 画布最小缩放 0.15 时屏幕上仍是 12px（32 / 0.4 × 0.15）。
 */
const FAR_HEAD_PX = farCardFontPx(32, ZOOM_OF.far);
/** 远档标题：字号名，跟着画布当前缩放，屏幕上不小于 --text-caption（11px）。 */
const FAR_TITLE_FONT = farTitleFontSize();

/** 远景：整张卡只剩状态色和大号字。编号按缩放倒数放大；标题跟着当前缩放，屏幕上不小于 11px。 */
function Far({ tone, big, small }: { tone: Tone; big: string; small?: string | undefined }) {
  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-1 px-3', toneSoft[tone])}>
      <div
        className={cn('num max-w-full truncate leading-none font-bold tracking-tight', toneText[tone])}
        style={{ fontSize: FAR_HEAD_PX }}
        title={big}
      >
        {big}
      </div>
      {small ? (
        <div
          className="max-w-full truncate leading-none font-semibold text-muted-foreground"
          style={{ fontSize: FAR_TITLE_FONT }}
          title={small}
        >
          {small}
        </div>
      ) : null}
    </div>
  );
}

/** 一排小计数（引擎、三段节点底下）：没有的写淡色 0。 */
function CountCells({ counts }: { counts: ToneCounts }) {
  const cells: { label: string; value: number; tone: Tone }[] = [
    { label: '在跑', value: counts.run, tone: 'run' },
    { label: '在等', value: counts.wait, tone: 'wait' },
    { label: '还没验', value: counts.stall, tone: 'stall' },
    { label: '等你', value: counts.human, tone: 'human' },
    { label: '出问题', value: counts.fail, tone: 'fail' },
  ];
  return (
    <div className="grid grid-cols-5 gap-1">
      {cells.map((c) => (
        <div key={c.label} className="min-w-0">
          <div
            className={cn(
              'num text-stat-num leading-none font-semibold',
              c.value ? toneText[c.tone] : 'text-faint',
            )}
          >
            {c.value}
          </div>
          <div className="mt-1 truncate text-micro text-muted-foreground">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

// ---------- 单子 ----------

/** 迷你时间线：对题 → 动手 → 验收 → 合并。只画状态，不跟秒表重画。 */
function PhaseStrip({ item, live }: { item: HomeRunning; live: boolean }) {
  return (
    <div className="flex gap-1">
      {phasesOf(item).map((p) => (
        <div key={p.key} className="min-w-0 flex-1" title={p.label}>
          <div
            className={cn(
              'h-1.5 rounded-full',
              p.state === 'pending' ? 'bg-foreground/10' : toneBg[p.tone],
              p.state === 'done' && 'opacity-70',
              p.state === 'active' && live && 'fd-sweep',
            )}
          />
          <div
            className={cn(
              'mt-1 truncate text-micro',
              p.state === 'pending' ? 'text-faint' : 'text-muted-foreground',
              p.state === 'active' && cn('font-medium', toneText[p.tone]),
            )}
          >
            {p.label}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 「谁在做 · 本段多久 · 共多久」一行。 */
function WorkerLine({ item }: { item: HomeRunning }) {
  return (
    <div className="flex min-w-0 items-center gap-x-1.5 text-xs text-muted-foreground">
      <Bot className="size-3 shrink-0" aria-hidden />
      <span className={cn('max-w-1/2 shrink-0 truncate', item.worker ? 'text-foreground' : undefined)}>
        {item.worker ?? '没有进程在跑'}
      </span>
      {item.stageSince ? (
        <span className="num shrink-0 whitespace-nowrap">
          · 本段 <Elapsed since={item.stageSince} />
        </span>
      ) : null}
      {item.taskSince ? (
        <span className="num min-w-0 truncate">
          · 共 <Elapsed since={item.taskSince} />
        </span>
      ) : null}
    </div>
  );
}

/**
 * 「在等什么 · 等了多久」一行（在哪一段已经写在标签上，不重复）。没在等：中景不占这一行，近景写「没在等」。
 */
function WaitLine({ item, tone, always }: { item: HomeRunning; tone: Tone; always: boolean }) {
  if (item.waitingReason === 'nothing') {
    return always ? <div className="truncate text-xs text-muted-foreground">没在等，正常往前走</div> : null;
  }
  return (
    <div className="flex min-w-0 items-center gap-x-1.5 text-xs">
      <span className={cn('shrink-0 font-medium', toneText[tone])}>{WAIT_LABEL[item.waitingReason]}</span>
      {item.waitingSince ? (
        <span className="num truncate text-muted-foreground">
          · 已 <Elapsed since={item.waitingSince} />
        </span>
      ) : null}
    </div>
  );
}

/** 最后一行：等你拍的写要拍什么；否则写最近一次事件；一笔流水都没有照实说。 */
function LastLine({ item, withAgo }: { item: HomeRunning; withAgo: boolean }) {
  if (needsFounder(item) && item.pendingDecision) {
    return (
      <div className="truncate text-xs text-ink-human" title={item.pendingDecision}>
        要你拍：{item.pendingDecision}
      </div>
    );
  }
  if (item.lastEvent) {
    return (
      <div
        className={cn(
          'truncate text-xs',
          item.lastEvent.tone === 'trouble' ? 'text-ink-fail' : 'text-muted-foreground',
        )}
        title={item.lastEvent.text}
      >
        最近：{item.lastEvent.text}
        {withAgo ? (
          <span className="num">
            {' '}
            · <Ago at={item.lastEvent.at} />
          </span>
        ) : null}
      </div>
    );
  }
  return <div className="truncate text-xs text-muted-foreground">最近：还没有三段流水记录</div>;
}

export const TicketNode = memo(function TicketNode({ id, data }: Props) {
  const level = useZoomLevel();
  if (data.kind !== 'ticket') return null;
  const item = data.item;
  const tone = ticketTone(item);
  const live = ticketLive(item);
  const founder = needsFounder(item);
  const title = `#${item.issueNumber} ${item.title}`;
  return (
    <Shell
      id={id}
      data={data}
      tone={tone}
      live={live}
      title={title}
      attrs={{ 'data-running-card': item.segment ?? 'none', 'data-needs-founder': String(founder) }}
    >
      <Handles side={data.side} source={item.pendingDecision !== undefined} />
      {level === 'far' ? (
        <Far tone={tone} big={`#${item.issueNumber}`} small={item.title} />
      ) : (
        <div className="flex h-full flex-col overflow-hidden py-3 pr-3 pl-4">
          <div className="flex shrink-0 items-center gap-x-2">
            <span className="num text-sub font-semibold text-muted-foreground">#{item.issueNumber}</span>
            <StatusChip tone={tone} label={statusTextOf(item)} />
            {founder ? (
              <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-ink-human">
                <span className="size-2 rounded-full bg-st-human" aria-hidden />
                等你
              </span>
            ) : null}
            <CardLink
              item={item}
              label={`打开 #${item.issueNumber} 的单子详情`}
              className="nopan nodrag ml-auto grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowUpRight className="size-3.5" aria-hidden />
            </CardLink>
          </div>
          <div
            className={cn(
              'mt-1.5 shrink-0 text-label leading-snug font-semibold',
              level === 'near' ? 'line-clamp-1' : 'line-clamp-2',
            )}
            title={item.title}
          >
            {item.title}
          </div>
          <div className="mt-1 shrink-0 space-y-0.5">
            <WaitLine item={item} tone={tone} always={level === 'near'} />
            <WorkerLine item={item} />
            {level === 'near' ? (
              <div className="num truncate text-xs text-muted-foreground">{item.repo}</div>
            ) : null}
            <LastLine item={item} withAgo={level === 'near'} />
          </div>
          <div className="mt-auto shrink-0 pt-2">
            <PhaseStrip item={item} live={live} />
          </div>
        </div>
      )}
    </Shell>
  );
});

// ---------- 要你拍 ----------

export const AskNode = memo(function AskNode({ id, data }: Props) {
  const level = useZoomLevel();
  if (data.kind !== 'ask') return null;
  return (
    <Shell id={id} data={data} tone="human" live={false} title={`#${data.item.issueNumber} 要你拍`}>
      <Handles side={data.side} source={false} />
      {level === 'far' ? (
        <div className={cn('flex h-full items-center justify-center', toneSoft.human)}>
          <span className={cn('font-bold', toneText.human)} style={{ fontSize: FAR_TITLE_FONT }}>
            等你
          </span>
        </div>
      ) : (
        <div className="flex h-full flex-col justify-center gap-1 py-2 pr-3 pl-4">
          <div className="flex items-center gap-1.5">
            <MessageCircleQuestion className={cn('size-3.5', toneText.human)} aria-hidden />
            <span className="text-sub font-semibold text-ink-human">要你拍</span>
          </div>
          <div className="line-clamp-2 text-xs leading-snug text-muted-foreground" title={data.text}>
            {data.text}
          </div>
        </div>
      )}
    </Shell>
  );
});

// ---------- 三段 ----------

export const SegmentNode = memo(function SegmentNode({ id, data }: Props) {
  const level = useZoomLevel();
  if (data.kind !== 'segment') return null;
  const tone = worstTone(data.counts);
  const name = segmentName(data.key);
  return (
    <Shell
      id={id}
      data={data}
      tone={data.total ? tone : 'wait'}
      live={false}
      title={name}
      className="border-border-strong"
      attrs={{ 'data-flow-lane': data.key }}
    >
      <Handles side={data.side} />
      {level === 'far' ? (
        <Far tone={data.total ? tone : 'wait'} big={name} small={`${data.total} 张`} />
      ) : (
        <div className="flex h-full flex-col py-3 pr-3.5 pl-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xl leading-tight font-bold">{name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              <span className="num text-stat-num font-semibold text-foreground">{data.total}</span> 张在途
            </span>
          </div>
          <div className="truncate text-caption text-muted-foreground">{segmentHintOf(data.key)}</div>
          <div
            className="num truncate text-caption text-muted-foreground"
            title={`样本取近 ${SAMPLE_DAYS} 天看板窗口里跑完的`}
          >
            {avgText(data.stage, data.key)}
          </div>
          <div className="mt-auto pt-2">
            <CountCells counts={data.counts} />
          </div>
        </div>
      )}
    </Shell>
  );
});

// ---------- 引擎（中心） ----------

const engineText: Record<'on' | 'off' | 'down' | 'unknown', { text: string; tone: Tone }> = {
  on: { text: '引擎正常', tone: 'run' },
  off: { text: '引擎已停用', tone: 'stall' },
  down: { text: '引擎没连上', tone: 'fail' },
  unknown: { text: '引擎没查成', tone: 'wait' },
};

export const RootNode = memo(function RootNode({ id, data }: Props) {
  const level = useZoomLevel();
  if (data.kind !== 'root') return null;
  const engine = data.engine ? engineText[data.engine.state] : undefined;
  const scope =
    data.repos.length === 1
      ? (data.repos[0] ?? '')
      : data.repos.length
        ? `${data.repos.length} 个项目`
        : '没有项目';
  return (
    <Shell id={id} data={data} tone="wait" live={false} title="在跑的单" className="border-border-strong">
      <Handle id="r" type="source" position={Position.Right} isConnectable={false} />
      <Handle id="l" type="source" position={Position.Left} isConnectable={false} />
      {level === 'far' ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-4">
          <div className="num leading-none font-bold tracking-tight" style={{ fontSize: FAR_HEAD_PX }}>
            {data.counts.total}
          </div>
          <div className="text-muted-foreground" style={{ fontSize: FAR_TITLE_FONT }}>
            张在跑
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col py-3 pr-3.5 pl-4">
          <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
            {engine ? (
              <>
                <StatusDot tone={engine.tone} className="size-1.5" />
                <span title={data.engine?.detail}>{engine.text}</span>
              </>
            ) : (
              '引擎'
            )}
          </div>
          <div className="text-xl leading-tight font-bold">
            <span className="num">{data.counts.total}</span> 张在跑
          </div>
          <div className="num truncate text-caption text-muted-foreground" title={data.repos.join('、')}>
            {scope}
          </div>
          <div className="mt-auto pt-2">
            <CountCells counts={data.counts} />
          </div>
        </div>
      )}
    </Shell>
  );
});

export const nodeTypes = { root: RootNode, segment: SegmentNode, ticket: TicketNode, ask: AskNode };
