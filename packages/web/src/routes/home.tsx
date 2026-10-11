// 主页（/）：画布占满正文，其余收起来（单 #1801）。
// 正文区整块是「在跑的」画布（思维导图看板：中心引擎 → 三段对题 / 动手 / 验收 → 每张单）；页面标题行去掉了，
// 健康条和刷新条挪进顶栏右段（≥1024 宽；更窄时落在画布上方一条细栏里）。
// 「要你拍的」「做完的」收进右侧抽屉（components/home/home-drawer.tsx）：桌面是画布右上角的按钮 + 360px 抽屉，
// ≥1920 停靠成一列；手机是列表顶上一条横条 + 底部 Sheet，看板退化成树形列表（一张单一行）。
// 看板的样子是初版（PR #13）那样：两侧展开、三级缩放、聚焦、过滤、全键盘、悬停和右键操作、右侧详情（创始人 2026-10-07 定）。

import { CirclePlay, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { brand } from '#brand';
import { isNotFound, useHome, useLiveState, useNodeHome } from '../api/client';
import { HealthStrip } from '../components/home/health-strip';
import { HomeDrawer } from '../components/home/home-drawer';
import { RunningBoard } from '../components/home/running-board';
import type { HomeData } from '../components/home/types';
import { RemoteViewProvider, SnapshotBanner, useSelectedNodeName } from '../components/node-notice';
import { NotBuilt } from '../components/not-built';
import { Empty, LoadError, LoadingRows, Panel } from '../components/page';
import { RefreshBar } from '../components/refresh-bar';
import { InTopbar } from '../components/shell/topbar-slot';
import { Button } from '../components/ui/button';
import { TIME } from '../lib/format';
import { useSelectedNodeId } from '../lib/node';
import { useShownError } from '../lib/shown-error';
import { usePhone, useTopbarRoom } from '../lib/viewport';

export function meta() {
  return [{ title: brand.title('主页') }];
}

/** 本台主页靠推送更新、不自己轮询；远程快照每 30 秒重拉。超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const HOME_STALE_AFTER_MS = 5 * TIME.MIN;

function HomeBody({ data, remote, phone }: { data: HomeData; remote: boolean; phone: boolean }) {
  return (
    <HomeDrawer decisions={data.decisions} done={data.done} remote={remote} phone={phone}>
      {data.running.length ? (
        <RunningBoard running={data.running} flow={data.flow} health={data.health} slots={data.slots} />
      ) : (
        <div className="grid h-full place-items-center">
          <Empty icon={CirclePlay} title="现在没有在跑的单" hint="新接的单会出现在这里。" />
        </div>
      )}
    </HomeDrawer>
  );
}

/** 没有这个环境（后端 404）：写明，给回主页的路；不转圈、不给「重试」（重试也不会有）。 */
function MissingEnv({ nodeId }: { nodeId: string }) {
  return (
    <Panel>
      <div role="alert">
        <Empty
          icon={SearchX}
          title="没有这个环境"
          hint={
            <>
              <span className="block">
                库里没有编号为「<span className="num">{nodeId}</span>
                」的环境：可能链接里的编号写错了，或这个环境已经不在了。
              </span>
              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link to="/">回主页</Link>
              </Button>
            </>
          }
        />
      </div>
    </Panel>
  );
}

/** 读不到、还在读、没接线：和以前一样占一块带内边距的区域，自己滚。 */
function Message({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">{children}</div>;
}

export default function Home() {
  // 选了远程环境（?node=）就渲染它最近一次推来的快照：同一套组件，只读、链接指向 GitHub、写按钮置灰。
  // 这是环境详情（接口 GET /api/nodes/:nodeId，没有单独的 /nodes/:id 路由）。
  const nodeId = useSelectedNodeId();
  const nodeName = useSelectedNodeName();
  const local = useHome({ enabled: nodeId === null });
  const remote = useNodeHome(nodeId);
  const phone = usePhone();
  const push = useLiveState().status;
  const topbarRoom = useTopbarRoom();
  // 本台读 useHome，选了远程环境读那台的快照。刷新条跟眼下这一份主查询走。
  const main = nodeId === null ? local : remote;
  // 推送重读会把从没读成过的快照退回骨架：显示记住的那次失败
  const remoteError = useShownError(nodeId ?? undefined, { error: remote.error, data: remote.node });
  const state =
    nodeId !== null && remoteError
      ? { status: 'error' as const, error: remoteError, retry: () => void remote.refetch() }
      : nodeId === null
        ? local.data
        : remote.data;

  const refresh = (
    <RefreshBar
      variant="dot"
      className="shrink-0"
      onRefresh={() => void main.refetch()}
      isFetching={main.isFetching}
      dataUpdatedAt={main.dataUpdatedAt}
      staleAfterMs={HOME_STALE_AFTER_MS}
      push={push}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-home>
      {/* 页面标题行去掉了，标题留给读屏和标签页：看哪个环境，顶栏的环境切换器也写着 */}
      <h1 className="sr-only">{nodeId === null ? '主页' : `主页 · ${nodeName ?? nodeId}`}</h1>
      {/* 健康条 + 刷新条：顶栏放得下（≥1024）就进顶栏右段，放不下落在画布上方一条细栏里 */}
      <InTopbar
        enabled={topbarRoom}
        fallback={
          <div
            data-home-statusbar
            className="flex shrink-0 flex-nowrap items-center gap-x-3 border-b px-3 sm:px-4 max-md:py-0 md:py-1.5"
          >
            {/* 手机：三个状态点 + 刷新图标按钮，同一行；更宽一点的屏仍写三格的名字 */}
            {state.status === 'data' ? (
              <HealthStrip health={state.data.health} detail="never" compact={phone} />
            ) : null}
            <div className="ml-auto">{refresh}</div>
          </div>
        }
      >
        {state.status === 'data' ? <HealthStrip health={state.data.health} detail="wide" /> : null}
        {refresh}
      </InTopbar>
      {nodeId !== null && remote.node ? (
        <div className="shrink-0 px-3 pt-3 sm:px-4">
          <SnapshotBanner
            name={remote.node.name}
            receivedAt={remote.node.receivedAt}
            reportedAt={remote.node.reportedAt}
          />
        </div>
      ) : null}
      {nodeId !== null && state.status === 'error' && isNotFound(state.error) ? (
        <Message>
          <MissingEnv nodeId={nodeId} />
        </Message>
      ) : state.status === 'loading' ? (
        <Message>
          <LoadingRows rows={6} />
        </Message>
      ) : state.status === 'error' ? (
        <Message>
          <LoadError what={nodeId === null ? '主页' : '这个环境'} error={state.error} onRetry={state.retry} />
        </Message>
      ) : state.status === 'notWired' ? (
        <Message>
          <NotBuilt notWired={state.notWired} />
        </Message>
      ) : (
        <div className="min-h-0 flex-1">
          <RemoteViewProvider value={nodeId === null ? null : { name: nodeName ?? nodeId }}>
            <HomeBody data={state.data} remote={nodeId !== null} phone={phone} />
          </RemoteViewProvider>
        </div>
      )}
    </div>
  );
}
