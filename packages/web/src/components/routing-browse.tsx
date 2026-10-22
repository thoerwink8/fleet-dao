// 路由页的「模型目录」「渠道」两块（#1366 第二部分）：左边一列定高的行，右边是选中那一行的路由。
// 目录会长到几百行：每块都有搜索框和「只看已开启」，行数超过 50 只画窗口里的行（lib/list-window.ts）；一次只看一块，页面不再一长条。
// 按路由页样板重做（#1916，样板 #1914）：一行一个主信息一个状态——第一行名字加一个状态，第二行一行灰字小字（厂家、配进哪些用途、
// 几条路几条活），右边开关；桌面、手机同一个样子，只是手机行高一点。筛选两层：搜索一层，其余筛选一层（手机横滑）。
// 改这里之前必须知道：
// - 行是定高的，窗口化靠它算位置（桌面 ROW_HEIGHT、手机 MOBILE_ROW_HEIGHT）。行里两行字都不折：放不下截断，整句在悬停里，不能让字撑破行高。
// - 模型目录在手机宽度不设内部定高滚动（手指落在列表上要滚的是页面）。桌面仍是 LIST_HEIGHT 的窗口。渠道列表不动。
// - 开关状态只有路由两层里有。没配进任何用途的模型读不到它的路由开着没有：开关置灰、写明原因，不画成开或关。
// - 开关走 routing-edit.tsx 里现成的确认弹窗和接口；Fable 的「只有创始人在驾驶舱能开」判在后端，这里只标一句。

import { founderOnlyFor } from '@fleet-dao/shared';
import { type ReactNode, useMemo, useState } from 'react';
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
import type { StatusKey } from '../theme/status-dict';
import { Button } from './layout/button';
import { EmptyState } from './layout/empty-state';
import { List, RowDetail, RowFrame } from './layout/list';
import { LoadError, LoadingRows } from './layout/load-state';
import { NativeSelect } from './layout/native-select';
import { DisclosureIcon, RowButton } from './layout/row-button';
import { ScrollRow } from './layout/scroll-row';
import { SearchInput } from './layout/search-input';
import { Section, SectionGrid } from './layout/section';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Tag, type TagTone } from './layout/tag';
import { Text } from './layout/text';
import { Toggle } from './layout/toggle';
import { RowItem, WindowBox, WindowList } from './layout/windowed';
import { ModelStrengthBadge } from './model-strength-badge';
import { ChannelSwitch, FounderOnlyBadge, ModelSwitch } from './routing-edit';
import { RouteEffortInline } from './routing-efforts';
import { KindChip, KindDot, useKindEnv } from './routing-kinds';
import { isManualChannel, ManualModelForm } from './routing-membership';
import { ModelRosterNotice } from './routing-roster';
import { ModelRoutes, OrderSummaryLine, RouteItem, useRouteOrder } from './routing-routes';

/**
 * 定高行的高度（像素）和一屏高度：窗口化按它们算位置。
 * 两行字（名字一行加一行小字）：桌面 48，和样板的 row-tall 一样；手机 56，点得准、两行也放得下（#1916，原来手机一行拆三行用 80）。
 */
export const ROW_HEIGHT = 48;
export const MOBILE_ROW_HEIGHT = 56;
export const LIST_HEIGHT = 440;

/** Tailwind `md`（768px）以下。 */
export const MOBILE_MQ = '(max-width: 767px)';

/** 手机上点一行后，把详情滚进画面。宽屏两栏并排，不滚。 */
export function revealOnMobile(id: string) {
  if (!window.matchMedia?.(MOBILE_MQ).matches) return;
  document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** 现在的行高（像素）：根字号不放大（1rem = 16px，#3509 照 Arco），设计值就是像素。调用方已按 MOBILE_MQ 重画。 */
function rowHeightNow(mobile: boolean): number {
  return mobile ? MOBILE_ROW_HEIGHT : ROW_HEIGHT;
}

/**
 * 列表上面的筛选，两层（样板：页签、筛选两层以内）：
 * 第一层搜索框和「显示 N / 共 M 个」；第二层「只看已开启」、调用方给的别的筛选（厂家、渠道、状态）和「清除筛选」，
 * 一行不折，手机上横滑。「清除筛选」只在筛着的时候出现。noun 是这一列叫什么（模型、渠道），给搜索框和读屏用。
 */
export function ListFilterBar({
  noun,
  filter,
  onChange,
  total,
  shown,
  active,
  onClear,
  children,
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
  /** 第二层里「只看已开启」后面的别的筛选。 */
  children?: ReactNode;
}) {
  const filtering = active ?? filterActive(filter);
  return (
    <List>
      <li>
        <RowFrame>
          <SearchInput
            value={filter.query}
            onChange={(query) => onChange({ ...filter, query })}
            placeholder={`搜${noun}的名字、编号`}
            aria-label={`搜索${noun}`}
            className="min-w-0 flex-1"
          />
          <span className="num shrink-0 whitespace-nowrap" aria-live="polite">
            <Text size="meta" tone="muted">
              {filtering ? `显示 ${shown} / 共 ${total} 个` : `共 ${total} 个`}
            </Text>
          </span>
        </RowFrame>
      </li>
      {/* 手机上放不下就横滑，右端渐隐提示还能往右滑（和用途那一排一样） */}
      <li>
        <RowFrame>
          <ScrollRow>
            <Toggle
              pressed={filter.onlyEnabled}
              onPressedChange={(onlyEnabled) => onChange({ ...filter, onlyEnabled })}
            >
              只看已开启
            </Toggle>
            {children}
            {filtering ? (
              <Button
                variant="text"
                size="sm"
                onClick={() => (onClear ? onClear() : onChange({ ...filter, query: '', onlyEnabled: false }))}
              >
                清除筛选
              </Button>
            ) : null}
          </ScrollRow>
        </RowFrame>
      </li>
    </List>
  );
}

/** 定高行的窗口化列表（不能拖）。行数不超过 50 全画。flow 时不设内部滚动，行跟页面一起滚（手机上的模型目录）。 */
export function WindowedRows<T>({
  ariaLabel,
  items,
  itemId,
  empty,
  rowProps,
  isSelected,
  rowHeight = ROW_HEIGHT,
  flow = false,
  children,
}: {
  ariaLabel: string;
  items: readonly T[];
  itemId: (item: T) => string;
  empty: string;
  rowProps?: (item: T) => Record<string, string | undefined>;
  /** 选中的行换底色。 */
  isSelected?: (item: T) => boolean;
  rowHeight?: number;
  /** 手机宽度：去掉内部定高滚动，行高仍给定，整列随页面滚。 */
  flow?: boolean;
  children: (item: T) => ReactNode;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  if (items.length === 0) {
    return <EmptyState size="inline" title={empty} />;
  }
  const total = items.length * rowHeight;
  if (flow) {
    return (
      <WindowBox flow>
        <WindowList ariaLabel={ariaLabel}>
          {items.map((item, k) => (
            <RowItem
              key={itemId(item)}
              attrs={rowProps?.(item) ?? {}}
              selected={isSelected?.(item) ?? false}
              height={rowHeight}
              posinset={k + 1}
              setsize={items.length}
            >
              {children(item)}
            </RowItem>
          ))}
        </WindowList>
      </WindowBox>
    );
  }
  // 窗口高和 CSS 的 h-routing-window 同一个数
  const listHeight = LIST_HEIGHT;
  const range = windowRange({ count: items.length, rowHeight, height: listHeight, scrollTop });
  return (
    <WindowBox
      windowed={items.length > WINDOW_MIN_ROWS}
      height={Math.min(listHeight, total)}
      onScrollTop={setScrollTop}
    >
      <WindowList ariaLabel={ariaLabel} total={total}>
        {items.slice(range.start, range.end).map((item, k) => (
          <RowItem
            key={itemId(item)}
            attrs={rowProps?.(item) ?? {}}
            selected={isSelected?.(item) ?? false}
            top={(range.start + k) * rowHeight}
            height={rowHeight}
            posinset={range.start + k + 1}
            setsize={items.length}
          >
            {children(item)}
          </RowItem>
        ))}
      </WindowList>
    </WindowBox>
  );
}

/** 库里留着的老状态词（已不再写）按「没探」说；词和颜色都从状态字典取。 */
const PROBE_STATUS: Readonly<Record<string, StatusKey>> = {
  ok: 'route:probe:passed',
  failed: 'route:probe:failed',
  skipped: 'route:probe:not_probed',
  not_wired: 'route:probe:not_probed',
};

/**
 * 一行两行字的骨架（样板 #1914）：左边按钮（第一行名字加一个状态，第二行灰字小字），右边开关。
 * 两行都不折：名字、小字放不下截断，整句在悬停里（定高行，字不能撑破行高）。
 */
function TwoLineRow({
  label,
  onPick,
  selected,
  name,
  nameTitle,
  quiet = false,
  badges,
  status,
  meta,
  metaTitle,
  trailing,
  nested = false,
}: {
  /** 按钮的读屏名字（「查看 X 的路由」）。 */
  label: string;
  onPick: () => void;
  selected: boolean;
  name: string;
  nameTitle?: string;
  /** 关着、没被用的：名字用灰字。 */
  quiet?: boolean;
  /** 名字后面紧跟的小标签（仅创始人可开）。 */
  badges?: ReactNode;
  status: ReactNode;
  meta: ReactNode;
  metaTitle: string;
  trailing: ReactNode;
  /** 分组下面的变体：行首缩进一格。 */
  nested?: boolean;
}) {
  return (
    <RowFrame tall className="h-full">
      {nested ? <span aria-hidden className="w-6 shrink-0" /> : null}
      <RowButton layout="column" onClick={onPick} pressed={selected} label={label}>
        <span data-row-name-line className="min-w-0 whitespace-nowrap">
          <Stack direction="horizontal" gap="sm" align="center">
            <span data-row-name title={nameTitle ?? name} className="min-w-0">
              <Text strong truncate tone={quiet ? 'muted' : 'default'}>
                {name}
              </Text>
            </span>
            {badges}
            <span data-status-word className="inline-flex shrink-0 items-center">
              {status}
            </span>
          </Stack>
        </span>
        <span data-row-meta title={metaTitle} className="block truncate whitespace-nowrap">
          <Text size="meta" tone="muted">
            {meta}
          </Text>
        </span>
      </RowButton>
      <span data-row-actions className="flex shrink-0 items-center">
        {trailing}
      </span>
    </RowFrame>
  );
}

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
  // 目录没读到时下拉里只有「全部渠道」；读失败的横幅在上面写着，不拿空列表冒充「没有渠道」
  const channelOptions = routing.data ? routing.data.channels : [];
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
    <Stack>
      <ModelRosterNotice layers={layers} />
      {routing.error ? <LoadError what="模型目录（没配进用途的模型读不到）" error={routing.error} /> : null}
      <SectionGrid cols={2} className="items-start">
        <Section flush aria-label="模型目录">
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
          >
            <NativeSelect
              aria-label="按厂家筛选"
              value={filter.vendor}
              onChange={(e) => setFilter((prev) => ({ ...prev, vendor: e.target.value }))}
              className="shrink-0"
            >
              <option value="">全部厂家</option>
              {vendors.map((vendor) => (
                <option key={vendor} value={vendor}>
                  {vendor}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="按渠道筛选"
              value={filter.channel}
              onChange={(e) => setFilter((prev) => ({ ...prev, channel: e.target.value }))}
              className="max-w-40 shrink-0"
            >
              <option value="">全部渠道</option>
              {channelOptions.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </NativeSelect>
            {CATALOG_STATUSES.map((status) => (
              <Toggle
                key={status}
                pressed={filter.statuses.includes(status)}
                onPressedChange={() => toggleStatus(status)}
              >
                {STATUS_LABEL[status]}
              </Toggle>
            ))}
          </ListFilterBar>
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
            isSelected={(row) => row.kind === 'entry' && row.entry.modelId === current?.modelId}
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
        </Section>
        <div id="routing-catalog-detail" className="min-w-0 scroll-mt-4">
          {current ? <CatalogDetail entry={current} now={now} /> : null}
        </div>
      </SectionGrid>
    </Stack>
  );
}

function entrySummary(e: CatalogEntry): string {
  // 「没配进用途」只留在行内状态那一格。备注只写路由条数，避免同一行写两遍。
  if (e.purposes.length === 0) return `${e.routeCount} 条路由`;
  const live = e.routes.filter((r) => r.verdict === 'live').length;
  return `${e.purposes.map(purposeLabel).join('、')} · ${e.routeCount} 条路，${live} 条活`;
}

const MARK_TONE = {
  discovered: 'done',
  retired: 'stop',
  locked: 'stall',
} as const satisfies Record<string, TagTone>;

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
    <>
      <span data-catalog-mark={tone} title={title} className="inline-flex shrink-0 align-middle">
        <Tag tone={MARK_TONE[tone]}>{children}</Tag>
      </span>{' '}
    </>
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
      <RowFrame tall className="h-full">
        <RowButton
          expanded={open}
          label={`${open ? '收起' : '展开'} ${row.group.label} 的变体`}
          onClick={() => onToggle(row.group.key)}
        >
          <DisclosureIcon open={open} />
          <Text strong truncate>
            {row.group.label}
          </Text>
          <span className="shrink-0 whitespace-nowrap">
            <Text size="meta" tone="muted">
              {row.group.members.length} 个变体 · {enabledCount} 个已开
            </Text>
          </span>
        </RowButton>
      </RowFrame>
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
  const notUsed = e.purposes.length === 0 ? '没配进用途' : '一条路由都没有';
  const markWords = [
    marks.discovered ? '新发现' : null,
    marks.retired && kind !== 'retired' ? '已下架' : null,
    marks.locked && !founder ? '锁住' : null,
  ].filter(Boolean);
  const metaTitle = [...markWords, e.family, entrySummary(e)].filter(Boolean).join(' · ');
  return (
    <TwoLineRow
      label={`查看 ${e.displayName} 的路由`}
      onPick={onPick}
      selected={selected}
      name={e.displayName}
      quiet={kind === null || kind === 'retired'}
      nested={nested}
      badges={
        <>
          <ModelStrengthBadge strength={e.strength} />
          <FounderOnlyBadge modelId={e.modelId} family={e.family} displayName={e.displayName} />
        </>
      }
      status={
        kind !== null ? (
          <KindChip kind={kind} variant="dot" />
        ) : (
          // 判不了的不画态：读屏写为什么，看得见的只写一遍「没配进用途」
          <Text size="meta" tone="muted">
            <KindDot kind={null} whyNot={e.purposes.length === 0 ? '没配进用途，没算过' : '一条路由都没有'} />
            {notUsed}
          </Text>
        )
      }
      metaTitle={metaTitle}
      meta={
        <>
          {/* 小标记放在小字最前面：窄屏截断时截掉的是后面的条数，不是标记 */}
          {marks.discovered ? <CatalogMark tone="discovered">新发现</CatalogMark> : null}
          {/* 状态已经是「已下架」就不再贴小标签；没画态的下架模型仍靠这枚标签。 */}
          {marks.retired && kind !== 'retired' ? (
            <CatalogMark tone="retired" title="目录里标了下架">
              已下架
            </CatalogMark>
          ) : null}
          {marks.locked && !founder ? (
            <CatalogMark tone="locked" title={marks.lockWhy}>
              锁住
            </CatalogMark>
          ) : null}
          {e.family ? (
            <>
              <span data-vendor>{e.family}</span>
              {' · '}
            </>
          ) : null}
          <span data-route-summary>{entrySummary(e)}</span>
        </>
      }
      trailing={
        <ModelSwitch
          modelId={e.modelId}
          modelName={e.displayName}
          enabled={e.enabled}
          expectedEnabled={e.routes.filter((r) => r.enabled).map((r) => r.routeId)}
          unavailable={why === true ? false : why}
        />
      }
    />
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
  const order = useRouteOrder(model);
  // 目录没读到时这里没有可列的路由；读失败的横幅在模型目录顶上，不在这里写成「一条都没有」
  const raw = routing.data ? routing.data.routes.filter((r) => r.modelId === e.modelId) : [];
  const channelName = (id: string) => routing.data?.channels.find((c) => c.id === id)?.name ?? id;
  const kind = modelKind(e, useKindEnv());
  return (
    <Section
      title={e.displayName}
      // 卡头一行：先后管所有用途、引擎按序试几条（和用途页右卡一个说法）；怎么改先后在悬停里
      description={
        e.switchKnown && e.routes.length > 0 ? (
          <span title="路由的先后管这个模型在所有用途里：拖动、置顶、置底，或聚焦后 Alt+上下键。">
            <span className="max-md:hidden">所有用途共用这个先后 · </span>
            <OrderSummaryLine summary={order} noun="路由" />
          </span>
        ) : (
          entrySummary(e)
        )
      }
      actions={kind !== null ? <KindChip kind={kind} variant="dot" /> : undefined}
      flush
    >
      {e.switchKnown ? (
        <ModelRoutes key={model.modelId} model={model} now={now} summary={false} />
      ) : (
        <>
          <RowFrame>
            <span role="note">
              <Text tone="muted">
                {e.purposes.length === 0
                  ? '这个模型还没配进任何用途，路由开着没有读不到，开关先置灰；在用途里排上它之后就能开关。'
                  : '这个模型下一条路由都没有：排了它也派不到它。'}
              </Text>
            </span>
          </RowFrame>
          {raw.length === 0 ? null : (
            <List aria-label={`${e.displayName} 在目录里的路由`}>
              {raw.map((r) => (
                <UnassignedRouteRow
                  key={r.id}
                  route={r}
                  modelId={e.modelId}
                  modelName={e.displayName}
                  name={`${channelName(r.channelId)} · ${r.poolId}`}
                />
              ))}
            </List>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * 没配进任何用途的路由（读不到开关）：一行名字加探针的结论，小字写执行方式（和模型名），右边档位就地改。
 * 路由编号这类内部 id 只在悬停里。
 */
function UnassignedRouteRow({
  route: r,
  modelId,
  modelName,
  name,
  modelLabel,
}: {
  route: Route;
  modelId: string;
  modelName: string;
  /** 「渠道 · 池」。 */
  name: string;
  /** 渠道页里写明这条路由属于哪个模型。 */
  modelLabel?: string;
}) {
  const probe: StatusKey = r.probe
    ? (PROBE_STATUS[r.probe.state] ?? 'route:probe:not_probed')
    : 'route:unprobed';
  const meta = [modelLabel, hostLabel[r.hostId]].filter(Boolean).join(' · ');
  return (
    <li data-route={r.id}>
      <RowFrame tall>
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <Stack direction="horizontal" gap="sm" align="center">
            <Text strong truncate title={`${name} · ${r.id}`}>
              {name}
            </Text>
            <StatusBadge status={probe} variant="dot" />
          </Stack>
          <Text size="meta" tone="muted" truncate title={meta}>
            {meta}
          </Text>
        </span>
        {/* 没配进用途的路由也能先配档位（#1914 第 5 轮） */}
        <RouteEffortInline modelId={modelId} modelName={modelName} routeId={r.id} routeName={name} />
      </RowFrame>
    </li>
  );
}

// —— 渠道 ——

/** 渠道行第二行：这个渠道下一共几条路由、其中几条在线。厂家这一列没有。 */
function channelRouteLine(counts: KindCounts): string {
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  return `${total} 条路，${counts.live} 条活`;
}

/** 渠道这一行的状态词：从渠道卡的事实对到状态字典的键（词和颜色等级都从字典取，页面不自己写）。 */
function channelStatusKey(c: ChannelCard): StatusKey {
  if (!c.channel.enabled) return 'route:off';
  if (c.state === 'idle') return `route:${c.kind}`;
  if (c.failover) return 'route:channel:failover';
  if (c.interrupted) return 'route:interrupted';
  if (c.quota && c.state === 'ok') {
    return c.quota.routes === c.activeRoutes ? 'route:channel:quota-all' : 'route:channel:quota-part';
  }
  if (c.state === 'ok') return 'route:live';
  if (c.state === 'partial') return 'route:channel:partial';
  if (c.state === 'down') return 'route:fault';
  return c.channel.billing === 'metered' ? 'route:channel:metered' : 'route:unprobed';
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
    <SectionGrid cols={2} className="items-start">
      <Section flush aria-label="渠道">
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
          isSelected={(c) => c.channel.id === current?.channel.id}
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
      </Section>
      <div id="routing-channel-detail" className="min-w-0 scroll-mt-4">
        {current ? <ChannelDetail key={current.channel.id} card={current} layers={layers} now={now} /> : null}
      </div>
    </SectionGrid>
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
  const line = channelRouteLine(c.counts);
  return (
    <TwoLineRow
      label={`查看 ${c.channel.name} 的路由`}
      onPick={onPick}
      selected={selected}
      name={c.channel.name}
      quiet={quiet}
      status={<StatusBadge status={channelStatusKey(c)} variant="dot" />}
      metaTitle={c.reason ? `${line} · ${c.reason}` : line}
      meta={<span data-route-summary>{line}</span>}
      trailing={<ChannelSwitch channelId={c.channel.id} name={c.channel.name} enabled={c.channel.enabled} />}
    />
  );
}

function ChannelDetail({ card: c, layers, now }: { card: ChannelCard; layers: RoutingLayers; now: number }) {
  const routing = useRouting();
  const { inLayers, others } = channelRoutes(c.channel.id, layers, routing.data);
  const [showAll, setShowAll] = useState(false);
  const enabledInLayers = inLayers.filter((row) => row.route.enabled);
  const hidden = inLayers.length - enabledInLayers.length + others.length;
  const visibleInLayers = showAll ? inLayers : enabledInLayers;
  const visibleOthers = showAll ? others : [];
  return (
    <Section
      title={c.channel.name}
      // 卡头一行：几条在线、几条关着 · 看原文、立即探测（原来这句在卡头和下面一条灰底里各写一遍）
      description={
        // 不截断：截断会把链接往外撑的可点范围一起裁掉；手机上原因收起，这一行本来就短
        <span className="whitespace-nowrap" title={c.reason ?? countsText(c.counts)}>
          {c.reason ? <span className="max-md:hidden">{c.reason} · </span> : null}
          {countsText(c.counts)} ·{' '}
          <Button variant="text" size="xs" href={`/routing/status?p=${encodeURIComponent(c.channel.id)}`}>
            看原文、立即探测
          </Button>
        </span>
      }
      actions={<StatusBadge status={channelStatusKey(c)} variant="dot" />}
      flush
    >
      {isManualChannel(c.channel.id, c.channel.name, layers.modelRoster?.manual) ? (
        <ManualModelForm channelId={c.channel.id} />
      ) : null}
      {inLayers.length === 0 && others.length === 0 ? (
        <EmptyState size="inline" title="这个渠道下一条路由都没有" />
      ) : null}
      {hidden > 0 ? (
        <RowDetail indent={false}>
          <Stack direction="horizontal" gap="sm" align="center">
            <Toggle pressed={showAll} onPressedChange={setShowAll}>
              显示全部
            </Toggle>
            {showAll ? null : (
              <Text size="meta" tone="muted">
                还有 <span className="num">{hidden}</span> 条没开或没配进用途
              </Text>
            )}
          </Stack>
        </RowDetail>
      ) : null}
      {visibleInLayers.length > 0 ? (
        <WindowList as="ol" ariaLabel={`${c.channel.name} 的路由`}>
          {visibleInLayers.map(({ route, modelId, modelName }) => (
            // 行高、内边距由 RouteItem 的行框（RowFrame）给；关着的只变淡，不整行灰底（路由页样板 #1914）
            <RowItem key={route.routeId} attrs={{ 'data-route': route.routeId }}>
              <RouteItem
                route={route}
                modelId={modelId}
                modelName={modelName}
                modelLabel={modelName}
                now={now}
              />
            </RowItem>
          ))}
        </WindowList>
      ) : null}
      {visibleOthers.length > 0 ? (
        <>
          {/* 分组小标题：淡字一行，不再是灰底横条 */}
          <RowFrame>
            <Text size="meta" tone="muted">
              没配进任何用途的路由（读不到开关）
            </Text>
          </RowFrame>
          <List aria-label={`${c.channel.name} 里没配进用途的路由`}>
            {visibleOthers.map(({ route, modelName }) => (
              <UnassignedRouteRow
                key={route.id}
                route={route}
                modelId={route.modelId}
                modelName={modelName}
                modelLabel={modelName}
                name={routeTitle({ channelName: c.channel.name, poolId: route.poolId })}
              />
            ))}
          </List>
        </>
      ) : null}
    </Section>
  );
}
