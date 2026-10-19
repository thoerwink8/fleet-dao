// 任务页「用量和模型」（#3228）：四个数、用哪个模型、三段、每一笔收成一行，点开才展开，照设计稿。
// 摘要只写读到的：几笔、已用时、输入当量、模型指定了没有；读不到的那项不写，不拿 0 顶。
// 收起时里面照样挂着（只是藏起来），展开不用重新读、指定模型的操作状态也不丢。默认收起。
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { TaskDetail } from '../api/types';
import { formatDuration } from '../lib/format';
import { segmentLabel } from '../lib/segments';
import { isTaskFinished } from '../lib/status';
import { Section } from './layout/section';
import { wallMs } from './segment-usage';

const COUNT = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });

export function usageFoldSummary(d: TaskDetail, now: number): string {
  const t = d.usage.total;
  const parts = [
    `${d.segmentRuns.length} 笔`,
    `${isTaskFinished(d.task) ? '总耗时' : '已用时'} ${formatDuration(wallMs(d, now))}`,
  ];
  // 有一笔没读到 token 就不写这项：写了是少算的数
  if (t.inputEquivalent > 0 && t.missingEquivalent === 0)
    parts.push(`输入当量 ${COUNT.format(t.inputEquivalent)}`);
  const pinned = d.routePins.pins.filter((p) => p.modelId !== undefined);
  if (d.routePins.unavailable) parts.push('模型指定没读到');
  else if (pinned.length) parts.push(`${pinned.map((p) => segmentLabel[p.segment]).join('、')}指定了模型`);
  else parts.push('动手、验收都是自动选');
  return parts.join(' · ');
}

/** 展没展开记在地址里（?usage=open）：点开后的链接发给别人也是展开的，刷新不收回去。 */
export const USAGE_PARAM = 'usage';

export function UsageFold({ summary, children }: { summary: string; children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const open = params.get(USAGE_PARAM) === 'open';
  const setOpen = (next: boolean) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (next) n.set(USAGE_PARAM, 'open');
        else n.delete(USAGE_PARAM);
        return n;
      },
      { replace: true },
    );
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div data-usage-fold className="flex min-w-0 flex-col gap-4 lg:gap-6">
      <Section flush aria-label="用量和模型">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-h-11 w-full min-w-0 items-center gap-3 px-4 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
        >
          <span className="shrink-0 font-semibold">用量和模型</span>
          <span data-usage-summary className="min-w-0 truncate text-meta text-muted-foreground">
            {summary}
          </span>
          <Icon className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </Section>
      <div hidden={!open} className="flex min-w-0 flex-col gap-4 lg:gap-6">
        {children}
      </div>
    </div>
  );
}
