// 路由页（#574，specs/509 方案第八节「两层的每层都要能一眼看出这条现在活着吗」；#1366 第二部分改成分块）：
// 「用途 / 模型目录 / 渠道」三块一次看一块。每个用途按顺序排哪些模型（紧凑行：序号、名字、状态点、开关；拖动、置顶、上移、下移、置底、Alt+上下键改先后），
// 选中一个模型再看它下面每条路由现在活不活（桌面左右并排、各自占满页面高度、内部滚动；手机整页纵向铺开）；关着的行置灰写「已跳过」，实际顺位只数开着的（lib/routing-order.ts）；模型目录、渠道各是一列带搜索的紧凑行。活不活由后端现算（db 的 routing-liveness.ts），这页不再判一遍。
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
  MOBILE_MQ,
  MOBILE_ROW_HEIGHT,
  ModelCatalogTab,
  revealOnMobile,
} from '../components/routing-browse';
import {
  FounderOnlyBadge,
  ModelSwitch,
  RoutingEditProvider,
  type RowControls,
  SortableList,
  useRoutingEdit,
} from '../components/routing-edit';
import { KindDot, useKindEnv } from '../components/routing-kinds';
import { AddPurposeModel, PurposeModelControls } from '../components/routing-membership';
import { ModelRoutes, OrderSummaryLine } from '../components/routing-routes';
import { StatusChip, StatusDot } from '../components/status';
import { formatClock } from '../lib/format';
import { useMediaQuery, useNow } from '../lib/hooks';
import { filterActive, filterRows, type ListFilter, NO_FILTER, WINDOW_MIN_ROWS } from '../lib/list-window';
import { modelKind } from '../lib/route-kinds';
import {
  countByVerdict,
  firstLive,
  modelSummary,
  pickPurpose,
  purposeLabel,
  purposeLine,
  purposeVerdictLabel,
  verdictTone,
} from '../lib/routing';
import { actualRanks, modelSlotState, type SlotState, slotWord, summarizeOrder } from '../lib/routing-order';
import { type Tone, toneText } from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('路由') }];
}

const DESCRIPTION =
  '每个用途按顺序排哪些模型、每个模型走哪几条路，现在派不派得出去。一条路接得上、额度够、没被禁令挡三件都过才算活。改先后：拖到新位置，或点每行的置顶、上移、下移、置底，或聚焦后按 Alt+上下键（Alt+Home 置顶、Alt+End 置底）；模型的先后只管这个用途，渠道的先后管这个模型在所有用途里。关着的行置灰、写「已跳过」：引擎自动跳过它、顺延给下一个，行上写的「实际第几位」只数开着的。模型、渠道、每条路由都有开关：模型开关关了，它在所有用途里不派；渠道开关关了，它下面的路由都不派。账号池可以在这里整池暂停。下一次选路就照新的。';

const TABS = [
  { id: 'purposes', label: '用途' },
  { id: 'models', label: '模型目录' },
  { id: 'channels', label: '渠道' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const parseTab = (raw: string | null): TabId => TABS.find((t) => t.id === raw)?.id ?? 'purposes';

/** 一句话的颜色：好消息不上色（只用灰），要看的才上色。 */
const lineInk = (tone: Tone) => (tone === 'done' ? 'text-muted-foreground' : toneText[tone]);

/** 说明折成一行「怎么用」，点开才展开：调整顺序的区域要占满页面主体高度，首屏留给顺序，不留给说明。 */
function RoutingDescription() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="block text-left underline-offset-2 hover:underline"
      >
        怎么用
      </button>
      {open ? <span className="mt-1 block">{DESCRIPTION}</span> : null}
    </>
  );
}

export default function Routing() {
  const { data, error, isLoading } = useRoutingLayers();
  const [params, setParams] = useSearchParams();

  if (error) {
    return (
      <Page title="路由" description={<RoutingDescription />}>
        <LoadError what="路由两层" error={error} />
      </Page>
    );
  }
  if (isLoading || !data) {
    return (
      <Page title="路由" description={<RoutingDescription />}>
        <LoadingRows rows={6} />
      </Page>
    );
  }
  if (data.unavailable) {
    return (
      <Page title="路由" description={<RoutingDescription />}>
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
      description={<RoutingDescription />}
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
    <div className="space-y-3">
      <PurposeList purposes={purposes} selected={selected.purpose} params={params} />
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

/** 用途选择：一排紧凑的按钮（手机上横向滑动），不再是一张张带阴影的卡片；每个用途的先后在下面的大区域里调。 */
function PurposeList({
  purposes,
  selected,
  params,
}: {
  purposes: RoutingLayerPurpose[];
  selected: string;
  params: URLSearchParams;
}) {
  const flow = purposes.filter((p) => routingPurposeOf(p.purpose)?.aside !== true);
  const aside = purposes.filter((p) => routingPurposeOf(p.purpose)?.aside === true);
  return (
    <nav aria-label="用途" className="min-w-0">
      <ul className="flex items-center gap-1.5 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible">
        {flow.map((p) => (
          <PurposeItem key={p.purpose} purpose={p} selected={selected} params={params} />
        ))}
        {aside.length > 0 ? (
          <>
            <li className="shrink-0 px-1 text-caption text-muted-foreground">不是流程里的一段</li>
            {aside.map((p) => (
              <PurposeItem key={p.purpose} purpose={p} selected={selected} params={params} />
            ))}
          </>
        ) : null}
      </ul>
      <p className="mt-1 text-caption text-muted-foreground">对题：{SCOPE_NO_ROUTE}</p>
    </nav>
  );
}

function PurposeItem({
  purpose: p,
  selected,
  params,
}: {
  purpose: RoutingLayerPurpose;
  selected: string;
  params: URLSearchParams;
}) {
  const active = p.purpose === selected;
  // 别的网址参数（?node=、?tab=）带着走
  const next = new URLSearchParams(params);
  next.set('purpose', p.purpose);
  return (
    <li className="shrink-0">
      <Link
        to={{ search: `?${next}` }}
        replace
        preventScrollReset
        aria-current={active ? 'true' : undefined}
        title={purposeLine(p).text}
        className={cn(
          'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors hover:border-border-strong md:min-h-8',
          active ? 'border-foreground bg-foreground/10 font-semibold' : 'border-border bg-background',
        )}
      >
        <StatusDot tone={verdictTone[p.verdict]} />
        <span className="sr-only">{purposeVerdictLabel[p.verdict]}：</span>
        <span>{purposeLabel(p.purpose)}</span>
        {p.purpose === 'groom' ? (
          <span className="hidden text-caption font-normal text-muted-foreground lg:inline">
            这里配指挥官用的模型
          </span>
        ) : null}
        <span className="num text-caption font-normal text-muted-foreground">{p.models.length}</span>
      </Link>
    </li>
  );
}

/** 调整顺序用的行高（桌面）。一屏要能看见 12 行以上：行高 36、区域占满页面主体高度。手机沿用 MOBILE_ROW_HEIGHT（两行）。 */
const ORDER_ROW_HEIGHT = 36;
/** 不到 xl 宽（平板）时模型清单没有父元素给高度：固定放得下 13 行。 */
const ORDER_LIST_HEIGHT = ORDER_ROW_HEIGHT * 13;
const WIDE_MQ = '(min-width: 1280px)';

function PurposeDetail({ purpose: p }: { purpose: RoutingLayerPurpose }) {
  const now = useNow();
  const line = purposeLine(p);
  const first = firstLive(p);
  const edit = useRoutingEdit();
  const holds = usePoolHolds();
  const [membershipError, setMembershipError] = useState<string | null>(null);
  // 选中看路由的模型：点过的优先；没点过，进来那一刻看顺位第一条活的所在的模型，没有就第一个。
  // 进来时定下来就不跟着变：开关一关、先后一调，顺位第一条活的会换，不能让下面的路由跟着跳到别的模型。
  const [picked, setPicked] = useState<string | null>(
    () => first?.model.modelId ?? p.models[0]?.modelId ?? null,
  );
  const current = p.models.find((m) => m.modelId === picked) ?? p.models[0];
  return (
    <section aria-label={`${purposeLabel(p.purpose)}的调整顺序`} className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {purposeLabel(p.purpose)}
          <span className="num text-caption font-normal text-muted-foreground">{p.purpose}</span>
        </h2>
        <StatusChip tone={verdictTone[p.verdict]} label={purposeVerdictLabel[p.verdict]} />
        {/* 一个模型都没排：那句话就是缺口本身，下面缺口栏已经写了，不在这里再写一遍 */}
        {p.models.length > 0 ? (
          <span className={cn('min-w-0 text-sub', lineInk(line.tone))}>{line.text}</span>
        ) : null}
      </header>
      {edit.disabledWhy ? (
        <p
          role="note"
          className="rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-sub text-muted-foreground"
        >
          {edit.disabledWhy}。先后、开关、添加和档位都不能改。
        </p>
      ) : null}
      {holds.error ? (
        <p role="status" className="text-sub text-ink-fail">
          整池暂停没读成，路由先不能单独开。
        </p>
      ) : null}
      {membershipError ? (
        <p role="alert" className="rounded-lg border border-ink-fail px-3 py-2 text-sub text-ink-fail">
          {membershipError}
        </p>
      ) : null}
      {p.problems.length > 0 ? (
        <ul
          aria-label="配置缺口"
          className="space-y-1 rounded-lg border border-st-fail/40 bg-st-fail/10 px-3 py-2 text-sub text-ink-fail"
        >
          {p.problems.map((x) => (
            <li key={x} className="flex gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {x}
            </li>
          ))}
        </ul>
      ) : null}
      {p.models.length === 0 ? <AddPurposeModel purpose={p} onError={setMembershipError} /> : null}
      {p.models.length > 0 ? (
        // 桌面（xl）：左模型先后、右这个模型下的路由先后，并排，各自占满页面主体高度、内部自己滚；窄屏纵向铺开
        <div className="grid items-stretch gap-3 xl:h-routing-desk xl:grid-cols-routing-desk">
          <ModelPriority
            purpose={p}
            selectedId={current?.modelId}
            onSelect={setPicked}
            onError={setMembershipError}
          />
          {current ? (
            <section
              id="routing-model-detail"
              aria-label={`${current.displayName} 的路由`}
              className="flex min-h-0 scroll-mt-4 flex-col overflow-hidden rounded-lg border bg-card"
            >
              <header className="flex flex-wrap items-baseline gap-x-2 border-b bg-muted/40 px-3 py-2">
                <h3 className="text-sm font-semibold">{current.displayName} 的路由</h3>
                <span className="text-caption text-muted-foreground">
                  先后管这个模型在所有用途里 · {modelSummary(current)}
                </span>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <ModelRoutes
                  key={current.modelId}
                  model={current}
                  now={now}
                  firstLiveRoute={first?.model === current ? first.route.routeId : undefined}
                />
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
      <p className="text-caption text-muted-foreground">
        活 = 接得上、额度够、没被禁令挡三件都过；不知道 =
        探针还没看过、额度没读成，不当活。引擎派活时另看账号池有没有空位
        （满了是等，不算故障）；探针的结论过期了，引擎照上一次的结论派、写明，这里标「探测过期」。
      </p>
    </section>
  );
}

/**
 * 这个用途下的模型优先级：一行一个模型的紧凑行（序号、拖动手柄、名字、状态点、开关），拖动或上移、下移、置顶、置底、Alt+上下键改先后，
 * 点名字在旁边看它的路由。关着的行置灰写「已跳过」，「实际第几位」只数开着的。
 * 超过 50 个模型才出搜索框和「只看已开启」，也只画窗口里的行；筛选时只显示了一部分，先后不能调（免得把看不见的行顺序弄乱）。
 */
function ModelPriority({
  purpose: p,
  selectedId,
  onSelect,
  onError,
}: {
  purpose: RoutingLayerPurpose;
  selectedId: string | undefined;
  onSelect: (modelId: string) => void;
  onError: (message: string | null) => void;
}) {
  const edit = useRoutingEdit();
  const env = useKindEnv();
  const mobile = useMediaQuery(MOBILE_MQ);
  const wide = useMediaQuery(WIDE_MQ);
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
  // 实际顺位按整份先后算，筛选只是少画几行
  const states = p.models.map((m) => modelSlotState(m, env.channelEnabled));
  const ranks = actualRanks(states);
  const slotOf = new Map(
    p.models.map((m, i) => [m.modelId, { state: states[i] ?? ('on' as SlotState), rank: ranks[i] ?? null }]),
  );
  const summary = summarizeOrder(states, '模型');
  const why =
    edit.disabledWhy ?? (filtering ? '正在筛选，只显示了一部分：清掉搜索和「只看已开启」再调先后' : null);
  // 视口：桌面宽屏填满父元素；平板固定 13 行；手机不超过 50 个就整页铺开（不设内部滚动），超过 50 个才开窗口
  const viewport = wide
    ? { height: 'fill' as const, rowHeight: ORDER_ROW_HEIGHT }
    : mobile
      ? long
        ? { height: LIST_HEIGHT, rowHeight: MOBILE_ROW_HEIGHT }
        : undefined
      : { height: ORDER_LIST_HEIGHT, rowHeight: ORDER_ROW_HEIGHT };
  return (
    <section
      aria-label="模型先后"
      className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card xl:h-full"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/40 px-3 py-2">
        <h3 className="text-sm font-semibold">模型先后</h3>
        <span className="text-caption text-muted-foreground">只管这个用途 · 引擎从上往下试</span>
        <span className="ml-auto">
          <AddPurposeModel purpose={p} onError={onError} />
        </span>
      </header>
      <OrderSummaryLine summary={summary} noun="模型" />
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
        <div className="min-h-0 flex-1">
          <SortableList
            ariaLabel="模型"
            items={shown}
            itemId={(m) => m.modelId}
            itemLabel={(m) => `${m.displayName}（${purposeLabel(p.purpose)}里的先后）`}
            disabled={why !== null}
            busy={edit.busy}
            disabledWhy={why}
            {...(viewport ? { viewport } : {})}
            rowClassName={(m) =>
              cn(
                'border-b',
                !viewport && 'min-h-11',
                slotOf.get(m.modelId)?.state !== 'on' && 'bg-muted/40',
                m.modelId === selectedId && 'bg-muted/70 shadow-row-selected',
              )
            }
            rowProps={(m) => ({ 'data-model': m.modelId })}
            onSave={(order, expected, movedId) =>
              edit.reorderModels({ purpose: p.purpose, movedId, order, expected })
            }
          >
            {(m, i, controls) => (
              <ModelRow
                purpose={p}
                model={m}
                position={p.models.findIndex((x) => x.modelId === m.modelId) + 1 || i + 1}
                slot={slotOf.get(m.modelId) ?? { state: 'on', rank: null }}
                selected={m.modelId === selectedId}
                onSelect={() => {
                  onSelect(m.modelId);
                  revealOnMobile('routing-model-detail');
                }}
                onError={onError}
                controls={controls}
              />
            )}
          </SortableList>
        </div>
      )}
    </section>
  );
}

function ModelRow({
  purpose,
  model: m,
  position,
  slot,
  selected,
  onSelect,
  onError,
  controls,
}: {
  purpose: RoutingLayerPurpose;
  model: RoutingLayerModel;
  position: number;
  slot: { state: SlotState; rank: number | null };
  selected: boolean;
  onSelect: () => void;
  onError: (message: string | null) => void;
  controls: RowControls;
}) {
  const enabledRouteIds = m.routes.filter((r) => r.enabled).map((r) => r.routeId);
  const kind = modelKind(m, useKindEnv());
  const skipped = slot.state !== 'on';
  return (
    <div className="flex h-full flex-col justify-center gap-0.5 py-1 pr-2 pl-1.5 md:flex-row md:items-center md:gap-1.5 md:py-0">
      <div className="flex min-w-0 items-center gap-1.5 md:h-full md:flex-1">
        {controls.grip}
        <span
          data-position
          title="配置里的先后"
          className="num grid size-5 shrink-0 place-items-center rounded-full bg-foreground/10 text-caption font-medium"
        >
          {position}
        </span>
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={`查看 ${m.displayName} 的路由`}
          title={modelSummary(m)}
          className={cn(
            'flex min-h-9 min-w-0 flex-1 items-center gap-2 text-left md:h-full md:min-h-0',
            skipped && 'opacity-60',
          )}
        >
          <KindDot kind={kind} whyNot="一条路由都没有" className="shrink-0" />
          <span
            data-row-name
            className="min-w-0 whitespace-normal break-words text-sm font-semibold leading-snug md:truncate"
          >
            {m.displayName}
          </span>
          {m.family ? (
            <span className="hidden truncate text-caption text-muted-foreground 2xl:inline">{m.family}</span>
          ) : null}
          {/* 几条路几条活：窄的时候放不下，悬停名字看（title），2xl 以上直接写在行里 */}
          <span className="hidden shrink-0 text-caption text-muted-foreground 2xl:inline">
            {modelSummary(m)}
          </span>
          <FounderOnlyBadge modelId={m.modelId} family={m.family} displayName={m.displayName} />
          <span
            data-slot-state={slot.state}
            className={cn(
              'ml-auto shrink-0 text-caption',
              skipped
                ? 'rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground'
                : 'num text-muted-foreground',
              !skipped && slot.rank !== position && 'font-semibold text-foreground',
            )}
          >
            {slotWord(slot.state, slot.rank, '模型')}
          </span>
        </button>
      </div>
      <div data-row-actions className="flex flex-wrap items-center justify-end gap-0.5">
        <PurposeModelControls purpose={purpose} model={m} onError={onError} />
        <ModelSwitch
          modelId={m.modelId}
          modelName={m.displayName}
          enabled={enabledRouteIds.length > 0}
          expectedEnabled={enabledRouteIds}
          unavailable={m.routes.length === 0}
        />
        {controls.pins}
      </div>
    </div>
  );
}
