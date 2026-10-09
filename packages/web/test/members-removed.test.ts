// @vitest-environment happy-dom
// #556 delete-soon-members：成员占位已删，路由、导航、占位文案三处都不再见 /members；
// 其他没做的页（账单、战绩、判断题记录）地址保留、但驾驶舱改版（2026-10-07）起不进导航。
// /models 不再占位，转到路由页的模型目录。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { NAV_ITEMS } from '../src/components/shell/nav';

// happy-dom 会把 import.meta.url 换成 http://localhost/，所以不从 import.meta 推；vitest 把 cwd 设为
// 仓根，packages/web 下的源码按仓根相对路径读。
const WEB_ROOT = path.join(process.cwd(), 'packages/web');

describe('#556 delete-soon-members：成员占位已从驾驶舱撤下', () => {
  test('主导航里不再有 /members；没做的页（/billing、/record、/judge）和旧地址 /models 也不占导航', () => {
    const paths = NAV_ITEMS.map((n) => n.to);
    expect(paths).not.toContain('/members');
    for (const keep of ['/models', '/billing', '/record', '/judge']) {
      expect(paths).not.toContain(keep);
    }
  });

  test('路由表里不再注册 members；/models 转到路由页，占位文案只剩账单、战绩、判断题记录', async () => {
    const routesTs = await readFile(path.join(WEB_ROOT, 'src/routes.ts'), 'utf8');
    expect(routesTs).not.toMatch(/route\('members'/);
    expect(routesTs).not.toMatch(/route\('models', 'routes\/soon\.tsx'/);
    expect(routesTs).toMatch(/route\('models', 'routes\/models\.tsx'/);

    const soonTsx = await readFile(path.join(WEB_ROOT, 'src/routes/soon.tsx'), 'utf8');
    expect(soonTsx).not.toMatch(/\/members/);
    expect(soonTsx).not.toMatch(/成员与权限/);
    expect(soonTsx).not.toMatch(/\/models/);
    expect(soonTsx).toMatch(/\/billing/);
    expect(soonTsx).toMatch(/\/record/);
    expect(soonTsx).toMatch(/\/judge/);
  });
});
