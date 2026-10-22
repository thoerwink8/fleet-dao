// 工作台（/，旧名「主页」；#3509 照 Arco 改版的样板页，样稿 canvas/Main.dc.html）：创始人一打开就看到现在怎样。
// 从上到下：
// 0. 数据概览：额度和本期估算两个数（读不到写「没记」「没查成」，不写 0）。
// 1. 左列：要你拍的（人闸，选项就是按钮）、在跑的任务（法国引擎的单和本机会话，卡住、等你的在前）。
// 2. 右列：卡住报警（看门狗的卡，谁在修、开了多久，没人接就写没人接）、最近上线、系统状态（流水线、中转、引擎进程）。
// 3. 项目：一个仓一行（老后端没给写明没给）。
// 原来的思维导图画布（/board）已删（创始人拍，#3533）；页头的「三段 / 全程」开关挪到了法国页的引擎卡（派单方式）。
// 数据全用现成接口：/home、/notifications、/nodes/sessions、/france/released-commits（components/home/today.ts 文件头）。
// 选了远程环境（?node=）读那台推来的快照：要你拍的只读、在跑的只列那台的引擎单；卡住报警、本机会话和上线记录是本台的，不顶着远程的名字列。
// 页面只拼 components/layout 的件，不写样式类（design 第三节、lint-design R13–R20）。
import { brand } from '#brand';
import {
  isNotFound,
  useFranceReleasedCommits,
  useHome,
  useLiveState,
  useLocalSessions,
  useNodeHome,
} from '../api/client';
import { MissingEnv } from '../components/home/missing-env';
import { Overview } from '../components/home/overview';
import { ProjectCards } from '../components/home/project-cards';
import { SystemStatus } from '../components/home/system-status';
import {
  AlarmBlock,
  AskBlock,
  RemoteAlarmBlock,
  RemoteAskBlock,
  RemoteRunBlock,
  RemoteShippedBlock,
  RunBlock,
  ShippedBlock,
} from '../components/home/today-blocks';
import { Grid } from '../components/layout/grid';
import { LoadError, LoadingRows, LoadStale } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { SnapshotBanner, useSelectedNodeName } from '../components/node-notice';
import { NotBuilt } from '../components/not-built';
import { TIME } from '../lib/format';
import { useSelectedNodeId } from '../lib/node';
import { useShownError } from '../lib/shown-error';

export function meta() {
  return [{ title: brand.title('工作台') }];
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
    nodeId !== null && remoteError && !remote.node
      ? { status: 'error' as const, error: remoteError, retry: () => void remote.refetch() }
      : nodeId === null
        ? local.data
        : remote.data;
  const machine = nodeName ?? nodeId ?? '';
  const what = nodeId === null ? '主页' : '这个环境';
  // 首屏一轮发完（经香港到法国每多一轮慢一趟）：本机会话、上线记录和主页、通知一起发，不等主页回来才由区块发
  useLocalSessions();
  useFranceReleasedCommits();

  const missing = nodeId !== null && state.status === 'error' && isNotFound(state.error);

  /**
   * 主页这份聚合还在读时，依赖它的几块画骨架；没接上的写待实现。
   * 没读成时这几块不画（没读成和重试只在「数据概览」那一处写一次，不在每块各写一遍，更不画成 0 或空）。
   */
  const pending = (title: string) =>
    state.status === 'error' ? null : (
      <Section title={title}>
        {state.status === 'notWired' ? (
          <NotBuilt notWired={state.notWired} compact />
        ) : (
          <LoadingRows rows={3} />
        )}
      </Section>
    );

  return (
    <Page
      title={nodeId === null ? '工作台' : `工作台 · ${machine}`}
      refresh={{
        variant: 'dot',
        onRefresh: () => void main.refetch(),
        isFetching: main.isFetching,
        dataUpdatedAt: main.dataUpdatedAt,
        staleAfterMs: HOME_STALE_AFTER_MS,
        push,
      }}
    >
      <div data-home>
        <Stack>
          {nodeId !== null && remote.node ? (
            <SnapshotBanner
              name={remote.node.name}
              receivedAt={remote.node.receivedAt}
              reportedAt={remote.node.reportedAt}
            />
          ) : null}
          {state.status === 'data' && state.stale ? (
            <LoadStale what={what} stale={state.stale} staleAfterMs={HOME_STALE_AFTER_MS} />
          ) : null}
          {missing ? (
            <MissingEnv nodeId={nodeId} />
          ) : (
            <>
              {state.status === 'data' ? (
                <Section title="数据概览">
                  <Overview quota={state.data.health.quota} spend={state.data.spend} />
                </Section>
              ) : (
                <Section title="数据概览">
                  {state.status === 'error' ? (
                    <LoadError what={what} error={state.error} onRetry={state.retry} />
                  ) : state.status === 'notWired' ? (
                    <NotBuilt notWired={state.notWired} compact />
                  ) : (
                    <LoadingRows rows={2} />
                  )}
                </Section>
              )}
              <Grid preset="main">
                <Stack>
                  {/* 要你拍的只读通知，不等主页那份聚合：主页没读成也照样能拍 */}
                  {nodeId === null ? (
                    <AskBlock />
                  ) : state.status === 'data' ? (
                    <RemoteAskBlock decisions={state.data.decisions} machine={machine} />
                  ) : (
                    pending('要你拍的')
                  )}
                  {state.status !== 'data' ? (
                    pending('在跑的任务')
                  ) : nodeId === null ? (
                    <RunBlock running={state.data.running} />
                  ) : (
                    <RemoteRunBlock running={state.data.running} />
                  )}
                </Stack>
                <Stack>
                  {nodeId === null ? <AlarmBlock /> : <RemoteAlarmBlock />}
                  {nodeId === null ? (
                    <ShippedBlock done={state.status === 'data' ? state.data.done : []} />
                  ) : (
                    <RemoteShippedBlock />
                  )}
                  {state.status === 'data' ? (
                    <Section title="系统状态">
                      <SystemStatus health={state.data.health} pipeline={state.data.pipeline} />
                    </Section>
                  ) : (
                    pending('系统状态')
                  )}
                </Stack>
              </Grid>
              {state.status === 'data' ? <ProjectCards projects={state.data.projects} /> : null}
            </>
          )}
        </Stack>
      </div>
    </Page>
  );
}
