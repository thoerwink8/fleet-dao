// 驾驶舱的 service worker（#2050，方案第七节）：只缓存静态资源，接口一律不缓存。
// 缓存的只有两样：/assets/ 下带内容哈希的构建产物（名字变了内容才变）和 /icons/ 下的图标。
// 其余——/api、/auth、页面外壳、manifest、这个文件本身——都不处理，交给浏览器直接走网络；
// 不拦就不会把登录态、业务数据或旧版外壳存下来。这一版不做离线。
const CACHE = 'fleet-static-v1';

/** 这个地址该不该走缓存：同源的 GET，路径在 /assets/ 或 /icons/ 下。 */
function isStaticAsset(request, selfOrigin) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== selfOrigin) return false;
  return url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/');
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isStaticAsset(request, self.location.origin)) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      // 只存成功的整份响应；404 之类不存
      if (res.ok && res.status === 200) await cache.put(request, res.clone());
      return res;
    }),
  );
});
