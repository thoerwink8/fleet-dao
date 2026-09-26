import {
  ArrowDown,
  ArrowUp,
  Ban as BanIcon,
  Bot,
  GripVertical,
  Lock,
  Pin,
  PinOff,
  Plus,
  Undo2,
  X,
} from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { brand } from '#brand';
import {
  ApiError,
  errorText,
  useAudit,
  useMe,
  usePools,
  useRouting,
  useUpdateStagePolicy,
} from '../api/client';
import type { Ban, PoolView, Routing, StageKind, StagePolicy } from '../api/types';
import { NotBuilt } from '../components/not-built';
import { LoadError, LoadingRows, Page, Panel } from '../components/page';
import { QuotaBar } from '../components/quota';
import { RouteHealth } from '../components/route-health';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { actorName } from '../lib/audit';
import {
  billingLabel,
  headlineBar,
  headlineInk,
  headlineText,
  routeInfo,
  routeProblem,
  routeQuotaHeadline,
  routeStatus,
  STAGES,
  stageLabel,
} from '../lib/catalog';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { describeChange, type PolicyValue, routeShort, samePolicy } from '../lib/policy';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('调度台') }];
}

function banText(routing: Routing, b: Ban): string {
  const who = b.modelId
    ? (routing.models.find((m) => m.id === b.modelId)?.displayName ?? b.modelId)
    : b.family
      ? `${b.family.toUpperCase()} 族`
      : '（没写对谁）';
  return `${who} × ${b.stage ? stageLabel[b.stage] : '所有阶段'}`;
}

const modelOf = routeShort;

export default function Dispatch() {
  const routing = useRouting();
  const pools = usePools();
  const audit = useAudit();
  const save = useUpdateStagePolicy();
  const { data: me } = useMe();
  const now = useNow();

  const onSave = (stage: StageKind, from: PolicyValue, to: PolicyValue, message: string, reason?: string) => {
    save.mutate(
      {
        stage,
        body: { routeIds: to.routeIds, pinned: to.pinned, expected: from, ...(reason ? { reason } : {}) },
      },
      {
        onSuccess: () =>
          toast.success(message, {
            description: '下一次派工就按新设置选路；在跑的会话不受影响。',
            action: {
              label: '撤销',
              onClick: () => onSave(stage, to, from, `已撤销：${message}`, '撤销刚才的改动'),
            },
          }),
        onError: (e) =>
          toast.error(
            e instanceof ApiError && e.code === 'conflict'
              ? '这个阶段刚被别人改过，已刷新，请再改一次'
              : '没保存上',
            { description: errorText(e) },
          ),
      },
    );
  };

  const data = routing.data;
  const changes = (audit.data?.pages[0]?.items ?? [])
    .filter((e) => e.action === 'stage_policy.update')
    .slice(0, 20);

  return (
    <Page
      title="调度台"
      description="每个阶段挂一串路由，派工时从上往下挑第一条能用的：在线、额度够、有空位、不犯禁令。拖动调整先后。"
    >
      {routing.error ? <LoadError what="路由" error={routing.error} /> : null}
      {routing.data ? <RouteHealth routing={routing.data} now={now} className="mb-3" /> : null}
      {pools.data?.quotaNotWired ? (
        <NotBuilt compact notWired={pools.data.quotaNotWired} className="mb-3" />
      ) : null}
      {pools.error ? (
        <div className="mb-3">
          <LoadError what="额度和并发（下面的路由不显示用量和在跑数）" error={pools.error} />
        </div>
      ) : null}
      {!data ? (
        <LoadingRows rows={6} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-3">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <BanIcon className="size-4 text-ink-fail" aria-hidden />
              全局禁令
            </span>
            {data.hardBans.map((b) => (
              <Tooltip key={b.id}>
                <TooltipTrigger asChild>
                  <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-st-fail/40 bg-st-fail/[0.07] px-2.5 text-xs">
                    <Lock className="size-3 text-ink-fail" aria-hidden />
                    {b.reason}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  写死在代码里（{b.id}），{brand.product}改不了
                </TooltipContent>
              </Tooltip>
            ))}
            {data.bans.map((b) => (
              <Tooltip key={`${b.family ?? ''}-${b.modelId ?? ''}-${b.stage ?? ''}`}>
                <TooltipTrigger asChild>
                  <span className="num inline-flex h-7 items-center gap-1.5 rounded-lg border border-st-fail/40 bg-st-fail/[0.07] px-2.5 text-xs">
                    {banText(data, b)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{b.reason}</TooltipContent>
              </Tooltip>
            ))}
            <span className="text-xs text-muted-foreground">
              犯禁令的路由在任何阶段都选不上，手动也不行。
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid min-w-0 grid-cols-1 content-start gap-4 lg:grid-cols-2">
              {STAGES.map((s) => {
                const policy = data.stages.find((p) => p.stage === s.id) ?? {
                  stage: s.id,
                  routeIds: [],
                  pinned: false,
                };
                return (
                  <StageCard
                    key={s.id}
                    stage={s.id}
                    hint={s.hint}
                    policy={policy}
                    routing={data}
                    pools={pools.data?.pools}
                    quotaNotWired={Boolean(pools.data?.quotaNotWired)}
                    now={now}
                    onSave={(to, message) => onSave(s.id, policy, to, message)}
                  />
                );
              })}
            </div>
            <Panel
              title="最近改动"
              description="每一条都写了谁改的、为什么；之后没人再改过的可以一键撤回。"
              className="h-fit"
              bodyClassName="p-0"
            >
              {audit.error ? (
                <div className="p-4">
                  <LoadError error={audit.error} />
                </div>
              ) : null}
              {changes.length === 0 && audit.data ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">最近没人改过路由顺序</p>
              ) : null}
              <ul className="divide-y">
                {changes.map((e) => {
                  const c = describeChange(data, e);
                  const current = c.stage ? data.stages.find((p) => p.stage === c.stage) : undefined;
                  const revertible = Boolean(
                    e.ok && c.stage && c.before && c.after && current && samePolicy(current, c.after),
                  );
                  return (
                    <li key={e.id} className="px-4 py-3">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {e.actor.kind === 'ai' ? (
                          <Bot className="size-3.5 text-foreground" aria-hidden />
                        ) : null}
                        <span className="font-medium text-foreground" title={e.actor.id}>
                          {actorName(e.actor, me)}
                        </span>
                        <span className="num ml-auto">{formatAgo(e.at, now)}</span>
                      </div>
                      <div className={cn('mt-1 text-sm', !e.ok && 'text-ink-fail')}>{c.summary}</div>
                      {e.reason ? (
                        <div className="mt-0.5 text-xs text-muted-foreground">理由：{e.reason}</div>
                      ) : null}
                      {e.error ? <div className="mt-0.5 text-xs text-ink-fail">没做成：{e.error}</div> : null}
                      {revertible && c.stage && c.before && c.after ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2 h-7"
                          disabled={save.isPending}
                          onClick={() =>
                            onSave(
                              c.stage as StageKind,
                              c.after as PolicyValue,
                              c.before as PolicyValue,
                              `已撤回：${c.summary}`,
                              `撤回 ${actorName(e.actor)} 的改动`,
                            )
                          }
                        >
                          <Undo2 />
                          撤回
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Panel>
          </div>
        </>
      )}
    </Page>
  );
}

function StageCard({
  stage,
  hint,
  policy,
  routing,
  pools,
  quotaNotWired,
  now,
  onSave,
}: {
  stage: StageKind;
  hint: string;
  policy: StagePolicy;
  routing: Routing;
  /** 额度表还没读到（在读或没读成）时是 undefined：路由行不显示用量，页面顶上另有提示。 */
  pools: PoolView[] | undefined;
  /** 额度读取还没做：路由行不显示用量（页面顶上有待实现占位），不说「额度没查成」。 */
  quotaNotWired: boolean;
  now: number;
  onSave(to: PolicyValue, message: string): void;
}) {
  const [order, setOrder] = useState(policy.routeIds);
  const orderRef = useRef(order);
  orderRef.current = order;
  const serverKey = policy.routeIds.join('|');

  // 后端（或 AI 帅位）改了顺序时跟上；保存失败回滚时也靠这里复原。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在服务端顺序变化时同步。
  useEffect(() => {
    setOrder(policy.routeIds);
  }, [serverKey]);

  const name = `「${stageLabel[stage]}」`;
  const commit = (ids: string[]) => {
    if (ids.join('|') === serverKey) return;
    onSave({ routeIds: ids, pinned: policy.pinned }, `已保存${name}的顺序`);
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    if (item === undefined) return;
    next.splice(to, 0, item);
    setOrder(next);
    commit(next);
  };
  const candidates = routing.routes.filter((r) => !order.includes(r.id));

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {stageLabel[stage]}
          <span className="num text-xs font-normal text-muted-foreground">{order.length} 条</span>
          {policy.pinned ? (
            <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px]">
              <Pin className="size-3" />
              已钉住
            </Badge>
          ) : null}
        </span>
      }
      description={hint}
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-pressed={policy.pinned}
              aria-label={policy.pinned ? '取消钉住' : '钉住'}
              onClick={() =>
                onSave(
                  { routeIds: policy.routeIds, pinned: !policy.pinned },
                  policy.pinned
                    ? `已取消钉住${name}`
                    : `已钉住${name}：${brand.terms.marshal}不会再改这个顺序`,
                )
              }
            >
              {policy.pinned ? <PinOff /> : <Pin />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {policy.pinned ? '取消钉住' : `钉住：${brand.terms.marshal}不改这个顺序`}
          </TooltipContent>
        </Tooltip>
      }
      bodyClassName="p-3"
    >
      {order.length === 0 ? (
        <p className="mb-2 rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          这个阶段还没挂路由，派不了工
        </p>
      ) : null}
      <Reorder.Group axis="y" values={order} onReorder={setOrder} className="space-y-1.5">
        {order.map((rid, i) => (
          <RouteRow
            key={rid}
            rid={rid}
            index={i}
            count={order.length}
            stage={stage}
            routing={routing}
            pools={pools}
            quotaNotWired={quotaNotWired}
            now={now}
            onDragEnd={() => commit(orderRef.current)}
            onMove={(to) => move(i, to)}
            onRemove={() =>
              onSave(
                { routeIds: order.filter((x) => x !== rid), pinned: policy.pinned },
                `已从${name}去掉 ${modelOf(routing, rid)}`,
              )
            }
          />
        ))}
      </Reorder.Group>
      <div className="mt-2">
        <Select
          value=""
          onValueChange={(rid) =>
            onSave(
              { routeIds: [...order, rid], pinned: policy.pinned },
              `已给${name}加上 ${modelOf(routing, rid)}`,
            )
          }
        >
          <SelectTrigger
            size="sm"
            className="w-full border-dashed text-muted-foreground"
            aria-label={`给${name}加一条路由`}
          >
            <span className="flex items-center gap-1.5">
              <Plus className="size-3.5" />
              加一条路由
            </span>
          </SelectTrigger>
          <SelectContent>
            {candidates.map((r) => {
              const info = routeInfo(routing, r.id);
              const problem = routeProblem(routing, r.id, stage, now);
              return (
                <SelectItem key={r.id} value={r.id} disabled={Boolean(problem)}>
                  <span className="num font-medium">{info?.model ?? r.id}</span>
                  <span className="text-muted-foreground">
                    {info?.channel} {info?.poolId}
                  </span>
                  {problem ? (
                    <span className="text-ink-fail">{problem}</span>
                  ) : !r.alive ? (
                    <span className="text-ink-stall">{routeStatus(r, now).label}</span>
                  ) : null}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
    </Panel>
  );
}

function RouteRow({
  rid,
  index,
  count,
  stage,
  routing,
  pools,
  quotaNotWired,
  now,
  onDragEnd,
  onMove,
  onRemove,
}: {
  rid: string;
  index: number;
  count: number;
  stage: StageKind;
  routing: Routing;
  /** 额度表还没读到（在读或没读成）时是 undefined：路由行不显示用量，页面顶上另有提示。 */
  pools: PoolView[] | undefined;
  quotaNotWired: boolean;
  now: number;
  onDragEnd(): void;
  onMove(to: number): void;
  onRemove(): void;
}) {
  const controls = useDragControls();
  const info = routeInfo(routing, rid);
  const pool = info && pools ? pools.find((p) => p.id === info.poolId) : undefined;
  // 和换模型对话框同一句话，按这条路由算：只扣别的模型组的窗满了不算它满（routeQuotaHeadline）。
  // 额度表读到了、却查不到这个池，也算「额度没查成」。
  const h =
    info && pools && !quotaNotWired
      ? routeQuotaHeadline(
          pool,
          routing.models.find((m) => m.id === info.route.modelId),
        )
      : undefined;
  const w = h && 'w' in h ? h.w : undefined;
  const problem = routeProblem(routing, rid, stage, now);
  // 在不在线照路由探针的结论（页面顶上有每条的原因）；还没探过的也派不了，一样画成灰的。
  const status = info ? routeStatus(info.route, now) : undefined;
  const offline = status ? status.kind !== 'online' : true;
  const channelOff = info ? !info.channelEnabled : false;
  const faint = offline || channelOff || Boolean(problem);
  return (
    <Reorder.Item
      value={rid}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragEnd}
      className="group relative flex items-center gap-2 rounded-lg border bg-card px-2 py-2 select-none"
      whileDrag={{ scale: 1.02, boxShadow: '0 12px 32px -12px var(--shadow-color)', zIndex: 10 }}
    >
      <button
        type="button"
        onPointerDown={(e) => controls.start(e)}
        className="cursor-grab touch-none text-faint hover:text-foreground active:cursor-grabbing"
        aria-label="拖动排序"
      >
        <GripVertical className="size-4" />
      </button>
      <span className="num w-4 text-center text-xs text-muted-foreground">{index + 1}</span>
      <div className={cn('min-w-0 flex-1', faint && 'opacity-55')}>
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="num shrink-0 text-[13px] font-semibold whitespace-nowrap">
            {info?.model ?? rid}
          </span>
          {info ? (
            <span
              className="min-w-0 truncate text-xs text-muted-foreground"
              title={`${info.channel} ${info.poolId}`}
            >
              {info.channel} <span className="num">{info.poolId}</span>
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
          {info ? (
            <span className="whitespace-nowrap">{info.host}</span>
          ) : (
            <span className="text-ink-fail">路由表里没有它</span>
          )}
          {info ? (
            <span className="rounded bg-muted px-1">
              {info.billing ? billingLabel[info.billing] : '计费未知'}
            </span>
          ) : null}
          {pool ? (
            <span className="num" title="账号池此刻在跑 / 并发上限">
              {pool.running}/{pool.maxConcurrency} 在跑
            </span>
          ) : null}
          {status && status.kind !== 'online' ? (
            <span
              className={cn(
                'min-w-0 max-w-full truncate',
                status.tone === 'fail' ? 'text-ink-fail' : 'text-ink-stall',
              )}
              title={status.detail}
            >
              {status.label}：{status.detail}
            </span>
          ) : null}
          {channelOff ? <span className="text-ink-stall">渠道已下架</span> : null}
          {problem ? <span className="text-ink-fail">{problem}</span> : null}
        </div>
      </div>
      {h ? (
        <div
          className="hidden w-24 shrink-0 sm:block"
          title={
            h.kind === 'util'
              ? w?.stale
                ? '读数过期'
                : w?.reading === 'measured'
                  ? '实读'
                  : '估算'
              : h.kind === 'full'
                ? `上游说${h.w.scope ? ` ${h.w.scope} 组的窗` : '扣它的窗'}已用满，调度会先绕开`
                : h.kind === 'unscoped'
                  ? '这个池的额度窗都只扣别的模型组'
                  : `${headlineText(h)}：不参与比较`
          }
        >
          <div
            data-quota={h.kind}
            className={cn(
              'text-right text-[11px]',
              h.kind === 'util' ? 'num text-muted-foreground' : cn('font-medium', headlineInk(h)),
              w?.stale && 'line-through',
            )}
          >
            {headlineText(h)}
            {h.kind === 'util' && w?.reading === 'estimated' ? '·估' : ''}
          </div>
          <QuotaBar util={headlineBar(h)} className="mt-1" />
        </div>
      ) : null}
      <div className="flex flex-col opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          className="grid size-4 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-30"
          onClick={() => onMove(index - 1)}
          disabled={index === 0}
          aria-label="上移"
        >
          <ArrowUp className="size-3" />
        </button>
        <button
          type="button"
          className="grid size-4 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-30"
          onClick={() => onMove(index + 1)}
          disabled={index === count - 1}
          aria-label="下移"
        >
          <ArrowDown className="size-3" />
        </button>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="grid size-6 place-items-center rounded text-faint opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-accent hover:text-ink-fail"
        aria-label="去掉这条路由"
      >
        <X className="size-3.5" />
      </button>
    </Reorder.Item>
  );
}
