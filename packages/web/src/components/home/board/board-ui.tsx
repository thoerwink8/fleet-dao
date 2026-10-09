// 首页看板的共用小件：三级缩放、选中 / 聚焦的小仓库、画布上下文、悬停意图、单子的操作对象和去处。
// 照初版（PR #13）的 board-ui.tsx 搬回，换成现在的数据（/api/home 的单子）。
import { type ReactFlowState, useStore } from '@xyflow/react';
import { createContext, useContext, useRef, useState, useSyncExternalStore } from 'react';
import { brand } from '#brand';
import type { ActionTarget } from '../../task-actions';
import type { HomeRunning } from '../types';
import type { BoardNodeData } from './model';

/** 三级缩放：远看只剩色块和数字，中景出现文字和状态，近景看到谁在做、等什么、最近一次事件和耗时。 */
export type ZoomLevel = 'far' | 'mid' | 'near';

export const ZOOM_OF: Record<ZoomLevel, number> = { far: 0.4, mid: 0.85, near: 1.5 };

/** 远档卡片标题、编号缩完之后，屏幕上至少这么大（px）。 */
export const FAR_LABEL_MIN_PX = 12;

/**
 * 远档卡片标题、编号的 CSS 字号（px）。
 * 画布按 zoom 缩小整张卡，字号乘缩放的倒数（max(基准, 12) / zoom），屏幕上不小于 12px。
 */
export function farCardFontPx(basePx: number, zoom: number = ZOOM_OF.far): number {
  const z = zoom > 0 ? zoom : ZOOM_OF.far;
  return Math.max(basePx, FAR_LABEL_MIN_PX) / z;
}

/**
 * 远档标题在预设缩放 0.4 下的设计字号，对齐 --text-strong（15px）。
 * 屏幕上的下限对齐 --text-caption（11px）：收进视野时缩放常小于 0.4。
 */
export const FAR_TITLE_DESIGN_PX = 15;
export const FAR_TITLE_FLOOR_PX = 11;

/**
 * 远档标题的 CSS 字号。用字号名，不写死像素。
 * --fd-zoom-far 是远档预设缩放，--fd-board-zoom 是画布当前缩放（画布外壳上写）。
 * 屏幕字号 = max(设计字号 × 当前缩放 / 预设缩放, 11)。
 */
export function farTitleFontSize(): string {
  return 'max(calc(var(--text-strong) / var(--fd-zoom-far, 0.4)), calc(var(--text-caption) / var(--fd-board-zoom, 0.4)))';
}

/** 远档标题换算到屏幕上的像素，用来对验收（不小于 11）。 */
export function farTitleScreenPx(zoom: number): number {
  const z = zoom > 0 ? zoom : ZOOM_OF.far;
  return Math.max((FAR_TITLE_DESIGN_PX * z) / ZOOM_OF.far, FAR_TITLE_FLOOR_PX);
}

export function levelOf(zoom: number): ZoomLevel {
  if (zoom < 0.55) return 'far';
  if (zoom < 1.2) return 'mid';
  return 'near';
}

const levelSelector = (s: ReactFlowState) => levelOf(s.transform[2]);

/** 只在跨过档位时才让节点重画，缩放过程中不逐帧重画。 */
export function useZoomLevel(): ZoomLevel {
  return useStore(levelSelector);
}

/**
 * 选中哪张卡、聚焦哪一支。放在一个小仓库里、每张卡只订阅「我是不是被选中 / 是不是变暗」这两个是非：
 * 点一下只重画前后两张卡，而不是所有卡跟着上下文一起重画。
 */
export interface BoardView {
  get(): { selectedId: string | null; focus: Set<string> | null };
  set(selectedId: string | null, focus: Set<string> | null): void;
  subscribe(cb: () => void): () => void;
}

export function createBoardView(): BoardView {
  let state: { selectedId: string | null; focus: Set<string> | null } = { selectedId: null, focus: null };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(selectedId, focus) {
      if (state.selectedId === selectedId && state.focus === focus) return;
      state = { selectedId, focus };
      for (const l of listeners) l();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** 这张卡是不是选中、是不是被聚焦模式压暗。两个都是是非值，没变就不重画。 */
export function useNodeView(view: BoardView, id: string): { selected: boolean; dimmed: boolean } {
  const selected = useSyncExternalStore(view.subscribe, () => view.get().selectedId === id);
  const dimmed = useSyncExternalStore(view.subscribe, () => {
    const f = view.get().focus;
    return f ? !f.has(id) : false;
  });
  return { selected, dimmed };
}

export interface BoardUi {
  view: BoardView;
  /** 看的是别的环境推来的快照：只读，不画操作，单子链接指向 GitHub。 */
  remote: boolean;
  select(id: string | null): void;
  /** 双击 / O：进单子详情。 */
  open(id: string): void;
  focusOn(id: string): void;
}

export const BoardUiContext = createContext<BoardUi | null>(null);

export function useBoardUi(): BoardUi {
  const ctx = useContext(BoardUiContext);
  if (!ctx) throw new Error('缺少 BoardUiContext');
  return ctx;
}

/** 节点挂着的那张单：单子节点和「要你拍」节点都对着它。 */
export function itemOf(data: BoardNodeData): HomeRunning | undefined {
  return data.kind === 'ticket' || data.kind === 'ask' ? data.item : undefined;
}

/**
 * 单子的操作对象（继续 / 叫停走 task-actions 那一份定义）。
 * 没有 taskId（老环境推来的快照）或看的是远程快照：不给，节点上就不画操作——画出来点了只会报错或改错台。
 * 首页上的单都还开着（/api/home 只给没进终态的）。快照里带了 state 就用它（挂起才画得出「重做」）；
 * 老环境没带 state 时，等你拍的记成 asking，其余记成 running。
 */
export function targetOfItem(item: HomeRunning, remote: boolean): ActionTarget | undefined {
  if (remote || item.taskId === undefined) return undefined;
  return {
    taskId: item.taskId,
    issueNumber: item.issueNumber,
    title: item.title,
    state: item.state ?? (item.waitingReason === 'founder_decision' ? 'asking' : 'running'),
    ...(item.paused === undefined ? {} : { paused: item.paused }),
  };
}

/** 单子在 GitHub 上的链接（看远程快照时用；拼不出来是 undefined）。 */
export function githubIssueLink(item: HomeRunning): string | undefined {
  const cut = item.repo.indexOf('/');
  if (cut <= 0) return undefined;
  return brand.repoLink(
    { owner: item.repo.slice(0, cut), name: item.repo.slice(cut + 1) },
    'issues',
    item.issueNumber,
  );
}

/** 悬停意图：移到浮出的操作条上时不立刻消失。 */
export function useHoverIntent(delay = 140) {
  const [hover, setHover] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bind = {
    onMouseEnter: () => {
      clearTimeout(timer.current);
      setHover(true);
    },
    onMouseLeave: () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setHover(false), delay);
    },
  };
  return { hover, bind };
}
