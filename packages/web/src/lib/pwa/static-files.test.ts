// PWA 的静态文件（#2050）：manifest 满足 Chrome、Edge 的可安装条件；service worker 只缓存静态资源、接口一律不缓存。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, test, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../../../public');

describe('manifest.webmanifest', () => {
  const manifest = JSON.parse(readFileSync(resolve(PUBLIC, 'manifest.webmanifest'), 'utf8'));

  test('名字、独立窗口、主题色、起始地址都有', () => {
    expect(manifest.name).toBe('驾驶舱');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.start_url).toBe('/');
  });

  test('有 192、512 和 maskable 图标，文件都在', () => {
    const icons = manifest.icons as { src: string; sizes: string; purpose?: string }[];
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const i of icons) expect(existsSync(resolve(PUBLIC, `.${i.src}`)), i.src).toBe(true);
  });
});

/** 在假的 service worker 全局里跑 sw.js，返回它挂上的各个事件处理函数。 */
function loadWorker(fetchImpl = vi.fn(async () => new Response('x', { status: 200 }))) {
  const handlers: Record<string, (ev: unknown) => void> = {};
  const store = new Map<string, Response>();
  const cache = {
    match: async (req: Request) => store.get(req.url),
    put: vi.fn(async (req: Request, res: Response) => {
      store.set(req.url, res);
    }),
  };
  const self = {
    location: { origin: 'https://cockpit.example' },
    addEventListener: (name: string, fn: (ev: unknown) => void) => {
      handlers[name] = fn;
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
  };
  const ctx = vm.createContext({
    self,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: fetchImpl,
    URL,
    Response,
  });
  vm.runInContext(readFileSync(resolve(PUBLIC, 'sw.js'), 'utf8'), ctx);
  return { handlers, cache, fetchImpl };
}

/** 发一个 fetch 事件，返回 respondWith 有没有被调、调的结果。 */
async function dispatch(
  handlers: Record<string, (ev: unknown) => void>,
  url: string,
  method = 'GET',
): Promise<{ handled: boolean; response?: Response }> {
  let promise: Promise<Response> | undefined;
  handlers.fetch?.({
    request: { url, method },
    respondWith: (p: Promise<Response>) => {
      promise = p;
    },
  });
  return promise ? { handled: true, response: await promise } : { handled: false };
}

describe('sw.js', () => {
  test('接口、登录、推送、页面外壳一律不处理（不缓存）', async () => {
    const { handlers, cache } = loadWorker();
    for (const path of [
      '/api/home',
      '/api/notifications?status=open',
      '/api/events',
      '/auth/me',
      '/',
      '/settings',
      '/index.html',
      '/manifest.webmanifest',
      '/sw.js',
    ]) {
      expect((await dispatch(handlers, `https://cockpit.example${path}`)).handled, path).toBe(false);
    }
    expect(cache.put).not.toHaveBeenCalled();
  });

  test('非 GET 和跨域请求不处理，哪怕路径在 /assets/ 下', async () => {
    const { handlers } = loadWorker();
    expect((await dispatch(handlers, 'https://cockpit.example/assets/a.js', 'POST')).handled).toBe(false);
    expect((await dispatch(handlers, 'https://evil.example/assets/a.js')).handled).toBe(false);
  });

  test('/assets/ 下的静态文件：第一次走网络并存下，第二次直接用缓存', async () => {
    const { handlers, cache, fetchImpl } = loadWorker();
    const first = await dispatch(handlers, 'https://cockpit.example/assets/app-abc123.js');
    expect(first.handled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    const second = await dispatch(handlers, 'https://cockpit.example/assets/app-abc123.js');
    expect(second.handled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('图标也缓存；404 的不存', async () => {
    const miss = vi.fn(async () => new Response('no', { status: 404 }));
    const { handlers, cache } = loadWorker(miss);
    expect((await dispatch(handlers, 'https://cockpit.example/icons/icon-192.png')).handled).toBe(true);
    expect(cache.put).not.toHaveBeenCalled();
  });
});
