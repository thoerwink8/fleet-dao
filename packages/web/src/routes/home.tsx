// 主页（/）：一屏三块 + 顶部持续状态条。
// 三块：要你拍的（最多 3 条，多的去通知中心）、在跑的（最多 8 张）、做完的（最近 8 篇 PR）。
// home-api 切片出来之前 data 走 NotBuilt 占位，形状已经按 types.ts 钉住，切片落地时这个文件不用再改。

import { CheckCheck, CirclePlay, Hand } from 'lucide-react';
import { Link } from 'react-router';
import { brand } from '#brand';
import { useHome } from '../api/client';
import { DecisionCard } from '../components/home/decision-card';
import { DoneCard } from '../components/home/done-card';
import { HealthStrip } from '../components/home/health-strip';
import { RunningCard } from '../components/home/running-card';
import type { HomeData } from '../components/home/types';
import { NotBuilt } from '../components/not-built';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { Button } from '../components/ui/button';

export function meta() {
  return [{ title: brand.title('主页') }];
}

const MAX_DECISIONS = 3;
const MAX_RUNNING = 8;
const MAX_DONE = 8;

function HomeBody({ data }: { data: HomeData }) {
  const decisions = data.decisions.slice(0, MAX_DECISIONS);
  const running = data.running.slice(0, MAX_RUNNING);
  const done = data.done.slice(0, MAX_DONE);
  const more = data.decisions.length - decisions.length;

  return (
    <>
      <section className="mt-4">
        <HealthStrip health={data.health} />
      </section>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Panel
          title="要你拍的"
          description="决定、待批、追问。多的去通知中心。"
          actions={
            <Button asChild size="sm" variant="ghost" className="h-7">
              <Link to="/notifications">全部</Link>
            </Button>
          }
          bodyClassName="p-3"
        >
          {decisions.length ? (
            <ul className="space-y-2">
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

        <Panel title="在跑的" description="现在每张单做到哪一段、在等什么。" bodyClassName="p-3">
          {running.length ? (
            <ul className="space-y-2">
              {running.map((r) => (
                <RunningCard key={r.issueNumber} item={r} />
              ))}
            </ul>
          ) : (
            <Empty icon={CirclePlay} title="现在没有在跑的单" hint="新接的单会出现在这里。" />
          )}
        </Panel>

        <Panel title="做完的" description="最近合进去的 PR。" bodyClassName="p-3">
          {done.length ? (
            <ul className="space-y-2">
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
    <Page title="主页" description="一屏三块：要你拍的、在跑的、做完的。上面是持续状态。">
      {state.status === 'loading' ? (
        <div className="mt-4">
          <LoadingRows rows={6} />
        </div>
      ) : state.status === 'error' ? (
        <div className="mt-4">
          <LoadError what="主页" error={state.error} />
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
