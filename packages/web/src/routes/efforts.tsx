// 思考档位页（#470）：每个模型走的每条路，起会话想多深——一行一条「模型 × 路由」，档位用下拉改，下一个起的会话就照新的。
// 排法学「渠道状态」（#1803）：一张表，按模型家族分组，组头可折叠；顶上搜索和「只看配过的」；手机上每行变两行。
// 改这里之前必须知道：
// - 档位存在库里（运行时配置，决定 0011 第 7 条）：改了直接写库，不开 PR、不用发版。
// - 能配哪几档由后端照这条路由的执行方式给好（choices；配不了给 fixed 和原因），这页不另判：Grok 没有 max、cursor 整串
//   模型名配不了，都是后端说了算。
// - 不先改缓存冒充改成了：选下去先亮着、标「改着」，后端不认（422）、别人刚改过（409）就退回库里现在的值并写明原因。
// - 没接上（开发环境内存版）和没读成是两回事：前者整块写 unavailable，后者写「没读成」和原因。都不画空表冒充「都没配」。
// - 能配的按家族展开；配不了、未分类默认折叠（#1756）。未分类用人读名，原始编号放悬停。

import { Brain, ChevronDown, Info } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { brand } from '#brand';
import { errorText, useRoutingEfforts, useUpdateRouteEffort } from '../api/client';
import type { EffortModel, RouteEffort, SessionEffort } from '../api/types';
import { EmptyState } from '../components/layout/empty-state';
import { LoadError, LoadingRows } from '../components/layout/load-state';
import { Page } from '../components/layout/page';
import { SearchInput } from '../components/layout/search-input';
import { Section } from '../components/layout/section';
import { StatusBadge } from '../components/layout/status-badge';
import { Toolbar } from '../components/layout/toolbar';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
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

/** 页头说明压成一行（#1821）；其余细节收进旁边的「ⓘ」。 */
const SUMMARY = '每条路起会话想多深；改了，下一个会话就照新的。';
const DETAILS =
  '没配的用默认档。配的是这条路的上限：单子只改一个文件（快档）时，引擎会再往下压到 medium，别的活就照配的这一档。改了不用发版。';

const DESCRIPTION = (
  <span className="inline-flex items-center gap-1.5">
    {SUMMARY}
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="档位怎么生效"
          className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground max-md:-my-2 max-md:size-10"
        >
          <Info className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-body">
        {DETAILS}
      </PopoverContent>
    </Popover>
  </span>
);

/** 「配不了」组头补的原因：各条的具体原因写在分组里，这里先说清为什么会配不了。 */
const FIXED_WHY = '这些路的执行方式不支持档位，点开看各自原因';

/** 「默认」那一项的值（不是一档，是「没配」）。 */
const DEFAULT_VALUE = 'default';

/** 思考档位没有推送，页面每 60 秒自己重拉。这份快照超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const EFFORTS_STALE_AFTER_MS = 5 * TIME.MIN;

/** 一行四格：模型 | 路由 | 当前档位 | 改档位。窄屏两列两行：模型+路由一行，档位+下拉一行，不横滚。 */
const ROW_GRID = 'grid grid-cols-2 items-center gap-x-3 gap-y-1.5 px-4 md:grid-cols-efforts';

export default function Efforts() {
  const { data, error, isLoading, isFetching, dataUpdatedAt, refetch } = useRoutingEfforts();
  const now = useNow();
  const [search, setSearch] = useState('');
  const [onlyConfigured, setOnlyConfigured] = useState(false);
  const refresh = {
    onRefresh: () => void refetch(),
    isFetching,
    // 共用秒表一拍最多慢 1 秒。刚读成的时间戳比「现在」新时压回这一拍，避免显示成「1 秒后」。
    dataUpdatedAt: dataUpdatedAt > now ? now : dataUpdatedAt,
    staleAfterMs: EFFORTS_STALE_AFTER_MS,
  };

  if (error) {
    return (
      <Page title="思考档位" description={DESCRIPTION} keepDescription refresh={refresh}>
        <LoadError what="思考档位" error={error} />
      </Page>
    );
  }
  if (isLoading || !data) {
    return (
      <Page title="思考档位" description={DESCRIPTION} keepDescription refresh={refresh}>
        <LoadingRows rows={6} />
      </Page>
    );
  }
  if (data.unavailable) {
    return (
      <Page title="思考档位" description={DESCRIPTION} keepDescription refresh={refresh}>
        <Section flush>
          <div role="note">
            <EmptyState size="inline" icon={Info} title={data.unavailable} />
          </div>
        </Section>
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
    <Page title="思考档位" description={DESCRIPTION} keepDescription refresh={refresh}>
      {data.models.length === 0 ? (
        <Section>
          <EmptyState
            icon={Brain}
            title="路由两层里一条路由都没有"
            hint="发布时会把仓里的默认骨架装进库；装过了还是空的，去看发布日志（load_routing 那一步）"
          />
        </Section>
      ) : (
        <div className="space-y-4">
          <Toolbar
            className="mb-0"
            start={<Counts models={data.models} fallback={data.defaultEffort} />}
            end={
              <>
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="搜模型、渠道、路由号"
                  aria-label="搜索模型或渠道"
                  className="sm:w-64"
                />
                {/* 整行是一个 label：手机上这一行 40 高，点字也能开关（开关本身 32×18，可点区域在 ui/switch 里往外撑）。 */}
                <label
                  htmlFor="efforts-only-configured"
                  className="flex items-center gap-2 text-body max-md:min-h-10"
                >
                  <Switch
                    id="efforts-only-configured"
                    checked={onlyConfigured}
                    onCheckedChange={setOnlyConfigured}
                  />
                  只看配过的
                </label>
              </>
            }
          />

          {families.length > 0 ? (
            <Section flush>
              <div
                aria-hidden
                className={cn(ROW_GRID, 'border-b py-2 text-meta text-muted-foreground max-md:hidden')}
              >
                <span>模型</span>
                <span>路由</span>
                <span>当前档位</span>
                <span>改档位</span>
              </div>
              {families.map((g) => (
                <FamilyGroup key={g.family} label={g.label} rows={g.rows} fallback={data.defaultEffort} />
              ))}
            </Section>
          ) : groups.configurable.length > 0 ? (
            <Section flush>
              <div role="status">
                <EmptyState
                  size="inline"
                  title={`没有符合的路由${search.trim() ? `：「${search.trim()}」` : ''}${onlyConfigured ? '，筛选在「只看配过的」' : ''}`}
                />
              </div>
            </Section>
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
    <p className="text-body text-muted-foreground">
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
    <Section flush>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-4 py-3 text-left text-body text-foreground hover:bg-accent max-md:min-h-11"
      >
        <ChevronDown
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')}
          aria-hidden
        />
        <span>{label}</span>
      </button>
    </Section>
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
        className="flex w-full items-center gap-1.5 bg-muted px-4 py-2 text-left text-body font-medium hover:bg-accent max-md:min-h-10"
      >
        <ChevronDown
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')}
          aria-hidden
        />
        <span>{label}</span>
        <span className="num text-meta font-normal text-muted-foreground">
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
            <span className="ml-2 text-meta font-normal text-muted-foreground" data-fixed-why>
              {FIXED_WHY}
            </span>
          </>
        }
      />
      {open ? (
        <div id={bodyId} className="mt-2 space-y-3">
          {byReason.map((g) => {
            const items = g.items.filter((i) => effortRowMatches(i, search));
            if (items.length === 0) return null;
            return (
              <Section
                key={g.reason}
                title={<span className="font-normal text-muted-foreground">{g.reason}</span>}
                flush
              >
                <ul>
                  {items.map(({ model, route }) => (
                    <FixedRouteRow key={route.routeId} model={model} route={route} />
                  ))}
                </ul>
              </Section>
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
        <Section flush className="mt-2">
          <ul id={bodyId}>
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
        </Section>
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
      className={cn('border-b px-4 py-3 last:border-b-0', !r.enabled && 'bg-muted')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="text-body font-medium"
          title={isUncategorizedModel(model) ? model.modelId : undefined}
        >
          {name}
        </span>
        <span className="text-body text-muted-foreground">{title}</span>
        <span className="text-meta text-muted-foreground">{hostLabel[r.hostId]}</span>
        {r.enabled ? null : <StatusBadge tone="stop" label="关着" />}
        <span className="num ml-auto truncate text-meta text-muted-foreground" title={r.model}>
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
      className={cn('border-t py-2.5 first:border-t-0', !r.enabled && 'bg-muted')}
    >
      <div className={ROW_GRID}>
        <span className="min-w-0 truncate text-body font-medium" title={rawModelId ?? modelName}>
          {modelName}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-body text-muted-foreground">
          <span className="truncate" title={`${title} · ${hostLabel[r.hostId]} · ${r.routeId}`}>
            {title}
          </span>
          <span className="num shrink-0 text-meta text-muted-foreground max-md:hidden" title={r.model}>
            {r.routeId}
          </span>
          {r.enabled ? null : <StatusBadge tone="stop" label="关着" />}
        </span>
        <span className="num text-body" aria-live="polite">
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
        <p role="alert" className="mt-1.5 px-4 text-body text-ink-fail">
          没改成：{errorText(update.error)}
        </p>
      ) : null}
    </li>
  );
}
