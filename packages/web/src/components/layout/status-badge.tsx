// 状态标签（#3509，样子照 canvas/fd3.css 的 .badge .dot / .tag orange|red）。
// 主用法：<StatusBadge status="task:running" />，中文和颜色等级都从状态字典（src/theme/status-dict.ts）取，页面不传 tone、label。
// 等级决定样子：success、processing、default 画圆点加字；warning、error 默认画橙、红底标签（颜色只给异常）；
// 表格状态列里挤的时候传 variant="dot"，warning、error 也只画圆点加字。意思靠字传，颜色只是辅助。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { emphasized, type Level, type StatusKey, statusEntry } from '../../theme/status-dict';
import { badgeShape, inkClass, type LayoutTone, solidClass } from './tone';

/** 小圆点（6px）：按等级上色；进行中带一圈浅蓝晕。只画点，字由旁边写。
 *  success 也画灰点（决定 0121 第 2 条「正常状态只画灰点」）：绿只留给标了 emphasis 的那一瞬。 */
const DOT: Record<Level, string> = {
  processing: 'bg-brand ring-3 ring-brand-1',
  success: 'bg-ink-3',
  warning: 'bg-warn',
  error: 'bg-fail',
  default: 'bg-ink-3',
};

/** 强调态（刚成功的那一瞬）的点：绿。只有 statusEntry(…).emphasis 才用。 */
const EMPHASIS_DOT = 'bg-success';

/** 带底色的标签：只有橙、红两种（灰标签是 Tag）。 */
const TAG: Partial<Record<Level, string>> = {
  warning: 'bg-warn-1 text-warn-ink',
  error: 'bg-fail-1 text-fail-ink',
};

export function LevelDot({ level, emphasis }: { level: Level; emphasis?: boolean }) {
  return (
    <span
      aria-hidden
      data-level={level}
      {...(emphasis ? { 'data-emphasis': '' } : {})}
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        emphasis && level === 'success' ? EMPHASIS_DOT : DOT[level],
      )}
    />
  );
}

/** 旧的八个 tone 对到新的五个等级（对照见 app.css 文件头）。 */
const TONE_LEVEL: Record<LayoutTone, Level> = {
  run: 'processing',
  done: 'success',
  stall: 'warning',
  doubt: 'warning',
  fail: 'error',
  wait: 'default',
  human: 'default',
  stop: 'default',
};

/**
 * 旧的小圆点：按 tone 上色，在跑的会一圈圈往外扩。
 * @deprecated 老页面还在用，迁页时换成 <StatusBadge status=…>（它自己画点），然后删这个。
 */
export function StatusDot({ tone, className }: { tone: LayoutTone; className?: string }) {
  return (
    <span
      aria-hidden
      data-tone={tone}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        solidClass[tone],
        inkClass[tone],
        tone === 'run' && 'fd-dot-live',
        className,
      )}
    />
  );
}

/** @deprecated 只给旧的 tone/label 写法用。 */
export type StatusBadgeVariant = 'soft' | 'outline' | 'dot';

interface LegacyProps {
  status?: undefined;
  /** @deprecated 改用 status（状态从字典取）。 */
  tone: LayoutTone;
  /** @deprecated 改用 status（中文从字典取）。 */
  label: string;
  /** @deprecated warning、error 自动画底色标签，其余画点加字；要全画点传 dot。 */
  variant?: StatusBadgeVariant;
  /** @deprecated 不再画图标，意思靠字。 */
  icon?: boolean;
  /** @deprecated 页面不写样式。 */
  className?: string;
  /** 悬停说明。写在标签自己身上，不再外包一层。 */
  title?: string;
}

interface DictProps {
  /** 状态字典的键，如 `task:running`。后端来的原始值先过 toStatus(domain, raw)。 */
  status: StatusKey;
  /** auto（默认）：warning、error 画橙、红底标签，其余画点加字；dot：一律只画点加字（表格状态列）。 */
  variant?: 'auto' | 'dot';
  /** 悬停说明（认不出的状态把原值放这里）。 */
  title?: string;
  tone?: undefined;
  label?: undefined;
  icon?: undefined;
  className?: undefined;
}

export type StatusBadgeProps = DictProps | LegacyProps;

export function StatusBadge(props: StatusBadgeProps): ReactNode {
  const legacy = props.status === undefined;
  const entry = legacy ? undefined : statusEntry(props.status);
  const level: Level = legacy ? TONE_LEVEL[props.tone] : (entry as { level: Level }).level;
  const label = legacy ? props.label : (entry as { label: string }).label;
  const emphasis = entry !== undefined && emphasized(entry);
  const dotOnly = props.variant === 'dot';
  const tag = !dotOnly && TAG[level] !== undefined;
  return (
    <span
      data-level={level}
      {...(legacy
        ? { 'data-tone': props.tone, 'data-variant': props.variant ?? 'soft' }
        : { 'data-status': props.status })}
      {...(props.title !== undefined ? { title: props.title } : {})}
      className={cn(
        tag
          ? cn(badgeShape, TAG[level])
          : 'inline-flex shrink-0 items-center gap-2 text-body whitespace-nowrap text-ink',
        legacy && props.className,
      )}
    >
      {tag ? null : <LevelDot level={level} emphasis={emphasis} />}
      {label}
    </span>
  );
}
