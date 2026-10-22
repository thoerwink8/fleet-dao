// 资源页（/resources，#1986；#3509 照 Arco 改版，样稿 canvas/Resources.dc.html）：法国这台机器此刻的整机内存、CPU、磁盘，每个上线项目各占多少、放在哪。
// 创始人原话：「资源页展示的是每个上线项目占用多少，比如驾驶舱占用」「磁盘占用我需要的是整个 vps 使用多少/总量多少」。
//
// 数据从哪来：和工作台同一份（useHome 的 resources；选了远程环境读那台推来的快照）。整机和每个项目的 CPU、内存每 5 秒随推送换；
// 按目录的磁盘占用由法国上 root 的单元每 10 分钟用 du 量一回，后端读它写的文件、带着推。不整页轮询。
// 每一格怎么写（读成了、没在占用、没读到、不全）在 components/resources/view.ts，这里只管拼三块：整机 → 上线项目 → 仓。
// 页面只拼 components/layout 的件，不写样式类（design 第三节、lint-design R13–R20）。
import { brand } from '#brand';
import { isNotFound, useHome, useLiveState, useNodeHome } from '../api/client';
import { MissingEnv } from '../components/home/missing-env';
import { Breadcrumb } from '../components/layout/breadcrumb';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { Stack } from '../components/layout/stack';
import { SnapshotBanner, useSelectedNodeName } from '../components/node-notice';
import { NotBuilt } from '../components/not-built';
import { AppsSection } from '../components/resources/apps-section';
import { HostSection } from '../components/resources/host-section';
import { ReposSection } from '../components/resources/repos-section';
import { TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useSelectedNodeId } from '../lib/node';
import { useShownError } from '../lib/shown-error';

export function meta() {
  return [{ title: brand.title('资源') }];
}

const STALE_AFTER_MS = 5 * TIME.MIN;

export default function Resources() {
  const nodeId = useSelectedNodeId();
  const nodeName = useSelectedNodeName();
  const local = useHome({ enabled: nodeId === null });
  const remote = useNodeHome(nodeId);
  const push = useLiveState().status;
  const now = useNow();
  const main = nodeId === null ? local : remote;
  const remoteError = useShownError(nodeId ?? undefined, { error: remote.error, data: remote.node });
  const state =
    nodeId !== null && remoteError
      ? { status: 'error' as const, error: remoteError, retry: () => void remote.refetch() }
      : nodeId === null
        ? local.data
        : remote.data;
  const isRemote = nodeId !== null;
  const machine = isRemote ? (nodeName ?? nodeId) : '这台机器';
  const retry = () => void main.refetch();

  return (
    <Page
      title="资源"
      breadcrumb={<Breadcrumb items={[{ label: '法国', href: '/france' }, { label: '资源' }]} />}
      description="整机此刻的内存、CPU、磁盘，每个上线项目、每个仓各占多少"
      detail="CPU、内存每 5 秒随推送更新（读各 systemd 单元的 cgroup，1 核 = 占满一个核）；按目录的磁盘占用每 10 分钟测一次；仓和工作树的清单由引擎每小时对账时出一份，「清理没用的工作树」只删没人用、没有没提交或没推改动的树。读不到写「没读到」，读不全写「不全」，不拿 0 顶。"
      refresh={{
        onRefresh: retry,
        isFetching: main.isFetching,
        dataUpdatedAt: main.dataUpdatedAt,
        staleAfterMs: STALE_AFTER_MS,
        push,
      }}
    >
      <Stack>
        {isRemote && remote.node ? (
          <SnapshotBanner
            name={remote.node.name}
            receivedAt={remote.node.receivedAt}
            reportedAt={remote.node.reportedAt}
          />
        ) : null}
        {nodeId !== null && state.status === 'error' && isNotFound(state.error) ? (
          <MissingEnv nodeId={nodeId} backTo="/resources" backLabel="回本台" />
        ) : state.status === 'loading' ? (
          <LoadingRows rows={8} />
        ) : state.status === 'error' ? (
          <LoadError what={isRemote ? '这个环境' : '资源读数'} error={state.error} onRetry={state.retry} />
        ) : state.status === 'notWired' ? (
          <NotBuilt notWired={state.notWired} />
        ) : (
          <>
            <HostSection resources={state.data.resources} remote={isRemote} machine={machine} now={now} />
            <AppsSection resources={state.data.resources} running={state.data.running} remote={isRemote} />
            <ReposSection
              resources={state.data.resources}
              running={state.data.running}
              remote={isRemote}
              now={now}
            />
          </>
        )}
      </Stack>
    </Page>
  );
}
