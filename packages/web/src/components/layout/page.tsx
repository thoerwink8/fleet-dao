// 页面外框：页头标题行（标题左、操作和刷新右，同一行垂直居中），下面最多一行说明，长说明收成 ⓘ（#1820、#1897）；所有页同一最大宽。
import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { usePhone } from '../../lib/viewport';
import { RefreshBar, type RefreshBarProps } from '../refresh-bar';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

/**
 * 页头的长说明收成标题旁边的「ⓘ」，点开才看（#1820）：一句长说明在 390 宽要占三四行，把第一屏的内容往下挤。
 * 说明没有丢：点「ⓘ」弹出来。
 */
export function DescriptionHint({
  children,
  label = '这页是做什么的',
}: {
  children: ReactNode;
  /** 按钮的名字，给读屏和悬停提示。 */
  label?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          data-description-hint
          className="inline-grid size-8 shrink-0 place-items-center align-middle max-md:size-10 rounded-full text-muted-foreground hover:text-foreground"
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

/** 说明超过这么多字就不在标题下摊开（桌面一行放不下一整句），收进 ⓘ。 */
export const DESCRIPTION_LINE_MAX = 50;

export function Page({
  title,
  description,
  detail,
  actions,
  refresh,
  tabs,
  breadcrumb,
  children,
  className,
  keepDescription,
  stackActions,
}: {
  title: ReactNode;
  /** 标题下的一行说明。超过 DESCRIPTION_LINE_MAX 个字（字符串时）自动收进 ⓘ。 */
  description?: ReactNode;
  /** 长说明：任何宽度都收进标题旁边的 ⓘ，点开才看。 */
  detail?: ReactNode;
  /** 页头右侧的操作按钮。 */
  actions?: ReactNode;
  /** 刷新控件，渲染在页头标题行右侧的固定槽位（最右）。页面传 RefreshBar 的属性，不再自己摆。 */
  refresh?: RefreshBarProps;
  /** 页头下面的一排页签（页内导航）。 */
  tabs?: ReactNode;
  /** 标题上面一行的面包屑（详情页：任务列表 / 这张单）。 */
  breadcrumb?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 一行说明在手机上、字多时也直接写出，不收成「ⓘ」：说明里放的是这页的关键信息（任务页的状态行），不是介绍。 */
  keepDescription?: boolean;
  /**
   * 手机上操作区改到标题下面、占满这一行（首页 #2969）。
   * 流程开关、状态和刷新并排会挤出屏幕、叠在一起；桌面仍是标题左、操作右。
   */
  stackActions?: boolean;
}) {
  const phone = usePhone();
  const tooLong = typeof description === 'string' && description.length > DESCRIPTION_LINE_MAX;
  const fold = Boolean(description) && !keepDescription && (phone || tooLong);
  const hint =
    fold || detail ? (
      <DescriptionHint>
        {fold ? <p>{description}</p> : null}
        {detail ? <div className={cn(fold && 'mt-2')}>{detail}</div> : null}
      </DescriptionHint>
    ) : null;
  return (
    <div
      data-page-width="full"
      className={cn(
        'fd-rise mx-auto w-full max-w-cockpit px-4 pt-5 pb-16 sm:px-6 lg:px-8 lg:pt-6',
        className,
      )}
    >
      {breadcrumb ? (
        <nav aria-label="位置" data-page-breadcrumb className="mb-2 text-meta text-muted-foreground">
          {breadcrumb}
        </nav>
      ) : null}
      {/* 标题行：标题（后面跟 ⓘ）在左，操作和刷新在右。两边都从顶对齐、各自至少一个控件高并垂直居中，
          所以刷新和标题在同一行上对齐，不会被下面的说明拉低；说明在标题下面，最多一行。
          stackActions（首页）在手机上把操作区放到标题下面，不再跟标题挤一行。 */}
      <header
        className={cn(
          'mb-section-gap flex flex-wrap items-start justify-between gap-x-stack gap-y-2 max-md:mb-4 lg:flex-nowrap',
          // 手机上标题自己一行，操作区在下面占满宽（具体怎么排在 app.css 的 data-actions-layout=stack）
          stackActions && 'max-md:flex-col max-md:items-stretch max-md:gap-3',
        )}
      >
        {/* grow：中间宽度（md）也吃满右边操作剩下的宽，一行说明不被挤成两行（#1914 第 5 轮，768 宽量到折行） */}
        <div
          className={cn(
            'min-w-0 grow basis-52 lg:flex-1',
            stackActions && 'max-md:w-full max-md:grow-0 max-md:basis-auto',
          )}
          data-page-titlebar
        >
          <h1 className="inline align-middle text-title">{title}</h1>
          {hint}
          {description && !fold ? (
            <div className="mt-1 max-w-3xl text-body text-muted-foreground" data-page-description>
              {description}
            </div>
          ) : null}
        </div>
        {actions || refresh ? (
          <div
            className={cn(
              'flex min-h-8 max-w-full flex-wrap items-center gap-2 max-md:min-h-10 lg:shrink-0',
              stackActions && 'max-md:w-full max-md:max-w-full max-md:shrink-0',
            )}
            data-page-actions
            {...(stackActions ? { 'data-actions-layout': 'stack' } : {})}
          >
            {actions}
            {refresh ? <RefreshBar {...refresh} /> : null}
          </div>
        ) : null}
      </header>
      {tabs ? <div className="mb-section">{tabs}</div> : null}
      {children}
    </div>
  );
}
