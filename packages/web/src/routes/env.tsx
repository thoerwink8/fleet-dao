// 环境页「环境」（#820 片 1，只读；顶上多一张能点的「引擎总开关」卡，#1086，见 components/engine-master-card.tsx）：
// 每个环境现在怎样，一项一个「查成了 / 没查成 + 原因」，几个环境并排比。
//
// 只读、不跨环境写、不开口子：本台读的是本后端自己库里的现成读法（/api/env 一处聚合，见 packages/api/src/env-view.ts），
// 远程环境读的是它自己推来的快照。
// 要做成什么（specs/820-驾驶舱环境视图与中止恢复/方案.md §5 片 1）：
// - 「回来看一眼」时，一眼看到：引擎在不在、在用哪版、落后主线没有、手上几个会话在跑、池占几个、健康红几项、最近拉单；
// - 读不到的格子明说「没查成」和原因，不拿空或 0 冒充正常（通用段「底线」）；一项读失败不连累别的项；
// - 引擎「按配置没开」用等待色，不画成红：红了表示「真坏了要当场修」，按配置关着不是坏了。
// 六格怎么画在 components/env-facts.tsx（和法国页共用）。
//
// 版式（驾驶舱改版 2026-10-07）：几个环境时是一张对照表——每个环境一列，六项各占一行，用 subgrid 让同一项在各列横着对齐，
// 一眼比出哪一台不一样；只有本台一个时六格排成三列两行。原来每列六张高卡片竖着堆，1920×1080 只看得到前四项。
//
// 改这里之前必须知道：
// - 这一页只在正式驾驶舱里（演示版没有这个模块，导航不给 module、路由表也不放）：它露机器名、在用版本、在跑会话数（R10）。

import { ServerCog } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { brand } from '#brand';
import { useEnv, useNodeSnapshots, useNodes } from '../api/client';
import { EngineMasterControl } from '../components/engine-master-card';
import { FACT_ROWS, factCells, factsSummary } from '../components/env-facts';
import { LoadError, LoadingRows, Page } from '../components/page';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { freshnessNow, nodeAgeText, useNodeSelection } from '../lib/node';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('环境') }];
}

/**
 * 一列的外框：环境名（h2）、本台还是远程、「读于 / 上报于 / 失联多久」、选中时描边。
 * 并排时这一列占父网格的 1 + 6 行（subgrid），六格各落一行，和别的列同一项横着对齐。
 */
function EnvColumn({
  id,
  name,
  badge,
  age,
  tone,
  selected,
  note,
  single,
  children,
}: {
  id: string;
  name: string;
  badge: string;
  age: string;
  tone: 'ok' | 'stale';
  selected: boolean;
  note?: ReactNode;
  single: boolean;
  children: ReactNode;
}) {
  return (
    <section
      data-env-column={id}
      data-env-column-state={tone}
      data-env-selected={selected}
      className={cn(
        'min-w-0 overflow-hidden rounded-xl border bg-card shadow-card-edge',
        !single && 'row-span-7 grid grid-rows-subgrid gap-0',
        selected && 'border-brand/60 ring-1 ring-brand/30',
      )}
    >
      <header className="px-4 py-3">
        <h2 className="flex min-w-0 items-center gap-2 text-strong font-semibold tracking-tight">
          <ServerCog className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate">{name}</span>
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
            {badge}
          </span>
        </h2>
        <p
          data-env-age
          className={cn('num mt-1 text-xs', tone === 'stale' ? 'text-ink-stall' : 'text-muted-foreground')}
        >
          {age}
        </p>
        {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
      </header>
      {single ? (
        <div
          className={cn(
            'grid gap-px border-t bg-border sm:grid-cols-2 xl:grid-cols-3 [&>*]:border-t-0 [&>*]:bg-card',
            tone === 'stale' && 'opacity-70',
          )}
        >
          {children}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

/** 一列里占满六行的那一块（没收到快照、读失败、在读）：并排时跨六行，单列时照常。 */
function Whole({ children }: { children: ReactNode }) {
  const style: CSSProperties = { gridRow: `span ${FACT_ROWS}` };
  return (
    <div className="border-t p-4" style={style}>
      {children}
    </div>
  );
}

export default function Env() {
  const local = useEnv();
  const nodes = useNodes();
  const { nodeId } = useNodeSelection();
  const now = useNow();
  const remote = nodes.data?.nodes ?? [];
  // 收到过快照的远程环境各读一份；从没收到过的（never）没有快照可读，那一列只写「从没收到过」
  const received = remote.filter((n) => n.receivedAt !== undefined);
  const snapshots = useNodeSnapshots(received.map((n) => n.id));
  const single = remote.length === 0 && !nodes.error;
  const look = 'row' as const;

  return (
    <Page
      title="环境"
      description="每个环境一列并排比：引擎、在跑的会话、池占用、健康、在用版本、最近拉单。读不到的写「没查成」和原因；远程环境的数是它推来的快照，写明上报于几分钟前、失联多久。"
    >
      {nodes.error ? (
        <div className="mb-3">
          <LoadError what="远程环境列表" error={nodes.error} onRetry={() => void nodes.refetch()} />
        </div>
      ) : null}
      {/* 引擎总开关（#1086）：选了远程环境时显示它的状态、只读，写明去那台上操作；本台能点（二次确认、写操作记录） */}
      <EngineMasterControl />
      <div
        className="grid gap-x-4 gap-y-0"
        style={single ? undefined : { gridTemplateColumns: `repeat(${1 + remote.length}, minmax(0, 1fr))` }}
      >
        {local.error ? (
          <LoadError what="本台的环境页" error={local.error} onRetry={() => void local.refetch()} />
        ) : local.isLoading || !local.data ? (
          <LoadingRows rows={4} />
        ) : (
          <EnvColumn
            id="local"
            name={local.data.name.name}
            badge="本台"
            age={`${formatAgo(local.data.asOf, now)}读`}
            tone="ok"
            selected={!single && nodeId === null}
            single={single}
            note={
              local.data.name.problem ? (
                <>
                  {local.data.name.problem}
                  {factsSummary(local.data.facts) ? <> · {factsSummary(local.data.facts)}</> : null}
                </>
              ) : (
                factsSummary(local.data.facts)
              )
            }
          >
            {factCells({ facts: local.data.facts, now, kind: 'env', look })}
          </EnvColumn>
        )}
        {remote.map((n) => {
          const f = freshnessNow(n, now);
          const idx = received.findIndex((r) => r.id === n.id);
          const snap = idx < 0 ? undefined : snapshots[idx];
          const age = nodeAgeText(n, now);
          const body =
            f === 'never' || snap === undefined ? (
              <Whole>
                <p data-env-never className="text-sm text-muted-foreground">
                  配了通行证，但从没收到过{n.name}
                  的快照：先去那台上把推送接上（docs/ops.md「接上法国看板」）。
                </p>
              </Whole>
            ) : snap.error ? (
              <Whole>
                <LoadError what={`${n.name}的快照`} error={snap.error} onRetry={() => void snap.refetch()} />
              </Whole>
            ) : snap.data ? (
              <div className={cn('contents', f !== 'fresh' && '[&>*]:opacity-70')}>
                {factCells({ facts: snap.data.env.facts, now, kind: 'env', look })}
              </div>
            ) : (
              <Whole>
                <LoadingRows rows={4} />
              </Whole>
            );
          return (
            <EnvColumn
              key={n.id}
              id={n.id}
              name={snap?.data?.name ?? n.name}
              badge="远程"
              age={f === 'fresh' ? `上报于 ${age}` : age}
              tone={f === 'fresh' ? 'ok' : 'stale'}
              selected={nodeId === n.id}
              single={false}
              note={
                f === 'stale'
                  ? '下面是它最后一次报的样子，不是现在的；要看现在的请去那台上看。'
                  : f === 'fresh'
                    ? '只读快照：写操作（暂停派活、叫停）要去那台上做。'
                    : undefined
              }
            >
              {body}
            </EnvColumn>
          );
        })}
      </div>
    </Page>
  );
}
