// 路由页上调先后和开关（母单 #1089，#1333，#1366 第二部分）：拖到目标位置、每行「置顶」「置底」、聚焦后 Alt+上下键改先后；
// 每条路由、每个模型、每个渠道各有开关。
// 改这里之前必须知道：
// - 开关点之前二次确认（和设置页「让 AI 接活」同一个做法），确认了才写后端。改先后不弹窗：鼠标放下、点置顶 / 置底、按 Alt+方向键，就保存。
// - 写的时候带「我看到的」：别人先改了后端回 409，这里把原话弹出来。不先改缓存冒充改成了：写完重拉，失败把预览清掉，顺序回到库里的。
// - 模型开关是把这个模型下每条路由的 enabled 一次写成同一个值（没有单独的 models.enabled）。打开会把原来单独关掉的也打开。
// - Fable 只有创始人本人在驾驶舱能打开（决定 0033）：判在后端（founder-only.ts 的 guardFounderOnly），这里不绕、不替它判，
//   只在开关旁标一句；后端拒了，原话弹出来。
// - 选了远程环境（?node=）时整块置灰：写只会落到本台的库。写「去那台上操作」。
// - 长列表（超过 50 行）只画窗口里的行；拖到容器上下沿时容器自己滚（lib/list-window.ts）。窗口化的行是定高的，行高由调用方给定。

import { founderOnlyFor } from '@fleet-dao/shared';
import {
  createContext,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import {
  errorText,
  useMovePurposeModel,
  useSetChannelEnabled,
  useSetModelEnabled,
  useUpdateModelRoute,
} from '../api/client';
import {
  autoScrollDelta,
  dropOrder,
  moveToEdge,
  sameOrder,
  stepOrder,
  WINDOW_MIN_ROWS,
  windowRange,
} from '../lib/list-window';
import { useSelectedNodeId } from '../lib/node';
import { ConfirmDialog } from './layout/confirm-dialog';
import { DragHandle } from './layout/drag-handle';
import { RowMenuItem } from './layout/row-menu';
import { Switch } from './layout/switch';
import { Tag } from './layout/tag';
import { RowItem, WindowBox, WindowList } from './layout/windowed';
import { useSelectedNodeName } from './node-notice';

interface Ask {
  title: string;
  description: string;
  /** 确认键上的字。 */
  verb: string;
  /** 成功后弹的一句。 */
  done: string;
  run: () => Promise<unknown>;
}

interface RoutingEdit {
  /** 不能改的原因（远程环境的快照）；null = 能改。 */
  disabledWhy: string | null;
  /** 有一笔先后或开关还在写。 */
  busy: boolean;
  /** 用途下的模型拖到新先后。order 是放下后的顺序，expected 是放下前页面上的。 */
  reorderModels(args: {
    purpose: string;
    movedId: string;
    order: string[];
    expected: string[];
  }): Promise<void>;
  /** 模型下的路由拖到新先后。先后不分用途。 */
  reorderRoutes(args: {
    modelId: string;
    movedId: string;
    order: string[];
    expected: string[];
  }): Promise<void>;
  /** 模型开 / 关。enabled 是此刻页面上的：有一条路由开着就算开。expectedEnabled 是此刻开着的路由编号。 */
  toggleModel(args: {
    modelId: string;
    modelName: string;
    enabled: boolean;
    expectedEnabled: string[];
  }): void;
  /** 渠道开 / 关。enabled 是此刻目录里的 channels.enabled。 */
  toggleChannel(args: { channelId: string; channelName: string; enabled: boolean }): void;
  /** 一条路由开 / 关。enabled 是此刻页面上画着的开关。 */
  toggleRoute(args: {
    modelId: string;
    modelName: string;
    routeId: string;
    routeName: string;
    enabled: boolean;
  }): void;
}

const RoutingEditContext = createContext<RoutingEdit | null>(null);

/** 改先后成功。同一编号，连点时新的顶掉旧的，屏幕上只留一条。 */
export const REORDER_SAVED_TOAST_ID = 'routing-reorder-saved';
/** 没改成。同一编号，连点时新的顶掉旧的，不和上一条叠在一起。 */
export const REORDER_FAILED_TOAST_ID = 'routing-reorder-failed';

function toastReordered(): void {
  toast.success('已改先后', { id: REORDER_SAVED_TOAST_ID });
}

function toastReorderFailed(e: unknown): void {
  toast.error('没改成', { id: REORDER_FAILED_TOAST_ID, description: errorText(e) });
}

export function useRoutingEdit(): RoutingEdit {
  const ctx = useContext(RoutingEditContext);
  if (!ctx) throw new Error('useRoutingEdit 要放在 RoutingEditProvider 里面');
  return ctx;
}

export function RoutingEditProvider({ children }: { children: ReactNode }) {
  const nodeId = useSelectedNodeId();
  const nodeName = useSelectedNodeName();
  const moveModelMutation = useMovePurposeModel();
  const updateRouteMutation = useUpdateModelRoute();
  const setModelMutation = useSetModelEnabled();
  const setChannelMutation = useSetChannelEnabled();
  const [asking, setAsking] = useState<Ask | null>(null);

  const disabledWhy =
    nodeId !== null ? `现在看的是${nodeName ?? nodeId}，这一页的先后和开关只能改本台的：去那台上操作` : null;

  const ask = useCallback((a: Ask) => setAsking(a), []);

  const edit = useMemo<RoutingEdit>(
    () => ({
      disabledWhy,
      busy:
        moveModelMutation.isPending ||
        updateRouteMutation.isPending ||
        setModelMutation.isPending ||
        setChannelMutation.isPending,
      reorderModels: async ({ purpose, movedId, order, expected }) => {
        try {
          await moveModelMutation.mutateAsync({ purpose, modelId: movedId, body: { order, expected } });
          toastReordered();
        } catch (e) {
          toastReorderFailed(e);
          throw e;
        }
      },
      reorderRoutes: async ({ modelId, movedId, order, expected }) => {
        try {
          await updateRouteMutation.mutateAsync({
            modelId,
            routeId: movedId,
            body: { op: 'reorder', order, expected },
          });
          toastReordered();
        } catch (e) {
          toastReorderFailed(e);
          throw e;
        }
      },
      toggleModel: ({ modelId, modelName, enabled, expectedEnabled }) => {
        const verb = enabled ? '关闭' : '开启';
        ask({
          title: `${verb}模型「${modelName}」？`,
          description: enabled
            ? '关闭后这个模型在所有用途里都不派：下面每条路由的开关一起关掉。并记一条操作记录。'
            : '开启后这个模型下面每条路由都打开，所有用途都能再派（还要探得通、额度够、没被禁令挡）。原来单独关掉的也会一起打开。并记一条操作记录。',
          verb,
          done: `已${verb}：${modelName}`,
          run: () =>
            setModelMutation.mutateAsync({
              modelId,
              body: { enabled: !enabled, expectedEnabled },
            }),
        });
      },
      toggleChannel: ({ channelId, channelName, enabled }) => {
        const verb = enabled ? '关闭' : '开启';
        ask({
          title: `${verb}渠道「${channelName}」？`,
          description: enabled
            ? '关闭后这个渠道下面所有路由都不派。原来每条路由的开关先不动，渠道重新打开后还是原来的开关。并记一条操作记录。'
            : '开启后这个渠道下面的路由按各自的开关派。并记一条操作记录。',
          verb,
          done: `已${verb}：${channelName}`,
          run: () =>
            setChannelMutation.mutateAsync({
              channelId,
              body: { enabled: !enabled, expected: enabled },
            }),
        });
      },
      toggleRoute: ({ modelId, modelName, routeId, routeName, enabled }) => {
        const verb = enabled ? '关闭' : '开启';
        ask({
          title: `${verb} ${modelName} 下的「${routeName}」？`,
          description: enabled
            ? '关闭后选路不再派这条渠道（照样挂在顺序里，随时能再开），哪个用途都一样。并记一条操作记录。'
            : '开启后选路又会派这条渠道（先要它探得通、额度够、没被禁令挡），哪个用途都一样。并记一条操作记录。',
          verb,
          done: `已${verb}：${routeName}`,
          run: () =>
            updateRouteMutation.mutateAsync({
              modelId,
              routeId,
              body: { op: 'enable', enabled: !enabled, expected: enabled },
            }),
        });
      },
    }),
    [ask, disabledWhy, moveModelMutation, setChannelMutation, setModelMutation, updateRouteMutation],
  );

  /** 确认键：成功关框并弹成功；失败打 toast、把错误抛回给框（框里写原因、留在原处，#2012）。 */
  const confirm = async () => {
    if (!asking) return;
    try {
      await asking.run();
      toast.success(asking.done);
      setAsking(null);
    } catch (e) {
      toastReorderFailed(e);
      throw e;
    }
  };

  return (
    <RoutingEditContext value={edit}>
      {children}
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title={asking?.title ?? ''}
        description={asking?.description}
        confirmText={asking?.verb}
        onConfirm={confirm}
      />
    </RoutingEditContext>
  );
}

const HANDLE_TITLE = '拖到新位置；键盘：Alt+上下键挪一格，Alt+Home 置顶，Alt+End 置底';

/** 一行的先后操作：拖动柄（桌面，键盘 Alt+方向键也在它上面）和「⋯」菜单里的挪动项。调用方决定摆在行里哪儿。 */
export interface RowControls {
  grip: ReactNode;
  /** 上移、下移、置顶、置底：画进行尾「⋯」菜单（RowMoveItems），点了走和拖动同一条保存路径。 */
  moves: RowMoves;
}

/** 一行能做的挪动：菜单项照它画、点了走和拖动同一条保存路径。 */
export interface RowMoves {
  /** 这一行的名字（带「里的先后」），菜单按钮的无障碍名字用。 */
  label: string;
  /** 不能挪的原因（远程环境）；null = 能挪。 */
  why: string | null;
  /** 正在保存、别的写还在进行：先后暂时点不动。 */
  off: boolean;
  atTop: boolean;
  atBottom: boolean;
  move: (to: 'up' | 'down' | 'top' | 'bottom') => void;
}

/** 行尾「⋯」的悬停提示。 */
export const ROW_MENU_TITLE = '上移、下移、置顶、置底和更多操作';

/**
 * 「⋯」菜单里的四个挪动项（#1806 起手机这样，路由页样板 #1914 起桌面也这样）：行里不再并排四个箭头。
 * 置灰的项悬停写原因：到头了、远程环境、正在保存。键盘照旧：聚焦拖动柄按 Alt+方向键。
 */
export function RowMoveItems({ moves }: { moves: RowMoves }) {
  const reason = (edge: string | null) => moves.why ?? (moves.off ? '正在保存，稍等' : edge) ?? undefined;
  const moveItems: { key: 'up' | 'down' | 'top' | 'bottom'; label: string; edge: string | null }[] = [
    { key: 'up', label: '上移一位', edge: moves.atTop ? '已经在最前' : null },
    { key: 'down', label: '下移一位', edge: moves.atBottom ? '已经在最后' : null },
    { key: 'top', label: '置顶', edge: moves.atTop ? '已经在最前' : null },
    { key: 'bottom', label: '置底', edge: moves.atBottom ? '已经在最后' : null },
  ];
  return (
    <>
      {moveItems.map((m) => {
        const why = reason(m.edge);
        return (
          <RowMenuItem
            key={m.key}
            disabled={why !== undefined}
            title={why}
            onSelect={() => moves.move(m.key)}
          >
            {m.label}
          </RowMenuItem>
        );
      })}
    </>
  );
}

/**
 * 窗口化的定高滚动容器：height 是可视高度，rowHeight 是每行高度，行数超过 50 才真的只画窗口里的。
 * height 给 'fill' = 填满父元素的高度（父元素要有确定的高度），可视高度由浏览器量出来；量不到先按 FILL_FALLBACK_HEIGHT 算。
 */
export interface SortViewport {
  height: number | 'fill';
  rowHeight: number;
}

const FILL_FALLBACK_HEIGHT = 560;

/**
 * 一列可拖动的行。鼠标拖动只标落点，放下才交给 onSave；置顶 / 置底按钮、Alt+方向键直接交给 onSave。
 * 保存失败由 onSave 抛出来，这里把预览清掉，顺序回到 items。
 * 给了 viewport 就是定高滚动容器：拖到上下沿时容器自己滚，超过 50 行只画窗口里的行（正在拖的那行始终留着）。
 */
export function SortableList<T>({
  ariaLabel,
  items,
  itemId,
  itemLabel,
  disabled,
  disabledWhy,
  isSelected,
  rowProps,
  viewport,
  busy = false,
  onSave,
  children,
}: {
  ariaLabel: string;
  items: readonly T[];
  itemId: (item: T) => string;
  itemLabel: (item: T) => string;
  disabled: boolean;
  /** 不能拖的原因；能拖时手柄上写键盘怎么用。 */
  disabledWhy: string | null;
  /** 选中的行（换底色）。 */
  isSelected?: (item: T) => boolean;
  rowProps?: (item: T) => Record<string, string | undefined>;
  viewport?: SortViewport;
  /** 别的写还在进行（开关）：先后暂时点不动，但手柄不置灰，焦点不丢。 */
  busy?: boolean;
  onSave: (order: string[], expected: string[], movedId: string) => Promise<unknown>;
  children: (item: T, index: number, controls: RowControls) => ReactNode;
}) {
  const ids = items.map(itemId);
  const idKey = ids.join('\n');
  const [preview, setPreview] = useState<string[] | null>(null);
  const [drop, setDrop] = useState<{ id: string; edge: 'before' | 'after' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [measured, setMeasured] = useState<number | null>(null);
  const fill = viewport?.height === 'fill';
  const dragId = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pointerY = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const off = disabled || saving || busy;

  useEffect(() => {
    if (preview && sameOrder(preview, idKey.split('\n'))) setPreview(null);
  }, [preview, idKey]);

  // 拖动中容器每帧按指针离上下沿的远近滚一点；放下、拖动结束、组件卸载都停
  const track = useCallback((e: globalThis.DragEvent) => {
    pointerY.current = e.clientY;
  }, []);
  const stopScroll = useCallback(() => {
    document.removeEventListener('dragover', track);
    pointerY.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  }, [track]);
  const tick = useCallback(() => {
    const el = box.current;
    const y = pointerY.current;
    if (el && y !== null) {
      const rect = el.getBoundingClientRect();
      const step = autoScrollDelta(y, rect.top, rect.bottom);
      if (step !== 0) {
        el.scrollTop += step;
        setScrollTop(el.scrollTop);
      }
    }
    frame.current = requestAnimationFrame(tick);
  }, []);
  const startScroll = useCallback(() => {
    if (!box.current || frame.current !== null) return;
    // 指针拖出容器（上沿以上、下沿以下）也要继续算，所以挂在整个文档上
    document.addEventListener('dragover', track);
    frame.current = requestAnimationFrame(tick);
  }, [tick, track]);
  useEffect(() => stopScroll, [stopScroll]);

  // fill：容器填满父元素，窗口化要的可视高度从它自己量
  useEffect(() => {
    const el = box.current;
    if (!fill || !el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => setMeasured(el.clientHeight));
    watch.observe(el);
    setMeasured(el.clientHeight);
    return () => watch.disconnect();
  }, [fill]);

  const shownIds = preview ?? ids;
  const byId = new Map(items.map((item) => [itemId(item), item]));
  const shown = shownIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });

  const save = async (order: string[], movedId: string) => {
    const expected = items.map(itemId);
    if (sameOrder(order, expected)) {
      setPreview(null);
      return;
    }
    setPreview(order);
    setSaving(true);
    try {
      await onSave(order, expected, movedId);
    } catch {
      setPreview(null);
    } finally {
      setSaving(false);
    }
  };

  /** 置顶 / 置底按钮、Alt+方向键共用：Alt+上下挪一格，Alt+Home / End 置顶 / 置底。 */
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
    e.stopPropagation();
    if (off || !e.altKey) return;
    const current = preview ?? ids;
    let next: string[] | null;
    if (e.key === 'ArrowUp') next = stepOrder(current, id, -1);
    else if (e.key === 'ArrowDown') next = stepOrder(current, id, 1);
    else if (e.key === 'Home') next = moveToEdge(current, id, 'top');
    else if (e.key === 'End') next = moveToEdge(current, id, 'bottom');
    else return;
    e.preventDefault();
    if (next) void save(next, id);
  };

  const endDrag = () => {
    dragId.current = null;
    setDragging(null);
    setDrop(null);
    stopScroll();
  };

  const onDragStart = (e: DragEvent<HTMLButtonElement>, id: string) => {
    e.stopPropagation();
    if (off) {
      e.preventDefault();
      return;
    }
    dragId.current = id;
    setDragging(id);
    setPreview(null);
    setDrop(null);
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    startScroll();
  };

  const onDragOver = (e: DragEvent<HTMLElement>, id: string) => {
    if (!dragId.current || off) return;
    e.preventDefault();
    pointerY.current = e.clientY;
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const edge = e.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
    setDrop((prev) => (prev?.id === id && prev.edge === edge ? prev : { id, edge }));
  };

  const onDrop = (e: DragEvent<HTMLLIElement>, id: string) => {
    const from = dragId.current;
    if (!from || off) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const edge = e.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
    endDrag();
    void save(dropOrder(ids, from, id, edge), from);
  };

  const controlsFor = (item: T): RowControls => {
    const id = itemId(item);
    const at = shownIds.indexOf(id);
    const label = itemLabel(item);
    const pin = (edge: 'top' | 'bottom') => {
      if (off) return;
      const next = moveToEdge(shownIds, id, edge);
      if (next) void save(next, id);
    };
    const step = (delta: -1 | 1) => {
      if (off) return;
      const next = stepOrder(shownIds, id, delta);
      if (next) void save(next, id);
    };
    const atTop = at === 0;
    const atBottom = at === shownIds.length - 1;
    return {
      moves: {
        label,
        why: disabledWhy,
        off: saving || busy,
        atTop,
        atBottom,
        move: (to) => {
          if (to === 'up') step(-1);
          else if (to === 'down') step(1);
          else pin(to);
        },
      },
      // 桌面才拖（手机用「⋯」菜单挪）；鼠标设备上悬停这一行才露出，键盘聚焦时也露出
      grip: (
        <DragHandle
          label={`拖动 ${label}`}
          title={disabledWhy ?? (saving ? '正在保存' : HANDLE_TITLE)}
          draggable={!off}
          disabled={disabled}
          busy={saving || busy}
          onDragStart={(e) => onDragStart(e, id)}
          onDragEnd={endDrag}
          onKeyDown={(e) => onKeyDown(e, id)}
        />
      ),
    };
  };

  const rowEl = (item: T, index: number, style?: { top: number; height: number }) => {
    const id = itemId(item);
    const edge = drop?.id === id ? drop.edge : undefined;
    return (
      <RowItem
        key={id}
        attrs={rowProps?.(item) ?? {}}
        selected={isSelected?.(item) ?? false}
        edge={edge}
        {...(style ? { top: style.top, height: style.height } : {})}
        {...(viewport ? { posinset: index + 1, setsize: shown.length } : {})}
        onDragOver={(e) => onDragOver(e, id)}
        onDrop={(e) => onDrop(e, id)}
      >
        {children(item, index, controlsFor(item))}
      </RowItem>
    );
  };

  if (!viewport) {
    return (
      <WindowList as="ol" ariaLabel={ariaLabel} pending={preview !== null}>
        {shown.map((item, index) => rowEl(item, index))}
      </WindowList>
    );
  }

  const { rowHeight } = viewport;
  const height = viewport.height === 'fill' ? (measured ?? FILL_FALLBACK_HEIGHT) : viewport.height;
  const total = shown.length * rowHeight;
  const range = windowRange({ count: shown.length, rowHeight, height, scrollTop });
  const draggedAt = dragging === null ? -1 : shownIds.indexOf(dragging);
  const rendered: number[] = [];
  for (let i = range.start; i < range.end; i++) rendered.push(i);
  // 正在拖的行滚出窗口也不卸载：卸了浏览器收不到拖动结束
  if (draggedAt >= 0 && (draggedAt < range.start || draggedAt >= range.end)) rendered.push(draggedAt);
  return (
    <WindowBox
      boxRef={box}
      attrs={{ 'data-sortable-box': '' }}
      windowed={shown.length > WINDOW_MIN_ROWS}
      fill={fill}
      height={Math.min(height, total)}
      onScrollTop={setScrollTop}
    >
      <WindowList as="ol" ariaLabel={ariaLabel} pending={preview !== null} total={total}>
        {rendered.flatMap((i) => {
          const item = shown[i];
          return item === undefined ? [] : [rowEl(item, i, { top: i * rowHeight, height: rowHeight })];
        })}
      </WindowList>
    </WindowBox>
  );
}

/** Fable 这类「只有创始人本人在驾驶舱能打开」的模型，开关旁标一句（判在后端，这里只提示，不拦也不绕）。 */
export function FounderOnlyBadge({
  modelId,
  family,
  displayName,
}: {
  modelId: string;
  family?: string | undefined;
  displayName: string;
}) {
  const rule = founderOnlyFor({ id: modelId, family: family ?? '', displayName });
  if (!rule) return null;
  return (
    <span title={rule.reason} className="inline-flex shrink-0">
      <Tag>仅创始人可开</Tag>
    </span>
  );
}

/** 一条路由的开关。lockedWhy 有字时置灰（渠道已关不走这里，调用方直接不画开关）。 */
export function RouteSwitch({
  label,
  enabled,
  lockedWhy,
  onToggle,
}: {
  label: string;
  enabled: boolean;
  lockedWhy?: string | null;
  onToggle: () => void;
}) {
  const { disabledWhy } = useRoutingEdit();
  const why = disabledWhy ?? lockedWhy ?? null;
  return (
    <Switch
      size="sm"
      checked={enabled}
      disabled={why !== null}
      title={why ?? (enabled ? '关掉这条路由' : '打开这条路由')}
      aria-label={`${label} 的开关`}
      onCheckedChange={onToggle}
    />
  );
}

/** 模型级开关：开着 = 下面至少一条路由开着。一条路由都没有（或读不到开关状态）时置灰，title 写原因。 */
export function ModelSwitch({
  modelId,
  modelName,
  enabled,
  expectedEnabled,
  unavailable,
}: {
  modelId: string;
  modelName: string;
  enabled: boolean;
  expectedEnabled: string[];
  /** 不能开关的原因。 */
  unavailable?: string | boolean;
}) {
  const edit = useRoutingEdit();
  const why =
    edit.disabledWhy ??
    (typeof unavailable === 'string' ? unavailable : unavailable ? '这个模型下一条路由都没有' : null);
  return (
    <Switch
      size="sm"
      checked={enabled}
      disabled={why !== null}
      title={why ?? (enabled ? '关掉这个模型（所有用途都不派）' : '打开这个模型')}
      aria-label={`${modelName} 的开关`}
      onCheckedChange={() => edit.toggleModel({ modelId, modelName, enabled, expectedEnabled })}
    />
  );
}

/** 渠道级开关：写 channels.enabled，不是目录里「下架」那种探针状态。 */
export function ChannelSwitch({
  channelId,
  name,
  enabled,
}: {
  channelId: string;
  name: string;
  enabled: boolean;
}) {
  const edit = useRoutingEdit();
  return (
    <Switch
      size="sm"
      checked={enabled}
      disabled={edit.disabledWhy !== null}
      title={edit.disabledWhy ?? (enabled ? '关掉这个渠道' : '打开这个渠道')}
      aria-label={`${name} 的开关`}
      onCheckedChange={() => edit.toggleChannel({ channelId, channelName: name, enabled })}
    />
  );
}
