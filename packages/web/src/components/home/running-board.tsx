// 主页「在跑的」那块：桌面是思维导图画布（React Flow + ELK，按需加载），手机上退化成可折叠的树形列表。
// 初版看板（PR #13）就是这么分的；画布的说明见 board/board-canvas.tsx。
import { lazy, Suspense } from 'react';
import { useMediaQuery } from '../../lib/hooks';
import { Skeleton } from '../ui/skeleton';
import { BoardTree } from './board/board-tree';
import type { HomeFlowStage, HomeHealth, HomeRunning, HomeSlots } from './types';

// 画布（React Flow + ELK）按需加载：手机上只用树形列表，不必下载它。
const BoardCanvas = lazy(() => import('./board/board-canvas').then((m) => ({ default: m.BoardCanvas })));

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

export function RunningBoard({
  running,
  flow,
  health,
  slots,
}: {
  running: readonly HomeRunning[];
  flow: readonly HomeFlowStage[];
  health?: HomeHealth | undefined;
  slots?: HomeSlots | undefined;
}) {
  const mobile = useMediaQuery('(max-width: 767px)');
  if (mobile) return <BoardTree running={running} flow={flow} />;
  // 画布占满父容器（主页给它正文区的全部高宽），不再自己定高
  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden" data-home-canvas>
      <Suspense fallback={<BoardSkeleton />}>
        <BoardCanvas running={running} flow={flow} health={health} slots={slots} />
      </Suspense>
    </div>
  );
}
