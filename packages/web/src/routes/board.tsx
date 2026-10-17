// 画布（/board）：原来的主页，思维导图画布占满正文（单 #1801）。主页（/）改成三块（决定 0093）后挪到这里，入口在侧栏「更多」。
// 正文区整块是「在跑的」画布（思维导图看板：中心引擎 → 三段对题 / 动手 / 验收 → 每张单）；页面标题行去掉了，
// 健康条和刷新条挪进顶栏右段（≥1024 宽；更窄时落在画布上方一条细栏里）。
// 「要你拍的」「做完的」收进右侧抽屉（components/home/home-drawer.tsx）：桌面是画布右上角的按钮 + 360px 抽屉，
// ≥1920 停靠成一列；手机是列表顶上一条横条 + 底部 Sheet，看板退化成树形列表（一张单一行）。
// 看板的样子是初版（PR #13）那样：两侧展开、三级缩放、聚焦、过滤、全键盘、悬停和右键操作、右侧详情。

import { CirclePlay } from 'lucide-react';
import type { ReactNode } from 'react';
import { brand } from '#brand';
import { isNotFound, useHome, useLiveState, useNodeHome } from '../api/client';
import { FlowModeToggle } from '../components/flow-mode-toggle';
import { HealthStrip } from '../components/home/health-strip';
import { HomeDrawer } from '../components/home/home-drawer';
import { MachineMeter } from '../components/home/machine-meter';
import { MissingEnv } from '../components/home/missing-env';
import { repoSlug, visibleForProject } from '../components/home/project-view';
import { RunningBoard } from '../components/home/running-board';
import type { HomeData } from '../components/home/types';
import { EmptyState } from '../components/layout/empty-state';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { RemoteViewProvider, SnapshotBanner, useSelectedNodeName } from '../components/node-notice';
import { NotBuilt } from '../components/not-built';
import { RefreshBar } from '../components/refresh-bar';
import { useRepoIfAny } from '../components/repo-context';
import { InTopbar } from '../components/shell/topbar-slot';
import { TIME } from '../lib/format';
import { useSelectedNodeId } from '../lib/node';
import { useShownError } from '../lib/shown-error';
import { usePhone, useTopbarRoom } from '../lib/viewport';

export function meta() {
  return [{ title: brand.title('画布') }];
}

/** 本台主页靠推送更新、不自己轮询；远程快照每 30 秒重拉。超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const HOME_STALE_AFTER_MS = 5 * TIME.MIN;

function HomeBody({
  data,
  remote,
  phone,
  afterStrip,
}: {
  data: HomeData;
  remote: boolean;
  phone: boolean;
  afterStrip?: ReactNode;
}) {
  // 顶栏当前项目。画布和两个抽屉只留这一仓；没挂仓的决定（整机的事）留下。
  // 外壳没包 RepoProvider（页面单独挂、测试直接渲染）时还没选出项目，先不筛。
  // 健康条、机器资源、池里的会话数不从这里过，仍是整台机器的。
  const repo = useRepoIfAny()?.repo;
  const slug = repo ? repoSlug(repo) : undefined;
  const decisions = visibleForProject(data.decisions, slug);
  const done = visibleForProject(data.done, slug);
  const running = visibleForProject(data.running, slug);
  return (
    <HomeDrawer decisions={decisions} done={done} remote={remote} phone={phone} afterStrip={afterStrip}>
      {running.length ? (
        <RunningBoard
          running={running}
          flow={data.flow}
          health={data.health}
          slots={data.slots}
          resources={data.resources}
        />
      ) : (
        <div className="grid h-full place-items-center">
          <div className="flex flex-col items-center gap-3">
            <EmptyState icon={CirclePlay} title="现在没有在跑的单" hint="新接的单会出现在这里。" />
            {/* 没有画布就没有「此刻」那一条：桌面上机器资源放在这里（手机在上面的细栏里） */}
            {phone ? null : <MachineMeter resources={data.resources} remote={remote} />}
          </div>
        </div>
      )}
    </HomeDrawer>
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
  const repo = useRepoIfAny()?.repo;
  const slug = repo ? repoSlug(repo) : undefined;
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

  // 机器资源两格（#1973）：整机内存、CPU，跟着推送动。桌面是画布左下「此刻」面板右边的一张小卡（顶栏放不下），
  // 手机没有画布，放在这条细栏的第二行
  const meter =
    state.status === 'data' && phone ? (
      <MachineMeter
        resources={state.data.resources}
        remote={nodeId !== null}
        machine={nodeId === null ? undefined : (nodeName ?? nodeId)}
      />
    ) : null;

  // 桌面画布自己的工具条上有开关。手机是树、或者这一仓没有在跑的单、画布还没出来时，开关放在这条细栏里，免得找不到。
  const canvasUp =
    !phone && state.status === 'data' && visibleForProject(state.data.running, slug).length > 0;
  const flowSwitch = canvasUp ? null : <FlowModeToggle />;

  // 画布上方（顶栏放不下时）或手机上的一条细栏：状态摘要（带字的「状态」按钮）+ 刷新；手机上第二行是机器资源。
  // 机器资源写了具体数值（#1973），手机一行放不下三样：硬塞会把健康条（它自己是 flex-1 min-w-0、内容靠右）挤出左边、
  // 字被截，所以手机上机器资源整块另起一行（靠右，和第一行的状态 + 刷新对齐右边）；第一行照旧是状态 + 刷新、不换行（#1819）。
  // 手机上它排在「要你拍的」横条下面，首屏第一眼是要你拍的；还没读到数据时（读取中、出错）没有横条，它照旧在最上面。
  const statusbar = (
    <div className="shrink-0 border-b">
      {flowSwitch ? <div className="flex px-3 py-1.5 sm:px-4">{flowSwitch}</div> : null}
      <div
        data-home-statusbar
        className="flex flex-nowrap items-center gap-x-3 px-3 sm:px-4 max-md:py-0 md:py-1.5"
      >
        {state.status === 'data' ? <HealthStrip health={state.data.health} /> : null}
        <div className="ml-auto">{refresh}</div>
      </div>
      {meter ? (
        <div data-home-meter-row className="-mt-1 flex justify-end px-3 sm:px-4">
          {meter}
        </div>
      ) : null}
    </div>
  );
  const phoneUnderStrip = phone && state.status === 'data';

  return (
    <div className="flex h-full min-h-0 flex-col" data-home>
      {/* 页面标题行去掉了，标题留给读屏和标签页：看哪个环境，顶栏的环境切换器也写着 */}
      <h1 className="sr-only">{nodeId === null ? '画布' : `画布 · ${nodeName ?? nodeId}`}</h1>
      {/* 健康条 + 刷新条：顶栏放得下（≥1024）就进顶栏右段，放不下落在画布上方一条细栏里 */}
      <InTopbar enabled={topbarRoom} fallback={phoneUnderStrip ? null : statusbar}>
        {flowSwitch}
        {state.status === 'data' ? <HealthStrip health={state.data.health} /> : null}
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
          <LoadError what={nodeId === null ? '画布' : '这个环境'} error={state.error} onRetry={state.retry} />
        </Message>
      ) : state.status === 'notWired' ? (
        <Message>
          <NotBuilt notWired={state.notWired} />
        </Message>
      ) : (
        <div className="min-h-0 flex-1">
          <RemoteViewProvider value={nodeId === null ? null : { name: nodeName ?? nodeId }}>
            <HomeBody
              data={state.data}
              remote={nodeId !== null}
              phone={phone}
              afterStrip={phoneUnderStrip ? statusbar : undefined}
            />
          </RemoteViewProvider>
        </div>
      )}
    </div>
  );
}
