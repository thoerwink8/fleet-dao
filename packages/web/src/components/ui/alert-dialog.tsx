'use client';

import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import type * as React from 'react';
import {
  createContext,
  type MouseEvent,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { cn } from '../../lib/utils';

import { Button } from './button';
import { maskMotion, popMotion, popSurface } from './styles';

// 外观（#3509，照 Arco，样稿 canvas/fd3.css `.mask` `.modal`）：和 dialog.tsx 同一套——mask 遮罩，框宽 480、内边距 24，
// 卡片底、浮层阴影、4 圆角、无描边，标题 16/500 左对齐，按钮靠右；进 200 出 100。

/**
 * 确认框的忙态（#2009，docs/design/驾驶舱界面.md「会发写请求的按钮」）：确定键传 onConfirm（返回 Promise）。
 * 等的时候确定键转圈、别的键标 aria-disabled，Esc、「先不」都关不掉；成功才关；失败留在原处，
 * 页脚上面一行 role=alert 写原因、焦点送过去（Primer），确定键恢复能再点。
 */
interface BusyState {
  /** 正在等的那个确定键（useId）；null＝不忙。 */
  busyId: string | null;
  error: string | null;
  start(id: string): boolean;
  succeed(): void;
  fail(message: string): void;
}

const BusyCtx = createContext<BusyState | null>(null);

function AlertDialog({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  const [inner, setInner] = useState(defaultOpen ?? false);
  const open = openProp ?? inner;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 同一帧里两个确定键都点到（暂停框有两个）：状态还没提交，靠 ref 只放第一个
  const busyRef = useRef<string | null>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInner(next);
      onOpenChange?.(next);
    },
    [openProp, onOpenChange],
  );

  // 每次重新打开都从干净的样子开始（上一次的错误不留）
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const busy: BusyState = {
    busyId,
    error,
    start(id) {
      if (busyRef.current !== null) return false;
      busyRef.current = id;
      setBusyId(id);
      setError(null);
      return true;
    },
    succeed() {
      busyRef.current = null;
      setBusyId(null);
      setOpen(false);
    },
    fail(message) {
      busyRef.current = null;
      setBusyId(null);
      setError(message);
    },
  };

  return (
    <BusyCtx value={busy}>
      <AlertDialogPrimitive.Root
        data-slot="alert-dialog"
        open={open}
        onOpenChange={(next) => {
          // 忙的时候不让关（Esc、「先不」、别的关法都走这里）
          if (!next && busyRef.current !== null) return;
          setOpen(next);
        }}
        {...props}
      />
    </BusyCtx>
  );
}

function AlertDialogTrigger({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(maskMotion, className)}
      {...props}
    />
  );
}

function AlertDialogContent({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  size?: 'default' | 'sm';
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          'group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid w-full max-w-dialog -translate-x-1/2 -translate-y-1/2 gap-4 p-6 data-[size=sm]:max-w-xs data-[size=default]:sm:max-w-120',
          popSurface,
          popMotion,
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        'grid grid-rows-stack place-items-start gap-2 text-left has-data-[slot=alert-dialog-media]:grid-rows-media has-data-[slot=alert-dialog-media]:gap-x-6 sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-stack',
        className,
      )}
      {...props}
    />
  );
}

/** 确定键失败时页脚上面那一行：role=alert，出现时焦点送过来（Primer：失败把焦点送到错误提示）。 */
function AlertDialogError({ message }: { message: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  // 每次失败都是新挂上的一行（再点时 start() 先把错误清掉），挂上时聚焦一次就够
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <p
      ref={ref}
      role="alert"
      tabIndex={-1}
      data-slot="alert-dialog-error"
      // 只是读屏和焦点的落点，不是能点的控件：不画聚焦圈
      className="rounded-sm bg-fail-1 px-4 py-2 text-body text-fail-ink outline-none"
    >
      没成功：{message}
    </p>
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  const busy = useContext(BusyCtx);
  return (
    <>
      {busy?.error ? <AlertDialogError message={busy.error} /> : null}
      <div
        data-slot="alert-dialog-footer"
        className={cn(
          'flex flex-col-reverse gap-2 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end',
          className,
        )}
        {...props}
      />
    </>
  );
}

function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(
        'text-heading text-ink sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-body text-ink-2', className)}
      {...props}
    />
  );
}

function AlertDialogMedia({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "mb-2 inline-flex size-12 items-center justify-center rounded-full bg-fill-2 text-ink-3 sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-6",
        className,
      )}
      {...props}
    />
  );
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 确认框的确定键。两种用法：
 * - 传 onConfirm（会发写请求的都用这个）：点了不马上关，等 Promise——成功关、失败留着写原因，等的时候转圈、关不掉。
 *   onConfirm 里照旧自己弹成功、失败的 toast；失败要把错误抛出来（或返回被拒的 Promise），框才知道没成。
 * - 只传 onClick（不发请求的）：照旧点了就关。
 * loading 由外面给时（同一个写请求另有入口）和框自己的忙态取或。
 */
function AlertDialogAction({
  className,
  variant = 'default',
  size = 'default',
  onConfirm,
  onClick,
  loading,
  loadingLabel,
  loadingText,
  children,
  ...props
}: Omit<React.ComponentProps<typeof AlertDialogPrimitive.Action>, 'asChild'> &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'> & {
    onConfirm?: () => Promise<unknown>;
    loading?: boolean;
    loadingLabel?: string;
    loadingText?: React.ReactNode;
  }) {
  const id = useId();
  const busy = useContext(BusyCtx);
  const managed = onConfirm !== undefined || loading !== undefined;
  const mine = busy?.busyId === id;
  const other = busy?.busyId != null && !mine;

  const handleClick = async (e: MouseEvent<HTMLButtonElement>) => {
    onClick?.(e);
    if (other) {
      e.preventDefault();
      return;
    }
    if (!onConfirm) return;
    e.preventDefault();
    if (!busy) {
      await onConfirm();
      return;
    }
    if (!busy.start(id)) return;
    try {
      await onConfirm();
      busy.succeed();
    } catch (err) {
      busy.fail(errorMessage(err));
    }
  };

  if (!managed) {
    return (
      <Button variant={variant} size={size} asChild>
        <AlertDialogPrimitive.Action
          data-slot="alert-dialog-action"
          className={cn(className)}
          onClick={onClick}
          {...props}
        >
          {children}
        </AlertDialogPrimitive.Action>
      </Button>
    );
  }
  // 不套 AlertDialogPrimitive.Action：它点了就关，而这里要等结果；关由上面的 succeed() 做。
  // Button 带忙态时会在旁边多画一个播报区，也套不进 asChild。
  return (
    <Button
      {...(props as React.ComponentProps<'button'>)}
      type="button"
      data-slot="alert-dialog-action"
      variant={variant}
      size={size}
      className={cn(className)}
      loading={mine || loading === true}
      {...(loadingLabel !== undefined ? { loadingLabel } : {})}
      {...(loadingText !== undefined ? { loadingText } : {})}
      {...(other ? { 'aria-disabled': true } : {})}
      onClick={handleClick}
    >
      {children}
    </Button>
  );
}

function AlertDialogCancel({
  className,
  // 「先不」照 Arco 对话框：灰底次按钮（fd3 `.modal-foot` 里的 `.btn.secondary`）
  variant = 'secondary',
  size = 'default',
  onClick,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  const busy = useContext(BusyCtx);
  const blocked = busy?.busyId != null;
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Cancel
        data-slot="alert-dialog-cancel"
        className={cn(className)}
        {...(blocked ? { 'aria-disabled': true } : {})}
        onClick={(e) => {
          // 确定键在等：「先不」不关（aria-disabled，焦点留着）
          if (blocked) {
            e.preventDefault();
            return;
          }
          onClick?.(e);
        }}
        {...props}
      />
    </Button>
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
