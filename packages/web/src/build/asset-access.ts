// 开发服务和测试读依赖里的资源（如 elkjs 的 `?url` worker）要过 vite 的 server.fs.strict：只放行 allow 里的目录，
// 默认只有工作区。pnpm 开了 enableGlobalVirtualStore 后，包的真实路径在工作区外的公共 store 里，合法的资源读取被 Denied ID 拒绝。
// 这里按实际依赖解析补最小的目录：本包 package.json 声明的每个依赖，取它在 node_modules 里解析到的真实包目录，
// 落在工作区外的才加进来。不关 strict、不放整个 store 或磁盘，没声明的包、包目录之外的文件照旧拒绝。
// 只在 Node 里跑（vite 配置、vitest 配置），不进浏览器的包。
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** 从一个目录往上找 node_modules/<包名>，返回真实路径；没装的返回 undefined（真要导入时 vite 会明确报找不到）。 */
function installedDir(from: string, name: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** packageDir 的 package.json 里声明的（dependencies + devDependencies）、真实路径落在 workspaceRoot 之外的依赖包目录。 */
export function externalDependencyDirs(packageDir: string, workspaceRoot: string): string[] {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const root = realpathSync(workspaceRoot);
  const dirs = new Set<string>();
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const dir = installedDir(packageDir, name);
    if (dir && !within(root, dir)) dirs.add(dir);
  }
  return [...dirs].sort();
}

/** vite 的 server.fs.allow：工作区加上声明依赖在工作区外的真实包目录。 */
export function assetServingAllow(packageDir: string, workspaceRoot: string): string[] {
  return [workspaceRoot, ...externalDependencyDirs(packageDir, workspaceRoot)];
}
