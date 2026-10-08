// 路由页的「模型目录」「渠道」两块（#1366 第二部分）：左边一列定高的紧凑行（名字、状态点、开关），右边是选中那一行的路由。
// 目录会长到几百行：每块都有搜索框和「只看已开启」，行数超过 50 只画窗口里的行（lib/list-window.ts）；一次只看一块，页面不再一长条。
// 改这里之前必须知道：
// - 行是定高的，窗口化靠它算位置。手机宽度（md 以下）一行拆成两行，用更高的 MOBILE_ROW_HEIGHT，不能让字撑破行高。
// - 模型目录在手机宽度不设内部定高滚动（手指落在列表上要滚的是页面）。桌面仍是 LIST_HEIGHT 的窗口。渠道列表不动。
// - 开关状态只有路由两层里有。没配进任何用途的模型读不到它的路由开着没有：开关置灰、写明原因，不画成开或关。
// - 开关走 routing-edit.tsx 里现成的确认弹窗和接口；Fable 的「只有创始人在驾驶舱能开」判在后端，这里只标一句。

import { founderOnlyFor } from '@fleet-dao/shared';
import { ChevronRight, Search } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useRouting } from '../api/client';
import type { Route, RoutingLayerModel, RoutingLayers } from '../api/types';
import { hostLabel } from '../lib/catalog';
import { buildChannelCards, type ChannelCard } from '../lib/channel-status';
import { useMediaQuery, useNow } from '../lib/hooks';
import {
  filterActive,
  filterRows,
  type ListFilter,
  NO_FILTER,
  WINDOW_MIN_ROWS,
  windowRange,
} from '../lib/list-window';
import { modelKind } from '../lib/route-kinds';
import { countsText, type KindCounts } from '../lib/route-state';
import { purposeLabel, routeTitle } from '../lib/routing';
import {
  buildCatalog,
  CATALOG_STATUSES,
  type CatalogEntry,
  type CatalogFilter,
  type CatalogStatus,
  type CatalogVisual,
  catalogFilterActive,
  catalogMarks,
  channelRoutes,
  filterCatalog,
  flattenCatalog,
  groupCatalog,
  NO_CATALOG_FILTER,
} from '../lib/routing-browse';
import { cn } from '../lib/utils';
import { LoadError, LoadingRows, Panel } from './page';
import { ChannelSwitch, FounderOnlyBadge, ModelSwitch } from './routing-edit';
import { KindChip, KindDot, useKindEnv } from './routing-kinds';
import { isManualChannel, ManualModelForm } from './routing-membership';
import { ModelRosterNotice } from './routing-roster';
import { ModelRoutes, RouteItem } from './routing-routes';
import { StatusChip, StatusDot } from './status';

/** 紧凑行的高度（像素）和一屏高度：窗口化按它们算位置。手机宽度两行，用更高的行高。 */
export const ROW_HEIGHT = 44;
export const MOBILE_ROW_HEIGHT = 80;
export const LIST_HEIGHT = 440;

/** Tailwind `md`（768px）以下。 */
export const MOBILE_MQ = '(max-width: 767px)';

/** 手机上点一行后，把详情滚进画面。宽屏两栏并排，不滚。 */
export function revealOnMobile(id: string) {
  if (!window.matchMedia?.(MOBILE_MQ).matches) return;
  document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function rowHeightNow(mobile: boolean): number {
  return mobile ? MOBILE_ROW_HEIGHT : ROW_HEIGHT;
}

/** 筛选芯片：按下用深色边框加底，和没按下分开。 */
function filterChipClass(pressed: boolean): string {
  return cn(
    'inline-flex h-7 items-center rounded-full border px-2.5 text-caption transition-colors',
    pressed
      ? 'border-foreground bg-foreground/10 font-semibold'
      : 'border-border bg-background hover:bg-muted',
  );
}

function choiceClass(selected: boolean, extra?: string): string {
  return cn(
    'h-7 rounded-md border px-1.5 text-caption',
    selected ? 'border-foreground bg-foreground/10 font-medium' : 'border-border bg-background',
    extra,
  );
}

/** 搜索框和「只看已开启」。noun 是这一列叫什么（模型、渠道），给搜索框和读屏用。 */
export function ListFilterBar({
  noun,
  filter,
  onChange,
  total,
  shown,
  active,
  onClear,
}: {
  noun: string;
  filter: ListFilter;
  onChange: (next: ListFilter) => void;
  total: number;
  shown: number;
  /** 目录上还有厂家、渠道、状态筛时，由调用方说「现在算不算在筛」。 */
  active?: boolean;
  /** 不给就只清搜索和「只看已开启」。目录要连厂家、渠道、状态一起清。 */
  onClear?: () => void;
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
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={filter.onlyEnabled}
            onClick={() => onChange({ ...filter, onlyEnabled: !filter.onlyEnabled })}
            className={filterChipClass(filter.onlyEnabled)}
          >
            只看已开启
          </button>
          <button
            type="button"
            onClick={() => (onClear ? onClear() : onChange({ ...filter, query: '', onlyEnabled: false }))}
            className="inline-flex h-7 items-center rounded-full border border-border bg-background px-2.5 text-caption hover:bg-muted"
          >
            清除筛选
          </button>
        </div>
        <span className="num text-caption text-muted-foreground" aria-live="polite">
          {(active ?? filterActive(filter)) ? `显示 ${shown} / 共 ${total} 个` : `共 ${total} 个`}
        </span>
      </div>
    </div>
  );
}

/** 定高行的窗口化列表（不能拖）。行数不超过 50 全画。flow 时不设内部滚动，行跟页面一起滚（手机上的模型目录）。 */
export function WindowedRows<T>({
  ariaLabel,
  items,
  itemId,
  empty,
  rowProps,
  rowClassName,
  rowHeight = ROW_HEIGHT,
  flow = false,
  children,
}: {
  ariaLabel: string;
  items: readonly T[];
  itemId: (item: T) => string;
  empty: string;
  rowProps?: (item: T) => Record<string, string | undefined>;
  rowClassName?: (item: T) => string | undefined;
  rowHeight?: number;
  /** 手机宽度：去掉内部定高滚动，行高仍给定，整列随页面滚。 */
  flow?: boolean;
  children: (item: T) => ReactNode;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  if (items.length === 0) {
    return <p className="px-3 py-8 text-center text-sub text-muted-foreground">{empty}</p>;
  }
  const total = items.length * rowHeight;
  if (flow) {
    return (
      <div
        data-page-scroll="true"
        className="h-auto overflow-visible md:h-routing-window md:overflow-y-auto md:overscroll-contain"
      >
        <ul aria-label={ariaLabel}>
          {items.map((item, k) => (
            <li
              key={itemId(item)}
              {...(rowProps?.(item) ?? {})}
              aria-posinset={k + 1}
              aria-setsize={items.length}
              style={{ height: rowHeight }}
              className={cn('border-b', rowClassName?.(item))}
            >
              {children(item)}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const range = windowRange({ count: items.length, rowHeight, height: LIST_HEIGHT, scrollTop });
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
              top: (range.start + k) * rowHeight,
              height: rowHeight,
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

const STATUS_LABEL: Record<CatalogStatus, string> = {
  discovered: '新发现',
  retired: '已下架',
  off: '关着',
  locked: '锁住',
};

export function ModelCatalogTab({ layers }: { layers: RoutingLayers }) {
  const routing = useRouting();
  const now = useNow();
  const mobile = useMediaQuery(MOBILE_MQ);
  const entries = useMemo(() => buildCatalog(layers, routing.data), [layers, routing.data]);
  const [filter, setFilter] = useState<CatalogFilter>(NO_CATALOG_FILTER);
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const shown = useMemo(() => filterCatalog(entries, filter, now), [entries, filter, now]);
  const visuals = useMemo(() => flattenCatalog(groupCatalog(shown), openGroups), [shown, openGroups]);
  const vendors = useMemo(
    () => [...new Set(entries.map((e) => e.family).filter((family) => family !== ''))].sort(),
    [entries],
  );
  const current = shown.find((e) => e.modelId === picked) ?? shown[0];
  const extra = filter.vendor !== '' || filter.channel !== '' || filter.statuses.length > 0;
  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleStatus = (status: CatalogStatus) =>
    setFilter((prev) => ({
      ...prev,
      statuses: prev.statuses.includes(status)
        ? prev.statuses.filter((item) => item !== status)
        : [...prev.statuses, status],
    }));
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
            onChange={(next) =>
              setFilter((prev) => ({ ...prev, query: next.query, onlyEnabled: next.onlyEnabled }))
            }
            total={entries.length}
            shown={shown.length}
            active={catalogFilterActive(filter)}
            onClear={() => setFilter(NO_CATALOG_FILTER)}
          />
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
            <select
              aria-label="按厂家筛选"
              value={filter.vendor}
              onChange={(e) => setFilter((prev) => ({ ...prev, vendor: e.target.value }))}
              className={choiceClass(filter.vendor !== '')}
            >
              <option value="">全部厂家</option>
              {vendors.map((vendor) => (
                <option key={vendor} value={vendor}>
                  {vendor}
                </option>
              ))}
            </select>
            <select
              aria-label="按渠道筛选"
              value={filter.channel}
              onChange={(e) => setFilter((prev) => ({ ...prev, channel: e.target.value }))}
              className={choiceClass(filter.channel !== '', 'max-w-40')}
            >
              <option value="">全部渠道</option>
              {(routing.data?.channels ?? []).map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </select>
            {CATALOG_STATUSES.map((status) => {
              const on = filter.statuses.includes(status);
              return (
                <button
                  key={status}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleStatus(status)}
                  className={filterChipClass(on)}
                >
                  {STATUS_LABEL[status]}
                </button>
              );
            })}
          </div>
          <WindowedRows
            ariaLabel="目录里的模型"
            rowHeight={rowHeightNow(mobile)}
            flow={mobile}
            items={visuals}
            itemId={(row) => (row.kind === 'group' ? `group:${row.group.key}` : row.entry.modelId)}
            empty={
              entries.length === 0
                ? '目录里一个模型都没有'
                : extra
                  ? '没有符合的模型：换个厂家、渠道或状态'
                  : '没有符合的模型：换个搜索词，或关掉「只看已开启」'
            }
            rowProps={(row) =>
              row.kind === 'entry'
                ? { 'data-catalog': row.entry.modelId }
                : { 'data-catalog-group': row.group.key }
            }
            rowClassName={(row) =>
              row.kind === 'entry' && row.entry.modelId === current?.modelId ? 'bg-muted/60' : undefined
            }
          >
            {(row) => (
              <CatalogVisualRow
                row={row}
                now={now}
                open={row.kind === 'group' && openGroups.has(row.group.key)}
                selected={row.kind === 'entry' && row.entry.modelId === current?.modelId}
                onPick={(modelId) => {
                  setPicked(modelId);
                  revealOnMobile('routing-catalog-detail');
                }}
                onToggle={toggleGroup}
              />
            )}
          </WindowedRows>
        </section>
        <div id="routing-catalog-detail" className="min-w-0 scroll-mt-4">
          {current ? <CatalogDetail entry={current} now={now} /> : null}
        </div>
      </div>
    </>
  );
}

function entrySummary(e: CatalogEntry): string {
  if (e.purposes.length === 0) return `没配进用途 · ${e.routeCount} 条路由`;
  const live = e.routes.filter((r) => r.verdict === 'live').length;
  return `${e.purposes.map(purposeLabel).join('、')} · ${e.routeCount} 条路，${live} 条活`;
}

const MARK_TONE = {
  discovered: 'text-ink-done',
  retired: 'text-ink-stop',
  locked: 'text-ink-stall',
} as const;

function CatalogMark({
  tone,
  children,
  title,
}: {
  tone: keyof typeof MARK_TONE;
  children: string;
  title?: string | undefined;
}) {
  return (
    <span
      data-catalog-mark={tone}
      title={title}
      className={cn(
        'inline-flex h-4 shrink-0 items-center rounded border border-current px-1 text-micro font-semibold',
        MARK_TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

function CatalogVisualRow({
  row,
  now,
  open,
  selected,
  onPick,
  onToggle,
}: {
  row: CatalogVisual;
  now: number;
  open: boolean;
  selected: boolean;
  onPick: (modelId: string) => void;
  onToggle: (key: string) => void;
}) {
  if (row.kind === 'group') {
    const enabledCount = row.group.members.filter((member) => member.switchKnown && member.enabled).length;
    return (
      <div className="flex h-full items-center gap-2 px-3">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? '收起' : '展开'} ${row.group.label} 的变体`}
          onClick={() => onToggle(row.group.key)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            aria-hidden
            data-variant-arrow={open ? 'open' : 'closed'}
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
          <span className="min-w-0 whitespace-normal break-words text-sm font-semibold md:truncate">
            {row.group.label}
          </span>
          <span className="shrink-0 text-caption text-muted-foreground">
            {row.group.members.length} 个变体
          </span>
          <span className="shrink-0 text-caption text-muted-foreground">{enabledCount} 个已开</span>
        </button>
      </div>
    );
  }
  return (
    <CatalogRow
      entry={row.entry}
      now={now}
      nested={row.nested}
      selected={selected}
      onPick={() => onPick(row.entry.modelId)}
    />
  );
}

function CatalogRow({
  entry: e,
  now,
  nested,
  selected,
  onPick,
}: {
  entry: CatalogEntry;
  now: number;
  nested: boolean;
  selected: boolean;
  onPick: () => void;
}) {
  const marks = catalogMarks(e, now);
  const founder = founderOnlyFor({ id: e.modelId, family: e.family, displayName: e.displayName });
  // 状态词和颜色按路由八态合成；没配进用途的模型读不到三件事，不画态
  const kind = modelKind(e, useKindEnv());
  const why = !e.switchKnown
    ? e.purposes.length === 0
      ? '还没配进任何用途，读不到它的路由开关；在用途里排上它之后才能开关'
      : '这个模型下一条路由都没有'
    : true;
  return (
    <div
      className={cn(
        'flex h-full flex-col justify-center gap-0.5 px-3 py-1 md:flex-row md:items-center md:gap-2 md:py-0',
        nested && 'pl-6',
      )}
    >
      <button
        type="button"
        onClick={onPick}
        aria-pressed={selected}
        aria-label={`查看 ${e.displayName} 的路由`}
        className="flex min-w-0 items-center gap-2 text-left md:h-full md:flex-1"
      >
        <KindDot
          kind={kind}
          whyNot={e.purposes.length === 0 ? '没配进用途，没算过' : '一条路由都没有'}
          className="shrink-0"
        />
        <span
          data-row-name
          className="min-w-0 whitespace-normal break-words text-sm font-semibold leading-snug md:truncate"
        >
          {e.displayName}
        </span>
        <FounderOnlyBadge modelId={e.modelId} family={e.family} displayName={e.displayName} />
      </button>
      <div data-row-meta className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        {e.family ? (
          <span data-vendor className="truncate text-caption text-muted-foreground">
            {e.family}
          </span>
        ) : null}
        <span data-status-word className="shrink-0">
          {kind !== null ? (
            <KindChip kind={kind} />
          ) : (
            <span className="text-caption text-muted-foreground">
              {e.purposes.length === 0 ? '没配进用途' : '一条路由都没有'}
            </span>
          )}
        </span>
        {marks.discovered ? <CatalogMark tone="discovered">新发现</CatalogMark> : null}
        {marks.retired ? (
          <CatalogMark tone="retired" title="目录里标了下架">
            已下架
          </CatalogMark>
        ) : null}
        {marks.locked && !founder ? (
          <CatalogMark tone="locked" title={marks.lockWhy}>
            锁住
          </CatalogMark>
        ) : null}
        <span data-route-summary className="min-w-0 truncate text-caption text-muted-foreground">
          {entrySummary(e)}
        </span>
        {nested && e.purposes.length === 0 ? (
          <span className="text-caption text-muted-foreground">没配进用途</span>
        ) : null}
        <ModelSwitch
          modelId={e.modelId}
          modelName={e.displayName}
          enabled={e.enabled}
          expectedEnabled={e.routes.filter((r) => r.enabled).map((r) => r.routeId)}
          unavailable={why === true ? false : why}
        />
      </div>
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

/** 渠道行第二行：这个渠道下一共几条路由、其中几条在线。厂家这一列没有。 */
function channelRouteLine(counts: KindCounts): string {
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  return `${total} 条路，${counts.live} 条活`;
}

export function ChannelTab({ layers }: { layers: RoutingLayers }) {
  const routing = useRouting();
  const now = useNow();
  const mobile = useMediaQuery(MOBILE_MQ);
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
          rowHeight={rowHeightNow(mobile)}
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
              onPick={() => {
                setPicked(c.channel.id);
                revealOnMobile('routing-channel-detail');
              }}
            />
          )}
        </WindowedRows>
      </section>
      <div id="routing-channel-detail" className="min-w-0 scroll-mt-4">
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
    <div className="flex h-full flex-col justify-center gap-0.5 px-3 py-1 md:flex-row md:items-center md:gap-2 md:py-0">
      <button
        type="button"
        onClick={onPick}
        aria-pressed={selected}
        aria-label={`查看 ${c.channel.name} 的路由`}
        className="flex min-w-0 items-center gap-2 text-left md:h-full md:flex-1"
      >
        <StatusDot tone={c.tone} className="shrink-0" />
        <span
          data-row-name
          className={cn(
            'min-w-0 whitespace-normal break-words text-sm font-semibold leading-snug md:truncate',
            quiet && 'text-muted-foreground',
          )}
        >
          {c.channel.name}
        </span>
      </button>
      <div data-row-meta className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span data-status-word className="shrink-0">
          <StatusChip tone={c.tone} label={c.label} />
        </span>
        <span data-route-summary className="min-w-0 truncate text-caption text-muted-foreground">
          {channelRouteLine(c.counts)}
        </span>
        <ChannelSwitch channelId={c.channel.id} name={c.channel.name} enabled={c.channel.enabled} />
      </div>
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
      {isManualChannel(c.channel.id, c.channel.name, layers.modelRoster?.manual) ? (
        <ManualModelForm channelId={c.channel.id} />
      ) : null}
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
