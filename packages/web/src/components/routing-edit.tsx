// 路由页上调先后和开关（母单 #1089 第二片）：每个用途下的模型、每个模型下的渠道各有「上移 / 下移」，渠道有开关。
// 改这里之前必须知道：
// - 点之前一律二次确认（和设置页「让 AI 接活」同一个做法）：弹窗里写清「从什么顺序变成什么顺序」，确认了才写后端。
// - 写的时候带「我看到的」顺序（点的那一刻页面上画着的）：别人先改了后端回 409，这里把原话（让刷新后再改）弹出来，库里不动。
//   不先改缓存冒充改成了：写完不管成败都重拉路由两层（client.tsx 的 useMovePurposeModel / useUpdateModelRoute），页面按库里现在的顺序重排。
// - 选了远程环境（?node=，本机 WSL 的快照）时整块置灰：这页的写只会落到本台的库，不能顶着别的环境的名字去改；写「去那台上操作」。

import { ArrowDown, ArrowUp } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useMovePurposeModel, useUpdateModelRoute } from '../api/client';
import type { MoveDirection } from '../api/types';
import { useSelectedNodeId } from '../lib/node';
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

/** 一串里的一项：编号和给人看的名字。 */
export interface OrderItem {
  id: string;
  name: string;
}

interface RoutingEdit {
  /** 不能改的原因（远程环境的快照）；null = 能改。 */
  disabledWhy: string | null;
  /** 用途下的模型上移 / 下移（点了先确认）。items 是此刻页面上画着的先后。 */
  moveModel(args: {
    purpose: string;
    purposeName: string;
    items: OrderItem[];
    index: number;
    direction: MoveDirection;
  }): void;
  /** 模型下的渠道上移 / 下移（点了先确认）。 */
  moveRoute(args: {
    modelId: string;
    modelName: string;
    items: OrderItem[];
    index: number;
    direction: MoveDirection;
  }): void;
  /** 渠道开 / 关（点了先确认）；enabled 是此刻页面上画着的开关。 */
  toggleRoute(args: { modelId: string; modelName: string; item: OrderItem; enabled: boolean }): void;
}

const RoutingEditContext = createContext<RoutingEdit | null>(null);

export function useRoutingEdit(): RoutingEdit {
  const ctx = useContext(RoutingEditContext);
  if (!ctx) throw new Error('useRoutingEdit 要放在 RoutingEditProvider 里面');
  return ctx;
}

const dirWord = (d: MoveDirection) => (d === 'up' ? '上移' : '下移');

function swapped(items: readonly OrderItem[], index: number, direction: MoveDirection): OrderItem[] {
  const next = [...items];
  const other = direction === 'up' ? index - 1 : index + 1;
  const a = next[index];
  const b = next[other];
  if (a && b) {
    next[index] = b;
    next[other] = a;
  }
  return next;
}

const names = (items: readonly OrderItem[]) => items.map((i) => i.name).join(' → ');

export function RoutingEditProvider({ children }: { children: ReactNode }) {
  const nodeId = useSelectedNodeId();
  const nodeName = useSelectedNodeName();
  const moveModelMutation = useMovePurposeModel();
  const updateRouteMutation = useUpdateModelRoute();
  const [asking, setAsking] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);

  const disabledWhy =
    nodeId !== null ? `现在看的是${nodeName ?? nodeId}，这一页的先后和开关只能改本台的：去那台上操作` : null;

  const ask = useCallback((a: Ask) => setAsking(a), []);

  const edit = useMemo<RoutingEdit>(
    () => ({
      disabledWhy,
      moveModel: ({ purpose, purposeName, items, index, direction }) => {
        const item = items[index];
        if (!item) return;
        const next = swapped(items, index, direction);
        ask({
          title: `把「${item.name}」在「${purposeName}」里${dirWord(direction)}一位？`,
          description: `${purposeName} 的模型顺序会从「${names(items)}」变成「${names(next)}」。改完下一次选路就照新的，并记一条操作记录。`,
          verb: dirWord(direction),
          done: `已${dirWord(direction)}：${item.name}`,
          run: () =>
            moveModelMutation.mutateAsync({
              purpose,
              modelId: item.id,
              body: { direction, expected: items.map((i) => i.id) },
            }),
        });
      },
      moveRoute: ({ modelId, modelName, items, index, direction }) => {
        const item = items[index];
        if (!item) return;
        const next = swapped(items, index, direction);
        ask({
          title: `把「${item.name}」在 ${modelName} 下${dirWord(direction)}一位？`,
          description: `${modelName} 的渠道顺序会从「${names(items)}」变成「${names(next)}」。渠道先后不分用途：哪个用途排了 ${modelName}，都照这个顺序。改完下一次选路就照新的，并记一条操作记录。`,
          verb: dirWord(direction),
          done: `已${dirWord(direction)}：${item.name}`,
          run: () =>
            updateRouteMutation.mutateAsync({
              modelId,
              routeId: item.id,
              body: { op: 'move', direction, expected: items.map((i) => i.id) },
            }),
        });
      },
      toggleRoute: ({ modelId, modelName, item, enabled }) => {
        const verb = enabled ? '关闭' : '开启';
        ask({
          title: `${verb} ${modelName} 下的「${item.name}」？`,
          description: enabled
            ? '关闭后选路不再派这条渠道（照样挂在顺序里，随时能再开），哪个用途都一样。并记一条操作记录。'
            : '开启后选路又会派这条渠道（先要它探得通、额度够、没被禁令挡），哪个用途都一样。并记一条操作记录。',
          verb,
          done: `已${verb}：${item.name}`,
          run: () =>
            updateRouteMutation.mutateAsync({
              modelId,
              routeId: item.id,
              body: { op: 'enable', enabled: !enabled, expected: enabled },
            }),
        });
      },
    }),
    [ask, disabledWhy, moveModelMutation, updateRouteMutation],
  );

  const confirm = async () => {
    if (!asking) return;
    setBusy(true);
    try {
      await asking.run();
      toast.success(asking.done);
    } catch (e) {
      // 409（别人刚改过）、422（已经在头尾）、503（没写进库）：后端的原话照弹，页面已经按库里现在的顺序重拉
      toast.error('没改成', { description: errorText(e) });
    } finally {
      setBusy(false);
      setAsking(null);
    }
  };

  return (
    <RoutingEditContext value={edit}>
      {children}
      <AlertDialog open={asking !== null} onOpenChange={(open) => !open && !busy && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{asking?.title}</AlertDialogTitle>
            <AlertDialogDescription>{asking?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>先不</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
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

/** 一行右边的「上移 / 下移」：已经在头 / 尾的那个键置灰；不能改（远程快照）时两个都置灰。 */
export function MoveButtons({
  label,
  canUp,
  canDown,
  onMove,
}: {
  /** 这一行叫什么（读屏和提示用）。 */
  label: string;
  canUp: boolean;
  canDown: boolean;
  onMove: (direction: MoveDirection) => void;
}) {
  const { disabledWhy } = useRoutingEdit();
  const off = disabledWhy !== null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={off || !canUp}
        title={disabledWhy ?? (canUp ? '上移一位' : '已经在最上面')}
        aria-label={`把 ${label} 上移`}
        onClick={() => onMove('up')}
      >
        <ArrowUp aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={off || !canDown}
        title={disabledWhy ?? (canDown ? '下移一位' : '已经在最下面')}
        aria-label={`把 ${label} 下移`}
        onClick={() => onMove('down')}
      >
        <ArrowDown aria-hidden />
      </Button>
    </span>
  );
}

/** 渠道的开关：开着还是关着画在开关上；不能改时置灰。 */
export function RouteSwitch({
  label,
  enabled,
  onToggle,
}: {
  label: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  const { disabledWhy } = useRoutingEdit();
  return (
    <Switch
      size="sm"
      checked={enabled}
      disabled={disabledWhy !== null}
      title={disabledWhy ?? (enabled ? '关掉这条渠道' : '打开这条渠道')}
      aria-label={`${label} 的开关`}
      // 受控：点了只弹确认，真的改了由重拉的数据带回来
      onCheckedChange={onToggle}
    />
  );
}
