// 路由表（routes.ts）：谁在登录闸里面、谁在外面，导航里的每个链接都有页接着，演示版（#1223 已删）的入口不再回来。
// 改这里之前必须知道：登录页必须在外壳（登录闸）外面，其余页面（包括兜底的 404）必须在里面——
// 放反了，要么登录页自己要先登录、要么没登录也能看到页面骨架。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RouteConfigEntry } from '@react-router/dev/routes';
import { describe, expect, test } from 'vitest';
import { NAV_ITEMS } from './components/shell/nav';
import routes from './routes';

// vitest 把 cwd 设为仓根（和 test/members-removed.test.ts 一样不从 import.meta 推）。
const WEB = path.join(process.cwd(), 'packages/web');
const SRC = path.join(WEB, 'src');

const table = routes as RouteConfigEntry[];

function flatten(entries: readonly RouteConfigEntry[]): RouteConfigEntry[] {
  return entries.flatMap((e) => [e, ...flatten(e.children ?? [])]);
}

const shellOf = (t: RouteConfigEntry[]) => {
  const shell = t.find((e) => e.file === 'routes/shell.tsx');
  if (!shell) throw new Error('路由表里没有外壳（routes/shell.tsx）');
  return shell;
};

/** 外壳里的页面路径（index 记成 /）。 */
const insideShell = (t: RouteConfigEntry[]) =>
  (shellOf(t).children ?? []).map((c) => (c.index ? '/' : `/${c.path ?? ''}`));

describe('路由表', () => {
  test('登录页在外壳外面；其余页面都在外壳（登录闸）里面，兜底的 404 也在里面且排最后', () => {
    expect(table.map((e) => e.path ?? e.file)).toEqual(['login', 'routes/shell.tsx']);
    expect(table[0]?.file).toBe('routes/login.tsx');
    const kids = shellOf(table).children ?? [];
    expect(kids.some((c) => c.file === 'routes/login.tsx')).toBe(false);
    const last = kids.at(-1);
    expect(last).toMatchObject({ path: '*', file: 'routes/not-found.tsx' });
    expect(kids.filter((c) => c.path === '*')).toHaveLength(1);
  });

  test('要登录才能看的页都在：主页、任务、额度、定时任务、通知、操作记录、设置、路由、思考档位、环境、法国、更新日志', () => {
    const pages = insideShell(table);
    for (const p of [
      '/',
      '/tasks/:taskId',
      '/quota',
      '/schedules',
      '/notifications',
      '/audit',
      '/settings',
      '/routing',
      '/efforts',
      '/env',
      '/france',
      '/changelog',
    ]) {
      expect(pages).toContain(p);
    }
  });

  test('路由表里的每个文件都真的存在（写错文件名，页面会在运行时才报错）', () => {
    const files = flatten(table).map((e) => e.file);
    expect(files.length).toBeGreaterThan(10);
    const missing = files.filter((f) => !existsSync(path.join(SRC, f)));
    expect(missing).toEqual([]);
  });

  test('路径不重复：一个地址只对着一页', () => {
    const paths = flatten(table)
      .map((e) => e.path)
      .filter((p): p is string => p !== undefined);
    expect(paths.filter((p, i) => paths.indexOf(p) !== i)).toEqual([]);
  });

  test('导航里每个链接都有页接着（点了不会掉进 404）', () => {
    const pages = insideShell(table);
    const dead = NAV_ITEMS.map((n) => n.to).filter((to) => !pages.includes(to));
    expect(dead).toEqual([]);
  });
});

// 演示版（香港 /demo/、发演示链接、换皮扫描）整层已删（#1223，创始人 2026-10-07）。下面几条是故意造出失败的：
// 谁把演示版的路由、页面文件、构建入口加回来，它们就红。保留本机假数据模式（--mode mock、src/api/mock/）。
describe('演示版已删：入口不会回来', () => {
  test('路由表里没有 /demo-links，也没有任何指向 demo 的文件', () => {
    expect(insideShell(table)).not.toContain('/demo-links');
    const bad = flatten(table).filter(
      (e) => /demo/i.test(e.path ?? '') || /demo/i.test(e.file) || /demo/i.test(e.id ?? ''),
    );
    expect(bad).toEqual([]);
  });

  test('导航里没有演示版入口', () => {
    expect(NAV_ITEMS.filter((n) => /demo|演示/i.test(`${n.to}${n.label}`))).toEqual([]);
  });

  test('演示版的页面、代码、构建脚本、品牌文件都不在了', () => {
    for (const rel of [
      'src/demo',
      'src/routes/demo-links.tsx',
      'src/brand/demo.tsx',
      'src/build/demo-renames.ts',
      'scripts/demo.ts',
    ]) {
      expect(existsSync(path.join(WEB, rel)), `${rel} 被加回来了`).toBe(false);
    }
  });

  test('构建配置里没有演示版入口：package.json 没有 dev:demo / build:demo，vite 配置没有 demo 模式', () => {
    const pkg = JSON.parse(readFileSync(path.join(WEB, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(Object.keys(pkg.scripts).filter((k) => /demo/i.test(k))).toEqual([]);
    expect(Object.values(pkg.scripts).filter((v) => /demo/i.test(v))).toEqual([]);
    const vite = readFileSync(path.join(WEB, 'vite.config.ts'), 'utf8');
    expect(vite).not.toMatch(/demo/i);
    // 本机假数据模式要留着：它是开发和截图天天在用的。
    expect(pkg.scripts['dev:mock']).toBe('react-router dev --mode mock');
    expect(readdirSync(path.join(SRC, 'api/mock')).length).toBeGreaterThan(0);
  });
});
