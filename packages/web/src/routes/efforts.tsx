// 思考档位页（#470）：每个模型走的每条路，起会话想多深——一行一条「模型 × 路由」，档位用下拉改，下一个起的会话就照新的。
// 排法学「渠道状态」（#1803）：一张表，按模型家族分组，组头可折叠；顶上搜索和「只看配过的」；手机上每行变两行。
// 改这里之前必须知道：
// - 档位存在库里（运行时配置，决定 0011 第 7 条）：改了直接写库，不开 PR、不用发版。
// - 能配哪几档由后端照这条路由的执行方式给好（choices；配不了给 fixed 和原因），这页不另判：Grok 没有 max、cursor 整串
//   模型名配不了，都是后端说了算。
// - 不先改缓存冒充改成了：选下去先亮着、标「改着」，后端不认（422）、别人刚改过（409）就退回库里现在的值并写明原因。
// - 没接上（开发环境内存版）和没读成是两回事：前者整块写 unavailable，后者写「没读成」和原因。都不画空表冒充「都没配」。
// - 能配的按家族展开；配不了、未分类默认折叠（#1756）。未分类用人读名，原始编号放悬停。

import { Brain, ChevronDown, Search } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { brand } from '#brand';
import { errorText, useRoutingEfforts, useUpdateRouteEffort } from '../api/client';
import type { EffortModel, RouteEffort, SessionEffort } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RefreshBar } from '../components/refresh-bar';
import { Badge } from '../components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { hostLabel } from '../lib/catalog';
import {
  EFFORT_HINT,
  type EffortRow,
  effectiveEffort,
  effortCounts,
  effortRowMatches,
  type FixedEffortReasonGroup,
  groupEffortRoutes,
  groupRowsByFamily,
  isUncategorizedModel,
  readableModelName,
} from '../lib/efforts';
import { TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('思考档位') }];
}

const DESCRIPTION =
  '每个模型走的每条路，起会话想多深。没配的用默认档；配的是这条路的上限——单子只改一个文件（快档）时，引擎会再往下压到 medium，别的活就照配的这一档。改了下一个起的会话就照新的，不用发版。';

/** 「默认」那一项的值（不是一档，是「没配」）。 */
const DEFAULT_VALUE = 'default';

/** 思考档位没有推送，页面每 60 秒自己重拉。这份快照超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const EFFORTS_STALE_AFTER_MS = 5 * TIME.MIN;

/** 一行四格：模型 | 路由 | 当前档位 | 改档位。窄屏两列两行：模型+路由一行，档位+下拉一行，不横滚。 */
const ROW_GRID =
  'grid grid-cols-2 items-center gap-x-3 gap-y-1.5 px-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_minmax(0,8rem)_10rem]';

export default function Efforts() {
  const { data, error, isLoading, isFetching, dataUpdatedAt, refetch } = useRoutingEfforts();
  const now = useNow();
  const [search, setSearch] = useState('');
  const [onlyConfigured, setOnlyConfigured] = useState(false);
  const refresh = (
    <RefreshBar
      onRefresh={() => void refetch()}
      isFetching={isFetching}
      // 共用秒表一拍最多慢 1 秒。刚读成的时间戳比「现在」新时压回这一拍，避免显示成「1 秒后」。
      dataUpdatedAt={dataUpdatedAt > now ? now : dataUpdatedAt}
      staleAfterMs={EFFORTS_STALE_AFTER_MS}
    />
  );

  if (error) {
    return (
      <Page title="思考档位" description={DESCRIPTION} actions={refresh}>
        <LoadError what="思考档位" error={error} />
      </Page>
    );
  }
  if (isLoading || !data) {
    return (
      <Page title="思考档位" description={DESCRIPTION} actions={refresh}>
        <LoadingRows rows={6} />
      </Page>
    );
  }
  if (data.unavailable) {
    return (
      <Page title="思考档位" description={DESCRIPTION} actions={refresh}>
        <div
          role="note"
          className="rounded-xl border border-dashed bg-card px-6 py-10 text-center text-sm text-muted-foreground"
        >
          {data.unavailable}
        </div>
      </Page>
    );
  }

  const groups = groupEffortRoutes(data.models);
  const keep = (row: EffortRow) =>
    effortRowMatches(row, search) && (!onlyConfigured || row.route.effort !== undefined);
  const families = groupRowsByFamily(groups.configurable)
    .map((g) => ({ ...g, rows: g.rows.filter(keep) }))
    .filter((g) => g.rows.length > 0);
  const filtering = search.trim() !== '' || onlyConfigured;

  return (
    <Page title="思考档位" description={DESCRIPTION} actions={refresh}>
      {data.models.length === 0 ? (
        <Panel>
          <Empty
            icon={Brain}
            title="路由两层里一条路由都没有"
            hint="发布时会把仓里的默认骨架装进库；装过了还是空的，去看发布日志（load_routing 那一步）"
          />
        </Panel>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <Counts models={data.models} fallback={data.defaultEffort} />
            <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 sm:w-auto">
              <label className="relative block min-w-0 flex-1 sm:w-64 sm:flex-none">
                <span className="sr-only">搜索模型或渠道</span>
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜模型、渠道、路由号"
                  aria-label="搜索模型或渠道"
                  className="h-9 w-full rounded-lg border bg-card pl-8 pr-2.5 text-sub outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </label>
              <div className="flex items-center gap-2 text-sub">
                <Switch
                  id="efforts-only-configured"
                  checked={onlyConfigured}
                  onCheckedChange={setOnlyConfigured}
                />
                <label htmlFor="efforts-only-configured">只看配过的</label>
              </div>
            </div>
          </div>

          {families.length > 0 ? (
            <section className="overflow-hidden rounded-xl border bg-card shadow-card-edge">
              <div
                aria-hidden
                className={cn(ROW_GRID, 'border-b py-2 text-caption text-muted-foreground max-md:hidden')}
              >
                <span>模型</span>
                <span>路由</span>
                <span>当前档位</span>
                <span>改档位</span>
              </div>
              {families.map((g) => (
                <FamilyGroup key={g.family} label={g.label} rows={g.rows} fallback={data.defaultEffort} />
              ))}
            </section>
          ) : groups.configurable.length > 0 ? (
            <p
              role="status"
              className="rounded-lg border border-dashed px-3 py-6 text-center text-sub text-muted-foreground"
            >
              没有符合的路由{search.trim() ? `：「${search.trim()}」` : ''}
              {onlyConfigured ? '，筛选在「只看配过的」' : ''}
            </p>
          ) : null}
          {groups.fixed.total > 0 && !onlyConfigured ? (
            <FixedFold total={groups.fixed.total} byReason={groups.fixed.byReason} search={search} />
          ) : null}
          {groups.uncategorized.length > 0 ? (
            <UncategorizedFold
              models={groups.uncategorized}
              fallback={data.defaultEffort}
              keep={filtering ? keep : undefined}
            />
          ) : null}
        </div>
      )}
    </Page>
  );
}

function Counts({ models, fallback }: { models: EffortModel[]; fallback: SessionEffort }) {
  const c = effortCounts(models);
  return (
    <p className="text-sub text-muted-foreground">
      <span className="num font-medium text-foreground">{c.configured}</span> 条配了 ·{' '}
      <span className="num font-medium text-foreground">{c.byDefault}</span> 条用默认 {fallback}
      {c.fixed > 0 ? (
        <>
          {' '}
          · <span className="num font-medium text-foreground">{c.fixed}</span> 条配不了
        </>
      ) : null}
    </p>
  );
}

function FoldButton({
  open,
  onToggle,
  controls,
  label,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  label: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 rounded-xl border bg-card px-4 py-3 text-left text-sm text-foreground shadow-card-edge hover:bg-accent/40"
    >
      <ChevronDown
        className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')}
        aria-hidden
      />
      <span>{label}</span>
    </button>
  );
}

/** 一个模型家族：组头可折叠，默认展开；组头写这家有几条路、几条配过。 */
function FamilyGroup({
  label,
  rows,
  fallback,
}: {
  label: string;
  rows: EffortRow[];
  fallback: SessionEffort;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const configured = rows.filter((r) => r.route.effort !== undefined).length;
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 bg-muted/40 px-4 py-2 text-left text-sub font-medium hover:bg-muted/70"
      >
        <ChevronDown
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')}
          aria-hidden
        />
        <span>{label}</span>
        <span className="num text-caption font-normal text-muted-foreground">
          {rows.length} 条{configured > 0 ? `，已配 ${configured}` : ''}
        </span>
      </button>
      {open ? (
        <ul id={bodyId}>
          {rows.map(({ model, route }) => (
            <RouteRow
              key={route.routeId}
              modelId={model.modelId}
              modelName={model.displayName}
              route={route}
              fallback={fallback}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** 配不了：默认折叠；同一句原因只在分组头写一次，行上不再重复。 */
function FixedFold({
  total,
  byReason,
  search,
}: {
  total: number;
  byReason: FixedEffortReasonGroup[];
  search: string;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <section>
      <FoldButton
        open={open}
        onToggle={() => setOpen((v) => !v)}
        controls={bodyId}
        label={
          <>
            配不了 <span className="num">{total}</span> 条
          </>
        }
      />
      {open ? (
        <div id={bodyId} className="mt-2 space-y-3">
          {byReason.map((g) => {
            const items = g.items.filter((i) => effortRowMatches(i, search));
            if (items.length === 0) return null;
            return (
              <Panel
                key={g.reason}
                title={<span className="font-normal text-muted-foreground">{g.reason}</span>}
                bodyClassName="p-0"
              >
                <ul>
                  {items.map(({ model, route }) => (
                    <FixedRouteRow key={route.routeId} model={model} route={route} />
                  ))}
                </ul>
              </Panel>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

/** 未分类：默认折叠；标题用人读名，原始编号放悬停。 */
function UncategorizedFold({
  models,
  fallback,
  keep,
}: {
  models: EffortModel[];
  fallback: SessionEffort;
  keep: ((row: EffortRow) => boolean) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const rows = models
    .flatMap((model) => model.routes.map((route) => ({ model, route })))
    .filter((row) => (keep ? keep(row) : true));
  const routeCount = models.reduce((n, m) => n + m.routes.length, 0);
  if (rows.length === 0) return null;
  return (
    <section>
      <FoldButton
        open={open}
        onToggle={() => setOpen((v) => !v)}
        controls={bodyId}
        label={
          <>
            未分类 <span className="num">{routeCount}</span> 条
          </>
        }
      />
      {open ? (
        <ul id={bodyId} className="mt-2 overflow-hidden rounded-xl border bg-card shadow-card-edge">
          {rows.map(({ model, route }) => (
            <RouteRow
              key={route.routeId}
              modelId={model.modelId}
              modelName={readableModelName(model.modelId)}
              rawModelId={model.modelId}
              route={route}
              fallback={fallback}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** 配不了分组里的行：原因已在分组头，这里只写渠道和路由编号。 */
function FixedRouteRow({ model, route: r }: { model: EffortModel; route: RouteEffort }) {
  const title = `${r.channelName} · ${r.poolId}`;
  const name = isUncategorizedModel(model) ? readableModelName(model.modelId) : model.displayName;
  return (
    <li
      data-route={r.routeId}
      data-model={model.modelId}
      className={cn('border-b px-4 py-3 last:border-b-0', !r.enabled && 'bg-muted/30')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="text-sub font-medium"
          title={isUncategorizedModel(model) ? model.modelId : undefined}
        >
          {name}
        </span>
        <span className="text-sub text-muted-foreground">{title}</span>
        <span className="text-caption text-muted-foreground">{hostLabel[r.hostId]}</span>
        {r.enabled ? null : (
          <Badge variant="outline" className="h-4 px-1 text-micro font-normal">
            关着
          </Badge>
        )}
        <span className="num ml-auto truncate text-micro text-faint" title={r.model}>
          {r.routeId}
        </span>
      </div>
    </li>
  );
}

function RouteRow({
  modelId,
  modelName,
  rawModelId,
  route: r,
  fallback,
}: {
  modelId: string;
  modelName: string;
  /** 未分类时：原始编号放模型名的悬停。 */
  rawModelId?: string;
  route: RouteEffort;
  fallback: SessionEffort;
}) {
  const update = useUpdateRouteEffort();
  const saved = r.effort ?? null;
  // 等后端回话时先亮着选下去的那一项；没成就退回库里的值（下面写原因）
  const shown = update.isPending ? update.variables.body.effort : saved;
  const effective = effectiveEffort(r, fallback);
  const title = `${r.channelName} · ${r.poolId}`;

  const change = (value: string) => {
    const next = value === DEFAULT_VALUE ? null : (value as SessionEffort);
    if (next === saved) return;
    update.mutate({ modelId, routeId: r.routeId, body: { effort: next, expected: saved } });
  };

  return (
    <li
      data-route={r.routeId}
      data-model={modelId}
      className={cn('border-t py-2.5 first:border-t-0', !r.enabled && 'bg-muted/30')}
    >
      <div className={ROW_GRID}>
        <span className="min-w-0 truncate text-sub font-medium" title={rawModelId ?? modelName}>
          {modelName}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-sub text-muted-foreground">
          <span className="truncate" title={`${title} · ${hostLabel[r.hostId]} · ${r.routeId}`}>
            {title}
          </span>
          <span className="num shrink-0 text-micro text-faint max-md:hidden" title={r.model}>
            {r.routeId}
          </span>
          {r.enabled ? null : (
            <Badge variant="outline" className="h-4 shrink-0 px-1 text-micro font-normal">
              关着
            </Badge>
          )}
        </span>
        <span className="num text-sub" aria-live="polite">
          {update.isPending ? (
            <span className="text-muted-foreground">改着…</span>
          ) : effective?.configured ? (
            <span className="font-medium">{effective.effort}</span>
          ) : (
            <span className="text-muted-foreground">默认（{effective?.effort ?? fallback}）</span>
          )}
        </span>
        <Select value={shown ?? DEFAULT_VALUE} onValueChange={change} disabled={update.isPending}>
          <SelectTrigger size="sm" className="w-full" aria-label={`${modelName} · ${title} 的思考档位`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value={DEFAULT_VALUE} title={`没配，用默认档 ${fallback}`}>
              默认
            </SelectItem>
            {r.choices.map((e) => (
              <SelectItem key={e} value={e} title={EFFORT_HINT[e]} className="num">
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {update.isError ? (
        <p role="alert" className="mt-1.5 px-4 text-sub text-ink-fail">
          没改成：{errorText(update.error)}
        </p>
      ) : null}
    </li>
  );
}
