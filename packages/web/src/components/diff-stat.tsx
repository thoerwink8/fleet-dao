// +增 -删 小徽标（#3140）：绿增、红删，数字等宽。
// 两样都没记就什么也不画——没记不写成 +0 -0，由调用方在旁边写「没记行数」。

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
    <span
      className="num inline-flex shrink-0 items-baseline gap-1 text-meta font-medium"
      title={title}
      data-diff-stat
    >
      <span className="text-ink-done">+{added ?? 0}</span>
      <span className="text-ink-fail">-{removed ?? 0}</span>
    </span>
  );
}
