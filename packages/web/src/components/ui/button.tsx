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
import { focusRing } from './styles';

/**
 * 按钮（#3509，照 Arco，样稿 canvas/fd3.css `.btn`）：2 圆角、字重 400、悬停只换底色（100ms）。
 * 五种：primary 品牌实色（一页最多一个）、secondary 灰底（最常用）、outline 品牌色描边、text 品牌色字、danger 红。
 * 另留两个旧名：ghost 透明底灰字（图标按钮、行尾「⋯」），link 品牌色字不留内边距。
 * 旧名对到新样子：default、brand → primary；destructive → danger。
 * 尺寸：xs 24、sm 28、md（default）32、lg 36；手机上至少 40 高（手指点得准）。
 * 禁用（disabled 或 aria-disabled 且不在忙）：fill-1 底、ink-3 字、not-allowed 光标；忙态（aria-busy）保留原色、转圈。
 */
const PRIMARY = 'bg-brand text-on-brand hover:bg-brand-hover active:bg-brand-active';
const DANGER =
  'bg-fail-1 text-fail-ink hover:bg-[color-mix(in_srgb,var(--fail)_18%,var(--card))] active:bg-[color-mix(in_srgb,var(--fail)_24%,var(--card))]';
const DISABLED =
  'disabled:cursor-not-allowed disabled:border-transparent disabled:bg-fill-1 disabled:text-ink-3 aria-disabled:not-aria-busy:cursor-not-allowed aria-disabled:not-aria-busy:border-transparent aria-disabled:not-aria-busy:bg-fill-1 aria-disabled:not-aria-busy:text-ink-3';

const buttonVariants = cva(
  `inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-sm border border-transparent text-body font-normal whitespace-nowrap transition-colors duration-100 ease-arco ${focusRing} ${DISABLED} aria-busy:cursor-progress aria-invalid:border-fail [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
  {
    variants: {
      variant: {
        primary: PRIMARY,
        default: PRIMARY,
        brand: PRIMARY,
        secondary: 'bg-fill-2 text-ink-2 hover:bg-fill-3 hover:text-ink',
        outline:
          'border-brand bg-transparent text-brand-ink hover:border-brand-hover hover:text-link-hover active:border-brand-active',
        text: 'bg-transparent text-brand-ink hover:bg-fill-2 hover:text-link-hover',
        danger: DANGER,
        destructive: DANGER,
        ghost: 'bg-transparent text-ink-2 hover:bg-fill-2 hover:text-ink',
        link: 'h-auto! bg-transparent px-0! text-brand-ink underline-offset-4 hover:text-link-hover hover:underline',
      },
      size: {
        md: 'h-control px-4 max-md:min-h-10',
        default: 'h-control px-4 max-md:min-h-10',
        sm: 'h-7 px-3 max-md:min-h-10',
        xs: "h-6 gap-1 px-2 text-meta max-md:min-h-10 [&_svg:not([class*='size-'])]:size-3.5",
        lg: 'h-9 px-5',
        icon: 'size-control max-md:min-h-10 max-md:min-w-10',
        'icon-xs': "size-6 max-md:min-h-10 max-md:min-w-10 [&_svg:not([class*='size-'])]:size-3.5",
        'icon-sm': 'size-7 max-md:min-h-10 max-md:min-w-10',
        'icon-lg': 'size-9',
      },
    },
    compoundVariants: [
      // 文字按钮左右只留 8（fd3 `.btn.text`），不像实底按钮那样留 16。
      { variant: 'text', size: ['md', 'default', 'sm', 'xs'], className: 'px-2' },
    ],
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
