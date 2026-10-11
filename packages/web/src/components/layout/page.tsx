// 页面外框：页头一行（标题左、操作右，刷新在固定槽位），说明手机上收成 ⓘ（#1820），下面是页面内容。
import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { usePhone } from '../../lib/viewport';
import { RefreshBar, type RefreshBarProps } from '../refresh-bar';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

/**
 * 手机上页头的说明收成标题旁边的「ⓘ」，点开才看（#1820）：一句说明在 390 宽要占三四行，把第一屏的内容往下挤。
 * 说明没有丢：点「ⓘ」弹出来。
 */
function DescriptionHint({ children }: { children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="这页是做什么的"
          data-description-hint
          className="inline-grid size-10 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <Info className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-sm text-body text-muted-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function Page({
  title,
  description,
  actions,
  refresh,
  tabs,
  width = 'full',
  children,
  className,
  keepDescription,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** 页头右侧的操作按钮。 */
  actions?: ReactNode;
  /** 刷新控件，渲染在页头操作区的固定槽位（最右）。页面传 RefreshBar 的属性，不再自己摆。 */
  refresh?: RefreshBarProps;
  /** 页头下面的一排页签（页内导航）。 */
  tabs?: ReactNode;
  /** full 铺满（默认）；narrow 窄栏（设置、登录这类读文字的页）。 */
  width?: 'full' | 'narrow';
  children: ReactNode;
  className?: string;
  /** 手机上也直接写出说明，不收成「ⓘ」：说明里放的是这页的关键信息（任务页的状态行），不是介绍。 */
  keepDescription?: boolean;
}) {
  const phone = usePhone();
  const fold = phone && Boolean(description) && !keepDescription;
  return (
    <div
      data-page-width={width}
      className={cn(
        'fd-rise mx-auto w-full px-4 pt-5 pb-16 sm:px-6 lg:px-8 lg:pt-6',
        width === 'narrow' ? 'max-w-4xl' : 'max-w-cockpit',
        className,
      )}
    >
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 max-md:mb-4 lg:flex-nowrap">
        <div className="relative min-w-0 lg:flex-1">
          <h1 className={cn('text-title', fold && 'pr-10')}>{title}</h1>
          {fold ? (
            <span className="absolute -top-1.5 right-0">
              <DescriptionHint>{description}</DescriptionHint>
            </span>
          ) : null}
          {description && !fold ? (
            <div className="mt-1 max-w-3xl text-body text-muted-foreground">{description}</div>
          ) : null}
        </div>
        {actions || refresh ? (
          <div className="flex max-w-full flex-wrap items-center gap-2 lg:shrink-0" data-page-actions>
            {actions}
            {refresh ? <RefreshBar {...refresh} /> : null}
          </div>
        ) : null}
      </header>
      {tabs ? <div className="mb-4">{tabs}</div> : null}
      {children}
    </div>
  );
}
