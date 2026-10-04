// 主页（/）：一屏三块 + 顶部持续状态条。
// 三块：要你拍的（最多 3 条，多的去通知中心）、在跑的（三段流水线图：每张单落在对题 / 动手 / 验收里它现在所在的那一段）、
// 做完的（最近 8 篇 PR）。「在跑的」那块的卡片就是原来在跑的列表，换成流水线图是因为「每张单走到了哪一步」是它的核心，
// 一列并排的卡片看不出先后（母单 #902，创始人 2026-10-05「驾驶舱的首页 react-flow 怎么没了」）。
// 版面：宽屏（2xl 起）左边要你拍的、右边流水线；窄一点要你拍的排在上面一条，流水线占满宽。要你拍的永远在流水线前面。

import { CheckCheck, CirclePlay, Hand } from 'lucide-react';
import { Link } from 'react-router';
import { brand } from '#brand';
import { useHome } from '../api/client';
import { DecisionCard } from '../components/home/decision-card';
import { DoneCard } from '../components/home/done-card';
import { FlowBoard } from '../components/home/flow-board';
import { HealthStrip } from '../components/home/health-strip';
import type { HomeData } from '../components/home/types';
import { NotBuilt } from '../components/not-built';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { Button } from '../components/ui/button';

export function meta() {
  return [{ title: brand.title('主页') }];
}

const MAX_DECISIONS = 3;
const MAX_DONE = 6;

function HomeBody({ data }: { data: HomeData }) {
  const decisions = data.decisions.slice(0, MAX_DECISIONS);
  const done = data.done.slice(0, MAX_DONE);
  const more = data.decisions.length - decisions.length;

  return (
    <>
      <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] 2xl:grid-rows-[auto_1fr]">
        <Panel
          title="要你拍的"
          description="决定、待批、追问。多的去通知中心。"
          actions={
            <Button asChild size="sm" variant="ghost" className="h-7">
              <Link to="/notifications">全部</Link>
            </Button>
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
            <Empty icon={Hand} title="没有要你拍的" hint="有决定、待批、追问时会出现在这里。" />
          )}
          {more > 0 ? (
            <p className="mt-3 px-1 text-xs text-muted-foreground">
              还有 <span className="num">{more}</span> 条，去
              <Link to="/notifications" className="underline underline-offset-2">
                通知中心
              </Link>
              看。
            </p>
          ) : null}
        </Panel>

        <Panel
          title="在跑的"
          description="每张开着的单走到三段里的哪一段、谁在做、在等什么。点卡片进单子详情。"
          className="2xl:col-start-2 2xl:row-span-2 2xl:row-start-1"
          bodyClassName="p-0"
        >
          {data.running.length ? (
            <FlowBoard running={data.running} flow={data.flow} />
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
  const { data: state } = useHome();

  return (
    <Page
      title="主页"
      // 持续状态条放在标题右边：首屏的高度留给要你拍的和流水线，不再单占一行
      actions={state.status === 'data' ? <HealthStrip health={state.data.health} /> : undefined}
      className="max-w-none"
    >
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
        <HomeBody data={state.data} />
      )}
    </Page>
  );
}
