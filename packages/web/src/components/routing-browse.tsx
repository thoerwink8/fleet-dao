// 路由页的「模型目录」「渠道」两块（#1366 第二部分）：左边一列定高的紧凑行（名字、状态点、开关），右边是选中那一行的路由。
// 目录会长到几百行：每块都有搜索框和「只看已开启」，行数超过 50 只画窗口里的行（lib/list-window.ts）；一次只看一块，页面不再一长条。
// 改这里之前必须知道：
// - 行是定高的（ROW_HEIGHT），窗口化靠它算位置：行里的字只许截断，不许换行撑高。
// - 开关状态只有路由两层里有。没配进任何用途的模型读不到它的路由开着没有：开关置灰、写明原因，不画成开或关。
// - 开关走 routing-edit.tsx 里现成的确认弹窗和接口；Fable 的「只有创始人在驾驶舱能开」判在后端，这里只标一句。

import { Search } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useRouting } from '../api/client';
import type { Route, RoutingLayerModel, RoutingLayers } from '../api/types';
import { hostLabel } from '../lib/catalog';
import { buildChannelCards, type ChannelCard } from '../lib/channel-status';
import { useNow } from '../lib/hooks';
import {
  filterActive,
  filterRows,
  type ListFilter,
  NO_FILTER,
  WINDOW_MIN_ROWS,
  windowRange,
} from '../lib/list-window';
import { countsText } from '../lib/route-state';
import { purposeLabel, routeTitle, verdictLabel, verdictTone } from '../lib/routing';
import { buildCatalog, type CatalogEntry, channelRoutes, isRetired } from '../lib/routing-browse';
import { cn } from '../lib/utils';
import { LoadError, LoadingRows, Panel } from './page';
import { ChannelSwitch, FounderOnlyBadge, ModelSwitch } from './routing-edit';
import { ModelRosterNotice } from './routing-roster';
import { ModelRoutes, RouteItem } from './routing-routes';
import { StatusChip, StatusDot } from './status';
import { Badge } from './ui/badge';

/** 紧凑行的高度（像素）和一屏高度：窗口化按它们算位置。 */
export const ROW_HEIGHT = 44;
export const LIST_HEIGHT = 440;

/** 搜索框和「只看已开启」。noun 是这一列叫什么（模型、渠道），给搜索框和读屏用。 */
export function ListFilterBar({
  noun,
  filter,
  onChange,
  total,
  shown,
}: {
  noun: string;
  filter: ListFilter;
  onChange: (next: ListFilter) => void;
  total: number;
  shown: number;
}) {
  return (
    <div className="space-y-2 border-b p-3">
      <label className="relative block">
        <span className="sr-only">搜索{noun}</span>
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
          placeholder={`搜${noun}的名字、编号`}
          aria-label={`搜索${noun}`}
          className="h-9 w-full rounded-lg border bg-background pl-8 pr-2.5 text-sub outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          aria-pressed={filter.onlyEnabled}
          onClick={() => onChange({ ...filter, onlyEnabled: !filter.onlyEnabled })}
          className={cn(
            'inline-flex h-7 items-center rounded-full border px-2.5 text-caption transition-colors hover:bg-muted',
            filter.onlyEnabled && 'border-border-strong bg-muted font-medium',
          )}
        >
          只看已开启
        </button>
        <span className="num text-caption text-muted-foreground" aria-live="polite">
          {filterActive(filter) ? `显示 ${shown} / 共 ${total} 个` : `共 ${total} 个`}
        </span>
      </div>
    </div>
  );
}

/** 定高行的窗口化列表（不能拖）。行数不超过 50 全画。 */
export function WindowedRows<T>({
  ariaLabel,
  items,
  itemId,
  empty,
  rowProps,
  rowClassName,
  children,
}: {
  ariaLabel: string;
  items: readonly T[];
  itemId: (item: T) => string;
  empty: string;
  rowProps?: (item: T) => Record<string, string | undefined>;
  rowClassName?: (item: T) => string | undefined;
  children: (item: T) => ReactNode;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  if (items.length === 0) {
    return <p className="px-3 py-8 text-center text-sub text-muted-foreground">{empty}</p>;
  }
  const total = items.length * ROW_HEIGHT;
  const range = windowRange({ count: items.length, rowHeight: ROW_HEIGHT, height: LIST_HEIGHT, scrollTop });
  return (
    <div
      data-windowed={items.length > WINDOW_MIN_ROWS ? 'true' : undefined}
      style={{ height: Math.min(LIST_HEIGHT, total) }}
      className="overflow-y-auto overscroll-contain"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <ul aria-label={ariaLabel} className="relative" style={{ height: total }}>
        {items.slice(range.start, range.end).map((item, k) => (
          <li
            key={itemId(item)}
            {...(rowProps?.(item) ?? {})}
            aria-posinset={range.start + k + 1}
            aria-setsize={items.length}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: (range.start + k) * ROW_HEIGHT,
              height: ROW_HEIGHT,
            }}
            className={cn('border-b', rowClassName?.(item))}
          >
            {children(item)}
          </li>
        ))}
      </ul>
    </div>
  );
}

const PROBE_WORD: Record<NonNullable<Route['probe']>['state'], string> = {
  ok: '探通',
  failed: '不通',
  skipped: '没探',
  not_wired: '插头没接',
};

// —— 模型目录 ——

export function ModelCatalogTab({ layers }: { layers: RoutingLayers }) {
  const routing = useRouting();
  const now = useNow();
  const entries = useMemo(() => buildCatalog(layers, routing.data), [layers, routing.data]);
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const [picked, setPicked] = useState<string | null>(null);
  const shown = useMemo(
    () =>
      filterRows(
        entries,
        filter,
        (e) => [e.displayName, e.modelId, e.family],
        (e) => e.switchKnown && e.enabled,
      ),
    [entries, filter],
  );
  const current = entries.find((e) => e.modelId === picked) ?? shown[0];
  return (
    <>
      <ModelRosterNotice layers={layers} />
      {routing.error ? (
        <div className="mb-4">
          <LoadError what="模型目录（没配进用途的模型读不到）" error={routing.error} />
        </div>
      ) : null}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <section
          aria-label="模型目录"
          className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-card-edge"
        >
          <ListFilterBar
            noun="模型"
            filter={filter}
            onChange={setFilter}
            total={entries.length}
            shown={shown.length}
          />
          <WindowedRows
            ariaLabel="目录里的模型"
            items={shown}
            itemId={(e) => e.modelId}
            empty={
              entries.length === 0
                ? '目录里一个模型都没有'
                : '没有符合的模型：换个搜索词，或关掉「只看已开启」'
            }
            rowProps={(e) => ({ 'data-catalog': e.modelId })}
            rowClassName={(e) => (e.modelId === current?.modelId ? 'bg-muted/60' : undefined)}
          >
            {(e) => (
              <CatalogRow
                entry={e}
                now={now}
                selected={e.modelId === current?.modelId}
                onPick={() => setPicked(e.modelId)}
              />
            )}
          </WindowedRows>
        </section>
        <div className="min-w-0">{current ? <CatalogDetail entry={current} now={now} /> : null}</div>
      </div>
    </>
  );
}

function entrySummary(e: CatalogEntry): string {
  if (e.purposes.length === 0) return `没配进用途 · ${e.routeCount} 条路由`;
  const live = e.routes.filter((r) => r.verdict === 'live').length;
  return `${e.purposes.map(purposeLabel).join('、')} · ${e.routeCount} 条路，${live} 条活`;
}

function CatalogRow({
  entry: e,
  now,
  selected,
  onPick,
}: {
  entry: CatalogEntry;
  now: number;
  selected: boolean;
  onPick: () => void;
}) {
  const retired = isRetired(e, now);
  const why = !e.switchKnown
    ? e.purposes.length === 0
      ? '还没配进任何用途，读不到它的路由开关；在用途里排上它之后才能开关'
      : '这个模型下一条路由都没有'
    : true;
  return (
    <div className="flex h-full items-center gap-2 px-3">
      <button
        type="button"
        onClick={onPick}
        aria-pressed={selected}
        aria-label={`查看 ${e.displayName} 的路由`}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
      >
        <StatusDot tone={e.verdict ? verdictTone[e.verdict] : 'stall'} className="shrink-0" />
        <span className="truncate text-sm font-semibold">{e.displayName}</span>
        <span className="sr-only">：{e.verdict ? verdictLabel[e.verdict] : '没配进用途，没算过'}</span>
        {e.family ? (
          <span className="hidden truncate text-caption text-muted-foreground sm:inline">{e.family}</span>
        ) : null}
        <FounderOnlyBadge modelId={e.modelId} family={e.family} displayName={e.displayName} />
        {retired ? (
          <Badge variant="outline" className="h-4 shrink-0 px-1 text-micro font-normal">
            已下架
          </Badge>
        ) : null}
        <span className="ml-auto hidden truncate text-caption text-muted-foreground md:inline">
          {entrySummary(e)}
        </span>
      </button>
      <ModelSwitch
        modelId={e.modelId}
        modelName={e.displayName}
        enabled={e.enabled}
        expectedEnabled={e.routes.filter((r) => r.enabled).map((r) => r.routeId)}
        unavailable={why === true ? false : why}
      />
    </div>
  );
}

function CatalogDetail({ entry: e, now }: { entry: CatalogEntry; now: number }) {
  const routing = useRouting();
  const model: RoutingLayerModel = {
    modelId: e.modelId,
    displayName: e.displayName,
    family: e.family,
    verdict: e.verdict ?? 'unknown',
    routes: e.routes,
  };
  const raw = (routing.data?.routes ?? []).filter((r) => r.modelId === e.modelId);
  const channelName = (id: string) => routing.data?.channels.find((c) => c.id === id)?.name ?? id;
  return (
    <Panel title={e.displayName} description={entrySummary(e)} bodyClassName="p-0">
      {e.switchKnown ? (
        <div className="overflow-hidden">
          <p className="border-b px-3 py-2 text-caption text-muted-foreground">
            路由的先后管这个模型在所有用途里：拖动、置顶、置底，或聚焦后 Alt+上下键。
          </p>
          <ModelRoutes model={model} now={now} />
        </div>
      ) : (
        <div>
          <p role="note" className="border-b px-3 py-2.5 text-sub text-muted-foreground">
            {e.purposes.length === 0
              ? '这个模型还没配进任何用途，路由开着没有读不到，开关先置灰；在用途里排上它之后就能开关。'
              : '这个模型下一条路由都没有：排了它也派不到它。'}
          </p>
          {raw.length === 0 ? null : (
            <ul aria-label={`${e.displayName} 在目录里的路由`}>
              {raw.map((r) => (
                <li
                  key={r.id}
                  data-route={r.id}
                  className="flex flex-wrap items-center gap-x-2 border-b px-3 py-2 text-sub last:border-b-0"
                >
                  <span className="font-medium">
                    {channelName(r.channelId)} · {r.poolId}
                  </span>
                  <span className="text-caption text-muted-foreground">
                    {hostLabel[r.hostId]} · {r.probe ? PROBE_WORD[r.probe.state] : '探针还没看过'}
                  </span>
                  <span className="num ml-auto truncate text-micro text-faint">{r.id}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

// —— 渠道 ——

export function ChannelTab({ layers }: { layers: RoutingLayers }) {
  const routing = useRouting();
  const now = useNow();
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const [picked, setPicked] = useState<string | null>(null);
  const cards = useMemo(
    () => (routing.data ? buildChannelCards(routing.data, layers, now) : []),
    [routing.data, layers, now],
  );
  const shown = useMemo(
    () =>
      filterRows(
        cards,
        filter,
        (c) => [c.channel.name, c.channel.id],
        (c) => c.channel.enabled,
      ),
    [cards, filter],
  );
  if (routing.error) return <LoadError what="渠道状态" error={routing.error} />;
  if (!routing.data) return <LoadingRows rows={4} />;
  const current = cards.find((c) => c.channel.id === picked) ?? shown[0];
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <section
        aria-label="渠道"
        className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-card-edge"
      >
        <ListFilterBar
          noun="渠道"
          filter={filter}
          onChange={setFilter}
          total={cards.length}
          shown={shown.length}
        />
        <WindowedRows
          ariaLabel="渠道列表"
          items={shown}
          itemId={(c) => c.channel.id}
          empty={
            cards.length === 0 ? '目录里一个渠道都没有' : '没有符合的渠道：换个搜索词，或关掉「只看已开启」'
          }
          rowProps={(c) => ({ 'data-channel': c.channel.id, 'data-kind': c.kind })}
          rowClassName={(c) => (c.channel.id === current?.channel.id ? 'bg-muted/60' : undefined)}
        >
          {(c) => (
            <ChannelRow
              card={c}
              selected={c.channel.id === current?.channel.id}
              onPick={() => setPicked(c.channel.id)}
            />
          )}
        </WindowedRows>
      </section>
      <div className="min-w-0">
        {current ? <ChannelDetail card={current} layers={layers} now={now} /> : null}
      </div>
    </div>
  );
}

function ChannelRow({
  card: c,
  selected,
  onPick,
}: {
  card: ChannelCard;
  selected: boolean;
  onPick: () => void;
}) {
  const quiet = c.kind === 'off' || c.kind === 'unused' || c.kind === 'retired';
  return (
    <div className="flex h-full items-center gap-2 px-3">
      <button
        type="button"
        onClick={onPick}
        aria-pressed={selected}
        aria-label={`查看 ${c.channel.name} 的路由`}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
      >
        <StatusDot tone={c.tone} className="shrink-0" />
        <span className={cn('truncate text-sm font-semibold', quiet && 'text-muted-foreground')}>
          {c.channel.name}
        </span>
        <StatusChip tone={c.tone} label={c.label} className="shrink-0" />
        <span className="ml-auto hidden truncate text-caption text-muted-foreground md:inline">
          {countsText(c.counts)}
        </span>
      </button>
      <ChannelSwitch channelId={c.channel.id} name={c.channel.name} enabled={c.channel.enabled} />
    </div>
  );
}

function ChannelDetail({ card: c, layers, now }: { card: ChannelCard; layers: RoutingLayers; now: number }) {
  const routing = useRouting();
  const { inLayers, others } = channelRoutes(c.channel.id, layers, routing.data);
  return (
    <Panel
      title={c.channel.name}
      description={c.reason ?? countsText(c.counts)}
      actions={<StatusChip tone={c.tone} label={c.label} />}
      bodyClassName="p-0"
    >
      <p className="border-b px-3 py-2 text-caption text-muted-foreground">
        {countsText(c.counts)} ·{' '}
        <Link
          to={`/routing/status?p=${encodeURIComponent(c.channel.id)}`}
          className="underline underline-offset-2 hover:text-foreground"
        >
          看原文、立即探测
        </Link>
      </p>
      {inLayers.length === 0 && others.length === 0 ? (
        <p className="px-3 py-6 text-center text-sub text-muted-foreground">这个渠道下一条路由都没有</p>
      ) : null}
      {inLayers.length > 0 ? (
        <ol aria-label={`${c.channel.name} 的路由`}>
          {inLayers.map(({ route, modelId, modelName }) => (
            <li
              key={route.routeId}
              data-route={route.routeId}
              className={cn('border-b px-3 py-2.5 last:border-b-0', !route.enabled && 'bg-muted/30')}
            >
              <RouteItem
                route={route}
                modelId={modelId}
                modelName={modelName}
                modelLabel={modelName}
                now={now}
              />
            </li>
          ))}
        </ol>
      ) : null}
      {others.length > 0 ? (
        <div>
          <p className="border-y bg-muted/30 px-3 py-1.5 text-caption text-muted-foreground">
            没配进任何用途的路由（读不到开关）
          </p>
          <ul aria-label={`${c.channel.name} 里没配进用途的路由`}>
            {others.map(({ route, modelName }) => (
              <li
                key={route.id}
                data-route={route.id}
                className="flex flex-wrap items-center gap-x-2 border-b px-3 py-2 text-sub last:border-b-0"
              >
                <span className="font-medium">
                  {routeTitle({ channelName: c.channel.name, poolId: route.poolId })}
                </span>
                <span className="text-caption text-muted-foreground">
                  {modelName} · {hostLabel[route.hostId]} ·{' '}
                  {route.probe ? PROBE_WORD[route.probe.state] : '探针还没看过'}
                </span>
                <span className="num ml-auto truncate text-micro text-faint">{route.id}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}
