// 路由页（#574，specs/509 方案第八节「两层的每层都要能一眼看出这条现在活着吗」）：每个用途 → 模型 → 路由，每一层活 / 死 /
// 不知道和原因。活不活由后端现算（db 的 routing-liveness.ts），这页不再判一遍；先后和开关能改（母单 #1089，components/routing-edit.tsx：点之前二次确认、带看到的顺序防同时改）。
// 改这里之前必须知道：
// - 不知道（探针没看过、额度没读成）不画成活，也不画成死：用停滞色，原因照写。
// - 没接上（开发环境内存版）和没读成是两回事：前者整块写 unavailable，后者写「没读成」和原因。都不画空表冒充「都没配」。

import { routingPurposeOf, SCOPE_NO_ROUTE } from '@fleet-dao/shared';
import { Route as RouteIcon, TriangleAlert } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { useRouting, useRoutingLayers } from '../api/client';
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
  MoveButtons,
  type OrderItem,
  RouteSwitch,
  RoutingEditProvider,
  useRoutingEdit,
} from '../components/routing-edit';
import { StatusChip, StatusDot } from '../components/status';
import { Badge } from '../components/ui/badge';
import { stageLabel } from '../lib/catalog';
import { buildChannelCards } from '../lib/channel-status';
import { formatAgo, formatClock, formatIn } from '../lib/format';
import { useNow } from '../lib/hooks';
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
  '每个用途按顺序排哪些模型、每个模型走哪几条路，现在派不派得出去。一条路接得上、额度够、没被禁令挡三件都过才算活。右边的上移 / 下移和开关改顺序：模型的先后只管这个用途，渠道的先后和开关管这个模型在所有用途里；下一次选路就照新的。';

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
      <ChannelSummary layers={data} />
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
            <RoutingEditProvider>
              <PurposeDetail purpose={selected} />
            </RoutingEditProvider>
          </div>
        </div>
      )}
    </Page>
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
  return <ChannelStrip cards={buildChannelCards(routing.data, layers, now)} now={now} />;
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
  const { disabledWhy } = useRoutingEdit();
  const modelItems: OrderItem[] = p.models.map((m) => ({ id: m.modelId, name: m.displayName }));
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
      {disabledWhy ? (
        <p
          role="note"
          className="mb-3 rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-sub text-muted-foreground"
        >
          {disabledWhy}：上移、下移和开关都不能点。
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
        <ol aria-label="模型" className="space-y-3">
          {p.models.map((m, i) => (
            <ModelBlock
              key={m.modelId}
              model={m}
              index={i}
              purpose={p.purpose}
              modelItems={modelItems}
              now={now}
              firstLiveRoute={first?.model === m ? first.route.routeId : undefined}
            />
          ))}
        </ol>
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
  purpose,
  modelItems,
  now,
  firstLiveRoute,
}: {
  model: RoutingLayerModel;
  index: number;
  purpose: RoutingLayerPurpose['purpose'];
  /** 这个用途下此刻画着的模型先后（上移 / 下移带它当「我看到的」）。 */
  modelItems: OrderItem[];
  now: number;
  firstLiveRoute: string | undefined;
}) {
  const edit = useRoutingEdit();
  const routeItems: OrderItem[] = m.routes.map((r) => ({ id: r.routeId, name: routeTitle(r) }));
  return (
    <li className="overflow-hidden rounded-lg border" data-model={m.modelId}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/40 px-3 py-2">
        <span className="num grid size-5 place-items-center rounded-full bg-foreground/10 text-caption font-medium">
          {index + 1}
        </span>
        <span className="text-sm font-semibold">{m.displayName}</span>
        {m.family ? <span className="text-caption text-muted-foreground">{m.family}</span> : null}
        <StatusChip tone={verdictTone[m.verdict]} label={verdictLabel[m.verdict]} />
        <span className="ml-auto text-caption text-muted-foreground">{modelSummary(m)}</span>
        <MoveButtons
          label={`${m.displayName}（${purposeLabel(purpose)}里的先后）`}
          canUp={index > 0}
          canDown={index < modelItems.length - 1}
          onMove={(direction) =>
            edit.moveModel({
              purpose,
              purposeName: purposeLabel(purpose),
              items: modelItems,
              index,
              direction,
            })
          }
        />
      </div>
      {m.routes.length === 0 ? (
        <p className="px-3 py-2.5 text-sub text-ink-fail">这个模型下一条路由都没有：排了它也派不到它</p>
      ) : (
        <ol aria-label={`${m.displayName} 的路由`}>
          {m.routes.map((r, i) => (
            <RouteItem
              key={r.routeId}
              route={r}
              index={i}
              modelId={m.modelId}
              modelName={m.displayName}
              routeItems={routeItems}
              now={now}
              firstLive={r.routeId === firstLiveRoute}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

function RouteItem({
  route: r,
  index,
  modelId,
  modelName,
  routeItems,
  now,
  firstLive: isFirst,
}: {
  route: RoutingLayerRoute;
  index: number;
  modelId: string;
  modelName: string;
  /** 这个模型下此刻画着的渠道先后（上移 / 下移带它当「我看到的」）。 */
  routeItems: OrderItem[];
  now: number;
  firstLive: boolean;
}) {
  const stale = probeStale(r, now);
  const slots = routeSlots(r);
  const edit = useRoutingEdit();
  const item: OrderItem = { id: r.routeId, name: routeTitle(r) };
  return (
    <li
      data-route={r.routeId}
      className={cn('border-b px-3 py-2.5 last:border-b-0', !r.enabled && 'bg-muted/30')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="num text-caption text-muted-foreground">{index + 1}.</span>
        <span className="text-sub font-medium">{routeTitle(r)}</span>
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
        <span className="num ml-auto truncate text-micro text-faint" title={r.routeId}>
          {r.routeId}
        </span>
        <RouteSwitch
          label={item.name}
          enabled={r.enabled}
          onToggle={() => edit.toggleRoute({ modelId, modelName, item, enabled: r.enabled })}
        />
        <MoveButtons
          label={`${item.name}（${modelName} 下的先后）`}
          canUp={index > 0}
          canDown={index < routeItems.length - 1}
          onMove={(direction) => edit.moveRoute({ modelId, modelName, items: routeItems, index, direction })}
        />
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
    </li>
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
