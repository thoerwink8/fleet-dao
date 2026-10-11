// 陈列页 /_design（#1848）只在 dev:mock 构建里挂载：生产构建的路由表里没有它。
// 路由表在构建时由 Node 读（routes.ts），拿不到 Vite 的 import.meta.env.MODE，所以看命令行里的 `--mode mock`。
import { type RouteConfigEntry, route } from '@react-router/dev/routes';

export function isMockBuild(argv: readonly string[] = process.argv): boolean {
  return argv.some((a, i) => a === '--mode=mock' || (a === '--mode' && argv[i + 1] === 'mock'));
}

export function designRoutes(mock: boolean): RouteConfigEntry[] {
  return mock ? [route('_design', 'routes/design.tsx')] : [];
}
