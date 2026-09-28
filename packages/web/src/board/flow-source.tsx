// 流程配置在看板上的两处：卡片/详情的小标（这一轮用的），顶栏（这个项目此刻的副本）。
// 停派与否只显示后端给的 paused / why，页面不自己算 45 分钟。文案从品牌读，演示包里不能出现会让扫描失败的词。
import type { ReactNode } from 'react';
import { brand } from '#brand';
import type { Board } from '../api/types';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';

const MARK = '全组织默认配置';

/** 只有这一轮用的是全组织默认才渲染。点开和悬停是同一句；点的时候别把卡片的选中、跳转一起触发。 */
export function OrgDefaultMark({
  flowSource,
}: {
  flowSource: 'project' | 'org_default' | undefined;
}): ReactNode {
  if (flowSource !== 'org_default') return null;
  const text = brand.flow.orgDefaultDetail;
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex h-5 shrink-0 items-center rounded-full border border-border bg-muted px-1.5 text-[11px] font-medium whitespace-nowrap text-muted-foreground"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {MARK}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-left">{text}</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-72 text-xs leading-relaxed" onClick={(e) => e.stopPropagation()}>
        {text}
      </PopoverContent>
    </Popover>
  );
}

/** 看板顶上：读自仓里、全组织默认、认不出停派。桌面画布和手机列表的上面都放这一块。 */
export function FlowBanner({ flow }: { flow: Board['flow'] }) {
  const now = useNow();
  if (flow.paused) {
    return (
      <section
        aria-label="流程配置"
        className="shrink-0 border-b border-st-fail bg-background px-4 py-2 text-xs"
      >
        <p className="font-medium text-ink-fail">这个项目停派</p>
        <p className="mt-0.5 text-ink-fail">{flow.why}</p>
        {flow.commit && flow.syncedAt ? (
          <p className="mt-0.5 text-muted-foreground">
            上次读成：<span className="num">{flow.commit}</span>
            {' · '}
            {formatAgo(flow.syncedAt, now)}
          </p>
        ) : null}
      </section>
    );
  }
  const head = flow.source === 'org_default' ? '流程配置用的全组织默认' : '流程配置读自仓里';
  return (
    <section
      aria-label="流程配置"
      className="shrink-0 border-b bg-background px-4 py-2 text-xs text-muted-foreground"
    >
      {head}
      {' · '}
      <span className="num">{flow.commit}</span>
      {' · '}
      {formatAgo(flow.syncedAt, now)}
    </section>
  );
}
