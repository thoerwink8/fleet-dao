// 一张单此刻占的内存和 CPU（#1973）：画布卡片、手机树形列表里展开的那张卡都用这一行。
// 口径在 ../resources.ts 文件头（按单合计、没在跑且没有上次会话写「没在占用」、有上次写峰值和 CPU、读不到写「没读到」，都不画 0）。
import { Cpu, MemoryStick } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { formatCpu, formatMb, type TicketUsage } from '../resources';

/** 悬停里的全文：几个会话、峰值口径、读不到的原因。 */
export function usageTitle(u: TicketUsage): string {
  switch (u.kind) {
    case 'idle':
      return '这一刻没有会话在跑（排队、等人、等验），不占这台机器的内存和 CPU';
    case 'last':
      return u.title;
    case 'unread':
      return `内存、CPU 没读到：${u.why}`;
    case 'ok': {
      const parts = [
        `内存 ${formatMb(u.memoryMb)}`,
        u.cpuPercent === undefined
          ? 'CPU 还在采样（这个会话刚起，只读到一次）'
          : `CPU ${formatCpu(u.cpuPercent)}（100% = 占满一个核）`,
      ];
      if (u.peakMb !== undefined)
        parts.push(`峰值 ${formatMb(u.peakMb)}${u.sessions > 1 ? '（各会话峰值之和，上界）' : ''}`);
      return `${u.sessions > 1 ? `${u.sessions} 个会话合计：` : ''}${parts.join('，')}`;
    }
  }
}

/** 卡片上的一行：图标 + 内存 + CPU；没在占用、没读到各写一句。size 跟着卡片用 canvas 或 meta 字号。 */
export function UsageLine({ usage, size = 'canvas' }: { usage: TicketUsage; size?: 'canvas' | 'meta' }) {
  const text = size === 'canvas' ? 'text-canvas' : 'text-meta';
  if (usage.kind === 'idle') {
    return (
      <div data-usage="idle" className={cn('truncate text-muted-foreground', text)} title={usageTitle(usage)}>
        没在占用
      </div>
    );
  }
  if (usage.kind === 'last') {
    return (
      <div data-usage="last" className={cn('truncate text-muted-foreground', text)} title={usageTitle(usage)}>
        {usage.text}
      </div>
    );
  }
  if (usage.kind === 'unread') {
    return (
      <div
        data-usage="unread"
        className={cn('truncate text-muted-foreground', text)}
        title={usageTitle(usage)}
      >
        内存、CPU 没读到
      </div>
    );
  }
  return (
    <div
      data-usage="ok"
      className={cn('flex min-w-0 items-center gap-x-1.5 whitespace-nowrap text-muted-foreground', text)}
      title={usageTitle(usage)}
    >
      <MemoryStick className="size-3 shrink-0" aria-hidden />
      <span className="num font-medium text-foreground">{formatMb(usage.memoryMb)}</span>
      <Cpu className="ml-1 size-3 shrink-0" aria-hidden />
      {usage.cpuPercent === undefined ? (
        <span>采样中</span>
      ) : (
        <span className="num font-medium text-foreground">{formatCpu(usage.cpuPercent)}</span>
      )}
      {usage.sessions > 1 ? <span className="num min-w-0 truncate">· {usage.sessions} 个会话</span> : null}
    </div>
  );
}

/** 远档卡片单号那一行右边的短写：「1.2G · 42%」；没在占用、没读到写短字。 */
export function usageShort(u: TicketUsage): string {
  if (u.kind === 'idle') return '没在占用';
  if (u.kind === 'last') return u.text;
  if (u.kind === 'unread') return '没读到';
  return `${formatMb(u.memoryMb)} · ${u.cpuPercent === undefined ? '采样中' : formatCpu(u.cpuPercent)}`;
}
