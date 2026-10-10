// 顶部持续状态条：额度、中转、引擎开关。
//
// 关键规矩（specs/509 第五节）：有问题**持续显示、不伪装成失败**——快清零、有路由探不通、引擎被关
// 这些都写在条上一目了然，但用 wait / stall 提示色（黄系），不用 fail 红。红了表示「真坏了，要当场修」，
// 这三件都不是「坏了」——额度本来就会被吃掉、探针本来就会报某些路由不通、引擎是按配置关的。
// 把它们画成红就是在伪装失败。反过来，引擎开着却探不到在线的工人（down）是真坏了，红；没查成（unknown）不写成正常。

import { CircleAlert, CircleCheck, CircleDashed, Gauge, Power, Waypoints } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { HomeHealth } from './types';

type Kind = 'ok' | 'warn' | 'muted' | 'bad';

function Chip({
  icon: Icon,
  label,
  detail,
  kind,
}: {
  icon: typeof Gauge;
  label: string;
  detail: string;
  kind: Kind;
}) {
  return (
    <span
      data-health-chip={kind}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
        kind === 'ok' && 'border-border text-muted-foreground',
        kind === 'warn' && 'border-st-wait/45 bg-st-wait/10 text-ink-wait',
        kind === 'bad' && 'border-st-fail/50 bg-st-fail/10 text-ink-fail',
        kind === 'muted' && 'border-dashed text-muted-foreground',
      )}
    >
      {kind === 'ok' ? (
        <CircleCheck className="size-3" aria-hidden />
      ) : kind === 'warn' || kind === 'bad' ? (
        <CircleAlert className="size-3" aria-hidden />
      ) : (
        <CircleDashed className="size-3" aria-hidden />
      )}
      <Icon className="size-3 opacity-70" aria-hidden />
      <span className="shrink-0 font-medium whitespace-nowrap">{label}</span>
      {/* 详情宽度、字号换成 max-w-health-detail、text-caption。 */}
      <span className="min-w-0 max-w-health-detail truncate text-caption opacity-90" title={detail}>
        {detail}
      </span>
    </span>
  );
}

function kindOfQuota(state: HomeHealth['quota']['state']): Kind {
  if (state === 'tight') return 'warn';
  if (state === 'ok') return 'ok';
  return 'muted';
}

function kindOfRoutes(state: HomeHealth['routes']['state']): Kind {
  if (state === 'degraded') return 'warn';
  if (state === 'ok') return 'ok';
  return 'muted';
}

function kindOfEngine(state: HomeHealth['engine']['state']): Kind {
  switch (state) {
    case 'on':
      return 'ok';
    case 'off':
      return 'warn'; // 按配置没开，不是坏了
    case 'down':
      return 'bad'; // 开着却没连上：真坏了，红
    case 'unknown':
      return 'muted'; // 没查成，不冒充正常
  }
}

/** 引擎进程那一格的名字和一句话：四种状态各说各的，名字都带「进程」，和顶栏的总开关分开，不共用「正常」。 */
function engineWords(engine: HomeHealth['engine']): { label: string; detail: string } {
  switch (engine.state) {
    case 'on':
      return { label: '引擎进程', detail: '正常' };
    case 'off':
      return { label: '引擎进程已停用', detail: engine.detail ?? '按配置没开' };
    case 'down':
      return { label: '引擎进程没连上', detail: engine.detail ?? '探不到在线的工人' };
    case 'unknown':
      return { label: '引擎进程', detail: `没查成${engine.detail ? `：${engine.detail}` : ''}` };
  }
}

export function HealthStrip({ health, className }: { health: HomeHealth; className?: string }) {
  return (
    <div
      role="status"
      aria-label="持续状态"
      data-health-strip
      className={cn('flex flex-wrap items-center gap-2', className)}
    >
      <Chip icon={Gauge} label="额度" detail={health.quota.detail} kind={kindOfQuota(health.quota.state)} />
      <Chip
        icon={Waypoints}
        label="中转"
        detail={health.routes.detail}
        kind={kindOfRoutes(health.routes.state)}
      />
      <Chip
        icon={Power}
        label={engineWords(health.engine).label}
        detail={engineWords(health.engine).detail}
        kind={kindOfEngine(health.engine.state)}
      />
    </div>
  );
}
