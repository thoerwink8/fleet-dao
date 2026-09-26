import { CalendarClock, Radio } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { brand } from '#brand';
import { errorText, usePools, useRouting, useUpdateChannel } from '../api/client';
import type { Channel, PoolView, Routing } from '../api/types';
import { NotBuilt } from '../components/not-built';
import { Empty, LoadError, LoadingRows, Page } from '../components/page';
import { QuotaBar, ReadingBadge } from '../components/quota';
import { StatusDot } from '../components/status';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import {
  billingLabel,
  headlineBar,
  headlineInk,
  headlineText,
  hostLabel,
  poolUsage,
  quotaHeadline,
  windowTitle,
} from '../lib/catalog';
import { formatDate, formatInDays, TIME } from '../lib/format';
import { useNow } from '../lib/hooks';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('渠道与账号') }];
}

export default function Channels() {
  const routing = useRouting();
  const pools = usePools();
  const update = useUpdateChannel();
  const [confirm, setConfirm] = useState<Channel | null>(null);
  const [reason, setReason] = useState('');

  const toggle = (ch: Channel, enabled: boolean, why?: string) =>
    update.mutate(
      { channelId: ch.id, body: { enabled, ...(why ? { reason: why } : {}) } },
      {
        onSuccess: () =>
          toast.success(enabled ? `${ch.name} 已上架` : `${ch.name} 已下架`, {
            description: enabled ? '新派的活可以用它了。' : '手上的活跑完后不再接新活。',
          }),
        onError: (e) => toast.error(enabled ? '没上架成' : '没下架成', { description: errorText(e) }),
      },
    );

  const data = routing.data;
  return (
    <Page
      title="渠道与账号"
      description="渠道是一个付费入口，账号池是渠道下的一份额度。每个渠道都标明套餐内还是按量。"
    >
      {routing.error ? <LoadError what="渠道" error={routing.error} /> : null}
      {pools.error ? (
        <div className="mb-3">
          <LoadError what="账号池" error={pools.error} />
        </div>
      ) : null}
      {pools.data?.quotaNotWired ? (
        <NotBuilt compact notWired={pools.data.quotaNotWired} className="mb-3" />
      ) : null}
      {data?.routeProbeNotWired ? (
        <NotBuilt compact notWired={data.routeProbeNotWired} className="mb-3" />
      ) : null}
      {!data ? (
        routing.error ? null : (
          <LoadingRows rows={5} />
        )
      ) : data.channels.length === 0 ? (
        <Empty icon={Radio} title="还没接任何渠道" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.channels.map((ch) => (
            <ChannelCard
              key={ch.id}
              ch={ch}
              routing={data}
              pools={pools.data?.pools.filter((p) => p.channelId === ch.id)}
              poolsFailed={Boolean(pools.error)}
              quotaNotWired={Boolean(pools.data?.quotaNotWired)}
              busy={update.isPending}
              onToggle={(on) => {
                if (on) toggle(ch, true);
                else {
                  setReason('');
                  setConfirm(ch);
                }
              }}
            />
          ))}
        </div>
      )}
      <AlertDialog open={Boolean(confirm)} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>下架 {confirm?.name}？</AlertDialogTitle>
            <AlertDialogDescription>
              它手上的活会跑完，之后不再接新活；调度会按顺序换下一条路由。随时可以再上架。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="为什么下架（会写进操作记录，可不填）"
            maxLength={500}
            className="min-h-16"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) toggle(confirm, false, reason.trim() || undefined);
              }}
            >
              下架
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

function ChannelCard({
  ch,
  routing,
  pools,
  poolsFailed,
  quotaNotWired,
  busy,
  onToggle,
}: {
  ch: Channel;
  routing: Routing;
  /** undefined = 账号池还没读到或没读成（不是「没有账号池」），看 poolsFailed。 */
  pools: PoolView[] | undefined;
  poolsFailed: boolean;
  /** 额度读取还没做：每个池的额度格子只画一道杠，页面顶上有待实现占位。 */
  quotaNotWired: boolean;
  busy: boolean;
  onToggle(on: boolean): void;
}) {
  const routes = routing.routes.filter((r) => r.channelId === ch.id);
  const alive = routes.filter((r) => r.alive).length;
  // 路由探针还没做：没人写过 alive，不数「几条在线」、不把路由划掉（页面顶上有待实现占位）
  const probeNotWired = Boolean(routing.routeProbeNotWired);
  const running = (pools ?? []).reduce((n, p) => n + p.running, 0);
  return (
    <section
      className={cn('rounded-xl border bg-card shadow-[0_1px_0_var(--border)]', !ch.enabled && 'opacity-70')}
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <StatusDot tone={!ch.enabled ? 'stop' : running ? 'run' : 'wait'} />
        <h2 className="text-[15px] font-semibold">{ch.name}</h2>
        <Badge variant={ch.billing === 'metered' ? 'outline' : 'secondary'}>{billingLabel[ch.billing]}</Badge>
        <span className="text-xs text-muted-foreground">
          {probeNotWired ? (
            <>
              路由 <span className="num">{routes.length}</span> 条
            </>
          ) : (
            <>
              路由 <span className="num text-foreground">{alive}</span>/
              <span className="num">{routes.length}</span> 在线
            </>
          )}
          {running ? (
            <>
              {' '}
              · <span className="num text-foreground">{running}</span> 个会话在跑
            </>
          ) : null}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden>{ch.enabled ? '上架中' : '已下架'}</span>
          <Switch
            checked={ch.enabled}
            disabled={busy}
            onCheckedChange={onToggle}
            aria-label={ch.enabled ? `下架 ${ch.name}` : `上架 ${ch.name}`}
          />
        </span>
      </header>
      {!pools ? (
        poolsFailed ? (
          <p className="px-4 py-3 text-xs text-ink-fail">账号池没读到</p>
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground">正在读账号池…</p>
        )
      ) : pools.length ? (
        <ul className="divide-y">
          {pools.map((p) => (
            <PoolRow key={p.id} pool={p} quotaNotWired={quotaNotWired} />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">这个渠道下还没有账号池</p>
      )}
      <div className="flex flex-wrap gap-1.5 border-t px-4 py-2.5">
        {routes.map((r) => {
          const m = routing.models.find((x) => x.id === r.modelId);
          return (
            <span
              key={r.id}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]',
                !r.alive && !probeNotWired && 'border-dashed text-muted-foreground line-through',
              )}
              title={`${hostLabel[r.hostId]} · 账号池 ${r.poolId}${r.alive || probeNotWired ? '' : ' · 离线'}`}
            >
              <span className="num">{m?.displayName ?? r.modelId}</span>
              <span className="text-muted-foreground">· {hostLabel[r.hostId]}</span>
            </span>
          );
        })}
      </div>
    </section>
  );
}

function PoolRow({ pool, quotaNotWired }: { pool: PoolView; quotaNotWired: boolean }) {
  const now = useNow();
  // 和调度台、换模型对话框同一句话：没查成 / 已用满 / 最满的窗用了几成 / 用量没读到……
  const h = quotaHeadline(pool);
  const usage = poolUsage(pool.windows);
  const w = 'w' in h ? h.w : undefined;
  const soon = pool.expiresAt ? Date.parse(pool.expiresAt) - now < 7 * TIME.DAY : false;
  const full = pool.maxConcurrency > 0 && pool.running >= pool.maxConcurrency;
  return (
    <li className="grid grid-cols-2 items-center gap-3 px-4 py-3 sm:grid-cols-[1.2fr_0.8fr_1.3fr_1fr]">
      <div className="min-w-0">
        <div className="num truncate text-sm font-medium">{pool.id}</div>
        <div className="text-[11px] text-muted-foreground">账号池</div>
      </div>
      <div>
        <div className="num text-sm">
          <span className={cn(full && 'text-ink-stall')}>{pool.running}</span>/{pool.maxConcurrency}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">在跑 / 并发上限</div>
      </div>
      <div className="min-w-0">
        {quotaNotWired ? (
          <span className="text-xs text-faint">—</span>
        ) : w ? (
          <>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-muted-foreground">{windowTitle(w)}</span>
              <span
                data-quota={h.kind}
                className={cn(
                  h.kind === 'util' ? 'num' : cn('font-medium', headlineInk(h)),
                  w.stale && 'text-muted-foreground line-through',
                )}
              >
                {headlineText(h)}
              </span>
            </div>
            <QuotaBar util={headlineBar(h)} className="mt-1" />
            <div className="mt-1 flex items-center gap-1.5">
              <ReadingBadge w={w} />
              {(h.kind === 'full' || h.kind === 'util') && usage.unknown.length ? (
                <span className="text-[11px] text-ink-stall" title="这些窗不参与比较">
                  另有 <span className="num">{usage.unknown.length}</span> 个窗用量没读到
                </span>
              ) : null}
              {w.stale ? <span className="text-[11px] text-ink-stall">读数过期</span> : null}
              {w.resetsAt ? (
                <span className="truncate text-[11px] text-muted-foreground">
                  <span className="num">{formatInDays(w.resetsAt, now)}</span>清零
                </span>
              ) : null}
            </div>
          </>
        ) : (
          <span
            data-quota={h.kind}
            className={cn('text-xs', headlineInk(h))}
            title={h.kind === 'unread' ? '一次都没读成过：是没查成，不是没用量' : undefined}
          >
            {headlineText(h)}
          </span>
        )}
      </div>
      <div className={cn('text-right text-xs', soon && 'text-ink-stall')}>
        {pool.expiresAt ? (
          <>
            <div className="flex items-center justify-end gap-1">
              <CalendarClock className="size-3.5" aria-hidden />
              <span className="num">{formatDate(pool.expiresAt)}</span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              <span className={cn('num', soon && 'font-medium text-ink-stall')}>
                {formatInDays(pool.expiresAt, now)}
              </span>
              到期
            </div>
          </>
        ) : (
          <span className="text-muted-foreground">没有到期日</span>
        )}
      </div>
    </li>
  );
}
