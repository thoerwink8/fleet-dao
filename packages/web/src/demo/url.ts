// 演示版在哪：构建时由 FLEET_DEMO_URL 定（vite.config.ts；发布脚本按 release.env 的 FLEET_DEMO_PATH 给），
// 演示版搬到别的路径、别的域名时改配置，不改代码。正式驾驶舱的登录页入口和发出去的演示链接都用它。
export const DEMO_URL = import.meta.env.FLEET_DEMO_URL ?? '/demo/';

/** 一条演示链接的完整地址：演示版地址后面加 ?k=口令；站内路径按当前域名补全。 */
export function demoLinkUrl(token: string, origin: string = location.origin): string {
  return new URL(`${DEMO_URL}?k=${encodeURIComponent(token)}`, origin).href;
}
