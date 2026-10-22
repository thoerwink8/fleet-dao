// 任务页右侧面板（#3277，照 Claude 桌面版右侧面板；#3533 照 Arco 重拼）：「过程」和「看会话」在同一个随开随关的抽屉里，不再常驻右栏。
// - 所有宽度都是盖在右边的抽屉（加遮罩），不占正文的位置；手机从底下整屏盖上来。
// - 开没开、多宽记在浏览器本地（读不到就默认关、默认宽）；`\` 键开关。任务页把「过程」放在页签里，面板里平时是一笔的会话。
// - 面板里可以是过程（TaskProcess inPanel）；点一笔「看会话」把 ?run=<笔号> 压进地址（能分享，后退回到过程），「‹ 过程」退回；K / J 上一笔、下一笔，
//   按整张单起跑先后（runOrder，和过程、汇报同一个「第 N 笔」）切，用替换不压历史。
// - 面板头「弹出到新窗口」开 /tasks/:taskId/runs/:runId 独立页（routes/task-run.tsx），窗口名按笔定，同一笔复用同一个窗口。
// 改这里之前必须知道：直接打开带 ?run= 的链接也要看得到面板（哪怕本地记的是关着）；关面板顺手把 ?run= 去掉，不留一个看不见的参数。
// 页面只拼 components/layout 的件，不写样式（design 第三节）；抽屉本体是 layout/side-panel.tsx。
import { ChevronDown, ChevronLeft, ChevronUp, ExternalLink, X } from 'lucide-react';
import {
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
import { usePhone } from '../lib/viewport';
import { Button } from './layout/button';
import { PanelResizer, SidePanel } from './layout/side-panel';
import { Stack } from './layout/stack';
import { Text } from './layout/text';
import { RunMeta, RunOutcomeBadge, RunTranscript, runTitle } from './run-transcript';
import { processSummaryOf, TaskProcess } from './task-process';

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

function IconButton({
  label,
  onClick,
  disabledReason,
  children,
}: {
  label: string;
  onClick: () => void;
  disabledReason?: string;
  children: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant="text"
      aria-label={label}
      title={label}
      {...(disabledReason ? { disabledReason } : {})}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** 面板头：看过程时「过程 + 那一句」，看一笔时「‹ 过程 / 第 N 笔 · 段」加上一笔、下一笔、弹出、关闭。 */
function PanelHeader({ d, now, panel }: { d: TaskDetail; now: number; panel: TaskPanel }) {
  const phone = usePhone();
  const run = panel.run;
  const list = orderedRuns(d.segmentRuns);
  const order = runOrder(d.segmentRuns);
  const at = run ? list.findIndex((r) => r.id === run.id) : -1;
  const popout = useHref(run ? runPopoutPath(d.task.id, run.id) : '/');
  const close = (
    <IconButton label="关掉面板（\）" onClick={panel.hide}>
      <X aria-hidden />
    </IconButton>
  );
  if (!run) {
    return (
      <Stack direction="horizontal" gap="sm" align="center" justify="between">
        <Stack direction="horizontal" gap="sm" align="baseline">
          <Text size="heading" strong>
            过程
          </Text>
          <Text size="meta" tone="muted" truncate>
            {processSummaryOf(d, now)}
          </Text>
        </Stack>
        {close}
      </Stack>
    );
  }
  return (
    <Stack direction="horizontal" gap="sm" align="center" justify="between">
      <Stack direction="horizontal" gap="sm" align="center">
        <Button size="sm" variant="text" onClick={panel.back} data-panel-back>
          <ChevronLeft aria-hidden />
          过程
        </Button>
        <Text tone="muted">/</Text>
        <span data-panel-run-title>
          <Text strong truncate>
            {runTitle(run, order.get(run.id) ?? at + 1)}
          </Text>
        </span>
      </Stack>
      <Stack direction="horizontal" gap="sm" align="center">
        <IconButton
          label="上一笔（K）"
          {...(at <= 0 ? { disabledReason: '已经是第一笔' } : {})}
          onClick={() => panel.step(-1)}
        >
          <ChevronUp aria-hidden />
        </IconButton>
        <IconButton
          label="下一笔（J）"
          {...(at >= list.length - 1 ? { disabledReason: '已经是最后一笔' } : {})}
          onClick={() => panel.step(1)}
        >
          <ChevronDown aria-hidden />
        </IconButton>
        {phone ? null : (
          <IconButton
            label="弹出到新窗口"
            onClick={() => {
              window.open(popout, runWindowName(run.id));
            }}
          >
            <ExternalLink aria-hidden />
          </IconButton>
        )}
        {close}
      </Stack>
    </Stack>
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

/**
 * 面板本身：盖在右边的抽屉（SidePanel），手机从底下整屏盖上来。不占正文的位置：创始人定的，贴在正文旁边会把
 * 「这一回合走到哪」、汇报挤窄（2026-10-19）。
 */
export function TaskPanelView({ d, now, panel }: { d: TaskDetail; now: number; panel: TaskPanel }) {
  const phone = usePhone();
  const { width, onDown, onKey } = usePanelWidth();
  const run = panel.run;
  return (
    <SidePanel
      open={panel.shown}
      // 开面板不压历史（看会话时 ?run= 已经压过一条，后退回到过程）；点遮罩、Esc 关
      onOpenChange={(o) => {
        if (!o) panel.hide();
      }}
      title="过程"
      description="这张单的过程，点一笔看它的会话"
      phone={phone}
      widthPx={width}
      resizer={<PanelResizer width={width} label="拉宽过程面板" onPointerDown={onDown} onKeyDown={onKey} />}
      view={run ? 'run' : 'process'}
      scroll={!run}
      header={<PanelHeader d={d} now={now} panel={panel} />}
      subheader={
        run ? (
          // 结局放在这一行开头：头一行留给第几笔和四个按钮，面板窄时标题不被挤掉
          <>
            <RunOutcomeBadge run={run} />
            <RunMeta run={run} now={now} />
          </>
        ) : undefined
      }
      data-task-panel="sheet"
    >
      {run ? (
        <RunTranscript taskId={d.task.id} run={run} />
      ) : (
        <div data-panel-process>
          <TaskProcess d={d} now={now} onViewTranscript={panel.openRun} inPanel />
        </div>
      )}
    </SidePanel>
  );
}
