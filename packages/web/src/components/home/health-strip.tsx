// 顶部持续状态条：额度、中转、引擎开关。
//
// 关键规矩（specs/509 第五节）：有问题**持续显示、不伪装成失败**——快清零、有路由探不通、引擎被关
// 这些都写在条上一目了然，但用 wait / stall 提示色（黄系），不用 fail 红。红了表示「真坏了，要当场修」，
// 这三件都不是「坏了」——额度本来就会被吃掉、探针本来就会报某些路由不通、引擎关是创始人拍的临时调整。
// 把它们画成红就是在伪装失败。

import { CircleAlert, CircleCheck, CircleDashed, Gauge, Power, Waypoints } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { HomeHealth } from './types';

type Kind = 'ok' | 'warn' | 'muted';

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
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
        kind === 'ok' && 'border-border text-muted-foreground',
        kind === 'warn' && 'border-st-wait/45 bg-st-wait/10 text-ink-wait',
        kind === 'muted' && 'border-dashed text-muted-foreground',
      )}
    >
      {kind === 'ok' ? (
        <CircleCheck className="size-3" aria-hidden />
      ) : kind === 'warn' ? (
        <CircleAlert className="size-3" aria-hidden />
      ) : (
        <CircleDashed className="size-3" aria-hidden />
      )}
      <Icon className="size-3 opacity-70" aria-hidden />
      <span className="font-medium">{label}</span>
      <span className="max-w-[320px] truncate text-[11px] opacity-90">{detail}</span>
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
  return state === 'off' ? 'warn' : 'ok';
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
        label={health.engine.state === 'off' ? '引擎关着' : '引擎'}
        detail={health.engine.state === 'off' ? (health.engine.detail ?? '临时调整') : '正常'}
        kind={kindOfEngine(health.engine.state)}
      />
    </div>
  );
}
