// @vitest-environment happy-dom
// #556 delete-soon-members：成员占位已删，路由、导航、占位文案三处都不再见 /members；
// 其他 soon 页（/models 等）保留。演示版的 demoBlocked('/members') 不再读 NAV（NAV 里没有 /members），
// 交 404；其它 soon 页在演示版没开放时照旧被拦。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('#brand', async () => await import('../src/brand/demo'));

import { demoBlocked, NAV_ITEMS, visibleNav } from '../src/components/shell/nav';
import { setDemoScopeForTest } from '../src/demo/access';

// happy-dom 会把 import.meta.url 换成 http://localhost/，所以不从 import.meta 推；vitest 把 cwd 设为
// 仓根，packages/web 下的源码按仓根相对路径读。
const WEB_ROOT = path.join(process.cwd(), 'packages/web');

afterEach(() => {
  setDemoScopeForTest(null);
});

describe('#556 delete-soon-members：成员占位已从驾驶舱撤下', () => {
  test('主导航里不再有 /members；其它 soon 页（/models、/billing、/record、/judge）保留', () => {
    const paths = NAV_ITEMS.map((n) => n.to);
    expect(paths).not.toContain('/members');
    for (const keep of ['/models', '/billing', '/record', '/judge']) {
      expect(paths).toContain(keep);
    }
  });

  test('路由表里不再注册 members；占位页 PLANS 里也不再有 /members 文案', async () => {
    const routesTs = await readFile(path.join(WEB_ROOT, 'src/routes.ts'), 'utf8');
    expect(routesTs).not.toMatch(/route\('members'/);
    expect(routesTs).toMatch(/route\('models', 'routes\/soon\.tsx'/);

    const soonTsx = await readFile(path.join(WEB_ROOT, 'src/routes/soon.tsx'), 'utf8');
    expect(soonTsx).not.toMatch(/\/members/);
    expect(soonTsx).not.toMatch(/成员与权限/);
    expect(soonTsx).toMatch(/\/models/);
  });

  test('演示版：/members 从导航消失后 demoBlocked 交 404（不挡）；其它未开放的占位页仍被拦', () => {
    // 演示版只开 board。
    setDemoScopeForTest({
      scope: { v: 1, modules: ['board'], detail: 'status' },
      source: 'link',
    });
    expect(visibleNav().flatMap((g) => g.items.map((i) => i.to))).not.toContain('/members');
    // /members 不在 NAV_ITEMS 里，demoBlocked 拿不到 item → 不拦（404 页处理），不许拦
    expect(demoBlocked('/members')).toBe(false);
    // 还在导航里的 /models 在演示版没开放 → 拦
    expect(demoBlocked('/models')).toBe(true);
  });
});
