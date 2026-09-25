// 这一次打开能看什么。正式驾驶舱什么都能看；演示版按可见范围（scope.ts）来，范围在页面渲染前读好
// （根路由的 clientLoader），之后各处同步地问 canSee / detailLevel。
import { brand } from '#brand';
import type { DemoDetail, DemoModule, LoadedScope } from './scope';
import { resolveScope, tokenFrom } from './scope';

let loaded: LoadedScope | null = null;

export function isDemo(): boolean {
  return brand.kind === 'demo';
}

/** 演示版读好的范围；正式驾驶舱、或者还没读好时是 null。 */
export function demoScope(): LoadedScope | null {
  return isDemo() ? loaded : null;
}

/** 这个模块能不能看。演示版范围还没读好时一律不能（不先露再收）。 */
export function canSee(module: DemoModule): boolean {
  if (!isDemo()) return true;
  return loaded?.scope.modules.includes(module) ?? false;
}

const LEVELS: Record<DemoDetail, number> = { status: 0, titles: 1, process: 2 };

/** 细节够不够这一级：status = 状态和耗时；titles = 还能看任务标题；process = 步骤清单和过程。 */
export function canSeeDetail(level: DemoDetail): boolean {
  if (!isDemo()) return true;
  return LEVELS[loaded?.scope.detail ?? 'status'] >= LEVELS[level];
}

export function detailLevel(): DemoDetail {
  if (!isDemo()) return 'process';
  return loaded?.scope.detail ?? 'status';
}

/** 构建时定的范围目录（FLEET_DEMO_SCOPES）；没给就是演示版自己目录下的 scopes/。 */
function scopesBase(): string {
  return import.meta.env.FLEET_DEMO_SCOPES ?? `${import.meta.env.BASE_URL}scopes/`;
}

/** 口令记在本机：在页面里点来点去、刷新，都还是这条链接的范围；链接作废或过期后就忘掉它。 */
const TOKEN_KEY = `${brand.storagePrefix}k`;

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 隐私模式：这次照样按链接的范围看，只是刷新后要重新带上链接。
  }
}

/** 读一次范围（整个页面只读一次）。正式驾驶舱直接返回 null。 */
let pending: Promise<LoadedScope | null> | null = null;
export function loadDemoScope(): Promise<LoadedScope | null> {
  if (!isDemo()) return Promise.resolve(null);
  pending ??= (async () => {
    const fromUrl = tokenFrom(location.search, location.hash);
    const token = fromUrl ?? storedToken();
    const result = await resolveScope({ token, base: scopesBase(), now: new Date() });
    if (fromUrl && result.source === 'link') storeToken(fromUrl);
    if (token && result.source !== 'link') storeToken(null);
    loaded = result;
    return result;
  })();
  return pending;
}

/** 测试用：直接给定这一次的范围。 */
export function setDemoScopeForTest(scope: LoadedScope | null) {
  loaded = scope;
  pending = scope ? Promise.resolve(scope) : null;
}
