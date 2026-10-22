// +增 -删 小徽标（#3140）：数字等宽。#3509 起不再涂红绿（颜色只给异常）：增用正文色，删用灰字。
// 两样都没记就什么也不画——没记不写成 +0 -0，由调用方在旁边写「没记行数」。
import { Text } from './layout/text';

export function DiffStat({
  added,
  removed,
  title,
}: {
  added: number | undefined;
  removed: number | undefined;
  title?: string | undefined;
}) {
  if (added === undefined && removed === undefined) return null;
  return (
    <span data-diff-stat {...(title !== undefined ? { title } : {})}>
      <Text size="meta" strong>
        +{added ?? 0}
      </Text>{' '}
      <Text size="meta" tone="muted">
        -{removed ?? 0}
      </Text>
    </span>
  );
}
