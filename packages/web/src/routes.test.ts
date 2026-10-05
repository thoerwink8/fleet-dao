// 路由表（routes.ts）：谁在登录闸里面、谁在外面，演示版少放哪几页，导航里的每个链接都有页接着。
// 改这里之前必须知道：登录页必须在外壳（登录闸）外面，其余页面（包括兜底的 404）必须在里面——
// 放反了，要么登录页自己要先登录、要么没登录也能看到页面骨架。
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RouteConfigEntry } from '@react-router/dev/routes';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { NAV_ITEMS } from './components/shell/nav';

// vitest 把 cwd 设为仓根（和 test/members-removed.test.ts 一样不从 import.meta 推）。
const SRC = path.join(process.cwd(), 'packages/web/src');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** 按演示版或正式版读一遍路由表（routes.ts 在加载时就按 FLEET_WEB_TARGET 定了放哪些页）。 */
async function table(target: 'demo' | undefined): Promise<RouteConfigEntry[]> {
  vi.resetModules();
  vi.stubEnv('FLEET_WEB_TARGET', target ?? '');
  const mod = (await import('./routes')) as { default: RouteConfigEntry[] };
  return mod.default;
}

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

describe('路由表：正式驾驶舱', () => {
  test('登录页在外壳外面；其余页面都在外壳（登录闸）里面，兜底的 404 也在里面且排最后', async () => {
    const t = await table(undefined);
    expect(t.map((e) => e.path ?? e.file)).toEqual(['login', 'routes/shell.tsx']);
    expect(t[0]?.file).toBe('routes/login.tsx');
    const kids = shellOf(t).children ?? [];
    expect(kids.some((c) => c.file === 'routes/login.tsx')).toBe(false);
    const last = kids.at(-1);
    expect(last).toMatchObject({ path: '*', file: 'routes/not-found.tsx' });
    expect(kids.filter((c) => c.path === '*')).toHaveLength(1);
  });

  test('要登录才能看的页都在：主页、任务、额度、定时任务、通知、操作记录、设置、路由、思考档位、环境、演示版、更新日志', async () => {
    const pages = insideShell(await table(undefined));
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
      '/demo-links',
      '/changelog',
    ]) {
      expect(pages).toContain(p);
    }
  });

  test('路由表里的每个文件都真的存在（写错文件名，页面会在运行时才报错）', async () => {
    const files = flatten(await table(undefined)).map((e) => e.file);
    expect(files.length).toBeGreaterThan(10);
    const missing = files.filter((f) => !existsSync(path.join(SRC, f)));
    expect(missing).toEqual([]);
  });

  test('路径不重复：一个地址只对着一页', async () => {
    const paths = flatten(await table(undefined))
      .map((e) => e.path)
      .filter((p): p is string => p !== undefined);
    expect(paths.filter((p, i) => paths.indexOf(p) !== i)).toEqual([]);
  });

  test('导航里每个链接都有页接着（点了不会掉进 404）', async () => {
    const pages = insideShell(await table(undefined));
    const dead = NAV_ITEMS.map((n) => n.to).filter((to) => !pages.includes(to));
    expect(dead).toEqual([]);
  });
});

describe('路由表：演示版（游客，不登录）', () => {
  test('没有登录页，也没有只有正式驾驶舱才有的页：发演示链接、更新日志、路由、思考档位、环境、占位页', async () => {
    const t = await table('demo');
    expect(flatten(t).some((e) => e.file === 'routes/login.tsx')).toBe(false);
    const pages = insideShell(t);
    for (const p of [
      '/demo-links',
      '/changelog',
      '/routing',
      '/efforts',
      // 环境页（#820 片 1）露机器名、在用版本、在跑会话数（R10）：演示版里不放这一页。
      '/env',
      '/models',
      '/billing',
      '/record',
      '/judge',
    ]) {
      expect(pages).not.toContain(p);
    }
  });

  test('游客能看的页还在，兜底 404 仍在最后', async () => {
    const t = await table('demo');
    const pages = insideShell(t);
    for (const p of [
      '/',
      '/tasks/:taskId',
      '/quota',
      '/schedules',
      '/notifications',
      '/audit',
      '/settings',
    ]) {
      expect(pages).toContain(p);
    }
    expect((shellOf(t).children ?? []).at(-1)).toMatchObject({ path: '*' });
  });

  test('导航里归某个模块的页（游客按开关能看到的）每一页都有路由接着；演示版里没有的页在导航里不带模块', async () => {
    const pages = insideShell(await table('demo'));
    const broken = NAV_ITEMS.filter(
      (n) => (n.module !== undefined) !== pages.includes(n.to) && n.to !== '/',
    ).map((n) => n.to);
    // 主页（/）在演示版里另有页（不是这个外壳里的那个 index），所以豁免；其余页：有模块 ⇔ 有路由。
    // 环境页（#820 片 1）没有 module、演示版路由表里也不放 → 两边都是「没有」，照样对得上。
    expect(broken).toEqual([]);
  });

  test('演示版的路由表读不出文件就报错，不静默给空表', async () => {
    const files = flatten(await table('demo')).map((e) => e.file);
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => !existsSync(path.join(SRC, f)))).toEqual([]);
  });
});
