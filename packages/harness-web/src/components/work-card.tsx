// 波次图上的卡片（#3784）：4 行——状态点+名字 / 状态·用时 / 类别·模型 / 一句话说明。
// 配色：在跑蓝、做完绿、失败红、阻塞和暂停黄、其余灰（排队整卡 75% 透明）。同一张单重试过，右上角 ×N 徽章；影子打分有就小字显示。
// 悬停或聚焦一张卡，上下游亮着，其余压到 20% 透明（由画布算好 dim 传进来）。

import type { WorkNode } from '@fleet-dao/harness-contract/work-graph';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { createContext, useContext } from 'react';
import { cn } from '../lib/cn';
import { workCategoryLabel, workStateLabel } from '../lib/labels';
import { COMPACT_H } from '../lib/work-layout';
import { elapsedMs, formatElapsed, pct, retried, retryCount, type Tone, toneOf } from '../lib/work-model';

export const TONE = {
  running: {
    card: 'border-brand/40 bg-brand-soft/60',
    dot: 'bg-brand animate-pulse-dot',
    text: 'text-brand-strong',
  },
  success: { card: 'border-success/30 bg-success-soft/50', dot: 'bg-success', text: 'text-success' },
  danger: { card: 'border-danger/40 bg-danger-soft', dot: 'bg-danger', text: 'text-danger' },
  warning: { card: 'border-warning/40 bg-warning-soft', dot: 'bg-warning', text: 'text-warning' },
  muted: { card: 'border-line bg-surface', dot: 'bg-line-strong', text: 'text-muted' },
} satisfies Record<Tone, { card: string; dot: string; text: string }>;

export function StateDot({ state, className }: { state: string; className?: string }) {
  return (
    <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE[toneOf(state)].dot, className)} />
  );
}

export interface CanvasCtx {
  now: number;
  /** 有运行号的卡才点得开。 */
  onOpen: (node: WorkNode) => void;
  onHover: (id: string | null) => void;
  onToggleWave: (wave: number) => void;
  /** 面板里正开着的节点（卡上加一圈）。 */
  openNodeIds: ReadonlySet<string>;
}
export const CanvasContext = createContext<CanvasCtx | null>(null);
const useCanvas = (): CanvasCtx => {
  const c = useContext(CanvasContext);
  if (!c) throw new Error('卡片要放在画布里');
  return c;
};

/** 状态词 + 用时（列表行和卡片共用）。 */
export function stateLine(node: WorkNode, now: number): string {
  const s = workStateLabel(node.state)?.text ?? node.state;
  const ms = elapsedMs(node, now);
  return ms === null ? s : `${s} · ${formatElapsed(ms)}`;
}

/** 类别·模型（卡片第三行、列表行右下）。 */
export function metaLine(node: WorkNode): string {
  const parts = [workCategoryLabel(node.category ?? undefined)?.text ?? '', node.model ?? ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

export interface CardData extends Record<string, unknown> {
  node: WorkNode;
  compact: boolean;
  dim: boolean;
}

const noHandle = { opacity: 0, pointerEvents: 'none', width: 1, height: 1 } as const;

export function WorkCard({ data }: NodeProps) {
  const { node, compact, dim } = data as CardData;
  const ctx = useCanvas();
  const tone = toneOf(node.state);
  const t = TONE[tone];
  const openable = node.runIds.length > 0;
  const opened = ctx.openNodeIds.has(node.id);
  const cls = cn(
    'relative block w-full rounded-lg border text-left transition-opacity duration-150 motion-reduce:transition-none',
    t.card,
    node.state === 'pending' && 'opacity-75',
    dim && '!opacity-20',
    openable ? 'cursor-pointer hover:border-line-strong' : 'cursor-default',
    opened && 'ring-2 ring-brand',
    compact ? 'px-2' : 'px-2.5 py-1',
  );
  const stateText = workStateLabel(node.state);
  const body = compact ? (
    <span className="flex items-center gap-2" style={{ height: COMPACT_H - 2 }}>
      <StateDot state={node.state} />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{node.label}</span>
      <span className={cn('shrink-0 text-2xs', t.text)}>{stateText?.text}</span>
    </span>
  ) : (
    <>
      <span className="flex items-center gap-2 pr-9">
        <StateDot state={node.state} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink" title={node.label}>
          {node.label}
        </span>
      </span>
      <span className={cn('flex items-center justify-between gap-2 text-2xs', t.text)}>
        <span className="num truncate" data-testid="card-state">
          {stateLine(node, ctx.now)}
        </span>
        {node.score ? (
          <span className="num shrink-0 text-muted" title="影子补丁和旧 PR 合并 diff 的改动行重合度">
            重合 {pct(node.score.lineJaccard)}
          </span>
        ) : null}
      </span>
      <span className="block truncate text-2xs text-muted">{metaLine(node)}</span>
      <span className="block truncate text-2xs text-ink-2" title={node.headline ?? undefined}>
        {node.headline ?? '—'}
      </span>
      {retried(node) ? (
        <span
          data-testid="retry-badge"
          title={`尝试了 ${retryCount(node)} 次`}
          className="num absolute top-1.5 right-1.5 rounded-sm bg-neutral-soft px-1 text-2xs leading-4 font-medium text-ink-2"
        >
          ×{retryCount(node)}
        </span>
      ) : null}
    </>
  );
  const common = {
    'data-testid': 'work-node',
    'data-node-id': node.id,
    'data-state': node.state,
    'data-compact': compact ? '1' : '0',
    className: cls,
    style: { height: compact ? COMPACT_H : undefined },
    onMouseEnter: () => ctx.onHover(node.id),
    onMouseLeave: () => ctx.onHover(null),
  };
  return (
    <>
      <Handle type="target" position={Position.Left} style={noHandle} isConnectable={false} />
      {/* 没有运行的卡点不开，但键盘聚焦时也要能高亮上下游：所以仍是按钮，只标 aria-disabled */}
      <button
        type="button"
        {...common}
        aria-disabled={!openable}
        aria-label={`${node.label}，${stateText?.text ?? node.state}，${openable ? '打开详情' : '还没有运行'}`}
        title={openable ? undefined : '还没有运行，没有详情可看'}
        onFocus={() => ctx.onHover(node.id)}
        onBlur={() => ctx.onHover(null)}
        onClick={() => {
          if (openable) ctx.onOpen(node);
        }}
      >
        {body}
      </button>
      <Handle type="source" position={Position.Right} style={noHandle} isConnectable={false} />
    </>
  );
}

export interface MoreData extends Record<string, unknown> {
  wave: number;
  more: number;
}

/** 折叠的波末尾的「+N 更多」格；展开后变成「收起」。 */
export function MoreCell({ data }: NodeProps) {
  const { wave, more } = data as MoreData;
  const ctx = useCanvas();
  return (
    <button
      type="button"
      data-testid="work-more"
      data-wave={wave}
      aria-expanded={more === 0}
      onClick={() => ctx.onToggleWave(wave)}
      className="h-full w-full cursor-pointer rounded-lg border border-dashed border-line-strong bg-surface/60 text-xs text-ink-2 hover:bg-surface hover:text-ink"
    >
      {more > 0 ? `+${more} 更多` : '收起'}
    </button>
  );
}

export interface HeadData extends Record<string, unknown> {
  title: string;
  summary: string;
  warn: boolean;
}

export function WaveHead({ data }: NodeProps) {
  const { title, summary, warn } = data as HeadData;
  return (
    <div data-testid="wave-head" className="flex h-full flex-col justify-center px-1">
      <span className="text-xs font-medium text-ink">{title}</span>
      <span className={cn('num text-2xs', warn ? 'text-danger' : 'text-muted')}>{summary}</span>
    </div>
  );
}
