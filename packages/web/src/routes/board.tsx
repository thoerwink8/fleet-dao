import { FolderGit2 } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router';
import { useBoard, useMe } from '../api/client';
import { BoardTree } from '../board/board-tree';
import { Empty, LoadError } from '../components/page';
import { useRepo } from '../components/repo-context';
import { Skeleton } from '../components/ui/skeleton';
import { useIsMobile } from '../lib/hooks';

// 画布（React Flow + ELK）按需加载：手机上只用树形列表，不必下载它。
const BoardCanvas = lazy(() => import('../board/board-canvas').then((m) => ({ default: m.BoardCanvas })));

export function meta() {
  return [{ title: '看板 · fleet-dao 驾驶舱' }];
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
  const [params, setParams] = useSearchParams();

  if (error || board.error) {
    return (
      <div className="p-6">
        <LoadError error={error ?? board.error} />
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

  if (isMobile) {
    return (
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
    );
  }
  return (
    <Suspense fallback={<BoardSkeleton />}>
      <BoardCanvas board={board.data} me={me} />
    </Suspense>
  );
}
