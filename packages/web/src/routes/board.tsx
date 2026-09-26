import { FolderGit2, TriangleAlert } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router';
import { brand } from '#brand';
import { errorText, useBoard, useMe, useRouting } from '../api/client';
import { BoardTree } from '../board/board-tree';
import { Empty, LoadError } from '../components/page';
import { useRepo } from '../components/repo-context';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { formatAgo } from '../lib/format';
import { useIsMobile, useNow } from '../lib/hooks';

// 画布（React Flow + ELK）按需加载：手机上只用树形列表，不必下载它。
const BoardCanvas = lazy(() => import('../board/board-canvas').then((m) => ({ default: m.BoardCanvas })));

export function meta() {
  return [{ title: brand.title('看板') }];
}

function BoardSkeleton() {
  return (
    <div className="grid h-full place-items-center" aria-busy>
      <div className="flex gap-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 w-64 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/** 首屏：当前仓的全局任务树。桌面是可拖动缩放的画布，手机上退化成可折叠的树形列表。 */
export default function BoardPage() {
  const { repoId, loading, error } = useRepo();
  const board = useBoard(repoId);
  const { data: me } = useMe();
  const isMobile = useIsMobile();
  // 画布上每个节点要写路由：和看板同时拉，别等画布（按需加载）挂上了才拉，那样又多等一轮。手机上的树形列表用不到
  useRouting({ enabled: !isMobile });
  const [params, setParams] = useSearchParams();

  // 一次都没读成才整块换成报错。读成过、之后重拉失败：保留上次的画面（视角也不动），上面压一条提示。
  if (!board.data && (error || board.error)) {
    return (
      <div className="p-6">
        <LoadError what={error ? '仓列表' : '看板'} error={error ?? board.error} />
      </div>
    );
  }
  if (!loading && !repoId) {
    return (
      <div className="p-6">
        <Empty
          icon={FolderGit2}
          title="还没有仓"
          hint="装好 GitHub App、把仓加进来之后，这里会出现它的任务树。"
        />
      </div>
    );
  }
  if (!board.data) return <BoardSkeleton />;

  const stale = board.error ? (
    <StaleBanner error={board.error} asOf={board.data.asOf} onRetry={() => void board.refetch()} />
  ) : null;

  if (isMobile) {
    return (
      <>
        {stale ? <div className="sticky top-0 z-20 p-2">{stale}</div> : null}
        <BoardTree
          board={board.data}
          me={me}
          filter={{ stuck: params.get('stuck') === '1', mine: params.get('mine') === '1' }}
          onFilter={(f) => {
            const p = new URLSearchParams(params);
            if (f.stuck) p.set('stuck', '1');
            else p.delete('stuck');
            if (f.mine) p.set('mine', '1');
            else p.delete('mine');
            setParams(p, { replace: true });
          }}
        />
      </>
    );
  }
  return (
    <div className="relative h-full">
      <Suspense fallback={<BoardSkeleton />}>
        <BoardCanvas board={board.data} me={me} />
      </Suspense>
      {stale ? (
        <div className="pointer-events-none absolute inset-x-0 top-16 z-20 flex justify-center px-3">
          <div className="pointer-events-auto">{stale}</div>
        </div>
      ) : null}
    </div>
  );
}

/** 重拉失败：画面照旧（是上次读到的），写明是几点的、为什么没刷新，给一个重试。 */
function StaleBanner({ error, asOf, onRetry }: { error: unknown; asOf: string; onRetry(): void }) {
  const now = useNow();
  return (
    <div
      role="alert"
      className="flex max-w-xl items-center gap-2 rounded-lg border border-st-fail/40 bg-popover px-3 py-2 text-xs shadow-lg"
    >
      <TriangleAlert className="size-3.5 shrink-0 text-ink-fail" aria-hidden />
      <span className="min-w-0">
        <span className="font-medium text-ink-fail">看板刷新没成</span>
        <span className="text-muted-foreground">
          ：{errorText(error)}。下面是 <span className="num">{formatAgo(asOf, now)}</span>读到的画面。
        </span>
      </span>
      <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}
