import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import { Slot } from 'radix-ui';
import type * as React from 'react';
import {
  Children,
  Fragment,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useRef,
} from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-body font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-focus focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        brand: 'bg-brand text-brand-foreground hover:bg-brand/90',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-accent dark:hover:bg-selected',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-control px-4 py-1.5 has-[>svg]:px-3 max-md:min-h-10',
        xs: "h-6 max-md:min-h-10 gap-1 rounded-md px-2 text-meta has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-control max-md:min-h-10 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        lg: 'h-row rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-control max-md:min-h-10 max-md:min-w-10',
        'icon-xs': "size-6 max-md:min-h-10 max-md:min-w-10 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-control max-md:min-h-10 max-md:min-w-10',
        'icon-lg': 'size-row',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

/**
 * 忙态（#2009，docs/design/驾驶舱界面.md「会发写请求的按钮」）。只给真按钮：asChild 时外层不是 button，
 * 拦点击、播报都落不到对的元素上，所以类型上 asChild 和 loading 二选一。
 */
type LoadingProps =
  | {
      asChild?: false;
      /**
       * 正在发写请求。传了（哪怕是 false）就算接上忙态：按钮旁边始终有一个 aria-live 播报区，同一帧的连点也挡。
       * 忙时 aria-busy + aria-disabled（不用原生 disabled，键盘焦点留得住），点击被拦，画转圈。
       */
      loading?: boolean;
      /** 播报区忙时读的字；不传就是「正在<按钮上的字>…」。 */
      loadingLabel?: string;
      /** 忙时按钮上换成的字（转圈在它前面）；不传就保留原字、转圈替掉前面的图标（没图标就盖在字上）。宽度按两份字里宽的那份，不跳。 */
      loadingText?: ReactNode;
    }
  | { asChild: true; loading?: never; loadingLabel?: never; loadingText?: never };

type ButtonProps = React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & LoadingProps;

/** 纯文字的 children 拼起来（播报默认字用）；拼不出返回空串。 */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** 第一个子节点是不是图标：一个没有 children 的组件元素（lucide 图标就是这样）。 */
function leadingIcon(nodes: ReactNode[]): ReactElement<{ className?: string }> | null {
  const first = nodes[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(first)) return null;
  if (typeof first.type === 'string' || first.type === Fragment) return null;
  if (first.props.children !== undefined) return null;
  return first;
}

function Spinner({ className }: { className?: string | undefined }) {
  return <LoaderCircle data-button-spinner aria-hidden className={cn('animate-spin', className)} />;
}

/** 忙时按钮里画什么：宽度一律不跳。 */
function busyContent(children: ReactNode, loadingText: ReactNode): ReactNode {
  const nodes = Children.toArray(children);
  const icon = leadingIcon(nodes);
  if (loadingText !== undefined) {
    // 两份字叠在同一格里，宽度取宽的那份：忙前忙后按钮一样宽
    const rest = icon ? nodes.slice(1) : nodes;
    return (
      <>
        <Spinner className={icon?.props.className} />
        <span className="inline-grid">
          <span className="invisible col-start-1 row-start-1" aria-hidden>
            {rest}
          </span>
          <span className="col-start-1 row-start-1">{loadingText}</span>
        </span>
      </>
    );
  }
  if (icon) {
    // 转圈替掉前面的图标（同一个尺寸类），字照旧
    return (
      <>
        <Spinner key="spinner" className={icon.props.className} />
        {nodes.slice(1)}
      </>
    );
  }
  // 没图标：字留着占位（透明），转圈盖在正中。用 opacity-0 不用 invisible：visibility:hidden 的字不进可访问名，
  // 读屏和 getByRole 就找不到「确认发布」了
  return (
    <span className="inline-grid place-items-center">
      <span className="col-start-1 row-start-1 inline-flex items-center gap-2 opacity-0">{nodes}</span>
      <Spinner className="col-start-1 row-start-1" />
    </span>
  );
}

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  loading,
  loadingLabel,
  loadingText,
  onClick,
  disabled,
  children,
  ...props
}: ButtonProps) {
  // 同一帧里的第二下：状态还没提交到 DOM（loading 还是 false），只靠 loading 挡不住，这里用 ref 再挡一道。
  const inFlight = useRef(false);
  const Comp = asChild ? Slot.Root : 'button';
  const managed = !asChild && loading !== undefined;
  const busy = managed && loading === true;

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (!managed) {
      onClick?.(e);
      return;
    }
    if (busy || inFlight.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    inFlight.current = true;
    const result = (onClick as ((e: MouseEvent<HTMLButtonElement>) => unknown) | undefined)?.(e);
    if (result instanceof Promise) {
      void result.finally(() => {
        inFlight.current = false;
      });
    } else {
      // 处理函数是同步的：下一帧 loading 已经提交（或者根本没进忙态），放开
      setTimeout(() => {
        inFlight.current = false;
      }, 0);
    }
  };

  const button = (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      onClick={handleClick}
      {...(busy
        ? { 'aria-busy': true, 'aria-disabled': true, 'data-loading': '' }
        : disabled !== undefined
          ? { disabled }
          : {})}
      {...props}
    >
      {busy ? busyContent(children, loadingText) : children}
    </Comp>
  );
  if (!managed) return button;
  const label = loadingLabel ?? `正在${textOf(children) || '处理'}…`;
  return (
    <>
      {button}
      {/* 播报区页面加载时就在（Primer：live region 要先于消息存在），忙时才放字；放在按钮外面——按钮的子节点对读屏是展示性的。
          只写 aria-live、不写 role="status"：效果一样（polite、整句读），但不在页面上多出一堆 status 角色，
          页面自己的结果提示（role="status" 的那一行）还是唯一的那个。 */}
      <span aria-live="polite" aria-atomic="true" data-button-status className="sr-only">
        {busy ? label : ''}
      </span>
    </>
  );
}

export type { ButtonProps };
export { Button, buttonVariants };
