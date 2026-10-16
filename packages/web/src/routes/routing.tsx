// 路由页（#574，specs/509 方案第八节「两层的每层都要能一眼看出这条现在活着吗」；#1366 第二部分改成分块）：
// 「用途 / 模型目录 / 渠道」三块一次看一块。每个用途按顺序排哪些模型，选中一个模型再看它下面每条路由现在活不活
// （桌面左右并排、右边跟着滚；手机整页纵向铺开）；关着的行降对比度写「已跳过」，实际顺位只数开着且没下架的（lib/routing-order.ts），
// 已下架的行写「已下架」不写名次；模型目录、渠道各是一列带搜索的紧凑行。活不活由后端现算（db 的 routing-liveness.ts），这页不再判一遍。
// 路由页样板（#1914，「ui到底做完没？怎么这么丑」）：
// - 这一页最该看的是「这个用途现在实际派给谁、为什么」：做成用途的标题块（用途名大一号，一句结论用正文字，细节灰字）。
// - 一行只留拖动柄、序号、名字加一行小字、一个状态、开关；档位、移出、上移下移置顶置底收进行尾「⋯」（悬停才露出），键盘 Alt+方向键照旧。
// - 页头右上只留一句汇总（红灯数为 0 不写红）和图标刷新，更新时间在悬停里；长说明都在 ⓘ。
// 改这里之前必须知道：
// - 不知道（探针没看过、额度没读成）不画成活，也不画成死：用停滞色，原因照写。
// - 没接上（开发环境内存版）和没读成是两回事：前者整块写 unavailable，后者写「没读成」和原因。都不画空表冒充「都没配」。
// - 先后、开关的写走 components/routing-edit.tsx（保存契约不变：带看到的旧顺序，别人先改了回 409）。

import { routingPurposeOf, SCOPE_NO_ROUTE } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { Route as RouteIcon } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { brand } from '#brand';
import { usePoolHolds, useRoutingEfforts, useRoutingLayers } from '../api/client';
import type { RoutingLayerModel, RoutingLayerPurpose } from '../api/types';
import { EmptyState } from '../components/layout/empty-state';
import { FilterTabGroups, FilterTabNote, FilterTabs } from '../components/layout/filter-tabs';
import { RowFrame } from '../components/layout/list';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Notice } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { Section, SectionGrid } from '../components/layout/section';
import { StatusBadge, StatusDot } from '../components/layout/status-badge';
import { Tag } from '../components/layout/tag';
import { ManualTracks } from '../components/manual-tracks';
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
import { EFFORTS_STALE_AFTER_MS, EffortsTab } from '../components/routing-efforts';
import { KindDot, useKindEnv } from '../components/routing-kinds';
import { AddPurposeModel, effortWord, PurposeModelMenu } from '../components/routing-membership';
import {
  CollapsibleOffModelRoutes,
  effortBlockedTitle,
  ModelRoutes,
  OrderSummaryLine,
  useRouteOrder,
} from '../components/routing-routes';
import { formatClock, TIME } from '../lib/format';
import { useMediaQuery, useNow } from '../lib/hooks';
import { filterActive, filterRows, type ListFilter, NO_FILTER, WINDOW_MIN_ROWS } from '../lib/list-window';
import { readRootScale, scaledPx } from '../lib/root-scale';
import { modelKind } from '../lib/route-kinds';
import {
  countByVerdict,
  firstLive,
  modelSummary,
  pickPurpose,
  purposeLabel,
  purposeLine,
  purposeLineFull,
  purposeVerdictLabel,
  routeHost,
  routeSlots,
  routeTitle,
  verdictTone,
} from '../lib/routing';
import { actualRanks, modelSlotState, type SlotState, slotWord, summarizeOrder } from '../lib/routing-order';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('路由') }];
}

/** 页头一行说明；细则收进标题旁的 ⓘ：首屏留给「谁在接活」和先后，不留给说明。 */
const SUMMARY = '每个用途里模型和渠道怎么排先后，现在哪些派得出去。';

const DESCRIPTION = (
  <div className="space-y-2">
    <p>
      每个用途按顺序排哪些模型、每个模型走哪几条路，现在派不派得出去。一条路接得上、额度够、没被禁令挡三件都过才算活。
    </p>
    <p>
      改先后：拖到新位置，或点每行行尾「⋯」里的上移、下移、置顶、置底，或聚焦拖动柄后按 Alt+上下键（Alt+Home
      置顶、Alt+End
      置底）；模型的先后只管这个用途，渠道的先后管这个模型在所有用途里。关着的行变淡、写「已跳过」：引擎自动跳过它、顺延给下一个，行上写的「实际第几位」只数开着且没下架的；已下架的不占名次，行上写「已下架」。
    </p>
    <p>
      模型、渠道、每条路由都有开关：模型开关关了，它在所有用途里不派；渠道开关关了，它下面的路由都不派。停用某个账号池在额度页那一行的开关。下一次选路就照新的。
    </p>
    <p>
      思考档位（起会话想多深）：点开一条路由就能改；所有路的档位放在「思考档位」页签里一张表看。改了下一个会话就照新的，不用发版。
    </p>
    <p>
      活 = 接得上、额度够、没被禁令挡三件都过；不知道 =
      探针还没看过、额度没读成，不当活。引擎派活时另看账号池有没有空位（满了是等，不算故障）；探针的结论过期了，引擎照上一次的结论派、写明，这里标「探测过期」。
    </p>
  </div>
);

const TABS = [
  { id: 'purposes', label: '用途' },
  { id: 'models', label: '模型目录' },
  { id: 'channels', label: '渠道' },
  // 思考档位并进路由页（#1914 第 5 轮）：所有路的档位一张表；每条路由展开后也能就地改
  { id: 'efforts', label: '思考档位' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const parseTab = (raw: string | null): TabId => TABS.find((t) => t.id === raw)?.id ?? 'purposes';

/** 路由两层每 30 秒重拉一次。刷新钮旁的新鲜度：1 分钟内不画，5 分钟内「数据有点旧」，更久「数据已过期」。 */
const ROUTING_STALE_AFTER_MS = 5 * TIME.MIN;

export default function Routing() {
  const { data, error, isLoading, isFetching, dataUpdatedAt, refetch } = useRoutingLayers();
  const efforts = useRoutingEfforts();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  // 刷新收成页头最右一个图标钮，最后更新时间在悬停里（和主页同一个样子，#1819）。
  // 「思考档位」页签看的是档位那份（没有推送，60 秒自己重拉）：刷新两份都重读，新鲜度按档位那份算。
  const refresh =
    tab === 'efforts'
      ? {
          onRefresh: () => {
            void efforts.refetch();
            void refetch();
          },
          isFetching: efforts.isFetching,
          // 共用秒表一拍最多慢 1 秒。刚读成的时间戳比「现在」新时压回这一拍，避免显示成「1 秒后」。
          dataUpdatedAt: efforts.dataUpdatedAt > now ? now : efforts.dataUpdatedAt,
          staleAfterMs: EFFORTS_STALE_AFTER_MS,
          variant: 'dot' as const,
        }
      : {
          onRefresh: () => void refetch(),
          isFetching,
          dataUpdatedAt,
          staleAfterMs: ROUTING_STALE_AFTER_MS,
          variant: 'dot' as const,
        };
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
  const page = { title: '路由', description: SUMMARY, detail: DESCRIPTION, refresh };

  // 从没读成：整页只写没读成和原因。读成过、刷新时失败：照旧画上一次读到的，顶上一条横幅带重试（不把看得到的清空）
  if (error && !data) {
    return (
      <Page {...page}>
        <LoadError what="路由两层" error={error} onRetry={() => void refetch()} />
      </Page>
    );
  }
  if (isLoading || !data) {
    return (
      <Page {...page}>
        <LoadingRows rows={6} />
      </Page>
    );
  }
  if (data.unavailable) {
    return (
      <Page {...page}>
        <Section>
          <div role="note">
            <EmptyState icon={RouteIcon} title={data.unavailable} />
          </div>
        </Section>
      </Page>
    );
  }

  // 只画对照里的用途。接口要是还带回老的（分诊、方案、审查……），当没点名，不占一格。
  const purposes = data.purposes.filter((p) => routingPurposeOf(p.purpose));

  return (
    <Page
      {...page}
      // 一个用途都没有时不报「派得出去」：那会读成没事
      actions={purposes.length > 0 ? <Summary purposes={purposes} asOf={data.asOf} /> : undefined}
      tabs={
        <FilterTabs
          aria-label="路由页分块"
          idPrefix="routing-tab"
          items={TABS}
          value={tab}
          onChange={setTab}
          className="w-fit"
        />
      }
    >
      {error ? (
        <div className="mb-4">
          <LoadError
            text={`路由两层刷新没读成，下面是上一次读到的：${errMessage(error)}`}
            error={error}
            onRetry={() => void refetch()}
          />
        </div>
      ) : null}
      <RoutingEditProvider>
        <div role="tabpanel" id="routing-panel" aria-labelledby={`routing-tab-${tab}`}>
          {tab === 'models' ? <ModelCatalogTab layers={data} /> : null}
          {tab === 'channels' ? <ChannelTab layers={data} /> : null}
          {tab === 'efforts' ? <EffortsTab /> : null}
          {tab === 'purposes' ? (
            <div className="flex flex-col gap-8">
              <ManualTracks data={data} />
              <PurposesTab purposes={purposes} params={params} />
            </div>
          ) : null}
        </div>
      </RoutingEditProvider>
    </Page>
  );
}

function PurposesTab({ purposes, params }: { purposes: RoutingLayerPurpose[]; params: URLSearchParams }) {
  const selected = pickPurpose(purposes, params.get('purpose'));
  if (purposes.length === 0 || !selected) {
    return (
      <Section>
        <EmptyState
          icon={RouteIcon}
          title="后端一个用途都没给"
          hint="每个用途都该有一份（没配的写明没配）：这不该发生，去看后端日志"
        />
      </Section>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <PurposeList purposes={purposes} selected={selected.purpose} params={params} />
      <div id="routing-purpose-detail" className="min-w-0 scroll-mt-4">
        <PurposeDetail key={selected.purpose} purpose={selected} />
      </div>
    </div>
  );
}

/** 页头右上的一句汇总：派得出去几个；不知道、派不出去是 0 就不写（红灯数为 0 不显示红）。算的时刻在悬停里。 */
function Summary({ purposes, asOf }: { purposes: RoutingLayerPurpose[]; asOf: string }) {
  const counts = countByVerdict(purposes);
  const worst = counts.dead > 0 ? 'fail' : counts.unknown > 0 ? 'stall' : 'done';
  return (
    <p
      data-routing-summary
      title={`${formatClock(asOf)} 后端现算`}
      className="flex items-center gap-2 text-body text-muted-foreground"
    >
      <StatusDot tone={worst} />
      <span className="num text-foreground">{counts.live} 个派得出去</span>
      {counts.unknown > 0 ? (
        <>
          <span aria-hidden>·</span>
          <span className="num text-ink-stall">{counts.unknown} 个不知道</span>
        </>
      ) : null}
      {counts.dead > 0 ? (
        <>
          <span aria-hidden>·</span>
          <span className="num font-medium text-ink-fail">{counts.dead} 个派不出去</span>
        </>
      ) : null}
    </p>
  );
}

/** 用途选择：流程里的一组、流程之外的一组（组头写「不是流程里的一段」），各带状态点和模型数。 */
function PurposeList({
  purposes,
  selected,
  params,
}: {
  purposes: RoutingLayerPurpose[];
  selected: string;
  params: URLSearchParams;
}) {
  const [, setParams] = useSearchParams();
  const env = useKindEnv();
  const flow = purposes.filter((p) => routingPurposeOf(p.purpose)?.aside !== true);
  const aside = purposes.filter((p) => routingPurposeOf(p.purpose)?.aside === true);
  const toItem = (p: RoutingLayerPurpose) => ({
    id: p.purpose,
    tone: verdictTone[p.verdict],
    count: p.models.length,
    label: (
      <span
        title={purposeLineFull(
          purposeLine(p, { retired: env.modelRetired, channelOpen: env.channelEnabled }),
        )}
      >
        <span className="sr-only">{purposeVerdictLabel[p.verdict]}：</span>
        {purposeLabel(p.purpose)}
        {/* 选中后标题块里写出来；按钮上只给读屏，不挤在筛选条里 */}
        {p.purpose === 'groom' ? <span className="sr-only">（{GROOM_HINT}）</span> : null}
      </span>
    ),
  });
  // 别的网址参数（?node=、?tab=）带着走
  const pick = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('purpose', id);
    setParams(next, { replace: true, preventScrollReset: true });
  };
  return (
    <nav aria-label="用途" className="min-w-0">
      <FilterTabGroups
        value={selected}
        onChange={pick}
        groups={[
          { key: 'flow', 'aria-label': '流程里的用途', items: flow.map(toItem) },
          ...(aside.length > 0
            ? [
                {
                  key: 'aside',
                  heading: '不是流程里的一段',
                  'aria-label': '流程之外的用途',
                  items: aside.map(toItem),
                  // 对题不选路：只读的一项，说明在悬停里，不另占一行
                  note: <FilterTabNote label="对题" detail={SCOPE_NO_ROUTE} />,
                },
              ]
            : []),
        ]}
      />
    </nav>
  );
}

const GROOM_HINT = '这里配指挥官用的模型';

/** 行高（桌面、平板）：名字一行加一行小字。只在超过 50 个模型、要开窗口时用；不到 50 个按内容高度、整页滚。 */
const ORDER_ROW_HEIGHT = 48;
/** 超过 50 个模型时窗口的高度：13 行，再多内部滚。 */
const ORDER_LIST_HEIGHT = ORDER_ROW_HEIGHT * 13;

/**
 * 用途的标题块：这一页最该看的一句——这个用途现在实际派给谁、为什么。
 * 用途名大一号、带结论标签；下一行是那句结论（正文字）；再下一行是走哪条路、几个在跑（灰字）。
 */
function PurposeHero({ purpose: p }: { purpose: RoutingLayerPurpose }) {
  const env = useKindEnv();
  const line = purposeLine(p, { retired: env.modelRetired, channelOpen: env.channelEnabled });
  const first = firstLive(p);
  // 灰字一行：结论的补充（走哪条路、为什么不是首选）+ 执行方式和在跑几个 + 用途自己的提示
  // 窄屏放不下时截掉的是最后的「在跑几个」，所以用途自己的提示排在前面
  const notes: string[] = [];
  if (p.purpose === 'groom') notes.push(GROOM_HINT);
  if (p.purpose === 'judge' && p.verdict === 'unknown') notes.push('按量计费，不自动探，不用处理');
  if (line.detail && p.models.length > 0) notes.push(line.detail);
  if (first) {
    const via = routeTitle(first.route);
    if (!line.detail?.includes(via)) notes.push(`走 ${via}`);
    notes.push(`${routeHost(first.route)} · ${routeSlots(first.route).text}`);
  }
  const noteText = notes.join(' · ');
  const badge = <StatusBadge tone={verdictTone[p.verdict]} label={purposeVerdictLabel[p.verdict]} />;
  return (
    // 三行、每行都不折（#1914 第 5 轮，创始人看 390 宽「变成 2 行了」）：用途名一行；结论短话带状态标签一行
    // （短话放不下就截断、标签不挤走）；灰字补充一行（放不下截断，整句在悬停里）。
    <header data-purpose-hero className="flex min-w-0 flex-col pt-2">
      <div className="mb-3 flex min-w-0 items-baseline gap-2 whitespace-nowrap">
        <h2 className="truncate text-subtitle">{purposeLabel(p.purpose)}</h2>
        <span className="shrink-0 text-meta text-muted-foreground">{p.purpose}</span>
      </div>
      {/* 一个模型都没排：那句话就是缺口本身，下面缺口栏已经写了，不在这里再写一遍 */}
      {p.models.length > 0 ? (
        <p
          data-hero-line
          title={purposeLineFull(line)}
          className="flex min-w-0 items-center gap-2.5 whitespace-nowrap text-heading font-normal"
        >
          {line.tone === 'done' ? null : <StatusDot tone={line.tone} className="shrink-0" />}
          <span data-hero-text className="min-w-0 truncate">
            {line.text}
          </span>
          <span className="shrink-0">{badge}</span>
        </p>
      ) : (
        <p>{badge}</p>
      )}
      {noteText ? (
        <p data-hero-notes title={noteText} className="mt-1.5 truncate text-meta text-muted-foreground">
          {noteText}
        </p>
      ) : null}
    </header>
  );
}

function PurposeDetail({ purpose: p }: { purpose: RoutingLayerPurpose }) {
  const now = useNow();
  const env = useKindEnv();
  const first = firstLive(p);
  const edit = useRoutingEdit();
  const holds = usePoolHolds();
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const modelIsOff = (m: RoutingLayerModel) =>
    modelSlotState(m, env.channelEnabled, env.modelRetired(m.modelId)) === 'off';
  // 选中看路由的模型：点过的优先；没点过，进来那一刻看顺位第一条活的所在的模型，没有就第一个。
  // 进来时定下来就不跟着变：开关一关、先后一调，顺位第一条活的会换，不能让下面的路由跟着跳到别的模型。
  const [picked, setPicked] = useState<string | null>(
    () => first?.model.modelId ?? p.models[0]?.modelId ?? null,
  );
  // 点选已关模型时默认折叠；看着开着的模型被关掉则不叠折叠层，好当场核开关（#1754）。
  const [foldOffRoutes, setFoldOffRoutes] = useState(() => {
    const id = first?.model.modelId ?? p.models[0]?.modelId;
    const m = id ? p.models.find((x) => x.modelId === id) : undefined;
    return m ? modelIsOff(m) : false;
  });
  const selectModel = (modelId: string) => {
    setPicked(modelId);
    const m = p.models.find((x) => x.modelId === modelId);
    setFoldOffRoutes(m ? modelIsOff(m) : false);
  };
  const current = p.models.find((m) => m.modelId === picked) ?? p.models[0];
  const currentPosition = current ? p.models.findIndex((m) => m.modelId === current.modelId) + 1 : 0;
  const currentOff = current !== undefined && modelIsOff(current);
  return (
    <section aria-label={`${purposeLabel(p.purpose)}的调整顺序`} className="flex flex-col gap-6">
      <PurposeHero purpose={p} />
      {edit.disabledWhy ? (
        <Notice tone="info">{edit.disabledWhy}。先后、开关、添加和档位都不能改。</Notice>
      ) : null}
      {holds.error ? <Notice tone="fail">整池暂停没读成，路由先不能单独开。</Notice> : null}
      {membershipError ? <Notice tone="fail">{membershipError}</Notice> : null}
      {p.problems.length > 0 ? (
        <Notice tone="fail">
          <ul aria-label="配置缺口" className="space-y-1">
            {p.problems.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {p.models.length === 0 ? (
        <Section>
          <EmptyState
            icon={RouteIcon}
            title="这个用途还没排模型"
            hint="从目录里挑一个，引擎就能往这里派"
            action={<AddPurposeModel purpose={p} onError={setMembershipError} />}
          />
        </Section>
      ) : (
        // 桌面（xl）：左模型先后、右这个模型下的路由，并排，各按各的内容高度（items-start，不互相拉高）；
        // 右边跟着页面滚动停在顶上（sticky），路由多了封顶在 routing-desk 高度、内部自己滚；窄屏纵向铺开
        <SectionGrid cols={1} className="items-start xl:grid-cols-routing-desk">
          <ModelPriority
            purpose={p}
            selectedId={current?.modelId}
            onSelect={selectModel}
            onError={setMembershipError}
          />
          {current ? (
            <RoutesCard
              model={current}
              off={currentOff && foldOffRoutes}
              position={currentPosition}
              now={now}
              firstLiveRoute={first?.model === current ? first.route.routeId : undefined}
            />
          ) : null}
        </SectionGrid>
      )}
    </section>
  );
}

/** 右边：选中模型下的路由。先后不分用途，管这个模型在所有用途里。 */
function RoutesCard({
  model,
  off,
  position,
  now,
  firstLiveRoute,
}: {
  model: RoutingLayerModel;
  off: boolean;
  position: number;
  now: number;
  firstLiveRoute: string | undefined;
}) {
  const order = useRouteOrder(model);
  return (
    <Section
      id="routing-model-detail"
      aria-label={`${model.displayName} 的路由`}
      title={`${model.displayName} 的路由`}
      description={
        <>
          {/* 手机上卡头一行放不下（不许折行），这半句收起，ⓘ 里有 */}
          <span className="max-md:hidden">所有用途共用这个先后 · </span>
          {model.routes.length > 0 ? <OrderSummaryLine summary={order} noun="路由" /> : modelSummary(model)}
        </>
      }
      flush
      className="flex min-h-0 scroll-mt-4 flex-col xl:sticky xl:top-6 xl:max-h-routing-desk *:last:flex *:last:min-h-0 *:last:flex-1 *:last:flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
        {off ? (
          <CollapsibleOffModelRoutes
            key={model.modelId}
            model={model}
            position={position}
            now={now}
            firstLiveRoute={firstLiveRoute}
            summary={false}
          />
        ) : (
          <ModelRoutes
            key={model.modelId}
            model={model}
            now={now}
            firstLiveRoute={firstLiveRoute}
            summary={false}
          />
        )}
      </div>
    </Section>
  );
}

/**
 * 这个用途下的模型先后：一行一个模型（拖动柄、序号、名字加一行小字、一个状态、开关、「⋯」），拖动或「⋯」里的上移、下移、置顶、置底、
 * Alt+上下键改先后，点名字在旁边看它的路由。关着的行变淡写「已跳过」，「实际第几位」只数开着且没下架的；已下架的写「已下架」，不写名次。
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
  const states = p.models.map((m) => modelSlotState(m, env.channelEnabled, env.modelRetired(m.modelId)));
  const ranks = actualRanks(states);
  const slotOf = new Map(
    p.models.map((m, i) => [m.modelId, { state: states[i] ?? ('on' as SlotState), rank: ranks[i] ?? null }]),
  );
  const summary = summarizeOrder(states, '模型');
  const why =
    edit.disabledWhy ?? (filtering ? '正在筛选，只显示了一部分：清掉搜索和「只看已开启」再调先后' : null);
  // 不超过 50 个：按内容高度、随页面滚（不设内部滚动）；超过 50 个才开窗口（定高行、只画看得见的）
  // 行高、窗口高是 16px 根字号下的设计值，乘根字号倍数（桌面 125%，#1937）才和 rem 写的行内容对得上
  const scale = readRootScale();
  const viewport = long
    ? mobile
      ? { height: scaledPx(LIST_HEIGHT, scale), rowHeight: scaledPx(MOBILE_ROW_HEIGHT, scale) }
      : { height: scaledPx(ORDER_LIST_HEIGHT, scale), rowHeight: scaledPx(ORDER_ROW_HEIGHT, scale) }
    : undefined;
  return (
    <Section
      aria-label="模型先后"
      title="模型先后"
      description={
        <>
          {/* 手机上卡头和「添加模型」挤一行，前半句收起，不折行 */}
          <span className="max-md:hidden">只管{purposeLabel(p.purpose)} · </span>
          <OrderSummaryLine summary={summary} noun="模型" />
        </>
      }
      actions={<AddPurposeModel purpose={p} onError={onError} />}
      flush
      className="flex min-h-0 flex-col *:last:flex *:last:min-h-0 *:last:flex-1 *:last:flex-col"
    >
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
        <EmptyState size="inline" title="没有符合的模型：换个搜索词，或关掉「只看已开启」" className="py-6" />
      ) : (
        <div className="relative min-h-0 flex-1 py-1">
          <SortableList
            ariaLabel="模型"
            // 行和行之间一根极细的分隔线，不画框（#1914 第 4 轮）
            className="divide-y divide-border"
            items={shown}
            itemId={(m) => m.modelId}
            itemLabel={(m) => `${m.displayName}（${purposeLabel(p.purpose)}里的先后）`}
            disabled={why !== null}
            busy={edit.busy}
            disabledWhy={why}
            {...(viewport ? { viewport } : {})}
            rowClassName={(m) =>
              m.modelId === selectedId ? 'bg-selected shadow-row-selected' : 'hover:bg-accent'
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
                fixedHeight={viewport !== undefined}
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
    </Section>
  );
}

function ModelRow({
  purpose,
  model: m,
  position,
  slot,
  selected,
  fixedHeight,
  onSelect,
  onError,
  controls,
}: {
  purpose: RoutingLayerPurpose;
  model: RoutingLayerModel;
  position: number;
  slot: { state: SlotState; rank: number | null };
  selected: boolean;
  fixedHeight: boolean;
  onSelect: () => void;
  onError: (message: string | null) => void;
  controls: RowControls;
}) {
  const enabledRouteIds = m.routes.filter((r) => r.enabled).map((r) => r.routeId);
  const kind = modelKind(m, useKindEnv());
  const skipped = slot.state !== 'on';
  // 档位配不了的长说明：行内不铺开，悬停小字看全文（#1754）；菜单里档位组头下面也写着
  const effortTitle = effortBlockedTitle(m.modelId, m.routes);
  const effort = effortWord(m.effort);
  const meta = [m.family, modelSummary(m), effort ? `档位 ${effort}` : null].filter(Boolean).join(' · ');
  const word = slotWord(slot.state, slot.rank, '模型');
  return (
    <RowFrame tall className={cn(fixedHeight && 'h-full')}>
      {controls.grip}
      <span
        data-position
        title="配置里的先后"
        className="num w-4 shrink-0 text-right text-body text-muted-foreground"
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
          'flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-focus focus-visible:ring-ring md:min-h-0',
          skipped && 'opacity-60',
        )}
      >
        <KindDot kind={kind} whyNot="一条路由都没有" className="shrink-0" />
        {/* 小字一行不折（#1914 第 5 轮，320 宽量到折行）：放不下截断，整句在悬停里。
            名字是认人的那一样，不截断：真长到放不下宁可换行（老规矩，test/routing-lists「名字可换行」） */}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2">
            <span data-row-name className="text-body font-medium break-words">
              {m.displayName}
            </span>
            <FounderOnlyBadge modelId={m.modelId} family={m.family} displayName={m.displayName} />
          </span>
          <span
            data-row-meta
            data-effort-tip={effortTitle ? '' : undefined}
            title={effortTitle ? `档位配不了：${effortTitle}` : `${meta} · ${word}`}
            className="block truncate whitespace-nowrap text-meta text-muted-foreground"
          >
            {/* 手机上一行放不下名字、状态和开关：厂家不写，实际第几位挪到这行小字里 */}
            <span className="max-md:hidden">{meta}</span>
            <span aria-hidden className="md:hidden">
              {[modelSummary(m), effort ? `档位 ${effort}` : null, word].filter(Boolean).join(' · ')}
            </span>
          </span>
        </span>
      </button>
      <span
        data-slot-state={slot.state}
        title={word}
        className={cn(
          'shrink-0 text-meta max-md:sr-only',
          !skipped && 'num text-muted-foreground',
          !skipped && slot.rank !== position && 'font-medium text-foreground',
        )}
      >
        {skipped ? <Tag>{word}</Tag> : word}
      </span>
      <span data-row-actions className="flex shrink-0 items-center gap-1">
        <ModelSwitch
          modelId={m.modelId}
          modelName={m.displayName}
          enabled={enabledRouteIds.length > 0}
          expectedEnabled={enabledRouteIds}
          unavailable={m.routes.length === 0}
        />
        <PurposeModelMenu purpose={purpose} model={m} onError={onError} moves={controls.moves} />
      </span>
    </RowFrame>
  );
}
