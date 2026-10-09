// 思考档位页（#470）：每个模型走的每条路，起会话想多深——一格一条路，点一下就改，下一个起的会话就照新的。
// 改这里之前必须知道：
// - 档位存在库里（运行时配置，决定 0011 第 7 条）：改了直接写库，不开 PR、不用发版。
// - 能配哪几档由后端照这条路由的执行方式给好（choices；配不了给 fixed 和原因），这页不另判：Grok 没有 max、cursor 整串
//   模型名配不了，都是后端说了算。
// - 不先改缓存冒充改成了：点下去那一格先亮着、标「改着」，后端不认（422）、别人刚改过（409）就退回库里现在的值并写明原因。
// - 没接上（开发环境内存版）和没读成是两回事：前者整块写 unavailable，后者写「没读成」和原因。都不画空表冒充「都没配」。

import { Brain } from 'lucide-react';
import { brand } from '#brand';
import { errorText, useRoutingEfforts, useUpdateRouteEffort } from '../api/client';
import type { EffortModel, RouteEffort, SessionEffort } from '../api/types';
import { Empty, LoadError, LoadingRows, Page, Panel } from '../components/page';
import { RefreshBar } from '../components/refresh-bar';
import { Badge } from '../components/ui/badge';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { hostLabel } from '../lib/catalog';
import { EFFORT_HINT, effectiveEffort, effortCounts } from '../lib/efforts';
import { TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('思考档位') }];
}

const DESCRIPTION =
  '每个模型走的每条路，起会话想多深。没配的用默认档；配的是这条路的上限——单子只改一个文件（快档）时，引擎会再往下压到 medium，别的活就照配的这一档。改了下一个起的会话就照新的，不用发版。';

/** 「默认」那一格的值（不是一档，是「没配」）。 */
const DEFAULT_VALUE = 'default';

/** 思考档位没有推送，页面每 60 秒自己重拉。这份快照超过 5 分钟还没再读成，刷新条标「数据已过期」。 */
const EFFORTS_STALE_AFTER_MS = 5 * TIME.MIN;

export default function Efforts() {
  const { data, error, isLoading, isFetching, dataUpdatedAt, refetch } = useRoutingEfforts();
  const now = useNow();
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

  return (
    <Page
      title="思考档位"
      description={DESCRIPTION}
      actions={
        <>
          {refresh}
          {data.models.length > 0 ? <Counts models={data.models} fallback={data.defaultEffort} /> : null}
        </>
      }
    >
      {data.models.length === 0 ? (
        <Panel>
          <Empty
            icon={Brain}
            title="路由两层里一条路由都没有"
            hint="发布时会把仓里的默认骨架装进库；装过了还是空的，去看发布日志（load_routing 那一步）"
          />
        </Panel>
      ) : (
        // 瀑布流（CSS 多栏）：模型下的路由条数差得多（1 条到 3 条），网格按行对齐会在矮卡下面空出一大块
        <div className="gap-4 lg:columns-2 2xl:columns-3">
          {byConfigurable(data.models).map((m) => (
            <div key={m.modelId} className="mb-4 break-inside-avoid">
              <ModelPanel model={m} fallback={data.defaultEffort} />
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}

/**
 * 来这页是为了改档位：有路能配的模型排前面（照后端给的先后），一条都配不了的（cursor 整串模型名、判断题小模型、引擎还没接上的）
 * 放最后，照列、写明为什么配不了，不占最显眼的位置。
 */
function byConfigurable(models: EffortModel[]): EffortModel[] {
  const fixedOnly = (m: EffortModel) => m.routes.length > 0 && m.routes.every((r) => r.fixed !== undefined);
  return [...models.filter((m) => !fixedOnly(m)), ...models.filter(fixedOnly)];
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

function ModelPanel({ model, fallback }: { model: EffortModel; fallback: SessionEffort }) {
  return (
    <Panel
      title={model.displayName}
      description={[model.family, model.modelId].filter(Boolean).join(' · ')}
      bodyClassName="p-0"
    >
      <ul data-model={model.modelId}>
        {model.routes.map((r) => (
          <RouteRow
            key={r.routeId}
            modelId={model.modelId}
            modelName={model.displayName}
            route={r}
            fallback={fallback}
          />
        ))}
      </ul>
    </Panel>
  );
}

function RouteRow({
  modelId,
  modelName,
  route: r,
  fallback,
}: {
  modelId: string;
  modelName: string;
  route: RouteEffort;
  fallback: SessionEffort;
}) {
  const update = useUpdateRouteEffort();
  const saved = r.effort ?? null;
  // 等后端回话时先亮着点下去的那一格；没成就退回库里的值（下面写原因）
  const shown = update.isPending ? update.variables.body.effort : saved;
  const effective = effectiveEffort(r, fallback);
  const title = `${r.channelName} · ${r.poolId}`;

  const change = (value: string) => {
    // 单选再点一下已经亮着的那格，组件会给空串：当没改
    if (!value) return;
    const next = value === DEFAULT_VALUE ? null : (value as SessionEffort);
    if (next === saved) return;
    update.mutate({ modelId, routeId: r.routeId, body: { effort: next, expected: saved } });
  };

  return (
    <li
      data-route={r.routeId}
      className={cn('border-b px-4 py-3 last:border-b-0', !r.enabled && 'bg-muted/30')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sub font-medium">{title}</span>
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
      {r.fixed !== undefined ? (
        <p className="mt-2 text-sub text-muted-foreground">配不了：{r.fixed}</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={shown ?? DEFAULT_VALUE}
            onValueChange={change}
            disabled={update.isPending}
            aria-label={`${modelName} · ${title} 的思考档位`}
          >
            <ToggleGroupItem value={DEFAULT_VALUE} title={`没配，用默认档 ${fallback}`}>
              默认
            </ToggleGroupItem>
            {r.choices.map((e) => (
              // 配了的那一档用实底：一屏扫过去就看出哪几条路配过（「默认」亮着只是浅灰，和悬停一个样）
              <ToggleGroupItem
                key={e}
                value={e}
                title={EFFORT_HINT[e]}
                className="num data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              >
                {e}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <span className="text-caption text-muted-foreground" aria-live="polite">
            {update.isPending
              ? '改着…'
              : effective
                ? `起会话用 ${effective.effort}${effective.configured ? '' : '（没配，用默认）'}`
                : null}
          </span>
        </div>
      )}
      {update.isError ? (
        <p role="alert" className="mt-1.5 text-sub text-ink-fail">
          没改成：{errorText(update.error)}
        </p>
      ) : null}
    </li>
  );
}
