// e2e 走的两个视口：1920×1080 是创始人的大屏、1366×768 是常见笔记本。每一轮两个都走（e2e 不在 PR 上跑了，决定 0093，
// 原来为 PR 省时间只走 1920 的那条分支随之删掉）。
// 两个视口是两个 Playwright 项目，各自的 worker 各起一套环境（support/fixtures.ts），1366 那一遍只读、看到的是刚备好的库。

export const VIEWPORTS = {
  'laptop-1366': { width: 1366, height: 768 },
  'desktop-1920': { width: 1920, height: 1080 },
} as const;

export type ViewportName = keyof typeof VIEWPORTS;

/** 项目的先后（列表顺序；各自起环境，谁先谁后不影响结果）。 */
export const VIEWPORT_ORDER: readonly ViewportName[] = ['laptop-1366', 'desktop-1920'];
