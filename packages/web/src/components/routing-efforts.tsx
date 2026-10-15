// 思考档位（#470）并进路由页（#1914 第 5 轮，「路由和思考档位能合并」）：
// 档位按「模型 × 路由」配，所以配在路由上——
// - 每条路由展开后的明细里有「思考档位」一格（RouteEffortField）：用途页右卡、模型目录、渠道页的路由都能就地改；
//   配过的在路由行的小字里写「档位上限 xhigh」，没配不写（默认不是新闻）。
// - 「思考档位」页签（EffortsTab）是思考档位整页：所有模型的所有路一张表，按家族分组，搜索、只看配过的，
//   配不了、未分类默认折叠。要横着比、要找「哪几条配过」时看这里。
//   #1916 按样板重做：一行一条路由，两行字（模型名、「渠道 · 池 · 执行方式」），右边现在照哪档和下拉；池号看得见（同一模型两条
//   Claude 订阅的路要分得出），路由号只在悬停；家族组头是淡字小标题。没配进用途的路由在模型目录、渠道里用行尾的紧凑版（RouteEffortInline）。
// 改这里之前必须知道（思考档位页签的规矩）：
// - 档位存在库里（运行时配置，决定 0011 第 7 条）：改了直接写库，不开 PR、不用发版。
// - 能配哪几档由后端照这条路由的执行方式给好（choices；配不了给 fixed 和原因），这里不另判：Grok 没有 max、cursor 整串
//   模型名配不了，都是后端说了算。
// - 不先改缓存冒充改成了：选下去先亮着、标「改着」，后端不认（422）、别人刚改过（409）就退回库里现在的值并写明原因。
// - 没接上（开发环境内存版）和没读成是两回事：前者整块写 unavailable，后者写「没读成」和原因。都不画空表冒充「都没配」。
// - 能配的按家族展开；配不了、未分类默认折叠（#1756）。未分类用人读名，原始编号放悬停。

import { Brain, ChevronDown, Info } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { errorText, useRoutingEfforts, useUpdateRouteEffort } from '../api/client';
import type { EffortModel, RouteEffort, SessionEffort } from '../api/types';
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
import { cn } from '../lib/utils';
import { EmptyState } from './layout/empty-state';
import { List, RowFrame } from './layout/list';
import { LoadError, LoadingRows } from './layout/load-state';
import { SearchInput } from './layout/search-input';
import { Section } from './layout/section';
import { StatusBadge } from './layout/status-badge';
import { Toolbar } from './layout/toolbar';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';

/** 页签顶上一行说明；其余细节收进旁边的「ⓘ」（#1821）。 */
const SUMMARY = '每条路起会话想多深，改了下个会话就照新的';
const DETAILS =
  '没配的用默认档。配的是这条路的上限：单子只改一个文件（快档）时，引擎会再往下压到 medium，别的活就照配的这一档。改了不用发版。也可以在用途、模型目录、渠道里点开一条路由，就地改它的档位。';

/** 「配不了」组头补的原因：各条的具体原因写在分组里，这里先说清为什么会配不了。 */
const FIXED_WHY = '这些路的执行方式不支持档位，点开看各自原因';

/** 「默认」那一项的值（不是一档，是「没配」）。 */
const DEFAULT_VALUE = 'default';

/** 思考档位没有推送，每 60 秒自己重拉。这份快照超过 5 分钟还没再读成，刷新钮旁标「数据已过期」。 */
export const EFFORTS_STALE_AFTER_MS = 5 * TIME.MIN;

// —— 改一条路由的档位：页签里的表、路由明细里的一格共用 ——

function useRouteEffortEdit(modelId: string, r: RouteEffort) {
  const update = useUpdateRouteEffort();
  const saved = r.effort ?? null;
  // 等后端回话时先亮着选下去的那一项；没成就退回库里的值（下面写原因）
  const shown = update.isPending ? update.variables.body.effort : saved;
  const change = (value: string) => {
    const next = value === DEFAULT_VALUE ? null : (value as SessionEffort);
    if (next === saved) return;
    update.mutate({ modelId, routeId: r.routeId, body: { effort: next, expected: saved } });
  };
  return { update, shown, change };
}

type EffortEdit = ReturnType<typeof useRouteEffortEdit>;

function EffortSelect({
  edit,
  route: r,
  fallback,
  label,
  className,
}: {
  edit: EffortEdit;
  route: RouteEffort;
  fallback: SessionEffort;
  label: string;
  className?: string;
}) {
  return (
    <Select value={edit.shown ?? DEFAULT_VALUE} onValueChange={edit.change} disabled={edit.update.isPending}>
      <SelectTrigger size="sm" className={cn('w-full', className)} aria-label={label}>
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
  );
}

/** 现在照哪一档：改着、配过的那档、默认（high）。 */
function EffortNow({
  edit,
  route: r,
  fallback,
}: {
  edit: EffortEdit;
  route: RouteEffort;
  fallback: SessionEffort;
}) {
  const effective = effectiveEffort(r, fallback);
  return (
    <span className="num text-body" aria-live="polite">
      {edit.update.isPending ? (
        <span className="text-muted-foreground">改着…</span>
      ) : effective?.configured ? (
        <span className="font-medium">{effective.effort}</span>
      ) : (
        <span className="text-muted-foreground">默认（{effective?.effort ?? fallback}）</span>
      )}
    </span>
  );
}

function EffortFailed({ edit }: { edit: EffortEdit }) {
  if (!edit.update.isError) return null;
  return (
    <p role="alert" className="mt-1.5 text-body text-ink-fail">
      没改成：{errorText(edit.update.error)}
    </p>
  );
}

function findRouteEffort(
  models: readonly EffortModel[],
  modelId: string,
  routeId: string,
): RouteEffort | undefined {
  return models.find((m) => m.modelId === modelId)?.routes.find((r) => r.routeId === routeId);
}

/** 路由行小字里的只读档位：只有配过才写（「档位上限 xhigh」），没配、配不了、没读到都不写。 */
export function useConfiguredRouteEffort(modelId: string, routeId: string): SessionEffort | null {
  const { data } = useRoutingEfforts();
  if (!data || data.unavailable) return null;
  const r = findRouteEffort(data.models, modelId, routeId);
  return r && r.fixed === undefined && r.effort ? r.effort : null;
}

/**
 * 路由明细里的「思考档位」一格：能配就是下拉，配不了写为什么；没接上、没读成照实写。
 * 和页签里那张表同一套改法（不先改缓存、422/409 退回并写原因）。
 */
export function RouteEffortField({
  modelId,
  modelName,
  routeId,
  routeName,
}: {
  modelId: string;
  modelName: string;
  routeId: string;
  routeName: string;
}) {
  const { data, error, isLoading } = useRoutingEfforts();
  let body: ReactNode;
  if (error) {
    body = <span className="text-ink-fail">思考档位没读成：{errorText(error)}</span>;
  } else if (isLoading || !data) {
    body = <span className="text-muted-foreground">读着…</span>;
  } else if (data.unavailable) {
    body = <span className="text-muted-foreground">{data.unavailable}</span>;
  } else {
    const r = findRouteEffort(data.models, modelId, routeId);
    body = !r ? (
      <span className="text-muted-foreground">目录里没有这条路由的档位</span>
    ) : r.fixed !== undefined ? (
      <span data-effort-fixed className="text-muted-foreground">
        配不了：{r.fixed}
      </span>
    ) : (
      <RouteEffortEditor
        modelId={modelId}
        route={r}
        fallback={data.defaultEffort}
        label={`${modelName} · ${routeName} 的思考档位`}
      />
    );
  }
  return (
    <div data-route-effort className="min-w-0">
      <div className="text-meta text-muted-foreground" title={DETAILS}>
        思考档位（这条路的上限）
      </div>
      <div className="mt-1 text-body">{body}</div>
    </div>
  );
}

function RouteEffortEditor({
  modelId,
  route,
  fallback,
  label,
}: {
  modelId: string;
  route: RouteEffort;
  fallback: SessionEffort;
  label: string;
}) {
  const edit = useRouteEffortEdit(modelId, route);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <EffortSelect edit={edit} route={route} fallback={fallback} label={label} className="w-36" />
        <EffortNow edit={edit} route={route} fallback={fallback} />
      </div>
      <EffortFailed edit={edit} />
    </>
  );
}

/**
 * 行尾的紧凑版（没配进用途的路由那一行，#1916）：只有下拉；配不了、没接上、没读成写两三个字，整句在悬停里。
 * 没改成的原因照写在下拉下面（红字），不冒充改成了。
 */
export function RouteEffortInline({
  modelId,
  modelName,
  routeId,
  routeName,
}: {
  modelId: string;
  modelName: string;
  routeId: string;
  routeName: string;
}) {
  const { data, error, isLoading } = useRoutingEfforts();
  const quiet = (text: string, title: string, fixed = false) => (
    <span
      data-route-effort
      data-effort-fixed={fixed ? '' : undefined}
      title={title}
      className="shrink-0 text-meta whitespace-nowrap text-muted-foreground"
    >
      {text}
    </span>
  );
  if (error) {
    return (
      <span
        data-route-effort
        className="shrink-0 text-meta whitespace-nowrap text-ink-fail"
        title={errorText(error)}
      >
        档位没读成
      </span>
    );
  }
  if (isLoading || !data) return quiet('读着…', '思考档位还在读');
  if (data.unavailable) return quiet('档位没接上', data.unavailable);
  const r = findRouteEffort(data.models, modelId, routeId);
  if (!r) return quiet('没有档位', '目录里没有这条路由的档位');
  if (r.fixed !== undefined) return quiet('档位配不了', `配不了：${r.fixed}`, true);
  return (
    <InlineEffortEditor
      modelId={modelId}
      route={r}
      fallback={data.defaultEffort}
      label={`${modelName} · ${routeName} 的思考档位`}
    />
  );
}

function InlineEffortEditor({
  modelId,
  route,
  fallback,
  label,
}: {
  modelId: string;
  route: RouteEffort;
  fallback: SessionEffort;
  label: string;
}) {
  const edit = useRouteEffortEdit(modelId, route);
  return (
    <span data-route-effort className="flex max-w-48 shrink-0 flex-col items-end">
      <EffortSelect edit={edit} route={route} fallback={fallback} label={label} className="w-28" />
      {edit.update.isError ? (
        <span role="alert" className="mt-1 text-right text-meta text-ink-fail">
          没改成：{errorText(edit.update.error)}
        </span>
      ) : null}
    </span>
  );
}

// —— 「思考档位」页签 ——

export function EffortsTab() {
  const { data, error, isLoading, refetch } = useRoutingEfforts();
  const [search, setSearch] = useState('');
  const [onlyConfigured, setOnlyConfigured] = useState(false);

  if (error) {
    return (
      <>
        <EffortsIntro />
        <LoadError what="思考档位" error={error} onRetry={() => void refetch()} />
      </>
    );
  }
  if (isLoading || !data) {
    return (
      <>
        <EffortsIntro />
        <LoadingRows rows={6} />
      </>
    );
  }
  if (data.unavailable) {
    return (
      <>
        <EffortsIntro />
        <Section flush>
          <div role="note">
            <EmptyState size="inline" icon={Info} title={data.unavailable} />
          </div>
        </Section>
      </>
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
    <>
      <EffortsIntro />
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
              {/* 不再有「模型 | 路由 | 当前档位 | 改档位」表头：一行两行字，右边就是档位（#1916） */}
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
    </>
  );
}

/** 页签顶上一行说明，细则在「ⓘ」里。 */
function EffortsIntro() {
  return (
    // 一行不折（#1914 第 5 轮）：窄屏放不下截断，ⓘ 紧跟在后面不被挤走
    <p className="mb-4 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-body text-muted-foreground">
      <span className="min-w-0 truncate" title={SUMMARY}>
        {SUMMARY}
      </span>
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
    </p>
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
        className="flex w-full items-center gap-1.5 whitespace-nowrap px-4 py-3 text-left text-body text-foreground hover:bg-accent max-md:min-h-11"
      >
        <ChevronDown
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')}
          aria-hidden
        />
        {/* 一行不折：组头的原因放不下就截断（#1914 第 5 轮） */}
        <span className="min-w-0 truncate">{label}</span>
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
      {/* 家族组头：淡字小标题加条数，不再是灰底横条（样板：层级靠字重和灰度，不靠色块） */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 border-b px-4 pt-3 pb-2 text-left text-meta font-medium text-muted-foreground hover:text-foreground max-md:min-h-10"
      >
        <ChevronDown
          className={cn('size-4 shrink-0 transition-transform', !open && '-rotate-90')}
          aria-hidden
        />
        <span>{label}</span>
        <span className="num font-normal">
          {rows.length} 条{configured > 0 ? `，已配 ${configured}` : ''}
        </span>
      </button>
      {open ? (
        <List id={bodyId}>
          {rows.map(({ model, route }) => (
            <EffortRouteRow
              key={route.routeId}
              modelId={model.modelId}
              modelName={model.displayName}
              route={route}
              fallback={fallback}
            />
          ))}
        </List>
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
            <span
              className="ml-2 text-meta font-normal text-muted-foreground"
              data-fixed-why
              title={FIXED_WHY}
            >
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
              <Section key={g.reason} flush>
                {/* 原因是一段话：小字灰字写在这一组上面，不当大标题（#1916，原来用区块标题，手机上一大段粗字） */}
                <p className="border-b px-4 pt-3 pb-2 text-meta text-muted-foreground">{g.reason}</p>
                <List>
                  {items.map(({ model, route }) => (
                    <FixedRouteRow key={route.routeId} model={model} route={route} />
                  ))}
                </List>
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
          <List id={bodyId}>
            {rows.map(({ model, route }) => (
              <EffortRouteRow
                key={route.routeId}
                modelId={model.modelId}
                modelName={readableModelName(model.modelId)}
                rawModelId={model.modelId}
                route={route}
                fallback={fallback}
              />
            ))}
          </List>
        </Section>
      ) : null}
    </section>
  );
}

/**
 * 页签里一行一条路由（#1916，样板 #1914）：第一行模型名加一个状态（关着才写「关着」），第二行灰字「渠道 · 池 · 执行方式」，
 * 右边是现在照哪一档和档位下拉。池号写出来：同一个模型常有两条同渠道的路（Claude 订阅 · claude-a、claude-b），
 * 只写渠道名就分不出哪条是哪条（#1902 只把池号放悬停，这里改成可见；路由编号这类内部 id 仍只在悬停）。
 */
function EffortRowFrame({
  routeId,
  modelId,
  name,
  nameTitle,
  route: r,
  trailing,
  detail,
}: {
  routeId: string;
  modelId: string;
  name: string;
  nameTitle?: string | undefined;
  route: RouteEffort;
  trailing?: ReactNode;
  detail?: ReactNode;
}) {
  const where = `${r.channelName} · ${r.poolId} · ${hostLabel[r.hostId]}`;
  return (
    <li data-route={routeId} data-model={modelId} className="hover:bg-accent">
      <RowFrame tall>
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
          <span className="flex min-w-0 items-center gap-2 whitespace-nowrap">
            <span className="min-w-0 truncate text-body font-medium" title={nameTitle ?? name}>
              {name}
            </span>
            {r.enabled ? null : (
              <span className="inline-flex shrink-0">
                <StatusBadge tone="stop" label="关着" variant="dot" />
              </span>
            )}
          </span>
          <span
            data-route-where
            className="block truncate text-meta whitespace-nowrap text-muted-foreground"
            title={`${where} · ${r.routeId}`}
          >
            {where}
          </span>
        </span>
        {trailing}
      </RowFrame>
      {detail}
    </li>
  );
}

/** 配不了分组里的行：原因已在分组头，这里只写模型、渠道和池。 */
function FixedRouteRow({ model, route: r }: { model: EffortModel; route: RouteEffort }) {
  const name = isUncategorizedModel(model) ? readableModelName(model.modelId) : model.displayName;
  return (
    <EffortRowFrame
      routeId={r.routeId}
      modelId={model.modelId}
      name={name}
      nameTitle={isUncategorizedModel(model) ? model.modelId : undefined}
      route={r}
    />
  );
}

function EffortRouteRow({
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
  const edit = useRouteEffortEdit(modelId, r);
  const title = `${r.channelName} · ${r.poolId}`;
  return (
    <EffortRowFrame
      routeId={r.routeId}
      modelId={modelId}
      name={modelName}
      nameTitle={rawModelId ?? modelName}
      route={r}
      trailing={
        <span className="flex shrink-0 items-center gap-3">
          {/* 手机上下拉里已经写着这一档，「默认（high）」这句只在宽的时候写 */}
          <span className="max-md:sr-only">
            <EffortNow edit={edit} route={r} fallback={fallback} />
          </span>
          <EffortSelect
            edit={edit}
            route={r}
            fallback={fallback}
            label={`${modelName} · ${title} 的思考档位`}
            className="w-28 md:w-32"
          />
        </span>
      }
      detail={
        edit.update.isError ? (
          <div className="-mt-1 px-4 pb-2">
            <EffortFailed edit={edit} />
          </div>
        ) : null
      }
    />
  );
}
