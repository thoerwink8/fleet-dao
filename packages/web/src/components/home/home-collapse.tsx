// 工作台区块的收起（#3707 批次 3）：三块常驻、其余四块默认收起，开合记在网址参数 ?open=（lib/section-open.ts）。
// 用上下文而不是一层层传 props：八块（本台/远程各四块）都从这一处拿，页面只在最外面包一次。
// 上下文本身在 components/layout/section-fold.tsx（设置页、法国页也用同一套），这里只给工作台各块定默认开合。
// 没有 Provider 时（组件测试单独摆一块、陈列页）返回 undefined：那些块照老样子全展开，不会因为缺上下文就收起。
import type { ComponentProps, ReactNode } from 'react';
import { FoldSection, type FoldState, useSectionFold } from '../layout/section-fold';

/** 工作台七块（决定 0093 的三块常驻 + 决定 0121 第四条收起的那四块）。 */
export type HomeBlockKey = 'ask' | 'run' | 'shipped' | 'alarm' | 'overview' | 'system' | 'projects';

/** 常驻三块（决定 0093、0121 第四条）：默认展开，人收起来了才记进网址。 */
export const HOME_RESIDENT: readonly HomeBlockKey[] = ['ask', 'run', 'shipped'];

export function defaultOpenOf(key: HomeBlockKey): boolean {
  return HOME_RESIDENT.includes(key);
}

/** 这一块现在开没开、点了做什么；没有 Provider 就 undefined（块照老样子全展开）。 */
export function useHomeCollapse(key: HomeBlockKey): FoldState | undefined {
  return useSectionFold(key, defaultOpenOf(key));
}

type FoldSectionProps = ComponentProps<typeof FoldSection>;

/**
 * 工作台的一块：`FoldSection` 加上这一块自己的默认开合（三块常驻默认展开，其余默认收起）。
 * 默认值必须从这里给——`FoldSection` 自己不认工作台的「哪三块常驻」，只认传进来的 defaultOpen。
 */
export function HomeFoldSection({
  block,
  ...rest
}: Omit<FoldSectionProps, 'block' | 'defaultOpen'> & { block: HomeBlockKey; children: ReactNode }) {
  return <FoldSection block={block} defaultOpen={defaultOpenOf(block)} {...rest} />;
}
