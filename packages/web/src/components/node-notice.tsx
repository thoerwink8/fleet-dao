// 看板多机：选了远程环境（?node=）时页面上要说清的几句话。
// - 能看远程快照的只有主页和法国页（REMOTE_PAGES）；其余页的数据全是本台的，整页换成一句明说，不顶着远程环境的名字显示本台的数据。
// - 看快照的页面顶上一条「<名字> <时间> 报的，只读」；失联、没收到过的换成醒目的一句，不拿旧数据当现在的。
import { CloudOff, Eye, ServerCog } from 'lucide-react';
import { createContext, type ReactNode, useContext } from 'react';
import { useMe, useNodes } from '../api/client';
import { formatDateTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { freshnessNow, nodeAgeText, useNodeSelection } from '../lib/node';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

/**
 * 选了远程环境时还能看的页：主页（那个环境的快照）和法国页（各台并排）。
 * /env 是法国页的旧地址，要留在这里：选了远程时外壳才会把这一页渲染出来，重定向才走得成。
 */
export const REMOTE_PAGES: readonly string[] = ['/', '/france', '/env'];

export const isRemotePage = (pathname: string): boolean => REMOTE_PAGES.includes(pathname);

/**
 * 主页的卡片在「看远程环境的快照」时读它：只读、单子链接改成 GitHub 链接、写按钮置灰并说明去那台上操作。
 * 没有（null）就是看本台，卡片照常。
 */
export interface RemoteView {
  /** 给人看的环境名（例如「本机 WSL」）。 */
  name: string;
}
const RemoteViewContext = createContext<RemoteView | null>(null);
export const RemoteViewProvider = ({
  value,
  children,
}: {
  value: RemoteView | null;
  children: ReactNode;
}) => <RemoteViewContext value={value}>{children}</RemoteViewContext>;
export const useRemoteView = (): RemoteView | null => useContext(RemoteViewContext);

/** 选中的远程环境这一刻的名字（列表没读到就用编号）。 */
export function useSelectedNodeName(): string | null {
  const { nodeId } = useNodeSelection();
  const nodes = useNodes();
  if (nodeId === null) return null;
  return nodes.data?.nodes.find((n) => n.id === nodeId)?.name ?? nodeId;
}

/** 其余页选了远程环境时的整页说明：这一页只看得到本台，给一个切回本台的按钮。 */
export function OnlyLocalNotice() {
  const { data: me } = useMe();
  const { select } = useNodeSelection();
  const nodeName = useSelectedNodeName();
  const local = me?.env.name ?? '本台';
  return (
    <div
      data-only-local
      className="mx-auto grid min-h-64 max-w-xl place-items-center px-6 py-16 text-center"
      role="status"
    >
      <div className="flex flex-col items-center gap-3">
        <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <ServerCog className="size-5" aria-hidden />
        </span>
        <p className="text-base font-semibold">这一页只看得到{local}的数据</p>
        <p className="text-sm text-muted-foreground">
          现在选的是{nodeName}。额度、路由、定时任务、设置、操作记录、任务详情这些页面读的是{local}自己的库，
          {nodeName}的请去那台上看；能看{nodeName}的只有主页和法国页。
        </p>
        <Button size="sm" onClick={() => select(null)}>
          切回{local}
        </Button>
      </div>
    </div>
  );
}

/** 看远程快照的页面顶上那一条：哪个环境、什么时候报的、只读；失联或没收到过的换成醒目的一句。 */
export function SnapshotBanner({
  name,
  receivedAt,
  reportedAt,
}: {
  name: string;
  receivedAt?: string | undefined;
  reportedAt?: string | undefined;
}) {
  const now = useNow();
  const f = freshnessNow({ receivedAt }, now);
  return (
    <div
      data-snapshot-banner={f}
      role="status"
      className={cn(
        'mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm',
        f === 'fresh'
          ? 'bg-muted/40 text-muted-foreground'
          : 'border-st-stall/50 bg-st-stall/6 text-ink-stall',
      )}
    >
      {f === 'fresh' ? (
        <Eye className="size-4 shrink-0" aria-hidden />
      ) : (
        <CloudOff className="size-4 shrink-0" aria-hidden />
      )}
      <span className="font-medium">
        {name} {receivedAt ? formatDateTime(receivedAt) : ''} 报的，只读
      </span>
      <span className="num">{nodeAgeText({ receivedAt }, now)}</span>
      {f !== 'fresh' ? (
        <span>下面是它最后一次报的样子，不是现在的；要看现在的请去{name}那台上看。</span>
      ) : (
        <span>数据是它自己推来的快照，这里的按钮都不能用；要操作请去{name}那台上做。</span>
      )}
      {reportedAt && f === 'fresh' ? (
        <span className="text-caption text-faint">它的钟 {formatDateTime(reportedAt)}</span>
      ) : null}
    </div>
  );
}
