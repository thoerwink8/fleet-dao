// 注册 service worker（#2050）。sw.js 只缓存 /assets/ 和 /icons/ 下的静态文件，接口一律不缓存（见 public/sw.js）。
// 只在正式构建里注册：开发和假数据模式（vite dev）下热更新会被缓存搅乱。

export const SW_URL = '/sw.js';

export function registerServiceWorker(
  enabled: boolean = import.meta.env.PROD,
  nav: Pick<Navigator, 'serviceWorker'> | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator,
): void {
  if (!enabled || !nav || !('serviceWorker' in nav)) return;
  // 注册失败不影响页面本身：只是装不成 APP
  nav.serviceWorker.register(SW_URL, { scope: '/' }).catch(() => {});
}
