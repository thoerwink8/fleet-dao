// 外壳按屏宽分档的几个判断。断点和 Tailwind 的 md / lg / xl / 3xl 对齐：768、1024、1280、1920。
// 用 matchMedia 而不是只靠 CSS：不同档渲染的是不同的组件（底部导航、抽屉停靠），不是同一个组件改样式。
import { useMediaQuery } from './hooks';

/** 手机：<768。导航换成底部四项，主页看板退成树形列表。 */
export function usePhone(): boolean {
  return useMediaQuery('(max-width: 767px)');
}

/** ≥1024：顶栏放得下主页的状态条和刷新条；更窄时它们落在画布上方一条细栏里。 */
export function useTopbarRoom(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}

/** ≥1280：侧栏默认展开；更窄默认收成图标栏（人手动选过就按人选的）。 */
export function useNavRoom(): boolean {
  return useMediaQuery('(min-width: 1280px)');
}

/** ≥1920：主页右侧抽屉停靠成一列，不盖画布。 */
export function useDockRoom(): boolean {
  return useMediaQuery('(min-width: 1920px)');
}
