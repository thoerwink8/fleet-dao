// 主页（/）：一屏三块 + 顶部持续状态条。
// 三块：要你拍的（最多 3 条，多的去通知中心）、在跑的（思维导图看板：中心引擎 → 三段对题 / 动手 / 验收 → 每张单）、
// 做完的（最近 8 篇 PR）。「在跑的」先是三段泳道（母单 #902），创始人 2026-10-07「react-flow 我还是喜欢初版那样」，
// 换回初版看板（PR #13）的样子和手感：两侧展开、三级缩放、聚焦、过滤、全键盘、悬停和右键操作、右侧详情；手机上是树形列表。
// 版面：xl（1280）起左列要你拍的 + 做完的、右边看板（xl 左列占三分之一，2xl 起左列固定 26rem），1366×768 一进来就看得到看板
// （指挥官 2026-10-07 定）；更窄时三块从上往下：要你拍的、看板、做完的。要你拍的永远在看板前面。

import { CheckCheck, CirclePlay, Hand, SearchX } from 'lucide-react';
import { Link } from 'react-router';
import { brand } from '#brand';
import { isNotFound, useHome, useNodeHome } from '../api/client';
import { DecisionCard } from '../components/home/decision-card';
import { DoneCard } from '../components/home/done-card';
import { HealthStrip } from '../components/home/health-strip';
import { RunningBoard } from '../components/home/running-board';
import type { HomeData } from '../components/home/types';
import { RemoteViewProvider, SnapshotBanner, useSelectedNodeName } from '../components/node-notice';
import { NotBuilt } from '../components/not-built';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { Button } from '../components/ui/button';
import { useSelectedNodeId } from '../lib/node';
import { useShownError } from '../lib/shown-error';

export function meta() {
  return [{ title: brand.title('主页') }];
}

const MAX_DECISIONS = 3;
const MAX_DONE = 6;

function HomeBody({ data, remote }: { data: HomeData; remote: boolean }) {
  const decisions = data.decisions.slice(0, MAX_DECISIONS);
  const done = data.done.slice(0, MAX_DONE);
  const more = data.decisions.length - decisions.length;

  return (
    <>
      <div className="grid items-start gap-4 xl:grid-cols-3 2xl:grid-cols-board">
        {/* 左列：窄屏上是 contents（两块直接当网格项，按 order 排在看板前后），xl 起才成一列 */}
        <div className="contents xl:col-start-1 xl:row-start-1 xl:flex xl:min-w-0 xl:flex-col xl:gap-4">
          <Panel
            title="要你拍的"
            description={remote ? '决定、待批（只读，要去那台上答）。' : '决定、待批。多的去通知中心。'}
            actions={
              // 通知中心读的是本台的库：看远程快照时没有「全部」可去
              remote ? undefined : (
                <Button asChild size="sm" variant="ghost" className="h-7">
                  <Link to="/notifications">全部</Link>
                </Button>
              )
            }
            className="order-1 xl:order-none"
            bodyClassName="p-3"
          >
            {decisions.length ? (
              <ul className="grid gap-2 md:grid-cols-3 xl:grid-cols-1">
                {decisions.map((d) => (
                  <DecisionCard key={`${d.kind}:${d.id}`} decision={d} />
                ))}
              </ul>
            ) : (
              <Empty icon={Hand} title="没有要你拍的" hint="有决定、待批时会出现在这里。" />
            )}
            {more > 0 ? (
              <p className="mt-3 px-1 text-xs text-muted-foreground">
                还有 <span className="num">{more}</span> 条，
                {remote ? (
                  '要去那台上的通知中心看。'
                ) : (
                  <>
                    去
                    <Link to="/notifications" className="underline underline-offset-2">
                      通知中心
                    </Link>
                    看。
                  </>
                )}
              </p>
            ) : null}
          </Panel>

          <Panel
            title="做完的"
            description="最近合进去的 PR。"
            className="order-3 xl:order-none"
            bodyClassName="p-3"
          >
            {done.length ? (
              <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-1">
                {done.map((d) => (
                  <DoneCard key={d.prNumber} item={d} />
                ))}
              </ul>
            ) : (
              <Empty icon={CheckCheck} title="最近没有合进的 PR" hint="有 PR 合进主线会出现在这里。" />
            )}
          </Panel>
        </div>

        <Panel
          title="在跑的"
          description="每张开着的单在对题、动手、验收哪一段，谁在做、在等什么。单击卡片看详情，双击进单子。"
          className="order-2 min-w-0 xl:order-none xl:col-span-2 xl:col-start-2 xl:row-start-1 2xl:col-span-1"
          bodyClassName="p-0"
        >
          {data.running.length ? (
            <RunningBoard running={data.running} flow={data.flow} health={data.health} />
          ) : (
            <Empty icon={CirclePlay} title="现在没有在跑的单" hint="新接的单会出现在这里。" />
          )}
        </Panel>
      </div>
    </>
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

export default function Home() {
  // 选了远程环境（?node=）就渲染它最近一次推来的快照：同一套组件，只读、链接指向 GitHub、写按钮置灰。
  // 这是环境详情（接口 GET /api/nodes/:nodeId，没有单独的 /nodes/:id 路由）。
  const nodeId = useSelectedNodeId();
  const nodeName = useSelectedNodeName();
  const local = useHome({ enabled: nodeId === null });
  const remote = useNodeHome(nodeId);
  // 推送重读会把从没读成过的快照退回骨架：显示记住的那次失败
  const remoteError = useShownError(nodeId ?? undefined, { error: remote.error, data: remote.node });
  const state =
    nodeId !== null && remoteError
      ? { status: 'error' as const, error: remoteError, retry: () => void remote.refetch() }
      : nodeId === null
        ? local.data
        : remote.data;

  return (
    <Page
      title={nodeId === null ? '主页' : `主页 · ${nodeName ?? nodeId}`}
      // 持续状态条放在标题右边：首屏的高度留给要你拍的和流水线，不再单占一行
      actions={state.status === 'data' ? <HealthStrip health={state.data.health} /> : undefined}
      className="max-w-none"
    >
      {nodeId !== null && remote.node ? (
        <SnapshotBanner
          name={remote.node.name}
          receivedAt={remote.node.receivedAt}
          reportedAt={remote.node.reportedAt}
        />
      ) : null}
      {nodeId !== null && state.status === 'error' && isNotFound(state.error) ? (
        <MissingEnv nodeId={nodeId} />
      ) : state.status === 'loading' ? (
        <div className="mt-4">
          <LoadingRows rows={6} />
        </div>
      ) : state.status === 'error' ? (
        <div className="mt-4">
          <LoadError what={nodeId === null ? '主页' : '这个环境'} error={state.error} onRetry={state.retry} />
        </div>
      ) : state.status === 'notWired' ? (
        <div className="mt-4">
          <NotBuilt notWired={state.notWired} />
        </div>
      ) : (
        <RemoteViewProvider value={nodeId === null ? null : { name: nodeName ?? nodeId }}>
          <HomeBody data={state.data} remote={nodeId !== null} />
        </RemoteViewProvider>
      )}
    </Page>
  );
}
