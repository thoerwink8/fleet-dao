// 版式件透传 data-* 属性（测试和 e2e 靠 data-testid、状态靠 data-phase 之类找元素）：只收 data- 开头的，不收 className 和 style。
export type DataAttrs = { [K in `data-${string}`]?: string | undefined };

/** 从一堆 props 里挑出 data-* 属性（组件自己有别的 props 时，用它把 data-* 摘出来往根元素上放）。 */
export function pickData(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('data-') && typeof v === 'string') out[k] = v;
  }
  return out;
}
