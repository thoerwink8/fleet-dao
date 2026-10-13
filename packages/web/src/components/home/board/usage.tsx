// 一张单占的内存和 CPU（#1973）：画布卡片、手机树形列表里展开的那张卡都用这一行。
// 口径在 ../resources.ts 文件头（按单合计；没在跑写「没在跑」加上一次会话的峰值；读不到写「没读到」，都不画 0）。
import { Cpu, MemoryStick } from 'lucide-react';
import { segmentLabel } from '../../../lib/segments';
import { cn } from '../../../lib/utils';
import { formatCpu, formatMb, type LastSession, type TicketUsage } from '../resources';

/** 上一次会话是哪一段（「上次动手」）；段认不出就只写「上次」。 */
function lastWhere(last: Extract<LastSession, { state: 'ok' }>): string {
  return last.segment === null ? '上次会话' : `上次${segmentLabel[last.segment]}`;
}

/** 悬停里的全文：几个会话、峰值口径、读不到的原因。 */
export function usageTitle(u: TicketUsage): string {
  switch (u.kind) {
    case 'idle': {
      const head = '这一刻没有会话在跑（排队、等人、等验、停下等人），不占这台机器的内存和 CPU';
      if (!u.last) return `${head}；这张单还没收过会话，没有上一次的读数`;
      if (u.last.state === 'unread') return `${head}；上一次会话的内存峰值没读到：${u.last.why}`;
      return `${head}；上一次${u.last.segment === null ? '' : segmentLabel[u.last.segment]}会话的内存峰值 ${formatMb(
        u.last.memoryPeakMb,
      )}（会话跑着时每半秒读 memory.peak，收场写库）；上一次会话 CPU 用了多少还没记`;
    }
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

/** 卡片上的一行：图标 + 内存 + CPU；没在跑写上一次的峰值，没读到写一句。size 跟着卡片用 canvas 或 meta 字号。 */
export function UsageLine({ usage, size = 'canvas' }: { usage: TicketUsage; size?: 'canvas' | 'meta' }) {
  const text = size === 'canvas' ? 'text-canvas' : 'text-meta';
  if (usage.kind === 'idle') {
    const last = usage.last;
    return (
      <div
        data-usage="idle"
        data-usage-last={last?.state ?? 'none'}
        className={cn('flex min-w-0 items-center gap-x-1.5 whitespace-nowrap text-muted-foreground', text)}
        title={usageTitle(usage)}
      >
        <MemoryStick className="size-3 shrink-0" aria-hidden />
        <span className="shrink-0">没在跑</span>
        {last?.state === 'ok' ? (
          <span className="min-w-0 truncate">
            · {lastWhere(last)}峰值{' '}
            <span className="num font-medium text-foreground">{formatMb(last.memoryPeakMb)}</span>
          </span>
        ) : last?.state === 'unread' ? (
          <span className="min-w-0 truncate">· 上次峰值没读到</span>
        ) : null}
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

/** 远档卡片标题下面那一行的短写：在跑「1.2G · 42%」；没在跑「上次 3.5G」；没读到写短字。 */
export function usageShort(u: TicketUsage): string {
  if (u.kind === 'idle') {
    if (!u.last) return '没在跑';
    return u.last.state === 'ok' ? `上次 ${formatMb(u.last.memoryPeakMb)}` : '上次没读到';
  }
  if (u.kind === 'unread') return '没读到';
  return `${formatMb(u.memoryMb)} · ${u.cpuPercent === undefined ? '采样中' : formatCpu(u.cpuPercent)}`;
}
