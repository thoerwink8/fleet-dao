// @vitest-environment happy-dom
// #556 delete-soon-members：成员占位已删，路由、导航、占位文案三处都不再见 /members；
// 其他没做的页（/models 等）地址保留、但驾驶舱改版（2026-10-07）起不进导航。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { NAV_ITEMS } from '../src/components/shell/nav';

// happy-dom 会把 import.meta.url 换成 http://localhost/，所以不从 import.meta 推；vitest 把 cwd 设为
// 仓根，packages/web 下的源码按仓根相对路径读。
const WEB_ROOT = path.join(process.cwd(), 'packages/web');

describe('#556 delete-soon-members：成员占位已从驾驶舱撤下', () => {
  test('主导航里不再有 /members；其它没做的页（/models、/billing、/record、/judge）也不占导航', () => {
    const paths = NAV_ITEMS.map((n) => n.to);
    expect(paths).not.toContain('/members');
    for (const keep of ['/models', '/billing', '/record', '/judge']) {
      expect(paths).not.toContain(keep);
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
});
