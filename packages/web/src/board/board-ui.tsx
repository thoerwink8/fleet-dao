import { type ReactFlowState, useStore } from '@xyflow/react';
import { createContext, useContext, useRef, useState, useSyncExternalStore } from 'react';
import type { BoardSubtask, BoardTask, Me, Routing } from '../api/types';
import { type ActionTarget, targetOf } from '../components/task-actions';
import type { BoardNodeData } from './model';

/** 三级缩放：远看只剩色块和数字，中景出现文字和按钮，近景看到每一步的路由、耗时、状态。 */
export type ZoomLevel = 'far' | 'mid' | 'near';

export const ZOOM_OF: Record<ZoomLevel, number> = { far: 0.4, mid: 0.85, near: 1.5 };

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
 * 点一下只重画前后两张卡，而不是几百张卡跟着上下文一起重画。
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
  routing: Routing | undefined;
  me: Me | undefined;
  select(id: string | null): void;
  /** 双击：进后台对应页。 */
  open(id: string): void;
  focusOn(id: string): void;
}

export const BoardUiContext = createContext<BoardUi | null>(null);

export function useBoardUi(): BoardUi {
  const ctx = useContext(BoardUiContext);
  if (!ctx) throw new Error('缺少 BoardUiContext');
  return ctx;
}

/** 节点对应的操作对象：需求节点对需求，子任务和 PR 节点对子任务。 */
export function nodeTarget(data: BoardNodeData): ActionTarget | undefined {
  switch (data.kind) {
    case 'task':
      return targetOf(data.task);
    case 'sub':
    case 'pr':
      return targetOf(data.task, data.sub);
    default:
      return undefined;
  }
}

/** 双击去哪：需求和子任务去任务详情，仓去总览。 */
export function hrefOf(data: BoardNodeData): string {
  switch (data.kind) {
    case 'task':
      return `/tasks/${data.task.id}`;
    case 'sub':
    case 'pr':
      return `/tasks/${data.task.id}?sub=${data.sub.id}`;
    default:
      return '/overview';
  }
}

export function taskOf(data: BoardNodeData): BoardTask | undefined {
  if (data.kind === 'task' || data.kind === 'sub' || data.kind === 'pr') return data.task;
  return undefined;
}

export function subOf(data: BoardNodeData): BoardSubtask | undefined {
  if (data.kind === 'sub' || data.kind === 'pr') return data.sub;
  return undefined;
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
