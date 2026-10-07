// 主页（/）：一屏三块 + 顶部持续状态条。
// 三块：要你拍的（最多 3 条，多的去通知中心）、在跑的（思维导图看板：中心引擎 → 三段对题 / 动手 / 验收 → 每张单）、
// 做完的（最近 8 篇 PR）。「在跑的」先是三段泳道（母单 #902），创始人 2026-10-07「react-flow 我还是喜欢初版那样」，
// 换回初版看板（PR #13）的样子和手感：两侧展开、三级缩放、聚焦、过滤、全键盘、悬停和右键操作、右侧详情；手机上是树形列表。
// 版面：宽屏（2xl 起）左边要你拍的、右边流水线；窄一点要你拍的排在上面一条，流水线占满宽。要你拍的永远在流水线前面。

import { CheckCheck, CirclePlay, Hand } from 'lucide-react';
import { Link } from 'react-router';
import { brand } from '#brand';
import { useHome, useNodeHome } from '../api/client';
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
      <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] 2xl:grid-rows-[auto_1fr]">
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
          className="2xl:col-start-1 2xl:row-start-1"
          bodyClassName="p-3"
        >
          {decisions.length ? (
            <ul className="grid gap-2 md:grid-cols-3 2xl:grid-cols-1">
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
          title="在跑的"
          description="每张开着的单在对题、动手、验收哪一段，谁在做、在等什么。单击卡片看详情，双击进单子。"
          className="min-w-0 2xl:col-start-2 2xl:row-span-2 2xl:row-start-1"
          bodyClassName="p-0"
        >
          {data.running.length ? (
            <RunningBoard running={data.running} flow={data.flow} health={data.health} />
          ) : (
            <Empty icon={CirclePlay} title="现在没有在跑的单" hint="新接的单会出现在这里。" />
          )}
        </Panel>

        <Panel
          title="做完的"
          description="最近合进去的 PR。"
          className="2xl:col-start-1 2xl:row-start-2"
          bodyClassName="p-3"
        >
          {done.length ? (
            <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-1">
              {done.map((d) => (
                <DoneCard key={d.prNumber} item={d} />
              ))}
            </ul>
          ) : (
            <Empty icon={CheckCheck} title="最近没有合进的 PR" hint="有 PR 合进主线会出现在这里。" />
          )}
        </Panel>
      </div>
    </>
  );
}

export default function Home() {
  // 选了远程环境（?node=）就渲染它最近一次推来的快照：同一套组件，只读、链接指向 GitHub、写按钮置灰
  const nodeId = useSelectedNodeId();
  const nodeName = useSelectedNodeName();
  const local = useHome({ enabled: nodeId === null });
  const remote = useNodeHome(nodeId);
  const state = nodeId === null ? local.data : remote.data;

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
      {state.status === 'loading' ? (
        <div className="mt-4">
          <LoadingRows rows={6} />
        </div>
      ) : state.status === 'error' ? (
        <div className="mt-4">
          <LoadError what="主页" error={state.error} onRetry={state.retry} />
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
