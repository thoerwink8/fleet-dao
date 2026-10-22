// 展开行（#3533，任务页过程的回合头、笔、步骤用）：一行一个按钮（aria-expanded），点了展开下面的内容；开没开由页面管（受控），
// 因为「有失败的、在跑的自动展开，人点过一次就听人的」这条要页面自己算。
// 和 ListRow 的 expandable 不同：ListRow 自己管开合、明细铺一层灰底；这里下面的内容不加底色、不加框，里面可以放行、可以再放展开行。
// 行首 leading（状态点）、中间 header、行尾 trailing（结局）、箭头在最右；actions 在按钮外面（「看会话」这类自己是按钮的东西不能套进按钮）。
// 不收 className 和 style；data-* 落在最外层。
import { ChevronRight } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId } from 'react';
import { cn } from '../../lib/utils';

type DataAttrs = { [K in `data-${string}`]?: string | number | boolean | undefined };

export function DisclosureRow({
  open,
  onToggle,
  leading,
  header,
  trailing,
  actions,
  controls,
  size = 'regular',
  ...rest
}: {
  open: boolean;
  onToggle: () => void;
  /** 行首：状态点。 */
  leading?: ReactNode;
  /** 主内容（一行或几行小字）。 */
  header: ReactNode;
  /** 箭头前面的东西：结局。 */
  trailing?: ReactNode;
  /** 按钮外面右边的操作。 */
  actions?: ReactNode;
  /** 展开内容的 id（给 aria-controls）。 */
  controls?: string;
  /** compact：步骤这种密一点的行。 */
  size?: 'regular' | 'compact';
} & DataAttrs &
  Omit<ComponentProps<'div'>, 'className' | 'style' | 'children' | 'onToggle'>) {
  return (
    <div
      data-open={open}
      className={cn(
        'flex min-w-0 items-start gap-stack px-section hover:bg-fill-1',
        size === 'compact' ? 'py-1.5' : 'py-2',
      )}
      {...rest}
    >
      <button
        type="button"
        aria-expanded={open}
        {...(controls ? { 'aria-controls': controls } : {})}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-start gap-stack rounded-sm text-left text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand-hover max-md:min-h-11"
      >
        {leading ? <span className="mt-1.5 flex shrink-0 items-center">{leading}</span> : null}
        <div className="min-w-0 flex-1">{header}</div>
        {trailing ? <span className="mt-0.5 shrink-0">{trailing}</span> : null}
        <ChevronRight
          className={cn(
            'mt-1 size-4 shrink-0 text-ink-3 transition-transform duration-200 ease-arco',
            open && 'rotate-90',
          )}
          aria-hidden
        />
      </button>
      {actions ? <span className="flex shrink-0 items-center">{actions}</span> : null}
    </div>
  );
}

/** 展开行加它下面的内容：open 才画内容。内容缩进到和行里的文字对齐。 */
export function Disclosure({
  open,
  onToggle,
  children,
  ...row
}: {
  children?: ReactNode;
} & ComponentProps<typeof DisclosureRow>) {
  const id = useId();
  return (
    <div>
      <DisclosureRow open={open} onToggle={onToggle} controls={id} {...row} />
      {open ? (
        <div id={id} className="pr-section pb-2 pl-section">
          {children}
        </div>
      ) : null}
    </div>
  );
}
