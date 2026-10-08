// 路由页上调先后和开关（母单 #1089，#1333）：拖到目标位置改先后；每条路由、每个模型、每个渠道各有开关。
// 改这里之前必须知道：
// - 开关点之前二次确认（和设置页「让 AI 接活」同一个做法），确认了才写后端。拖动不弹窗：鼠标放下、或键盘回车，才保存。
// - 写的时候带「我看到的」：别人先改了后端回 409，这里把原话弹出来。不先改缓存冒充改成了：写完重拉，失败把预览清掉，顺序回到库里的。
// - 模型开关是把这个模型下每条路由的 enabled 一次写成同一个值（没有单独的 models.enabled）。打开会把原来单独关掉的也打开。
// - 选了远程环境（?node=）时整块置灰：写只会落到本台的库。写「去那台上操作」。

import { GripVertical } from 'lucide-react';
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
import { useSelectedNodeId } from '../lib/node';
import { cn } from '../lib/utils';
import { useSelectedNodeName } from './node-notice';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Button } from './ui/button';
import { Switch } from './ui/switch';

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

export function useRoutingEdit(): RoutingEdit {
  const ctx = useContext(RoutingEditContext);
  if (!ctx) throw new Error('useRoutingEdit 要放在 RoutingEditProvider 里面');
  return ctx;
}

const sameOrder = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export function RoutingEditProvider({ children }: { children: ReactNode }) {
  const nodeId = useSelectedNodeId();
  const nodeName = useSelectedNodeName();
  const moveModelMutation = useMovePurposeModel();
  const updateRouteMutation = useUpdateModelRoute();
  const setModelMutation = useSetModelEnabled();
  const setChannelMutation = useSetChannelEnabled();
  const [asking, setAsking] = useState<Ask | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);

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
          toast.success('已改先后');
        } catch (e) {
          toast.error('没改成', { description: errorText(e) });
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
          toast.success('已改先后');
        } catch (e) {
          toast.error('没改成', { description: errorText(e) });
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

  const confirm = async () => {
    if (!asking) return;
    setDialogBusy(true);
    try {
      await asking.run();
      toast.success(asking.done);
    } catch (e) {
      toast.error('没改成', { description: errorText(e) });
    } finally {
      setDialogBusy(false);
      setAsking(null);
    }
  };

  return (
    <RoutingEditContext value={edit}>
      {children}
      <AlertDialog open={asking !== null} onOpenChange={(open) => !open && !dialogBusy && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{asking?.title}</AlertDialogTitle>
            <AlertDialogDescription>{asking?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dialogBusy}>先不</AlertDialogCancel>
            <AlertDialogAction
              disabled={dialogBusy}
              onClick={(e) => {
                e.preventDefault();
                void confirm();
              }}
            >
              {asking?.verb}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </RoutingEditContext>
  );
}

const HANDLE_TITLE = '拖到新位置；键盘：方向键挪，回车确认，Esc 取消';

function stepOrder(ids: readonly string[], movedId: string, delta: -1 | 1): string[] | null {
  const from = ids.indexOf(movedId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  const swap = next[to];
  if (swap === undefined) return null;
  next[to] = movedId;
  next[from] = swap;
  return next;
}

function dropOrder(
  ids: readonly string[],
  movedId: string,
  targetId: string,
  edge: 'before' | 'after',
): string[] {
  if (movedId === targetId) return [...ids];
  const rest = ids.filter((id) => id !== movedId);
  const at = rest.indexOf(targetId);
  if (at < 0) return [...ids];
  const next = [...rest];
  next.splice(edge === 'before' ? at : at + 1, 0, movedId);
  return next;
}

function dropEdge(e: { clientY: number; currentTarget: EventTarget | null }): 'before' | 'after' {
  const el = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  const rect = el?.getBoundingClientRect();
  const mid = (rect?.top ?? 0) + (rect?.height ?? 0) / 2;
  return e.clientY > mid ? 'after' : 'before';
}

/**
 * 一列可拖动的行。鼠标拖动时只标落点，放下才交给 onSave；键盘是方向键先改预览（data-pending），回车才保存。
 * 保存失败由 onSave 抛出来，这里把预览清掉，顺序回到 items。
 */
export function SortableList<T>({
  ariaLabel,
  items,
  itemId,
  itemLabel,
  disabled,
  disabledWhy,
  className,
  rowClassName,
  rowProps,
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
  className?: string;
  rowClassName?: (item: T) => string | undefined;
  rowProps?: (item: T) => Record<string, string | undefined>;
  onSave: (order: string[], expected: string[], movedId: string) => Promise<unknown>;
  children: (item: T, index: number, handle: ReactNode) => ReactNode;
}) {
  const ids = items.map(itemId);
  const idKey = ids.join('\n');
  const [preview, setPreview] = useState<string[] | null>(null);
  const [drop, setDrop] = useState<{ id: string; edge: 'before' | 'after' } | null>(null);
  const [saving, setSaving] = useState(false);
  const dragId = useRef<string | null>(null);
  const off = disabled || saving;

  useEffect(() => {
    if (preview && sameOrder(preview, idKey.split('\n'))) setPreview(null);
  }, [preview, idKey]);

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

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
    e.stopPropagation();
    if (off) return;
    const current = preview ?? ids;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = stepOrder(current, id, e.key === 'ArrowUp' ? -1 : 1);
      if (next) setPreview(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (preview && !sameOrder(preview, ids)) void save(preview, id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setPreview(null);
      setDrop(null);
    }
  };

  const onDragStart = (e: DragEvent<HTMLButtonElement>, id: string) => {
    e.stopPropagation();
    if (off) {
      e.preventDefault();
      return;
    }
    dragId.current = id;
    setPreview(null);
    setDrop(null);
    e.dataTransfer?.setData('text/plain', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (e: DragEvent<HTMLLIElement>, id: string) => {
    if (!dragId.current || off) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const edge = dropEdge(e);
    setDrop((prev) => (prev?.id === id && prev.edge === edge ? prev : { id, edge }));
  };

  const onDrop = (e: DragEvent<HTMLLIElement>, id: string) => {
    const from = dragId.current;
    if (!from || off) return;
    e.preventDefault();
    e.stopPropagation();
    dragId.current = null;
    const edge = dropEdge(e);
    setDrop(null);
    void save(dropOrder(ids, from, id, edge), from);
  };

  return (
    <ol aria-label={ariaLabel} data-pending={preview ? 'true' : undefined} className={className}>
      {shown.map((item, index) => {
        const id = itemId(item);
        const edge = drop?.id === id ? drop.edge : undefined;
        const handle = (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            draggable={!off}
            disabled={off}
            title={disabledWhy ?? (saving ? '正在保存' : HANDLE_TITLE)}
            aria-label={`拖动 ${itemLabel(item)}`}
            onDragStart={(e) => onDragStart(e, id)}
            onDragEnd={() => {
              dragId.current = null;
              setDrop(null);
            }}
            onKeyDown={(e) => onKeyDown(e, id)}
          >
            <GripVertical aria-hidden />
          </Button>
        );
        return (
          <li
            key={id}
            {...(rowProps?.(item) ?? {})}
            data-drop={edge}
            className={cn(
              rowClassName?.(item),
              edge === 'before' && 'border-t-2 border-t-foreground',
              edge === 'after' && 'border-b-2 border-b-foreground',
            )}
            onDragOver={(e) => onDragOver(e, id)}
            onDrop={(e) => onDrop(e, id)}
          >
            {children(item, index, handle)}
          </li>
        );
      })}
    </ol>
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

/** 模型级开关：开着 = 下面至少一条路由开着。一条路由都没有时置灰。 */
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
  unavailable?: boolean;
}) {
  const edit = useRoutingEdit();
  const why = edit.disabledWhy ?? (unavailable ? '这个模型下一条路由都没有' : null);
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
