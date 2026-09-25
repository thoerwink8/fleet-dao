import type { Routing } from '../api/types';
import { routeInfo } from '../lib/catalog';
import { cn } from '../lib/utils';

/** 路由的名字：模型用等宽粗体，渠道和账号池用普通字。modelName 优先用后端给的。 */
export function RouteLabel({
  routing,
  routeId,
  modelName,
  showHost,
  className,
}: {
  routing: Routing | undefined;
  routeId: string;
  modelName?: string | undefined;
  showHost?: boolean;
  className?: string;
}) {
  const info = routing ? routeInfo(routing, routeId) : undefined;
  return (
    <span className={cn('inline-flex max-w-full min-w-0 items-baseline gap-1.5', className)}>
      <span className="num shrink-0 font-semibold">{modelName ?? info?.model ?? routeId}</span>
      {info ? (
        <span className="truncate text-muted-foreground">
          {info.channel} · {info.poolId}
          {showHost ? ` · ${info.host}` : ''}
        </span>
      ) : null}
    </span>
  );
}
