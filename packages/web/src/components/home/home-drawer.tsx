// 主页的画布外壳：画布占满正文，「要你拍的」「做完的」收进右侧抽屉（单 #1801，创始人 2026-10-11 要「空间以画布为主体」）。
//
// 三种摆法，同一份内容：
// - 手机（<768）：列表顶上一条横条（有要你拍的就写件数，点开是底部 Sheet；没有就写「做完的」），画布位置是树形列表。
// - 桌面（768–1919）：画布右上角一个按钮「要你拍的 N | 做完的」，点开浮在画布右侧的 360px 抽屉，不加遮罩，点画布空白处或按 Esc 关。
// - ≥1920：抽屉停靠成右侧一列（不盖画布），可折叠；折叠状态记在 localStorage。
// 有要你拍的（N>0）时按钮用「等你」色，不用红：红留给失败。
import { CheckCheck, ChevronRight, Hand, PanelRightClose } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { brand } from '#brand';
import { useLocalState } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { useDockRoom } from '../../lib/viewport';
import { Empty } from '../page';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui/sheet';
import { DecisionCard } from './decision-card';
import { DoneCard } from './done-card';
import type { HomeDecision, HomeDone } from './types';

const MAX_DECISIONS = 3;
const MAX_DONE = 6;

type Tab = 'decisions' | 'done';

function DrawerBody({
  tab,
  onTab,
  decisions,
  done,
  remote,
  onClose,
}: {
  tab: Tab;
  onTab(tab: Tab): void;
  decisions: readonly HomeDecision[];
  done: readonly HomeDone[];
  remote: boolean;
  onClose?: (() => void) | undefined;
}) {
  const shown = decisions.slice(0, MAX_DECISIONS);
  const more = decisions.length - shown.length;
  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'decisions', label: '要你拍的', count: decisions.length },
    { id: 'done', label: '做完的', count: Math.min(done.length, MAX_DONE) },
  ];
  return (
    <>
      <div className="flex items-center gap-1 border-b px-2 pt-1.5" role="tablist" aria-label="抽屉分页">
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`home-drawer-tab-${t.id}`}
              aria-selected={active}
              aria-controls={`home-drawer-panel-${t.id}`}
              onClick={() => onTab(t.id)}
              className={cn(
                'relative flex h-10 items-center gap-1.5 rounded-t-md px-3 text-sm text-muted-foreground transition-colors hover:text-foreground md:h-9',
                active && 'font-medium text-foreground',
              )}
            >
              {t.label}
              <span
                className={cn(
                  'num rounded-full px-1.5 text-micro leading-4',
                  t.id === 'decisions' && t.count > 0
                    ? 'bg-st-human text-white'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {t.count}
              </span>
              {active ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" /> : null}
            </button>
          );
        })}
        {onClose ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="ml-auto size-10 md:size-8"
            onClick={onClose}
            aria-label="收起抽屉"
          >
            <PanelRightClose />
          </Button>
        ) : null}
      </div>
      <div
        role="tabpanel"
        id={`home-drawer-panel-${tab}`}
        aria-labelledby={`home-drawer-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin"
      >
        {tab === 'decisions' ? (
          <>
            <p className="mb-3 px-1 text-xs text-muted-foreground">
              {remote ? '决定、待批（只读，要去那台上答）。' : '决定、待批。多的去通知中心。'}
            </p>
            {shown.length ? (
              <ul className="grid grid-cols-1 gap-2">
                {shown.map((d) => (
                  <DecisionCard key={`${d.kind}:${d.id}`} decision={d} stacked />
                ))}
              </ul>
            ) : (
              <Empty icon={Hand} title="没有要你拍的" hint="有决定、待批时会出现在这里。" />
            )}
            {more > 0 ? (
              <p className="mt-3 px-1 text-xs text-muted-foreground">
                还有 <span className="num">{more}</span> 条，
                {remote ? (
                  '要去那台上的通知中心看。'
                ) : (
                  <>
                    去
                    <Link to="/notifications" className="underline underline-offset-2">
                      通知中心
                    </Link>
                    看。
                  </>
                )}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="mb-3 px-1 text-xs text-muted-foreground">最近合进去的 PR。</p>
            {done.length ? (
              <ul className="grid grid-cols-1 gap-2">
                {done.slice(0, MAX_DONE).map((d) => (
                  <DoneCard key={d.prNumber} item={d} />
                ))}
              </ul>
            ) : (
              <Empty icon={CheckCheck} title="最近没有合进的 PR" hint="有 PR 合进主线会出现在这里。" />
            )}
          </>
        )}
      </div>
    </>
  );
}

/** 画布右上角的按钮：左半开「要你拍的」，右半开「做完的」。N>0 时左半用等你色。 */
function DrawerButton({ count, open, onOpen }: { count: number; open: boolean; onOpen(tab: Tab): void }) {
  const half =
    'flex h-8 items-center gap-1.5 px-3 text-sm transition-colors hover:bg-accent focus-visible:z-10';
  return (
    <div
      data-drawer-button
      className={cn(
        'absolute top-3 right-3 z-30 flex overflow-hidden rounded-xl border bg-popover/90 shadow-sm backdrop-blur',
        count > 0 && 'border-st-human/50',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`要你拍的 ${count} 条，打开抽屉`}
        onClick={() => onOpen('decisions')}
        className={cn(
          half,
          count > 0
            ? 'bg-st-human/12 font-medium text-ink-human hover:bg-st-human/20'
            : 'text-muted-foreground',
        )}
      >
        <Hand className="size-3.5" aria-hidden />
        要你拍的
        <span
          className={cn(
            'num rounded-full px-1.5 text-micro leading-4',
            count > 0 ? 'bg-st-human text-white' : 'bg-muted text-muted-foreground',
          )}
        >
          {count}
        </span>
      </button>
      <button
        type="button"
        aria-expanded={open}
        aria-label="做完的，打开抽屉"
        onClick={() => onOpen('done')}
        className={cn(half, 'border-l text-muted-foreground')}
      >
        <CheckCheck className="size-3.5" aria-hidden />
        做完的
      </button>
    </div>
  );
}

export function HomeDrawer({
  decisions,
  done,
  remote,
  phone,
  children,
}: {
  decisions: readonly HomeDecision[];
  done: readonly HomeDone[];
  remote: boolean;
  phone: boolean;
  /** 画布（手机上是树形列表）。 */
  children: ReactNode;
}) {
  const docked = useDockRoom();
  const [collapsed, setCollapsed] = useLocalState<boolean>(
    `${brand.storagePrefix}home-drawer-collapsed`,
    false,
  );
  const [floating, setFloating] = useState(false);
  const [tab, setTab] = useState<Tab>(decisions.length > 0 ? 'decisions' : 'done');
  const panelRef = useRef<HTMLElement>(null);

  const open = docked ? !collapsed : floating;
  const setOpen = (next: boolean) => (docked ? setCollapsed(!next) : setFloating(next));
  const openTab = (next: Tab) => {
    // 已经开着、点的又是当前这页：当成收起；点的是另一页：只换页
    if (open && next === tab) setOpen(false);
    else {
      setTab(next);
      setOpen(true);
    }
  };

  // 浮层打开后把焦点带进去，Esc 关
  useEffect(() => {
    if (!phone && !docked && floating) panelRef.current?.focus();
  }, [phone, docked, floating]);

  if (phone) {
    const n = decisions.length;
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden" data-home-body>
        <button
          type="button"
          data-home-strip
          onClick={() => {
            setTab(n > 0 ? 'decisions' : 'done');
            setFloating(true);
          }}
          className={cn(
            'flex min-h-11 shrink-0 items-center gap-2 border-b px-4 text-left text-sm',
            n > 0 ? 'bg-st-human/10 font-medium text-ink-human' : 'text-muted-foreground',
          )}
        >
          {n > 0 ? (
            <Hand className="size-4 shrink-0" aria-hidden />
          ) : (
            <CheckCheck className="size-4 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate">
            {n > 0 ? (
              <>
                <span className="num">{n}</span> 件要你拍的
              </>
            ) : (
              '最近做完的'
            )}
          </span>
          <ChevronRight className="size-4 shrink-0 opacity-60" aria-hidden />
        </button>
        {children}
        <Sheet open={floating} onOpenChange={setFloating}>
          <SheetContent side="bottom" className="max-h-4/5 gap-0 rounded-t-2xl p-0">
            <SheetTitle className="sr-only">要你拍的和做完的</SheetTitle>
            <SheetDescription className="sr-only">要你拍的决定和最近做完的 PR</SheetDescription>
            <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border-strong" aria-hidden />
            <DrawerBody tab={tab} onTab={setTab} decisions={decisions} done={done} remote={remote} />
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  const panelClass = 'flex flex-col bg-panel';
  return (
    <div className="relative flex h-full min-h-0 overflow-hidden" data-home-body>
      {/* 画布：占满正文区剩下的全部宽，没有左列。右端让出抽屉按钮的位置给工具条 */}
      <div
        data-home-canvas-wrap
        className="relative min-w-0 flex-1"
        style={{ '--board-toolbar-end': 'var(--spacing-drawer-button)' } as React.CSSProperties}
        onPointerDownCapture={(event) => {
          // 浮着时点画布（空白或卡片都算）就收；点抽屉按钮本身交给按钮自己切换
          if (docked || !floating) return;
          if (event.target instanceof Element && event.target.closest('[data-drawer-button]')) return;
          setFloating(false);
        }}
      >
        {children}
        <DrawerButton count={decisions.length} open={open} onOpen={openTab} />
      </div>
      {open ? (
        <aside
          ref={panelRef}
          tabIndex={-1}
          aria-label="要你拍的和做完的"
          data-home-drawer={docked ? 'docked' : 'floating'}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !docked) setFloating(false);
          }}
          className={cn(
            panelClass,
            'w-drawer max-w-full shrink-0 border-l outline-none',
            !docked &&
              'absolute inset-y-0 right-0 z-40 bg-popover shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200',
          )}
        >
          <DrawerBody
            tab={tab}
            onTab={setTab}
            decisions={decisions}
            done={done}
            remote={remote}
            onClose={() => setOpen(false)}
          />
        </aside>
      ) : null}
    </div>
  );
}
