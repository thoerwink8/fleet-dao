// 任务页右侧面板（#3277，照 Claude 桌面版右侧面板）：「过程」和「看会话」在同一个随开随关的抽屉里，不再常驻右栏。
// - 所有宽度都是盖在右边的抽屉（加遮罩），不占正文的位置；手机从底下整屏盖上来。
// - 开没开、多宽记在浏览器本地（读不到就默认关、默认宽）；页头「过程」按钮和 `\` 键开关。
// - 面板里先是过程；点一笔「看会话」把 ?run=<笔号> 压进地址（能分享，后退回到过程），「‹ 过程」退回；K / J 上一笔、下一笔，
//   按整张单起跑先后（runOrder，和过程、汇报同一个「第 N 笔」）切，用替换不压历史。
// - 面板头「弹出到新窗口」开 /tasks/:taskId/runs/:runId 独立页（routes/task-run.tsx），窗口名按笔定，同一笔复用同一个窗口。
// 改这里之前必须知道：直接打开带 ?run= 的链接也要看得到面板（哪怕本地记的是关着）；关面板顺手把 ?run= 去掉，不留一个看不见的参数。
import { ChevronDown, ChevronLeft, ChevronUp, ExternalLink, ListTree, PanelRight, X } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
} from 'react';
import { useHref, useNavigate, useSearchParams } from 'react-router';
import { brand } from '#brand';
import type { TaskDetail } from '../api/types';
import { useLocalState } from '../lib/hooks';
import type { SegmentRunView } from '../lib/segments';
import { runOrder } from '../lib/task-process';
import { cn } from '../lib/utils';
import { usePhone } from '../lib/viewport';
import { Section } from './layout/section';
import { RunMeta, RunOutcomeBadge, RunTranscript, runTitle } from './run-transcript';
import { processSummaryOf, TaskProcess } from './task-process';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './ui/sheet';

/** 网址里看的是哪一笔的会话。 */
export const RUN_PARAM = 'run';
export const PANEL_OPEN_KEY = `${brand.storagePrefix}task-panel-open`;
export const PANEL_WIDTH_KEY = `${brand.storagePrefix}task-panel-width`;
/** 面板宽：默认 560、最窄 400（像素，根字号不放大），最宽不超过屏宽六成；左右键一下 40。 */
const PANEL_DEFAULT_PX = 560;
const PANEL_MIN_PX = 400;
const PANEL_MAX_RATIO = 0.6;
const PANEL_STEP_PX = 40;

/** 整张单的笔按起跑先后排好（K / J 切换、弹出窗口左边的列表都按这个先后）。 */
export function orderedRuns(runs: readonly SegmentRunView[]): SegmentRunView[] {
  const order = runOrder(runs);
  return [...runs].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export function runPopoutPath(taskId: string, runId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`;
}

/** 弹出窗口的名字：同一笔再点弹出复用那个窗口，不再开新的。 */
export function runWindowName(runId: string): string {
  return `${brand.storagePrefix}run-${runId}`;
}

export interface TaskPanel {
  /** 面板现在看不看得到。 */
  shown: boolean;
  /** 面板里正看着的那一笔；没有是在看过程。 */
  run: SegmentRunView | undefined;
  toggle(): void;
  show(): void;
  hide(): void;
  /** 「看会话」：压一条 ?run=，后退回到过程。 */
  openRun(runId: string): void;
  /** 「‹ 过程」：本页自己压的就后退一步，直接打开的链接只去掉参数。 */
  back(): void;
  /** 上一笔（-1）、下一笔（+1）：替换地址，不压历史。到头了不动。 */
  step(delta: -1 | 1): void;
}

/** runs：这张单的笔（详情还没读到时给空的，面板跟着关）。网址里的笔号对不上任何一笔就当没有。 */
export function useTaskPanel(runs: readonly SegmentRunView[]): TaskPanel {
  const [open, setOpen] = useLocalState<boolean>(PANEL_OPEN_KEY, false);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const pushed = useRef(false);
  const runId = params.get(RUN_PARAM);
  const run = runId ? runs.find((r) => r.id === runId) : undefined;
  const setRun = (id: string | null, replace: boolean) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id === null) next.delete(RUN_PARAM);
        else next.set(RUN_PARAM, id);
        return next;
      },
      { replace },
    );
  const shown = runs.length > 0 && (open || run !== undefined);
  const hide = () => {
    setOpen(false);
    if (runId !== null) {
      pushed.current = false;
      setRun(null, true);
    }
  };
  return {
    shown,
    run,
    toggle: () => (shown ? hide() : setOpen(true)),
    show: () => setOpen(true),
    hide,
    openRun: (id) => {
      setOpen(true);
      pushed.current = true;
      setRun(id, false);
    },
    back: () => {
      setOpen(true);
      if (pushed.current) {
        pushed.current = false;
        void navigate(-1);
        return;
      }
      setRun(null, true);
    },
    step: (delta) => {
      if (!run) return;
      const list = orderedRuns(runs);
      const next = list[list.findIndex((r) => r.id === run.id) + delta];
      if (next) setRun(next.id, true);
    },
  };
}

/** 打字的地方不抢键：输入框、文本框、下拉、可编辑区里按 \ J K 照常打字。 */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/** `\` 开关面板；看着一笔会话时 K 上一笔、J 下一笔。带 Ctrl / ⌘ / Alt 的不管（留给浏览器和命令面板）。 */
export function usePanelKeys(panel: TaskPanel): void {
  const latest = useRef(panel);
  latest.current = panel;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const p = latest.current;
      if (e.key === '\\') p.toggle();
      else if (p.shown && p.run && (e.key === 'k' || e.key === 'K')) p.step(-1);
      else if (p.shown && p.run && (e.key === 'j' || e.key === 'J')) p.step(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** 页头「过程」按钮：开关面板，按下态跟着面板。 */
export function PanelToggle({ panel }: { panel: TaskPanel }) {
  return (
    <Button
      type="button"
      size="sm"
      variant={panel.shown ? 'secondary' : 'outline'}
      aria-pressed={panel.shown}
      aria-keyshortcuts="\"
      title="过程面板（\）"
      onClick={panel.toggle}
      data-panel-toggle
    >
      <PanelRight aria-hidden />
      过程
    </Button>
  );
}

/** 面板关着时正文末尾一行：「过程 · N 个回合 · M 笔 · 用时 …」，有在跑的再写第几笔在跑；点开面板。 */
export function PanelLauncher({ d, now, panel }: { d: TaskDetail; now: number; panel: TaskPanel }) {
  if (panel.shown || !d.segmentRuns.length) return null;
  const order = runOrder(d.segmentRuns);
  const running = d.segmentRuns.filter((r) => r.running).at(-1);
  // 和「用量和模型」收起时同一个样子：一张卡一行，整行可点
  return (
    <Section flush aria-label="过程">
      <button
        type="button"
        onClick={panel.show}
        data-panel-launcher
        className="flex min-h-11 w-full min-w-0 items-center gap-3 px-4 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
      >
        <ListTree className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 font-semibold">过程</span>
        <span className="min-w-0 truncate text-meta text-muted-foreground">
          {processSummaryOf(d, now)}
          {running ? ` · 第 ${order.get(running.id) ?? '?'} 笔在跑` : ''}
        </span>
        <ChevronLeft className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
    </Section>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** 面板里的东西：头（过程或「‹ 过程 / 第 N 笔 · 段」）加内容（过程或这一笔的会话）。贴边和 Sheet 共用。 */
function PanelBody({ d, now, panel }: { d: TaskDetail; now: number; panel: TaskPanel }) {
  const phone = usePhone();
  const run = panel.run;
  const list = orderedRuns(d.segmentRuns);
  const order = runOrder(d.segmentRuns);
  const at = run ? list.findIndex((r) => r.id === run.id) : -1;
  const popout = useHref(run ? runPopoutPath(d.task.id, run.id) : '/');
  const close = (
    <IconButton label="关掉面板（\）" onClick={panel.hide}>
      <X />
    </IconButton>
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-panel-view={run ? 'run' : 'process'}>
      <header className="flex shrink-0 items-center gap-2 border-b py-2 pr-2 pl-4">
        {run ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="-ml-2 shrink-0 px-2"
              onClick={panel.back}
              data-panel-back
            >
              <ChevronLeft aria-hidden />
              过程
            </Button>
            <span aria-hidden className="text-muted-foreground">
              /
            </span>
            <h2 className="num min-w-0 truncate text-body font-medium" data-panel-run-title>
              {runTitle(run, order.get(run.id) ?? at + 1)}
            </h2>
            <div className="ml-auto flex shrink-0 items-center">
              <IconButton label="上一笔（K）" disabled={at <= 0} onClick={() => panel.step(-1)}>
                <ChevronUp />
              </IconButton>
              <IconButton label="下一笔（J）" disabled={at >= list.length - 1} onClick={() => panel.step(1)}>
                <ChevronDown />
              </IconButton>
              {phone ? null : (
                <IconButton
                  label="弹出到新窗口"
                  onClick={() => {
                    window.open(popout, runWindowName(run.id));
                  }}
                >
                  <ExternalLink />
                </IconButton>
              )}
              {close}
            </div>
          </>
        ) : (
          <>
            <h2 className="shrink-0 text-heading">过程</h2>
            <span className="min-w-0 truncate text-meta text-muted-foreground">
              {processSummaryOf(d, now)}
            </span>
            <div className="ml-auto shrink-0">{close}</div>
          </>
        )}
      </header>
      {run ? (
        <>
          {/* 结局放在这一行开头：头一行留给第几笔和四个按钮，面板窄时标题不被挤掉 */}
          <div className="flex shrink-0 items-start gap-2 border-b px-4 py-2">
            <RunOutcomeBadge run={run} />
            <RunMeta run={run} now={now} />
          </div>
          <RunTranscript taskId={d.task.id} run={run} />
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin" data-panel-process>
          <TaskProcess d={d} now={now} onViewTranscript={panel.openRun} inPanel />
        </div>
      )}
    </div>
  );
}

/** 面板宽度：记在本地，拖左边沿或左右键调，夹在最窄和屏宽六成之间。 */
function usePanelWidth(): {
  width: number;
  onDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onKey: (e: KeyboardEvent<HTMLDivElement>) => void;
} {
  const [stored, setStored] = useLocalState<number | null>(PANEL_WIDTH_KEY, null);
  const minPx = PANEL_MIN_PX;
  const clamp = (w: number) =>
    Math.round(Math.min(Math.max(minPx, window.innerWidth * PANEL_MAX_RATIO), Math.max(minPx, w)));
  const width = clamp(typeof stored === 'number' ? stored : PANEL_DEFAULT_PX);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // 面板贴右边：宽度 = 面板右边沿 - 指针
    const right = e.currentTarget.parentElement?.getBoundingClientRect().right ?? window.innerWidth;
    const move = (ev: PointerEvent) => setStored(clamp(right - ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setStored(clamp(width + PANEL_STEP_PX));
    else if (e.key === 'ArrowRight') setStored(clamp(width - PANEL_STEP_PX));
    else return;
    e.preventDefault();
  };
  return { width, onDown, onKey };
}

/** 左边沿的拉宽条（window splitter）。 */
function Resizer({
  width,
  onDown,
  onKey,
}: {
  width: number;
  onDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onKey: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: 可聚焦、可拖动的分隔条（window splitter），<hr> 不能带键盘和拖动
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="拉宽过程面板"
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onDown}
      onKeyDown={onKey}
      data-panel-resizer
      className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-border-strong focus-visible:bg-ring focus-visible:outline-none"
    />
  );
}

/**
 * 面板本身：盖在右边的抽屉（Sheet），手机从底下整屏盖上来。不占正文的位置：创始人定的，贴在正文旁边会把
 * 「这一回合走到哪」、汇报挤窄（2026-10-19）。
 */
export function TaskPanelView({ d, now, panel }: { d: TaskDetail; now: number; panel: TaskPanel }) {
  const phone = usePhone();
  const { width, onDown, onKey } = usePanelWidth();
  const style = { '--task-panel-w': `${width}px` } as CSSProperties;
  return (
    <Sheet
      open={panel.shown}
      // 开面板不压历史（看会话时 ?run= 已经压过一条，后退回到过程）；点遮罩、Esc 关
      historyEntry={false}
      onOpenChange={(o) => {
        if (!o) panel.hide();
      }}
    >
      <SheetContent
        side={phone ? 'bottom' : 'right'}
        showCloseButton={false}
        style={style}
        className={cn(
          'gap-0 p-0',
          phone ? 'h-dvh max-h-dvh w-full' : 'w-[min(var(--task-panel-w),90vw)] sm:max-w-none',
        )}
        data-task-panel="sheet"
      >
        <SheetTitle className="sr-only">过程</SheetTitle>
        <SheetDescription className="sr-only">这张单的过程，点一笔看它的会话</SheetDescription>
        {phone ? null : <Resizer width={width} onDown={onDown} onKey={onKey} />}
        <PanelBody d={d} now={now} panel={panel} />
      </SheetContent>
    </Sheet>
  );
}
