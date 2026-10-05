// 按触发事件挑这一轮走哪几个视口（全仓审查第 2 路清单 3）。
// PR 上只走 1920 那一遍：e2e 是 PR 的 CI 墙钟最后收尾的那个 job（中位 358 秒），两个视口串行各走一遍，
// 1366 那一遍只读、从没红出过 1920 不红的东西（6 次 e2e、git 历史里没有「1366」的修复）。
// 1366 留给每夜全量（schedule）和主线推送：那两种照旧两个视口都走。本机（没有 GITHUB_EVENT_NAME）也两个都走。
// 主线推送和某个 PR 同一棵树时 CI 复用那次 PR 的结果、不再重跑（ci.yml 头注释），所以 1366 实际由每夜那一轮兜。

export const VIEWPORTS = {
  'laptop-1366': { width: 1366, height: 768 },
  'desktop-1920': { width: 1920, height: 1080 },
} as const;

export type ViewportName = keyof typeof VIEWPORTS;

/** 事件名（GitHub Actions 的 GITHUB_EVENT_NAME）→ 这一轮走的视口，按走的先后（1366 只读那一遍在前，见 playwright.config.ts）。 */
export function viewportsFor(eventName: string | undefined): ViewportName[] {
  if (eventName === 'pull_request') return ['desktop-1920'];
  return ['laptop-1366', 'desktop-1920'];
}
