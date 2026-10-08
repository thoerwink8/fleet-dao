// 路由页（#574，specs/509 方案第八节「两层的每层都要能一眼看出这条现在活着吗」；#1366 第二部分改成分块）：
// 「用途 / 模型目录 / 渠道」三块一次看一块。每个用途按顺序排哪些模型（紧凑行：名字、状态点、开关；拖动、置顶、置底、Alt+上下键改先后），
// 选中一个模型再看它下面每条路由现在活不活；模型目录、渠道各是一列带搜索的紧凑行。活不活由后端现算（db 的 routing-liveness.ts），这页不再判一遍。
// 改这里之前必须知道：
// - 不知道（探针没看过、额度没读成）不画成活，也不画成死：用停滞色，原因照写。
// - 没接上（开发环境内存版）和没读成是两回事：前者整块写 unavailable，后者写「没读成」和原因。都不画空表冒充「都没配」。
// - 先后、开关的写走 components/routing-edit.tsx（保存契约不变：带看到的旧顺序，别人先改了回 409）。

import { routingPurposeOf, SCOPE_NO_ROUTE } from '@fleet-dao/shared';
import { Route as RouteIcon, TriangleAlert } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { usePoolHolds, useRoutingLayers } from '../api/client';
import type { RoutingLayerModel, RoutingLayerPurpose } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import {
  ChannelTab,
  LIST_HEIGHT,
  ListFilterBar,
  ModelCatalogTab,
  ROW_HEIGHT,
} from '../components/routing-browse';
import {
  FounderOnlyBadge,
  ModelSwitch,
  RoutingEditProvider,
  type RowControls,
  SortableList,
  useRoutingEdit,
} from '../components/routing-edit';
import { ModelRoutes } from '../components/routing-routes';
import { StatusChip, StatusDot } from '../components/status';
import { formatClock } from '../lib/format';
import { useNow } from '../lib/hooks';
import { filterActive, filterRows, type ListFilter, NO_FILTER, WINDOW_MIN_ROWS } from '../lib/list-window';
import {
  countByVerdict,
  firstLive,
  modelSummary,
  pickPurpose,
  purposeLabel,
  purposeLine,
  purposeVerdictLabel,
  verdictLabel,
  verdictTone,
} from '../lib/routing';
import { type Tone, toneText } from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('路由') }];
}

const DESCRIPTION =
  '每个用途按顺序排哪些模型、每个模型走哪几条路，现在派不派得出去。一条路接得上、额度够、没被禁令挡三件都过才算活。改先后：拖到新位置，或点每行的置顶、置底，或聚焦后按 Alt+上下键（Alt+Home 置顶、Alt+End 置底）；模型的先后只管这个用途，渠道的先后管这个模型在所有用途里。模型、渠道、每条路由都有开关：模型开关关了，它在所有用途里不派；渠道开关关了，它下面的路由都不派。账号池可以在这里整池暂停。下一次选路就照新的。';

const TABS = [
  { id: 'purposes', label: '用途' },
  { id: 'models', label: '模型目录' },
  { id: 'channels', label: '渠道' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const parseTab = (raw: string | null): TabId => TABS.find((t) => t.id === raw)?.id ?? 'purposes';

/** 一句话的颜色：好消息不上色（只用灰），要看的才上色。 */
const lineInk = (tone: Tone) => (tone === 'done' ? 'text-muted-foreground' : toneText[tone]);

export default function Routing() {
  const { data, error, isLoading } = useRoutingLayers();
  const [params, setParams] = useSearchParams();

  if (error) {
    return (
      <Page title="路由" description={DESCRIPTION}>
        <LoadError what="路由两层" error={error} />
      </Page>
    );
  }
  if (isLoading || !data) {
    return (
      <Page title="路由" description={DESCRIPTION}>
        <LoadingRows rows={6} />
      </Page>
    );
  }
  if (data.unavailable) {
    return (
      <Page title="路由" description={DESCRIPTION}>
        <div
          role="note"
          className="rounded-xl border border-dashed bg-card px-6 py-10 text-center text-sm text-muted-foreground"
        >
          {data.unavailable}
        </div>
      </Page>
    );
  }

  // 只画对照里的用途。接口要是还带回老的（分诊、方案、审查……），当没点名，不占一格。
  const purposes = data.purposes.filter((p) => routingPurposeOf(p.purpose));
  const tab = parseTab(params.get('tab'));
  const setTab = (id: TabId) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id === 'purposes') next.delete('tab');
        else next.set('tab', id);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );

  return (
    <Page
      title="路由"
      description={DESCRIPTION}
      // 一个用途都没有时不报「0 个派不出去」：那会读成没事
      actions={purposes.length > 0 ? <Summary purposes={purposes} asOf={data.asOf} /> : undefined}
    >
      <RoutingEditProvider>
        <RoutingTabs tab={tab} onPick={setTab} />
        <div role="tabpanel" id="routing-panel" aria-labelledby={`routing-tab-${tab}`}>
          {tab === 'models' ? <ModelCatalogTab layers={data} /> : null}
          {tab === 'channels' ? <ChannelTab layers={data} /> : null}
          {tab === 'purposes' ? <PurposesTab purposes={purposes} params={params} /> : null}
        </div>
      </RoutingEditProvider>
    </Page>
  );
}

/** 三块的页签：一次只显示一块。方向键、Home、End 在页签间移动。 */
function RoutingTabs({ tab, onPick }: { tab: TabId; onPick: (id: TabId) => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = TABS.findIndex((t) => t.id === tab);
    let to: number;
    if (e.key === 'ArrowRight') to = (at + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') to = (at - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = TABS.length - 1;
    else return;
    e.preventDefault();
    const next = TABS[to];
    if (!next) return;
    onPick(next.id);
    document.getElementById(`routing-tab-${next.id}`)?.focus();
  };
  return (
    <div role="tablist" aria-label="路由页分块" className="mb-4 flex gap-1 border-b">
      {TABS.map((t) => {
        const active = t.id === tab;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`routing-tab-${t.id}`}
            aria-selected={active}
            aria-controls="routing-panel"
            tabIndex={active ? 0 : -1}
            onClick={() => onPick(t.id)}
            onKeyDown={onKeyDown}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm transition-colors hover:text-foreground',
              active
                ? 'border-foreground font-semibold text-foreground'
                : 'border-transparent text-muted-foreground',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function PurposesTab({ purposes, params }: { purposes: RoutingLayerPurpose[]; params: URLSearchParams }) {
  const selected = pickPurpose(purposes, params.get('purpose'));
  // 窄屏上清单在上、详情在下：点了就滚到详情（宽屏两栏并排，不用滚）
  const reveal = () => {
    if (!window.matchMedia?.('(max-width: 1279px)').matches) return;
    requestAnimationFrame(() =>
      document
        .getElementById('routing-purpose-detail')
        ?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }),
    );
  };
  if (purposes.length === 0 || !selected) {
    return (
      <Panel>
        <Empty
          icon={RouteIcon}
          title="后端一个用途都没给"
          hint="每个用途都该有一份（没配的写明没配）：这不该发生，去看后端日志"
        />
      </Panel>
    );
  }
  return (
    <div className="grid items-start gap-4 xl:grid-cols-routing">
      <PurposeList purposes={purposes} selected={selected.purpose} params={params} onPick={reveal} />
      <div id="routing-purpose-detail" className="min-w-0 scroll-mt-4">
        <PurposeDetail key={selected.purpose} purpose={selected} />
      </div>
    </div>
  );
}

function Summary({ purposes, asOf }: { purposes: RoutingLayerPurpose[]; asOf: string }) {
  const counts = countByVerdict(purposes);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusChip tone="done" label={`${counts.live} 个派得出去`} />
      <StatusChip tone="stall" label={`${counts.unknown} 个不知道`} />
      <StatusChip tone="fail" label={`${counts.dead} 个派不出去`} />
      <span className="num text-caption text-muted-foreground">{formatClock(asOf)} 现算</span>
    </div>
  );
}

function PurposeList({
  purposes,
  selected,
  params,
  onPick,
}: {
  purposes: RoutingLayerPurpose[];
  selected: string;
  params: URLSearchParams;
  onPick: () => void;
}) {
  const flow = purposes.filter((p) => routingPurposeOf(p.purpose)?.aside !== true);
  const aside = purposes.filter((p) => routingPurposeOf(p.purpose)?.aside === true);
  return (
    <nav aria-label="用途" className="min-w-0">
      <p className="mb-2 rounded-xl border border-dashed bg-card px-3.5 py-3 text-sm text-muted-foreground">
        对题：{SCOPE_NO_ROUTE}
      </p>
      <ul className="space-y-2">
        {flow.map((p) => (
          <PurposeItem key={p.purpose} purpose={p} selected={selected} params={params} onPick={onPick} />
        ))}
      </ul>
      {aside.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 px-1 text-caption text-muted-foreground">不是流程里的一段</p>
          <ul className="space-y-2">
            {aside.map((p) => (
              <PurposeItem key={p.purpose} purpose={p} selected={selected} params={params} onPick={onPick} />
            ))}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}

function PurposeItem({
  purpose: p,
  selected,
  params,
  onPick,
}: {
  purpose: RoutingLayerPurpose;
  selected: string;
  params: URLSearchParams;
  onPick: () => void;
}) {
  const line = purposeLine(p);
  const active = p.purpose === selected;
  // 别的网址参数（?node=、?tab=）带着走
  const next = new URLSearchParams(params);
  next.set('purpose', p.purpose);
  return (
    <li>
      <Link
        to={{ search: `?${next}` }}
        replace
        preventScrollReset
        onClick={onPick}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'block rounded-xl border bg-card px-3.5 py-3 shadow-card-edge transition-colors hover:border-border-strong',
          active && 'border-border-strong bg-muted/60',
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">{purposeLabel(p.purpose)}</span>
          {p.purpose === 'groom' ? (
            <span className="text-caption text-muted-foreground">这里配指挥官用的模型</span>
          ) : null}
          <span className="num text-caption text-muted-foreground">{p.purpose}</span>
          <StatusChip
            tone={verdictTone[p.verdict]}
            label={purposeVerdictLabel[p.verdict]}
            className="ml-auto"
          />
        </div>
        {p.models.length > 0 ? (
          <ol aria-label="模型顺序" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-caption">
            {p.models.map((m, i) => (
              <li key={m.modelId} className="inline-flex items-center gap-1">
                <StatusDot tone={verdictTone[m.verdict]} className="size-1.5" />
                <span className="num text-muted-foreground">{i + 1}</span>
                <span className={m.verdict === 'live' ? undefined : toneText[verdictTone[m.verdict]]}>
                  {m.displayName}
                </span>
                <span className="sr-only">：{verdictLabel[m.verdict]}</span>
              </li>
            ))}
          </ol>
        ) : null}
        <p className={cn('mt-1.5 text-caption', lineInk(line.tone))}>{line.text}</p>
      </Link>
    </li>
  );
}

function PurposeDetail({ purpose: p }: { purpose: RoutingLayerPurpose }) {
  const now = useNow();
  const line = purposeLine(p);
  const first = firstLive(p);
  const edit = useRoutingEdit();
  const holds = usePoolHolds();
  // 选中看路由的模型：点过的优先；没点过，进来那一刻看顺位第一条活的所在的模型，没有就第一个。
  // 进来时定下来就不跟着变：开关一关、先后一调，顺位第一条活的会换，不能让下面的路由跟着跳到别的模型。
  const [picked, setPicked] = useState<string | null>(
    () => first?.model.modelId ?? p.models[0]?.modelId ?? null,
  );
  const current = p.models.find((m) => m.modelId === picked) ?? p.models[0];
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {purposeLabel(p.purpose)}
          <span className="num text-caption font-normal text-muted-foreground">{p.purpose}</span>
        </span>
      }
      // 一个模型都没排：那句话就是缺口本身，下面缺口栏已经写了，不在副标题再写一遍
      description={p.models.length > 0 ? <span className={lineInk(line.tone)}>{line.text}</span> : undefined}
      actions={<StatusChip tone={verdictTone[p.verdict]} label={purposeVerdictLabel[p.verdict]} />}
    >
      {edit.disabledWhy ? (
        <p
          role="note"
          className="mb-3 rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-sub text-muted-foreground"
        >
          {edit.disabledWhy}。先后和开关都不能改。
        </p>
      ) : null}
      {holds.error ? (
        <p role="status" className="mb-3 text-sub text-ink-fail">
          整池暂停没读成，路由先不能单独开。
        </p>
      ) : null}
      {p.problems.length > 0 ? (
        <ul
          aria-label="配置缺口"
          className="mb-3 space-y-1 rounded-lg border border-st-fail/40 bg-st-fail/10 px-3 py-2 text-sub text-ink-fail"
        >
          {p.problems.map((x) => (
            <li key={x} className="flex gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {x}
            </li>
          ))}
        </ul>
      ) : null}
      {p.models.length > 0 ? (
        <>
          <ModelPriority purpose={p} selectedId={current?.modelId} onSelect={setPicked} />
          {current ? (
            <section
              aria-label={`${current.displayName} 的路由`}
              className="mt-4 overflow-hidden rounded-lg border"
            >
              <header className="flex flex-wrap items-baseline gap-x-2 border-b bg-muted/40 px-3 py-2">
                <h3 className="text-sm font-semibold">{current.displayName} 的路由</h3>
                <span className="text-caption text-muted-foreground">
                  先后管这个模型在所有用途里 · {modelSummary(current)}
                </span>
              </header>
              <ModelRoutes
                key={current.modelId}
                model={current}
                now={now}
                firstLiveRoute={first?.model === current ? first.route.routeId : undefined}
              />
            </section>
          ) : null}
        </>
      ) : null}
      <p className="mt-4 text-caption text-muted-foreground">
        活 = 接得上、额度够、没被禁令挡三件都过；不知道 =
        探针还没看过、额度没读成，不当活。引擎派活时另看账号池有没有空位
        （满了是等，不算死）；探针的结论过期了，引擎照上一次的结论派、写明，这里标「探测过期」。
      </p>
    </Panel>
  );
}

/**
 * 这个用途下的模型优先级：一行一个模型的紧凑行，拖动或置顶 / 置底 / Alt+上下键改先后，点名字在下面看它的路由。
 * 超过 50 个模型才出搜索框和「只看已开启」，也只画窗口里的行；筛选时只显示了一部分，先后不能调（免得把看不见的行顺序弄乱）。
 */
function ModelPriority({
  purpose: p,
  selectedId,
  onSelect,
}: {
  purpose: RoutingLayerPurpose;
  selectedId: string | undefined;
  onSelect: (modelId: string) => void;
}) {
  const edit = useRoutingEdit();
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const long = p.models.length > WINDOW_MIN_ROWS;
  const filtering = long && filterActive(filter);
  const shown = filtering
    ? filterRows(
        p.models,
        filter,
        (m) => [m.displayName, m.modelId, m.family ?? ''],
        (m) => m.routes.some((r) => r.enabled),
      )
    : p.models;
  const why =
    edit.disabledWhy ?? (filtering ? '正在筛选，只显示了一部分：清掉搜索和「只看已开启」再调先后' : null);
  return (
    <div className="overflow-hidden rounded-lg border">
      {long ? (
        <ListFilterBar
          noun="模型"
          filter={filter}
          onChange={setFilter}
          total={p.models.length}
          shown={shown.length}
        />
      ) : null}
      {shown.length === 0 ? (
        <p className="px-3 py-8 text-center text-sub text-muted-foreground">
          没有符合的模型：换个搜索词，或关掉「只看已开启」
        </p>
      ) : (
        <SortableList
          ariaLabel="模型"
          items={shown}
          itemId={(m) => m.modelId}
          itemLabel={(m) => `${m.displayName}（${purposeLabel(p.purpose)}里的先后）`}
          disabled={why !== null}
          busy={edit.busy}
          disabledWhy={why}
          viewport={{ height: LIST_HEIGHT, rowHeight: ROW_HEIGHT }}
          rowClassName={(m) => cn('border-b', m.modelId === selectedId && 'bg-muted/60')}
          rowProps={(m) => ({ 'data-model': m.modelId })}
          onSave={(order, expected, movedId) =>
            edit.reorderModels({ purpose: p.purpose, movedId, order, expected })
          }
        >
          {(m, i, controls) => (
            <ModelRow
              model={m}
              position={p.models.findIndex((x) => x.modelId === m.modelId) + 1 || i + 1}
              selected={m.modelId === selectedId}
              onSelect={() => onSelect(m.modelId)}
              controls={controls}
            />
          )}
        </SortableList>
      )}
    </div>
  );
}

function ModelRow({
  model: m,
  position,
  selected,
  onSelect,
  controls,
}: {
  model: RoutingLayerModel;
  position: number;
  selected: boolean;
  onSelect: () => void;
  controls: RowControls;
}) {
  const enabledRouteIds = m.routes.filter((r) => r.enabled).map((r) => r.routeId);
  return (
    <div className="flex h-full items-center gap-1.5 pr-2 pl-1.5">
      {controls.grip}
      <span className="num grid size-5 shrink-0 place-items-center rounded-full bg-foreground/10 text-caption font-medium">
        {position}
      </span>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`查看 ${m.displayName} 的路由`}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
      >
        <StatusDot tone={verdictTone[m.verdict]} className="shrink-0" />
        <span className="truncate text-sm font-semibold">{m.displayName}</span>
        <span className="sr-only">：{verdictLabel[m.verdict]}</span>
        {m.family ? (
          <span className="hidden truncate text-caption text-muted-foreground sm:inline">{m.family}</span>
        ) : null}
        <FounderOnlyBadge modelId={m.modelId} family={m.family} displayName={m.displayName} />
        <span className="ml-auto hidden truncate text-caption text-muted-foreground md:inline">
          {modelSummary(m)}
        </span>
      </button>
      <ModelSwitch
        modelId={m.modelId}
        modelName={m.displayName}
        enabled={enabledRouteIds.length > 0}
        expectedEnabled={enabledRouteIds}
        unavailable={m.routes.length === 0}
      />
      {controls.pins}
    </div>
  );
}
