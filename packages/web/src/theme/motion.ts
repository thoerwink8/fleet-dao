// 动效档位（#3509，照 Arco Design）：时长只有三档，缓动只有一条。
// app.css 的 --transition-duration-100/200/300、--ease-arco 写的是同一组数，src/theme/motion.test.ts 核两边一致。
// motion 库（motion/react）里的 transition 从这里取，不在组件里另写数；lint-design R16 拦档位以外的时长和缓动。

/** 时长（毫秒）：悬停变色 100、展开和浮层 200、抽屉和进度 300。 */
export const DURATION_MS = { fast: 100, base: 200, slow: 300 } as const;

/** 同一组时长换成秒（motion 的 transition.duration 收秒）。 */
export const DURATION_S = {
  fast: DURATION_MS.fast / 1000,
  base: DURATION_MS.base / 1000,
  slow: DURATION_MS.slow / 1000,
} as const;

/** Arco 的标准缓动：cubic-bezier(0.34, 0.69, 0.1, 1)。motion 的 ease 收这个数组。 */
export const EASE_ARCO = [0.34, 0.69, 0.1, 1] as const;

/** 同一条缓动的 CSS 写法。 */
export const EASE_ARCO_CSS = `cubic-bezier(${EASE_ARCO.join(', ')})`;
