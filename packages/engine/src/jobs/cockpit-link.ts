// 飞书单向通知里的驾驶舱链接（提需求 F1 #2051：每条通知都带驾驶舱链接）。
// 地址来自引擎环境变量 FLEET_PUBLIC_URL（和 api.env 同一个值：浏览器看到的驾驶舱地址）。
// 没配、认不出一律抛，调用方记没查成、不推：不拿一条没有链接的通知冒充推过。抛出的话里不带地址。
export const COCKPIT_URL_ENV = 'FLEET_PUBLIC_URL';

/** 驾驶舱某一页的完整链接。path 以 / 开头（/ 是主页）。 */
export function cockpitLink(raw: string | undefined, path: string): string {
  const base = typeof raw === 'string' ? raw.trim() : '';
  if (base === '') throw new Error(`驾驶舱地址没配：引擎环境里没有 ${COCKPIT_URL_ENV}，这条通知推不出去`);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`驾驶舱地址不认：${COCKPIT_URL_ENV} 不是网址，这条通知推不出去`);
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      `驾驶舱地址不认：${COCKPIT_URL_ENV} 只收不带账号、查询串的 http(s) 网址，这条通知推不出去`,
    );
  }
  if (!path.startsWith('/')) throw new Error(`驾驶舱页面路径要以 / 开头：${path}`);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}${path}`;
}
