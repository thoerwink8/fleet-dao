import type { Routing } from '../api/types';
import { routeInfo } from '../lib/catalog';
import { Code } from './layout/code';
import { Stack } from './layout/stack';
import { Text } from './layout/text';

/** 路由的名字：模型用等宽粗体，渠道和账号池用普通字。modelName 优先用后端给的。 */
export function RouteLabel({
  routing,
  routeId,
  modelName,
  showHost,
}: {
  routing: Routing | undefined;
  routeId: string;
  modelName?: string | undefined;
  showHost?: boolean;
}) {
  const info = routing ? routeInfo(routing, routeId) : undefined;
  return (
    <Stack direction="horizontal" gap="sm" align="baseline">
      {(modelName ?? info?.model) ? (
        <span className="num shrink-0">
          <Text strong>{modelName ?? info?.model}</Text>
        </span>
      ) : (
        <Code>{routeId}</Code>
      )}
      {info ? (
        <Text tone="muted" truncate>
          {info.channel} · {info.poolId}
          {showHost ? ` · ${info.host}` : ''}
        </Text>
      ) : null}
    </Stack>
  );
}
