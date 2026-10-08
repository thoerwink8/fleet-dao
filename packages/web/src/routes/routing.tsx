// 路由页（#574，specs/509 方案第八节「两层的每层都要能一眼看出这条现在活着吗」）：每个用途 → 模型 → 路由，每一层活 / 死 /
// 不知道和原因。活不活由后端现算（db 的 routing-liveness.ts），这页不再判一遍；先后拖动改、开关能改（母单 #1089、#1333）。
// 改这里之前必须知道：
// - 不知道（探针没看过、额度没读成）不画成活，也不画成死：用停滞色，原因照写。
// - 没接上（开发环境内存版）和没读成是两回事：前者整块写 unavailable，后者写「没读成」和原因。都不画空表冒充「都没配」。

import { routingPurposeOf, SCOPE_NO_ROUTE } from '@fleet-dao/shared';
import { Route as RouteIcon, TriangleAlert } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { usePoolHolds, useRouting, useRoutingLayers } from '../api/client';
import type {
  LivenessFact,
  RoutingLayerModel,
  RoutingLayerPurpose,
  RoutingLayerRoute,
  RoutingLayers,
} from '../api/types';
import { ChannelStrip } from '../components/channel-status';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import {
  ChannelSwitch,
  ModelSwitch,
  RouteSwitch,
  RoutingEditProvider,
  SortableList,
  useRoutingEdit,
} from '../components/routing-edit';
import { PoolHoldControl } from '../components/routing-hold';
import { StatusChip, StatusDot } from '../components/status';
import { Badge } from '../components/ui/badge';
import { stageLabel } from '../lib/catalog';
import { buildChannelCards } from '../lib/channel-status';
import { formatAgo, formatClock, formatIn } from '../lib/format';
import { useNow } from '../lib/hooks';
import { poolIsHeld } from '../lib/pool-holds';
import {
  countByVerdict,
  firstLive,
  modelSummary,
  pickPurpose,
  probeStale,
  purposeLine,
  purposeVerdictLabel,
  routeHost,
  routeSlots,
  routeTitle,
  verdictLabel,
  verdictTone,
} from '../lib/routing';
import { type Tone, toneText } from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('路由') }];
}

const DESCRIPTION =
  '每个用途按顺序排哪些模型、每个模型走哪几条路，现在派不派得出去。一条路接得上、额度够、没被禁令挡三件都过才算活。拖到新位置改先后（键盘：方向键挪，回车确认）：模型的先后只管这个用途，渠道的先后管这个模型在所有用途里。模型开关关了，它在所有用途里不派；渠道开关关了，它下面的路由都不派。账号池可以在这里整池暂停。下一次选路就照新的。';

/** 一句话的颜色：好消息不上色（只用灰），要看的才上色。 */
const lineInk = (tone: Tone) => (tone === 'done' ? 'text-muted-foreground' : toneText[tone]);

/** 这一格在路由页上的名字。不在对照里的用途不该被画出来（调用方先滤掉）。 */
function purposeLabel(purpose: RoutingLayerPurpose['purpose']): string {
  return routingPurposeOf(purpose)?.label ?? stageLabel[purpose];
}

export default function Routing() {
  const { data, error, isLoading } = useRoutingLayers();
  const [params] = useSearchParams();
  const detail = useRef<HTMLDivElement>(null);

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
  const selected = pickPurpose(purposes, params.get('purpose'));
  // 窄屏上清单在上、详情在下：点了就滚到详情（宽屏两栏并排，不用滚）
  const reveal = () => {
    if (!window.matchMedia?.('(max-width: 1279px)').matches) return;
    requestAnimationFrame(() => detail.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
  };

  return (
    <Page
      title="路由"
      description={DESCRIPTION}
      // 一个用途都没有时不报「0 个派不出去」：那会读成没事
      actions={purposes.length > 0 ? <Summary purposes={purposes} asOf={data.asOf} /> : undefined}
    >
      <RoutingEditProvider>
        <ChannelSummary layers={data} />
        <ModelRosterNotice layers={data} />
        {purposes.length === 0 || !selected ? (
          <Panel>
            <Empty
              icon={RouteIcon}
              title="后端一个用途都没给"
              hint="每个用途都该有一份（没配的写明没配）：这不该发生，去看后端日志"
            />
          </Panel>
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-routing">
            <PurposeList purposes={purposes} selected={selected.purpose} onPick={reveal} />
            <div ref={detail} className="min-w-0 scroll-mt-4">
              <PurposeDetail purpose={selected} />
            </div>
          </div>
        )}
      </RoutingEditProvider>
    </Page>
  );
}

/**
 * 渠道名册和目录的差（#1302）。只列，不放按钮：加模型走改 deploy/catalog.json 的 PR。
 * 没读到、读失败、还没读过，都不写「都对得上」。两头都空、也没有失败时才写那一句。
 */
function ModelRosterNotice({ layers }: { layers: RoutingLayers }) {
  const roster = layers.modelRoster;
  let body: ReactNode;
  if (layers.modelRosterUnavailable) {
    body = <p>{layers.modelRosterUnavailable}</p>;
  } else if (!roster) {
    body = <p>渠道模型表没读到，不能当成都对得上</p>;
  } else if (
    roster.missingFromCatalog.length === 0 &&
    roster.goneRoutes.length === 0 &&
    roster.failed.length === 0 &&
    roster.notYet.length === 0
  ) {
    body = <p>都对得上</p>;
  } else {
    body = (
      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">渠道里有、目录里还没有的模型</h2>
          {roster.missingFromCatalog.length === 0 ? (
            <p className="mt-1 text-muted-foreground">没有</p>
          ) : (
            <ul className="mt-1 list-disc pl-5">
              {roster.missingFromCatalog.map((item) => (
                <li key={`${item.channelId}:${item.modelKey}`}>
                  {item.channelName}：{item.modelKey}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2 className="text-sm font-semibold">目录里有、渠道已不认的路由</h2>
          {roster.goneRoutes.length === 0 ? (
            <p className="mt-1 text-muted-foreground">没有</p>
          ) : (
            <ul className="mt-1 list-disc pl-5">
              {roster.goneRoutes.map((item) => (
                <li key={item.routeId}>
                  {item.channelName} 的路由 {item.routeId}（模型 {item.modelId}，
                  {item.upstreamModel ? `上游串 ${item.upstreamModel}` : '目录没写上游串'}）
                </li>
              ))}
            </ul>
          )}
        </div>
        {roster.failed.map((item) => (
          <p key={item.channelId}>
            {item.channelName} 没读成（{item.code}）：{item.message}
          </p>
        ))}
        {roster.notYet.map((item) => (
          <p key={item.channelId}>{item.channelName} 还没读过</p>
        ))}
      </div>
    );
  }
  return (
    <section
      aria-label="渠道模型表"
      className="mb-4 rounded-xl border border-dashed bg-card px-4 py-3 text-sm"
    >
      {body}
    </section>
  );
}

/** 顶上一行渠道一览（细看、立即探测在渠道状态页）。目录读不到照说没读成，不画空的一行。 */
function ChannelSummary({ layers }: { layers: RoutingLayers }) {
  const routing = useRouting();
  const now = useNow();
  if (routing.error) {
    return (
      <div className="mb-4">
        <LoadError what="渠道状态" error={routing.error} />
      </div>
    );
  }
  if (!routing.data) return null;
  return (
    <ChannelStrip
      cards={buildChannelCards(routing.data, layers, now)}
      now={now}
      extra={(card) => (
        <ChannelSwitch channelId={card.channel.id} name={card.channel.name} enabled={card.channel.enabled} />
      )}
    />
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
  onPick,
}: {
  purposes: RoutingLayerPurpose[];
  selected: string;
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
          <PurposeItem key={p.purpose} purpose={p} selected={selected} onPick={onPick} />
        ))}
      </ul>
      {aside.length > 0 ? (
        <div className="mt-4">
          <p className="mb-2 px-1 text-caption text-muted-foreground">不是流程里的一段</p>
          <ul className="space-y-2">
            {aside.map((p) => (
              <PurposeItem key={p.purpose} purpose={p} selected={selected} onPick={onPick} />
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
  onPick,
}: {
  purpose: RoutingLayerPurpose;
  selected: string;
  onPick: () => void;
}) {
  const line = purposeLine(p);
  const active = p.purpose === selected;
  return (
    <li>
      <Link
        to={{ search: `?purpose=${p.purpose}` }}
        replace
        preventScrollReset
        onClick={onPick}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'block rounded-xl border bg-card px-3.5 py-3 shadow-card-edge transition-colors hover:border-border-strong',
          active && 'border-border-strong bg-muted/60',
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{purposeLabel(p.purpose)}</span>
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
        <SortableList
          ariaLabel="模型"
          items={p.models}
          itemId={(m) => m.modelId}
          itemLabel={(m) => `${m.displayName}（${purposeLabel(p.purpose)}里的先后）`}
          disabled={edit.disabledWhy !== null || edit.busy}
          disabledWhy={edit.disabledWhy}
          className="space-y-3"
          rowClassName={() => 'overflow-hidden rounded-lg border'}
          rowProps={(m) => ({ 'data-model': m.modelId })}
          onSave={(order, expected, movedId) =>
            edit.reorderModels({ purpose: p.purpose, movedId, order, expected })
          }
        >
          {(m, i, handle) => (
            <ModelBlock
              model={m}
              index={i}
              handle={handle}
              now={now}
              firstLiveRoute={first?.model === m ? first.route.routeId : undefined}
            />
          )}
        </SortableList>
      ) : null}
      <p className="mt-4 text-caption text-muted-foreground">
        活 = 接得上、额度够、没被禁令挡三件都过；不知道 =
        探针还没看过、额度没读成，不当活。引擎派活时另看账号池有没有空位
        （满了是等，不算死）；探针的结论过期了，引擎照上一次的结论派、写明，这里标「探测过期」。
      </p>
    </Panel>
  );
}

function ModelBlock({
  model: m,
  index,
  handle,
  now,
  firstLiveRoute,
}: {
  model: RoutingLayerModel;
  index: number;
  handle: ReactNode;
  now: number;
  firstLiveRoute: string | undefined;
}) {
  const edit = useRoutingEdit();
  const enabledRouteIds = m.routes.filter((r) => r.enabled).map((r) => r.routeId);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/40 px-3 py-2">
        <span className="num grid size-5 place-items-center rounded-full bg-foreground/10 text-caption font-medium">
          {index + 1}
        </span>
        <span className="text-sm font-semibold">{m.displayName}</span>
        {m.family ? <span className="text-caption text-muted-foreground">{m.family}</span> : null}
        <StatusChip tone={verdictTone[m.verdict]} label={verdictLabel[m.verdict]} />
        <span className="ml-auto text-caption text-muted-foreground">{modelSummary(m)}</span>
        <ModelSwitch
          modelId={m.modelId}
          modelName={m.displayName}
          enabled={enabledRouteIds.length > 0}
          expectedEnabled={enabledRouteIds}
          unavailable={m.routes.length === 0}
        />
        {handle}
      </div>
      {m.routes.length === 0 ? (
        <p className="px-3 py-2.5 text-sub text-ink-fail">这个模型下一条路由都没有：排了它也派不到它</p>
      ) : (
        <SortableList
          ariaLabel={`${m.displayName} 的路由`}
          items={m.routes}
          itemId={(r) => r.routeId}
          itemLabel={(r) => `${routeTitle(r)}（${m.displayName} 下的先后）`}
          disabled={edit.disabledWhy !== null || edit.busy}
          disabledWhy={edit.disabledWhy}
          rowClassName={(r) => cn('border-b px-3 py-2.5 last:border-b-0', !r.enabled && 'bg-muted/30')}
          rowProps={(r) => ({ 'data-route': r.routeId })}
          onSave={(order, expected, movedId) =>
            edit.reorderRoutes({ modelId: m.modelId, movedId, order, expected })
          }
        >
          {(r, i, routeHandle) => (
            <RouteItem
              route={r}
              index={i}
              modelId={m.modelId}
              modelName={m.displayName}
              handle={routeHandle}
              now={now}
              firstLive={r.routeId === firstLiveRoute}
            />
          )}
        </SortableList>
      )}
    </>
  );
}

function RouteItem({
  route: r,
  index,
  modelId,
  modelName,
  handle,
  now,
  firstLive: isFirst,
}: {
  route: RoutingLayerRoute;
  index: number;
  modelId: string;
  modelName: string;
  handle: ReactNode;
  now: number;
  firstLive: boolean;
}) {
  const stale = probeStale(r, now);
  const slots = routeSlots(r);
  const edit = useRoutingEdit();
  const routing = useRouting();
  const holds = usePoolHolds();
  const name = routeTitle(r);
  // 目录没读到不猜渠道关没关：只有读到了且 enabled 为 false 才换成「渠道已关」。
  const channelOff = routing.data
    ? routing.data.channels.find((c) => c.id === r.channelId)?.enabled === false
    : false;
  const poolLocked = Boolean(holds.data && poolIsHeld(holds.data, r.poolId));
  const lockWhy = holds.error
    ? '整池暂停没读成，先不能开这条路由'
    : poolLocked
      ? '这个账号池整池暂停，不能单独开'
      : null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="num text-caption text-muted-foreground">{index + 1}.</span>
        <span className="text-sub font-medium">{name}</span>
        <StatusChip tone={verdictTone[r.verdict]} label={verdictLabel[r.verdict]} />
        {r.enabled ? null : (
          <Badge variant="outline" className="h-4 px-1 text-micro font-normal">
            关着
          </Badge>
        )}
        {isFirst ? (
          <Badge variant="secondary" className="h-4 px-1 text-micro font-normal">
            顺位第一条活的
          </Badge>
        ) : null}
        <span className="text-caption text-muted-foreground">
          {routeHost(r)} · <span className="num">{slots.text}</span>
          {slots.full ? <span className="text-ink-stall">（满了，等空位，不算死）</span> : null}
        </span>
        <PoolHoldControl poolId={r.poolId} routeId={r.routeId} />
        <span className="num ml-auto truncate text-micro text-faint" title={r.routeId}>
          {r.routeId}
        </span>
        {channelOff ? (
          <span className="text-caption text-muted-foreground" title="渠道关了，这里不能单独开">
            渠道已关
          </span>
        ) : (
          <RouteSwitch
            label={name}
            enabled={r.enabled}
            lockedWhy={lockWhy}
            onToggle={() =>
              edit.toggleRoute({
                modelId,
                modelName,
                routeId: r.routeId,
                routeName: name,
                enabled: r.enabled,
              })
            }
          />
        )}
        {handle}
      </div>
      <div className="mt-2 grid gap-x-4 gap-y-2 md:grid-cols-3">
        <Fact label="接得上" fact={r.connect}>
          {r.probedAt ? (
            stale ? (
              <span className="text-ink-stall">
                探测过期：{formatAgo(r.probedAt, now)}的结论，探针可能停了
              </span>
            ) : (
              <>{formatAgo(r.probedAt, now)}探的</>
            )
          ) : null}{' '}
          <Link
            to={`/routing/status?p=${encodeURIComponent(r.channelId)}`}
            className="underline underline-offset-2 hover:text-foreground"
          >
            原文、立即探测
          </Link>
        </Fact>
        <Fact label="额度够" fact={r.quota}>
          {r.exhausted.length > 0
            ? r.exhausted.map((w) => (
                <span key={w.label} className="block">
                  {w.label}：{w.resetsAt ? `${formatIn(w.resetsAt, now)}清零` : '清零时刻没读到'}
                </span>
              ))
            : null}
        </Fact>
        <Fact label="禁令与开关" fact={r.ban} />
      </div>
    </>
  );
}

function Fact({ label, fact, children }: { label: string; fact: LivenessFact; children?: ReactNode }) {
  const tone = verdictTone[fact.verdict];
  return (
    <div className="min-w-0">
      <div className="text-caption text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-start gap-1.5 text-sub">
        <StatusDot tone={tone} className="mt-1.5" />
        {/* 过了的一件用灰字，没过的（死、不知道）才上色：一眼先看到卡在哪 */}
        <span
          className={cn(
            'min-w-0 break-words',
            fact.verdict === 'live' ? 'text-muted-foreground' : toneText[tone],
          )}
        >
          <span className="sr-only">{verdictLabel[fact.verdict]}：</span>
          {fact.reason}
        </span>
      </div>
      {children ? <div className="mt-0.5 pl-3.5 text-caption text-muted-foreground">{children}</div> : null}
    </div>
  );
}
