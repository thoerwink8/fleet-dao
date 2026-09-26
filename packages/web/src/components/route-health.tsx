// 路由在线状态（#129）：路由探针写进库的结论——在线几条、最近一次探测是什么时候、每条在线 / 离线（原因）/ 还没探过。
// 探针停了（结论太久没更新）照实说「可能停了」，不拿上一次的结论当现在。

import { ROUTE_PROBE_EVERY_MINUTES, ROUTE_PROBE_STALE_MINUTES } from '@fleet-dao/shared';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Routing } from '../api/types';
import { probeSummary, routeStatus } from '../lib/catalog';
import { formatAgo, TIME } from '../lib/format';
import { cn } from '../lib/utils';
import { RouteLabel } from './route-label';
import { StatusChip, StatusDot } from './status';

export function RouteHealth({
  routing,
  now,
  className,
}: {
  routing: Routing;
  now: number;
  className?: string;
}) {
  const s = probeSummary(routing.routes);
  const statuses = routing.routes.map((r) => ({ route: r, status: routeStatus(r, now) }));
  // 真探了没通的（标红）、一条在线的都没有：默认展开，要人看；其余收着，只看一行数。
  const alarming = s.online === 0 || statuses.some((x) => x.status.tone === 'fail');
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const expanded = open ?? alarming;
  const probeStale =
    s.lastAt !== undefined && now - Date.parse(s.lastAt) > ROUTE_PROBE_STALE_MINUTES * TIME.MIN;
  // 在线的排前面，其次真探了没通的，再次还没探过的，最后按规矩不在线的。
  const rank = (x: (typeof statuses)[number]) =>
    x.status.kind === 'online' ? 0 : x.status.tone === 'fail' ? 1 : x.status.kind === 'unprobed' ? 2 : 3;
  const rows = [...statuses].sort((a, b) => rank(a) - rank(b));

  return (
    <section data-route-health className={cn('rounded-xl border bg-card', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
        <StatusDot tone={s.online === 0 ? 'fail' : probeStale ? 'stall' : 'done'} />
        <span className="text-sm font-semibold">路由在线状态</span>
        <span className="text-xs text-muted-foreground">
          在线 <span className="num text-foreground">{s.online}</span>/<span className="num">{s.total}</span>
          {s.unprobed ? (
            <>
              {' '}
              · 还没探过 <span className="num">{s.unprobed}</span> 条
            </>
          ) : null}
          {' · '}
          {s.lastAt ? (
            <>
              最近一次探测 <span className="num">{formatAgo(s.lastAt, now)}</span>
            </>
          ) : (
            '探针还没出过结论'
          )}
          {` · 每 ${ROUTE_PROBE_EVERY_MINUTES} 分钟一轮`}
        </span>
        {probeStale ? (
          <span className="text-xs text-ink-stall">
            超过 {ROUTE_PROBE_STALE_MINUTES} 分钟没出新结论，探针可能停了（看
            <Link to="/schedules" className="underline underline-offset-2">
              定时任务
            </Link>
            ），下面是上一次的结论
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen(!expanded)}
          aria-expanded={expanded}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? '收起' : '看每条'}
          <ChevronDown
            className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
            aria-hidden
          />
        </button>
      </div>
      {expanded ? (
        <ul className="divide-y border-t">
          {rows.map(({ route, status }) => (
            <li
              key={route.id}
              data-route-status={status.kind}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 px-4 py-2 sm:grid-cols-[minmax(0,16rem)_auto_minmax(0,1fr)_auto]"
            >
              <RouteLabel routing={routing} routeId={route.id} showHost className="text-[13px]" />
              <StatusChip
                tone={status.tone}
                label={status.label}
                className="justify-self-end sm:justify-self-start"
              />
              <span
                className={cn(
                  'col-span-2 min-w-0 text-xs break-words sm:col-span-1',
                  status.tone === 'fail' ? 'text-ink-fail' : 'text-muted-foreground',
                )}
              >
                {status.detail}
              </span>
              <span className="num col-span-2 text-[11px] whitespace-nowrap text-faint sm:col-span-1">
                {status.at ? formatAgo(status.at, now) : ''}
                {status.stale ? <span className="ml-1 text-ink-stall">探测过期</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
