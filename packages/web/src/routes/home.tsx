// 主页（/）：创始人一打开就看到现在怎样（#2759 在三块之上加了三样）：
// 0. 一句话：有几件要你定 / 流水线卡在哪一步、谁在修了多久 / 在走；旁边一行额度和本期估算（读不到写「没记」）。
//    再按仓出卡：本周上线几版、在跑几张、卡住几张、当前里程碑，有问题的排前面。
// 1. 要你拍的：只放真要他拍的（四类人闸 + 看门狗进来的卡），一条一行；人闸的选项就是按钮，看门狗只写谁在修、开了多久；
// 2. 在跑的：法国引擎和本机在做的，一件一行：事、谁在做、进度、卡没卡；
// 3. 上线了的：最近切到法国的版本，一句话说清改了什么，带上它带的 PR。
// 原来的思维导图画布挪到 /board（routes/board.tsx），和别的页一起收进侧栏「更多」。
// 数据全用现成接口：/home、/notifications、/nodes/sessions、/france/released-commits（components/home/today.ts 文件头）。
// 选了远程环境（?node=）读那台推来的快照：要你拍的只读、在跑的只列那台的引擎单；本机会话和上线记录是本台的，不顶着远程的名字列。
import { brand } from '#brand';
import {
  isNotFound,
  useFranceReleasedCommits,
  useHome,
  useLiveState,
  useLocalSessions,
  useNodeHome,
} from '../api/client';
import { FlowModeToggle } from '../components/flow-mode-toggle';
import { Headline } from '../components/home/headline';
import { HealthStrip } from '../components/home/health-strip';
import { MissingEnv } from '../components/home/missing-env';
import { ProjectCards } from '../components/home/project-cards';
import { SpendLine } from '../components/home/spend-line';
import {
  AskBlock,
  RemoteAskBlock,
  RemoteRunBlock,
  RemoteShippedBlock,
  RunBlock,
  ShippedBlock,
} from '../components/home/today-blocks';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { SnapshotBanner, useSelectedNodeName } from '../components/node-notice';
import { NotBuilt } from '../components/not-built';
import { TIME } from '../lib/format';
import { useSelectedNodeId } from '../lib/node';
import { useShownError } from '../lib/shown-error';

export function meta() {
  return [{ title: brand.title('主页') }];
}

/** 本台主页靠推送更新、兜底轮询；远程快照每 30 秒重拉。超过 5 分钟还没再读成，刷新标「数据已过期」。 */
const HOME_STALE_AFTER_MS = 5 * TIME.MIN;

export default function Home() {
  const nodeId = useSelectedNodeId();
  const nodeName = useSelectedNodeName();
  const local = useHome({ enabled: nodeId === null });
  const remote = useNodeHome(nodeId);
  const push = useLiveState().status;
  const main = nodeId === null ? local : remote;
  // 推送重读会把从没读成过的快照退回骨架：显示记住的那次失败
  const remoteError = useShownError(nodeId ?? undefined, { error: remote.error, data: remote.node });
  const state =
    nodeId !== null && remoteError
      ? { status: 'error' as const, error: remoteError, retry: () => void remote.refetch() }
      : nodeId === null
        ? local.data
        : remote.data;
  const machine = nodeName ?? nodeId ?? '';
  // 首屏一轮发完（经香港到法国每多一轮慢一趟）：本机会话、上线记录和主页、通知一起发，不等主页回来才由区块发
  useLocalSessions();
  useFranceReleasedCommits();

  return (
    <Page
      title={nodeId === null ? '主页' : `主页 · ${machine}`}
      stackActions
      actions={
        <>
          <FlowModeToggle />
          {state.status === 'data' ? <HealthStrip health={state.data.health} /> : null}
        </>
      }
      refresh={{
        variant: 'dot',
        onRefresh: () => void main.refetch(),
        isFetching: main.isFetching,
        dataUpdatedAt: main.dataUpdatedAt,
        staleAfterMs: HOME_STALE_AFTER_MS,
        push,
      }}
    >
      <div data-home className="flex flex-col gap-4 lg:gap-6">
        {nodeId !== null && remote.node ? (
          <SnapshotBanner
            name={remote.node.name}
            receivedAt={remote.node.receivedAt}
            reportedAt={remote.node.reportedAt}
          />
        ) : null}
        {state.status === 'data' ? (
          <>
            <Headline decisions={state.data.decisions.length} pipeline={state.data.pipeline} />
            <SpendLine quota={state.data.health.quota} spend={state.data.spend} />
          </>
        ) : null}
        {/* 要你拍的只读通知，不等主页那份聚合：主页没读成也照样能拍 */}
        {nodeId === null ? <AskBlock /> : null}
        {nodeId !== null && state.status === 'error' && isNotFound(state.error) ? (
          <MissingEnv nodeId={nodeId} />
        ) : state.status === 'loading' ? (
          <LoadingRows rows={6} />
        ) : state.status === 'error' ? (
          <LoadError what={nodeId === null ? '主页' : '这个环境'} error={state.error} onRetry={state.retry} />
        ) : state.status === 'notWired' ? (
          <NotBuilt notWired={state.notWired} />
        ) : nodeId === null ? (
          <>
            <ProjectCards projects={state.data.projects} />
            <RunBlock running={state.data.running} />
            <ShippedBlock done={state.data.done} />
          </>
        ) : (
          <>
            <ProjectCards projects={state.data.projects} />
            <RemoteAskBlock decisions={state.data.decisions} machine={machine} />
            <RemoteRunBlock running={state.data.running} />
            <RemoteShippedBlock />
          </>
        )}
      </div>
    </Page>
  );
}
