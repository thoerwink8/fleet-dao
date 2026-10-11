import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { designRoutes, isMockBuild } from './routes-design.ts';

describe('陈列页只在 mock 构建里挂载', () => {
  test('非 mock 构建的路由表里没有 /_design', () => {
    expect(designRoutes(false)).toEqual([]);
    expect(isMockBuild(['node', 'react-router', 'build'])).toBe(false);
    expect(isMockBuild(['node', 'react-router', 'dev'])).toBe(false);
    expect(isMockBuild(['node', 'react-router', 'dev', '--mode', 'production'])).toBe(false);
  });

  test('mock 构建有，两种写法都认', () => {
    expect(designRoutes(true).map((r) => r.path)).toEqual(['_design']);
    expect(isMockBuild(['node', 'react-router', 'dev', '--mode', 'mock'])).toBe(true);
    expect(isMockBuild(['node', 'react-router', 'dev', '--mode=mock'])).toBe(true);
  });

  test('routes.ts 只经 designRoutes 挂它，没有手写 _design 路由', () => {
    const src = readFileSync(join(process.cwd(), 'packages/web/src/routes.ts'), 'utf8');
    expect(src).toContain('designRoutes(isMockBuild())');
    expect(src).not.toContain("route('_design'");
  });
});
