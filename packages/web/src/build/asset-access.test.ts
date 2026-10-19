// 资源读取的访问边界：用真 vite 的 createServer 和资源转换（?url）在临时目录里造两种依赖布局——
// 公共虚拟仓（包的真实路径在工作区外）和普通本地虚拟仓（在工作区内），核对声明依赖的资源能读、其余照旧被 strict 拒绝。
// 不依赖哪台机器的路径，也不扫真实用户目录。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, searchForWorkspaceRoot, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, test } from 'vitest';
import { assetServingAllow, externalDependencyDirs } from './asset-access';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Layout {
  workspace: string;
  app: string;
  /** 声明依赖的真实包目录 */
  realPkg: string;
  /** 同一个 store 里没声明的别的包的文件 */
  stranger: string;
  /** 工作区外、跟谁都无关的文件 */
  loose: string;
}

/** 造 { 工作区/app（声明依赖 asset-pkg 和 @scope/asset-pkg）、store（真实包放在哪由 external 定）}。 */
function layout(external: boolean): Layout {
  // native 展开 Windows 临时目录的 8.3 短名；Vite strict 会在 allow 检查前拒绝短名路径。
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'asset-access-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const workspace = join(base, 'ws');
  const app = join(workspace, 'packages', 'app');
  const store = external ? join(base, 'global-store') : join(workspace, 'node_modules', '.pnpm');
  const put = (file: string, body: string) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, body);
  };
  put(join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  put(
    join(app, 'package.json'),
    JSON.stringify({
      name: 'app',
      dependencies: { 'asset-pkg': '1.0.0', '@scope/asset-pkg': '1.0.0', 'not-installed': '1.0.0' },
    }),
  );
  const realPkg = join(store, 'asset-pkg@1.0.0', 'node_modules', 'asset-pkg');
  const scoped = join(store, 'scope-asset-pkg@1.0.0', 'node_modules', '@scope', 'asset-pkg');
  const strangerPkg = join(store, 'stranger@1.0.0', 'node_modules', 'stranger');
  put(join(realPkg, 'package.json'), '{"name":"asset-pkg","version":"1.0.0"}');
  put(join(realPkg, 'worker.js'), 'self.onmessage = () => {};');
  put(join(scoped, 'package.json'), '{"name":"@scope/asset-pkg","version":"1.0.0"}');
  put(join(scoped, 'worker.js'), 'self.onmessage = () => {};');
  put(join(strangerPkg, 'package.json'), '{"name":"stranger","version":"1.0.0"}');
  put(join(strangerPkg, 'secret.js'), 'export const secret = 1;');
  put(join(base, 'loose', 'passwd.txt'), 'x');
  mkdirSync(join(app, 'node_modules', '@scope'), { recursive: true });
  symlinkSync(realPkg, join(app, 'node_modules', 'asset-pkg'), 'junction');
  symlinkSync(scoped, join(app, 'node_modules', '@scope', 'asset-pkg'), 'junction');
  return {
    workspace,
    app,
    realPkg,
    stranger: join(strangerPkg, 'secret.js'),
    loose: join(base, 'loose', 'passwd.txt'),
  };
}

async function serve(root: string, allow: string[] | undefined): Promise<ViteDevServer> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, ws: false, watch: null, ...(allow ? { fs: { allow } } : {}) },
  });
  cleanups.push(() => server.close());
  return server;
}

/** 像页面里 `import url from 'asset-pkg/worker.js?url'` 那样：先让 vite 解析，再走资源转换。 */
async function loadUrlAsset(server: ViteDevServer, root: string, spec: string) {
  const resolved = await server.environments.client.pluginContainer.resolveId(spec, join(root, 'entry.js'));
  if (!resolved) throw new Error(`解析不到 ${spec}`);
  return server.environments.client.transformRequest(resolved.id);
}

describe.each([
  ['公共虚拟仓（真实路径在工作区外）', true],
  ['普通本地虚拟仓（真实路径在工作区内）', false],
])('%s', (_name, external) => {
  test('声明依赖的 ?url 资源能读，包括带 scope 的包', async () => {
    const l = layout(external);
    const server = await serve(l.app, assetServingAllow(l.app, l.workspace));
    for (const spec of ['asset-pkg/worker.js?url', '@scope/asset-pkg/worker.js?url']) {
      const out = await loadUrlAsset(server, l.app, spec);
      expect(out?.code).toContain('export default');
    }
  });

  test('没声明的包、同 store 里的别的文件、工作区外的无关文件、越出包目录的路径照旧拒绝', async () => {
    const l = layout(external);
    const server = await serve(l.app, assetServingAllow(l.app, l.workspace));
    const denied = { code: 'ERR_DENIED_ID' };
    if (external) {
      await expect(loadUrlAsset(server, l.app, `${l.stranger}?url`)).rejects.toMatchObject(denied);
      await expect(loadUrlAsset(server, l.app, `${l.loose}?url`)).rejects.toMatchObject(denied);
      await expect(
        loadUrlAsset(
          server,
          l.app,
          `${l.realPkg}/../../../stranger@1.0.0/node_modules/stranger/secret.js?url`,
        ),
      ).rejects.toMatchObject(denied);
    } else {
      // 普通布局下 store 在工作区内，本来就能读；工作区外的无关文件仍拒绝
      await expect(loadUrlAsset(server, l.app, `${l.loose}?url`)).rejects.toMatchObject(denied);
    }
  });
});

describe('补的目录', () => {
  test('公共虚拟仓：只加声明依赖的真实包目录，跳过没装的；不含 store 根', () => {
    const l = layout(true);
    const dirs = externalDependencyDirs(l.app, l.workspace);
    expect(dirs).toHaveLength(2);
    expect(dirs).toContain(l.realPkg);
    expect(dirs.every((d) => d.endsWith('asset-pkg'))).toBe(true);
    expect(assetServingAllow(l.app, l.workspace)).toEqual([l.workspace, ...dirs]);
  });

  test('普通本地虚拟仓：不补任何目录', () => {
    const l = layout(false);
    expect(externalDependencyDirs(l.app, l.workspace)).toEqual([]);
  });

  test('对照：不补的话 vite 默认的 strict 会拒绝公共虚拟仓里的声明依赖（复现原故障）', async () => {
    const l = layout(true);
    const server = await serve(l.app, [searchForWorkspaceRoot(l.app)]);
    await expect(loadUrlAsset(server, l.app, 'asset-pkg/worker.js?url')).rejects.toMatchObject({
      code: 'ERR_DENIED_ID',
    });
  });
});
